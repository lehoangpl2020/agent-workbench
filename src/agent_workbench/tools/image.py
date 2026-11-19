"""
The `generate_image` tool: an OpenAI image model behind a run-scoped endpoint.

Why an endpoint and not a function in the sandbox: the model's code runs in the sandbox, which must never hold
an API key (AGENTS.md invariant 6). So the code POSTs to
    POST /api/runs/{run_id}/tools/generate_image
on the server (the URL is passed to the code as the IMAGE_TOOL_URL environment variable), and the server calls
OpenAI with its own key, then writes the PNG into that run's output/ directory. The existing artifact collection
picks the file up like any other file the code created.

Guards: the tool is off unless IMAGE_TOOL=true; it only answers for the run that is active right now; each run has
a cap on calls (a model in a retry loop must not burn money); the filename cannot leave output/; a symlink the
sandbox planted in output/ is never written through.
"""

import asyncio
import base64
import json
import logging
import os
import uuid
from dataclasses import dataclass
from typing import Literal

import httpx
from pydantic import BaseModel, Field

from agent_workbench.storage.workspace import RunWorkspace

logger = logging.getLogger(__name__)

# The cheapest image model on OpenAI's price list (checked 2026-11-19). OpenAI retires image models quickly: it lists
# gpt-image-1 as shut down on 2026-10-23, and this one for 2026-12-01 (replacement: gpt-image-2.5/2.6 flare or sunburst,
# priced higher). When it stops answering, the endpoint says so (503) and IMAGE_MODEL is the only thing to change.
DEFAULT_MODEL = "gpt-image-1-mini"
DEFAULT_MAX_PER_RUN = 4
# High quality can take well over a minute; the sandbox's code timeout (not this one) is what usually limits a call.
READ_TIMEOUT_SECONDS = 240.0


@dataclass(frozen=True)
class ImageToolSettings:
    """Read once by config.Settings.from_env(). `url` is the server as the SANDBOX sees it."""

    enabled: bool = False
    model: str = DEFAULT_MODEL
    url: str = "http://127.0.0.1:8668"
    max_per_run: int = DEFAULT_MAX_PER_RUN


