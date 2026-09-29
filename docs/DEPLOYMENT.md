# DEPLOYMENT — Run & reproduce Q-REX anywhere

This guide takes you from a clean machine to a running Q-REX stack with demo
data, and covers servers, day-to-day operations and troubleshooting.

Everything runs in Docker Compose. The whole system (including the "platforms")
is self-contained: Q-REX talks only to its bundled **mock-platform**, never to a
real Blinkit or Swiggy Instamart account.

---

## 1. What gets deployed

| Service | What it is | Host port | Reachable from |
|---|---|---|---|
| `web` | Next.js dashboard | **3000** | browser |
| `api` | FastAPI (REST + live SSE events); runs DB migrations on start | **8000** | browser |
| `mock-platform` | Imitation seller portal: OTP login, CSV exports, **chaos panel** | **9000** | browser |
| `mailpit` | Captures alert emails (web inbox) | **8025** (UI) | browser |
| `worker` | Celery workers: syncs, retries, backfills, alert dispatch | — | internal |
| `beat` | Celery scheduler: sync ticks, health probe, monitoring | — | internal |
| `db` | PostgreSQL 17 (raw / staging / clean layers) | 5432 | this host only |
| `redis` | Broker, locks, schedule keys, live-event pub/sub | 6379 | this host only |

All services use `restart: unless-stopped`, so they come back after a reboot
or a Docker daemon restart. Postgres data lives in the `pgdata` volume;
dropped/uploaded report files live in `./data/`.

## 2. Requirements

- **Docker Engine 24+** with the **Compose v2** plugin (`docker compose version`).
  Docker Desktop on macOS/Windows works too.
- **~4 GB free RAM**, **~3 GB disk** for images.
- **Internet on the first build** (base images, pip and npm packages). After
  that the stack runs fully offline — fonts are self-hosted, no CDNs.
- Free ports: 3000, 8000, 9000, 8025 (plus 5432, 6379, 1025 on localhost).
- `git`. Nothing else — Python and Node run inside the images.

<details>
<summary>Installing Docker on Ubuntu / Debian</summary>

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
# Debian/Kali package name may be `docker-compose` instead of `docker-compose-v2`
sudo usermod -aG docker "$USER"   # then log out and back in (or run: newgrp docker)
docker compose version            # should print v2.x
```
</details>

## 3. Quick start (local machine, ~5 minutes)

```bash
git clone <repo-url> qrex && cd qrex
cp .env.example .env                                   # defaults work as-is locally
docker compose up -d --build                           # build + start all 8 services
docker compose ps                                      # wait until api/db/redis/mock show "healthy"
docker compose exec api python -m scripts.seed         # connectors, consents, SKU map, demo login
docker compose exec api python -m scripts.sync_now     # first pull of all 8 datasets
```

Open:

| URL | |
|---|---|
| http://localhost:3000 | Dashboard |
| http://localhost:8000/docs | API (interactive docs) |
| http://localhost:9000 | Chaos panel — inject faults |
| http://localhost:9000/dev/phone | Simulated seller phone (receives OTPs) |
| http://localhost:8025 | Alert emails (Mailpit) |

From here the scheduler keeps syncing every 60–300 s on its own.

**Optional — 7 days of order history** (fills the Summary KPIs and the Orders chart
straight away; otherwise history builds up over time):

```bash
docker compose exec api python -m scripts.backfill --platform blinkit   --hours 168
docker compose exec api python -m scripts.backfill --platform instamart --hours 168
```

## 4. Verify the deployment

```bash
curl -s localhost:8000/health        # {"status":"ok","db":"ok","redis":"ok",...}
curl -s localhost:9000/health        # {"status":"ok","service":"mock-platform",...}
docker compose exec api python -m scripts.demo
```

`scripts.demo` drives the system end to end and should end with six `PASS`
lines: healthy run, schema drift, transient failure (500 / timeout / 429),
partial pull, session expiry + OTP re-auth + gap backfill, and stock alerts.
It exits non-zero if anything fails, so it doubles as a smoke test.

Useful flags: `--only 2,5` (run selected scenarios), `--gap-seconds 45` (how long
the session stays expired in scenario 5).

## 5. Configuration (`.env`)

Copy `.env.example` to `.env`. Every variable has a working default for a local run.

| Variable | Default | Change it when |
|---|---|---|
| `SECRET` | `change-me-dev-secret` | **Always** outside a laptop demo. |
| `ENCRYPTION_KEY` | dev key | **Always** outside a laptop demo. Encrypts seller sessions at rest. Generate: `docker compose run --rm api python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`. Changing it invalidates stored sessions (just re-authenticate). |
| `PUBLIC_WEB_URL` | `http://localhost:3000` | Deploying on a server — used in alert emails / re-auth links. |
| `PUBLIC_API_URL` | `http://localhost:8000` | Deploying on a server — **baked into the dashboard at build time**. |
| `PUBLIC_MOCK_URL` | `http://localhost:9000` | Deploying on a server — chaos-panel / phone links in the dashboard (build time). |
| `DATABASE_URL`, `REDIS_URL`, `MOCK_PLATFORM_URL` | Compose service names | Only when pointing at external Postgres / Redis. |
| `SYNC_DEFAULT_INTERVAL` | `60` | Fallback interval; per-dataset schedules are edited on the dashboard's **Sources** page. |
| `MOCK_SESSION_TTL_SECONDS` | `43200` (12 h) | Shorten to see natural session expiry. |
| `ALERT_EMAIL_*` | Mailpit | Point at a real SMTP server (set `ALERT_EMAIL_STARTTLS=true`, user, password). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | empty (off) | Set both to also send alerts to Telegram. |

