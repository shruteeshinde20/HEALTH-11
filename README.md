# HEALTH-11: Emergency Evac Graph

Hospital evacuation planning (FastAPI + PostgreSQL). The full specification is in
[PROJECT.md](PROJECT.md).

> HEALTH-11 supports planning and training. It does not replace a hospital's
> official emergency procedures or fire-safety professionals.

All commands are for **PowerShell**, run from the project folder
(for example `C:\Users\<you>\HEALTH-11`).

## 1. First-time setup

```powershell
# Python 3.11 virtual environment and pinned packages
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# Create your private settings file, then open it and replace every placeholder
Copy-Item .env.example .env
notepad .env
```

Generate a JWT secret for `JWT_SECRET_KEY` in `.env`:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

## 2. Start PostgreSQL (Docker Desktop must be running)

```powershell
docker compose up -d
docker compose ps        # wait until health11-postgres shows "healthy"
```

Create the separate test database once:

```powershell
docker exec health11-postgres createdb -U health11 health11_test
```

## 3. Apply database migrations

Alembic prints the target database before it changes anything — check it.

```powershell
# Development database (uses POSTGRES_* from .env)
.\.venv\Scripts\alembic.exe upgrade head

# Test database: point DATABASE_URL at it for this command only
$env:DATABASE_URL = "postgresql+psycopg://health11:<your-password>@127.0.0.1:5433/health11_test"
.\.venv\Scripts\alembic.exe upgrade head
Remove-Item Env:DATABASE_URL
```

## 4. Run the API

```powershell
.\.venv\Scripts\uvicorn.exe app.main:app --app-dir backend --reload
```

- Health check: http://127.0.0.1:8000/health
- API docs: http://127.0.0.1:8000/docs (all endpoints are under `/api/v1`)

Behind a reverse proxy in production, start uvicorn with `--proxy-headers`
so rate limits and the audit log see the real client IP.

## 5. Run the tests

Tests only ever use `health11_test`; they refuse to run against any other database.

```powershell
Get-Content .env.test | ForEach-Object {
    if ($_ -match '^\s*TEST_DATABASE_URL\s*=\s*(.*)$') {
        $env:TEST_DATABASE_URL = $matches[1].Trim().Trim('"').Trim("'")
    }
}
if (-not $env:TEST_DATABASE_URL -or -not $env:TEST_DATABASE_URL.EndsWith('/health11_test')) {
    throw 'Refusing to run tests: TEST_DATABASE_URL must point to /health11_test'
}
$env:DATABASE_URL = $env:TEST_DATABASE_URL
.\.venv\Scripts\python.exe -m pytest -v
Remove-Item Env:DATABASE_URL
```

`.env.test` contains a single line (keep it private, it is git-ignored):

```
TEST_DATABASE_URL=postgresql+psycopg://health11:<your-password>@127.0.0.1:5433/health11_test
```

Each test runs inside a transaction that is rolled back, so no test data is kept.
The test database must already be migrated (step 3).

## 6. Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: Python 3.11,
PostgreSQL 16, migrations up → down → up, a model/migration drift check
(`alembic check`) and the full test suite.

## API overview (all under `/api/v1`, header `Authorization: Bearer <token>`)

