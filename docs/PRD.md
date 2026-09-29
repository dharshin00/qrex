# PRD — Q-REX

Product Requirements. Scoped for the hackathon build (Claude Code CLI as the
implementer). Priorities: **P0** must ship, **P1** ship if time allows, **P2**
explicitly deferred.

---

## Problem statement

Brands selling on Blinkit and Swiggy Instamart lack a reliable, low-maintenance
way to see their own orders, inventory, warehouse stock, and sales. Existing
browser automation breaks on session expiry, OTP prompts, and platform changes.
Q-REX turns fragmented, fragile data access into a monitored, self-healing,
terms-compliant pipeline with a single dashboard.

## Goals

1. Deliver an end-to-end pipeline (auth → retrieve → validate → transform →
   store → monitor → alert → dashboard) that runs from `docker compose up`.
2. Survive the failure modes named in the PS — session expiry, OTP, schema
   change, partial/failed pulls — with automatic detection, alerting, retry, and
   backfill.
3. Operate only through terms-compliant, consent-logged source paths; store the
   provenance of every record.
4. Present one unified, cross-platform SKU / stock / sales view with per-source
   freshness.
5. Prove all of the above live via a chaos-driven demo, without a real seller
   account.

## Non-goals

- **Not** reverse-engineering or driving any real platform's internal API.
  *(Rationale: out of terms, high-maintenance, account risk.)*
- **Not** automating OTP entry or bypassing authentication.
  *(Rationale: the PS wants OTP *handled*, not defeated.)*
- **Not** production-grade multi-tenant SaaS, billing, or RBAC.
  *(Rationale: hackathon scope; note as future.)*
- **Not** real integrations with Blinkit/Instamart production systems.
  *(Rationale: no legitimate access; `mock-platform` stands in.)*
- **Not** mobile app or native clients. *(Web dashboard only.)*

## Personas & user stories

**Brand ops analyst (primary consumer of the dashboard)**
- As an analyst, I want one view of stock and sales across Blinkit and Instamart
  so I stop reconciling exports by hand.
- As an analyst, I want to see how fresh each source is so I trust the numbers.
- As an analyst, I want alerts when a SKU is low or out at a warehouse so I act
  before I stock out.

**Brand admin / seller (owns credentials & consent)**
- As an admin, I want to authorize a connector once and only step in for OTP
  when genuinely required.
- As an admin, when a session expires I want a one-tap prompt to re-auth, after
  which the system catches up on its own.

**Platform operator (runs Q-REX / demos it)**
- As an operator, I want scheduled syncs I can also trigger on demand.
- As an operator, I want failed/incomplete pulls detected automatically with
  retries and logs.
- As an operator (demo), I want to inject faults and show them being handled.

## Requirements

### P0 — must ship

**R1. Connector layer**
- Base connector implements source-path ordering (API → export → email →
  upload) and records the winning path per pull.
- Two connectors: `blinkit` and `instamart`, both backed by `mock-platform`.
- *Acceptance:* a sync produces `raw_pulls` rows tagged with `source_path`; the
  connector interface is identical across both platforms.

**R2. mock-platform**
- FastAPI service exposing: OTP login, session issuance with expiry, and CSV
  exports for orders/inventory/warehouse-stock/sales.
- Chaos panel toggles: rename column, HTTP 500/timeout, partial file, expire
  session, rate-limit.
- *Acceptance:* each toggle changes real response behavior and is switchable at
  runtime via an endpoint/UI.

**R3. Authentication & session management**
- Sessions stored encrypted at rest; expiry tracked via TTL + health probe.
- `SessionExpired` pauses the connector and opens an intervention.
- *Acceptance:* expiring a session (via chaos) is detected before the next sync
  writes bad data.

**R4. OTP re-auth flow with backfill**
- On expiry: alert seller + one-tap re-auth link → OTP screen → new encrypted
  session → resume → backfill missed window.
