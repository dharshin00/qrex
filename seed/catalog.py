"""Deterministic demo catalog + data generator.

Everything here is invented for the demo. The per-platform column names below
are the *mock-platform's* export formats — they are NOT the real Blinkit or
Swiggy Instamart report formats (which we do not know and do not guess).

The generator is a pure function of (platform, wall-clock minute), so the mock
platform can "produce" orders continuously and any re-pull of the same window
returns byte-identical rows. That is what lets the demo prove idempotency and
gap backfill against ground truth.
"""

from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache

PLATFORMS = ("blinkit", "instamart")
DATASETS = ("orders", "inventory", "warehouse_stock", "sales")

HISTORY_DAYS = 3          # how far back the mock can export orders
SALES_DAYS = 7            # daily sales rows exported
LOW_STOCK_THRESHOLD = 15  # default per-warehouse threshold


@dataclass(frozen=True)
class Product:
    canonical_sku: str
    name: str
    price: float


PRODUCTS: tuple[Product, ...] = tuple(
    Product(f"VF-{i + 1:03d}", name, price)
    for i, (name, price) in enumerate(
        [
            ("Cold-Pressed Groundnut Oil 1L", 289.0),
            ("Stone-Ground Atta 5kg", 315.0),
            ("Millet Muesli 500g", 245.0),
            ("Ragi Cookies 200g", 85.0),
            ("Jaggery Powder 500g", 120.0),
            ("A2 Ghee 500ml", 690.0),
            ("Masala Peanut Butter 350g", 199.0),
            ("Himalayan Pink Salt 1kg", 99.0),
            ("Turmeric Latte Mix 200g", 260.0),
            ("Moringa Powder 100g", 175.0),
            ("Multigrain Dosa Mix 500g", 140.0),
            ("Foxtail Millet 1kg", 155.0),
            ("Kokum Sherbet 750ml", 180.0),
            ("Honey Raw Forest 500g", 399.0),
            ("Chia Seeds 250g", 210.0),
            ("Amla Candy 200g", 95.0),
            ("Filter Coffee Powder 500g", 330.0),
            ("Tulsi Green Tea 25 bags", 165.0),
            ("Sprouted Moong 500g", 135.0),
            ("Coconut Chips 100g", 110.0),
            ("Kodo Millet Poha 500g", 125.0),
            ("Mango Pickle 400g", 175.0),
            ("Sesame Chikki 200g", 90.0),
            ("Rose Gulkand 300g", 195.0),
        ]
    )
)

CITIES = ("Bengaluru", "Mumbai", "Delhi", "Hyderabad", "Pune", "Chennai")


def platform_sku(platform: str, canonical_sku: str) -> str:
    n = int(canonical_sku.split("-")[1])
    if platform == "blinkit":
        return f"BLK-{700100 + n * 7}"
    return f"IM{55000 + n * 13:06d}"


def stores(platform: str) -> list[tuple[str, str]]:
    """[(store_id, city)] — dark stores / warehouses for a platform."""
    if platform == "blinkit":
        return [(f"BLK-DS-{c[:3].upper()}-{i + 1:02d}", c) for i, c in enumerate(CITIES)]
    return [(f"IMWH{i + 1:03d}", c) for i, c in enumerate(CITIES)]


# ---------------------------------------------------------------------------
# Mock export formats (invented; see module docstring)
# canonical field -> mock column name
# ---------------------------------------------------------------------------
COLUMN_MAPS: dict[str, dict[str, dict[str, str]]] = {
    "blinkit": {
        "orders": {
            "order_id": "order_id", "sku": "item_id", "store_id": "dark_store_id",
            "quantity": "qty", "amount": "order_value", "status": "order_status",
            "ordered_at": "created_at",
        },
        "inventory": {
            "sku": "item_id", "product_name": "item_name", "units": "total_qty",
            "as_of": "last_updated",
        },
        "warehouse_stock": {
            "store_id": "dark_store_id", "city": "dark_store_city", "sku": "item_id",
            "units": "available_qty", "as_of": "last_updated",
        },
        "sales": {
            "sale_date": "sale_date", "store_id": "dark_store_id", "sku": "item_id",
            "units_sold": "units_sold", "revenue": "gmv",
        },
    },
    "instamart": {
        "orders": {
            "order_id": "OrderID", "sku": "SKUCode", "store_id": "WarehouseCode",
            "quantity": "Quantity", "amount": "TotalAmount", "status": "Status",
            "ordered_at": "OrderTime",
        },
        "inventory": {
            "sku": "SKUCode", "product_name": "ProductName", "units": "OnHand",
            "as_of": "AsOf",
        },
        "warehouse_stock": {
            "store_id": "WarehouseCode", "city": "City", "sku": "SKUCode",
            "units": "OnHand", "as_of": "AsOf",
        },
        "sales": {
            "sale_date": "Date", "store_id": "WarehouseCode", "sku": "SKUCode",
            "units_sold": "UnitsSold", "revenue": "Revenue",
        },
    },
}


