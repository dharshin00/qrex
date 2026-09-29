"""Celery tasks. Every task is idempotent and safe to retry (NOTE.md).

- sync_dataset   one (connector, dataset) pull; Redis lock prevents overlap;
                 exponential backoff + jitter on transient failures.
- backfill       re-pull the stale window after re-auth (same load path).
- dispatch_due   beat tick: enqueue syncs whose interval elapsed.
- health_probe   detect expired / near-TTL sessions before a sync hits them.
- monitor        freshness SLA + stock evaluation.
- dispatch_alert deliver a new alert to external channels.
- prune          trim staging / old raw pulls.
"""

from __future__ import annotations

import logging
import random
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from redis.exceptions import LockError
from sqlalchemy import delete, select

from app.config import get_settings
from app.db.session import session_scope
from app.models import Alert, Connector, RawPullRow, StagingRecord
from app.services import monitor as mon
from app.services.events import mark_changed, redis_client
from app.services.notify import dispatch
from app.services.pipeline import (
    Retryable, finish_backfill, handle_session_expired, perform_sync,
)
from app.services.sessions import build_connector, load_session
from workers.celery_app import celery
from workers.connectors.base import ConnectorError, SourcePath, TransientError

log = logging.getLogger(__name__)
DATASETS = mon.DATASETS
NEAR_TTL = timedelta(minutes=10)


def backoff(retries: int, retry_after: float | None = None) -> float:
    s = get_settings()
    delay = min(s.sync_retry_cap, s.sync_retry_base * (2 ** retries)) * random.uniform(0.5, 1.5)
    return max(delay, retry_after or 0)


@contextmanager
def dataset_lock(connector_id: int, dataset: str, wait: float | None = None):
    lock = redis_client().lock(f"qrex:lock:{connector_id}:{dataset}",
                               timeout=get_settings().sync_lock_ttl,
                               blocking=wait is not None, blocking_timeout=wait)
    got = lock.acquire()
    try:
        yield got
    finally:
        if got:
            try:
                lock.release()
            except LockError:  # expired under us; nothing to release
                pass


@celery.task(bind=True, name="workers.tasks.sync_dataset", max_retries=None)
def sync_dataset(self, connector_id: int, dataset: str, mode: str = "scheduled",
                 since: str | None = None, only: str | None = None) -> dict:
    s = get_settings()
    # scheduled runs skip if one is in flight; explicit triggers wait their turn
    wait = None if mode == "scheduled" else 60
    with dataset_lock(connector_id, dataset, wait=wait) as got:
        if not got:
            log.info("sync %s/%s already running; skipped", connector_id, dataset)
            return {"status": "skipped_locked"}
        if only in ("EMAIL_INGEST", "MANUAL_UPLOAD") and not _has_drop_file(connector_id, dataset, only):
            return {"status": "skipped_no_file"}  # another task already consumed it
        try:
            out = perform_sync(
                connector_id, dataset, mode=mode, attempt=self.request.retries + 1,
                final_attempt=self.request.retries >= s.sync_max_retries,
                task_id=self.request.id,
                since=datetime.fromisoformat(since) if since else None,
                only=SourcePath[only] if only else None)
        except Retryable as e:
            countdown = backoff(self.request.retries, e.retry_after)
            log.warning("sync %s/%s attempt %d failed (%s); retry in %.1fs", connector_id, dataset,
                        self.request.retries + 1, e, countdown)
            raise self.retry(countdown=countdown, exc=e) from None
    return out.as_dict()


def _has_drop_file(connector_id: int, dataset: str, only: str) -> bool:
    s = get_settings()
    with session_scope() as db:
        platform = db.get(Connector, connector_id).platform
    root = s.inbox_dir if only == "EMAIL_INGEST" else s.upload_dir
    folder = root / platform / dataset
    return folder.is_dir() and any(folder.glob("*.csv"))


