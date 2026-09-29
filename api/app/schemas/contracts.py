"""Canonical per-dataset contracts (Pydantic v2).

Connectors map their platform's column headers onto these canonical field
names; every row must validate against the contract before it may reach
staging. See docs/ARCH.md §7.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
NonNeg = Annotated[int, Field(ge=0)]
Money = Annotated[float, Field(ge=0)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class OrderRecord(_Contract):
    order_id: NonEmpty
    sku: NonEmpty
    store_id: NonEmpty
    quantity: Annotated[int, Field(ge=1)]
    amount: Money
    status: NonEmpty
    ordered_at: AwareDatetime


class InventoryRecord(_Contract):
    sku: NonEmpty
    product_name: NonEmpty
    units: NonNeg
    as_of: AwareDatetime


class WarehouseStockRecord(_Contract):
    store_id: NonEmpty
    city: NonEmpty
    sku: NonEmpty
    units: NonNeg
    as_of: AwareDatetime


class SaleRecord(_Contract):
    sale_date: date
    store_id: NonEmpty
    sku: NonEmpty
    units_sold: NonNeg
    revenue: Money


CONTRACTS: dict[str, type[_Contract]] = {
    "orders": OrderRecord,
    "inventory": InventoryRecord,
    "warehouse_stock": WarehouseStockRecord,
    "sales": SaleRecord,
}

# Snapshot datasets return a roughly constant row count each pull, so a
# rolling row-count band is meaningful. `orders` is incremental (windowed).
SNAPSHOT_DATASETS = {"inventory", "warehouse_stock", "sales"}

# Timestamp fields that must not be in the future (clock-skew tolerance applied)
TIMESTAMP_FIELDS: dict[str, str] = {
    "orders": "ordered_at",
    "inventory": "as_of",
    "warehouse_stock": "as_of",
    "sales": "sale_date",
}


def external_id(dataset: str, rec: dict) -> str:
    if dataset == "orders":
        return rec["order_id"]
    if dataset == "inventory":
        return rec["sku"]
    if dataset == "warehouse_stock":
        return rec["store_id"]
    if dataset == "sales":
        d = rec["sale_date"]
        return f"{d.isoformat() if isinstance(d, (date, datetime)) else d}:{rec['store_id']}"
    raise KeyError(dataset)
