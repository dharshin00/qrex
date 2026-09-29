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

- [eng] SSE vs polling — default SSE.
- [eng] Telegram vs email for live re-auth demo — decide on the day.
- [partner] Which datasets Palm Era prioritizes — build all four, polish toward
  their answer.
- [data] Realistic seed cardinality — avoid a toy-looking dashboard.

## Changelog
- _(add dated entries as the build progresses)_
