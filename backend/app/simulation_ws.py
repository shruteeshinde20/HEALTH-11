"""WebSocket /ws/simulations/{run_id}?token=<token>&speed=<x>

Streams a saved simulation run tick by tick (PROJECT.md API contract):
  {t, total, evacuated, positions: [{id, x, y, floor_id, mobility, status}],
   blocked_nodes, congested_edges, exit_load, done, ...counts}
Accepts {"action": "pause"} and {"action": "resume"}; replies with
{"status": "paused" | "running", "t": ...}.

- Authenticated with a token in the query string (browsers cannot set
  headers on WebSockets): preferably a stream token from
  POST /simulations/{run_id}/stream-token (60 seconds, this run only), or an
  access token. Organization-checked: another organization's run is reported
  exactly like a missing one.
- `speed` = simulated seconds per real second (default 10).
- Hazards added with POST /simulations/{run_id}/hazards while streaming are
  picked up within about a second and take effect from the current tick.
- Close codes: 4401 not authenticated, 4404 run not found, 1000 finished.
"""

import asyncio
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_common import get_active
from app.auth import user_for_stream
from app.db_session import get_db
from app.errors import error_body, error_code_for_status
from app.models.simulation import SimulationRun
from app.services import simulation_runner as runner

router = APIRouter(tags=["Simulation"])

POLL_SECONDS = 1.0


@router.websocket("/ws/simulations/{run_id}")
async def stream_simulation(
    websocket: WebSocket,
    run_id: int,
    token: str | None = Query(None, max_length=4096),
    speed: float = Query(10.0, gt=0, le=10_000),
    db: Session = Depends(get_db),
):
    await websocket.accept()

    def load():
        user = user_for_stream(db, token, run_id)
        run = get_active(db, SimulationRun, run_id, user.organization_id, "Simulation run")
        return user, run

    try:
        user, run = await run_in_threadpool(load)
    except HTTPException as exc:
        await websocket.send_json(error_body(error_code_for_status(exc.status_code), exc.detail))
        await websocket.close(code=4401 if exc.status_code == 401 else 4404)
        return

    params = run.params
    injected = list(params.get("injected_hazards", []))
    known = {h["id"] for h in injected}
    simulation = runner.build_simulation(params["snapshot"], injected, run.algorithm, params["values"])
    interval = params["values"]["simulation_tick_seconds"] / speed
    state = {"paused": False}

    def new_hazards():
        fresh = db.scalar(
            select(SimulationRun)
            .where(SimulationRun.id == run_id, SimulationRun.organization_id == user.organization_id)
            .execution_options(populate_existing=True)
        )
        return [h for h in (fresh.params or {}).get("injected_hazards", []) if h["id"] not in known]

    async def receive():
        while True:
            message = await websocket.receive_json()
            action = message.get("action") if isinstance(message, dict) else None
            if action == "pause":
                state["paused"] = True
                await websocket.send_json({"status": "paused", "t": simulation.t})
            elif action == "resume":
                state["paused"] = False
                await websocket.send_json({"status": "running", "t": simulation.t})
            else:
                await websocket.send_json(error_body("VALIDATION_ERROR",
                                                     'Send {"action": "pause"} or {"action": "resume"}'))

    receiver = asyncio.create_task(receive())
    loop = asyncio.get_running_loop()
    last_poll = loop.time()
    try:
        await websocket.send_json(simulation.frame())
        while not simulation.done:
            if receiver.done():
                receiver.result()  # re-raise a disconnect
            if state["paused"]:
                await asyncio.sleep(0.02)
                continue
            if loop.time() - last_poll >= POLL_SECONDS:
                last_poll = loop.time()
                for hazard in await run_in_threadpool(new_hazards):
                    known.add(hazard["id"])
                    start = max(hazard["start_minutes"], simulation.t / 60.0)
                    simulation.add_hazard(SimpleNamespace(**{**hazard, "start_minutes": start}))
            await websocket.send_json(simulation.step())
            await asyncio.sleep(interval)
        await websocket.close(code=1000)
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
