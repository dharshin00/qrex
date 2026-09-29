from workers.connectors.base import BaseConnector


class BlinkitConnector(BaseConnector):
    """Blinkit — backed by mock-platform. Column headers are the MOCK's export
    format, not Blinkit's real report format (unknown; not guessed)."""

    platform = "blinkit"
    display_name = "Blinkit (mock)"
    COLUMNS = {
        "orders": {
            "order_id": "order_id", "sku": "item_id", "store_id": "dark_store_id",
            "quantity": "qty", "amount": "order_value", "status": "order_status",
            "ordered_at": "created_at",
        },
        "inventory": {"sku": "item_id", "product_name": "item_name", "units": "total_qty",
                      "as_of": "last_updated"},
        "warehouse_stock": {"store_id": "dark_store_id", "city": "dark_store_city",
                            "sku": "item_id", "units": "available_qty", "as_of": "last_updated"},
        "sales": {"sale_date": "sale_date", "store_id": "dark_store_id", "sku": "item_id",
                  "units_sold": "units_sold", "revenue": "gmv"},
    }
