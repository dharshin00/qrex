"""Idempotent clean-layer loader.

The ONLY writer to the clean tables. Normal syncs and backfills both come
through here (NOTE.md: never write a second loader).

INSERT ... ON CONFLICT (platform, external_id, sku) DO UPDATE ... WHERE
row_hash IS DISTINCT FROM excluded.row_hash — so a re-run with identical data
touches zero rows.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import CLEAN_MODELS

# as_of is a snapshot timestamp that moves every pull; hashing it would rewrite
# unchanged rows. Excluded, so as_of reads as "value last changed at".
_META = {"id", "loaded_at", "updated_at", "run_id", "row_hash", "source_path", "as_of"}
CHUNK = 1000


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def row_hash(record: dict[str, Any]) -> str:
    """Stable hash over business fields only (not provenance/run metadata)."""
    body = {k: _jsonable(v) for k, v in sorted(record.items()) if k not in _META}
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


def upsert_clean(db: Session, dataset: str, records: list[dict[str, Any]], *,
                 run_id: int, source_path: str) -> int:
    """Upsert canonical records; returns number of rows inserted or changed."""
    if not records:
        return 0
    model = CLEAN_MODELS[dataset]
    table = model.__table__
    data_cols = [c.name for c in table.columns if c.name not in {"id", "loaded_at"}]
    changed = 0
    for i in range(0, len(records), CHUNK):
        rows = []
        for r in records[i : i + CHUNK]:
            row = {k: r[k] for k in r if k in table.columns}
            row["row_hash"] = row_hash(row)
            row["run_id"] = run_id
            row["source_path"] = source_path
            rows.append(row)
        stmt = insert(table).values(rows)
        update_cols = {c: stmt.excluded[c] for c in data_cols
                       if c not in {"platform", "external_id", "sku", "updated_at"}}
        update_cols["updated_at"] = func.now()
        stmt = stmt.on_conflict_do_update(
            index_elements=["platform", "external_id", "sku"],
            set_=update_cols,
            where=table.c.row_hash.is_distinct_from(stmt.excluded.row_hash),
        ).returning(table.c.id)
        # RETURNING yields only inserted/updated rows (skipped conflicts return nothing)
        changed += len(db.execute(stmt).all())
    return changed
