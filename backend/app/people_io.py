"""Patients and staff as CSV files: export the list, import a file that becomes the list.

GET  /patients/export, /staff/export   any signed-in user; CSV sorted by code.
POST /patients/import, /staff/import   Administrator or Emergency Commander; the
     body is the CSV file (Content-Type text/csv).
     ?apply=false (default): only checks the file and answers what would change.
     ?apply=true: saves it.

The file is the full list. People in the file are matched by their code
(patient_code / staff_code): new codes are added, changed rows are updated, and
people on the website whose code is not in the file are removed (the same soft
delete as the Delete button). The website shows these counts and asks before it
sends ?apply=true. A file without any person is refused, so a wrong or empty
file can never remove everyone; that is done on the website.

Where someone is: the columns hospital, building, floor_number and place, as
shown in the Facility Manager and Graph Builder (each is unique at its level).
All four empty means "not placed".

Safety
- 1 MiB and 5,000 rows at most; text/csv only.
- The header must have exactly the expected columns (in any order), so a typo
  in a column name is reported instead of being ignored.
- Every row is checked; problems are reported as "row N, column" without
  repeating the submitted values. Nothing is saved if any row has a problem.
- One transaction: all changes are saved, or none.
- Spreadsheet formulas are neutralised on export and restored on import, as in
  the floor CSV (app.floor_io).
"""

import csv
import io
from dataclasses import dataclass
from typing import Annotated, Any

from app.api_common import Name
from app.audit import record_audit
from app.db_session import get_db
from app.errors import error_body
from app.floor_io import _csv_safe, _csv_unescape
from app.models.facility import Building, Floor, Hospital
from app.models.graph import Node
from app.models.operations import Patient, PatientMobility, Staff
from app.models.user import User
from app.permissions import Editor, Reader
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

router = APIRouter(tags=["Patients and Staff"])

Db = Annotated[Session, Depends(get_db)]

MAX_IMPORT_BYTES = 1024 * 1024
MAX_IMPORT_ROWS = 5_000
MAX_REPORTED_PROBLEMS = 50

LOCATION_COLUMNS = ("hospital", "building", "floor_number", "place")
PATIENT_COLUMNS = ("patient_code", "mobility", "criticality", "test_data", *LOCATION_COLUMNS)
STAFF_COLUMNS = ("staff_code", "full_name", "role", "test_data", *LOCATION_COLUMNS)


# --- Row formats ---------------------------------------------------------------------------

def _blank_to_none(value: Any) -> Any:
    return None if isinstance(value, str) and not value.strip() else value


def _yes_no(value: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return False
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "yes", "1"}:
            return True
        if text in {"false", "no", "0"}:
            return False
        raise ValueError("Use true or false")
    return value


def _lower(value: Any) -> Any:
    return value.strip().lower() if isinstance(value, str) else value


TestData = Annotated[bool, BeforeValidator(_yes_no)]
OptionalName = Annotated[str | None, BeforeValidator(_blank_to_none)]
FloorNumber = Annotated[Annotated[int, Field(ge=-20, le=300)] | None, BeforeValidator(_blank_to_none)]