After editing `.env`:

```bash
docker compose up -d                # picks up runtime variables
docker compose up -d --build web    # needed if you changed PUBLIC_API_URL / PUBLIC_MOCK_URL
```

## 6. Deploying on a server / cloud VM

The same Compose file runs on any Linux VM (AWS EC2, GCP, Azure, DigitalOcean, a
spare box). Example for Ubuntu 22.04+ with 2 vCPU / 4 GB RAM:

```bash
# 1. install Docker (section 2), then:
git clone <repo-url> qrex && cd qrex
cp .env.example .env

# 2. set the browser-facing URLs to the server's address, and real secrets
HOST=203.0.113.10        # your server's public IP or DNS name
sed -i "s#^PUBLIC_WEB_URL=.*#PUBLIC_WEB_URL=http://$HOST:3000#;
        s#^PUBLIC_API_URL=.*#PUBLIC_API_URL=http://$HOST:8000#;
        s#^PUBLIC_MOCK_URL=.*#PUBLIC_MOCK_URL=http://$HOST:9000#" .env
sed -i "s#^SECRET=.*#SECRET=$(openssl rand -hex 32)#" .env
docker compose build api
sed -i "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=$(docker compose run --rm --no-deps api python -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')#" .env

# 3. start, seed, verify
docker compose up -d --build
docker compose exec api python -m scripts.seed
docker compose exec api python -m scripts.sync_now
docker compose exec api python -m scripts.demo
```

4. **Open ports 3000, 8000, 9000 and 8025** in the cloud firewall / security group,
   **only to your own IP**. Postgres, Redis and SMTP are bound to `127.0.0.1` in
   `docker-compose.yml` and never exposed.

> **Security:** Q-REX has no login (multi-tenant auth/RBAC is out of scope — see
> PRD non-goals), and the chaos panel can break syncs on purpose. Don't leave it
> open to the internet. Prefer one of:
> - **SSH tunnel** (nothing opened publicly):
>   `ssh -L 3000:localhost:3000 -L 8000:localhost:8000 -L 9000:localhost:9000 -L 8025:localhost:8025 user@$HOST`
>   and keep the `PUBLIC_*_URL`s as `localhost`.
> - **Reverse proxy with auth** (Caddy / nginx + basic auth + HTTPS) in front of
>   ports 3000, 8000 and 9000. If you proxy under a domain, set the `PUBLIC_*_URL`s
>   to the proxied `https://` URLs and rebuild `web`. The API's `/events`
>   endpoint is server-sent events — disable proxy buffering for it.

## 7. Operating it

```bash
docker compose ps                         # status + health
docker compose logs -f worker             # follow a service (api, worker, beat, mock-platform, web)
docker compose restart worker             # restart one service
docker compose stop                       # stop everything (data kept)
docker compose start                      # start again
docker compose down                       # remove containers (data kept in the pgdata volume)
docker compose down -v                    # remove containers AND the database volume
```

**After mock-platform restarts** (host reboot, `docker compose restart`, rebuild),
both connectors show **paused** within ~30 s. That's by design: the mock keeps
seller sessions in memory, so a restart is a real "session expired" event that
Q-REX detects and alerts on. Re-authenticate either way:

- Dashboard → **Sources** → *Re-authenticate* → *Send code* → type the OTP shown
  at http://localhost:9000/dev/phone. Q-REX resumes and backfills the gap.