class ImageToolError(Exception):
    """Carries the HTTP status the endpoint should answer with; `message` is meant for the model to read."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class ImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    size: Literal["1024x1024", "1536x1024", "1024x1536"] = "1024x1024"
    quality: Literal["low", "medium", "high"] = "medium"
    background: Literal["auto", "opaque", "transparent"] = "auto"
    # Letters, digits, dot, dash, underscore; no path separators. ".png" is added when missing.
    filename: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def tool_url(base_url: str, run_id: str) -> str:
    return f"{base_url.rstrip('/')}/api/runs/{run_id}/tools/generate_image"


def _png_name(filename: str | None, n: int) -> str:
    name = filename or f"image_{n:02d}.png"
    return name if name.lower().endswith(".png") else f"{name}.png"


def _detail(body: bytes) -> str:
    try:
        err = json.loads(body).get("error", {})
        detail = err.get("message") if isinstance(err, dict) else str(err)
    except (ValueError, AttributeError):
        detail = body.decode("utf-8", "replace")[:300]
    return (detail or "")[:500]


def _model_unavailable(status: int, detail: str) -> bool:
    """OpenAI answers 400 or 404 "The model `x` does not exist" for a retired model or one this key cannot use."""
    lowered = detail.lower()
    return status == 404 or (status == 400 and "model" in lowered
                             and ("does not exist" in lowered or "not found" in lowered))


def _error_message(status: int, body: bytes) -> str:
    # The provider's own message is what lets the model fix a bad prompt (e.g. a moderation block)
    detail = _detail(body)
    if _model_unavailable(status, detail):
        return (f"The image model is not available to the server's OpenAI key ({detail}). This is a server setting, "
                "not a problem with the prompt: tell the user to check IMAGE_MODEL and their OpenAI access. Do not retry.")
    if status == 401:
        return f"OpenAI rejected the server's API key (HTTP 401). Tell the user to check OPENAI_API_KEY. {detail}"
    if status == 403:
        return f"This OpenAI key cannot use the image model (HTTP 403; it may need organization verification). {detail}"
    if status == 429:
        return f"OpenAI rate limit or out of credit (HTTP 429). {detail}"
    if status == 400:
        return f"OpenAI rejected the request (HTTP 400), for example a safety block. Change the prompt. {detail}"
    return f"OpenAI image API error (HTTP {status}). {detail}"


class ImageTool:
    def __init__(self, settings: ImageToolSettings, api_key: str, base_url: str,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._http = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(connect=10.0, read=READ_TIMEOUT_SECONDS, write=30.0, pool=10.0),
        )
        self._calls: dict[str, int] = {}

    @property
    def max_per_run(self) -> int:
        return self.settings.max_per_run

    def sandbox_env(self, run_id: str) -> dict[str, str]:
        """What the run's code needs to call this tool: only the URL for that run (the key stays on the server)."""
        return {"IMAGE_TOOL_URL": tool_url(self.settings.url, run_id)}

    async def aclose(self) -> None:
        await self._http.aclose()

    async def generate(self, workspace: RunWorkspace, req: ImageRequest, *, still_active) -> dict:
        """Calls the image API and saves the PNG in the run's output/. `still_active()`: is this run still running?"""
        used = self._calls.get(workspace.run_id, 0)
        if used >= self.max_per_run:
            raise ImageToolError(429, f"Image limit reached: at most {self.max_per_run} image requests per run. "
                                      "Use the images you already have.")
        # Counted before the call: a failing call may still be billed, and a loop must not be able to retry forever
        self._calls[workspace.run_id] = used + 1

        data = await self._request(req)
        if not still_active():
            # Stop was pressed while OpenAI was working: the run is over, so do not add files to it
            raise ImageToolError(409, "The run is no longer active; the image was discarded.")
        try:
            png = base64.b64decode(data["data"][0]["b64_json"], validate=True)
        except (KeyError, IndexError, TypeError, ValueError):
            raise ImageToolError(502, "OpenAI returned no image data.") from None

        name = _png_name(req.filename, used + 1)
        await asyncio.to_thread(self._save, workspace, name, png)   # a few MB of disk I/O: keep it off the event loop
        return {
            "path": f"/workspace/output/{name}",
            "filename": name,
            "bytes": len(png),
            "model": self.settings.model,
            "requests_left": self.max_per_run - (used + 1),
        }

    async def _request(self, req: ImageRequest) -> dict:
        body = {"model": self.settings.model, "prompt": req.prompt, "size": req.size, "quality": req.quality,
                "background": req.background, "output_format": "png", "n": 1}
        try:
            resp = await self._http.post(f"{self._base_url}/images/generations", json=body,
                                         headers={"Authorization": f"Bearer {self._api_key}"})
        except httpx.TimeoutException:
            raise ImageToolError(504, "OpenAI took too long to generate the image. Try quality=low.") from None
        except httpx.TransportError as e:
            raise ImageToolError(502, f"Cannot reach OpenAI ({type(e).__name__}).") from None
        if resp.status_code >= 400:
            # 503: the server is misconfigured (retired model); the code that called us cannot fix it by changing the prompt
            unavailable = _model_unavailable(resp.status_code, _detail(resp.content))
            status = 503 if unavailable else 502 if resp.status_code >= 500 else 400
            raise ImageToolError(status, _error_message(resp.status_code, resp.content))
        try:
            return resp.json()
        except ValueError:
            raise ImageToolError(502, "OpenAI returned an unreadable response.") from None

    @staticmethod
    def _save(workspace: RunWorkspace, name: str, png: bytes) -> None:
        """Writes output/<name> atomically. The sandbox can write in output/, so never follow what it planted there."""
        out = workspace.output_dir
        if out.is_symlink() or not out.resolve().is_relative_to(workspace.root.resolve()):
            raise ImageToolError(500, "The run's output directory is not usable.")
        target = out / name
        if target.is_symlink():
            raise ImageToolError(400, f"{name} is a symbolic link; pick another filename.")
        tmp = out / f".{uuid.uuid4().hex}.tmp"
        try:
            tmp.write_bytes(png)
            os.chmod(tmp, 0o644)
            os.replace(tmp, target)   # replaces a link itself, never the file it points to
        finally:
            tmp.unlink(missing_ok=True)
