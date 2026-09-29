"""mock-platform — an imitation seller portal for the Q-REX demo.

This is the ONLY place in the repo that implements "platform" HTTP behaviour.
Every endpoint, field and format here is invented for the demo; none of it
describes a real Blinkit or Swiggy Instamart API.

Features
- OTP login (`POST /login` -> OTP delivered to a simulated seller phone,
  `POST /otp` -> session token with expires_at), `GET /session` validity check.
- CSV report exports `GET /export/{dataset}` driven by `seed.catalog`.
- Chaos controls `POST /chaos/{toggle}` to inject faults at runtime.
- `GET /` chaos panel UI, `GET /dev/phone` simulated seller phone (OTP inbox),
  `GET /dev/truth/orders` ground-truth counts for the demo's no-gap check.
"""

from __future__ import annotations

import asyncio
import csv
import io
import os
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from seed import catalog

SESSION_TTL = int(os.getenv("MOCK_SESSION_TTL_SECONDS", "43200"))
TIMEOUT_SLEEP = float(os.getenv("MOCK_TIMEOUT_SLEEP_SECONDS", "8"))  # > client timeout
OTP_TTL = 300

app = FastAPI(title="Q-REX mock-platform", description=__doc__)

# ---------------------------------------------------------------------------
# In-memory state (single-process service; restarting it logs everyone out,
# which is itself a realistic failure the pipeline must handle)
# ---------------------------------------------------------------------------
SESSIONS: dict[str, dict[str, Any]] = {}      # token -> {platform, expires_at}
CHALLENGES: dict[str, dict[str, Any]] = {}    # challenge_id -> {platform, otp, exp}
PHONE: list[dict[str, Any]] = []              # simulated seller SMS inbox
STOCK_OVERRIDES: dict[tuple[str, str, str], int] = {}  # (platform, store, sku)->units

TOGGLES = ("rename_column", "http_500", "timeout", "partial_file", "rate_limit")
# toggle -> {platform: {"remaining": int|None, **params}}
CHAOS: dict[str, dict[str, dict[str, Any]]] = {t: {} for t in TOGGLES}
CHAOS_LOG: list[dict[str, Any]] = []

DEFAULT_RENAMES = {"orders": "quantity", "inventory": "units", "warehouse_stock": "units",
                   "sales": "units_sold"}


def _now() -> datetime:
    return datetime.now(UTC)


def _log(event: str, **kw: Any) -> None:
    CHAOS_LOG.append({"at": _now().isoformat(), "event": event, **kw})
    del CHAOS_LOG[:-200]


def _platforms(platform: str) -> list[str]:
    if platform == "all":
        return list(catalog.PLATFORMS)
    if platform not in catalog.PLATFORMS:
        raise HTTPException(404, f"unknown platform {platform!r}")
    return [platform]


def _chaos_hit(toggle: str, platform: str, dataset: str | None = None) -> dict | None:
    """Return toggle params if active for this platform (consuming one use)."""
    st = CHAOS[toggle].get(platform)
    if st is None:
        return None
    if dataset and st.get("dataset") not in (None, dataset):
        return None
    if st["remaining"] is not None:
        st["remaining"] -= 1
        if st["remaining"] <= 0:
            CHAOS[toggle].pop(platform, None)
    _log(f"chaos:{toggle}", platform=platform, dataset=dataset)
    return st


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "mock-platform", "time": _now().isoformat()}


# ---------------------------------------------------------------------------
# Auth: OTP login and sessions
# ---------------------------------------------------------------------------
class LoginIn(BaseModel):
    platform: str
    seller_id: str


class OtpIn(BaseModel):
    challenge_id: str
    otp: str


