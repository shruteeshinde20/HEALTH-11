"""Audit log helper: every create, update, delete, login and failed login.

Rows are added to the caller's session so they commit (or roll back)
together with the change they describe. Never put passwords, tokens or
other secrets in `details`.
"""

from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models import AuditLog


def client_ip(request: Request | None) -> str | None:
    if request is None or request.client is None:
        return None
    return request.client.host[:45]


def record_audit(
    db: Session,
    *,
    organization_id: int,
    actor_user_id: int | None,
    action: str,
    entity_type: str,
    entity_id: int | None = None,
    request: Request | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditLog(
            organization_id=organization_id,
            actor_user_id=actor_user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
            ip_address=client_ip(request),
        )
    )
