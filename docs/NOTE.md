# NOTE — Q-REX Decisions, Gotchas & Do-Not-Do

A living log. Claude Code CLI and the team append here whenever a non-obvious
decision is made or a trap is discovered. Newest at the top of each section.

---

## DO NOT DO (hard rules — re-read before every session)

- **Do not invent any real platform's API.** No guessed Blinkit/Instamart
  endpoints, fields, auth schemes, or credentials in code, config, or docs. Real
  HTTP behavior lives only in `mock-platform`. If a real API is unknown, code to
  the connector interface and mark `OfficialApiSource` as `NotAvailable`.
- **Do not automate OTP or bypass authentication.** OTP is always a
  human-in-the-loop step.
- **Do not write to the clean layer from an unvalidated pull.** Quarantine first.
- **Do not create non-idempotent worker tasks.** Every task must be safe to
  re-run and retry.
- **Do not store session material in plaintext or logs.** Encrypt at rest; redact
  in logs.
- **Do not skip the gate** at the end of a TASK phase to "come back later."

## Key decisions (with rationale)

- **Schedule = Redis NX key with TTL = interval** (2026-09-29). Beat runs one
  `dispatch_due` tick every 5s; it `SET qrex:sched:<conn>:<ds> NX EX <interval>`
  and enqueues only if the set succeeded. Intervals are read from
  `connectors.config_json` on every tick, so dashboard edits apply without
  restarting beat. Paused connectors are skipped.
- **Consent-gated ladder** (2026-09-29). A source path is tried only if a
  non-revoked `consents` row exists for it. `OfficialApiSource` always raises
  `NotAvailable` (no real API known — not guessed).
- **Session expiry falls through the ladder** (2026-09-29). If the portal says
  `SessionExpired` but an email-ingest/upload file is waiting, that lower rung is
  used *and* the expiry is still handled (pause + alert + intervention).
- **Connector owns its column contract** (2026-09-29). `workers/connectors/*.py`
  declares the expected headers independently of `seed/catalog.py` (the mock's
  generator), so drift detection compares against a real contract, not the mock.
- **`row_hash` excludes `as_of`** (2026-09-29). Snapshot timestamps move every
  pull; hashing them rewrote every inventory/stock row on each run. Excluded,
  so re-runs change 0 rows and `as_of` reads as "value last changed at".
