"""GET /audit_log: the organization's audit trail (Administrators only)."""

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_common import Page, PageParams, page_params, paginate
from app.db_session import get_db
from app.models.simulation import AuditLog
from app.permissions import Admin

router = APIRouter(tags=["Audit log"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    actor_user_id: int | None
    action: str
    entity_type: str
    entity_id: int | None
    details: dict[str, Any] | None
    ip_address: str | None


@router.get("/audit_log", response_model=Page[AuditLogOut])
def list_audit_log(
    db: Db,
    admin: Admin,
    paging: Paging,
    action: Annotated[str | None, Query(max_length=100)] = None,
    entity_type: Annotated[str | None, Query(max_length=100)] = None,
    entity_id: Annotated[int | None, Query(gt=0)] = None,
    actor_user_id: Annotated[int | None, Query(gt=0)] = None,
):
    stmt = select(AuditLog).where(
        AuditLog.organization_id == admin.organization_id, AuditLog.deleted_at.is_(None)
    )
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if actor_user_id is not None:
        stmt = stmt.where(AuditLog.actor_user_id == actor_user_id)
    # Newest first.
    return paginate(db, stmt, paging, AuditLog.id.desc())
