# ARCH — Q-REX System Architecture

Companion to `IDEATION.md` (the why) and `PRD.md` (the what). This is the how.

---

## 1. Guiding constraints

- **Connector abstraction over guessed APIs.** Downstream code never knows or
  cares which source path produced a record. It only sees the connector
  interface's normalized output.
- **Layered storage** (raw → staging → clean) so a bad pull never poisons
  analytics.
- **Idempotent everything.** Re-running a sync must not create duplicates.
- **Async, scheduled, retryable.** Celery + Redis; every task is idempotent and
  retry-safe.
- **No real platform internals in code.** Only the connector interface and
  `mock-platform` are implemented for real endpoints.

## 2. Component map

```
                        ┌─────────────────────────────────────────────┐
                        │                DASHBOARD (Next.js)           │
                        │  freshness · SKU view · stock alerts ·       │
                        │  intervention log · re-auth prompts          │
                        └───────────────▲─────────────────────────────┘
                                        │ REST / SSE
                        ┌───────────────┴─────────────────────────────┐
                        │                API (FastAPI)                 │
                        │  connectors admin · sync trigger · metrics · │
                        │  auth/re-auth callback · alerts feed         │
                        └───────▲───────────────────────▲─────────────┘
                                │                        │
             ┌──────────────────┘                        └────────────────┐
             │                                                             │
 ┌───────────┴───────────┐                              ┌──────────────────┴────────┐
 │  WORKERS (Celery)      │  ── enqueue / results ──►    │  Redis                     │
 │  sync · validate ·     │ ◄──  schedules (beat) ───    │  broker · locks · TTL      │
 │  transform · load ·    │                              │  cache · retry state       │
 │  health-probe · alert  │                              └────────────────────────────┘
 └───────────┬───────────┘
             │ uses
 ┌───────────┴───────────────────────────────────────────────┐
 │  CONNECTOR LAYER  (source-order: API → export → email → up)│
 │   BlinkitConnector · InstamartConnector  (mock-backed)     │
 └───────────┬───────────────────────────────────────────────┘
             │ talks only to
 ┌───────────┴───────────┐        ┌──────────────────────────┐
 │  mock-platform         │        │  PostgreSQL              │
 │  (FastAPI): OTP login, │        │  raw · staging · clean · │
 │  expiring sessions,    │        │  sku_map · sessions ·    │
 │  CSV exports, CHAOS    │        │  sync_runs · alerts      │
 └────────────────────────┘        └──────────────────────────┘
```

## 3. The pipeline (canonical flow)

```
Authentication → Retrieval → Validation → Transformation → Storage
      → Monitoring & Alerts → Dashboard
```

1. **Authentication** — connector obtains/reuses an encrypted session; if
   expired, raises `SessionExpired` → triggers re-auth flow (§6).
2. **Retrieval** — connector fetches via the highest available source path;
   writes the untouched payload to `raw` with a `source_path` label.
3. **Validation** — Pydantic schema + expectation checks (row count in band,
   required columns present, no drift). Failures quarantine the pull.
4. **Transformation** — normalize to the canonical record shape; resolve SKUs
   via `sku_map`; compute derived fields.
5. **Storage** — idempotent upsert into `clean` keyed on
   `(platform, external_id, sku)`; staging holds the transformed-but-unmerged
   rows for auditability.
6. **Monitoring & Alerts** — every run writes a `sync_runs` row; freshness SLA
   and stock thresholds evaluated; alerts dispatched.
7. **Dashboard** — reads clean layer + metadata tables.

## 4. Connector interface (the core abstraction)

Every connector implements the same contract. Downstream code depends on this,
never on a platform's specifics.

```python
class Connector(Protocol):
    platform: str                       # "blinkit" | "instamart"

    def authenticate(self, creds) -> Session: ...
    def is_session_valid(self, session) -> bool: ...
    def fetch(self, dataset: Dataset, session) -> RawPull: ...
    #   dataset ∈ {ORDERS, INVENTORY, WAREHOUSE_STOCK, SALES}
    #   RawPull carries: payload, source_path, fetched_at, row_hint

class SourcePath(Enum):        # tried in this order by the base connector
    OFFICIAL_API      = 1
    PORTAL_EXPORT     = 2
    EMAIL_INGEST      = 3
    MANUAL_UPLOAD     = 4
```

`fetch()` walks `SourcePath` in order and returns the first that succeeds,
recording which one won. If a real official API is ever available, only that
one method changes; nothing downstream moves.

## 5. Data model (PostgreSQL)

Tables (columns abbreviated — see `PRD.md` §Requirements for field lists):

- `connectors(id, platform, display_name, enabled, config_json)`
- `sessions(id, connector_id, encrypted_blob, expires_at, status)` — session
  material stored **encrypted at rest**; never logged.
- `raw_pulls(id, connector_id, dataset, source_path, payload, row_count, fetched_at, run_id)`
- `staging_records(id, run_id, dataset, normalized_json, sku_raw)`
- `orders / inventory / warehouse_stock / sales` — the **clean** layer, each
  with `(platform, external_id, sku)` unique constraint for upsert.
- `sku_map(id, canonical_sku, platform, platform_sku, product_name)` — unifies
  identifiers across platforms.
