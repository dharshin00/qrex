from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    secret: str = "change-me-dev-secret"
    encryption_key: str = ""

    database_url: str = "postgresql+psycopg://qrex:qrex@localhost:5432/qrex"
    redis_url: str = "redis://localhost:6379/0"
    mock_platform_url: str = "http://localhost:9000"

    public_web_url: str = "http://localhost:3000"
    public_api_url: str = "http://localhost:8000"

    sync_default_interval: int = 60

    # client-side HTTP timeout for connector calls; the mock's chaos `timeout`
    # sleeps longer than this so the retry path actually fires (see NOTE.md).
    connector_http_timeout: float = 4.0

    # retry policy for sync tasks
    sync_max_retries: int = 4
    sync_retry_base: float = 2.0
    sync_retry_cap: float = 30.0

    # Redis lock TTL must exceed worst-case task time (see NOTE.md gotchas)
    sync_lock_ttl: int = 300

    alert_email_enabled: bool = False
    alert_email_host: str = "localhost"
    alert_email_port: int = 1025
    alert_email_user: str = ""
    alert_email_password: str = ""
    alert_email_from: str = "qrex-alerts@localhost"
    alert_email_to: str = "seller@brand.local"
    alert_email_starttls: bool = False

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    inbox_dir: Path = REPO_ROOT / "data" / "inbox"
    upload_dir: Path = REPO_ROOT / "data" / "uploads"


@lru_cache
def get_settings() -> Settings:
    return Settings()
