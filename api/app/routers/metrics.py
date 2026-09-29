"""Read models for the dashboard: overview, unified SKU view, warehouses."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    CLEAN_MODELS, Alert, Connector, Intervention, Inventory, Order, Sale, SkuMap, WarehouseStock,
)
from app.services import monitor as mon

router = APIRouter(tags=["metrics"])


@router.get("/metrics/overview")
def overview(db: Session = Depends(get_db)) -> dict:
    now = datetime.now(UTC)
    conns = list(db.scalars(select(Connector).order_by(Connector.id)))

    open_alerts = db.execute(select(Alert.severity, func.count()).where(Alert.resolved_at.is_(None))
                             .group_by(Alert.severity)).all()
    open_by_kind = db.execute(select(Alert.kind, func.count()).where(Alert.resolved_at.is_(None))
                              .group_by(Alert.kind)).all()

    # interventions per ISO week, last 8 weeks (oldest first)
    week0 = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    weeks = [week0 - timedelta(weeks=i) for i in range(7, -1, -1)]
    wk = func.date_trunc("week", func.timezone("UTC", Intervention.requested_at))
    iv_rows = db.execute(select(wk, func.count(),
                                func.coalesce(func.sum(Intervention.gap_minutes_recovered), 0))
                         .where(Intervention.requested_at >= weeks[0])
                         .group_by(wk)).all()
    by_week = {w.date(): (n, g) for w, n, g in iv_rows}
    interventions = [{"week": w.date(), "count": by_week.get(w.date(), (0, 0))[0],
                      "gap_minutes_recovered": int(by_week.get(w.date(), (0, 0))[1])} for w in weeks]

    # duplicates in clean layer (proof of idempotency; should always be 0)
    dupes = 0
    counts = {}
    for name, model in CLEAN_MODELS.items():
        total, distinct = db.execute(select(
            func.count(), func.count(func.distinct(func.concat_ws("|", model.platform,
                                                                  model.external_id, model.sku))))
        ).one()
        counts[name] = total
        dupes += total - distinct

    since24 = now - timedelta(hours=24)
    o24 = db.execute(select(Order.platform, func.count(func.distinct(Order.external_id)),
                            func.coalesce(func.sum(Order.amount), 0))
                     .where(Order.ordered_at >= since24).group_by(Order.platform)).all()

    sales_days = db.execute(select(Sale.sale_date, Sale.platform, func.sum(Sale.units_sold),
                                   func.sum(Sale.revenue))
                            .group_by(Sale.sale_date, Sale.platform)
                            .order_by(Sale.sale_date)).all()
    trend: dict = defaultdict(dict)
    for d, p, u, r in sales_days:
        trend[d.isoformat()][p] = {"units": int(u or 0), "revenue": float(r or 0)}

    return {
        "generated_at": now,
        "connectors": [{"platform": c.platform, "display_name": c.display_name, "status": c.status,
                        "enabled": c.enabled, "freshness": mon.freshness(db, c)} for c in conns],
        "open_alerts": {s: n for s, n in open_alerts},
        "open_alerts_by_kind": {k: n for k, n in open_by_kind},
        "interventions_per_week": interventions,
        "gap_minutes_recovered_total": int(db.scalar(
            select(func.coalesce(func.sum(Intervention.gap_minutes_recovered), 0))) or 0),
        "clean_row_counts": counts,
        "duplicate_clean_rows": dupes,
        "orders_24h": {p: {"orders": n, "revenue": float(r)} for p, n, r in o24},
        "sales_trend": [{"date": d, **v} for d, v in sorted(trend.items())],
    }


@router.get("/skus")
def unified_skus(db: Session = Depends(get_db)) -> list[dict]:
    """One row per physical product across platforms (via sku_map)."""
    since = (datetime.now(UTC) - timedelta(days=6)).date()
    thresholds = {c.platform: mon.low_stock_threshold(c) for c in db.scalars(select(Connector))}
    names = {}
    by: dict[str, dict] = defaultdict(lambda: {"platforms": {}})
    for m in db.scalars(select(SkuMap)):
        names[m.canonical_sku] = m.product_name
        by[m.canonical_sku]["platforms"].setdefault(m.platform, {"sku": m.platform_sku})

    for inv in db.scalars(select(Inventory)):
        key = inv.canonical_sku or f"UNMAPPED:{inv.platform}:{inv.sku}"
        names.setdefault(key, inv.product_name)
        by[key]["platforms"].setdefault(inv.platform, {"sku": inv.sku}).update(
            units=inv.units, as_of=inv.as_of, source_path=inv.source_path)

    for canon, platform, sku, u, r in db.execute(
            select(Sale.canonical_sku, Sale.platform, Sale.sku, func.sum(Sale.units_sold),
                   func.sum(Sale.revenue)).where(Sale.sale_date >= since)
            .group_by(Sale.canonical_sku, Sale.platform, Sale.sku)).all():
        key = canon or f"UNMAPPED:{platform}:{sku}"
        by[key]["platforms"].setdefault(platform, {"sku": sku}).update(
            units_sold_7d=int(u or 0), revenue_7d=float(r or 0))

    low = defaultdict(list)
    for ws in db.scalars(select(WarehouseStock)):
        if ws.units < thresholds.get(ws.platform, mon.DEFAULT_LOW_STOCK):
            low[ws.canonical_sku or f"UNMAPPED:{ws.platform}:{ws.sku}"].append(
                {"platform": ws.platform, "store_id": ws.store_id, "city": ws.city, "units": ws.units})

    out = []
    for key, v in by.items():
        ps = v["platforms"]
        units = sum(p.get("units", 0) for p in ps.values())
        sold = sum(p.get("units_sold_7d", 0) for p in ps.values())
        out.append({
            "canonical_sku": None if key.startswith("UNMAPPED:") else key,
            "key": key, "product_name": names.get(key, key), "platforms": ps,
            "total_units": units, "units_sold_7d": sold,
            "revenue_7d": round(sum(p.get("revenue_7d", 0) for p in ps.values()), 2),
            "days_of_cover": round(units / (sold / 7), 1) if sold else None,
            "low_stock_locations": low.get(key, []),
        })
    return sorted(out, key=lambda x: (x["canonical_sku"] is None, x["key"]))


@router.get("/warehouses")
def warehouses(db: Session = Depends(get_db)) -> list[dict]:
    thresholds = {c.platform: mon.low_stock_threshold(c) for c in db.scalars(select(Connector))}
    names = dict(db.execute(select(SkuMap.canonical_sku, SkuMap.product_name)).all())
    stores: dict[tuple[str, str], dict] = {}
    for ws in db.scalars(select(WarehouseStock).order_by(WarehouseStock.platform,
                                                         WarehouseStock.store_id)):
        th = thresholds.get(ws.platform, mon.DEFAULT_LOW_STOCK)
        s = stores.setdefault((ws.platform, ws.store_id), {
            "platform": ws.platform, "store_id": ws.store_id, "city": ws.city, "threshold": th,
            "sku_count": 0, "total_units": 0, "low_stock": [], "stock_out": [], "as_of": ws.as_of,
            "items": []})
        s["sku_count"] += 1
        s["total_units"] += ws.units
        item = {"sku": ws.sku, "canonical_sku": ws.canonical_sku,
                "product_name": names.get(ws.canonical_sku, ws.sku), "units": ws.units}
        s["items"].append(item)
        if ws.units == 0:
            s["stock_out"].append(item)
        elif ws.units < th:
            s["low_stock"].append(item)
    return list(stores.values())



@router.get("/metrics/orders_count")
def orders_count(platform: str, since: datetime, until: datetime, db: Session = Depends(get_db)) -> dict:
    """Clean-layer order lines/orders in a window (demo: compare with source ground truth)."""
    lines, orders = db.execute(select(func.count(), func.count(func.distinct(Order.external_id)))
                               .where(Order.platform == platform, Order.ordered_at >= since,
                                      Order.ordered_at < until)).one()
    return {"lines": lines, "orders": orders}


@router.get("/metrics/clean_counts")
def clean_counts(db: Session = Depends(get_db)) -> dict:
    out: dict = {}
    for name, model in CLEAN_MODELS.items():
        out[name] = dict(db.execute(select(model.platform, func.count()).group_by(model.platform)).all())
    return out
