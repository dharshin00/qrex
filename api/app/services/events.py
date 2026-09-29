"""Change notifications for the dashboard's SSE stream.

Code marks a DB session as having changed something (`mark_changed`); after the
transaction commits we publish one small message on Redis pub/sub, and fire any
queued post-commit hooks (e.g. external alert dispatch). Publishing after commit
means the dashboard never refetches before the data is visible.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from functools import lru_cache

import redis
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.config import get_settings

CHANNEL = "qrex:events"
log = logging.getLogger(__name__)


@lru_cache
def redis_client() -> redis.Redis:
    return redis.Redis.from_url(get_settings().redis_url, decode_responses=True)


def mark_changed(db: Session, topic: str) -> None:
    db.info.setdefault("qrex_topics", set()).add(topic)


def after_commit(db: Session, fn: Callable[[], None]) -> None:
    db.info.setdefault("qrex_hooks", []).append(fn)


def publish(topics: set[str]) -> None:
    try:
        redis_client().publish(CHANNEL, json.dumps({"topics": sorted(topics)}))
    except redis.RedisError as e:  # never fail a write because the UI ping failed
        log.warning("event publish failed: %s", e)


@event.listens_for(Session, "after_commit")
def _on_commit(db: Session) -> None:
    topics = db.info.pop("qrex_topics", None)
    hooks = db.info.pop("qrex_hooks", [])
    if topics:
        publish(topics)
    for fn in hooks:
        try:
            fn()
        except Exception:  # noqa: BLE001
            log.exception("post-commit hook failed")


@event.listens_for(Session, "after_rollback")
def _on_rollback(db: Session) -> None:
    db.info.pop("qrex_topics", None)
    db.info.pop("qrex_hooks", None)
