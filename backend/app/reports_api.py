"""Reports (PROJECT.md API contract): GET /reports/{run_id}?format=pdf|csv
returns a file built only from the stored run.

Readable by every signed-in user of the organization (Staff Users included).
Downloads are rate limited per user and recorded in the audit log.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import rate_limit
from app.api_common import get_active
from app.audit import record_audit
from app.config import get_settings
from app.db_session import get_db
from app.models.facility import Building
from app.models.operations import Scenario
from app.models.simulation import MLModel, SimulationRun
from app.permissions import Reader
from app.services import ml, reports
from app.services.model_parameters import load_parameters

router = APIRouter(tags=["Reports"])

Db = Annotated[Session, Depends(get_db)]

MEDIA_TYPES = {"pdf": "application/pdf", "csv": "text/csv; charset=utf-8"}


def _name(db: Session, model, item_id, organization_id: int) -> str | None:
    # Names as they are now, including items deleted since the run.
    if item_id is None:
        return None
    item = db.scalar(select(model).where(model.id == item_id,
                                         model.organization_id == organization_id))
    return item.name if item else None


def _accuracy(db: Session, organization_id: int):
    record = db.scalar(select(MLModel).where(
        MLModel.organization_id == organization_id, MLModel.model_type == ml.PREDICTOR_TYPE,
        MLModel.deleted_at.is_(None)).order_by(MLModel.id.desc()).limit(1))
    min_runs = int(load_parameters(db, organization_id, ["predictor_min_runs"])
                   ["predictor_min_runs"].value)
    if record is None:
        return reports.model_accuracy_rows(None, None, min_runs)
    return reports.model_accuracy_rows(record.metrics, record.trained_at, min_runs)


@router.get("/reports/{run_id}")
def download_report(
    run_id: int, db: Db, user: Reader, request: Request,
    format: Annotated[Literal["pdf", "csv"], Query()] = "pdf",
):
    org = user.organization_id
    run = get_active(db, SimulationRun, run_id, org, "Simulation run")
    if not run.results:
        raise HTTPException(status_code=409, detail="This simulation run has no results yet")
    settings = get_settings()
    rate_limit.hit(db, rate_limit.bucket_key("report:user", str(user.id)),
                   settings.report_max_requests_per_user, settings.report_window_seconds)

    accuracy_rows, accuracy_note = _accuracy(db, org)
    building_id = (run.params or {}).get("snapshot", {}).get("building_id")
    report = reports.build_report(
        run, scenario_name=_name(db, Scenario, run.scenario_id, org),
        building_name=_name(db, Building, building_id, org),
        accuracy_rows=accuracy_rows, accuracy_note=accuracy_note)
    content = (reports.to_pdf(report, settings.report_font_path) if format == "pdf"
               else reports.to_csv(report))

    record_audit(db, organization_id=org, actor_user_id=user.id, action="report.downloaded",
                 entity_type="simulation_run", entity_id=run.id, request=request,
                 details={"format": format})
    db.commit()
    return Response(content=content, media_type=MEDIA_TYPES[format], headers={
        "Content-Disposition": f'attachment; filename="health11-run-{run.id}.{format}"',
        "Cache-Control": "no-store",
    })
