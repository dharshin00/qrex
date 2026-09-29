"""Log redaction: session material must never reach logs (NOTE.md do-not-do)."""

from __future__ import annotations

import logging
import re

_PATTERNS = [
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]+", re.I), r"\1<redacted>"),
    (re.compile(r"""(["']?(?:token|otp|encrypted_blob|password)["']?\s*[:=]\s*["']?)[^"',\s}]+""", re.I),
     r"\1<redacted>"),
    (re.compile(r"gAAAAA[A-Za-z0-9_=-]{20,}"), "<fernet-redacted>"),
]


def redact(text: str) -> str:
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = ()
        return True


def install(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    f = RedactingFilter()
    for h in root.handlers:
        if not any(isinstance(x, RedactingFilter) for x in h.filters):
            h.addFilter(f)
    # httpx logs full URLs at INFO; keep it quieter
    logging.getLogger("httpx").setLevel(logging.WARNING)
