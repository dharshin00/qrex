from workers.connectors.base import BaseConnector


class InstamartConnector(BaseConnector):
    """Swiggy Instamart — backed by mock-platform. Column headers are the MOCK's
    export format, not Instamart's real report format (unknown; not guessed)."""

    platform = "instamart"
    display_name = "Swiggy Instamart (mock)"
    COLUMNS = {
        "orders": {
            "order_id": "OrderID", "sku": "SKUCode", "store_id": "WarehouseCode",
            "quantity": "Quantity", "amount": "TotalAmount", "status": "Status",
            "ordered_at": "OrderTime",
        },
        "inventory": {"sku": "SKUCode", "product_name": "ProductName", "units": "OnHand",
                      "as_of": "AsOf"},
        "warehouse_stock": {"store_id": "WarehouseCode", "city": "City", "sku": "SKUCode",
                            "units": "OnHand", "as_of": "AsOf"},
        "sales": {"sale_date": "Date", "store_id": "WarehouseCode", "sku": "SKUCode",
                  "units_sold": "UnitsSold", "revenue": "Revenue"},
    }
