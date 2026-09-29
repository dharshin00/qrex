from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Intervention
from app.services.events import mark_changed


def open_intervention(db: Session, connector_id: int, kind: str, note: str | None = None) -> Intervention:
    """Idempotent: returns the already-open intervention of this kind if any."""
    cur = db.scalar(select(Intervention).where(
        Intervention.connector_id == connector_id, Intervention.kind == kind,
        Intervention.resolved_at.is_(None)))
    if cur:
        return cur
    i = Intervention(connector_id=connector_id, kind=kind, note=note,
                     requested_at=datetime.now(UTC))
    db.add(i)
    db.flush()
    mark_changed(db, "interventions")
    return i


def close_intervention(db: Session, connector_id: int, kind: str, *,
                       gap_minutes: int | None = None, note: str | None = None) -> Intervention | None:
    cur = db.scalar(select(Intervention).where(
        Intervention.connector_id == connector_id, Intervention.kind == kind,
        Intervention.resolved_at.is_(None)))
    if cur:
        cur.resolved_at = datetime.now(UTC)
        cur.gap_minutes_recovered = gap_minutes
        if note:
            cur.note = f"{cur.note or ''} {note}".strip()
        mark_changed(db, "interventions")
    return cur
