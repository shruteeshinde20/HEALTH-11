"""Set a new password for a HEALTH-11 account, for someone who has forgotten it.

For the person who runs the server: it works directly on the database that
the settings point at (.env, or the environment), so it needs the same access
as the server itself. The website has no "forgot password" e-mail.

    # Show organizations (Organization ID) and their accounts:
    .\\.venv\\Scripts\\python.exe scripts\\reset_password.py --list

    # Set a new password (asked twice, never shown):
    .\\.venv\\Scripts\\python.exe scripts\\reset_password.py --organization noble-hospital --email you@example.com

The new password must follow the usual rules. Every existing login of that
account is ended, its failed-login lockout is cleared, and the change is
written to the organization's audit log. Nothing is ever printed except
organization IDs, names, e-mails and roles.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

REFUSED_DATABASES = {"health11_test", "health11_e2e"}
AUDIT_ACTION = "user.password_reset_by_operator"


class ResetError(Exception):
    """Refused or failed; nothing was changed."""


def list_accounts(db) -> list[dict]:
    """Active organizations with their accounts (no password data)."""
    from sqlalchemy import select

    from app.models import Organization, User
    from app.roles import role_label

    rows = []
    organizations = db.scalars(select(Organization).where(Organization.deleted_at.is_(None))
                               .order_by(Organization.slug)).all()
    for org in organizations:
        users = db.scalars(select(User).where(User.organization_id == org.id, User.deleted_at.is_(None))
                           .order_by(User.email)).all()
        rows.append({
            "organization_id": org.slug, "organization": org.name,
            "users": [{"email": u.email, "role": role_label(u.role),
                       "active": u.is_active} for u in users],
        })
    return rows


def reset_password(db, organization_slug: str, email: str, new_password: str) -> None:
    """Set the password, end every session, clear the login lockout, audit it.
    The caller commits."""
    from sqlalchemy import delete, func, select

    from app import rate_limit
    from app.audit import record_audit
    from app.auth import _password_hash, check_password_strength, end_other_sessions
    from app.models import Organization, User
    from app.models.security import RateLimitEvent

    slug = organization_slug.strip().lower()
    address = email.strip().lower()
    try:
        check_password_strength(new_password)
    except ValueError as exc:
        raise ResetError(str(exc)) from None

    organization = db.scalar(select(Organization).where(Organization.slug == slug,
                                                        Organization.deleted_at.is_(None)))
    if organization is None:
        raise ResetError(f"No organization with the ID {slug!r}. Use --list to see them.")
    user = db.scalar(select(User).where(User.organization_id == organization.id,
                                        func.lower(User.email) == address,
                                        User.deleted_at.is_(None)))
    if user is None:
        raise ResetError(f"No account {address!r} in that organization. Use --list to see them.")

    user.password_hash = _password_hash(new_password)
    end_other_sessions(db, user)
    # The login page counts failed attempts per organization and e-mail.
    db.execute(delete(RateLimitEvent).where(
        RateLimitEvent.bucket_key == rate_limit.bucket_key("login:account", f"{slug}|{address}")))
    record_audit(db, organization_id=organization.id, actor_user_id=None, action=AUDIT_ACTION,
                 entity_type="user", entity_id=user.id,
                 details={"by": "server operator (scripts/reset_password.py)"})
    db.flush()


def _new_password() -> str:
    print("Type the new password (it is not shown while you type).")
    print("At least 12 characters, with a lowercase and an uppercase letter, a digit and a symbol.")
    first = getpass.getpass("New password: ")
    if getpass.getpass("Same password again: ") != first:
        raise ResetError("The two passwords are different.")
    return first


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set a new password for a HEALTH-11 account.")
    parser.add_argument("--list", action="store_true", help="show organizations and accounts")
    parser.add_argument("--organization", help="the Organization ID used on the login page")
    parser.add_argument("--email", help="the account's e-mail address")
    args = parser.parse_args(argv)
    if not args.list and not (args.organization and args.email):
        parser.error("use --list, or give both --organization and --email")

    from sqlalchemy import create_engine, make_url
    from sqlalchemy.orm import Session

    from app.config import get_settings

    url = make_url(get_settings().resolved_database_url)
    print(f"Database: {url.host}:{url.port}/{url.database}")
    if url.database in REFUSED_DATABASES:
        raise ResetError(f"{url.database!r} belongs to the automated tests.")
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with Session(engine) as db:
            if args.list:
                for org in list_accounts(db):
                    print(f"\nOrganization ID: {org['organization_id']}   ({org['organization']})")
                    for user in org["users"]:
                        state = "" if user["active"] else "   [deactivated]"
                        print(f"  {user['email']}   {user['role']}{state}")
                return 0
            password = _new_password()
            reset_password(db, args.organization, args.email, password)
            db.commit()
    finally:
        engine.dispose()
    print("New password saved. Log in with it on the website; earlier logins of this account have ended.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ResetError as error:
        print(f"Nothing changed: {error}", file=sys.stderr)
        sys.exit(1)
