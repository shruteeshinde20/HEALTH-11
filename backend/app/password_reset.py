"""'Forgot password?': a code by e-mail, then a new password.

POST /auth/password-reset/request {organization_slug, email}
    Always answers the same (202), whether or not the account exists, so the
    page cannot be used to find out who has an account. For an active account
    a 6-digit code is e-mailed after the answer is sent (no timing hint).
POST /auth/password-reset/confirm {organization_slug, email, code, new_password}
    Sets the new password if the code is right, unexpired, unused and has not
    had too many wrong tries. Then every earlier login of the account ends,
    its failed-login lockout is cleared and the audit log records it.

Only a keyed hash of each code is stored (HMAC-SHA256 with JWT_SECRET_KEY).
Requests are limited per network address and per account. Without SMTP
settings the feature answers 503 and says so.
"""

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app import rate_limit
from app.audit import client_ip, record_audit
from app.auth import _password_hash, check_password_strength, end_other_sessions, normalize_email
from app.config import get_settings
from app.db_session import get_db
from app.models import Organization, PasswordResetCode, User
from app.models.security import RateLimitEvent
from app.services.mailer import MailError, send_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth/password-reset", tags=["Authentication"])

SENT_MESSAGE = ("If an account with this Organization ID and e-mail exists, a code has been sent to "
                "that e-mail. It is valid for {minutes} minutes. Check the spam folder too.")
WRONG_CODE = "The code is wrong, has expired or was tried too many times. Ask for a new code."
NOT_SET_UP = ("Password reset by e-mail is not set up on this server. "
              "Ask your Administrator to set a new password for you.")
DONE_MESSAGE = "Your password has been changed. Log in with the new password."


class ResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    organization_slug: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=320)

    @field_validator("organization_slug")
    @classmethod
    def normalize_slug(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        return normalize_email(value)


class ResetConfirm(ResetRequest):
    code: str = Field(pattern=r"^\s*\d{6}\s*$")
    new_password: str = Field(min_length=1, max_length=200)

    @field_validator("code")
    @classmethod
    def strip_code(cls, value: str) -> str:
        return value.strip()

    @field_validator("new_password")
    @classmethod
    def strong(cls, value: str) -> str:
        return check_password_strength(value)


def code_hash(user_id: int, code: str) -> str:
    key = get_settings().jwt_secret_key.encode("utf-8")
    return hmac.new(key, f"{user_id}:{code}".encode("utf-8"), hashlib.sha256).hexdigest()


def _find_user(db: Session, slug: str, email: str) -> tuple[Organization | None, User | None]:
    organization = db.scalar(select(Organization).where(
        Organization.slug == slug, Organization.deleted_at.is_(None)))
    if organization is None:
        return None, None
    user = db.scalar(select(User).where(
        User.organization_id == organization.id, User.email == email,
        User.deleted_at.is_(None), User.is_active.is_(True)))
    return organization, user


def _email_text(organization_name: str, code: str, minutes: int) -> str:
    return (
        f"Someone asked to reset the HEALTH-11 password for this e-mail address "
        f"in the organization \"{organization_name}\".\n\n"
        f"Your code: {code}\n\n"
        f"It is valid for {minutes} minutes and works once. Enter it on the HEALTH-11 "
        f"\"Forgot password?\" page together with your new password.\n\n"
        f"If you did not ask for this, ignore this e-mail: your password stays the same.\n"
    )


def _deliver(to_address: str, organization_name: str, code: str, minutes: int) -> None:
    try:
        send_email(to_address, "Your HEALTH-11 password reset code",
                   _email_text(organization_name, code, minutes))
    except MailError as exc:
        # Never log the address or the code.
        logger.warning("A password reset e-mail could not be sent: %s", exc)


def _require_email() -> None:
    if not get_settings().email_configured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=NOT_SET_UP)


@router.post("/request", status_code=status.HTTP_202_ACCEPTED)
def request_code(payload: ResetRequest, request: Request, background: BackgroundTasks,
                 db: Session = Depends(get_db)):
    _require_email()
    settings = get_settings()
    window = settings.password_reset_window_seconds
    rate_limit.hit(db, rate_limit.bucket_key("reset:ip", client_ip(request) or "unknown"),
                   settings.password_reset_requests_per_ip, window)
    minutes = settings.password_reset_code_minutes
    answer = {"message": SENT_MESSAGE.format(minutes=minutes)}

    organization, user = _find_user(db, payload.organization_slug, payload.email)
    account_key = rate_limit.bucket_key("reset:account", f"{payload.organization_slug}|{payload.email}")
    if user is None or rate_limit.count_recent(db, account_key, window) >= settings.password_reset_requests_per_account:
        # Same answer either way; nothing is sent.
        db.commit()
        return answer

    rate_limit.record_event(db, account_key)
    now = datetime.now(timezone.utc)
    # A new code ends the older ones.
    db.execute(update(PasswordResetCode).where(
        PasswordResetCode.organization_id == user.organization_id,
        PasswordResetCode.user_id == user.id,
        PasswordResetCode.used_at.is_(None),
    ).values(used_at=func.now()))
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(PasswordResetCode(organization_id=user.organization_id, user_id=user.id,
                             code_hash=code_hash(user.id, code),
                             expires_at=now + timedelta(minutes=minutes)))
    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action="auth.password_reset_requested", entity_type="user", entity_id=user.id,
                 request=request)
    db.commit()
    # Sent after the answer, so the answer takes the same time for unknown accounts.
    background.add_task(_deliver, user.email, organization.name, code, minutes)
    return answer


@router.post("/confirm")
def confirm_code(payload: ResetConfirm, request: Request, db: Session = Depends(get_db)):
    _require_email()
    settings = get_settings()
    rate_limit.hit(db, rate_limit.bucket_key("reset-confirm:ip", client_ip(request) or "unknown"),
                   settings.password_reset_requests_per_ip * settings.password_reset_max_attempts,
                   settings.password_reset_window_seconds)

    _, user = _find_user(db, payload.organization_slug, payload.email)
    row = None
    if user is not None:
        row = db.scalar(select(PasswordResetCode).where(
            PasswordResetCode.organization_id == user.organization_id,
            PasswordResetCode.user_id == user.id,
            PasswordResetCode.used_at.is_(None),
            PasswordResetCode.expires_at > func.now(),
        ).order_by(PasswordResetCode.id.desc()).limit(1).with_for_update())
    if user is None or row is None or row.attempts >= settings.password_reset_max_attempts:
        db.commit()
        raise HTTPException(status_code=400, detail=WRONG_CODE)

    if not hmac.compare_digest(row.code_hash, code_hash(user.id, payload.code)):
        row.attempts += 1
        record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                     action="auth.password_reset_wrong_code", entity_type="user", entity_id=user.id,
                     request=request)
        db.commit()
        raise HTTPException(status_code=400, detail=WRONG_CODE)

    user.password_hash = _password_hash(payload.new_password)
    row.used_at = func.now()
    end_other_sessions(db, user)
    db.execute(delete(RateLimitEvent).where(RateLimitEvent.bucket_key == rate_limit.bucket_key(
        "login:account", f"{payload.organization_slug}|{payload.email}")))
    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action="auth.password_reset_completed", entity_type="user", entity_id=user.id,
                 request=request)
    db.commit()
    return {"message": DONE_MESSAGE}
