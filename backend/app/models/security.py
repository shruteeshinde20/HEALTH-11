from sqlalchemy import Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, TimestampMixin


class RateLimitEvent(TimestampMixin, Base):
    """One counted attempt in a rate-limit bucket.

    Not hospital data, so it has no organization_id. The bucket key is a
    SHA-256 hash, so client IPs and emails are not stored in plain text.
    """

    __tablename__ = "rate_limit_events"
    __table_args__ = (
        Index("ix_rate_limit_events_key_created", "bucket_key", "created_at"),
        Index("ix_rate_limit_events_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    bucket_key: Mapped[str] = mapped_column(String(64), nullable=False)
