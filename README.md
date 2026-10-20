# HEALTH-11: Emergency Evac Graph

Hospital evacuation planning. A hospital describes its buildings as a map of
places and paths, adds patients and staff, and creates emergency scenarios
(fire, smoke, hazmat, structural). HEALTH-11 finds routes that respect each
patient's mobility, simulates the evacuation step by step, finds bottlenecks,
compares routing methods and writes PDF and CSV reports. Many hospitals can
use one installation; each sees only its own data.

Built with FastAPI, PostgreSQL, Next.js and Docker. The full specification is
in [PROJECT.md](PROJECT.md).

| Read this | For |
|---|---|
| [User guide](docs/user-guide.md) | What every page does, roles, the AI features, and a 10-minute demo |
| [Architecture](docs/architecture.md) | How the parts fit together, the code map, the rules every part follows |
| [Security review](docs/security-review.md) | Security measures, the accepted risk and open items |
| This README | Setup, running, tests, production, backups, demo data and the API |

Licence: [MIT](LICENSE). Free to use, change and share; it comes without any warranty.

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
so rate limits and the audit log see the real client IP. The production setup
in section 9 does this for you.

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

## 6. Run the website (frontend)

The website is in `frontend/` (Next.js 16, TypeScript, Tailwind). It needs
Node.js 22.18 or newer and the API running (step 4).

```powershell
cd frontend
Copy-Item .env.example .env.local     # first time only; BACKEND_URL points at the API
npm install                           # first time and after dependency changes
npm run dev                           # http://localhost:3000
```

Checks (run from `frontend/`): `npm test` (unit tests), `npm run lint`,
`npm run typecheck`, `npm run build`.

Use a Node.js **LTS** release (22 or 24); Node.js recommends only LTS lines for
production. `npm audit --omit=dev` checks the packages the website ships.
`npm audit` also reports GHSA-vfj7-8cjw-p6xm in `braces`, which reaches the
project only through the lint tooling (`eslint-config-next`), has no fixed
version yet, and is not part of the website; `npm audit fix --force` would
downgrade the lint config to an incompatible version, so do not run it.

How sessions work: the browser only talks to the website. The website's own
server logs in at the API and keeps the tokens in httpOnly, SameSite=Strict
cookies that page scripts cannot read (`__Host-` cookies over HTTPS in
production); it renews them automatically. Requests that change data must come
from the website's own pages. In production, put a reverse proxy in front and
set `TRUST_PROXY_HEADERS=true` so the API's login rate limits see each
visitor's real IP. Section 9 uses Caddy and sets it for you. Leave it `false`
otherwise.

## 7. End-to-end tests (Playwright)

A real browser (Chromium) uses the real website, API and PostgreSQL:
sign-up, log out and in, Facility Manager and floor import (PROJECT.md's Test
case), Graph Builder, patients and staff CSV import and export, Scenario
Builder, Algorithm Comparison (it must show the Test case values: 48.5 m mean
walk, everyone out after 100 s with C1 blocked), live replay, Reports with the
timeline chart and a real PDF, the AI Assistant, an Administrator adding a
Staff User who then sees only that role's pages, Settings, an automatic
accessibility check (WCAG 2.1 A and AA, axe-core) of every page, and that no
page breaks the Content-Security-Policy.

The tests start their own servers (website 3100, API 8100, a fake AI 11500),
so your normal ones on 3000 and 8000 can keep running. They use their own
database, `health11_e2e`, which is **emptied and rebuilt on every run**; any
other database is refused. No real AI is called.

Once:

```powershell
docker exec health11-postgres createdb -U health11 health11_e2e
cd frontend
npx playwright install chromium
```

Each run (stop `npm start` first, the build replaces its files):

```powershell
cd frontend
npm run build
npm run e2e
```

The database address is taken from `TEST_DATABASE_URL` in `.env.test` with the
name changed to `health11_e2e` (or set `E2E_DATABASE_URL`). After a failure,
`npx playwright show-report` opens the report with screenshots and traces.

## 8. Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- Python 3.11 with exactly the locked packages, and PostgreSQL 16.
- Migrations up → down → up, and a model/migration drift check (`alembic check`).
- The full test suite and the website checks.
- The end-to-end tests in Chromium.
- A build of the production images, a check of the Caddy configuration, and a
  check that the compose file refuses empty secrets.

## 9. Run in production (Docker, HTTPS)

