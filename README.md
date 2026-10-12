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
