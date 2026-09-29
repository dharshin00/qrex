"""Re-pull a window through the normal idempotent load path.

  python -m scripts.backfill --platform blinkit --hours 6 [--queue]
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.db.session import session_scope
from app.models import Connector
from app.services.monitor import DATASETS
from app.services.pipeline import perform_sync


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", required=True)
    ap.add_argument("--hours", type=float, default=6)
    ap.add_argument("--queue", action="store_true")
    a = ap.parse_args()
    since = datetime.now(UTC) - timedelta(hours=a.hours)
    with session_scope() as db:
        cid = db.scalar(select(Connector.id).where(Connector.platform == a.platform))
    if a.queue:
        from workers.tasks import backfill

        print("queued", backfill.delay(cid, since.isoformat()).id)
        return
    for ds in DATASETS:
        out = perform_sync(cid, ds, mode="backfill", since=since if ds == "orders" else None)
        print(f"{ds:16} {out.status:12} rows_in={out.rows_in} upserted={out.rows_upserted}")


if __name__ == "__main__":
    main()