- **Row-count band only for snapshot datasets** with >=3 successful runs of
  history (inventory, warehouse_stock, sales). `orders` is windowed, so its
  count legitimately varies; partial orders pulls are caught by the source's
  `X-Row-Count` hint and truncated-tail detection instead. This also removes
  the need to seed baseline sync history (no false alarm on run #1).
- **Partial pulls retry, drift does not.** A PARTIAL_PULL from the portal is
  quarantined, alerted, then retried with backoff. Schema drift is not
  transient: the pull is quarantined and the next scheduled run tries again.
- **Recovery auto-resolves alerts.** A successful run resolves open
  PULL_FAILED / SCHEMA_DRIFT / PARTIAL_PULL / STALE_SOURCE for that
  connector+dataset; stock alerts resolve when a warehouse sync no longer
  shows the condition; SESSION_EXPIRED resolves on successful re-auth.
- **Scheduled runs skip when locked; manual/backfill runs wait** (up to 60s).
  Otherwise a manual trigger right after a re-auth backfill silently did nothing.
- **Demo "human" lives only in `scripts/_seller.py`.** The scripted demo and
  seed read the OTP from mock-platform's simulated phone (`/dev/inbox`) — the
  stand-in for a person reading an SMS. No API/worker code imports it.
- **Email channel = Mailpit in compose** (UI :8025), so an external channel
  works on a cold clone with no credentials. Telegram activates if a token is set.
- **Seeded intervention baseline** (`note LIKE 'seed:%'`) gives the
  interventions-per-week chart its "before"; the dashboard says so under the chart.

- **Compliant connector layer instead of token-scraping.** The PS grades on
  reliability + terms compliance; scraping internal APIs loses on both. Same
  downstream pipeline, different front door. (See `IDEATION.md` §3–4.)
- **Mock platform + chaos panel is a first-class deliverable.** We can't (and
  shouldn't) demo on a live seller account; controllable faults prove resilience
  better than a fragile live scrape. Connector interface is identical to a real
  source, so nothing is throwaway.
- **Layered storage (raw/staging/clean).** A bad pull can never corrupt
  analytics; raw gives auditability; staging gives a transform checkpoint.
- **Idempotent upsert on `(platform, external_id, sku)` + `row_hash`.** Kills
  duplicates and makes re-runs cheap — directly answers "prevent duplicate or
  incomplete records."
- **Fernet for session encryption.** Enough to demonstrate encrypted-at-rest
  without vault infra; vault is the noted production upgrade.
- **SSE (not websockets) for dashboard live updates.** Simpler; sufficient for a
  read-mostly dashboard. Revisit only if a feature needs bidirectional.
- **Unified SKU mapping via `sku_map`.** Same product has different IDs per
  platform; brands want one view. High demo value, low cost.

## Gotchas / watch-list

- `chaos/expire_session` without `token=` expires *every* session for the
  platform — including the live system's. Tests pass `token=` so they don't
  pause the running stack.
- SQLAlchemy's batched insert returns `rowcount = -1`; count changed rows via
  `RETURNING id` (skipped ON CONFLICT rows return nothing).
- Postgres session timezone is forced to UTC in the engine; otherwise API
  timestamps came back in the host's local offset.
- Mock-platform keeps sessions in memory: restarting it logs Q-REX out. The
  health probe catches this within 30s (a realistic failure, left as-is).

- Redis lock per `(connector, dataset)` must have a TTL longer than the max run
  time or a crashed run could deadlock the schedule. Set lock TTL > worst-case
  task time and release in `finally`.
- Backfill must reuse the **same idempotent load path** as normal sync — do not
  write a second loader, or you'll reintroduce duplicates.
- Schema-drift check should diff on the *set of columns/keys*, not order; CSV
  column reordering is not drift.
- Expectation "row-count band" needs a warm-up: first few runs have no history —
  seed a baseline so the demo doesn't false-alarm on run #1.
- Chaos `timeout` must actually exceed the client timeout, or the retry path
  won't trigger — tune both together.
- De-dup alerts on `(kind, connector, dataset)` while an alert is open, else the
  feed floods during a failing scenario.
- Freshness SLA "stale" state must survive a `PULL_FAILED` — last-good data stays
  served but clearly marked; don't blank the dashboard on failure.

## Demo-day checklist

- [ ] Fresh clone → `docker compose up` → `scripts/seed` → `scripts/demo` works
      cold.
- [ ] External alert channel authenticated (email or Telegram token valid today).
- [ ] Baseline history seeded so run #1 doesn't false-alarm.
- [ ] Interventions chart has a "before" so the "after" (down) is visible.
- [ ] Have the chaos panel open on a second screen for manual toggles if the
      scripted walk stalls.

## Pitch line (for the jury)

> "The naive answer is to scrape the platform's API with a stolen token — which
> is exactly the fragile, non-compliant workflow Palm Era is trying to escape.
> Q-REX does the opposite: it pulls data only through permitted, consent-logged
> paths, *handles* OTP and session expiry with a one-tap re-auth and automatic
> backfill, and defends itself against schema changes and partial pulls. Here's
> it surviving every one of those failures, live."

## Open items carried from PRD

- [eng] SSE vs polling — **SSE implemented** (`/events`), with 15s polling as fallback.
- [eng] Telegram vs email for live re-auth demo — email via Mailpit works cold; Telegram optional via env.
- [partner] Which datasets Palm Era prioritizes — build all four, polish toward
  their answer.
- [data] Seed cardinality: 24 SKUs × 6 locations × 2 platforms, ~4.4k orders/day/platform, ~1–2 weeks of cover.

## Known gaps

- Docker Compose path written but **not executed in the build environment**
  (no Docker available there). Everything was verified with `scripts/dev.sh`
  (same processes, user-space Postgres 18 + Redis 8). Run the demo-day
  checklist on a Docker host before presenting.
- Great Expectations (P1) not used; the lightweight checks in
  `api/app/services/validation.py` cover the PRD acceptance criteria.
- Retry-exhaustion -> PULL_FAILED is covered by `tests/test_pipeline.py`, not
  by the live demo (keeps the walk under ~3 minutes).
- No auth on the Q-REX API/dashboard (non-goal: RBAC). Don't expose it publicly.

## Changelog
- 2026-09-29 — Phases 0–9 implemented. `scripts/demo` passes all 6 scenarios
  from a cold reset; 12 pytest tests pass; dashboard verified in a headless
  browser incl. the OTP re-auth flow. P1 delivered: days-of-cover per SKU,
  7-day sales history chart, backfill progress indicator.
- 2026-09-29 — Docs moved under `docs/` (README also kept at repo root).
