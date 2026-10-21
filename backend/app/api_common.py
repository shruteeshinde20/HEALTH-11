"""Shared building blocks for the REST API.

- Pagination: every list endpoint returns {items, total, limit, offset} and
  accepts ?limit= (1-200, default 50) and ?offset=.
- Search: ?q= does a case-insensitive "contains" match; % and _ typed by the
  user are matched literally.
- Lookups are always scoped to the caller's organization and ignore
  soft-deleted rows; anything else is reported as 404 (never 403), so other
  organizations' IDs cannot be probed.
- Validated input types: trimmed non-blank strings and finite numbers.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Generic, TypeVar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, Query, status
from pydantic import AfterValidator, BaseModel, Field, StringConstraints
from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

T = TypeVar("T")

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


# --- Input types ----------------------------------------------------------------

def Name(max_length: int):
    """Required text: surrounding spaces removed, cannot be blank."""
    return Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length)
    ]


def OptionalText(max_length: int):
    """Optional text: surrounding spaces removed; blank becomes null."""
    text = Annotated[
        str,
        StringConstraints(strip_whitespace=True, max_length=max_length),
        AfterValidator(lambda value: value or None),
    ]
    return text | None


FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
NonNegativeFloat = Annotated[float, Field(ge=0, allow_inf_nan=False)]
PositiveFloat = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Id = Annotated[int, Field(gt=0, le=2_147_483_647)]
# A place's width or length in metres (floor-plan drawing).
PlaceSize = Annotated[float, Field(gt=0, le=1000, allow_inf_nan=False)]
SIZE_PAIR = "Give both width and length (metres), or neither"


def _valid_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Use an IANA time zone such as Europe/London") from None
    return value


TimeZoneName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(_valid_timezone),
]


# --- Pagination and search -----------------------------------------------------

class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


@dataclass(frozen=True)
class PageParams:
    limit: int
    offset: int


def page_params(
    limit: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    offset: int = Query(0, ge=0, le=1_000_000),
) -> PageParams:
    return PageParams(limit=limit, offset=offset)


SearchQuery = Annotated[str | None, Query(max_length=100)]


def contains(column, text: str | None):
    """Case-insensitive contains filter with LIKE wildcards escaped."""
    text = (text or "").strip()
    if not text:
        return None
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return column.ilike(f"%{escaped}%", escape="\\")


def paginate(db: Session, stmt: Select, params: PageParams, *order_by) -> dict[str, Any]:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    items = db.scalars(
        stmt.order_by(*order_by).limit(params.limit).offset(params.offset)
    ).all()
    return {"items": list(items), "total": total or 0, "limit": params.limit, "offset": params.offset}


# --- Organization-scoped lookups --------------------------------------------------

def get_active(db: Session, model, item_id: int, organization_id: int, label: str):
    item = db.scalar(
        select(model).where(
            model.id == item_id,
            model.organization_id == organization_id,
            model.deleted_at.is_(None),
        )
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{label} not found")
    return item


def require_reference(db: Session, model, item_id: int | None, organization_id: int, label: str):
    """Like get_active, but for IDs inside a request body: a missing or
    foreign reference is a 422 validation problem, not a missing URL."""
    if item_id is None:
        return None
    item = db.scalar(
        select(model).where(
            model.id == item_id,
            model.organization_id == organization_id,
            model.deleted_at.is_(None),
        )
    )
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{label} {item_id} does not exist in your organization",
        )
    return item


def ensure_none_active(db: Session, model, condition, message: str) -> None:
    """409 if any non-deleted row of `model` matches `condition`."""
    exists = db.scalar(
        select(func.count()).select_from(model).where(condition, model.deleted_at.is_(None))
    )
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


# --- Writes -------------------------------------------------------------------------

def flush_or_conflict(db: Session, message: str) -> None:
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message) from exc


def commit_or_conflict(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message) from exc


def changes_from(payload: BaseModel, not_null: set[str] | None = None) -> dict[str, Any]:
    """Fields the client actually sent in a PATCH body.

    Rejects an empty body and explicit null for fields that cannot be null.
    """
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="No fields supplied")
    nulls = sorted(f for f, v in changes.items() if v is None and f in (not_null or set()))
    if nulls:
        raise HTTPException(status_code=422, detail=f"Fields cannot be null: {', '.join(nulls)}")
    return changes


def soft_delete(item, now: datetime | None = None) -> None:
    item.deleted_at = now or func.now()


class Timestamps(BaseModel):
    created_at: datetime
    updated_at: datetime
