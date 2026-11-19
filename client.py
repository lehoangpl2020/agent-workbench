"""
Client for Code Execution Agent API.
Usage:
    python client.py "Calculate pi to 100 decimal places"
    python client.py --stream "Generate a chart of sin(x)"
    python client.py --base-url http://your-server:8000 "Your task here"
"""

import argparse
import json
import sys
import httpx


DEFAULT_BASE_URL = "http://localhost:8000"


def execute_sync(
    base_url: str,
    message: str,
    max_iterations: int = 5,
    timeout_seconds: int = 30,
    provider: str | None = None,
    model: str | None = None,
):
    """Gọi /api/execute (sync), đợi kết quả cuối cùng."""
    url = f"{base_url}/api/execute"
    payload = {
        "message": message,
        "max_iterations": max_iterations,
        "timeout_seconds": timeout_seconds,
    }
    # Không truyền → server dùng default trong model_catalog.py (Claude Sonnet 4.6)
    if provider:
        payload["provider"] = provider
    if model:
        payload["model"] = model

    print(f"⏳ Sending request to {url}...")
    print(f"   Task: {message}\n")

    with httpx.Client(timeout=600) as client:
        resp = client.post(url, json=payload)
        _raise_for_status(resp)
        data = resp.json()

    print(f"Model:      {data.get('provider', '?')} / {data.get('model', '?')}")
    print(f"Status:     {data['status']}")
    print(f"Iterations: {data['iterations']}")
    print(f"Session:    {data['session_id']}")
    if data.get("message"):
        print(f"Message:    {data['message']}")
    print(f"\n{'─' * 50}")
    print(f"Answer:\n{data['answer']}")

    if data.get("code_blocks"):
        last_code = data["code_blocks"][-1]
        print(f"\n{'─' * 50}")
        print(f"Final code ({last_code['language']}):\n{last_code['code']}")

    return data


def execute_stream(
    base_url: str,
    message: str,
    max_iterations: int = 5,
    timeout_seconds: int = 30,
    provider: str | None = None,
    model: str | None = None,
):
    """Gọi /api/execute/stream (SSE), in từng event realtime."""
    url = f"{base_url}/api/execute/stream"
    payload = {
        "message": message,
        "max_iterations": max_iterations,
        "timeout_seconds": timeout_seconds,
    }
    # Không truyền → server dùng default trong model_catalog.py (Claude Sonnet 4.6)
    if provider:
        payload["provider"] = provider
    if model:
        payload["model"] = model

    print(f"⏳ Streaming from {url}...")
    print(f"   Task: {message}\n")

    with httpx.Client(timeout=600) as client:
        with client.stream("POST", url, json=payload) as resp:
            if resp.status_code >= 400:
                resp.read()
                _raise_for_status(resp)
            buffer = ""

            for chunk in resp.iter_text():
                buffer += chunk
                while "\n\n" in buffer:
                    raw_event, buffer = buffer.split("\n\n", 1)
                    event = _parse_sse(raw_event)
                    if event:
                        _print_event(event)


def _parse_sse(raw: str) -> dict | None:
    """Parse một SSE event thành {event, data}."""
    event_type = ""
    data_lines = []

    for line in raw.strip().split("\n"):
        if line.startswith("event: "):
            event_type = line[7:]
        elif line.startswith("data: "):
            data_lines.append(line[6:])

    if not event_type or not data_lines:
        return None

    try:
        data = json.loads("".join(data_lines))
    except json.JSONDecodeError:
        data = {"raw": "".join(data_lines)}

    return {"event": event_type, "data": data}


