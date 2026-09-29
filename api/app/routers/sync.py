"""On-demand triggers for everything that is scheduled (IDEATION §8.4) + run history."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Connector, RawPullRow, SyncRun
from app.routers.deps import DATASETS, check_dataset, connector_by_platform

router = APIRouter(tags=["sync"])


@router.post("/sync/{platform}/{dataset}")
def trigger_sync(dataset: str, since: datetime | None = None,
                 c: Connector = Depends(connector_by_platform)) -> dict:
    from workers.tasks import sync_dataset

    dss = DATASETS if dataset == "all" else (check_dataset(dataset),)
    tasks = {ds: sync_dataset.delay(c.id, ds, "manual", since.isoformat() if since else None).id
             for ds in dss}
    return {"status": "queued", "tasks": tasks}


@router.post("/sync")
def trigger_all(db: Session = Depends(get_db)) -> dict:
    from workers.tasks import sync_dataset

    out = {}
    for c in db.scalars(select(Connector).where(Connector.enabled.is_(True))):
        out[c.platform] = {ds: sync_dataset.delay(c.id, ds, "manual").id for ds in DATASETS}
    return {"status": "queued", "tasks": out}


@router.post("/backfill/{platform}")
def trigger_backfill(since: datetime, c: Connector = Depends(connector_by_platform)) -> dict:
    from workers.tasks import backfill

    return {"status": "queued", "task_id": backfill.delay(c.id, since.isoformat()).id}


@router.post("/probe")
def run_probe() -> dict:
    """Run the session health probe now (normally every 30s via beat)."""
    from workers.tasks import health_probe

    return health_probe()


@router.post("/monitor")
def run_monitor() -> dict:
    """Run freshness + stock evaluation now (normally every 30s via beat)."""
    from workers.tasks import monitor

    return monitor()


@router.get("/runs")
def list_runs(platform: str | None = None, dataset: str | None = None, status: str | None = None,
              mode: str | None = None, since_id: int | None = None,
              limit: int = Query(100, le=500), db: Session = Depends(get_db)) -> list[dict]:
    q = (select(SyncRun, Connector.platform).join(Connector, Connector.id == SyncRun.connector_id)
         .order_by(SyncRun.id.desc()).limit(limit))
    if platform:
        q = q.where(Connector.platform == platform)
    if dataset:
        q = q.where(SyncRun.dataset == dataset)
    if status:
        q = q.where(SyncRun.status == status)
    if mode:
        q = q.where(SyncRun.mode == mode)
    if since_id:
        q = q.where(SyncRun.id > since_id)
    out = []
    for r, p in db.execute(q).all():
        out.append({
            "id": r.id, "platform": p, "dataset": r.dataset, "status": r.status, "mode": r.mode,
            "attempt": r.attempt, "source_path": r.source_path, "window_start": r.window_start,
            "window_end": r.window_end, "started_at": r.started_at, "finished_at": r.finished_at,
            "duration_ms": int((r.finished_at - r.started_at).total_seconds() * 1000)
            if r.finished_at else None,
            "rows_in": r.rows_in, "rows_upserted": r.rows_upserted, "error": r.error,
        })
    return out


@router.get("/raw/{raw_id}")
def get_raw(raw_id: int, db: Session = Depends(get_db)) -> dict:
    r = db.get(RawPullRow, raw_id)
    if r is None:
        return {}
    return {"id": r.id, "dataset": r.dataset, "source_path": r.source_path, "row_count": r.row_count,
            "row_hint": r.row_hint, "quarantined": r.quarantined,
            "quarantine_reason": r.quarantine_reason, "fetched_at": r.fetched_at,
            "payload_head": "\n".join(r.payload.splitlines()[:6])}
