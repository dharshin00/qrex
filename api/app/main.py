from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.db.session import engine
from app.logging_setup import install
from app.routers import alerts, connectors, events, metrics, sync
from app.services.events import redis_client

install()

app = FastAPI(
    title="Q-REX API",
    description="Autonomous quick-commerce data retrieval & reliability platform. "
                "All platform traffic goes to mock-platform; see docs/ARCH.md.",
    version="0.1.0",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health", tags=["meta"])
def health() -> dict:
    checks = {}
    try:
        with engine.connect() as c:
            c.execute(text("select 1"))
        checks["db"] = "ok"
    except Exception as e:  # noqa: BLE001
        checks["db"] = f"error: {type(e).__name__}"
    try:
        redis_client().ping()
        checks["redis"] = "ok"
    except Exception as e:  # noqa: BLE001
        checks["redis"] = f"error: {type(e).__name__}"
    ok = all(v == "ok" for v in checks.values())
    return {"status": "ok" if ok else "degraded", "service": "api", **checks}


for r in (connectors.router, sync.router, alerts.router, metrics.router, events.router):
    app.include_router(r)
