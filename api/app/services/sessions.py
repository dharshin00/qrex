"""Encrypted session storage (Fernet, key from ENCRYPTION_KEY).

Plaintext session tokens exist only in memory. The DB holds Fernet tokens; logs
never see either (see app.logging redaction filter).
"""

from __future__ import annotations

from datetime import UTC, datetime
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, update
from sqlalchemy.orm import Session as DB

from app.config import get_settings
from app.models import Consent, Connector, SessionRow
from workers.connectors.base import BaseConnector, Session


@lru_cache
def _fernet() -> Fernet:
    key = get_settings().encryption_key
    if not key:
        raise RuntimeError("ENCRYPTION_KEY is not set (see .env.example)")
    return Fernet(key.encode())


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def store_session(db: DB, connector_id: int, session: Session) -> SessionRow:
    db.execute(update(SessionRow)
               .where(SessionRow.connector_id == connector_id, SessionRow.status == "active")
               .values(status="replaced"))
    row = SessionRow(connector_id=connector_id, encrypted_blob=encrypt(session.token),
                     expires_at=session.expires_at, status="active")
    db.add(row)
    db.flush()
    return row


def load_session(db: DB, connector_id: int) -> Session | None:
    row = db.scalar(select(SessionRow)
                    .where(SessionRow.connector_id == connector_id, SessionRow.status == "active")
                    .order_by(SessionRow.id.desc()).limit(1))
    if row is None:
        return None
    try:
        return Session(decrypt(row.encrypted_blob), row.expires_at)
    except InvalidToken:  # key rotated / tampered: treat as no session
        return None


def mark_expired(db: DB, connector_id: int) -> None:
    db.execute(update(SessionRow)
               .where(SessionRow.connector_id == connector_id, SessionRow.status == "active")
               .values(status="expired", expires_at=datetime.now(UTC)))


def consented_paths(db: DB, connector_id: int) -> set[str]:
    return set(db.scalars(select(Consent.source_path)
                          .where(Consent.connector_id == connector_id,
                                 Consent.revoked_at.is_(None))))


def build_connector(db: DB, conn: Connector) -> BaseConnector:
    from workers.connectors import connector_class

    return connector_class(conn.platform)(conn.config_json or {}, consented_paths(db, conn.id))
