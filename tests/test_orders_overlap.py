"""Regression: the orders re-pull overlap must cover the source's status-change
horizon, or late status updates never reach the clean layer (orders froze at
"in_transit" before this was fixed)."""

from datetime import UTC, datetime, timedelta

from app.services.pipeline import ORDERS_OVERLAP
from seed import catalog


def test_overlap_covers_status_horizon():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    # find how long after placement the mock still changes an order's status
    rows = catalog.orders("blinkit", now - timedelta(hours=1), now, now)
    horizon = max((now - r["ordered_at"]) for r in rows if r["status"] != "delivered")
    assert ORDERS_OVERLAP > horizon, f"overlap {ORDERS_OVERLAP} must exceed status horizon {horizon}"
