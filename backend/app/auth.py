from datetime import datetime, timedelta, timezone
import logging
import re
import secrets
import uuid

import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import rate_limit
from app.audit import client_ip, record_audit
from app.config import get_settings
from app.db_session import get_db
from app.models import Organization, RefreshToken, User, UserRole
from app.roles import role_label

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["Authentication"])
security = HTTPBearer(auto_error=False)


def normalize_email(value: str) -> str:
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise ValueError("Enter a valid email address")
    return value


def check_password_strength(value: str) -> str:
    """Password rules shared by sign-up and user management."""
    if len(value) < 12:
        raise ValueError("Password must be at least 12 characters")
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
        return normalize_email(value)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        return check_password_strength(value)


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

    @field_serializer("role")
    def serialize_role(self, role: UserRole) -> str:
        # API contract: "Administrator", "Emergency Commander", "Staff User".
        return role_label(role)


def _password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _password_matches(password: str, stored_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


_dummy_hash: str | None = None


def _burn_password_check(password: str) -> None:
    """Spend the same time as a real check when the account does not exist,
    so response timing does not reveal which emails are registered."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = _password_hash(secrets.token_urlsafe(16))
    _password_matches(password, _dummy_hash)


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
    details: dict | None = None,
) -> None:
    record_audit(
        db,
        organization_id=organization_id,
        actor_user_id=actor_user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        request=request,
        details=details,
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
    return user_from_access_token(db, credentials.credentials)


def user_from_access_token(db: Session, token: str | None) -> User:
    """Validate an access token and return its active user (HTTP and WebSocket)."""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    return _active_user(db, _decode_token(token, "access"))


def issue_stream_token(user: User, run_id: int) -> tuple[str, int]:
    """A short-lived token that only opens the live stream of one simulation run.

    The website hands it to the browser for the WebSocket URL (browsers cannot
    send headers there), so the access token itself never reaches JavaScript
    or server logs. It cannot be used as a Bearer token for the REST API.
    """
    lifetime = get_settings().stream_token_expire_seconds
    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "sub": str(user.id),
            "org_id": user.organization_id,
            "type": "stream",
            "run_id": run_id,
            "jti": str(uuid.uuid4()),
            "iat": now,
            "exp": now + timedelta(seconds=lifetime),
        },
        get_settings().jwt_secret_key,
        algorithm=get_settings().jwt_algorithm,
    )
    return token, lifetime


def user_for_stream(db: Session, token: str | None, run_id: int) -> User:
    """WebSocket authentication: a stream token for this run, or an access token."""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    settings = get_settings()
    try:
        token_type = jwt.decode(
            token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm]
        ).get("type")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from None
    if token_type != "stream":
        return user_from_access_token(db, token)
    claims = _decode_token(token, "stream")
    if claims.get("run_id") != run_id:
        raise HTTPException(status_code=401, detail="This token is for another simulation run")
    return _active_user(db, claims)


def _active_user(db: Session, claims: dict) -> User:
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
    if user.tokens_valid_after is not None:
        valid_after = user.tokens_valid_after
        if valid_after.tzinfo is None:
            valid_after = valid_after.replace(tzinfo=timezone.utc)
        issued = claims.get("iat")
        # iat is in whole seconds; a token from an earlier second predates the change.
        if not isinstance(issued, (int, float)) or issued < int(valid_after.timestamp()):
            raise HTTPException(status_code=401, detail="This session has ended; please sign in again")
    return user


def end_other_sessions(db: Session, user: User) -> None:
    """Refuse every token issued so far and revoke every refresh token of the user
    (used when the password changes). New tokens issued afterwards work."""
    user.tokens_valid_after = datetime.now(timezone.utc)
    db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.organization_id == user.organization_id,
            RefreshToken.user_id == user.id,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=func.now(), revoked_reason="sessions_ended")
    )


@router.post("/register-organization", status_code=201)
def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    settings = get_settings()
    rate_limit.hit(
        db,
        rate_limit.bucket_key("register:ip", client_ip(request) or "unknown"),
        settings.register_max_attempts_per_ip,
        settings.register_window_seconds,
    )

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
    settings = get_settings()
    window = settings.rate_limit_window_seconds

    # 1) Per client IP: every attempt counts (stops password spraying).
    rate_limit.hit(
        db,
        rate_limit.bucket_key("login:ip", client_ip(request) or "unknown"),
        settings.login_max_attempts_per_ip,
        window,
    )

    # 2) Per account: only failures count, so a locked-out attacker cannot
    #    keep guessing one user's password from many IPs.
    account_key = rate_limit.bucket_key(
        "login:account", f"{payload.organization_slug}|{payload.email}"
    )
    rate_limit.ensure_not_limited(
        db, account_key, settings.login_max_failures_per_account, window
    )

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

    if user is None:
        _burn_password_check(payload.password)
        password_ok = False
    else:
        password_ok = _password_matches(payload.password, user.password_hash)

    if not password_ok or not user.is_active:
        reason = "inactive_account" if password_ok else "invalid_credentials"
        rate_limit.record_event(db, account_key)
        if organization is not None:
            _audit(
                db, organization.id, user.id if user else None,
                "auth.login_failed", "user", user.id if user else None,
                request, details={"reason": reason},
            )
        else:
            logger.warning("Login failed for an unknown organization")
        db.commit()
        if password_ok:
            raise HTTPException(status_code=403, detail="User account is inactive")
        raise HTTPException(status_code=401, detail="Invalid organization, email, or password")

    try:
        tokens = _new_token_pair(db, user)
        _audit(db, user.organization_id, user.id, "auth.login",
               "user", user.id, request)
        db.commit()
        return {"user": UserResponse.model_validate(user), **tokens}
    except Exception:
        db.rollback()
        raise


REUSE_GRACE_SECONDS = 30


def _handle_refresh_reuse(db: Session, request: Request, jti: str, user_id: int,
                          organization_id: int, now: datetime) -> None:
    """A refresh token that was already rotated or revoked is presented again.

    Each refresh token works once. If an old one comes back later than a short
    grace period (two tabs renewing at the same moment), it was probably copied:
    every session of the user is ended, so a stolen token stops working for the
    thief too. The user simply signs in again.
    """
    used = db.scalar(
        select(RefreshToken).where(
            RefreshToken.jti == jti,
            RefreshToken.user_id == user_id,
            RefreshToken.organization_id == organization_id,
            # Only a token replaced by a newer one can be "reused"; one ended by
            # logout or a password change is simply refused.
            RefreshToken.revoked_reason == "rotated",
        )
    )
    if used is None or used.revoked_at is None:
        return
    revoked_at = used.revoked_at
    if revoked_at.tzinfo is None:
        revoked_at = revoked_at.replace(tzinfo=timezone.utc)
    if (now - revoked_at).total_seconds() <= REUSE_GRACE_SECONDS:
        return
    user = db.scalar(select(User).where(User.id == user_id, User.organization_id == organization_id))
    if user is None:
        return
    end_other_sessions(db, user)
    _audit(db, organization_id, user_id, "auth.refresh_token_reused", "user", user_id, request)
    db.commit()


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
        _handle_refresh_reuse(db, request, jti, user_id, organization_id, now)
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
    stored.revoked_reason = "rotated"
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
        # Already signed out (for example a second click on Log out): nothing to do.
        return None

    stored.revoked_at = datetime.now(timezone.utc)
    stored.revoked_reason = "logout"
    _audit(db, organization_id, user_id, "auth.logout",
           "user", user_id, request)
    db.commit()
    return None


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)):
    return current_user


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=200)

    @field_validator("full_name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Must contain at least two non-space characters")
        return value


@router.patch("/me", response_model=UserResponse)
def update_me(payload: ProfileUpdate, request: Request, current_user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """Users change their own display name (email and role are managed by Administrators)."""
    current_user.full_name = payload.full_name
    _audit(db, current_user.organization_id, current_user.id, "user.profile_updated", "user",
           current_user.id, request, details={"fields": ["full_name"]})
    db.commit()
    db.refresh(current_user)
    return current_user


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=72)
    new_password: str = Field(min_length=12, max_length=72)

    @field_validator("new_password")
    @classmethod
    def strong(cls, value: str) -> str:
        return check_password_strength(value)


@router.post("/change-password")
def change_password(payload: PasswordChange, request: Request, current_user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """Change your own password. Every other session of this user is signed out
    (its refresh tokens are revoked) and this one gets new tokens. Wrong
    current passwords count towards the same limit as failed logins."""
    settings = get_settings()
    key = rate_limit.bucket_key("password:user", str(current_user.id))
    rate_limit.ensure_not_limited(db, key, settings.login_max_failures_per_account,
                                  settings.rate_limit_window_seconds)
    if not _password_matches(payload.current_password, current_user.password_hash):
        rate_limit.record_event(db, key)
        _audit(db, current_user.organization_id, current_user.id, "auth.password_change_failed",
               "user", current_user.id, request)
        db.commit()
        # 400, not 401: the session itself is fine.
        raise HTTPException(status_code=400, detail="The current password is not correct")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="Choose a new password that is different from the current one")

    current_user.password_hash = _password_hash(payload.new_password)
    end_other_sessions(db, current_user)
    tokens = _new_token_pair(db, current_user)
    # Never log the password; only that it changed.
    _audit(db, current_user.organization_id, current_user.id, "user.password_changed", "user",
           current_user.id, request)
    db.commit()
    return {"user": UserResponse.model_validate(current_user), **tokens}