class _Located(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    test_data: TestData = False
    hospital: OptionalName = None
    building: OptionalName = None
    floor_number: FloorNumber = None
    place: OptionalName = None


class PatientRow(_Located):
    patient_code: Name(100)
    mobility: Annotated[PatientMobility, BeforeValidator(_lower)]
    criticality: Annotated[int, BeforeValidator(lambda v: _blank_to_none(v) or 3), Field(ge=1, le=5)] = 3


class StaffRow(_Located):
    staff_code: Name(100)
    full_name: Name(200)
    role: Name(100)


@dataclass(frozen=True)
class Kind:
    model: type
    row: type[_Located]
    columns: tuple[str, ...]
    code: str                      # column and attribute holding the code
    fields: tuple[str, ...]        # attributes compared and saved, besides node_id
    entity: str                    # audit entity type
    filename: str


PATIENTS = Kind(Patient, PatientRow, PATIENT_COLUMNS, "patient_code",
                ("mobility", "criticality", "is_synthetic"), "patient", "patients.csv")
STAFF = Kind(Staff, StaffRow, STAFF_COLUMNS, "staff_code",
             ("full_name", "role", "is_synthetic"), "staff", "staff.csv")


# --- Places by name --------------------------------------------------------------------------

LocationKey = tuple[str, str, int, str]


def _places(db: Session, organization_id: int) -> dict[LocationKey, int]:
    """(hospital, building, floor_number, place) -> node id, for active records only."""
    rows = db.execute(
        select(Hospital.name, Building.name, Floor.floor_number, Node.name, Node.id)
        .join(Building, (Building.hospital_id == Hospital.id) & Building.deleted_at.is_(None))
        .join(Floor, (Floor.building_id == Building.id) & Floor.deleted_at.is_(None))
        .join(Node, (Node.floor_id == Floor.id) & Node.deleted_at.is_(None))
        .where(Hospital.organization_id == organization_id, Hospital.deleted_at.is_(None))
    ).all()
    return {(h, b, f, n): node_id for h, b, f, n, node_id in rows}


# --- Export ----------------------------------------------------------------------------------

def _export(db: Session, user: User, kind: Kind) -> Response:
    where = {node_id: key for key, node_id in _places(db, user.organization_id).items()}
    # Sorted here, not by the database: text sorting in PostgreSQL depends on the
    # server's locale, and the same data should give the same file everywhere.
    people = sorted(
        db.scalars(
            select(kind.model)
            .where(kind.model.organization_id == user.organization_id, kind.model.deleted_at.is_(None))
        ),
        key=lambda person: (getattr(person, kind.code), person.id),
    )

    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(kind.columns)
    for person in people:
        location = where.get(person.node_id, ("", "", "", ""))
        values = {
            kind.code: getattr(person, kind.code),
            "test_data": "true" if person.is_synthetic else "false",
            **dict(zip(LOCATION_COLUMNS, location)),
        }
        if kind is PATIENTS:
            values |= {"mobility": person.mobility.value, "criticality": person.criticality}
        else:
            values |= {"full_name": person.full_name, "role": person.role}
        writer.writerow([_csv_safe(values[column]) for column in kind.columns])

    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{kind.filename}"'},
    )


@router.get("/patients/export")
def export_patients(db: Db, user: Reader):
    return _export(db, user, PATIENTS)


@router.get("/staff/export")
def export_staff(db: Db, user: Reader):
    return _export(db, user, STAFF)


# --- Import ----------------------------------------------------------------------------------

class _FileProblems(Exception):
    def __init__(self, details: list[dict]):
        super().__init__("The file has problems")
        self.details = details


def _problem(row: int | None, column: str | None, message: str) -> dict:
    where = ", ".join(part for part in (f"row {row}" if row else None, column) if part)
    return {"field": where or "file", "message": message}


