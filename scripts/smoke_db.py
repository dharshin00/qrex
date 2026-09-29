"""Phase 1 gate: insert + upsert a clean row; a duplicate upsert leaves counts unchanged."""

from datetime import UTC, datetime

from sqlalchemy import func, select

from app.db.session import session_scope
from app.models import Order
from app.services.load import upsert_clean

REC = dict(platform="smoke", external_id="SMOKE-1", sku="SKU-1", canonical_sku=None,
           store_id="S1", quantity=2, amount=10.5, status="placed",
           ordered_at=datetime(2026, 1, 1, tzinfo=UTC))


def main() -> None:
    with session_scope() as db:
        db.query(Order).filter(Order.platform == "smoke").delete()
        n1 = upsert_clean(db, "orders", [REC], run_id=0, source_path="MANUAL_UPLOAD")
        n2 = upsert_clean(db, "orders", [REC], run_id=0, source_path="MANUAL_UPLOAD")
        n3 = upsert_clean(db, "orders", [{**REC, "status": "delivered"}], run_id=0,
                          source_path="MANUAL_UPLOAD")
        count = db.scalar(select(func.count()).select_from(Order).where(Order.platform == "smoke"))
        status = db.scalar(select(Order.status).where(Order.platform == "smoke"))
        db.query(Order).filter(Order.platform == "smoke").delete()
    print(f"insert={n1} duplicate={n2} changed={n3} rows={count} status={status}")
    assert (n1, n2, n3, count, status) == (1, 0, 1, 1, "delivered"), "idempotency broken"
    print("PHASE 1 GATE: PASS")


if __name__ == "__main__":
    main()
