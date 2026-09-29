"""Wipe runtime data (keeps schema) and clear chaos. Then re-run scripts.seed.

  python -m scripts.reset [--yes]
"""

from __future__ import annotations

import argparse

import httpx
from sqlalchemy import text

from app.config import get_settings
from app.db.session import session_scope
from app.services.events import redis_client

TABLES = ["staging_records", "raw_pulls", "orders", "inventory", "warehouse_stock", "sales",
          "alerts", "interventions", "sync_runs", "sessions", "consents", "sku_map", "connectors"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    if not ap.parse_args().yes and input("Wipe all Q-REX data? [y/N] ").lower() != "y":
        return
    with session_scope() as db:
        db.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
    r = redis_client()
    for pattern in ("qrex:sched:*", "qrex:lock:*", "qrex:inbox:*"):
        for k in r.scan_iter(pattern):
            r.delete(k)
    try:
        httpx.delete(get_settings().mock_platform_url + "/chaos", timeout=5)
    except httpx.HTTPError:
        print("mock-platform unreachable; chaos not reset")
    print("reset done — now run: python -m scripts.seed")


if __name__ == "__main__":
    main()