| Resource | Endpoints |
|---|---|
| Auth | `POST /auth/register-organization`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` |
| Hospitals, buildings, floors | `/hospitals`, `/buildings?hospital_id=`, `/floors?building_id=` |
| Graph | `/nodes?floor_id=&type=`, `/edges?floor_id=&node_id=`, `GET /floors/{id}/graph`, `POST /floors/{id}/route` |
| People | `/patients?node_id=&mobility=`, `/staff?node_id=` |
| Scenarios | `/scenarios` (each scenario contains its `hazards` list) |
| Settings | `/parameters` (name, value, unit, source) |
| Admin | `/users`, `GET /audit_log?action=&entity_type=&entity_id=&actor_user_id=` |
| Floor files | `POST /floors/{id}/import` (CSV, JSON, GeoJSON; max 5 MiB), `GET /floors/{id}/export?format=json\|geojson\|csv` |

Every resource supports `GET` list, `GET /{id}`, `POST`, `PATCH /{id}` and
`DELETE /{id}`. Deleting is a soft delete (the row is hidden and kept for
history). Lists return `{"items": [...], "total", "limit", "offset"}` and accept
`?limit=` (1–200, default 50), `?offset=` and `?q=` (search).

Rules worth knowing:

- Everything is scoped to your organization. Another organization's IDs give
  `404` in the URL and `422` inside a request body.
- Edges are two-way (A–B is the same as B–A). An edge between two floors must
  join two stairs, ramps or lifts in the same building.
- A hospital, building or floor that still has active children cannot be
  deleted (`409`). Deleting a node also deletes its edges, but not while
  patients, staff or hazards are placed on it.
- An organization always keeps at least one active Administrator.

## Routing

`POST /api/v1/floors/{floor_id}/route` with
`{"start": <node id or name>, "destination": <optional>, "mobility": "...", "algorithm": "..."}`.
Without `destination` the route goes to the nearest usable exit. Routes use
the whole building, so they can go down stairs, ramps or lifts; the response
lists `node_names`, `floor_ids` and `distance_metres`.

| Mobility | Cannot use |
|---|---|
| `ambulatory` | blocked nodes or edges only |
| `wheelchair` | stairs; edges not marked `wheelchair_accessible` |
| `stretcher`, `ventilator` | stairs; edges not marked `stretcher_accessible` |

| Algorithm | What it finds |
|---|---|
| `bfs` | the route with the fewest steps (not always the shortest distance) |
| `dfs` | the first route found (no guarantee of being short) |
| `dijkstra` | the shortest distance |
| `astar` | the shortest distance, using node positions to search faster |

## Hazards, bottlenecks and recommendations

- A scenario's hazards spread along the building graph at `spread_rate`
  **metres per minute**. Fire, hazmat and structural hazards block the nodes
  they reach; smoke blocks at or above `smoke_blocking_severity` and otherwise
  adds risk. Nodes about to be reached carry rising risk, which routes avoid.
- During **fire or smoke**, ordinary lifts are not used. Mark protected lifts
  with `is_evacuation_lift: true` (only allowed on nodes of type `lift`).
- Route around hazards: add `"scenario_id"` and `"minutes_elapsed"` to
  `POST /floors/{id}/route`. The response shows the real walking distance and,
  separately, the added `risk_cost_metres`.
- `POST /scenarios/{id}/analysis` with `{"building_id": ..., "minutes_elapsed": 0,
  "algorithm": "astar"}` routes every placed patient and staff member and
  returns hazard state per node, routes, people with no safe route, edge load
  and queue minutes (edge `max_flow` = **people per minute**), betweenness,
  single points of failure, exit load and plain-language recommendations.
  Nothing is saved.

Model numbers are read from `/parameters` when present; otherwise the default
is used and labelled "default (assumed, to be validated)" in every response:

| Parameter | Default | Meaning |
|---|---|---|
| `hazard_risk_horizon_minutes` | 5 | risk rises during this time before a hazard arrives |
| `hazard_risk_cost_metres` | 50 | extra route cost at full risk |
| `smoke_blocking_severity` | 4 | smoke at this severity or higher blocks a node (6 = never) |
| `bottleneck_queue_minutes` | 2 | an edge is a bottleneck when its queue takes this long |
| `exit_imbalance_share` | 0.7 | suggest spreading people when one exit gets more than this share |

These are planning models (not machine learning): they do not model walking
speeds, crowds, doors or ventilation, and they do not replace official
emergency procedures.

## Simulation

| Endpoint | What it does | Who |
|---|---|---|
| `POST /simulate {scenario_id, algorithm, building_id?}` | Runs and saves a simulation, returns `{run_id}`. `building_id` can be left out when the scenario's hazards are in one building. | Administrator, Emergency Commander |
| `GET /simulation_runs`, `GET /simulation_runs/{id}` | Saved runs: summary, timeline, each person's route and outcome, congestion, bottlenecks, recommendations, parameters used | everyone |
| `POST /simulations/{run_id}/hazards {name, type, origin_node_id, spread_rate, severity, at_seconds}` | Adds a hazard that appears mid-run; everyone re-routes and the run is recalculated | Administrator, Emergency Commander |
| `POST /compare {scenario_id, building_id?}` | Same scenario with BFS, DFS, Dijkstra and A*: `[{algorithm, evacuation_time_s, distance_m, risk}]` (not saved) | Administrator, Emergency Commander |
| `GET /dashboard` | `{hospitals, scenarios, last_evacuation_time_s, bottlenecks}` | everyone |
| `WS /api/v1/ws/simulations/{run_id}?token=<access token>&speed=10` | Streams the run tick by tick; send `{"action": "pause"}` / `{"action": "resume"}` | everyone in the organization |

How it works: every patient and staff member placed in the building walks
their route at the speed for their mobility type. Corridors let at most
`max_flow` people per minute in; the rest queue in arrival order. Hazards
spread on the simulation clock and people re-route (or turn back) when their
route becomes unsafe. Outcomes are `evacuated`, `needs_assistance` or
`reached_by_hazard`; only people who reach an exit count as evacuated, and the
dashboard shows an evacuation time only when everyone got out. The same inputs
always give the same result; each run keeps a snapshot so it can be replayed.

| Parameter | Default (assumed, to be validated) |
|---|---|
| `speed_ambulatory_m_per_s` | 1.2 |
| `speed_wheelchair_m_per_s` | 0.8 |
| `speed_stretcher_m_per_s` | 0.5 |
| `speed_ventilator_m_per_s` | 0.4 |
| `simulation_tick_seconds` | 1 |
| `simulation_max_minutes` | 60 |
| `simulation_frame_seconds` | 5 (timeline sampling) |

Set real, sourced values in `/parameters`; every run lists the values and
sources it used. Not modelled: alarm/pre-movement delay, crowd density inside
corridors, slower movement on stairs, staff helping patients.

## AI features

| Feature | Endpoint | What it is | Who |
|---|---|---|---|
| Evacuation-time predictor | `POST /predict {scenario_id, building_id?, algorithm?}` → `{predicted_time_s, method, mae, r2, note, about}` | scikit-learn random-forest regression trained on **your organization's own complete simulation runs** — a fast surrogate for the simulator, not a measurement of real evacuations. Accuracy (MAE, R²) is measured on 25% of runs held out from training and compared with always guessing the average. | Administrator, Emergency Commander |
| Patient priority | `GET /patient_priority?scenario_id=&building_id=` | Rule-based weighted score (not ML): mobility, criticality and walking distance to the hazard, with the full breakdown per patient. | everyone |
| Unusual-run alerts | `GET /alerts` → `{message, alerts: [{run_id, reason, kind}]}` | scikit-learn IsolationForest on evacuation time, highest corridor queue and blocked nodes, plus bottleneck and safety alerts from recent runs. | everyone |

Honesty rules built in:

- The predictor returns `predicted_time_s: null` with a note when there are
  fewer than `predictor_min_runs` (default 30) complete runs, when nobody is
  placed, or when someone has no safe route at the start.
- Only runs where everyone was evacuated are used for training.
- Unusual-run detection needs at least 50 runs and says "More data needed"
  until then (bottleneck and safety alerts still work).
- Trained models are saved per organization under `var/models/` (git-ignored;
  change with `MODEL_DIR` in `.env`) and recorded in the `ml_models` table.

Priority parameters (defaults "assumed, to be validated"): weights
`priority_weight_mobility` 0.4, `priority_weight_criticality` 0.3,
`priority_weight_hazard` 0.3; mobility factors ambulatory 0, wheelchair 0.5,
stretcher 0.8, ventilator 1.0; `priority_hazard_distance_m` 50.

## AI assistant (Anthropic Claude)

| Endpoint | What it does | Who |
|---|---|---|
| `POST /assistant {text, floor_id}` | Turns a plain-language description ("fire in Ward A, spreading fast") into a **draft** scenario `{scenario: {name, description, hazards}}`, or asks a question `{clarification, unknown_names}` | Administrator, Emergency Commander |
| `POST /assistant/summary {run_id}` | Plain-language summary of a saved simulation run, `{summary, source, note, facts}` | everyone |

Safety rules built in:

- The model sees only your text and the place names of the selected floor.
  Every place in its answer is matched against the database (exact, or
  case-insensitive when only one place matches). Anything unknown, ambiguous or
  out of range becomes a question — never a guess.
- A draft is never saved or run. "Run it" uses the normal `POST /scenarios`
  and `POST /simulate` endpoints with their usual checks.
- A summary is written only from the run's stored results. If it contains a
  figure that is not in those results, a standard summary is shown instead
  (`source: "standard"`).
- Your text is not stored; the audit log keeps only its length.
- Limited to `ASSISTANT_MAX_REQUESTS_PER_USER` (default 20) requests per user per
  `ASSISTANT_WINDOW_SECONDS` (default 600).

Setup: put `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in `.env` (never in code or
chat). Without them the endpoints answer `503` with an explanation. Check the
setup with one real (billed) request — the key is never printed:

```powershell
.\.venv\Scripts\python.exe scripts\check_assistant.py
```

## Roles

| Role (API value)      | Access |
|-----------------------|--------|
| `Administrator`       | Everything, including users and the audit log of their own organization |
| `Emergency Commander` | Everything except Admin |
| `Staff User`          | Read-only |

## Error format

Every error response has the same shape:

```json
{"error": {"code": "NOT_FOUND", "message": "Floor not found"}}
```

Validation errors (HTTP 422) also include
`"details": [{"field": "body.email", "message": "..."}]`. Submitted values are
never echoed back. Rate-limited requests return HTTP 429 with a `Retry-After`
header.
