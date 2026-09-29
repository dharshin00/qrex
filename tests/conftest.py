import os

import httpx
import pytest

from app.config import get_settings


def seller_reads_otp(platform: str) -> str:
    """Test stand-in for the human: read the OTP from the mock's simulated phone."""
    msgs = httpx.get(get_settings().mock_platform_url + "/dev/inbox",
                     params={"platform": platform}).json()
    return msgs[0]["text"][:6]


@pytest.fixture(autouse=True)
def _reset_chaos():
    httpx.delete(get_settings().mock_platform_url + "/chaos")
    yield
    httpx.delete(get_settings().mock_platform_url + "/chaos")
