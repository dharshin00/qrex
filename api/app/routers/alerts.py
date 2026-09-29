from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Alert, Connector, Intervention
from app.services.events import mark_changed

router = APIRouter(tags=["alerts"])


def alert_view(a: Alert, platform: str | None) -> dict:
    return {"id": a.id, "kind": a.kind, "severity": a.severity, "platform": platform,
            "dataset": a.dataset, "message": a.message, "payload": a.payload,
            "occurrences": a.occurrences, "created_at": a.created_at,
            "last_seen_at": a.last_seen_at, "resolved_at": a.resolved_at,
            "delivered": a.delivered}


@router.get("/alerts")
def list_alerts(status: str = Query("all", pattern="^(open|resolved|all)$"), kind: str | None = None,
                limit: int = Query(200, le=1000), db: Session = Depends(get_db)) -> list[dict]:
    q = (select(Alert, Connector.platform).outerjoin(Connector, Connector.id == Alert.connector_id)
         .order_by(Alert.resolved_at.is_not(None), Alert.last_seen_at.desc()).limit(limit))
    if status == "open":
        q = q.where(Alert.resolved_at.is_(None))
    elif status == "resolved":
        q = q.where(Alert.resolved_at.is_not(None))
    if kind:
        q = q.where(Alert.kind == kind)
    return [alert_view(a, p) for a, p in db.execute(q).all()]


@router.post("/alerts/{alert_id}/resolve")
def resolve(alert_id: int, db: Session = Depends(get_db)) -> dict:
    a = db.get(Alert, alert_id)
    if a is None:
        raise HTTPException(404)
    if a.resolved_at is None:
        a.resolved_at = datetime.now(UTC)
        mark_changed(db, "alerts")
        db.commit()
    return alert_view(a, None)


@router.get("/interventions")
def list_interventions(limit: int = Query(100, le=500), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.execute(select(Intervention, Connector.platform)
                      .join(Connector, Connector.id == Intervention.connector_id)
                      .order_by(Intervention.requested_at.desc()).limit(limit)).all()
    return [{"id": i.id, "platform": p, "kind": i.kind, "requested_at": i.requested_at,
             "resolved_at": i.resolved_at, "note": i.note,
             "gap_minutes_recovered": i.gap_minutes_recovered} for i, p in rows]
