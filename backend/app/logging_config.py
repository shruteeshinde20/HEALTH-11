import logging
import re
import sys

from pythonjsonlogger.json import JsonFormatter

# Tokens may travel in a query string (live simulation streams over WebSocket).
_TOKEN_IN_QUERY = re.compile(r"((?:^|[?&])(?:token|access_token|refresh_token)=)[^&\s\"']+")


def redact_tokens(text: str) -> str:
    return _TOKEN_IN_QUERY.sub(r"\1[hidden]", text)


class RedactTokens(logging.Filter):
    """Keeps tokens out of server logs (for example uvicorn's
    'WebSocket /api/v1/ws/simulations/5?token=...' lines)."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        cleaned = redact_tokens(message)
        if cleaned != message:
            record.msg, record.args = cleaned, ()
        return True


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s"
    ))
    handler.addFilter(RedactTokens())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())
    # uvicorn's own loggers have their own handlers; filter at the logger.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactTokens) for f in logger.filters):
            logger.addFilter(RedactTokens())
