from datetime import datetime
import enum

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    false,
    func,
    text,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, TenantMixin, TimestampMixin


class UserRole(str, enum.Enum):
    ADMINISTRATOR = "administrator"
    EMERGENCY_COMMANDER = "emergency_commander"
    STAFF_USER = "staff_user"


class User(TenantMixin, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_users_org_id"),
        # One active account per email inside an organization. Soft-deleted
        # users do not block the email from being reused.
        Index(
            "uq_users_org_email_active",
            "organization_id",
            func.lower(text("email")),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(
            UserRole,
            name="user_role",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=UserRole.STAFF_USER,
    )
    is_active: Mapped[bool] = mapped_column(default=True, server_default=true(), nullable=False)
    # Tokens issued before this moment are refused (set when the password
    # changes or an Administrator resets it), so other sessions end at once.
    tokens_valid_after: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    organization: Mapped["Organization"] = relationship(back_populates="users")


class RefreshToken(TenantMixin, TimestampMixin, Base):
    __tablename__ = "refresh_tokens"
    __table_args__ = (
        UniqueConstraint("jti", name="uq_refresh_tokens_jti"),
        ForeignKeyConstraint(
            ["organization_id", "user_id"],
            ["users.organization_id", "users.id"],
            name="fk_refresh_tokens_user", ondelete="CASCADE",
        ),
        Index("ix_refresh_tokens_org_user", "organization_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(nullable=False)
    jti: Mapped[str] = mapped_column(String(36), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # rotated (replaced by refresh), logout, sessions_ended (password change) or deactivated.
    revoked_reason: Mapped[str | None] = mapped_column(String(30), nullable=True)
