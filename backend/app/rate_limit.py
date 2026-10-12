"""PostgreSQL-backed sliding-window rate limiting.

Counting in the database (not in process memory) keeps limits correct when
the API runs with several workers or several servers. A transaction-level
advisory lock per bucket stops parallel requests from slipping past the
limit together.
"""

import hashlib
import math
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.models.security import RateLimitEvent

# Rows older than this are always safe to delete (longest window is 1 hour).
_RETENTION = timedelta(days=1)


def bucket_key(scope: str, identifier: str) -> str:
    return hashlib.sha256(f"{scope}:{identifier}".encode("utf-8")).hexdigest()


def _lock(db: Session, key: str) -> None:
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": key})


def _window_start(db: Session, window_seconds: int) -> datetime:
    now = db.scalar(select(func.now()))
    return now - timedelta(seconds=window_seconds)


def _raise_limited(db: Session, key: str, window_seconds: int, since: datetime) -> None:
    oldest = db.scalar(
        select(func.min(RateLimitEvent.created_at)).where(
            RateLimitEvent.bucket_key == key, RateLimitEvent.created_at > since
        )
    )
    now = db.scalar(select(func.now()))
    retry_after = window_seconds
    if oldest is not None:
        retry_after = max(1, math.ceil((oldest + timedelta(seconds=window_seconds) - now).total_seconds()))
    db.rollback()
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many attempts. Please wait and try again.",
        headers={"Retry-After": str(retry_after)},
    )


def count_recent(db: Session, key: str, window_seconds: int) -> int:
    since = _window_start(db, window_seconds)
    return db.scalar(
        select(func.count()).select_from(RateLimitEvent).where(
            RateLimitEvent.bucket_key == key, RateLimitEvent.created_at > since
        )
    ) or 0


def ensure_not_limited(db: Session, key: str, limit: int, window_seconds: int) -> None:
    """Raise 429 if the bucket already holds `limit` events in the window."""
    _lock(db, key)
    if count_recent(db, key, window_seconds) >= limit:
        _raise_limited(db, key, window_seconds, _window_start(db, window_seconds))


def record_event(db: Session, key: str) -> None:
    """Add one event to the bucket and prune expired rows. Caller commits."""
    _lock(db, key)
    db.add(RateLimitEvent(bucket_key=key))
    db.execute(
        delete(RateLimitEvent).where(
            RateLimitEvent.created_at < func.now() - _RETENTION
        )
    )


def hit(db: Session, key: str, limit: int, window_seconds: int) -> None:
    """Check the limit, then count this attempt and commit it immediately so
    it is kept even if the rest of the request fails."""
    ensure_not_limited(db, key, limit, window_seconds)
    record_event(db, key)
    db.commit()
