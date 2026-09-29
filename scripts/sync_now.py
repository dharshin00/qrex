"""Trigger every connector/dataset now.

  python -m scripts.sync_now          # run inline, print outcomes
  python -m scripts.sync_now --queue  # enqueue on the Celery workers instead
"""

from __future__ import annotations

import argparse

from sqlalchemy import select

from app.db.session import session_scope
from app.models import Connector
from app.services.monitor import DATASETS
from app.services.pipeline import Retryable, perform_sync


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", action="store_true")
    ap.add_argument("--platform")
    a = ap.parse_args()
    with session_scope() as db:
        conns = [(c.id, c.platform) for c in db.scalars(select(Connector).where(Connector.enabled))
                 if a.platform in (None, c.platform)]
    for cid, platform in conns:
        for ds in DATASETS:
            if a.queue:
                from workers.tasks import sync_dataset

                print(platform, ds, "queued", sync_dataset.delay(cid, ds, "manual").id)
                continue
            try:
                out = perform_sync(cid, ds, mode="manual")
                print(f"{platform:10} {ds:16} {out.status:12} via {out.source_path} "
                      f"rows_in={out.rows_in} upserted={out.rows_upserted} {out.error or ''}")
            except Retryable as e:
                print(f"{platform:10} {ds:16} retryable: {e}")


if __name__ == "__main__":
    main()