def _print_event(event: dict):
    """In SSE event theo format đẹp."""
    etype = event["event"]
    data = event["data"]

    if etype == "session":
        print(f"🔗 Session: {data['session_id']}  ({data.get('provider', '?')} / {data.get('model', '?')})\n")

    elif etype == "iteration":
        phase = data.get("phase", "")
        icon = "🧠" if phase == "planning" else "⚙️"
        print(f"{icon} Iteration {data['iteration']} — {phase}")

    elif etype == "code":
        print(f"   📝 {data.get('explanation', '')}")
        preview = data.get("code_preview", "")
        if preview:
            lines = preview.split("\n")[:5]
            for line in lines:
                print(f"      {line}")
            if len(preview.split("\n")) > 5:
                print(f"      ... ({len(data.get('code_preview', ''))} chars)")
        print()

    elif etype == "result":
        exit_code = data.get("exit_code", -1)
        false_success = data.get("false_success", False)
        timed_out = data.get("timed_out", False)
        icon = "⏱" if timed_out else ("🔄" if false_success else ("✅" if exit_code == 0 else "❌"))
        time_ms = data.get("time_ms", 0)
        suffix = " (timed out)" if timed_out else (" (false success → retry)" if false_success else "")
        if data.get("artifacts"):
            suffix += f" files: {', '.join(data['artifacts'])}"
        print(f"   {icon} exit_code={exit_code} ({time_ms:.0f}ms){suffix}")
        stdout = data.get("stdout_preview", "").strip()
        if stdout:
            for line in stdout.split("\n")[:5]:
                print(f"      {line}")
        stderr = data.get("stderr_preview", "").strip()
        if stderr:
            print(f"   ⚠️  {stderr[:200]}")
        print()

    elif etype == "activity":
        # Hành động hiện tại: model đang viết/sửa/xem, hoặc runtime đang chạy/cài package/thu file
        print(f"   · {data.get('text', '')}")

    elif etype == "model_done":
        print(f"   🏁 Model replied DONE (iteration {data['iteration']})\n")

    elif etype == "done":
        print(f"{'═' * 50}")
        print(f"Model:      {data.get('provider', '?')} / {data.get('model', '?')}")
        print(f"Status:     {data['status']}")
        print(f"Iterations: {data['iterations']}")
        if data.get("message"):
            print(f"Message:    {data['message']}")
        print(f"\nAnswer:\n{data['answer']}")

    elif etype == "error":
        print(f"💥 Error: {data.get('message', data)}")


def _raise_for_status(resp: httpx.Response):
    if resp.status_code == 409:
        detail = resp.json().get("detail", {})
        print(f"⛔ {detail.get('message', 'Busy')} (active run: {detail.get('active_run_id')})")
        sys.exit(2)
    resp.raise_for_status()


def health_check(base_url: str):
    """Kiểm tra server có sống không."""
    url = f"{base_url}/health"
    try:
        resp = httpx.get(url, timeout=5)
        data = resp.json()
        print(f"✅ Server OK — docker={data.get('docker')}")
        return True
    except Exception as e:
        print(f"❌ Server unreachable: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Client for Code Execution Agent",
    )
    parser.add_argument(
        "message",
        nargs="?",
        help="Task to execute",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Use SSE streaming endpoint",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Server URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=5,
        help="Max code runs (default: 5). The model is called at most this + 1 times "
             "(the last call only reviews the output and replies DONE).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Execution timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--provider",
        help="anthropic | openai | ollama (default: server default, Claude Sonnet 4.6)",
    )
    parser.add_argument(
        "--model",
        help="Model ID from the server catalog, e.g. claude-sonnet-4-6, qwen3.5:4b",
    )
    parser.add_argument(
        "--health",
        action="store_true",
        help="Check server health and exit",
    )

    args = parser.parse_args()

    if args.health:
        health_check(args.base_url)
        return

    if not args.message:
        parser.print_help()
        sys.exit(1)

    if args.stream:
        execute_stream(
            base_url=args.base_url,
            message=args.message,
            max_iterations=args.max_iterations,
            timeout_seconds=args.timeout,
            provider=args.provider,
            model=args.model,
        )
    else:
        execute_sync(
            base_url=args.base_url,
            message=args.message,
            max_iterations=args.max_iterations,
            timeout_seconds=args.timeout,
            provider=args.provider,
            model=args.model,
        )


if __name__ == "__main__":
    main()