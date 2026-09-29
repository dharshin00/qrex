# Q-REX

**Autonomous Quick-Commerce Data Retrieval & Reliability Platform**
PS-9 · Company partner: Palm Era

Q-REX gives consumer brands one reliable, self-healing, terms-compliant view of
their orders, inventory, warehouse stock, and sales across quick-commerce
platforms (Blinkit, Swiggy Instamart) — and keeps working when sessions expire,
OTP is required, or a platform changes its data format.

> **Design stance:** Q-REX never reverse-engineers a platform's internal APIs or
> drives a real seller account with a bot. It retrieves data only through
> compliant, consent-logged source paths, and it *handles* OTP and session
> expiry rather than bypassing them. See `docs/IDEATION.md` for the full
> rationale.

---

## What it does

```
Authentication → Retrieval → Validation → Transformation → Storage
      → Monitoring & Alerts → Dashboard
```

- **Compliant connector layer** — each platform is reached via a source-path
  ladder: official/partner API → seller-authorized report export → emailed
  report ingestion → manual upload. First that works wins; provenance is stored.
- **OTP-safe sessions** — expiry is detected before it breaks a sync; the seller
  gets a one-tap re-auth prompt; the system backfills the gap automatically.
- **Self-defending pipeline** — schema-drift detection, expectation checks,
  idempotent upserts, retries with backoff, quarantine of bad pulls.
- **Unified view** — one SKU/stock/sales table across platforms, with per-source
  freshness and per-warehouse stock alerts.
- **Provable resilience** — a built-in mock platform with a chaos panel lets you
  inject faults live and watch them get handled.

## Architecture at a glance

Next.js dashboard → FastAPI → Celery workers (+ beat) over Redis → PostgreSQL
(raw/staging/clean). Connectors talk to a local `mock-platform` (FastAPI) that
imitates a seller portal. Full detail in `docs/ARCH.md`.

## Quick start

Prereqs: Docker + Docker Compose.

```bash
git clone <repo> qrex && cd qrex
cp .env.example .env          # set SECRET/ENCRYPTION_KEY, alert channel creds
docker compose up --build     # brings up api, workers, beat, redis, db,
                              # mock-platform, web
```

Then:

- Dashboard: http://localhost:3000 — tabs: **Summary** (KPIs, store heatmap,
  city map, top SKUs), **Orders** (order-level table with delivery progress),
  SKUs, Stores, **Syncs** (pipeline health, activity, run history), Alerts,
  **Sources** (sessions, consent ladder, schedules, re-auth). The pink filter
  button scopes Summary/Orders to one platform.
- API docs: http://localhost:8000/docs
- Mock platform chaos panel: http://localhost:9000 (API docs at `/docs`)
- Simulated seller phone (receives OTPs): http://localhost:9000/dev/phone
- Alert emails (Mailpit): http://localhost:8025

Seed demo data and run a first sync:

```bash
docker compose exec api python -m scripts.seed        # deterministic demo data
docker compose exec api python -m scripts.sync_now    # trigger all connectors
```

### Without Docker

`scripts/dev.sh` runs the same services as local processes, using user-space
PostgreSQL + Redis under `./.local` (no root needed):

```bash
uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -r requirements-dev.txt
(cd web && npm install)
cp .env.example .env   # then point DATABASE_URL/REDIS_URL/MOCK_PLATFORM_URL at
                       # 127.0.0.1:55432 / 127.0.0.1:56379 / http://127.0.0.1:9000,
                       # ALERT_EMAIL_HOST=127.0.0.1 and INBOX_DIR/UPLOAD_DIR at ./data
scripts/dev.sh up      # postgres, redis, smtp sink, mock, api, worker, beat, web
export PYTHONPATH=$PWD:$PWD/api
.venv/bin/python -m scripts.seed
.venv/bin/python -m scripts.demo
scripts/dev.sh down
```

### Tests

