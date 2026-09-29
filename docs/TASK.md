# TASK — Q-REX Build Plan

Phased task list for **Claude Code CLI** to implement Q-REX. Work top to bottom.
Each phase has a **gate** — do not start the next phase until the gate passes.
Check boxes as you go. Map every task back to a PRD requirement (R#).

**Global rules (never break these):**
- Do **not** invent any real platform API, endpoint, field, or credential. Real
  endpoints exist only in `mock-platform`. Everything else uses the connector
  interface. If unsure, use the mock and say so.
- Every worker task must be **idempotent** and **retry-safe**.
- Nothing bad reaches the **clean** layer: validation failures quarantine.
- Prefer the smallest change that satisfies the acceptance criterion.
- Update `docs/NOTE.md` whenever you make a non-obvious decision or deviate.

---

## Phase 0 — Repo & environment audit
- [ ] Read all six docs in `docs/` before writing code.
- [ ] Scaffold repo per `ARCH.md` §12 layout.
- [ ] `docker-compose.yml` with services: `db` (postgres), `redis`, `api`,
      `worker`, `beat`, `mock-platform`, `web`.
- [ ] `.env.example` with every var from `README.md` §Configuration.
- [ ] Health endpoints on `api` and `mock-platform`.
- **Gate:** `docker compose up` starts all services; health checks green.

## Phase 1 — Data model & migrations  (R7)
- [ ] SQLAlchemy models for all tables in `ARCH.md` §5.
- [ ] Alembic migration creating them, incl. unique constraint
      `(platform, external_id, sku)` on each clean table.
- [ ] `sku_map`, `sessions`, `sync_runs`, `alerts`, `interventions`, `raw_pulls`,
      `staging_records`.
- **Gate:** migrations apply cleanly; a smoke script inserts + upserts a clean
  row and a duplicate upsert leaves row count unchanged.

## Phase 2 — mock-platform  (R2)
- [ ] FastAPI service: `POST /login` (returns "OTP required"), `POST /otp`
      (returns session token with `expires_at`), `GET /session` (validity).
- [ ] Report exports: `GET /export/{dataset}` → CSV for orders / inventory /
      warehouse_stock / sales, driven by `seed/` data.
- [ ] **Chaos controls** (`POST /chaos/{toggle}`): `rename_column`, `http_500`,
      `timeout`, `partial_file`, `expire_session`, `rate_limit`. State held in
      Redis or memory; togglable at runtime.
- [ ] Minimal chaos panel UI (or documented curl calls) — the demo driver.
- **Gate:** each dataset exports valid CSV; each chaos toggle demonstrably
  changes response behavior.

## Phase 3 — Connector layer  (R1, R3)
- [ ] `connectors/base.py`: `Connector` protocol + `SourcePath` ordering +
      `fetch()` that walks paths and records the winner.
- [ ] `PortalExportSource` (calls mock `/export`), `EmailIngestSource` (parse
      attachment from a drop folder/mailbox stub), `ManualUploadSource`
      (parse an uploaded file). `OfficialApiSource` = documented stub that raises
      `NotAvailable` (no guessing).
- [ ] `blinkit.py`, `instamart.py` — thin subclasses wiring platform config.
- [ ] Session mgmt: `authenticate()` via mock OTP; store **encrypted** session
      (Fernet); `is_session_valid()`; raise `SessionExpired`.
- **Gate:** a manual `fetch(ORDERS)` on each connector returns a `RawPull` with
  correct `source_path`; expired session raises `SessionExpired`.

## Phase 4 — Retrieval → raw + validation  (R5)
- [ ] Celery task `sync(connector, dataset)`: fetch → write `raw_pulls` with
      `source_path` → open a `sync_runs` row.
- [ ] Pydantic contract per dataset in `api/schemas/`.
- [ ] Validation service: column diff (drift), expectation checks (row-count
      band, required non-null, timestamp sanity).
- [ ] On failure: quarantine (stay in raw), raise `SCHEMA_DRIFT` / `PARTIAL_PULL`
      alert, mark run failed.
- **Gate:** healthy pull passes to staging; `rename_column` chaos → drift alert +
  clean layer untouched; `partial_file` chaos → partial alert + quarantine.

## Phase 5 — Transform → clean + SKU mapping  (R6, R7)
- [ ] Transform service: normalize staging → canonical records; resolve SKUs via
      `sku_map`; compute `row_hash`.
- [ ] Idempotent upsert into clean tables on `(platform, external_id, sku)`;
      skip write when `row_hash` unchanged.
- [ ] Seed `sku_map` so one product maps across both platforms.
- **Gate:** after syncing both connectors, the unified SKU view shows one row per
  physical product; a re-run changes nothing (0 duplicates).

## Phase 6 — Scheduling, retries, locks, on-demand  (R8)
- [ ] Celery beat schedule from `connectors.config_json` (per connector/dataset).
- [ ] Retry policy: exponential backoff + jitter, capped; after cap →
      `PULL_FAILED`, keep serving last-good (stale).
- [ ] Redis lock per `(connector, dataset)` to prevent overlap.
- [ ] API endpoints to trigger any sync on demand (demo need).
- **Gate:** `http_500` chaos → visible retries → recovery or `PULL_FAILED`;
  concurrent triggers do not double-run.

## Phase 7 — Re-auth flow + backfill  (R4)
- [ ] Health-probe beat task detecting near-TTL / invalid sessions.
- [ ] On expiry: pause connector, mark data stale, open `interventions`, send
      `SESSION_EXPIRED` alert with one-tap re-auth link.
- [ ] `/reauth/{connector}` → mock OTP screen → new encrypted session → resume.
- [ ] Backfill task re-pulls the stale window (idempotent load).
- **Gate:** `expire_session` chaos → alert + re-auth link → submit OTP → resume →
  gap window backfilled, no missing/duplicate clean rows; intervention closes.

## Phase 8 — Monitoring, freshness, alerting, dashboard  (R9, R10)
- [ ] Freshness SLA per source; `STALE_SOURCE` when breached.
- [ ] Stock evaluation → `LOW_STOCK` / `STOCK_OUT` per warehouse/SKU.
- [ ] Alert dispatch: in-dashboard feed + one external channel; de-dup open
      conditions.
- [ ] Next.js pages: Overview (freshness tiles, open alerts, interventions
      trend), SKUs, Warehouses, Sync runs, Alerts (resolve action),
      Connectors/Re-auth. Live via SSE or polling.
- **Gate:** every P0 backend capability is visible/actionable in the UI; each
  alert kind can be produced and shows in the feed; external channel gets ≥1.

## Phase 9 — Demo packaging & polish  (R11)
- [ ] `scripts/seed` (deterministic), `scripts/sync_now`, `scripts/reset`,
      `scripts/backfill`, `scripts/demo` (scripted chaos walk from README).
- [ ] Ensure a clean clone runs the whole demo via compose + scripts, no manual
      DB steps.
- [ ] Fill `docs/NOTE.md` with final decisions, known gaps, and the pitch line.
- [ ] (P1, if time) forecasting, Telegram re-auth, history charts, backfill
      progress UI.
- **Gate:** fresh clone → `docker compose up` → `scripts/demo` runs all six
  scenarios end to end.

---

## Definition of done (hackathon)
- All P0 acceptance criteria (R1–R11) demonstrated live via the chaos demo.
- 0 duplicate clean rows on re-run.
- Re-auth + backfill works end to end with simulated OTP.
- Interventions-per-week chart visibly trends down.
- `docs/NOTE.md` current.

## Suggested Claude Code CLI cadence
- One phase per focused session; run the gate before moving on.
- After each phase: run the relevant chaos toggle, confirm the handled outcome,
  then commit.
- Keep commits phase-scoped (`phase-4: validation + drift detection`).
