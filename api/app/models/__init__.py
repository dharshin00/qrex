"""SQLAlchemy models — see docs/ARCH.md §5.

Layers: raw (`raw_pulls`) -> staging (`staging_records`) -> clean
(`orders`, `inventory`, `warehouse_stock`, `sales`). Clean tables carry a
unique `(platform, external_id, sku)` constraint for idempotent upserts and a
`row_hash` so unchanged rows are not rewritten.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON, BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric,
    String, Text, UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JsonType = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    pass


def _ts(**kw: Any) -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), **kw)


# ---------------------------------------------------------------------------
# Control plane
# ---------------------------------------------------------------------------
class Connector(Base):
    __tablename__ = "connectors"
    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(32), unique=True)
    display_name: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # active | paused (paused = waiting on human re-auth)
    status: Mapped[str] = mapped_column(String(16), default="active")
    paused_at: Mapped[datetime | None] = _ts(nullable=True)
    # {"seller_id", "schedules": {dataset: seconds}, "freshness_sla": {dataset: seconds},
    #  "low_stock_threshold", "orders_lookback_minutes"}
    config_json: Mapped[dict] = mapped_column(JsonType, default=dict)


class Consent(Base):
    """Seller's logged consent for Q-REX to use a given source path."""
    __tablename__ = "consents"
    id: Mapped[int] = mapped_column(primary_key=True)
    connector_id: Mapped[int] = mapped_column(ForeignKey("connectors.id"))
    source_path: Mapped[str] = mapped_column(String(32))
    granted_by: Mapped[str] = mapped_column(String(128))
    scope: Mapped[str] = mapped_column(Text)
    granted_at: Mapped[datetime] = _ts(server_default=func.now())
    revoked_at: Mapped[datetime | None] = _ts(nullable=True)


class SessionRow(Base):
    __tablename__ = "sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    connector_id: Mapped[int] = mapped_column(ForeignKey("connectors.id"), index=True)
    encrypted_blob: Mapped[str] = mapped_column(Text)  # Fernet token; never logged
    expires_at: Mapped[datetime] = _ts()
    status: Mapped[str] = mapped_column(String(16), default="active")  # active|expired|replaced
    created_at: Mapped[datetime] = _ts(server_default=func.now())


class SyncRun(Base):
    __tablename__ = "sync_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    connector_id: Mapped[int] = mapped_column(ForeignKey("connectors.id"), index=True)
    dataset: Mapped[str] = mapped_column(String(32))
    # running | success | quarantined | retrying | failed | paused
    status: Mapped[str] = mapped_column(String(16))
    mode: Mapped[str] = mapped_column(String(16), default="scheduled")  # scheduled|manual|backfill
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_path: Mapped[str | None] = mapped_column(String(32), nullable=True)
    window_start: Mapped[datetime | None] = _ts(nullable=True)
    window_end: Mapped[datetime | None] = _ts(nullable=True)
    started_at: Mapped[datetime] = _ts(server_default=func.now())
    finished_at: Mapped[datetime | None] = _ts(nullable=True)
    rows_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rows_upserted: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (Index("ix_sync_runs_conn_ds_started", "connector_id", "dataset", "started_at"),)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    # SESSION_EXPIRED | SCHEMA_DRIFT | STALE_SOURCE | STOCK_OUT | LOW_STOCK |
    # PARTIAL_PULL | PULL_FAILED
    kind: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16))  # info | warn | critical
    connector_id: Mapped[int | None] = mapped_column(ForeignKey("connectors.id"), nullable=True)
    dataset: Mapped[str | None] = mapped_column(String(128), nullable=True)
    message: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict] = mapped_column(JsonType, default=dict)
    # de-dup key: one OPEN alert per (kind, connector, dataset)
    dedup_key: Mapped[str] = mapped_column(String(256))
    occurrences: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = _ts(server_default=func.now())
    last_seen_at: Mapped[datetime] = _ts(server_default=func.now())
    resolved_at: Mapped[datetime | None] = _ts(nullable=True)
    delivered: Mapped[dict] = mapped_column(JsonType, default=dict)  # channel -> status

    __table_args__ = (
        Index("uq_alerts_open_dedup", "dedup_key", unique=True,
              postgresql_where=text("resolved_at IS NULL")),
    )


