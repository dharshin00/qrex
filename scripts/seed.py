"""Deterministic demo seed.

  python -m scripts.seed            # migrate, connectors, consents, sku_map,
                                    # intervention baseline, simulated first login
  python -m scripts.seed --no-login # leave connectors needing re-auth in the UI

Idempotent: safe to run repeatedly.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from app.db.session import session_scope
from app.models import Consent, Connector, Intervention, SkuMap
from app.services.sessions import build_connector, store_session
from seed import catalog
from workers.connectors import REGISTRY

SELLER = "Verdant Foods (demo seller)"
SCHEDULES = {"orders": 60, "inventory": 120, "warehouse_stock": 60, "sales": 300}
SLA = {"orders": 300, "inventory": 600, "warehouse_stock": 300, "sales": 1200}
CONSENT_SCOPE = {
    "OFFICIAL_API": "Use an official/partner seller API if the platform offers one.",
    "PORTAL_EXPORT": "Download my standard seller-portal reports on my behalf at most once a minute.",
    "EMAIL_INGEST": "Parse scheduled report emails I forward to the Q-REX ingest mailbox.",
    "MANUAL_UPLOAD": "Process report files my team uploads.",
}
# "Before" baseline for the interventions/week chart: the manual, fragile
# workflow Q-REX replaces (weekly re-logins, broken scrapes). Marked as seed.
BASELINE_WEEKLY = [9, 8, 8, 6, 4, 3, 2]


def migrate() -> None:
    api = Path(__file__).resolve().parents[1] / "api"
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=api, check=True)


def seed_static() -> None:
    with session_scope() as db:
        for platform, cls in REGISTRY.items():
            stmt = insert(Connector).values(
                platform=platform, display_name=cls.display_name, enabled=True, status="active",
                config_json={"seller_id": "verdant-foods", "schedules": SCHEDULES,
                             "freshness_sla": SLA,
                             "low_stock_threshold": catalog.LOW_STOCK_THRESHOLD},
            ).on_conflict_do_nothing(index_elements=["platform"])
            db.execute(stmt)
        db.flush()
        conns = {c.platform: c for c in db.scalars(select(Connector))}

        for c in conns.values():
            have = set(db.scalars(select(Consent.source_path).where(Consent.connector_id == c.id)))
            for path, scope in CONSENT_SCOPE.items():
                if path not in have:
                    db.add(Consent(connector_id=c.id, source_path=path, granted_by=SELLER,
                                   scope=scope))

        rows = [dict(canonical_sku=p.canonical_sku, platform=pf,
                     platform_sku=catalog.platform_sku(pf, p.canonical_sku), product_name=p.name)
                for pf in catalog.PLATFORMS for p in catalog.PRODUCTS]
        db.execute(insert(SkuMap).values(rows).on_conflict_do_nothing(
            index_elements=["platform", "platform_sku"]))

        if not db.scalar(select(func.count()).select_from(Intervention)
                         .where(Intervention.note.like("seed:%"))):
            now = datetime.now(UTC)
            ids = [c.id for c in conns.values()]
            for w, n in enumerate(BASELINE_WEEKLY):
                week_start = now - timedelta(weeks=len(BASELINE_WEEKLY) - w)
                for k in range(n):
                    at = week_start + timedelta(hours=7 + 17 * k)
                    db.add(Intervention(
                        connector_id=ids[k % len(ids)],
                        kind="MANUAL_RELOGIN" if w < 4 else "REAUTH",
                        requested_at=at, resolved_at=at + timedelta(minutes=35 - 3 * w),
                        note="seed: pre-automation baseline (demo data)"))
    print(f"seeded connectors, consents, {len(catalog.PRODUCTS) * 2} sku_map rows, baseline")


def simulated_login() -> None:
    from scripts._seller import read_otp_from_phone

    with session_scope() as db:
        conns = list(db.scalars(select(Connector)))
    for c in conns:
        with session_scope() as db:
            connector = build_connector(db, c)
        ch = connector.begin_login()
        otp = read_otp_from_phone(c.platform)  # simulated human reads SMS
        sess = connector.authenticate({"challenge_id": ch.challenge_id, "otp": otp})
        with session_scope() as db:
            store_session(db, c.id, sess)
            conn = db.get(Connector, c.id)
            conn.status, conn.paused_at = "active", None
        print(f"{c.platform}: session established (expires {sess.expires_at:%Y-%m-%d %H:%M} UTC)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-login", action="store_true")
    ap.add_argument("--no-migrate", action="store_true")
    a = ap.parse_args()
    if not a.no_migrate:
        migrate()
    seed_static()
    if not a.no_login:
        simulated_login()


if __name__ == "__main__":
    main()