@app.post("/login")
def login(body: LoginIn) -> dict:
    _platforms(body.platform)
    cid = secrets.token_urlsafe(12)
    otp = f"{secrets.randbelow(1_000_000):06d}"
    CHALLENGES[cid] = {"platform": body.platform, "otp": otp, "exp": time.time() + OTP_TTL,
                       "seller_id": body.seller_id}
    PHONE.append({"at": _now().isoformat(), "platform": body.platform,
                  "seller_id": body.seller_id,
                  "text": f"{otp} is your {body.platform}-mock seller login OTP. Valid 5 min."})
    del PHONE[:-50]
    _log("login", platform=body.platform)
    return {"status": "otp_required", "challenge_id": cid, "delivery": "sms",
            "expires_in": OTP_TTL}


@app.post("/otp")
def submit_otp(body: OtpIn) -> dict:
    ch = CHALLENGES.get(body.challenge_id)
    if not ch or ch["exp"] < time.time():
        raise HTTPException(400, "challenge expired or unknown")
    if not secrets.compare_digest(ch["otp"], body.otp.strip()):
        raise HTTPException(401, "invalid otp")
    CHALLENGES.pop(body.challenge_id, None)
    token = secrets.token_urlsafe(32)
    expires_at = _now() + timedelta(seconds=SESSION_TTL)
    SESSIONS[token] = {"platform": ch["platform"], "expires_at": expires_at}
    _log("session_issued", platform=ch["platform"])
    return {"token": token, "expires_at": expires_at.isoformat(), "platform": ch["platform"]}


def _session(authorization: str | None) -> dict:
    token = (authorization or "").removeprefix("Bearer ").strip()
    s = SESSIONS.get(token)
    if not s or s["expires_at"] <= _now():
        raise HTTPException(401, "session expired", headers={"X-Session": "expired"})
    return s


@app.get("/session")
def session_status(authorization: str | None = Header(None)) -> dict:
    token = (authorization or "").removeprefix("Bearer ").strip()
    s = SESSIONS.get(token)
    valid = bool(s and s["expires_at"] > _now())
    return {"valid": valid, "platform": s and s["platform"],
            "expires_at": s and s["expires_at"].isoformat()}


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
def _fmt(v: Any) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _rows(platform: str, dataset: str, since: datetime | None, until: datetime | None) -> list[dict]:
    now = _now()
    if dataset == "orders":
        lo = now - timedelta(days=catalog.HISTORY_DAYS)
        since = max(since or now - timedelta(hours=24), lo)
        until = min(until or now, now)
        return catalog.orders(platform, since, until, now)
    stock = catalog.warehouse_stock(platform, now)
    for r in stock:
        o = STOCK_OVERRIDES.get((platform, r["store_id"], r["sku"]))
        if o is not None:
            r["units"] = o
    if dataset == "warehouse_stock":
        return stock
    if dataset == "inventory":
        return catalog.inventory(platform, now, stock)
    if dataset == "sales":
        return catalog.sales(platform, now)
    raise HTTPException(404, f"unknown dataset {dataset!r}")


