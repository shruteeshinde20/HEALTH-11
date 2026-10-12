"""Server-side permission checks (PROJECT.md, Roles).

- Administrator: everything, including user management and the audit log.
- Emergency Commander: everything except Admin.
- Staff User: read-only.
"""

from typing import Annotated

from fastapi import Depends, HTTPException, status

from app.auth import get_current_user
from app.models.user import User, UserRole
from app.roles import as_role


def require_roles(*allowed: UserRole):
    """Dependency factory: the current user must hold one of `allowed`."""
    allowed_set = frozenset(allowed)

    def dependency(user: User = Depends(get_current_user)) -> User:
        if as_role(user.role) not in allowed_set:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your role does not allow this action",
            )
        return user

    return dependency


# Any signed-in user of the organization (read access).
Reader = Annotated[User, Depends(get_current_user)]

# Administrators and Emergency Commanders may change operational data.
Editor = Annotated[
    User,
    Depends(require_roles(UserRole.ADMINISTRATOR, UserRole.EMERGENCY_COMMANDER)),
]

# Organization administration (users, audit log).
Admin = Annotated[User, Depends(require_roles(UserRole.ADMINISTRATOR))]
