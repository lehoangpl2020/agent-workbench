"""Server-Sent Events plumbing for the run streams: format one event, drain a queue, wrap a response."""

import asyncio
import json

from fastapi.responses import StreamingResponse

from agent_workbench.domain.events import Event

SSE_PING_SECONDS = 15


def sse_event(event: str, data: dict) -> str:
    """Format Server-Sent Event."""
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


async def drain(queue: asyncio.Queue):
    """Reads events from the queue until 'done'; sends pings so the connection is not closed."""
    while True:
        try:
            event, data = await asyncio.wait_for(queue.get(), timeout=SSE_PING_SECONDS)
        except asyncio.TimeoutError:
            yield ": ping\n\n"
            continue
        yield sse_event(event, data)
        if event == Event.DONE:
            return


def sse_response(gen, on_close=None) -> StreamingResponse:
    async def wrapped():
        try:
            async for chunk in gen:
                yield chunk
        finally:
            # The client closed the stream: only unsubscribe, the run keeps going (only Stop stops the run)
            if on_close:
                on_close()

    return StreamingResponse(
        wrapped(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
