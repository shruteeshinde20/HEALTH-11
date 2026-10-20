# HEALTH-11 architecture

How the parts fit together, where the code lives, and the rules every part
follows. The full specification is [PROJECT.md](../PROJECT.md); setup and
commands are in the [README](../README.md); what each page does is in the
[user guide](user-guide.md).

## The parts

```
Browser
  |  HTTPS (production: Caddy, deploy/Caddyfile)
  v
Website: Next.js 16 (frontend/)                 live streams (WebSocket)
  pages, plus a small server that keeps the  ---------------------------+
  session in httpOnly cookies and passes                                |
  allowed calls on to the API                                           |
  |  HTTP inside the server / Docker network                            |
  v                                                                     v
API: FastAPI (backend/app/), everything under /api/v1, OpenAPI at /docs
  auth, facilities, floor graph, people, scenarios, routing, simulation,
  analysis, AI, reports, admin, audit log
  |  SQLAlchemy 2 + psycopg 3; schema changes only through Alembic (alembic/)
  v
PostgreSQL 16
```

- **The browser only talks to the website.** Tokens never reach page scripts:
  the website's server logs in at the API and keeps the access and refresh
  tokens in httpOnly, SameSite=Strict cookies. Requests that change data must
  come from the site's own pages (same-origin check). The token endpoints are
  not reachable through the website's pass-through route.
- **Live simulation** uses a WebSocket straight to the API
  (`/api/v1/ws/simulations/{run_id}`), opened with a short-lived token that is
  valid for that one run.
- **AI services** (Anthropic, Gemini, Groq or a local Ollama model) are called
  only by the API, with the key from `.env`. The browser never sees a key.

## Code map

| Folder | What is there |
|---|---|
| `backend/app/main.py` | The FastAPI app: middleware (request size limit, security headers, CORS), error format, routers. |
| `backend/app/config.py` | All settings, read from `.env` / the environment, with production checks. |
| `backend/app/models/` | Database tables (SQLAlchemy). |
| `backend/app/*_api.py`, `floor_io.py`, `people_io.py` | The REST endpoints, one file per area. |
| `backend/app/services/` | The logic: `routing.py` (BFS, DFS, Dijkstra, A*, nearest safe exit, mobility rules), `hazards.py` (spread model and risk), `simulation.py` and `simulation_runner.py` (tick-based simulation), `bottlenecks.py`, `priority.py`, `ml.py` (predictor and alerts), `assistant.py` (language-model assistant), `reports.py` (PDF and CSV), `model_parameters.py` (parameter defaults and limits). |
| `backend/app/auth.py`, `permissions.py`, `roles.py`, `rate_limit.py`, `audit.py` | Sign-up, login, tokens, roles, rate limits, audit log. |
| `alembic/versions/` | Database migrations. |
| `frontend/src/app/` | The pages (App Router) and the website's server routes (`api/session/*`, `api/backend/*`). |
| `frontend/src/lib/` | `server/` (session, CSP, request checks), `client/`, `shared/` (types and pure helpers, unit-tested). |
| `frontend/src/components/` | Shared UI pieces (forms, tables, charts, map). |
| `tests/` | Backend tests (pytest) against the separate `health11_test` database. |
| `frontend/tests/unit/`, `frontend/e2e/` | Website unit tests (node:test) and end-to-end tests (Playwright). |
| `scripts/` | `seed_demo.py` (DEMO data, development only), `backup.ps1`, `restore.ps1`, `new-production-secrets.ps1`, `check_assistant.py`. |
| `backend/Dockerfile`, `frontend/Dockerfile`, `compose.production.yml`, `deploy/` | Production images and setup (README section 9). |

## Rules every part follows

**Multi-tenant isolation.** Every table with hospital data has
`organization_id`. The organization always comes from the login token, never
from the request. Child rows point at their parent with
(`organization_id`, `parent_id`), so the database itself rejects a link
between two organizations. Tests check this for every endpoint and the
WebSocket.

**No built-in hospital data.** Hospitals, places, paths, people, scenarios,
numbers and results come from the database through the API. The website holds
no sample names, numbers or graphs. The DEMO seed is a separate,
development-only script that enters made-up data through the same API.

**Honest numbers.** Simulation numbers come from the stored parameters
(name, value, unit, source). Defaults are reported with the source
"assumed, to be validated". Every run stores the parameters it used. AI
features say what they are and show their real accuracy, or say that there is
not enough data.

**Records are not destroyed.** Deleting hospital data sets `deleted_at` (soft
delete); unique names apply only to active rows. Every create, update and
delete, every login and failed login is written to the audit log.

**Untrusted input.** Every request body is validated (Pydantic) with size
limits. Uploads have their own size and row limits and are checked completely
before anything is saved. Errors use one JSON format and never echo submitted
values. Text sent to the AI is treated as data, never as instructions, and the
AI may only name places that exist on the chosen floor.

**Security headers.** The API sends no-sniff, deny-framing, no-referrer and
`default-src 'none'`. Pages get a strict Content-Security-Policy with a fresh
nonce per response. Details are in [security-review.md](security-review.md).

## How a simulation run works

1. `POST /api/v1/simulate {scenario_id, algorithm, building_id?}`.
2. The API loads a **snapshot** of the building (places, paths, links between
   floors), the people placed in it, the scenario's hazards and the
   organization's parameters.
3. The hazard model works out when each place is reached and its risk;
   routes are found with the chosen algorithm, mobility rules and risk costs.
4. The tick-based simulator moves everyone along their routes, with queues on
   paths (width and maximum flow) and re-routing when a hazard blocks the way.
5. The run is stored with its inputs (snapshot, parameter values and sources,
   features for the predictor) and results (timeline, routes, bottlenecks,
   recommendations). Live Simulation replays it over the WebSocket. A hazard
   added during the replay (`POST /simulations/{run_id}/hazards`, with the
   moment it appears) re-runs that same run: from that moment everyone
   re-routes, and the stored results are replaced and audited.

## Environments

| | Database | How it starts |
|---|---|---|
| Development | `health11` (Docker, port 5433) | `uvicorn --reload` and `npm run dev` (README sections 2 to 6). The DEMO seed may be loaded here. |
| Backend tests | `health11_test` | `pytest`. Each test runs in a transaction that is rolled back. Any other database is refused. |
| End-to-end tests | `health11_e2e` | `npm run e2e`. It is emptied and rebuilt on every run. Any other database is refused. |
| Production | its own volume in `compose.production.yml` | Docker Compose with Caddy, at https://localhost or a server (README sections 9 and 10). |
