from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Connector

DATASETS = ("orders", "inventory", "warehouse_stock", "sales")


def connector_by_platform(platform: str, db: Session = Depends(get_db)) -> Connector:
    c = db.scalar(select(Connector).where(Connector.platform == platform))
    if c is None:
        raise HTTPException(404, f"unknown connector {platform!r}")
    return c


def check_dataset(dataset: str) -> str:
    if dataset not in DATASETS:
        raise HTTPException(404, f"unknown dataset {dataset!r}; one of {DATASETS}")
    return dataset