- *Acceptance:* after simulated re-auth, the gap window is refilled and no
  clean-layer records are missing or duplicated.

**R5. Validation & schema-drift detection**
- Pydantic contract per dataset; column diff + expectation checks before
  transform; failures quarantine the pull and raise an alert.
- *Acceptance:* a renamed column (chaos) yields a `SCHEMA_DRIFT` alert and the
  clean layer is untouched.

**R6. Transformation & unified SKU mapping**
- Normalize to canonical records; resolve platform SKUs to `canonical_sku` via
  `sku_map`.
- *Acceptance:* the same physical product from both platforms appears as one row
  in the unified SKU view.

**R7. Storage with idempotent upserts**
- Layered raw/staging/clean; clean writes upsert on
  `(platform, external_id, sku)`.
- *Acceptance:* running the same sync twice does not change row counts in clean.

**R8. Scheduling, retries, failure detection**
- Celery beat per-connector/dataset configurable intervals; on-demand trigger;
  exponential backoff retries; Redis lock prevents overlap; failed/partial pulls
  detected and alerted.
- *Acceptance:* a chaos 500 triggers retries with backoff, then a `PULL_FAILED`
  alert if the cap is hit, while last-good data stays served (marked stale).

**R9. Monitoring, freshness SLA & alerts**
- Per-source freshness SLA; alert kinds: `SESSION_EXPIRED`, `SCHEMA_DRIFT`,
  `STALE_SOURCE`, `PARTIAL_PULL`, `PULL_FAILED`, `STOCK_OUT`, `LOW_STOCK`.
- At least the in-dashboard feed **and** one external channel deliver alerts;
  alerts de-duplicate.
- *Acceptance:* each alert kind can be produced on demand and appears in the
  feed; external channel receives at least one.

**R10. Dashboard**
- Pages: Overview (freshness tiles, open alerts, interventions trend), SKUs,
  Warehouses (low-stock highlights), Sync runs, Alerts, Connectors/Re-auth.
- *Acceptance:* every P0 backend capability is visible/actionable from the UI.

**R11. Reproducible demo**
- Deterministic seed data; `docker compose up` brings the whole system live;
  a demo script walks the chaos scenarios.
- *Acceptance:* a clean clone runs the full demo without manual DB fiddling.

### P1 — if time allows

- Stock-out **forecasting** (simple velocity-based days-of-cover per SKU/store).
- Telegram bot re-auth (vs email link) for a slicker live re-auth.
- Great Expectations for richer data-quality reports.
- Historical charts (sales trend, stock trend) beyond current-state tables.
- Backfill progress indicator in the UI.

### P2 — future considerations

- Real official/partner API adapters (drop-in when access exists).
- Multi-tenant + RBAC + audit export.
- Secret manager/vault instead of app-level Fernet.
- Anomaly detection on sales/inventory beyond threshold rules.

## Success metrics

**Leading (visible during the demo)**
- % of P0 acceptance criteria demonstrated live: target 100%.
- Chaos scenarios handled correctly / injected: target all.
- Duplicate rows created on re-run: target 0.

**Lagging (the story we tell)**
- Manual interventions per week: designed to trend down; shown falling in the
  interventions chart after re-auth automation kicks in.
- Reporting-gap minutes avoided: gap window backfilled = minutes recovered.

## Open questions

- **[eng]** SSE vs polling for live dashboard updates — default SSE, fall back
  to polling if it costs time.
- **[eng]** Telegram vs email as the external alert channel for the live re-auth
  demo — pick whichever authenticates fastest on the day.
- **[partner]** Which datasets does Palm Era care about most (orders vs stock)?
  Build all four; sequence UI polish toward their answer if known.
- **[data]** Realistic SKU/warehouse cardinality for seed data so the demo
  looks credible, not toy.

## Timeline / phasing

Follows `TASK.md` phases 0→9. Hard gate: R1–R11 (P0) before any P1. The demo
(R11) is built incrementally from Phase 2 onward, not bolted on at the end.
