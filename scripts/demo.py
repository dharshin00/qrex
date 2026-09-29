"""Scripted chaos walk (README §Running the demo). Drives the system only
through its public HTTP surfaces: the Q-REX API and the mock-platform chaos panel.

  python -m scripts.demo [--gap-seconds 45] [--only 2,5] [--api URL] [--mock URL]

Scenarios
  1 healthy run           both connectors sync; data fresh
  2 schema drift          renamed column -> SCHEMA_DRIFT, quarantined, clean untouched
  3 transient failure     HTTP 500 x2 (+ timeout, rate-limit) -> backoff retries -> recovery
  4 partial pull          truncated file -> quarantined -> PARTIAL_PULL -> retried
  5 session expiry        expire -> alert + intervention -> seller OTP -> resume -> gap backfilled
  6 stock alerts          SKU below threshold -> LOW_STOCK / STOCK_OUT

Exit code is non-zero if any scenario fails.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.config import get_settings

G, R, Y, B, D, X = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[2m", "\033[0m"


class Demo:
    def __init__(self, api: str, mock: str, gap_seconds: int):
        self.api, self.mock, self.gap = api.rstrip("/"), mock.rstrip("/"), gap_seconds
        self.h = httpx.Client(timeout=30)
        self.results: list[tuple[str, bool, str]] = []

    # -- plumbing ----------------------------------------------------------
    def get(self, path: str, **params: Any) -> Any:
        r = self.h.get(self.api + path, params=params)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, base: str | None = None, **params: Any) -> Any:
        r = self.h.post((base or self.api) + path, params=params)
        r.raise_for_status()
        return r.json()

    def chaos(self, toggle: str, **params: Any) -> None:
        self.post(f"/chaos/{toggle}", base=self.mock, **params)
        say(f"{Y}⚡ chaos {toggle} {params}{X}")

    def chaos_reset(self) -> None:
        self.h.delete(self.mock + "/chaos")

    def last_run_id(self) -> int:
        runs = self.get("/runs", limit=1)
        return runs[0]["id"] if runs else 0

    def runs_since(self, rid: int, **filters: Any) -> list[dict]:
        return sorted(self.get("/runs", since_id=rid, limit=500, **filters), key=lambda r: r["id"])

    def alerts(self, **filters: Any) -> list[dict]:
        return self.get("/alerts", **filters)

    def wait(self, what: str, fn: Callable[[], Any], timeout: float = 90, every: float = 1.0) -> Any:
        t0 = time.time()
        while time.time() - t0 < timeout:
            v = fn()
            if v:
                say(f"{D}  ✓ {what} ({time.time() - t0:.1f}s){X}")
                return v
            time.sleep(every)
        raise AssertionError(f"timed out after {timeout}s waiting for: {what}")

    def ensure_active(self) -> None:
        from scripts._seller import reauth_via_api

        for c in self.get("/connectors"):
            if c["status"] == "paused" or not c["session"] or c["session"]["status"] != "active":
                say(f"{D}  {c['platform']} needs a session; seller re-auths first{X}")
                reauth_via_api(self.api, c["platform"])
                self.wait(f"{c['platform']} backfill done", lambda p=c["platform"]: not self.get(
                    f"/connectors/{p}")["open_intervention"], timeout=120)

    def scenario(self, n: int, title: str, fn: Callable[[], str]) -> None:
        say(f"\n{B}[{n}] {title}{X}")
        try:
            detail = fn()
            self.results.append((f"{n}. {title}", True, detail))
            say(f"{G}  PASS{X} {detail}")
        except Exception as e:  # noqa: BLE001
            self.results.append((f"{n}. {title}", False, str(e)))
            say(f"{R}  FAIL{X} {e}")
        finally:
            self.chaos_reset()

    # -- scenarios -----------------------------------------------------------
    def s1_healthy(self) -> str:
        self.ensure_active()
        rid = self.last_run_id()
        self.post("/sync")
        runs = self.wait("8 manual runs succeed (2 connectors × 4 datasets)",
                         lambda: (lambda rs: rs if len([r for r in rs if r["status"] == "success"]) >= 8
                                  else None)(self.runs_since(rid, mode="manual")))
        paths = {r["source_path"] for r in runs}
        fresh = [(c["platform"], f["dataset"], f["state"]) for c in self.get("/connectors")
                 for f in c["freshness"]]
        assert all(s == "fresh" for *_, s in fresh), f"not all fresh: {fresh}"
        o = self.get("/metrics/overview")
        assert o["duplicate_clean_rows"] == 0
        return f"source_path={paths}; all 8 datasets fresh; clean rows {o['clean_row_counts']}; 0 duplicates"

    def s2_drift(self) -> str:
        rid = self.last_run_id()
        self.chaos("rename_column", platform="blinkit", dataset="orders")
        before = self.get("/metrics/clean_counts")["orders"].get("blinkit", 0)
        self.post("/sync/blinkit/orders")
        run = self.wait("blinkit orders run quarantined",
                        lambda: next((r for r in self.runs_since(rid, platform="blinkit", dataset="orders")
                                      if r["status"] == "quarantined"), None))
        alert = self.wait("SCHEMA_DRIFT alert open", lambda: next(
            (a for a in self.alerts(status="open", kind="SCHEMA_DRIFT")
             if a["platform"] == "blinkit" and a["dataset"] == "orders"), None))
        after = self.get("/metrics/clean_counts")["orders"].get("blinkit", 0)
        assert after == before, f"clean layer changed during drift: {before} -> {after}"
        say(f"{D}  {alert['message']}{X}")
        self.chaos_reset()
        rid2 = self.last_run_id()
        self.post("/sync/blinkit/orders")
        self.wait("next pull succeeds after the source is fixed", lambda: any(
            r["status"] == "success" for r in self.runs_since(rid2, platform="blinkit", dataset="orders")))
        self.wait("SCHEMA_DRIFT auto-resolved", lambda: not [
            a for a in self.alerts(status="open", kind="SCHEMA_DRIFT") if a["platform"] == "blinkit"])
        return (f"run #{run['id']} quarantined; missing={alert['payload'].get('missing')} "
                f"unexpected={alert['payload'].get('unexpected')}; clean orders unchanged ({after})")

    def s3_transient(self) -> str:
        out = []
        for toggle, ds, count in (("http_500", "inventory", 2), ("timeout", "sales", 1),
                                  ("rate_limit", "warehouse_stock", 1)):
            rid = self.last_run_id()
            self.chaos(toggle, platform="instamart", dataset=ds, count=count)
            self.post(f"/sync/instamart/{ds}")
            runs = self.wait(f"{toggle}: retries then success", lambda: (
                lambda rs: rs if any(r["status"] == "success" for r in rs) else None)(
                self.runs_since(rid, platform="instamart", dataset=ds, mode="manual")), timeout=120)
            tries = [f"#{r['attempt']}:{r['status']}" for r in runs]
            assert any(r["status"] == "retrying" for r in runs), f"no retry observed: {tries}"
            gaps = [(datetime.fromisoformat(b["started_at"]) - datetime.fromisoformat(a["finished_at"]))
                    .total_seconds() for a, b in zip(runs, runs[1:])]
            out.append(f"{toggle}: {' → '.join(tries)} (backoff {', '.join(f'{g:.1f}s' for g in gaps)})")
            say(f"{D}  {out[-1]}{X}")
        # retries-exhausted path is covered by tests (keeps the live demo short)
        return "; ".join(out)

    def s4_partial(self) -> str:
        rid = self.last_run_id()
        self.chaos("partial_file", platform="blinkit", dataset="warehouse_stock", count=1)
        self.post("/sync/blinkit/warehouse_stock")
        runs = self.wait("quarantined then retried to success", lambda: (
            lambda rs: rs if any(r["status"] == "success" for r in rs) else None)(
            self.runs_since(rid, platform="blinkit", dataset="warehouse_stock", mode="manual")), timeout=60)
        q = next(r for r in runs if r["status"] == "quarantined")
        alert = next(a for a in self.alerts(kind="PARTIAL_PULL")
                     if a["platform"] == "blinkit" and a["dataset"] == "warehouse_stock")
        return f"run #{q['id']} quarantined ({q['error']}); PARTIAL_PULL alert #{alert['id']}; retry succeeded"

    def s5_session(self) -> str:
        from scripts._seller import reauth_via_api

        self.ensure_active()
        t0 = datetime.now(UTC)
        self.chaos("expire_session", platform="blinkit")
        say(f"{D}  running the health probe now (beat runs it every 30s){X}")
        self.post("/probe")
        self.wait("SESSION_EXPIRED alert + connector paused", lambda: any(
            a["platform"] == "blinkit" for a in self.alerts(status="open", kind="SESSION_EXPIRED"))
            and self.get("/connectors/blinkit")["status"] == "paused")
        iv = self.get("/connectors/blinkit")["open_intervention"]
        assert iv and iv["kind"] == "REAUTH", f"no open REAUTH intervention: {iv}"
        say(f"{D}  seller notified with one-tap link: {self.get('/connectors/blinkit')['reauth_url']}{X}")
        say(f"{D}  letting orders accumulate on the platform for {self.gap}s (the reporting gap)…{X}")
        time.sleep(self.gap)
        say(f"{D}  seller taps link → OTP sent to phone → seller types OTP{X}")
        res = reauth_via_api(self.api, "blinkit")
        since = datetime.fromisoformat(res["backfill"]["since"])
        self.wait("backfill complete, intervention closed", lambda: not self.get(
            "/connectors/blinkit")["open_intervention"], timeout=120)
        # ground truth: everything the platform has for [since - 1h, now - 1m)
        lo, hi = since - timedelta(hours=1), datetime.now(UTC) - timedelta(minutes=1)
        truth = httpx.get(self.mock + "/dev/truth/orders",
                          params={"platform": "blinkit", "since": lo.isoformat(),
                                  "until": hi.isoformat()}).json()
        ours = self.get("/metrics/orders_count", platform="blinkit", since=lo.isoformat(),
                        until=hi.isoformat())
        assert ours == truth, f"gap not closed: source={truth} clean={ours}"
        dupes = self.get("/metrics/overview")["duplicate_clean_rows"]
        assert dupes == 0, f"{dupes} duplicate clean rows"
        gap = self.get("/interventions", limit=1)[0]["gap_minutes_recovered"]
        return (f"paused {int((datetime.now(UTC) - t0).total_seconds())}s; backfilled from "
                f"{since:%H:%M:%S}; window source={truth['lines']} lines vs clean={ours['lines']} "
                f"(0 missing, 0 duplicates); gap recovered {gap} min")

    def s6_stock(self) -> str:
        self.chaos("stock_drop", platform="blinkit", units=0)
        self.chaos("stock_drop", platform="instamart", units=6)
        self.post("/sync/blinkit/warehouse_stock")
        self.post("/sync/instamart/warehouse_stock")
        out = self.wait("STOCK_OUT (blinkit) and LOW_STOCK (instamart) raised", lambda: (
            lambda a: a if {"STOCK_OUT", "LOW_STOCK"} <= {x["kind"] for x in a} else None)(
            [x for x in self.alerts(status="open") if x["kind"] in ("STOCK_OUT", "LOW_STOCK")]))
        return "; ".join(f"{a['kind']}: {a['message']}" for a in out[:2]) + \
            " (clears automatically on the next warehouse sync after restock)"

    def summary(self) -> int:
        say(f"\n{B}Summary{X}")
        for name, ok, detail in self.results:
            say(f"  {G + 'PASS' if ok else R + 'FAIL'}{X}  {name}")
        o = self.get("/metrics/overview")
        say(f"\n  interventions/week: {[w['count'] for w in o['interventions_per_week']]}")
        say(f"  duplicate clean rows: {o['duplicate_clean_rows']}  ·  open alerts: {o['open_alerts']}")
        say(f"  dashboard: {get_settings().public_web_url}  ·  chaos panel: {self.mock}")
        return 0 if all(ok for _, ok, _ in self.results) else 1


def say(msg: str) -> None:
    print(msg, flush=True)


def main() -> None:
    s = get_settings()
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.getenv("QREX_API_URL", "http://localhost:8000"))
    ap.add_argument("--mock", default=s.mock_platform_url)
    ap.add_argument("--gap-seconds", type=int, default=45)
    ap.add_argument("--only", default="1,2,3,4,5,6")
    a = ap.parse_args()
    d = Demo(a.api, a.mock, a.gap_seconds)

    def healthy() -> bool:
        try:
            return (d.h.get(d.api + "/health").json()["status"] == "ok"
                    and d.h.get(d.mock + "/health").status_code == 200)
        except (httpx.HTTPError, ValueError, KeyError):
            return False

    d.wait("api + mock-platform healthy", healthy, timeout=90)
    d.chaos_reset()
    steps = {1: ("Healthy run", d.s1_healthy), 2: ("Schema drift", d.s2_drift),
             3: ("Transient failure", d.s3_transient), 4: ("Partial pull", d.s4_partial),
             5: ("Session expiry + re-auth + backfill", d.s5_session), 6: ("Stock alerts", d.s6_stock)}
    for n in map(int, a.only.split(",")):
        d.scenario(n, *steps[n])
    sys.exit(d.summary())


if __name__ == "__main__":
    main()