def _rng(*parts: object) -> random.Random:
    h = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


def _minute(ts: datetime) -> int:
    return int(ts.timestamp() // 60)


@lru_cache(maxsize=50_000)
def _orders_in_minute(platform: str, minute: int) -> tuple[tuple, ...]:
    """Canonical order lines placed during one wall-clock minute (status-less)."""
    rng = _rng("orders", platform, minute)
    hour = (minute // 60 + 5) % 24  # rough IST hour-of-day for demand shape
    demand = 0.4 if hour < 7 else (1.8 if 18 <= hour <= 22 else 1.1)
    n_orders = sum(rng.random() < demand / 2 for _ in range(3))
    st = stores(platform)
    out = []
    for i in range(n_orders):
        order_id = f"{'B' if platform == 'blinkit' else 'S'}{minute:09d}{i:02d}"
        store_id, _ = st[rng.randrange(len(st))]
        ts = datetime.fromtimestamp(minute * 60 + rng.randrange(60), UTC)
        for p in rng.sample(PRODUCTS, rng.randint(1, 3)):
            qty = rng.randint(1, 4)
            out.append((order_id, platform_sku(platform, p.canonical_sku), store_id,
                        qty, round(qty * p.price, 2), ts))
    return tuple(out)


def orders(platform: str, since: datetime, until: datetime, now: datetime) -> list[dict]:
    """Canonical order lines with since <= ordered_at < until."""
    rows = []
    for m in range(_minute(since), _minute(until) + 1):
        for oid, sku, store, qty, amt, ts in _orders_in_minute(platform, m):
            if since <= ts < until:
                age = (now - ts).total_seconds()
                status = "delivered" if age > 20 * 60 else ("in_transit" if age > 3 * 60 else "placed")
                rows.append(dict(order_id=oid, sku=sku, store_id=store, quantity=qty,
                                 amount=amt, status=status, ordered_at=ts))
    return rows


def warehouse_stock(platform: str, now: datetime) -> list[dict]:
    hour = _minute(now) // 60
    rows = []
    for store_id, city in stores(platform):
        for p in PRODUCTS:
            base = _rng("stock", platform, store_id, p.canonical_sku).randint(35, 220)
            drift = _rng("stockdrift", platform, store_id, p.canonical_sku, hour).randint(-20, 20)
            rows.append(dict(store_id=store_id, city=city,
                             sku=platform_sku(platform, p.canonical_sku),
                             units=max(base + drift, 20), as_of=now.replace(microsecond=0)))
    return rows


def inventory(platform: str, now: datetime, stock_rows: list[dict] | None = None) -> list[dict]:
    stock_rows = stock_rows if stock_rows is not None else warehouse_stock(platform, now)
    totals: dict[str, int] = {}
    for r in stock_rows:
        totals[r["sku"]] = totals.get(r["sku"], 0) + r["units"]
    return [
        dict(sku=platform_sku(platform, p.canonical_sku), product_name=p.name,
             units=totals[platform_sku(platform, p.canonical_sku)],
             as_of=now.replace(microsecond=0))
        for p in PRODUCTS
    ]


def sales(platform: str, now: datetime) -> list[dict]:
    """Daily sales per (date, store, sku) for the last SALES_DAYS days (UTC dates)."""
    today = now.date()
    start = datetime.combine(today - timedelta(days=SALES_DAYS - 1), datetime.min.time(), UTC)
    agg: dict[tuple[date, str, str], list] = {}
    for m in range(_minute(start), _minute(now) + 1):
        for _, sku, store, qty, amt, ts in _orders_in_minute(platform, m):
            if ts >= now:
                continue
            k = (ts.date(), store, sku)
            a = agg.setdefault(k, [0, 0.0])
            a[0] += qty
            a[1] += amt
    rows = []
    for d in range(SALES_DAYS):
        day = today - timedelta(days=SALES_DAYS - 1 - d)
        for store_id, _ in stores(platform):
            for p in PRODUCTS:
                sku = platform_sku(platform, p.canonical_sku)
                u, r = agg.get((day, store_id, sku), [0, 0.0])
                rows.append(dict(sale_date=day, store_id=store_id, sku=sku,
                                 units_sold=u, revenue=round(r, 2)))
    return rows
