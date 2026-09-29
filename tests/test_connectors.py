"""Phase 3 gate: fetch(ORDERS) returns RawPull with source_path; expiry raises SessionExpired."""

import httpx
import pytest

from app.config import get_settings
from tests.conftest import seller_reads_otp
from workers.connectors import REGISTRY
from workers.connectors.base import Dataset, NotAvailable, SessionExpired, SourcePath, TransientError


def login(conn):
    ch = conn.begin_login()
    return conn.authenticate({"challenge_id": ch.challenge_id, "otp": seller_reads_otp(conn.platform)})


@pytest.mark.parametrize("platform", ["blinkit", "instamart"])
def test_fetch_orders_and_expiry(platform, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "inbox_dir", tmp_path / "inbox")
    monkeypatch.setattr(get_settings(), "upload_dir", tmp_path / "up")
    conn = REGISTRY[platform]({"seller_id": "t"})
    s = login(conn)
    assert "<redacted>" in repr(s)
    assert conn.is_session_valid(s)
    pull = conn.fetch(Dataset.ORDERS, s)
    assert pull.source_path is SourcePath.PORTAL_EXPORT
    assert pull.row_hint and pull.row_hint > 0
    assert pull.payload.splitlines()[0].split(",") == list(conn.COLUMNS["orders"].values())
    assert any("OFFICIAL_API" in x for x in pull.skipped)

    httpx.post(get_settings().mock_platform_url + "/chaos/expire_session",
               params={"platform": platform, "token": s.token})  # only ours, not the live system's
    assert not conn.is_session_valid(s)
    with pytest.raises(SessionExpired):
        conn.fetch(Dataset.ORDERS, s)


def test_ladder_falls_back_to_email_when_session_expired(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "inbox_dir", tmp_path)
    d = tmp_path / "blinkit" / "inventory"
    d.mkdir(parents=True)
    (d / "report.csv").write_text("item_id,item_name,total_qty,last_updated\n")
    conn = REGISTRY["blinkit"]({})
    pull = conn.fetch(Dataset.INVENTORY, None)
    assert pull.source_path is SourcePath.EMAIL_INGEST and pull.session_expired
    pull.ack()
    assert not list(d.glob("*.csv")) and list((d / "processed").glob("*.csv"))


def test_transient_and_consent(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "inbox_dir", tmp_path / "i")
    monkeypatch.setattr(get_settings(), "upload_dir", tmp_path / "u")
    conn = REGISTRY["instamart"]({})
    s = login(conn)
    httpx.post(get_settings().mock_platform_url + "/chaos/http_500",
               params={"platform": "instamart", "count": 1})
    with pytest.raises(TransientError):
        conn.fetch(Dataset.SALES, s)
    no_consent = REGISTRY["instamart"]({}, consented_paths={"EMAIL_INGEST"})
    with pytest.raises(NotAvailable, match="no consent"):
        no_consent.fetch(Dataset.SALES, s)