@app.get("/export/{dataset}")
async def export(
    dataset: str,
    since: datetime | None = Query(None, description="orders only: ordered_at >= since"),
    until: datetime | None = Query(None, description="orders only: ordered_at < until"),
    authorization: str | None = Header(None),
) -> Response:
    if dataset not in catalog.DATASETS:
        raise HTTPException(404, f"unknown dataset {dataset!r}")
    sess = _session(authorization)
    platform = sess["platform"]

    if _chaos_hit("rate_limit", platform, dataset):
        return JSONResponse({"detail": "rate limited"}, 429, headers={"Retry-After": "3"})
    if _chaos_hit("http_500", platform, dataset):
        return JSONResponse({"detail": "internal error (chaos)"}, 500)
    if _chaos_hit("timeout", platform, dataset):
        await asyncio.sleep(TIMEOUT_SLEEP)

    colmap = dict(catalog.COLUMN_MAPS[platform][dataset])
    rename = _chaos_hit("rename_column", platform, dataset)
    if rename:
        field = rename.get("column") or DEFAULT_RENAMES[dataset]
        colmap[field] = rename.get("to") or f"{colmap[field]}_v2"

    rows = _rows(platform, dataset, since, until)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(colmap.values())
    for r in rows:
        w.writerow(_fmt(r[k]) for k in colmap)
    body = buf.getvalue()

    if _chaos_hit("partial_file", platform, dataset):
        # truncated transfer: keep ~40% of bytes, cut mid-line
        body = body[: max(len(body) * 2 // 5, 1)]
        body = body[: body.rfind("\n") + 1 + 7] if "\n" in body else body

    return Response(
        body,
        media_type="text/csv",
        headers={
            "X-Row-Count": str(len(rows)),
            "Content-Disposition": f'attachment; filename="{platform}_{dataset}.csv"',
        },
    )


# ---------------------------------------------------------------------------
# Chaos controls
# ---------------------------------------------------------------------------
@app.get("/chaos")
def chaos_state() -> dict:
    return {
        "toggles": {t: {p: dict(v) for p, v in s.items()} for t, s in CHAOS.items()},
        "stock_overrides": [{"platform": p, "store_id": s, "sku": k, "units": u}
                            for (p, s, k), u in STOCK_OVERRIDES.items()],
        "active_sessions": [{"platform": v["platform"], "expires_at": v["expires_at"].isoformat()}
                            for v in SESSIONS.values() if v["expires_at"] > _now()],
        "log": CHAOS_LOG[-30:],
    }


@app.post("/chaos/expire_session")
def chaos_expire_session(platform: str = "all",
                         token: str | None = Query(None, description="expire only this session")) -> dict:
    ps = _platforms(platform)
    n = 0
    for t, s in SESSIONS.items():
        if token and t != token:
            continue
        if s["platform"] in ps and s["expires_at"] > _now():
            s["expires_at"] = _now()
            n += 1
    _log("chaos:expire_session", platform=platform, expired=n)
    return {"expired": n}


@app.post("/chaos/stock_drop")
def chaos_stock_drop(platform: str = "blinkit", sku: str | None = None,
                     store_id: str | None = None, units: int = 0) -> dict:
    """Force a SKU's units at a store (default: first SKU at first store)."""
    ps = _platforms(platform)
    out = []
    for p in ps:
        s = store_id or catalog.stores(p)[0][0]
        k = sku or catalog.platform_sku(p, catalog.PRODUCTS[0].canonical_sku)
        STOCK_OVERRIDES[(p, s, k)] = units
        out.append({"platform": p, "store_id": s, "sku": k, "units": units})
    _log("chaos:stock_drop", items=out)
    return {"overrides": out}


@app.post("/chaos/{toggle}")
def chaos_set(
    toggle: str,
    platform: str = "all",
    enabled: bool = True,
    count: int | None = Query(None, description="auto-disable after N hits; omit = until disabled"),
    dataset: str | None = None,
    column: str | None = Query(None, description="rename_column: canonical field to rename"),
    to: str | None = Query(None, description="rename_column: new column header"),
) -> dict:
    if toggle not in CHAOS:
        raise HTTPException(404, f"unknown toggle; choose from {TOGGLES + ('expire_session', 'stock_drop')}")
    for p in _platforms(platform):
        if enabled:
            CHAOS[toggle][p] = {"remaining": count, "dataset": dataset, "column": column, "to": to}
        else:
            CHAOS[toggle].pop(p, None)
    _log(f"set:{toggle}", platform=platform, enabled=enabled, count=count, dataset=dataset)
    return chaos_state()["toggles"][toggle]


@app.delete("/chaos")
def chaos_reset() -> dict:
    for t in CHAOS.values():
        t.clear()
    STOCK_OVERRIDES.clear()
    _log("reset")
    return {"status": "reset"}


# ---------------------------------------------------------------------------
# Dev helpers: simulated seller phone + ground truth for demo verification
# ---------------------------------------------------------------------------
@app.get("/dev/inbox")
def dev_inbox(platform: str | None = None) -> list[dict]:
    """Simulated seller phone SMS inbox. Stands in for the human reading an SMS."""
    return [m for m in reversed(PHONE) if platform in (None, m["platform"])]


@app.get("/dev/truth/orders")
def dev_truth_orders(platform: str, since: datetime, until: datetime) -> dict:
    rows = catalog.orders(platform, since, until, _now())
    return {"lines": len(rows), "orders": len({r["order_id"] for r in rows})}


@app.get("/dev/phone", response_class=HTMLResponse)
def dev_phone() -> str:
    return _page("Seller phone (simulated)", """
<p class=muted>Stands in for the seller's phone. OTPs sent by the mock portal land here.</p>
<div id=msgs></div>
<script>
async function load(){const r=await fetch('/dev/inbox');const m=await r.json();
document.getElementById('msgs').innerHTML=m.map(x=>`<div class=card><b>${x.platform}</b>
<span class=muted>${new Date(x.at).toLocaleTimeString()}</span><div class=otp>${x.text}</div></div>`).join('')
||'<p class=muted>No messages yet.</p>'}
load();setInterval(load,2000)</script>""")


@app.get("/", response_class=HTMLResponse)
def panel(request: Request) -> str:
    return _page("mock-platform · chaos panel", """
<p class=muted>Inject faults into the imitation seller portal and watch Q-REX handle them.
<a href="/dev/phone">Seller phone</a> · <a href="/docs">API docs</a></p>
<label>Platform <select id=pf><option>all</option><option>blinkit</option><option>instamart</option></select></label>
<div class=grid>
 <button onclick="t('rename_column')">Rename column (schema drift)</button>
 <button onclick="t('http_500','&count=2')">HTTP 500 ×2 (recovers)</button>
 <button onclick="t('http_500')">HTTP 500 (until off)</button>
 <button onclick="t('timeout','&count=1')">Timeout ×1</button>
 <button onclick="t('partial_file','&count=1')">Partial file ×1</button>
 <button onclick="t('rate_limit','&count=2')">Rate-limit ×2</button>
 <button onclick="p('/chaos/expire_session')">Expire session</button>
 <button onclick="p('/chaos/stock_drop?units=0&platform='+pfv())">Stock-out a SKU</button>
 <button onclick="p('/chaos/stock_drop?units=6&platform='+pfv())">Low-stock a SKU</button>
 <button class=reset onclick="fetch('/chaos',{method:'DELETE'}).then(load)">Reset all chaos</button>
</div>
<h3>State</h3><pre id=state></pre>
<script>
const pfv=()=>document.getElementById('pf').value;
async function p(u){await fetch(u+(u.includes('?')?'':'?platform='+pfv()),{method:'POST'});load()}
function t(n,extra=''){p('/chaos/'+n+'?platform='+pfv()+extra)}
async function load(){const s=await (await fetch('/chaos')).json();
document.getElementById('state').textContent=JSON.stringify(s,null,1)}
load();setInterval(load,2000)</script>""")


def _page(title: str, body: str) -> str:
    return f"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>{title}</title>
<style>body{{font:15px system-ui;max-width:900px;margin:24px auto;padding:0 16px;background:#0f1115;color:#e6e6e6}}
.muted{{color:#9aa}}a{{color:#7cc4ff}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin:12px 0}}
button{{padding:10px;border-radius:8px;border:1px solid #334;background:#1b2130;color:#e6e6e6;cursor:pointer}}
button:hover{{background:#26304a}}button.reset{{border-color:#a55}}pre{{background:#151923;padding:12px;border-radius:8px;overflow:auto;font-size:12px}}
.card{{background:#151923;padding:12px;border-radius:8px;margin:8px 0}}.otp{{font-size:18px;margin-top:6px}}select{{padding:6px}}</style>
</head><body><h2>{title}</h2>{body}</body></html>"""