- `sync_runs(id, connector_id, dataset, status, source_path, started_at, finished_at, rows_in, rows_upserted, error)`
- `alerts(id, kind, severity, connector_id, payload, created_at, resolved_at)`
  — kinds: `SESSION_EXPIRED`, `SCHEMA_DRIFT`, `STALE_SOURCE`, `STOCK_OUT`,
  `LOW_STOCK`, `PARTIAL_PULL`, `PULL_FAILED`.
- `interventions(id, connector_id, kind, requested_at, resolved_at)` — powers
  the "manual interventions/week" metric.

### Idempotency rule

Clean-layer writes use `INSERT ... ON CONFLICT (platform, external_id, sku) DO
UPDATE`. A hash of the source row (`row_hash`) decides whether an update is even
needed, so re-runs are cheap and duplicate-free.

## 6. Session & re-auth flow (OTP-safe)

```
health-probe (Celery beat)
   └─ session invalid / near TTL?
        ├─ pause connector, mark data STALE
        ├─ write alert SESSION_EXPIRED + interventions row (open)
        ├─ notify seller (email/Telegram) with one-tap re-auth link
        │       └─ link → API /reauth/<connector> → mock-platform OTP screen
        │              └─ seller submits OTP → new Session stored (encrypted)
        └─ on success: resume connector → run BACKFILL for the stale window
                       → close interventions row
```

No code path ever supplies an OTP automatically. Backfill re-pulls the missed
window using the same idempotent load, so gaps self-heal.

## 7. Validation & schema-drift detection

- Each dataset has a Pydantic model = the contract.
- Before transform, the raw columns/keys are diffed against the expected set.
  A new, missing, or renamed column raises `SchemaDrift` → alert + quarantine
  (the pull lands in `raw_pulls` but never reaches clean).
- Expectation checks: row count within a rolling band, no all-null required
  columns, monotonic timestamps where expected.
- Partial pulls (row count far below band) → `PARTIAL_PULL` alert, quarantined,
  retried.

## 8. Scheduling, retries, concurrency

- **Celery beat** holds per-connector, per-dataset schedules (configurable
  interval stored in `connectors.config_json`).
- **Retries:** exponential backoff with jitter; capped attempts; after cap →
  `PULL_FAILED` alert and the connector's last-good data stays served (marked
  stale).
- **Locks:** a Redis lock per `(connector, dataset)` prevents overlapping runs.
- **On-demand:** every scheduled task is also exposed via the API for the demo.

## 9. Alerting

- Channels: email + one chat channel (Telegram bot or webhook) + in-dashboard
  feed. Channel set is config-driven; at minimum the in-dashboard feed and one
  external channel must work.
- Every alert has severity (`info | warn | critical`) and is de-duplicated
  (don't spam the same open condition).

## 10. Dashboard (Next.js)

Pages:
- **Overview** — per-source freshness tiles, open-alert count, interventions
  trend chart.
- **SKUs** — unified table across platforms with stock + sales per SKU.
- **Warehouses** — stock by dark store / warehouse with low-stock highlights.
- **Sync runs** — run history with status, source path, rows, errors.
- **Alerts** — feed with resolve action.
- **Connectors / Re-auth** — connector status; re-auth prompt surfaces here too.

Reads via FastAPI REST; live updates via SSE (or short polling if simpler).

## 11. Tech stack (from Q-REX baseline)

| Concern | Choice |
|---|---|
| Dashboard | Next.js (App Router), Tailwind |
| API | FastAPI + Pydantic v2 |
| Workers / schedule | Celery + Celery beat |
| Broker / cache / locks | Redis |
| Database | PostgreSQL |
| Migrations | Alembic |
| Secrets / session encryption | app-level encryption (Fernet) + env-provided key; vault optional |
| Orchestration | Docker Compose |
| Mock source | FastAPI (`mock-platform`) |
| Data quality | Pydantic + lightweight expectation checks (optionally Great Expectations) |

## 12. Repository layout (target)

```
qrex/
  docker-compose.yml
  .env.example
  docs/            # these six files
  api/             # FastAPI app
    app/
      main.py
      routers/     # connectors, sync, metrics, alerts, reauth
      models/      # SQLAlchemy models
      schemas/     # Pydantic contracts per dataset
      services/    # validation, transform, sku mapping, freshness
      db/          # session, migrations (alembic/)
  workers/         # Celery app, tasks, beat schedule
    connectors/    # base.py + blinkit.py + instamart.py (mock-backed)
  mock-platform/   # FastAPI: OTP login, expiring sessions, CSV exports, chaos
  web/             # Next.js dashboard
  seed/            # deterministic demo data
  scripts/         # demo runner, reset, backfill trigger
```

## 13. Key trade-offs recorded

- **Mock over live scraping:** loses "real data" wow factor, wins reliability,
  reproducibility, and compliance. Correct for a hackathon judged on resilience.
- **Layered storage:** more tables, but a bad pull can never corrupt analytics.
- **SSE vs websockets:** SSE is simpler and enough for a dashboard; chosen
  unless a feature needs bidirectional.
- **Fernet vs full vault:** Fernet is enough to demonstrate "encrypted at rest"
  without infra overhead; vault noted as the production upgrade.
