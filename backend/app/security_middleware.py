"""Request size limit and security headers for every API response.

- Request bodies larger than MAX_REQUEST_BYTES are refused with 413 before
  the endpoint runs (checked from Content-Length and while reading, so a
  missing or wrong Content-Length does not get around it). Floor imports
  have their own, smaller limit on top.
- Every response says: do not guess content types, never show this in a
  frame, send no referrer. API answers are never cached unless an endpoint
  says otherwise, and they may not load anything (they are data, not pages).
  The interactive API docs (/docs) keep their own needs.
"""

import json

from starlette.exceptions import HTTPException

from app.errors import error_body

MAX_REQUEST_BYTES = 6 * 1024 * 1024

BASE_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
]
API_CSP = (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'")
NO_STORE = (b"cache-control", b"no-store")


class _TooLarge(HTTPException):
    """Raised while reading the body; an HTTPException, so FastAPI's body
    parsing passes it on and the normal error format (413) is used."""

    def __init__(self):
        super().__init__(status_code=413, detail="The request is too large")


class SecurityMiddleware:
    def __init__(self, app, api_prefix: str, max_bytes: int = MAX_REQUEST_BYTES):
        self.app = app
        self.api_prefix = api_prefix
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        is_data = path.startswith(self.api_prefix) or path == "/health"
        started = False

        async def send_with_headers(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = list(message.get("headers", []))
                names = {name.lower() for name, _ in headers}
                extra = list(BASE_HEADERS)
                if is_data:
                    extra.append(API_CSP)
                    if b"cache-control" not in names:
                        extra.append(NO_STORE)
                headers += [(name, value) for name, value in extra if name not in names]
                message = {**message, "headers": headers}
            await send(message)

        declared = dict(scope.get("headers", [])).get(b"content-length")
        if declared is not None:
            try:
                too_big = int(declared) > self.max_bytes
            except ValueError:
                too_big = False
            if too_big:
                await self._refuse(send_with_headers)
                return

        received = 0

        async def counting_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _TooLarge()
            return message

        try:
            await self.app(scope, counting_receive, send_with_headers)
        except _TooLarge:
            if not started:
                await self._refuse(send_with_headers)

    async def _refuse(self, send):
        body = json.dumps(error_body("PAYLOAD_TOO_LARGE", "The request is too large")).encode()
        await send({"type": "http.response.start", "status": 413, "headers": [
            (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
