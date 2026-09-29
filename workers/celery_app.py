from celery import Celery
from celery.signals import after_setup_logger, after_setup_task_logger

from app.config import get_settings
from app.logging_setup import RedactingFilter

s = get_settings()
celery = Celery("qrex", broker=s.redis_url, include=["workers.tasks"])
celery.conf.update(
    task_acks_late=True,               # tasks are idempotent; redeliver on crash
    worker_prefetch_multiplier=1,
    task_reject_on_worker_lost=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    beat_schedule={
        # per-connector/dataset intervals live in connectors.config_json; the
        # dispatcher reads them every tick, so edits apply without a restart
        "dispatch-due-syncs": {"task": "workers.tasks.dispatch_due", "schedule": 5.0},
        "health-probe": {"task": "workers.tasks.health_probe", "schedule": 30.0},
        "monitor": {"task": "workers.tasks.monitor", "schedule": 30.0},
        "prune": {"task": "workers.tasks.prune", "schedule": 3600.0},
    },
)
app = celery  # `celery -A workers.celery_app`


@after_setup_logger.connect
@after_setup_task_logger.connect
def _redact(logger, *args, **kwargs):
    for h in logger.handlers:
        h.addFilter(RedactingFilter())