- Or scripted (the demo's simulated seller): `docker compose exec api python -m scripts.reauth`

**Update to a new version**

```bash
git pull
docker compose up -d --build              # migrations run automatically on api start
docker compose exec api python -m scripts.reauth   # the mock restarted, so re-auth
```

**Reset to a clean demo state** (wipes all Q-REX data, keeps the schema):

```bash
docker compose exec api python -m scripts.reset --yes
docker compose exec api python -m scripts.seed --no-migrate
docker compose exec api python -m scripts.sync_now
```

**Back up / restore the database**

```bash
docker compose exec -T db pg_dump -U qrex qrex > qrex-backup.sql
cat qrex-backup.sql | docker compose exec -T db psql -U qrex qrex    # into an empty/reset DB
```

**Other scripts** (all run as `docker compose exec api python -m scripts.<name>`)

| Script | Does |
|---|---|
| `seed` | Migrations, connectors, consents, SKU map, intervention baseline, simulated first login. Idempotent. `--no-login` leaves connectors for you to re-auth in the UI. |
| `sync_now` | Pull every dataset now (`--queue` to hand it to the workers, `--platform X` for one). |
| `backfill --platform X --hours N` | Re-pull a window through the normal idempotent path. |
| `reauth` | Simulated-seller OTP re-auth for paused connectors (`--all`, `--platform X`). |
| `demo` | Scripted chaos walk; six PASS/FAIL checks. |
| `reset --yes` | Truncate all data and clear chaos. |

## 8. Moving it to a machine without internet

Build once where there is internet, then carry the images:

```bash
docker compose build
docker save qrex-api qrex-worker qrex-beat qrex-mock-platform qrex-web \
  postgres:17-alpine redis:7-alpine axllent/mailpit:latest | gzip > qrex-images.tar.gz
# copy qrex-images.tar.gz + the repo to the target, then:
gunzip -c qrex-images.tar.gz | docker load
docker compose up -d            # no --build
```

(Image names use the Compose project name, which is the repo folder name — keep
the folder called `qrex`, or pass `-p qrex`.)

## 9. Running without Docker (development)

`scripts/dev.sh` runs the same processes locally with user-space Postgres and Redis
(no root). It needs PostgreSQL server binaries, `redis-server`, Python 3.13 and Node 22.

```bash
uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -r requirements-dev.txt
(cd web && npm install)
cp .env.example .env
# point infra at the dev.sh ports:
sed -i 's#@db:5432#@127.0.0.1:55432#; s#redis://redis:6379#redis://127.0.0.1:56379#;
        s#http://mock-platform:9000#http://127.0.0.1:9000#; s#ALERT_EMAIL_HOST=mailpit#ALERT_EMAIL_HOST=127.0.0.1#' .env
sed -i "s#/code/data#$PWD/data#" .env
scripts/dev.sh up                         # postgres, redis, smtp sink, mock, api, worker, beat, web
export PYTHONPATH=$PWD:$PWD/api
.venv/bin/python -m scripts.seed && .venv/bin/python -m scripts.demo
scripts/dev.sh down
```

Compose and `dev.sh` use the same host ports (3000/8000/9000) — run one or the other.

## 10. Running the tests

The tests are integration tests: they need the stack running and seeded. From
the host, against Compose:

```bash
uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -r requirements-dev.txt
DATABASE_URL=postgresql+psycopg://qrex:qrex@127.0.0.1:5432/qrex \
REDIS_URL=redis://127.0.0.1:6379/0 MOCK_PLATFORM_URL=http://127.0.0.1:9000 \
INBOX_DIR=$PWD/data/inbox UPLOAD_DIR=$PWD/data/uploads \
.venv/bin/pytest -q
```

## 11. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `permission denied … /var/run/docker.sock` | Your user isn't in the `docker` group yet → `sudo usermod -aG docker $USER`, then log out/in (or `newgrp docker`). |
| `bind: address already in use` on 3000/8000/9000/5432/6379 | Something else holds the port (often a local Postgres/Redis, or `scripts/dev.sh`) → stop it, or change the left-hand port in `docker-compose.yml`. |
| Dashboard loads but shows *"Can't reach the Q-REX API"* | The browser can't reach `PUBLIC_API_URL` as baked into the build → fix it in `.env`, `docker compose up -d --build web`, open port 8000 (or tunnel it). |
| Connectors show **paused**, `SESSION_EXPIRED` alerts | mock-platform restarted (sessions are in memory) → re-authenticate (section 7). Expected behaviour. |
| Every sync fails with `ConnectError` | `mock-platform` isn't running → `docker compose ps`, `docker compose up -d`. |
| `scripts.seed` fails on the OTP step | mock-platform not healthy yet → wait for `docker compose ps` to show it healthy, re-run (seed is idempotent). |
| Summary KPIs show 0 for earlier days | Only ~24 h of orders pulled so far → run the 7-day backfill (section 3). |
| No alert emails in Mailpit | Check `ALERT_EMAIL_ENABLED=true` and `ALERT_EMAIL_HOST=mailpit` in `.env`; `docker compose logs worker \| grep dispatch_alert`. |
| `web` build fails at `npm ci` | No internet during build, or an old lockfile → build with network access; see section 8 for offline installs. |
| Need a completely fresh start | `docker compose down -v && docker compose up -d --build`, then seed again. |