def _read_rows(content: bytes, kind: Kind, places: dict[LocationKey, int]) -> list[tuple[_Located, int | None]]:
    """The checked rows with their place, or _FileProblems listing every problem found."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise _FileProblems([_problem(None, None, "Save the file as CSV UTF-8")]) from None

    try:
        reader = csv.DictReader(io.StringIO(text, newline=""))
        header = [(name or "").strip() for name in (reader.fieldnames or [])]
        if not any(header):
            raise _FileProblems([_problem(1, None, "The file has no header row")])
        reader.fieldnames = header
        missing = [c for c in kind.columns if c not in header]
        unknown = [c for c in header if c not in kind.columns]
        duplicated = sorted({c for c in header if header.count(c) > 1})
        if missing or unknown or duplicated:
            problems = []
            if missing:
                problems.append(_problem(1, None, "Missing columns: " + ", ".join(missing)))
            if unknown:
                problems.append(_problem(1, None, f"{len(unknown)} column name(s) are not expected; "
                                                  "the columns are " + ", ".join(kind.columns)))
            if duplicated:
                problems.append(_problem(1, None, "Columns appear twice: " + ", ".join(duplicated)))
            raise _FileProblems(problems)

        problems: list[dict] = []
        checked: list[tuple[_Located, int | None]] = []
        first_row_of: dict[str, int] = {}
        for raw in reader:
            row_number = reader.line_num
            if None in raw or any(value is None for value in raw.values()):
                problems.append(_problem(row_number, None, "This row has a different number of cells than the header"))
                continue
            values = {key: _csv_unescape(value) for key, value in raw.items()}
            if not any(value.strip() for value in values.values()):
                continue                                   # empty line (spreadsheets add them)
            if len(checked) + len(problems) >= MAX_IMPORT_ROWS:
                raise _FileProblems([_problem(None, None, f"At most {MAX_IMPORT_ROWS:,} people per file")])
            try:
                row = kind.row.model_validate(values)
            except ValidationError as exc:
                for error in exc.errors():
                    column = str(error["loc"][0]) if error.get("loc") else None
                    problems.append(_problem(row_number, column, error.get("msg", "Invalid value")))
                continue

            code = getattr(row, kind.code)
            if code in first_row_of:
                problems.append(_problem(row_number, kind.code, f"The same code is already in row {first_row_of[code]}"))
                continue
            first_row_of[code] = row_number

            location = (row.hospital, row.building, row.floor_number, row.place)
            if all(part is None for part in location):
                node_id = None
            elif any(part is None for part in location):
                problems.append(_problem(row_number, "place",
                                         "Fill in all of hospital, building, floor_number and place, "
                                         "or leave all four empty (not placed)"))
                continue
            else:
                node_id = places.get(location)            # type: ignore[arg-type]
                if node_id is None:
                    problems.append(_problem(row_number, "place",
                                             "No such place: check hospital, building, floor_number and place "
                                             "against the Facility Manager and Graph Builder"))
                    continue
            checked.append((row, node_id))
    except csv.Error:
        raise _FileProblems([_problem(None, None, "This is not a readable CSV file")]) from None

    if problems:
        raise _FileProblems(problems[:MAX_REPORTED_PROBLEMS])
    if not checked:
        raise _FileProblems([_problem(None, None, "The file has no people. To remove everyone, "
                                                  "delete them on the website")])
    return checked


def _values(kind: Kind, row: _Located, node_id: int | None) -> dict:
    values = {"is_synthetic": row.test_data, "node_id": node_id}
    for field in kind.fields:
        if field != "is_synthetic":
            values[field] = getattr(row, field)
    return values


def _import(db: Session, user: User, request: Request, kind: Kind, content: bytes, apply: bool) -> dict:
    rows = _read_rows(content, kind, _places(db, user.organization_id))
    existing = {
        getattr(person, kind.code): person
        for person in db.scalars(
            select(kind.model).where(kind.model.organization_id == user.organization_id,
                                     kind.model.deleted_at.is_(None))
        )
    }

    added, updated, unchanged = [], [], 0
    for row, node_id in rows:
        values = _values(kind, row, node_id)
        person = existing.get(getattr(row, kind.code))
        if person is None:
            added.append((getattr(row, kind.code), values))
        elif any(getattr(person, field) != value for field, value in values.items()):
            updated.append((person, values))
        else:
            unchanged += 1
    in_file = {getattr(row, kind.code) for row, _ in rows}
    removed = [person for code, person in existing.items() if code not in in_file]

    result = {"applied": False, "rows": len(rows), "added": len(added), "updated": len(updated),
              "removed": len(removed), "unchanged": unchanged}
    if not apply:
        return result

    try:
        for person in removed:
            person.deleted_at = func.now()
        for person, values in updated:
            for field, value in values.items():
                setattr(person, field, value)
        db.flush()   # removals and code-preserving updates first, then the new codes
        for code, values in added:
            db.add(kind.model(organization_id=user.organization_id, **{kind.code: code}, **values))
        db.flush()
        record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                     action=f"{kind.entity}.imported", entity_type=kind.entity, request=request,
                     details={k: result[k] for k in ("added", "updated", "removed", "unchanged")})
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The list changed while importing; check the file again") from exc
    except Exception:
        db.rollback()
        raise
    return {**result, "applied": True}


async def _read_body(request: Request) -> bytes:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "text/csv":
        raise HTTPException(status_code=415, detail="Send the file as text/csv")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_IMPORT_BYTES:
            raise HTTPException(status_code=413, detail="The file is larger than 1 MB")
        chunks.append(chunk)
    return b"".join(chunks)


async def _handle_import(request: Request, db: Session, user: User, kind: Kind, apply: bool):
    content = await _read_body(request)
    try:
        return await run_in_threadpool(_import, db, user, request, kind, content, apply)
    except _FileProblems as problems:
        return JSONResponse(status_code=422, content=error_body(
            "VALIDATION_ERROR", "The file has problems; nothing was saved", problems.details))


Apply = Annotated[bool, Query(description="false: only check the file; true: save it")]


@router.post("/patients/import")
async def import_patients(request: Request, user: Editor, db: Db, apply: Apply = False):
    return await _handle_import(request, db, user, PATIENTS, apply)


@router.post("/staff/import")
async def import_staff(request: Request, user: Editor, db: Db, apply: Apply = False):
    return await _handle_import(request, db, user, STAFF, apply)
