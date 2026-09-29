# IDEATION — Q-REX

> Autonomous Quick-Commerce Data Retrieval & Reliability Platform
> PS-9 · Company partner: Palm Era

This document explains *what we are building and why*. It is the reasoning
layer above the PRD and ARCH docs. Read it first. When a design decision
later feels arbitrary, the justification is here.

---

## 1. The problem, in one line

Consumer brands sell through Blinkit and Swiggy Instamart but cannot reliably
see their own operational data (orders, inventory, warehouse stock, sales)
because seller-facing APIs are limited or absent, and the browser automation
they fall back on breaks whenever a session expires, an OTP is required, or the
platform changes its pages.

## 2. What the partner is actually asking for

Reading the PS closely, the graded requirement is **reliability and low
maintenance within platform terms of service** — not "get the data by any
means." The words "terms-compliant", "permitted mechanisms", and "comply with
the respective platform's terms of service" appear repeatedly and on purpose.

So the winning solution is not the cleverest scraper. It is the pipeline that
keeps working when things go wrong and never puts the brand's seller account at
risk.

## 3. The tempting-but-wrong approach (and why we reject it)

**Rejected idea:** take a real seller's access token, drive their internal API
with a bot, and harvest everything.

Why we do not do this:

| Problem | Consequence |
|---|---|
| Internal endpoints are undocumented and change without notice | Highest-maintenance option — the exact failure mode the PS wants gone |
| A copied session token expires | Skips the hardest requirement (OTP + session expiry) instead of solving it |
| Bot-like traffic on a real account can get the seller flagged/suspended | No brand will accept losing its sales channel |
| We hold a live credential for a real business | Security and liability we cannot defend to a jury |

This approach loses on compliance *and* on engineering. We reject it.

## 4. Our approach — a compliance-first connector layer

We keep the entire downstream pipeline the naive idea imagined (transform →
store → monitor → alert → dashboard). We replace only the front door.

Every platform is reached through a **connector** that tries data sources in a
fixed order of preference, most-compliant and most-resilient first:

1. **Official / partner API** — if the platform exposes one to sellers or
   brands, always first choice.
2. **Seller-authorized portal report export** — the connector, acting on the
   seller's explicit and logged consent, downloads the same CSV/Excel reports a
   human would from the seller portal, at a human-like cadence.
3. **Scheduled-report email ingestion** — where the portal can email reports,
   the seller forwards them to an ingest mailbox; we parse attachments. No live
   session to maintain — the most resilient path.
4. **Manual upload fallback** — an ops user drops a file in; the pipeline still
   validates, dedupes, transforms, and loads it.

Each stored record carries the **source path** it came from, so the dashboard
is always honest about provenance.

## 5. How we handle OTP and session expiry (honestly)

We do **not** bypass OTP. We make re-authentication a *managed human-in-the-loop
event* that is rare, scheduled, and never silent:

- A health-check probe plus a token-TTL tracker detects expiry *before* it
  breaks a scheduled sync.
- On expiry: pause that connector, mark its data **stale** on the dashboard,
  and alert the seller with a one-tap re-auth link.
- The seller completes OTP; the new session is stored **encrypted**; the
  connector resumes and **backfills the gap** so no records are lost.
- We track *manual interventions per week* as a first-class metric and show it
  trending down.

This answers "without frequent manual intervention" truthfully.

## 6. Why we build a mock platform for the demo

We will not have a production seller account, and we should not demo against a
live one anyway. So we build **`mock-platform`**: a small FastAPI service that
imitates a seller portal — OTP login, expiring sessions, CSV report exports —
plus a **chaos panel** that can, on command:

- rename a column (schema drift)
- return HTTP 500 / time out
- return a truncated/partial file
- expire the session mid-run
- rate-limit the caller

On stage we flip these switches and show the pipeline *catching each failure*:
an expiry alert, drift detection, retry with backoff, a quarantined partial
pull, a clean backfill. This demonstrates "resilient" far more convincingly
than a live scraper that might simply die in front of the jury.

The connector interface is identical whether it points at `mock-platform` or a
real source, so nothing about the demo is throwaway.

## 7. Features that make us stand out

- **Schema-drift detection** on every pull (a platform change becomes an alert,
  not silent corruption).
- **Idempotent upserts** keyed on `(platform, external_id, sku)` — kills
  duplicates, guarantees consistency.
- **Per-source freshness SLA** — dashboard shows "Blinkit synced 12m ago ✅ /
  Instamart stale 3h ⚠️".
- **Unified SKU mapping** across platforms — the same product has different IDs
  on Blinkit vs Instamart; brands care a lot about one view.
- **Per-warehouse / dark-store stock-out & low-stock alerts.**
- **Manual-intervention-per-week** metric, trending down.

## 8. Non-negotiable principles for the build

1. **Never invent a real platform's API, endpoint, field, or credential.** If a
   real API surface is unknown, code against the connector interface and the
   `mock-platform` only. Say "unknown" rather than guess.
2. **Compliance is a feature, not a disclaimer.** Consent is logged; source
   path is stored; nothing bypasses OTP.
3. **Fail loud, degrade safe.** A broken source pauses and alerts; it never
   writes bad data into the clean layer.
4. **Everything scheduled is also runnable on demand**, for the demo.
5. **The demo is a first-class deliverable**, driven by the chaos panel.

## 9. Success criteria (what "done" looks like for the hackathon)

- End-to-end run: auth → retrieve → validate → transform → store → monitor →
  alert → dashboard, against `mock-platform`.
- Each chaos switch produces the correct handled outcome, visible on the
  dashboard.
- Two connectors (Blinkit-mock, Instamart-mock) feeding one unified SKU view.
- A live re-auth flow (simulated OTP) with automatic gap backfill.
- Clean, seeded demo that runs from `docker compose up`.

See `PRD.md` for scoped requirements, `ARCH.md` for the system design,
`TASK.md` for the phased build, and `NOTE.md` for running decisions.
