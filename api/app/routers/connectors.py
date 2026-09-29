"""Connector admin, consent, human-in-the-loop re-auth, manual upload."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.session import get_db
from app.models import Consent, Connector, Intervention, SessionRow
from app.routers.deps import check_dataset, connector_by_platform
from app.services import monitor as mon
from app.services.events import mark_changed
from app.services.interventions import open_intervention
from app.services.pipeline import resume_after_reauth
from app.services.sessions import build_connector, store_session
from workers.connectors.base import AuthError, ConnectorError

router = APIRouter(tags=["connectors"])


def connector_view(db: Session, c: Connector) -> dict[str, Any]:
    sess = db.scalar(select(SessionRow).where(SessionRow.connector_id == c.id)
                     .order_by(SessionRow.id.desc()).limit(1))
    open_iv = db.scalar(select(Intervention).where(Intervention.connector_id == c.id,
                                                  Intervention.resolved_at.is_(None)))
    consents = db.scalars(select(Consent).where(Consent.connector_id == c.id,
                                                Consent.revoked_at.is_(None))).all()
    return {
        "id": c.id, "platform": c.platform, "display_name": c.display_name, "enabled": c.enabled,
        "status": c.status, "paused_at": c.paused_at, "config": c.config_json,
        "session": sess and {"status": sess.status, "expires_at": sess.expires_at,
                             "created_at": sess.created_at},
        "open_intervention": open_iv and {"id": open_iv.id, "kind": open_iv.kind,
                                          "requested_at": open_iv.requested_at, "note": open_iv.note},
        "consents": [{"source_path": x.source_path, "granted_by": x.granted_by, "scope": x.scope,
                      "granted_at": x.granted_at} for x in consents],
        "freshness": mon.freshness(db, c),
        "reauth_url": f"{get_settings().public_web_url}/connectors/{c.platform}/reauth",
    }


@router.get("/connectors")
def list_connectors(db: Session = Depends(get_db)) -> list[dict]:
    return [connector_view(db, c) for c in db.scalars(select(Connector).order_by(Connector.id))]


@router.get("/connectors/{platform}")
def get_connector(c: Connector = Depends(connector_by_platform), db: Session = Depends(get_db)) -> dict:
    return connector_view(db, c)


class ConfigPatch(BaseModel):
    enabled: bool | None = None
    schedules: dict[str, int] | None = Field(None, description="dataset -> seconds")
    freshness_sla: dict[str, int] | None = Field(None, description="dataset -> seconds")
    low_stock_threshold: int | None = None


@router.patch("/connectors/{platform}")
def patch_connector(body: ConfigPatch, c: Connector = Depends(connector_by_platform),
                    db: Session = Depends(get_db)) -> dict:
    cfg = dict(c.config_json or {})
    for key in ("schedules", "freshness_sla"):
        val = getattr(body, key)
        if val:
            for ds, secs in val.items():
                check_dataset(ds)
                if secs < 10:
                    raise HTTPException(422, f"{key}.{ds} must be >= 10 seconds")
            cfg[key] = {**cfg.get(key, {}), **val}
    if body.low_stock_threshold is not None:
        cfg["low_stock_threshold"] = body.low_stock_threshold
    c.config_json = cfg
    if body.enabled is not None:
        c.enabled = body.enabled
    mark_changed(db, "connectors")
    db.commit()
    return connector_view(db, c)


# ---------------------------------------------------------------------------
# Re-auth: human-in-the-loop OTP. No code path ever supplies an OTP itself.
# ---------------------------------------------------------------------------
@router.post("/reauth/{platform}/start")
def reauth_start(c: Connector = Depends(connector_by_platform), db: Session = Depends(get_db)) -> dict:
    connector = build_connector(db, c)
    try:
        ch = connector.begin_login()
    except ConnectorError as e:
        raise HTTPException(502, f"platform login unavailable: {e}") from e
    open_intervention(db, c.id, "REAUTH", note="re-auth started")
    db.commit()
    return {"challenge_id": ch.challenge_id, "delivery": ch.delivery, "expires_in": ch.expires_in,
            "message": f"An OTP was sent to the seller's registered phone ({ch.delivery})."}


class OtpBody(BaseModel):
    challenge_id: str
    otp: str = Field(min_length=4, max_length=8, pattern=r"^\d+$")


@router.post("/reauth/{platform}/otp")
def reauth_otp(body: OtpBody, c: Connector = Depends(connector_by_platform),
               db: Session = Depends(get_db)) -> dict:
    connector = build_connector(db, c)
    try:
        sess = connector.authenticate({"challenge_id": body.challenge_id, "otp": body.otp})
    except AuthError as e:
        raise HTTPException(401, "OTP rejected") from e
    except ConnectorError as e:
        raise HTTPException(400, f"re-auth failed: {e}") from e
    store_session(db, c.id, sess)
    gap_start = resume_after_reauth(db, c.id)
    db.commit()
    from workers.tasks import backfill

    task = backfill.delay(c.id, gap_start.isoformat())
    return {"status": "resumed", "session_expires_at": sess.expires_at,
            "backfill": {"task_id": task.id, "since": gap_start}}


# ---------------------------------------------------------------------------
# Manual upload fallback (bottom rung of the ladder)
# ---------------------------------------------------------------------------
@router.post("/upload/{platform}/{dataset}")
async def upload(dataset: str, file: UploadFile = File(...),
                 c: Connector = Depends(connector_by_platform)) -> dict:
    check_dataset(dataset)
    folder = get_settings().upload_dir / c.platform / dataset
    folder.mkdir(parents=True, exist_ok=True)
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "file too large")
    dest = folder / f"{datetime.now(UTC):%Y%m%dT%H%M%S%f}.csv"
    dest.write_bytes(data)
    from workers.tasks import sync_dataset

    task = sync_dataset.delay(c.id, dataset, "manual", None, "MANUAL_UPLOAD")
    return {"status": "queued", "task_id": task.id, "stored_as": dest.name}