@celery.task(bind=True, name="workers.tasks.backfill", max_retries=None)
def backfill(self, connector_id: int, gap_start: str) -> dict:
    """Re-pull every dataset from the gap start via the normal idempotent path."""
    s = get_settings()
    start = datetime.fromisoformat(gap_start)
    results = {}
    for ds in DATASETS:
        with dataset_lock(connector_id, ds, wait=120) as got:
            if not got:
                raise self.retry(countdown=5)
            try:
                out = perform_sync(connector_id, ds, mode="backfill",
                                   attempt=self.request.retries + 1,
                                   final_attempt=self.request.retries >= s.sync_max_retries,
                                   task_id=self.request.id,
                                   since=start if ds == "orders" else None)
            except Retryable as e:
                raise self.retry(countdown=backoff(self.request.retries, e.retry_after)) from None
        results[ds] = out.as_dict()
        if out.status == "paused":  # session died again mid-backfill; wait for next re-auth
            return {"status": "paused", "results": results}
    ok = all(r["status"] == "success" for r in results.values())
    gap = None
    if ok:
        with session_scope() as db:
            gap = finish_backfill(db, connector_id, start)
    return {"status": "success" if ok else "partial", "gap_minutes": gap, "results": results}


@celery.task(name="workers.tasks.dispatch_due")
def dispatch_due() -> list[str]:
    """Enqueue due syncs. A Redis NX key with TTL=interval *is* the schedule."""
    r = redis_client()
    s = get_settings()
    queued = []
    with session_scope() as db:
        conns = list(db.scalars(select(Connector).where(Connector.enabled.is_(True))))
    for c in conns:
        for ds in DATASETS:
            # email-ingest drop folder: ingest any waiting report regardless of pause
            inbox = s.inbox_dir / c.platform / ds
            if (inbox.is_dir() and any(inbox.glob("*.csv"))
                    and r.set(f"qrex:inbox:{c.id}:{ds}", "1", nx=True, ex=30)):
                sync_dataset.delay(c.id, ds, "scheduled", None, "EMAIL_INGEST")
                queued.append(f"{c.platform}/{ds}:email")
            if c.status == "paused":
                continue  # waiting on a human re-auth
            if r.set(f"qrex:sched:{c.id}:{ds}", "1", nx=True, ex=mon.schedule_seconds(c, ds)):
                sync_dataset.delay(c.id, ds, "scheduled")
                queued.append(f"{c.platform}/{ds}")
    return queued


@celery.task(name="workers.tasks.health_probe")
def health_probe() -> dict:
    """Detect invalid / near-expiry sessions *before* a scheduled sync hits them."""
    out = {}
    with session_scope() as db:
        conns = list(db.scalars(select(Connector).where(Connector.enabled.is_(True),
                                                       Connector.status == "active")))
    for c in conns:
        with session_scope() as db:
            sess = load_session(db, c.id)
            connector = build_connector(db, c)
        reason = None
        if sess is None:
            reason = "no active session"
        elif sess.expires_at - datetime.now(UTC) < NEAR_TTL:
            reason = f"session expires at {sess.expires_at:%H:%M} UTC (within {NEAR_TTL})"
        else:
            try:
                if not connector.is_session_valid(sess):
                    reason = "portal reports session invalid"
            except (TransientError, ConnectorError) as e:
                out[c.platform] = f"probe inconclusive: {e}"  # don't pause on a blip
                continue
        if reason:
            with session_scope() as db:
                handle_session_expired(db, c.id, reason)
        out[c.platform] = reason or "ok"
    return out


@celery.task(name="workers.tasks.monitor")
def monitor() -> dict:
    out = {}
    with session_scope() as db:
        for c in db.scalars(select(Connector).where(Connector.enabled.is_(True))):
            mon.evaluate_freshness(db, c)
            out[c.platform] = mon.evaluate_stock(db, c)
    return out


@celery.task(bind=True, name="workers.tasks.dispatch_alert", max_retries=3)
def dispatch_alert(self, alert_id: int) -> dict:
    with session_scope() as db:
        a = db.get(Alert, alert_id)
        if a is None or a.delivered.get("email") == "sent":
            return {"status": "noop"}
        conn = db.get(Connector, a.connector_id) if a.connector_id else None
        result = dispatch(a, conn)
        a.delivered = result
        mark_changed(db, "alerts")
    return result


@celery.task(name="workers.tasks.prune")
def prune() -> dict:
    now = datetime.now(UTC)
    with session_scope() as db:
        st = db.execute(delete(StagingRecord).where(
            StagingRecord.created_at < now - timedelta(hours=24))).rowcount
        # keep quarantined raw pulls (audit), trim healthy ones after 7 days
        rp = db.execute(delete(RawPullRow).where(
            RawPullRow.fetched_at < now - timedelta(days=7),
            RawPullRow.quarantined.is_(False))).rowcount
    return {"staging_deleted": st, "raw_deleted": rp}
