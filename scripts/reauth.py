"""Re-authenticate connectors as the simulated seller (DEMO ONLY).

Walks the same flow a seller does in the dashboard (start -> read the OTP from
mock-platform's simulated phone -> submit), then Q-REX backfills the gap.
Use after mock-platform restarts: it keeps sessions in memory, so a restart
logs Q-REX out and pauses both connectors.

  python -m scripts.reauth                 # all paused connectors
  python -m scripts.reauth --all           # every connector
  python -m scripts.reauth --platform blinkit
"""

from __future__ import annotations

import argparse
import os

import httpx

from scripts._seller import reauth_via_api


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.getenv("QREX_API_URL", "http://localhost:8000"))
    ap.add_argument("--platform")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    conns = httpx.get(f"{a.api}/connectors", timeout=10).json()
    todo = [c["platform"] for c in conns
            if (a.platform in (None, c["platform"])) and (a.all or a.platform or c["status"] == "paused")]
    if not todo:
        print("nothing to do — no paused connectors (use --all to force)")
        return
    for p in todo:
        r = reauth_via_api(a.api, p)
        print(f"{p}: {r['status']} · backfilling since {r['backfill']['since']}")


if __name__ == "__main__":
    main()
