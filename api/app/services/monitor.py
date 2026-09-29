"""Freshness SLA + per-warehouse stock evaluation (docs/ARCH.md §9)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Connector, SyncRun, WarehouseStock
from app.services.alerts import raise_alert, resolve_alerts

DATASETS = ("orders", "inventory", "warehouse_stock", "sales")
DEFAULT_SCHEDULES = {"orders": 60, "inventory": 120, "warehouse_stock": 60, "sales": 300}
DEFAULT_LOW_STOCK = 15


def schedule_seconds(conn: Connector, dataset: str) -> int:
    sch = (conn.config_json or {}).get("schedules", {})
    return int(sch.get(dataset) or DEFAULT_SCHEDULES.get(dataset) or get_settings().sync_default_interval)


def sla_seconds(conn: Connector, dataset: str) -> int:
    sla = (conn.config_json or {}).get("freshness_sla", {})
    return int(sla.get(dataset) or max(3 * schedule_seconds(conn, dataset), 180))


def low_stock_threshold(conn: Connector) -> int:
    return int((conn.config_json or {}).get("low_stock_threshold", DEFAULT_LOW_STOCK))


def freshness(db: Session, conn: Connector) -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    last_ok = dict(db.execute(
        select(SyncRun.dataset, func.max(SyncRun.finished_at))
        .where(SyncRun.connector_id == conn.id, SyncRun.status == "success")
        .group_by(SyncRun.dataset)).all())
    last_any = {r.dataset: r for r in db.scalars(
        select(SyncRun).distinct(SyncRun.dataset)
        .where(SyncRun.connector_id == conn.id)
        .order_by(SyncRun.dataset, SyncRun.started_at.desc()))}
    out = []
    for ds in DATASETS:
        ok = last_ok.get(ds)
        age = (now - ok).total_seconds() if ok else None
        sla = sla_seconds(conn, ds)
        breached = age is None or age > sla
        last = last_any.get(ds)
        if conn.status == "paused":
            state = "stale"
        elif breached:
            state = "stale"
        elif last and last.status in ("failed", "quarantined", "retrying"):
            state = "degraded"
        else:
            state = "fresh"
        out.append({
            "dataset": ds, "state": state, "last_success_at": ok, "age_seconds": age,
            "sla_seconds": sla, "sla_breached": breached,
            "interval_seconds": schedule_seconds(conn, ds),
            "last_status": last.status if last else None,
            "last_source_path": last.source_path if last else None,
            "last_error": last.error if last else None,
        })
    return out


def evaluate_freshness(db: Session, conn: Connector) -> None:
    for f in freshness(db, conn):
        if f["sla_breached"]:
            age = "never" if f["age_seconds"] is None else f"{int(f['age_seconds'] // 60)}m ago"
            raise_alert(db, "STALE_SOURCE", connector_id=conn.id, dataset=f["dataset"],
                        message=f"{conn.display_name} {f['dataset']} is stale: last good sync {age} "
                                f"(SLA {f['sla_seconds'] // 60}m). Last-good data is still served, marked stale.",
                        payload={k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in f.items()})
        else:
            resolve_alerts(db, ["STALE_SOURCE"], connector_id=conn.id, dataset=f["dataset"])


def evaluate_stock(db: Session, conn: Connector) -> dict[str, int]:
    th = low_stock_threshold(conn)
    rows = db.execute(select(WarehouseStock.store_id, WarehouseStock.city, WarehouseStock.sku,
                             WarehouseStock.canonical_sku, WarehouseStock.units)
                      .where(WarehouseStock.platform == conn.platform, WarehouseStock.units < th)).all()
    out_keys, low_keys = set(), set()
    for store, city, sku, canon, units in rows:
        key = f"{store}/{sku}"
        kind = "STOCK_OUT" if units == 0 else "LOW_STOCK"
        (out_keys if kind == "STOCK_OUT" else low_keys).add(key)
        raise_alert(db, kind, connector_id=conn.id, dataset=key,
                    message=f"{canon or sku} at {store} ({city}) on {conn.display_name}: "
                            + ("OUT OF STOCK" if units == 0 else f"{units} units left (threshold {th})"),
                    payload={"store_id": store, "city": city, "sku": sku, "canonical_sku": canon,
                             "units": units, "threshold": th})
    resolve_alerts(db, ["STOCK_OUT"], connector_id=conn.id, keep=out_keys)
    resolve_alerts(db, ["LOW_STOCK"], connector_id=conn.id, keep=low_keys)
    return {"stock_out": len(out_keys), "low_stock": len(low_keys)}