```bash
# needs the stack up + seeded (integration tests). Against Compose:
DATABASE_URL=postgresql+psycopg://qrex:qrex@127.0.0.1:5432/qrex REDIS_URL=redis://127.0.0.1:6379/0 \
MOCK_PLATFORM_URL=http://127.0.0.1:9000 .venv/bin/pytest -q
# Against scripts/dev.sh: just `.venv/bin/pytest -q` with the dev .env in place.
```

## Running the demo

```bash
docker compose exec api python -m scripts.demo        # scripted chaos walk
```

The demo script (or the chaos panel at :9000) steps through:

1. **Healthy run** — both connectors sync; dashboard shows fresh data.
2. **Schema drift** — rename a column → `SCHEMA_DRIFT` alert, clean layer
   untouched.
3. **Transient failure** — inject 500 → retries with backoff → recovery.
4. **Partial pull** — truncated file → quarantined → `PARTIAL_PULL` alert.
5. **Session expiry + re-auth** — expire session → alert + one-tap re-auth →
   submit OTP → resume → **gap backfilled**, no duplicates.
6. **Stock alerts** — drop a SKU below threshold → `LOW_STOCK` / `STOCK_OUT`.

Watch the **interventions-per-week** chart fall once re-auth automation is in
play — that's the headline metric. (Weeks before the current one come from a
seeded baseline representing the manual workflow; the dashboard labels it.)

In the demo script the "seller" reading the OTP is played by
`scripts/_seller.py`, which reads the mock's simulated phone. To do it by hand,
open the dashboard's **Connectors → Re-authenticate**, click *Send OTP*, read
the code at `/dev/phone`, and type it in.

Useful flags: `--gap-seconds N` (how long the session stays expired in
scenario 5), `--only 2,5` (run selected scenarios). Reset between runs with
`python -m scripts.reset --yes && python -m scripts.seed`.

## Configuration

Key `.env` values (see `.env.example` for the full list):

| Var | Purpose |
|---|---|
| `ENCRYPTION_KEY` | Fernet key for session encryption at rest |
| `DATABASE_URL` | PostgreSQL connection |
| `REDIS_URL` | Celery broker + locks + cache |
| `MOCK_PLATFORM_URL` | Base URL of the mock seller portal |
| `ALERT_EMAIL_*` / `TELEGRAM_*` | External alert channel(s) |
| `SYNC_DEFAULT_INTERVAL` | Default schedule if a connector sets none |

Per-connector schedules and thresholds live in `connectors.config_json` and are
editable from the dashboard.

## Repository layout

```
qrex/
  docs/            IDEATION · ARCH · PRD · README · TASK · NOTE (README also at root)
  api/             FastAPI app (routers, models, schemas, services, db)
  workers/         Celery app, tasks, beat schedule, connectors/
  mock-platform/   FastAPI mock seller portal + chaos panel
  web/             Next.js dashboard
  seed/            deterministic demo data
  scripts/         seed · sync_now · demo · reset · backfill · dev.sh
  tests/           connector, validation and pipeline tests
  docker-compose.yml
  .env.example
```

## Compliance note (read before demoing)

Q-REX is built to operate within each platform's terms of service. It:

- retrieves only through permitted/consented mechanisms and logs that consent,
- stores the source path of every record for auditability,
- never automates OTP or holds credentials it isn't authorized to use.

For the hackathon, all live data flows through `mock-platform`; no production
platform is contacted. Real official/partner-API adapters are a drop-in future
step (`docs/PRD.md` §P2) that reuses the same connector interface.

## Docs index

- `docs/IDEATION.md` — why this approach; what we rejected and why.
- `docs/ARCH.md` — components, data flow, schema, trade-offs.
- `docs/PRD.md` — scoped requirements with acceptance criteria.
- `docs/TASK.md` — phased build plan for Claude Code CLI.
- `docs/NOTE.md` — running decisions, gotchas, and the do-not-do list.
