"""AI assistant endpoints (PROJECT.md API contract).

- POST /assistant {text, floor_id} -> {clarification} or {scenario}
    A draft only: nothing is saved or run. To use it, the user presses
    "Run it", which creates the scenario (POST /scenarios) and starts the
    simulation (POST /simulate) through the normal, validated endpoints.
- POST /assistant/summary {run_id} -> {summary, source, note, facts}
    A plain-language summary of a saved run, written only from its stored
    results.

Requests are rate limited per user. The user's text is not stored (only its
length is audited), because it may contain patient information.
"""

import json
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import rate_limit
from app.api_common import Id, get_active, require_reference
from app.audit import record_audit
from app.config import get_settings
from app.db_session import get_db
from app.models.facility import Floor
from app.models.graph import Node
from app.models.simulation import SimulationRun
from app.permissions import Editor, Reader
from app.services import assistant

router = APIRouter(tags=["AI assistant"])
logger = logging.getLogger(__name__)

Db = Annotated[Session, Depends(get_db)]

METHOD_DRAFT = (
    "A large language model (Anthropic Claude, model set in ANTHROPIC_MODEL) reads your text "
    "and the place names of the selected floor only. Every place in its answer is checked "
    "against the database; anything missing or unclear becomes a question instead of a "
    "guess. Nothing is saved or run until you press Run it."
)
METHOD_SUMMARY = (
    "A large language model writes the summary from the stored results of this run only. "
    "If it uses a figure that is not in the stored results, a standard summary is shown instead."
)


class DraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, Field(min_length=3, max_length=assistant.MAX_TEXT_LENGTH)]
    floor_id: Id


class SummaryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: Id


def get_language_model() -> assistant.LanguageModel:
    """The configured model; tests replace this dependency with a stand-in."""
    settings = get_settings()
    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    if not key or not settings.anthropic_model:
        raise HTTPException(
            status_code=503,
            detail="The AI assistant is not configured: set ANTHROPIC_API_KEY and "
                   "ANTHROPIC_MODEL in .env",
        )
    try:
        return assistant.AnthropicModel(key, settings.anthropic_model,
                                        timeout=settings.assistant_timeout_seconds)
    except ImportError as exc:
        raise HTTPException(status_code=503,
                            detail="The anthropic package is not installed") from exc


Model = Annotated[assistant.LanguageModel, Depends(get_language_model)]


def _limit(db: Session, user) -> None:
    settings = get_settings()
    rate_limit.hit(db, rate_limit.bucket_key("assistant:user", str(user.id)),
                   settings.assistant_max_requests_per_user, settings.assistant_window_seconds)


def _call(model: assistant.LanguageModel, **kwargs) -> dict:
    try:
        return model.complete_json(**kwargs)
    except assistant.AssistantError as exc:
        if exc.detail:
            logger.warning("AI service error: %s", exc.detail)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/assistant")
def draft_scenario(payload: DraftRequest, db: Db, user: Editor, model: Model, request: Request):
    floor = require_reference(db, Floor, payload.floor_id, user.organization_id, "Floor")
    nodes = [assistant.FloorNode(id=n.id, name=n.name) for n in db.scalars(
        select(Node).where(Node.organization_id == user.organization_id, Node.floor_id == floor.id,
                           Node.deleted_at.is_(None)).order_by(Node.name))]
    if not nodes:
        raise HTTPException(status_code=422, detail="This floor has no places yet; add nodes first")
    _limit(db, user)

    reply = _call(model, system=assistant.DRAFT_SYSTEM_PROMPT,
                  user_content=assistant.draft_request_content(payload.text, [n.name for n in nodes]),
                  schema=assistant.DRAFT_SCHEMA, max_tokens=1500)
    try:
        result = assistant.interpret_draft(reply, nodes)
    except assistant.AssistantError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action="assistant.draft", entity_type="floor", entity_id=floor.id, request=request,
                 details={"text_length": len(payload.text),
                          "outcome": "scenario" if "scenario" in result else "clarification"})
    db.commit()
    return {**result, "floor_id": floor.id, "method": METHOD_DRAFT,
            "note": "Nothing has been saved or run. Check the draft, then press Run it."
            if "scenario" in result else None}


@router.post("/assistant/summary")
def summarise_run(payload: SummaryRequest, db: Db, user: Reader, model: Model, request: Request):
    run = get_active(db, SimulationRun, payload.run_id, user.organization_id, "Simulation run")
    facts = assistant.summary_facts({**(run.results or {}), "algorithm": run.algorithm})
    _limit(db, user)
    reply = _call(model, system=assistant.SUMMARY_SYSTEM_PROMPT,
                  user_content=json.dumps({"stored_results": facts}, ensure_ascii=False),
                  schema=assistant.SUMMARY_SCHEMA, max_tokens=800)
    try:
        result = assistant.interpret_summary(reply, facts)
    except assistant.AssistantError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action="assistant.summary", entity_type="simulation_run", entity_id=run.id,
                 request=request, details={"source": result["source"]})
    db.commit()
    return {**result, "run_id": run.id, "facts": facts, "method": METHOD_SUMMARY}
