"""Tiny pub/sub used to push live updates to the UI over Server-Sent Events.

Worker threads call publish(); each connected browser tab owns an asyncio
queue that the SSE endpoint drains.
"""
import asyncio
import json
import threading

_subscribers: set[asyncio.Queue] = set()
_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop):
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue:
    q = asyncio.Queue(maxsize=500)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q):
    with _lock:
        _subscribers.discard(q)


def _put(q, msg):
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        pass


def publish(event: str, data=None):
    if _loop is None:
        return
    msg = f"event: {event}\ndata: {json.dumps(data if data is not None else {})}\n\n"
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        _loop.call_soon_threadsafe(_put, q, msg)
