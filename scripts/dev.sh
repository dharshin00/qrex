#!/usr/bin/env bash
# Run the whole Q-REX stack WITHOUT Docker (user-space Postgres + Redis).
#   scripts/dev.sh up | down | status | logs <svc>
# Needs: PostgreSQL server binaries, redis-server, a .venv with requirements-dev.txt,
# node/npm for the dashboard. State lives in ./.local (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
L=$ROOT/.local
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
PY=$ROOT/.venv/bin
export PYTHONPATH=$ROOT:$ROOT/api:$ROOT/mock-platform
mkdir -p "$L"

start() {  # name, command...
  local name=$1; shift
  if [[ -f $L/$name.pid ]] && kill -0 "$(cat "$L/$name.pid")" 2>/dev/null; then
    echo "  $name already running"; return
  fi
  nohup "$@" >"$L/$name.log" 2>&1 &
  echo $! >"$L/$name.pid"
  echo "  $name started (pid $!)"
}

up() {
  if [[ ! -d $L/pg ]]; then
    "$PGBIN/initdb" -D "$L/pg" -U qrex --auth=trust >/dev/null
  fi
  if ! "$PGBIN/pg_ctl" -D "$L/pg" status >/dev/null 2>&1; then
    "$PGBIN/pg_ctl" -D "$L/pg" -o "-p 55432 -k $L -c listen_addresses=127.0.0.1" -l "$L/pg.log" start >/dev/null
    sleep 2
    "$PGBIN/createdb" -h 127.0.0.1 -p 55432 -U qrex qrex 2>/dev/null || true
  fi
  echo "  postgres on :55432"
  redis-cli -p 56379 ping >/dev/null 2>&1 || redis-server --port 56379 --daemonize yes --dir "$L" --logfile "$L/redis.log"
  echo "  redis on :56379"
  start smtp "$PY/python" -m aiosmtpd -n -l 127.0.0.1:1025 -c aiosmtpd.handlers.Debugging stdout
  start mock "$PY/uvicorn" mockp.main:app --port 9000
  (cd api && "$PY/alembic" upgrade head >/dev/null)
  start api "$PY/uvicorn" app.main:app --port 8000
  start worker "$PY/celery" -A workers.celery_app worker -l info -c 4
  start beat "$PY/celery" -A workers.celery_app beat -l info -s "$L/celerybeat-schedule"
  if [[ -d web/node_modules ]]; then
    (cd web && NEXT_PUBLIC_API_URL=http://localhost:8000 start web npm run dev -- -p 3000)
  fi
  echo "dashboard http://localhost:3000 · api http://localhost:8000/docs · mock http://localhost:9000"
}

down() {
  for f in "$L"/*.pid; do
    [[ -f $f ]] || continue
    pkill -P "$(cat "$f")" 2>/dev/null || true
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  redis-cli -p 56379 shutdown nosave >/dev/null 2>&1 || true
  "$PGBIN/pg_ctl" -D "$L/pg" stop >/dev/null 2>&1 || true
  echo "stopped"
}

status() {
  for f in "$L"/*.pid; do
    [[ -f $f ]] || continue
    n=$(basename "$f" .pid)
    kill -0 "$(cat "$f")" 2>/dev/null && echo "  $n: up" || echo "  $n: DOWN"
  done
}

case ${1:-up} in
  up) up ;;
  down) down ;;
  status) status ;;
  logs) tail -f "$L/${2:-api}.log" ;;
  *) echo "usage: $0 up|down|status|logs <svc>"; exit 1 ;;
esac