class Intervention(Base):
    __tablename__ = "interventions"
    id: Mapped[int] = mapped_column(primary_key=True)
    connector_id: Mapped[int] = mapped_column(ForeignKey("connectors.id"))
    kind: Mapped[str] = mapped_column(String(32))  # REAUTH | MANUAL_UPLOAD | ...
    requested_at: Mapped[datetime] = _ts(server_default=func.now())
    resolved_at: Mapped[datetime | None] = _ts(nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    gap_minutes_recovered: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        Index("uq_interventions_open", "connector_id", "kind", unique=True,
              postgresql_where=text("resolved_at IS NULL")),
    )


# ---------------------------------------------------------------------------
# Raw + staging
# ---------------------------------------------------------------------------
class RawPullRow(Base):
    __tablename__ = "raw_pulls"
    id: Mapped[int] = mapped_column(primary_key=True)
    connector_id: Mapped[int] = mapped_column(ForeignKey("connectors.id"))
    dataset: Mapped[str] = mapped_column(String(32))
    source_path: Mapped[str] = mapped_column(String(32))
    payload: Mapped[str] = mapped_column(Text)  # untouched source bytes (CSV)
    row_count: Mapped[int] = mapped_column(Integer)
    row_hint: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fetched_at: Mapped[datetime] = _ts()
    run_id: Mapped[int] = mapped_column(ForeignKey("sync_runs.id"), index=True)
    quarantined: Mapped[bool] = mapped_column(Boolean, default=False)
    quarantine_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class StagingRecord(Base):
    __tablename__ = "staging_records"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("sync_runs.id"), index=True)
    dataset: Mapped[str] = mapped_column(String(32))
    normalized_json: Mapped[dict] = mapped_column(JsonType)
    sku_raw: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = _ts(server_default=func.now())


class SkuMap(Base):
    __tablename__ = "sku_map"
    id: Mapped[int] = mapped_column(primary_key=True)
    canonical_sku: Mapped[str] = mapped_column(String(64), index=True)
    platform: Mapped[str] = mapped_column(String(32))
    platform_sku: Mapped[str] = mapped_column(String(64))
    product_name: Mapped[str] = mapped_column(String(256))
    __table_args__ = (UniqueConstraint("platform", "platform_sku"),)


# ---------------------------------------------------------------------------
# Clean layer
# ---------------------------------------------------------------------------
class _CleanMixin:
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    platform: Mapped[str] = mapped_column(String(32))
    external_id: Mapped[str] = mapped_column(String(128))
    sku: Mapped[str] = mapped_column(String(64))
    canonical_sku: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    row_hash: Mapped[str] = mapped_column(String(64))
    source_path: Mapped[str] = mapped_column(String(32))
    run_id: Mapped[int] = mapped_column(Integer)
    loaded_at: Mapped[datetime] = _ts(server_default=func.now())
    updated_at: Mapped[datetime] = _ts(server_default=func.now())


class Order(_CleanMixin, Base):
    __tablename__ = "orders"
    store_id: Mapped[str] = mapped_column(String(64))
    quantity: Mapped[int] = mapped_column(Integer)
    amount: Mapped[float] = mapped_column(Numeric(12, 2))
    status: Mapped[str] = mapped_column(String(32))
    ordered_at: Mapped[datetime] = _ts(index=True)
    __table_args__ = (UniqueConstraint("platform", "external_id", "sku", name="uq_orders_key"),)


class Inventory(_CleanMixin, Base):
    __tablename__ = "inventory"
    product_name: Mapped[str] = mapped_column(String(256))
    units: Mapped[int] = mapped_column(Integer)
    as_of: Mapped[datetime] = _ts()
    __table_args__ = (UniqueConstraint("platform", "external_id", "sku", name="uq_inventory_key"),)


class WarehouseStock(_CleanMixin, Base):
    __tablename__ = "warehouse_stock"
    store_id: Mapped[str] = mapped_column(String(64))
    city: Mapped[str] = mapped_column(String(64))
    units: Mapped[int] = mapped_column(Integer)
    as_of: Mapped[datetime] = _ts()
    __table_args__ = (UniqueConstraint("platform", "external_id", "sku", name="uq_warehouse_stock_key"),)


class Sale(_CleanMixin, Base):
    __tablename__ = "sales"
    sale_date: Mapped[date] = mapped_column(Date, index=True)
    store_id: Mapped[str] = mapped_column(String(64))
    units_sold: Mapped[int] = mapped_column(Integer)
    revenue: Mapped[float] = mapped_column(Numeric(14, 2))
    __table_args__ = (UniqueConstraint("platform", "external_id", "sku", name="uq_sales_key"),)


CLEAN_MODELS: dict[str, type[_CleanMixin]] = {
    "orders": Order,
    "inventory": Inventory,
    "warehouse_stock": WarehouseStock,
    "sales": Sale,
}
