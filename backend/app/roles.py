"""Role names exposed by the API.

The database stores stable lowercase identifiers (administrator,
emergency_commander, staff_user). The API contract (PROJECT.md) uses exactly
"Administrator", "Emergency Commander" and "Staff User", so values are
translated at the API boundary only.
"""

from app.models.user import UserRole

ROLE_LABELS: dict[UserRole, str] = {
    UserRole.ADMINISTRATOR: "Administrator",
    UserRole.EMERGENCY_COMMANDER: "Emergency Commander",
    UserRole.STAFF_USER: "Staff User",
}


def as_role(role: UserRole | str) -> UserRole:
    return UserRole(getattr(role, "value", role))


def role_label(role: UserRole | str) -> str:
    return ROLE_LABELS[as_role(role)]
