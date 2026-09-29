"""External alert channels: email (SMTP) and Telegram. Config-driven."""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

import httpx

from app.config import get_settings
from app.models import Alert, Connector

log = logging.getLogger(__name__)


def reauth_link(platform: str) -> str:
    return f"{get_settings().public_web_url}/connectors/{platform}/reauth"


def render(alert: Alert, connector: Connector | None) -> tuple[str, str]:
    who = connector.display_name if connector else "Q-REX"
    subject = f"[Q-REX {alert.severity.upper()}] {alert.kind} · {who}" + (
        f" · {alert.dataset}" if alert.dataset else "")
    lines = [alert.message, ""]
    if alert.kind == "SESSION_EXPIRED" and connector:
        lines += ["Re-authenticate in one tap (you will be asked for the OTP sent to your phone):",
                  reauth_link(connector.platform), ""]
    lines.append(f"Dashboard: {get_settings().public_web_url}/alerts")
    return subject, "\n".join(lines)


def send_email(subject: str, body: str) -> str:
    s = get_settings()
    if not s.alert_email_enabled:
        return "disabled"
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, s.alert_email_from, s.alert_email_to
    msg.set_content(body)
    with smtplib.SMTP(s.alert_email_host, s.alert_email_port, timeout=10) as smtp:
        if s.alert_email_starttls:
            smtp.starttls()
        if s.alert_email_user:
            smtp.login(s.alert_email_user, s.alert_email_password)
        smtp.send_message(msg)
    return "sent"


def send_telegram(subject: str, body: str) -> str:
    s = get_settings()
    if not (s.telegram_bot_token and s.telegram_chat_id):
        return "disabled"
    r = httpx.post(f"https://api.telegram.org/bot{s.telegram_bot_token}/sendMessage",
                   json={"chat_id": s.telegram_chat_id, "text": f"{subject}\n\n{body}",
                         "disable_web_page_preview": True}, timeout=10)
    r.raise_for_status()
    return "sent"


CHANNELS = {"email": send_email, "telegram": send_telegram}


def dispatch(alert: Alert, connector: Connector | None) -> dict[str, str]:
    subject, body = render(alert, connector)
    result = {"dashboard": "sent"}
    for name, fn in CHANNELS.items():
        try:
            result[name] = fn(subject, body)
        except Exception as e:  # noqa: BLE001 - a dead channel must not break others
            log.warning("alert channel %s failed: %s", name, type(e).__name__)
            result[name] = f"error: {type(e).__name__}"
    return result
