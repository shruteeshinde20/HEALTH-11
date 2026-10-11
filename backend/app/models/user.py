import enum

from sqlalchemy import Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, TenantMixin, TimestampMixin


class UserRole(str, enum.Enum):
    ADMINISTRATOR = "administrator"
    EMERGENCY_COMMANDER = "emergency_commander"
    STAFF_USER = "staff_user"


class User(TenantMixin, TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role", values_callable=lambda enum_cls: [member.value for member in enum_cls]),
        nullable=False,
        default=UserRole.STAFF_USER,
    )
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

    organization: Mapped["Organization"] = relationship(back_populates="users")
