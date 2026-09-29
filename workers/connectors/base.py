"""Connector contract + source-path ladder (docs/ARCH.md §4).

Downstream code only ever sees `RawPull`. Which rung of the ladder produced it
is recorded in `RawPull.source_path` and carried through to every clean row.

    OFFICIAL_API  -> PORTAL_EXPORT -> EMAIL_INGEST -> MANUAL_UPLOAD

A rung is only tried if the seller has a logged consent for it. OTP is never
supplied by code: `begin_login` asks the platform to send an OTP to the seller,
and `authenticate` needs the OTP the *human* typed in.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum, IntEnum
from pathlib import Path

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


class Dataset(str, Enum):
    ORDERS = "orders"
    INVENTORY = "inventory"
    WAREHOUSE_STOCK = "warehouse_stock"
    SALES = "sales"


class SourcePath(IntEnum):  # tried in this order
    OFFICIAL_API = 1
    PORTAL_EXPORT = 2
    EMAIL_INGEST = 3
    MANUAL_UPLOAD = 4


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class ConnectorError(Exception):
    pass


class NotAvailable(ConnectorError):
    """This source path cannot serve the request (no API, no consent, no file)."""


class SessionExpired(ConnectorError):
    """Portal session is missing/expired. Needs a human OTP re-auth."""


class TransientError(ConnectorError):
    """Retryable: 5xx, timeout, rate limit."""

    def __init__(self, msg: str, retry_after: float | None = None):
        super().__init__(msg)
        self.retry_after = retry_after


class AuthError(ConnectorError):
    """Login/OTP rejected."""


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------
@dataclass
class Session:
    token: str  # plaintext only in memory; stored Fernet-encrypted (never logged)
    expires_at: datetime

    def __repr__(self) -> str:  # keep secrets out of logs/tracebacks
        return f"Session(token=<redacted>, expires_at={self.expires_at.isoformat()})"


@dataclass
class Window:
    since: datetime | None = None
    until: datetime | None = None


@dataclass
class RawPull:
    dataset: Dataset
    payload: str
    source_path: SourcePath
    fetched_at: datetime
    row_hint: int | None = None  # rows the source *claims* it sent, when known
    skipped: list[str] = field(default_factory=list)  # why higher rungs were skipped
    session_expired: bool = False  # a higher rung failed on session expiry
    _ack: Callable[[], None] | None = field(default=None, repr=False)

    def ack(self) -> None:
        """Call after the raw payload is durably stored (e.g. consume inbox file)."""
        if self._ack:
            self._ack()


@dataclass
class LoginChallenge:
    challenge_id: str
    delivery: str
    expires_in: int


# ---------------------------------------------------------------------------
# Source paths
# ---------------------------------------------------------------------------
class Source:
    path: SourcePath

    def fetch(self, conn: BaseConnector, dataset: Dataset, session: Session | None,
              window: Window) -> RawPull:
        raise NotImplementedError


class OfficialApiSource(Source):
    """Official / partner API.

    No official seller data API is known to us for either platform, so this rung
    deliberately raises NotAvailable. When real access exists, implement it here;
    nothing downstream changes. (We do not guess endpoints — NOTE.md.)
    """

    path = SourcePath.OFFICIAL_API

    def fetch(self, conn, dataset, session, window):
        raise NotAvailable("no official API configured for this platform")


class PortalExportSource(Source):
    """Seller-authorized report export (mock-platform `/export/{dataset}`)."""

    path = SourcePath.PORTAL_EXPORT

    def fetch(self, conn, dataset, session, window):
        if session is None:
            raise SessionExpired("no active session")
        params = {}
        if dataset is Dataset.ORDERS:
            if window.since:
                params["since"] = window.since.isoformat()
            if window.until:
                params["until"] = window.until.isoformat()
        r = conn.http("GET", f"/export/{dataset.value}", params=params,
                      headers={"Authorization": f"Bearer {session.token}"})
        hint = r.headers.get("X-Row-Count")
        return RawPull(dataset, r.text, self.path, datetime.now(UTC),
                       row_hint=int(hint) if hint and hint.isdigit() else None)


class _DropFolderSource(Source):
    """Consume the oldest `<root>/<platform>/<dataset>/*.csv` file."""

    root_attr: str

    def fetch(self, conn, dataset, session, window):
        folder = Path(getattr(get_settings(), self.root_attr)) / conn.platform / dataset.value
        files = sorted(folder.glob("*.csv")) if folder.is_dir() else []
        if not files:
            raise NotAvailable(f"no file in {self.path.name.lower()} folder")
        f = files[0]

        def ack() -> None:
            done = folder / "processed"
            done.mkdir(exist_ok=True)
            shutil.move(str(f), done / f"{datetime.now(UTC):%Y%m%dT%H%M%S}_{f.name}")

        return RawPull(dataset, f.read_text(encoding="utf-8-sig"), self.path,
                       datetime.now(UTC), _ack=ack)


class EmailIngestSource(_DropFolderSource):
    """Scheduled-report emails: attachments land in the ingest drop folder."""

    path = SourcePath.EMAIL_INGEST
    root_attr = "inbox_dir"


class ManualUploadSource(_DropFolderSource):
    """Ops user uploaded a file through the dashboard/API."""

    path = SourcePath.MANUAL_UPLOAD
    root_attr = "upload_dir"


# ---------------------------------------------------------------------------
# Base connector
# ---------------------------------------------------------------------------
class BaseConnector:
    platform: str = ""
    display_name: str = ""
    # canonical field -> column header in this platform's (mock) export format.
    # This is the *contract*; drift is measured against it.
    COLUMNS: dict[str, dict[str, str]] = {}

    sources: tuple[Source, ...] = (
        OfficialApiSource(), PortalExportSource(), EmailIngestSource(), ManualUploadSource(),
    )

    def __init__(self, config: dict | None = None, consented_paths: set[str] | None = None):
        self.config = config or {}
        # None = allow all (tests); normally loaded from `consents`
        self.consented = consented_paths
        self.base_url = get_settings().mock_platform_url.rstrip("/")

    # -- transport --------------------------------------------------------
    def http(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            r = httpx.request(method, self.base_url + path,
                              timeout=get_settings().connector_http_timeout, **kw)
        except httpx.TimeoutException as e:
            raise TransientError(f"timeout calling {path}") from e
        except httpx.TransportError as e:
            raise TransientError(f"transport error calling {path}: {type(e).__name__}") from e
        if r.status_code == 401:
            if r.headers.get("X-Session") == "expired":
                raise SessionExpired("portal session expired")
            raise AuthError(r.text[:200])
        if r.status_code == 429:
            ra = r.headers.get("Retry-After")
            raise TransientError("rate limited", retry_after=float(ra) if ra else None)
        if r.status_code >= 500:
            raise TransientError(f"HTTP {r.status_code} from {path}")
        if r.status_code >= 400:
            raise ConnectorError(f"HTTP {r.status_code} from {path}: {r.text[:200]}")
        return r

    # -- auth (human-in-the-loop) -----------------------------------------
    def begin_login(self) -> LoginChallenge:
        """Ask the portal to send an OTP to the seller. Returns the challenge."""
        r = self.http("POST", "/login", json={"platform": self.platform,
                                              "seller_id": self.config.get("seller_id", "seller")})
        d = r.json()
        return LoginChallenge(d["challenge_id"], d.get("delivery", "sms"), d.get("expires_in", 300))

    def authenticate(self, creds: dict) -> Session:
        """creds = {"challenge_id", "otp"} where otp was typed by the seller."""
        r = self.http("POST", "/otp", json={"challenge_id": creds["challenge_id"],
                                            "otp": creds["otp"]})
        d = r.json()
        return Session(d["token"], datetime.fromisoformat(d["expires_at"]))

    def is_session_valid(self, session: Session | None) -> bool:
        if session is None or session.expires_at <= datetime.now(UTC):
            return False
        r = self.http("GET", "/session", headers={"Authorization": f"Bearer {session.token}"})
        return bool(r.json().get("valid"))

    # -- retrieval ---------------------------------------------------------
    def fetch(self, dataset: Dataset, session: Session | None, window: Window | None = None,
              only: SourcePath | None = None) -> RawPull:
        """Walk the source ladder; return the first rung that succeeds.

        `only` restricts to one rung (e.g. an explicit manual upload).
        """
        window = window or Window()
        skipped: list[str] = []
        errors: list[ConnectorError] = []
        for src in self.sources:
            if only is not None and src.path is not only:
                continue
            name = src.path.name
            if self.consented is not None and name not in self.consented:
                skipped.append(f"{name}: no consent")
                continue
            try:
                pull = src.fetch(self, dataset, session, window)
            except NotAvailable as e:
                skipped.append(f"{name}: {e}")
                continue
            except (SessionExpired, TransientError) as e:
                skipped.append(f"{name}: {type(e).__name__}: {e}")
                errors.append(e)
                continue
            pull.skipped = skipped
            pull.session_expired = any(isinstance(e, SessionExpired) for e in errors)
            log.info("fetch %s/%s via %s", self.platform, dataset.value, name)
            return pull
        for kind in (SessionExpired, TransientError):
            for e in errors:
                if isinstance(e, kind):
                    raise e
        raise NotAvailable("; ".join(skipped) or "no source paths")
