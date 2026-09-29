"""Alert creation with de-duplication (one OPEN alert per kind/connector/dataset)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Alert
from app.services.events import after_commit, mark_changed

SEVERITY = {
    "SESSION_EXPIRED": "critical",
    "SCHEMA_DRIFT": "critical",
    "PULL_FAILED": "critical",
    "STOCK_OUT": "critical",
    "PARTIAL_PULL": "warn",
    "STALE_SOURCE": "warn",
    "LOW_STOCK": "warn",
}
KINDS = tuple(SEVERITY)


def dedup_key(kind: str, connector_id: int | None, dataset: str | None) -> str:
    return f"{kind}:{connector_id or '-'}:{dataset or '-'}"


def raise_alert(db: Session, kind: str, *, connector_id: int | None, dataset: str | None,
                message: str, payload: dict[str, Any] | None = None) -> tuple[Alert, bool]:
    """Open an alert, or bump the existing open one. Returns (alert, is_new).

    New alerts are dispatched to external channels after the transaction commits.
    """
    key = dedup_key(kind, connector_id, dataset)
    now = datetime.now(UTC)
    existing = db.scalar(select(Alert).where(Alert.dedup_key == key, Alert.resolved_at.is_(None))
                         .with_for_update())
    if existing:
        existing.occurrences += 1
        existing.last_seen_at = now
        existing.message = message
        existing.payload = payload or existing.payload
        mark_changed(db, "alerts")
        return existing, False
    a = Alert(kind=kind, severity=SEVERITY[kind], connector_id=connector_id, dataset=dataset,
              message=message, payload=payload or {}, dedup_key=key, created_at=now,
              last_seen_at=now, delivered={})
    # a concurrent writer may insert the same open key; the partial unique index
    # makes that a conflict we can absorb
    with db.begin_nested() as sp:
        db.add(a)
        try:
            db.flush()
        except IntegrityError:  # lost a race on the open-dedup index
            sp.rollback()
            other = db.scalar(select(Alert).where(Alert.dedup_key == key,
                                                  Alert.resolved_at.is_(None)))
            if other:
                other.occurrences += 1
                return other, False
            raise
    mark_changed(db, "alerts")
    alert_id = a.id

    def _dispatch() -> None:
        from workers.tasks import dispatch_alert

        dispatch_alert.delay(alert_id)

    after_commit(db, _dispatch)
    return a, True


def resolve_alerts(db: Session, kinds: list[str] | tuple[str, ...], *, connector_id: int | None,
                   dataset: str | None = None, keep: set[str] | None = None) -> int:
    """Resolve open alerts of the given kinds for a connector (optionally one dataset).

    `keep`: dataset values that must stay open (used by stock evaluation).
    """
    q = update(Alert).where(Alert.kind.in_(kinds), Alert.resolved_at.is_(None))
    if connector_id is not None:
        q = q.where(Alert.connector_id == connector_id)
    if dataset is not None:
        q = q.where(Alert.dataset == dataset)
    if keep:
        q = q.where(Alert.dataset.not_in(keep))
    n = db.execute(q.values(resolved_at=datetime.now(UTC))).rowcount or 0
    if n:
        mark_changed(db, "alerts")
    return n
