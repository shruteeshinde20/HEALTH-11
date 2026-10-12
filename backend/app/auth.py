from datetime import datetime, timedelta, timezone
import re
import secrets
import uuid

import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db_session import get_db
from app.models import AuditLog, Organization, RefreshToken, User, UserRole

router = APIRouter(prefix="/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)


class RegisterRequest(BaseModel):
    organization_name: str = Field(min_length=2, max_length=200)
    full_name: str = Field(min_length=2, max_length=200)
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=12, max_length=72)

    @field_validator("organization_name", "full_name")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Must contain at least two non-space characters")
        return value

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Enter a valid email address")
        return value

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        if not any(c.islower() for c in value):
            raise ValueError("Password must contain a lowercase letter")
        if not any(c.isupper() for c in value):
            raise ValueError("Password must contain an uppercase letter")
        if not any(c.isdigit() for c in value):
            raise ValueError("Password must contain a digit")
        if not any(not c.isalnum() for c in value):
            raise ValueError("Password must contain a special character")
        return value


class LoginRequest(BaseModel):
    organization_slug: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=72)

    @field_validator("organization_slug", "email")
    @classmethod
    def normalize_login_fields(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=4096)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    email: str
    full_name: str
    role: UserRole
    is_active: bool


def _password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _password_matches(password: str, stored_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def _issue_token(user: User, token_type: str, lifetime: timedelta, jti: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": str(user.id),
            "org_id": user.organization_id,
            "role": user.role.value,
            "type": token_type,
            "jti": jti,
            "iat": now,
            "exp": now + lifetime,
        },
        get_settings().jwt_secret_key,
        algorithm=get_settings().jwt_algorithm,
    )


def _audit(
    db: Session,
    organization_id: int,
    actor_user_id: int | None,
    action: str,
    entity_type: str,
    entity_id: int | None,
    request: Request,
) -> None:
    db.add(
        AuditLog(
            organization_id=organization_id,
            actor_user_id=actor_user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=None,
            ip_address=request.client.host if request.client else None,
        )
    )


def _new_token_pair(db: Session, user: User) -> dict:
    settings = get_settings()
    refresh_jti = str(uuid.uuid4())
    refresh_lifetime = timedelta(days=settings.refresh_token_expire_days)
    refresh_expiry = datetime.now(timezone.utc) + refresh_lifetime

    access_token = _issue_token(
        user, "access", timedelta(minutes=settings.access_token_expire_minutes),
        str(uuid.uuid4()),
    )
    refresh_token = _issue_token(user, "refresh", refresh_lifetime, refresh_jti)

    db.add(
        RefreshToken(
            organization_id=user.organization_id,
            user_id=user.id,
            jti=refresh_jti,
            expires_at=refresh_expiry,
        )
    )
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_minutes * 60,
    }


