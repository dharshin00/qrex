"""Read models for the dashboard: overview, unified SKU view, warehouses."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    CLEAN_MODELS, Alert, Connector, Intervention, Inventory, Order, Sale, SkuMap, SyncRun,
    WarehouseStock,
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


@router.get("/metrics/orders_hourly")
def orders_hourly(hours: int = Query(24, ge=1, le=192), db: Session = Depends(get_db)) -> dict:
    """Distinct orders + revenue per platform per hour (oldest first), zero-filled."""
    now = datetime.now(UTC)
    start = (now - timedelta(hours=hours - 1)).replace(minute=0, second=0, microsecond=0)
    hr = func.date_trunc("hour", func.timezone("UTC", Order.ordered_at))
    rows = db.execute(select(Order.platform, hr, func.count(func.distinct(Order.external_id)),
                             func.coalesce(func.sum(Order.amount), 0))
                      .where(Order.ordered_at >= start).group_by(Order.platform, hr)).all()
    got = {(p, h.replace(tzinfo=UTC)): (n, float(r)) for p, h, n, r in rows}
    slots = [start + timedelta(hours=i) for i in range(hours)]
    platforms = sorted({p for p, *_ in rows}) or ["blinkit", "instamart"]
    return {
        "hours": [h.isoformat() for h in slots],
        "series": {p: [{"orders": got.get((p, h), (0, 0.0))[0], "revenue": got.get((p, h), (0, 0.0))[1]}
                       for h in slots] for p in platforms},
    }


@router.get("/activity")
def activity(limit: int = Query(40, le=200), db: Session = Depends(get_db)) -> list[dict]:
    """One timeline of what the system did: alerts, interventions and every
    non-routine sync run (routine scheduled successes are summarised away)."""
    plat = dict(db.execute(select(Connector.id, Connector.platform)).all())
    ev: list[dict] = []
    for a in db.scalars(select(Alert).order_by(Alert.created_at.desc()).limit(limit)):
        ev.append({"at": a.created_at, "type": "alert", "kind": a.kind, "tone": a.severity,
                   "platform": plat.get(a.connector_id), "dataset": a.dataset,
                   "title": a.kind.replace("_", " ").title(), "detail": a.message})
        if a.resolved_at:
            ev.append({"at": a.resolved_at, "type": "resolved", "kind": a.kind, "tone": "good",
                       "platform": plat.get(a.connector_id), "dataset": a.dataset,
                       "title": f"{a.kind.replace('_', ' ').title()} resolved", "detail": None})
    for i in db.scalars(select(Intervention).where(or_(Intervention.note.is_(None),
                                                       ~Intervention.note.like("seed:%")))
                        .order_by(Intervention.requested_at.desc()).limit(limit)):
        ev.append({"at": i.requested_at, "type": "intervention", "kind": i.kind, "tone": "warn",
                   "platform": plat.get(i.connector_id), "dataset": None,
                   "title": "Seller re-auth requested", "detail": i.note})
        if i.resolved_at:
            gap = f" · {i.gap_minutes_recovered} min backfilled" if i.gap_minutes_recovered else ""
            ev.append({"at": i.resolved_at, "type": "intervention", "kind": i.kind, "tone": "good",
                       "platform": plat.get(i.connector_id), "dataset": None,
                       "title": "Re-auth complete" + gap, "detail": None})
    runs = db.scalars(select(SyncRun).where(or_(SyncRun.status != "success", SyncRun.mode != "scheduled"))
                      .order_by(SyncRun.id.desc()).limit(limit))
    for r in runs:
        tone = {"success": "good", "failed": "critical", "quarantined": "critical",
                "retrying": "warn", "paused": "warn"}.get(r.status, "info")
        rows = f" · {r.rows_upserted} rows changed" if r.rows_upserted is not None else ""
        ev.append({"at": r.finished_at or r.started_at, "type": "run", "kind": r.status, "tone": tone,
                   "platform": plat.get(r.connector_id), "dataset": r.dataset,
                   "title": f"{r.mode.title()} {r.dataset} sync {r.status}"
                            + (f" (attempt {r.attempt})" if r.attempt > 1 else "") + rows,
                   "detail": r.error})
    ev.sort(key=lambda e: e["at"], reverse=True)
    return ev[:limit]


def _store_cities(db: Session) -> dict[tuple[str, str], str]:
    return {(p, s): c for p, s, c in db.execute(
        select(WarehouseStock.platform, WarehouseStock.store_id, WarehouseStock.city).distinct())}


@router.get("/metrics/summary")
def summary(platform: str | None = None, db: Session = Depends(get_db)) -> dict:
    """Commerce summary for the Summary page. Days are UTC calendar days; the
    day-over-day change compares the last two *complete* days."""
    today = datetime.now(UTC).date()
    days = [today - timedelta(days=i) for i in range(6, -1, -1)]
    pf = [Sale.platform == platform] if platform else []
    of = [Order.platform == platform] if platform else []

    sales_day = {d: (int(u or 0), float(r or 0)) for d, u, r in db.execute(
        select(Sale.sale_date, func.sum(Sale.units_sold), func.sum(Sale.revenue))
        .where(Sale.sale_date >= days[0], *pf).group_by(Sale.sale_date)).all()}
    day = func.date(func.timezone("UTC", Order.ordered_at))
    orders_day = {d: (int(n), float(r or 0)) for d, n, r in db.execute(
        select(day, func.count(func.distinct(func.concat(Order.platform, Order.external_id))),
               func.coalesce(func.sum(Order.amount), 0))
        .where(Order.ordered_at >= datetime.combine(days[0], datetime.min.time(), UTC), *of)
        .group_by(day)).all()}

    def series(fn):
        return [round(fn(d), 2) for d in days]

    rev = series(lambda d: sales_day.get(d, (0, 0.0))[1])
    units = series(lambda d: sales_day.get(d, (0, 0.0))[0])
    orders = series(lambda d: orders_day.get(d, (0, 0.0))[0])
    aov = [round(orders_day[d][1] / orders_day[d][0], 2) if orders_day.get(d, (0,))[0] else 0 for d in days]

    def kpi(key, label, values, total):
        prev, last = values[-3], values[-2]  # last two complete days
        return {"key": key, "label": label, "value": total, "series": values,
                "change_pct": round((last - prev) / prev * 100, 1) if prev else None}

    tot_orders = sum(orders)
    kpis = [
        kpi("revenue", "Revenue", rev, round(sum(rev), 2)),
        kpi("orders", "Orders", orders, tot_orders),
        kpi("units", "Units sold", units, sum(units)),
        kpi("aov", "Avg basket", aov, round(sum(orders_day.get(d, (0, 0.0))[1] for d in days) / tot_orders, 2) if tot_orders else 0),
    ]

    cities = _store_cities(db)
    heat = db.execute(select(Sale.platform, Sale.store_id, Sale.sale_date, func.sum(Sale.revenue))
                      .where(Sale.sale_date >= days[0], *pf)
                      .group_by(Sale.platform, Sale.store_id, Sale.sale_date)).all()
    stores: dict = {}
    for p, sid, d, r in heat:
        row = stores.setdefault((p, sid), {"platform": p, "store_id": sid, "city": cities.get((p, sid), ""),
                                           "values": [0.0] * 7})
        row["values"][days.index(d)] = round(float(r or 0), 2)
    by_city: dict[str, float] = defaultdict(float)
    for s in stores.values():
        by_city[s["city"]] += sum(s["values"])
    by_platform = dict(db.execute(select(Sale.platform, func.sum(Sale.revenue))
                                  .where(Sale.sale_date >= days[0], *pf).group_by(Sale.platform)).all())
    names = dict(db.execute(select(SkuMap.canonical_sku, SkuMap.product_name)).all())
    top = db.execute(select(Sale.canonical_sku, func.sum(Sale.revenue), func.sum(Sale.units_sold))
                     .where(Sale.sale_date >= days[0], *pf).group_by(Sale.canonical_sku)
                     .order_by(func.sum(Sale.revenue).desc()).limit(5)).all()
    total_rev = sum(rev) or 1
    return {
        "days": [d.isoformat() for d in days],
        "kpis": kpis,
        "heatmap": sorted(stores.values(), key=lambda s: (s["platform"], s["city"])),
        "by_platform": [{"platform": p, "revenue": round(float(r), 2), "share": round(float(r) / total_rev * 100, 1)}
                        for p, r in sorted(by_platform.items(), key=lambda x: -x[1])],
        "by_city": [{"city": c, "revenue": round(r, 2), "share": round(r / total_rev * 100, 1)}
                    for c, r in sorted(by_city.items(), key=lambda x: -x[1])],
        "top_skus": [{"canonical_sku": c, "product_name": names.get(c, c), "revenue": round(float(r), 2),
                      "units": int(u), "share": round(float(r) / total_rev * 100, 1)} for c, r, u in top],
    }


@router.get("/orders")
def list_orders(platform: str | None = None, status: str | None = None, q: str | None = None,
                limit: int = Query(50, le=200), offset: int = 0, db: Session = Depends(get_db)) -> dict:
    """Order-level view (clean layer is one row per order line)."""
    conds = []
    if platform:
        conds.append(Order.platform == platform)
    if status:
        conds.append(Order.status == status)
    if q:
        conds.append(or_(Order.external_id.ilike(f"%{q}%"), Order.store_id.ilike(f"%{q}%")))
    grp = (Order.platform, Order.external_id)
    base = (select(Order.platform, Order.external_id, func.min(Order.store_id), func.min(Order.ordered_at),
                   func.min(Order.status), func.count(), func.sum(Order.quantity), func.sum(Order.amount),
                   func.array_agg(Order.canonical_sku), func.min(Order.source_path))
            .where(*conds).group_by(*grp))
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    rows = db.execute(base.order_by(func.min(Order.ordered_at).desc()).limit(limit).offset(offset)).all()
    cities = _store_cities(db)
    names = dict(db.execute(select(SkuMap.canonical_sku, SkuMap.product_name)).all())
    return {"total": total, "items": [{
        "platform": p, "order_id": oid, "store_id": st, "city": cities.get((p, st), ""),
        "ordered_at": at, "status": status_, "lines": n, "units": int(u), "amount": float(a),
        "products": [names.get(c, c) for c in (skus or []) if c], "source_path": sp,
    } for p, oid, st, at, status_, n, u, a, skus, sp in rows]}
