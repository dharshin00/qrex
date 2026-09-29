"""Canonical records -> clean-layer rows; resolve platform SKUs via sku_map."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SkuMap
from app.schemas.contracts import external_id


def sku_lookup(db: Session, platform: str) -> dict[str, str]:
    return dict(db.execute(select(SkuMap.platform_sku, SkuMap.canonical_sku)
                           .where(SkuMap.platform == platform)).all())


def to_clean(dataset: str, platform: str, records: list[dict[str, Any]],
             skus: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    for r in records:
        row = dict(r)
        row["platform"] = platform
        row["external_id"] = external_id(dataset, r)
        row["canonical_sku"] = skus.get(r["sku"])  # None = unmapped; still loaded
        row.pop("order_id", None)
        out.append(row)
    return out