def _decode_token(token: str, expected_type: str) -> dict:
    settings = get_settings()
    try:
        claims = jwt.decode(
            token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm]
        )
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from None

    if claims.get("type") != expected_type:
        raise HTTPException(status_code=401, detail="Invalid token type")
    if not claims.get("sub") or not claims.get("org_id") or not claims.get("jti"):
        raise HTTPException(status_code=401, detail="Invalid token claims")
    return claims


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authentication required")

    claims = _decode_token(credentials.credentials, "access")
    try:
        user_id = int(claims["sub"])
        organization_id = int(claims["org_id"])
    except (ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid token claims") from None

    user = db.scalar(
        select(User).where(
            User.id == user_id,
            User.organization_id == organization_id,
            User.is_active.is_(True),
            User.deleted_at.is_(None),
        )
    )
    if user is None:
        raise HTTPException(status_code=401, detail="User is unavailable")
    return user


@router.post("/register-organization", status_code=201)
def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    slug_base = re.sub(r"[^a-z0-9]+", "-", payload.organization_name.lower()).strip("-")
    slug = slug_base[:80].strip("-")
    if not slug:
        raise HTTPException(status_code=422, detail="Organization name needs letters or numbers")

    if db.scalar(select(Organization.id).where(Organization.slug == slug)):
        slug = f"{slug[:70]}-{secrets.token_hex(4)}"

    organization = Organization(name=payload.organization_name, slug=slug)
    try:
        db.add(organization)
        db.flush()

        user = User(
            organization_id=organization.id,
            email=payload.email,
            password_hash=_password_hash(payload.password),
            full_name=payload.full_name,
            role=UserRole.ADMINISTRATOR,
            is_active=True,
        )
        db.add(user)
        db.flush()


        _audit(db, organization.id, user.id, "organization.registered",
               "organization", organization.id, request)
        tokens = _new_token_pair(db, user)
        db.commit()
        return {
            "organization": {"id": organization.id, "name": organization.name, "slug": organization.slug},
            "user": UserResponse.model_validate(user),
            **tokens,
        }
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Organization or user conflicts with existing data") from None


@router.post("/login")
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    organization = db.scalar(
        select(Organization).where(
            Organization.slug == payload.organization_slug,
            Organization.deleted_at.is_(None),
        )
    )
    user = None
    if organization is not None:
        user = db.scalar(
            select(User).where(
                User.organization_id == organization.id,
                User.email == payload.email,
                User.deleted_at.is_(None),
            )
        )

    if user is None or not _password_matches(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid organization, email, or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User account is inactive")

    try:
        tokens = _new_token_pair(db, user)
        _audit(db, user.organization_id, user.id, "auth.login",
               "user", user.id, request)
        db.commit()
        return {"user": UserResponse.model_validate(user), **tokens}
    except Exception:
        db.rollback()
        raise


@router.post("/refresh")
def refresh(payload: RefreshRequest, request: Request, db: Session = Depends(get_db)):
    claims = _decode_token(payload.refresh_token, "refresh")
    try:
        user_id = int(claims["sub"])
        organization_id = int(claims["org_id"])
        jti = str(uuid.UUID(claims["jti"]))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=401, detail="Invalid refresh token") from None

    stored = db.scalar(
        select(RefreshToken).where(
            RefreshToken.jti == jti,
            RefreshToken.user_id == user_id,
            RefreshToken.organization_id == organization_id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.deleted_at.is_(None),
        ).with_for_update()
    )
    now = datetime.now(timezone.utc)
    if stored is None:
        raise HTTPException(status_code=401, detail="Refresh token has been revoked or used")
    expires_at = stored.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        raise HTTPException(status_code=401, detail="Refresh token has expired")

    user = db.scalar(
        select(User).where(
            User.id == user_id,
            User.organization_id == organization_id,
            User.is_active.is_(True),
            User.deleted_at.is_(None),
        )
    )
    if user is None:
        raise HTTPException(status_code=401, detail="User is unavailable")

    stored.revoked_at = now
    tokens = _new_token_pair(db, user)
    _audit(db, organization_id, user.id, "auth.refresh",
           "user", user.id, request)
    db.commit()
    return {"user": UserResponse.model_validate(user), **tokens}


@router.post("/logout", status_code=204)
def logout(payload: RefreshRequest, request: Request, db: Session = Depends(get_db)):
    claims = _decode_token(payload.refresh_token, "refresh")
    try:
        jti = str(uuid.UUID(claims["jti"]))
        user_id = int(claims["sub"])
        organization_id = int(claims["org_id"])
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=401, detail="Invalid refresh token") from None

    stored = db.scalar(
        select(RefreshToken).where(
            RefreshToken.jti == jti,
            RefreshToken.user_id == user_id,
            RefreshToken.organization_id == organization_id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.deleted_at.is_(None),
        ).with_for_update()
    )
    if stored is None:
        raise HTTPException(status_code=401, detail="Refresh token has already been revoked or used")

    stored.revoked_at = datetime.now(timezone.utc)
    _audit(db, organization_id, user_id, "auth.logout",
           "user", user_id, request)
    db.commit()
    return None


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)):
    return current_user


