"""Pipeline integration tests. Need: local Postgres + Redis + mock-platform, seeded
(`scripts/dev.sh up && python -m scripts.seed`)."""

import httpx
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db.session import session_scope
from app.models import Alert, Connector, SyncRun
from app.services.pipeline import Retryable, perform_sync
from workers.tasks import dataset_lock, sync_dataset

MOCK = get_settings().mock_platform_url


@pytest.fixture
def instamart_id():
    with session_scope() as db:
        c = db.scalar(select(Connector).where(Connector.platform == "instamart"))
        if c is None or c.status != "active":
            pytest.skip("instamart connector not seeded/active")
        return c.id


def test_retries_exhausted_raise_pull_failed(instamart_id):
    httpx.post(f"{MOCK}/chaos/http_500", params={"platform": "instamart", "dataset": "sales"})
    with pytest.raises(Retryable):
        perform_sync(instamart_id, "sales", mode="manual", attempt=1, final_attempt=False)
    out = perform_sync(instamart_id, "sales", mode="manual", attempt=5, final_attempt=True)
    assert out.status == "failed"
    with session_scope() as db:
        a = db.scalar(select(Alert).where(Alert.kind == "PULL_FAILED", Alert.dataset == "sales",
                                          Alert.connector_id == instamart_id,
                                          Alert.resolved_at.is_(None)))
        assert a is not None
    httpx.delete(f"{MOCK}/chaos")
    assert perform_sync(instamart_id, "sales", mode="manual").status == "success"
    with session_scope() as db:
        assert db.get(Alert, a.id).resolved_at is not None  # recovery auto-resolves


def test_concurrent_trigger_does_not_double_run(instamart_id):
    with session_scope() as db:
        before = db.query(SyncRun).count()
    with dataset_lock(instamart_id, "inventory") as got:
        assert got
        res = sync_dataset.apply(args=(instamart_id, "inventory", "scheduled")).get()
    assert res == {"status": "skipped_locked"}
    with session_scope() as db:
        assert db.query(SyncRun).count() == before


def test_rerun_is_idempotent(instamart_id):
    perform_sync(instamart_id, "sales", mode="manual")
    again = perform_sync(instamart_id, "sales", mode="manual")
    assert again.status == "success" and again.rows_upserted == 0
