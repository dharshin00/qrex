"""The sync pipeline (docs/ARCH.md §3):

  Authentication -> Retrieval -> raw -> Validation -> staging -> Transformation
  -> idempotent clean upsert -> Monitoring & Alerts

`perform_sync` is the single code path for scheduled, manual and backfill runs,
so backfill can never introduce duplicates (NOTE.md). It never holds a DB
transaction open across a network call.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from app.db.session import session_scope
from app.models import Connector, RawPullRow, StagingRecord, SyncRun
from app.services.alerts import raise_alert, resolve_alerts
from app.services.events import mark_changed
from app.services.interventions import close_intervention, open_intervention
from app.services.load import upsert_clean
from app.services.monitor import evaluate_stock
from app.services.notify import reauth_link
from app.services.sessions import build_connector, load_session, mark_expired
from app.services.transform import sku_lookup, to_clean
from app.services.validation import ValidationFailure, validate
from workers.connectors.base import (
    ConnectorError, Dataset, SessionExpired, SourcePath, TransientError, Window,
)

log = logging.getLogger(__name__)

ORDERS_OVERLAP = timedelta(minutes=5)
FIRST_SYNC_LOOKBACK = timedelta(hours=24)
RECOVERY_KINDS = ["PULL_FAILED", "SCHEMA_DRIFT", "PARTIAL_PULL", "STALE_SOURCE"]


class Retryable(Exception):
    def __init__(self, reason: str, retry_after: float | None = None):
        super().__init__(reason)
        self.retry_after = retry_after


@dataclass
class SyncOutcome:
    status: str
    run_id: int | None = None
    rows_in: int | None = None
    rows_upserted: int | None = None
    source_path: str | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def orders_watermark(db: Session, connector_id: int) -> datetime | None:
    return db.scalar(select(func.max(SyncRun.window_end)).where(
        SyncRun.connector_id == connector_id, SyncRun.dataset == "orders",
        SyncRun.status == "success"))


def _history_counts(db: Session, connector_id: int, dataset: str, source_path: str) -> list[int]:
    return list(db.scalars(select(SyncRun.rows_in).where(
        SyncRun.connector_id == connector_id, SyncRun.dataset == dataset,
        SyncRun.status == "success", SyncRun.source_path == source_path,
        SyncRun.mode != "backfill").order_by(SyncRun.id.desc()).limit(10)))


def _jsonable(rec: dict[str, Any]) -> dict[str, Any]:
    return {k: (v.isoformat() if isinstance(v, (datetime, date)) else v) for k, v in rec.items()}


def _finish(db: Session, run_id: int, status: str, **kw: Any) -> None:
    run = db.get(SyncRun, run_id)
    run.status = status
    run.finished_at = datetime.now(UTC)
    for k, v in kw.items():
        setattr(run, k, v)
    mark_changed(db, "runs")


# ---------------------------------------------------------------------------
# session expiry / re-auth
# ---------------------------------------------------------------------------
def handle_session_expired(db: Session, connector_id: int, reason: str) -> None:
    """Pause connector, mark session expired, open intervention, alert seller."""
    conn = db.get(Connector, connector_id, with_for_update=True)
    if conn.status != "paused":
        conn.status = "paused"
        conn.paused_at = datetime.now(UTC)
        mark_changed(db, "connectors")
    mark_expired(db, connector_id)
    open_intervention(db, connector_id, "REAUTH", note=reason)
    raise_alert(db, "SESSION_EXPIRED", connector_id=connector_id, dataset=None,
                message=f"{conn.display_name} seller session expired ({reason}). Sync is paused and "
                        f"data is marked stale until you re-authenticate: {reauth_link(conn.platform)}",
                payload={"reauth_url": reauth_link(conn.platform), "reason": reason})


def resume_after_reauth(db: Session, connector_id: int) -> datetime:
    """Called after a human completed OTP. Returns the backfill start (gap start)."""
    conn = db.get(Connector, connector_id, with_for_update=True)
    wm = orders_watermark(db, connector_id)
    gap_start = min(x for x in (wm, conn.paused_at, datetime.now(UTC)) if x is not None)
    conn.status = "active"
    conn.paused_at = None
    resolve_alerts(db, ["SESSION_EXPIRED"], connector_id=connector_id)
    mark_changed(db, "connectors")
    return gap_start


def finish_backfill(db: Session, connector_id: int, gap_start: datetime) -> int:
    gap = max(math.ceil((datetime.now(UTC) - gap_start).total_seconds() / 60), 0)
    close_intervention(db, connector_id, "REAUTH", gap_minutes=gap, note="re-auth + backfill complete")
    return gap


# ---------------------------------------------------------------------------
# the sync
# ---------------------------------------------------------------------------
def perform_sync(connector_id: int, dataset: str, *, mode: str = "scheduled", attempt: int = 1,
                 final_attempt: bool = True, task_id: str | None = None,
                 since: datetime | None = None, until: datetime | None = None,
                 only: SourcePath | None = None) -> SyncOutcome:
    ds = Dataset(dataset)

    # -- open run ---------------------------------------------------------
    with session_scope() as db:
        conn = db.get(Connector, connector_id)
        if conn is None or not conn.enabled:
            return SyncOutcome("skipped", error="connector disabled")
        window = Window()
        if ds is Dataset.ORDERS:
            now = datetime.now(UTC)
            if since is None:
                wm = orders_watermark(db, connector_id)
                since = (wm - ORDERS_OVERLAP) if wm else now - FIRST_SYNC_LOOKBACK
            window = Window(since=since, until=until or now)
        run = SyncRun(connector_id=connector_id, dataset=dataset, status="running", mode=mode,
                      attempt=attempt, task_id=task_id, window_start=window.since,
                      window_end=window.until, started_at=datetime.now(UTC))
        db.add(run)
        db.flush()
        run_id = run.id
        platform = conn.platform
        session = load_session(db, connector_id)
        connector = build_connector(db, conn)
        mark_changed(db, "runs")

    # -- retrieve (no txn held) --------------------------------------------
    try:
        pull = connector.fetch(ds, session, window, only=only)
    except SessionExpired as e:
        with session_scope() as db:
            handle_session_expired(db, connector_id, str(e))
            _finish(db, run_id, "paused", error=f"SessionExpired: {e}")
        return SyncOutcome("paused", run_id, error=str(e))
    except TransientError as e:
        with session_scope() as db:
            _finish(db, run_id, "failed" if final_attempt else "retrying",
                    error=f"attempt {attempt}: {e}")
            if final_attempt:
                raise_alert(db, "PULL_FAILED", connector_id=connector_id, dataset=dataset,
                            message=f"{platform} {dataset}: pull failed after {attempt} attempts "
                                    f"({e}). Last-good data is still served, marked stale.",
                            payload={"run_id": run_id, "error": str(e), "attempts": attempt})
        if final_attempt:
            return SyncOutcome("failed", run_id, error=str(e))
        raise Retryable(str(e), e.retry_after) from e
    except ConnectorError as e:  # NotAvailable, AuthError, other 4xx: not retryable
        with session_scope() as db:
            _finish(db, run_id, "failed", error=f"{type(e).__name__}: {e}")
            raise_alert(db, "PULL_FAILED", connector_id=connector_id, dataset=dataset,
                        message=f"{platform} {dataset}: no source path could serve the pull ({e})",
                        payload={"run_id": run_id, "error": str(e)})
        return SyncOutcome("failed", run_id, error=str(e))

    # -- raw (durable before anything else) --------------------------------
    with session_scope() as db:
        if pull.session_expired:
            handle_session_expired(db, connector_id, "portal session expired; fell back to "
                                   f"{pull.source_path.name}")
        raw = RawPullRow(connector_id=connector_id, dataset=dataset,
                         source_path=pull.source_path.name, payload=pull.payload,
                         row_count=max(pull.payload.count("\n") - 1, 0), row_hint=pull.row_hint,
                         fetched_at=pull.fetched_at, run_id=run_id)
        db.add(raw)
        db.flush()
        raw_id = raw.id
        run = db.get(SyncRun, run_id)
        run.source_path = pull.source_path.name
    pull.ack()

    # -- validate -> staging -> clean ---------------------------------------
    retry_partial = False
    with session_scope() as db:
        conn = db.get(Connector, connector_id)
        try:
            records = validate(dataset=dataset, payload=pull.payload,
                               columns=connector.COLUMNS[dataset], row_hint=pull.row_hint,
                               history_counts=_history_counts(db, connector_id, dataset,
                                                              pull.source_path.name))
        except ValidationFailure as vf:
            raw = db.get(RawPullRow, raw_id)
            raw.quarantined = True
            raw.quarantine_reason = str(vf)
            retry_partial = (vf.kind == "PARTIAL_PULL" and not final_attempt
                             and pull.source_path is SourcePath.PORTAL_EXPORT)
            _finish(db, run_id, "quarantined", error=str(vf))
            raise_alert(db, vf.kind, connector_id=connector_id, dataset=dataset,
                        message=f"{conn.display_name} {dataset}: {vf.reason}. Pull quarantined "
                                f"(raw_pull #{raw_id}); clean layer untouched.",
                        payload={**vf.details, "raw_pull_id": raw_id, "run_id": run_id,
                                 "source_path": pull.source_path.name})
            outcome = SyncOutcome("quarantined", run_id, source_path=pull.source_path.name,
                                  error=str(vf))
        else:
            if records:
                db.execute(insert(StagingRecord), [
                    {"run_id": run_id, "dataset": dataset, "normalized_json": _jsonable(r),
                     "sku_raw": r["sku"]} for r in records])
            clean = to_clean(dataset, platform, records, sku_lookup(db, platform))
            n = upsert_clean(db, dataset, clean, run_id=run_id, source_path=pull.source_path.name)
            _finish(db, run_id, "success", rows_in=len(records), rows_upserted=n)
            resolve_alerts(db, RECOVERY_KINDS, connector_id=connector_id, dataset=dataset)
            if ds is Dataset.WAREHOUSE_STOCK:
                evaluate_stock(db, conn)
            mark_changed(db, "data")
            outcome = SyncOutcome("success", run_id, len(records), n, pull.source_path.name)
    if retry_partial:
        raise Retryable(outcome.error or "partial pull")
    return outcome
