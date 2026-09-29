"""Validation gate between raw and staging (docs/ARCH.md §7).

Order of checks:
1. Transfer integrity  -> PARTIAL_PULL  (row-count vs source hint, truncated tail,
                                         malformed rows)
2. Schema drift        -> SCHEMA_DRIFT  (set diff of headers; order-insensitive)
3. Row contract        -> SCHEMA_DRIFT  (Pydantic type/constraint violations)
4. Expectations        -> SCHEMA_DRIFT / PARTIAL_PULL (future timestamps,
                                         all-null required cols, row-count band)

Any failure raises ValidationFailure; the caller quarantines the pull and
nothing reaches staging or clean.
"""

from __future__ import annotations

import csv
import io
import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from app.schemas.contracts import CONTRACTS, SNAPSHOT_DATASETS, TIMESTAMP_FIELDS

CLOCK_SKEW = timedelta(minutes=5)
BAND_MIN_HISTORY = 3
BAND_LOW_RATIO = 0.5


@dataclass
class ValidationFailure(Exception):
    kind: str  # SCHEMA_DRIFT | PARTIAL_PULL
    reason: str
    details: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"{self.kind}: {self.reason}"


def parse_csv(payload: str) -> tuple[list[str], list[list[str]]]:
    rows = list(csv.reader(io.StringIO(payload)))
    rows = [r for r in rows if r]  # ignore blank lines
    if not rows:
        return [], []
    return [h.strip() for h in rows[0]], rows[1:]


def validate(*, dataset: str, payload: str, columns: dict[str, str], row_hint: int | None,
             history_counts: list[int] | None = None) -> list[dict[str, Any]]:
    """Return canonical, contract-valid records or raise ValidationFailure."""
    header, rows = parse_csv(payload)

    # 1. transfer integrity ----------------------------------------------------
    if not header:
        raise ValidationFailure("PARTIAL_PULL", "empty file")
    malformed = [i for i, r in enumerate(rows) if len(r) != len(header)]
    if malformed:
        tail = malformed == [len(rows) - 1] and not payload.endswith("\n")
        raise ValidationFailure(
            "PARTIAL_PULL",
            "truncated file (last row cut mid-line)" if tail else f"{len(malformed)} malformed rows",
            {"malformed_rows": malformed[:10], "rows_received": len(rows), "row_hint": row_hint},
        )
    if row_hint is not None and len(rows) != row_hint:
        raise ValidationFailure(
            "PARTIAL_PULL", f"received {len(rows)} rows, source reported {row_hint}",
            {"rows_received": len(rows), "row_hint": row_hint},
        )

    # 2. schema drift (set comparison — column reordering is NOT drift) --------
    expected = set(columns.values())
    got = set(header)
    if got != expected:
        missing, unexpected = sorted(expected - got), sorted(got - expected)
        raise ValidationFailure(
            "SCHEMA_DRIFT",
            f"columns changed: missing {missing}, unexpected {unexpected}",
            {"missing": missing, "unexpected": unexpected, "expected": sorted(expected)},
        )

    # 3. row contract -----------------------------------------------------------
    contract = CONTRACTS[dataset]
    idx = {canon: header.index(col) for canon, col in columns.items()}
    records: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for n, r in enumerate(rows, start=2):
        raw = {canon: (r[i].strip() or None) for canon, i in idx.items()}
        try:
            records.append(contract.model_validate(raw).model_dump())
        except ValidationError as e:
            errors.append({"line": n, "errors": [
                {"field": ".".join(map(str, x["loc"])), "msg": x["msg"]} for x in e.errors()[:3]]})
    if errors:
        # which fields are *entirely* null -> strongest drift signal
        all_null = [c for c, i in idx.items() if rows and all(not r[i].strip() for r in rows)]
        raise ValidationFailure(
            "SCHEMA_DRIFT",
            f"{len(errors)} rows violate the {dataset} contract"
            + (f"; all-null required columns {all_null}" if all_null else ""),
            {"row_errors": errors[:5], "error_count": len(errors), "all_null_columns": all_null},
        )

    # 4. expectations -----------------------------------------------------------
    ts_field = TIMESTAMP_FIELDS[dataset]
    now = datetime.now(UTC)
    future = []
    for rec in records:
        v = rec[ts_field]
        limit = now + CLOCK_SKEW if isinstance(v, datetime) else (now + CLOCK_SKEW).date()
        if v > limit:
            future.append(str(v))
    if future:
        raise ValidationFailure("SCHEMA_DRIFT", f"{len(future)} rows have future {ts_field}",
                                {"examples": future[:5]})

    if dataset in SNAPSHOT_DATASETS:
        if not records:
            raise ValidationFailure("PARTIAL_PULL", "snapshot dataset returned 0 rows")
        hist = [c for c in (history_counts or []) if c]
        if len(hist) >= BAND_MIN_HISTORY:
            med = statistics.median(hist)
            if len(records) < BAND_LOW_RATIO * med:
                raise ValidationFailure(
                    "PARTIAL_PULL",
                    f"row count {len(records)} below band (median {med:.0f} over last {len(hist)} runs)",
                    {"rows": len(records), "median": med},
                )
    return records
