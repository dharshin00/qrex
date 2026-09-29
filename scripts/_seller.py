"""DEMO-ONLY stand-in for the human seller.

Reads the OTP from mock-platform's *simulated phone* (`/dev/inbox`) — the same
thing a person would do by looking at their SMS. It exists only under
`scripts/` for the scripted demo and seed; no worker/API code path imports it,
so Q-REX itself never supplies an OTP (NOTE.md: OTP is human-in-the-loop).
"""

from __future__ import annotations

import time

import httpx

from app.config import get_settings


def read_otp_from_phone(platform: str, after: float | None = None, tries: int = 20) -> str:
    url = get_settings().mock_platform_url + "/dev/inbox"
    for _ in range(tries):
        msgs = httpx.get(url, params={"platform": platform}, timeout=5).json()
        if msgs:
            return msgs[0]["text"][:6]
        time.sleep(0.5)
    raise RuntimeError(f"no OTP arrived on the simulated phone for {platform}")


def reauth_via_api(api: str, platform: str) -> dict:
    """Walk the same flow the seller does in the dashboard: start -> read SMS -> submit."""
    start = httpx.post(f"{api}/reauth/{platform}/start", timeout=10)
    start.raise_for_status()
    otp = read_otp_from_phone(platform)
    r = httpx.post(f"{api}/reauth/{platform}/otp",
                   json={"challenge_id": start.json()["challenge_id"], "otp": otp}, timeout=10)
    r.raise_for_status()
    return r.json()
