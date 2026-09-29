"""Server-Sent Events: the dashboard refetches when something changes."""

from __future__ import annotations

import asyncio
import json

import redis.asyncio as aioredis
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.services.events import CHANNEL

router = APIRouter(tags=["events"])


@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    async def stream():
        r = aioredis.Redis.from_url(get_settings().redis_url, decode_responses=True)
        ps = r.pubsub()
        await ps.subscribe(CHANNEL)
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                msg = await ps.get_message(ignore_subscribe_messages=True, timeout=15.0)
                if msg and msg.get("type") == "message":
                    yield f"event: change\ndata: {msg['data']}\n\n"
                else:
                    yield f"event: ping\ndata: {json.dumps({})}\n\n"
                await asyncio.sleep(0)
        finally:
            await ps.unsubscribe(CHANNEL)
            await ps.aclose()
            await r.aclose()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