Everything runs in Docker from `compose.production.yml`: PostgreSQL, the API,
the website and [Caddy](https://caddyserver.com), which gives the site HTTPS.
Browsers reach only Caddy. It sends live simulation streams (`/api/v1/ws/...`)
to the API and everything else to the website. The database and the API have
no open ports. This is a separate Docker project (`health11-prod`) with its own
database. Your development database and `docker-compose.yml` are not touched.

| Part | Image | Notes |
|---|---|---|
| API | `backend/Dockerfile` on `python:3.11.9-slim-bookworm` | Exactly `requirements.lock.txt`, checked with `pip check`. Runs as an ordinary user and applies the migrations on start. |
| Website | `frontend/Dockerfile` on `node:24.20.0-bookworm-slim` | `npm ci` and `npm run build`; ships only the standalone server, run as the `node` user. |
| HTTPS | `caddy:2.11.7` | `deploy/Caddyfile`. |
| Database | `postgres:16.6` | Volume `postgres_data`. |

The base images are pinned by digest, so a rebuild starts from the same files.

**Python lock files.** `requirements.txt` lists what the project uses (it is what
you install on Windows). `requirements.lock.txt` lists every package, including
the packages those packages need, with exact versions for Linux.
`requirements-test.lock.txt` adds pytest. The Docker image and CI install the
lock files. `tests/test_deployment_files.py` checks that both lists agree.

### First start on your PC (https://localhost)

Ports 80 and 443 must be free, and Docker Desktop must be running.

```powershell
Copy-Item .env.production.example .env.production
```

Docker refuses to start while `POSTGRES_PASSWORD` or `JWT_SECRET_KEY` is
empty. This fills both with new random values without showing them (it never
replaces a value that is set, because the database keeps its first password):

```powershell
.\scripts\new-production-secrets.ps1
```

Then open the file with `notepad .env.production` and put your AI key in `GROQ_API_KEY` too, or choose another `AI_PROVIDER`. The
free Gemini tier is refused in production. Ollama on the same PC cannot be
reached from inside Docker.

Build and start (the first build takes several minutes):

```powershell
docker compose -f compose.production.yml --env-file .env.production up -d --build
docker compose -f compose.production.yml --env-file .env.production ps
```

Wait until `postgres`, `backend` and `web` show `healthy`, then open
https://localhost.

**Trust the certificate (once).** Caddy makes its own certificate for
localhost, so browsers warn until you trust Caddy's local certificate
authority. The authority stays in the `caddy_data` volume and is used for
nothing else. Windows asks you to confirm the import.

```powershell
docker compose -f compose.production.yml --env-file .env.production cp caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-local-root.crt
Import-Certificate -FilePath .\caddy-local-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Then restart the browser. Chrome and Edge use the Windows certificate store;
Firefox has its own. To remove the trust later:

```powershell
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like '*Caddy Local Authority*' | Remove-Item
```

**Everyday commands** (from the project folder):

```powershell
docker compose -f compose.production.yml --env-file .env.production logs -f backend   # Ctrl+C to stop watching
docker compose -f compose.production.yml --env-file .env.production stop               # stop, data is kept
docker compose -f compose.production.yml --env-file .env.production up -d --build       # start again or after an update
```

Do not add `-v` to `down`: it deletes the volumes, and with them the database.

**Prove the locked Linux packages pass every backend test.** The test image is
the API image plus pytest and `tests/`. It runs against `health11_test` (the
same database as section 5, reached through `host.docker.internal`), never the
production or development database.

```powershell
docker build -f backend/Dockerfile --target test -t health11-backend-test .
$url = ((Get-Content .env.test | Select-String '^\s*TEST_DATABASE_URL\s*=').Line -split '=', 2)[1].Trim().Trim('"').Trim("'") -replace '@127\.0\.0\.1:', '@host.docker.internal:'
docker run --rm -e "TEST_DATABASE_URL=$url" -e "DATABASE_URL=$url" health11-backend-test
Remove-Variable url
```

`tests/test_deployment_files.py` is not in that image, because it checks the
Dockerfiles and compose file. It runs with the normal test suite (section 5)
and in CI.

### Later, on a server

The same files work. In `.env.production` set `SITE_HOST` to the server's
domain name, `CADDY_TLS` to your e-mail address (Caddy then gets a free Let's
Encrypt certificate and renews it) and `PUBLISH_IP=0.0.0.0`. The domain must
point at the server, and ports 80 and 443 must be open.

## 10. Backup and restore (production database)

```powershell
.\scripts\backup.ps1                          # backups\health11-<date>-<time>.dump
.\scripts\backup.ps1 -Label before-update     # backups\health11-<date>-<time>-before-update.dump
```

The backup is checked with `pg_restore --list` before the script reports
success. Backups hold all hospital data, so keep them private. The `backups`
folder is ignored by git. Copy backups to another disk now and then. Trained
AI models are not in the backup; train them again on the AI page after a
restore on a new PC.

To restore, the production stack must be running:

```powershell
.\scripts\restore.ps1 -BackupFile backups\health11-20261020-101500.dump
```

It asks you to type `RESTORE`. It then makes a safety backup of the current
data (`...-before-restore.dump`) and stops the website and the API. It empties
the database, loads the backup (stopping at the first error) and starts both
again. The API brings an older backup up to date with the migrations. If
loading fails, the message gives the command to put the safety backup back.
Both scripts work only with `compose.production.yml`, never with the
development database.

## 11. Demo data (development only)

`scripts/seed_demo.py` loads one clearly labelled, made-up organization into
the **development** database, so the project can be shown in a few minutes:

- "DEMO Organization (made-up data)" with one Administrator;
- "DEMO Hospital" > "DEMO Block A" > "Ground floor", with PROJECT.md's Test
  case floor (ICU, WardA, C1, C2, S1, S2, R1, R2, E1, E2);
- 10 patients and 4 staff, all marked synthetic (codes start with `DEMO-`);
- the default simulation parameters, with source "assumed, to be validated";
- two scenarios: a drill without hazards, and the Test case fire at C1.

It goes through the API, with the same checks and audit log as the website,
in one transaction: everything is saved or nothing is. It refuses to run
unless `ENVIRONMENT=development`, refuses `health11_test` and `health11_e2e`,
and changes nothing if the DEMO organization already exists. The application
never depends on it.

With the development database running and migrated (sections 2 and 3):

```powershell
.\.venv\Scripts\python.exe scripts\seed_demo.py
```

It asks for a password for the DEMO Administrator, typed twice and never
shown. Then it prints the **Organization ID** and email to log in with. The
[user guide](docs/user-guide.md#a-10-minute-demo-with-the-demo-data) has a
walkthrough.

## 12. Forgotten password

The website has no "forgot password" e-mail. An Administrator can set a new
password for other users on the Admin page. If the only Administrator has
forgotten theirs, whoever runs the server can set one directly in the
database:

```powershell
.\.venv\Scripts\python.exe scripts\reset_password.py --list
.\.venv\Scripts\python.exe scripts\reset_password.py --organization <Organization ID> --email <e-mail>
```

`--list` shows each Organization ID with its accounts (e-mail and role only).
The new password is asked twice and never shown. Earlier logins of that
account end, its failed-login lockout is cleared, and the change goes into the
organization's audit log. It uses the database that `.env` points at (the
development setup); the production image does not contain this script.

## 13. "Forgot password?" by e-mail

The login page has a **Forgot password?** link. Someone enters their
Organization ID and e-mail; if that account exists and is active, a 6-digit
code is e-mailed. The page answers the same either way, so it cannot be used
to find out who has an account. The code is valid for 10 minutes, works once
and allows 5 wrong tries; asking again ends the older code. With the code and
a new password, every earlier login of the account ends and the change is
written to the audit log. Only a keyed hash of each code is stored. Requests
are limited per account and per network address.

E-mail is sent over SMTP, for free with a Gmail account. Use a **separate
Gmail account made for the app**, not a personal one:

1. Create the Gmail account (for example `yourhospital.health11@gmail.com`).
2. In that Google account, turn on **2-step verification**.
3. Create an **app password** (Google Account → Security → App passwords) and
   copy the 16 letters.
4. In `.env` (development) or `.env.production` (production) set:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USERNAME=yourhospital.health11@gmail.com
SMTP_PASSWORD=<the app password>
SMTP_FROM=yourhospital.health11@gmail.com
```

5. Restart the API. Without `SMTP_HOST` the link still shows, and the page
   says that reset by e-mail is not set up.

The code goes to the account's e-mail address, so it only works for accounts
with a real inbox. Otherwise an Administrator sets a new password on the
Admin page, or the server operator uses `scripts/reset_password.py`
(section 12). A free Gmail account sends to up to 500 recipients a day.
SMS codes are not offered: in India every business SMS needs DLT registration
and costs money.

## 14. Outside data (optional)

| Source | What it adds | Key | Settings |
|---|---|---|---|
| OpenStreetMap (Overpass API) | Facility Manager → **Find on OpenStreetMap**: hospitals near the hospital's map position; **Use this** saves an address and position | none | `OSM_ENABLED`, `OVERPASS_URL`, `OSM_SEARCHES_PER_DAY` (default 100), `OSM_SEARCHES_PER_ORGANIZATION_PER_DAY` (default 30) |

Outside data is shown with its source, licence and time, and is never used
silently in a simulation. OpenStreetMap data is © OpenStreetMap contributors,
under the [ODbL](https://www.openstreetmap.org/copyright). The public Overpass
servers are free; their fair-use rule for programs that use them regularly is
about 100 searches a day, so that is this server's daily total. The main
server (overpass-api.de) is often busy, so a search that gets a busy answer
(406, 429, 502, 503, 504) or no connection tries the next server in `OVERPASS_URL`
(by default overpass.private.coffee, also a free public server listed on the
OpenStreetMap wiki); it still counts as one search. Tests never call it
(a fake server answers).

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
| People files | `GET /patients/export`, `GET /staff/export` (CSV); `POST /patients/import?apply=false\|true`, `POST /staff/import?apply=false\|true` (CSV, max 1 MiB, 5,000 rows). The file is the full list: matched by code, new codes added, changed rows updated, codes not in the file removed. `apply=false` only reports what would change. |

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

## AI assistant (Anthropic Claude, Google Gemini, Groq or a local model with Ollama)

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

Choose the AI service with `AI_PROVIDER` in `.env` (never put keys in code or
chat). Without a key and model the endpoints answer `503` with an explanation.
All the safety rules above are in HEALTH-11's own code, so they apply to every provider.

| `AI_PROVIDER` | Settings | Notes |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Paid API credits (separate from a Claude chat subscription) |
| `gemini` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FREE_TIER`, `GEMINI_API_VERSION` (`v1` default, or `v1beta`) | Key from Google AI Studio. On the **free tier** Google may use what is sent to improve its products: every answer then carries a `data_notice`, use made-up data only, and the server refuses to start in production. Set `GEMINI_FREE_TIER=false` only for a paid (billing-enabled) key. |
| `groq` | `GROQ_API_KEY`, `GROQ_MODEL` (for example `openai/gpt-oss-20b` or `openai/gpt-oss-120b`, production models on [Groq's model list](https://console.groq.com/docs/models)) | GroqCloud's OpenAI-compatible API with strict structured outputs. A daily limit that is used up is reported as such. |
| `ollama` | `OLLAMA_MODEL`, `OLLAMA_URL` (default `http://127.0.0.1:11434`), `OLLAMA_TIMEOUT_SECONDS` (default 180) | Free model running on this computer with [Ollama](https://ollama.com): no key, no quota, nothing leaves the computer. Install Ollama, then `ollama pull <model>` (for example `llama3.2`). Slower than hosted services and small models make more mistakes; the checks above still apply. In production `OLLAMA_URL` must be on the same machine or use `https`. |

Check the setup with one real request — the key is never printed, and on failure
the service's own reason is shown:

```powershell
.\.venv\Scripts\python.exe scripts\check_assistant.py
```

## Reports (PDF and CSV)

`GET /api/v1/reports/{run_id}?format=pdf` (default) or `?format=csv` downloads a
report of a saved simulation run. Every signed-in user of the organization can
download reports (Staff Users included); each download is recorded in the audit
log and limited to `REPORT_MAX_REQUESTS_PER_USER` (default 30) per user per
`REPORT_WINDOW_SECONDS` (default 600).

Contents, all taken from what was stored with the run: summary, hazards
(including ones added during the run), recommendations, bottlenecks, people per
exit, timeline, hazard spread, each person's route and outcome, the parameters
used (with their source) and the accuracy of the evacuation-time predictor
(or a note that none has been trained). The safety notice is on every PDF page
and at the top of the CSV.

- Place names are the ones at the time of the run; people are listed by record
  number only, never by name.
- The CSV is UTF-8 with a byte-order mark (opens correctly in Excel), one block
  per section. Text that a spreadsheet would run as a formula (`=`, `+`, `-`,
  `@`) is prefixed with `'`.
- The built-in PDF font covers Western European letters. For place names in
  other scripts set `REPORT_FONT_PATH` to a `.ttf` font that has them (for
  example `C:\Windows\Fonts\arial.ttf`); scripts that need letter shaping,
  such as Devanagari, may still not join correctly in the PDF — the CSV always
  has the exact text.
- Very large runs take longer as PDF (about 20 s for 5,000 people and an hour
  of timeline); the CSV is immediate.

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
