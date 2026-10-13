"""User management for Administrators of their own organization.

Rules
- Only Administrators can list, add, change or remove users, and only in
  their own organization.
- Administrators cannot deactivate or delete their own account.
- An organization always keeps at least one active Administrator.
- Deactivating or deleting a user revokes all of their refresh tokens; their
  access tokens stop working immediately (checked on every request).
"""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api_common import (
    Name,
    Page,
    PageParams,
    SearchQuery,
    changes_from,
    commit_or_conflict,
    contains,
    flush_or_conflict,
    get_active,
    page_params,
    paginate,
)
from app.audit import record_audit
from app.auth import _password_hash, check_password_strength, end_other_sessions, normalize_email
from app.db_session import get_db
from app.models.user import RefreshToken, User, UserRole
from app.permissions import Admin
from app.roles import ROLE_LABELS, role_label

router = APIRouter(tags=["Users"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

CONFLICT = "A user with this email already exists in your organization"
RoleName = Literal["Administrator", "Emergency Commander", "Staff User"]
ROLE_BY_LABEL = {label: role for role, label in ROLE_LABELS.items()}


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: Annotated[str, Field(min_length=3, max_length=320)]
    full_name: Name(200)
    role: RoleName
    password: Annotated[str, Field(min_length=12, max_length=72)]

    _email = field_validator("email")(lambda cls, v: normalize_email(v))
    _password = field_validator("password")(lambda cls, v: check_password_strength(v))


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: Name(200) | None = None
    role: RoleName | None = None
    is_active: bool | None = None
    password: Annotated[str, Field(min_length=12, max_length=72)] | None = None

    @field_validator("password")
    @classmethod
    def _strong(cls, value: str | None) -> str | None:
        return None if value is None else check_password_strength(value)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    email: str
    full_name: str
    role: UserRole
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @field_serializer("role")
    def _role(self, role: UserRole) -> str:
        return role_label(role)


def _audit(db, admin, request, action, entity_id, details=None):
    record_audit(
        db, organization_id=admin.organization_id, actor_user_id=admin.id,
        action=action, entity_type="user", entity_id=entity_id,
        request=request, details=details,
    )


def _ensure_another_admin(db: Session, user: User) -> None:
    """409 if `user` is the organization's last active Administrator."""
    if user.role != UserRole.ADMINISTRATOR or not user.is_active:
        return
    # Lock the administrator rows so two parallel requests cannot both
    # remove "the other" administrator.
    admins = db.scalars(
        select(User.id).where(
            User.organization_id == user.organization_id,
            User.role == UserRole.ADMINISTRATOR,
            User.is_active.is_(True),
            User.deleted_at.is_(None),
        ).with_for_update()
    ).all()
    if len(admins) <= 1:
        raise HTTPException(
            status_code=409,
            detail="The organization must keep at least one active Administrator",
        )


def _revoke_refresh_tokens(db: Session, user: User) -> None:
    db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.organization_id == user.organization_id,
            RefreshToken.user_id == user.id,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=func.now(), revoked_reason="deactivated")
    )


@router.get("/users", response_model=Page[UserOut])
def list_users(db: Db, admin: Admin, paging: Paging, q: SearchQuery = None):
    stmt = select(User).where(
        User.organization_id == admin.organization_id, User.deleted_at.is_(None)
    )
    matches = [m for m in (contains(User.email, q), contains(User.full_name, q)) if m is not None]
    if matches:
        stmt = stmt.where(or_(*matches))
    return paginate(db, stmt, paging, User.full_name, User.id)


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Db, admin: Admin):
    return get_active(db, User, user_id, admin.organization_id, "User")


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, db: Db, admin: Admin, request: Request):
    user = User(
        organization_id=admin.organization_id,
        email=payload.email,
        full_name=payload.full_name,
        role=ROLE_BY_LABEL[payload.role],
        password_hash=_password_hash(payload.password),
        is_active=True,
    )
    db.add(user)
    flush_or_conflict(db, CONFLICT)
    _audit(db, admin, request, "user.created", user.id, {"role": payload.role})
    commit_or_conflict(db, CONFLICT)
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, db: Db, admin: Admin, request: Request):
    user = get_active(db, User, user_id, admin.organization_id, "User")
    changes = changes_from(payload, not_null={"full_name", "role", "is_active", "password"})

    new_role = ROLE_BY_LABEL[changes["role"]] if "role" in changes else user.role
    deactivating = changes.get("is_active") is False
    if user.id == admin.id and deactivating:
        raise HTTPException(status_code=409, detail="You cannot deactivate your own account")
    if new_role != UserRole.ADMINISTRATOR or deactivating:
        _ensure_another_admin(db, user)

    if "full_name" in changes:
        user.full_name = changes["full_name"]
    if "role" in changes:
        user.role = new_role
    if "is_active" in changes:
        user.is_active = changes["is_active"]
    if "password" in changes:
        user.password_hash = _password_hash(changes["password"])
    if "password" in changes:
        # Signs the user out everywhere at once: old access tokens stop working too.
        end_other_sessions(db, user)
    elif deactivating:
        _revoke_refresh_tokens(db, user)

    flush_or_conflict(db, CONFLICT)
    # Never log the password itself; only that it was changed.
    _audit(db, admin, request, "user.updated", user.id, {
        "fields": sorted(changes),
        **({"role": changes["role"]} if "role" in changes else {}),
    })
    commit_or_conflict(db, CONFLICT)
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: int, db: Db, admin: Admin, request: Request):
    user = get_active(db, User, user_id, admin.organization_id, "User")
    if user.id == admin.id:
        raise HTTPException(status_code=409, detail="You cannot delete your own account")
    _ensure_another_admin(db, user)
    user.deleted_at = func.now()
    user.is_active = False
    _revoke_refresh_tokens(db, user)
    _audit(db, admin, request, "user.deleted", user.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
