# \# HEALTH-11: Emergency Evac Graph

# AI-driven hospital evacuation planning under fire and hazard scenarios (SDG 11 and SDG 13). Users: hospitals and disaster management agencies. Tagline: "Smarter Paths. Safer People. Healthier Tomorrows."

#

## Scope rule

The full scope in this file is the target. Never reduce it to an "MVP" on your own, never drop a feature or page, and never skip a build step. If something cannot be finished in a step, say so clearly and tell me what is left. Build in the order given in "Build order".

#

## Environment rules

- The developer is a complete beginner working on Windows 11 with PowerShell, VS Code and Docker Desktop. Give commands for PowerShell and explain errors in simple words.

- Run commands on the developer's computer. If you cannot run something in your environment (Docker, PostgreSQL, a browser), say so and give the exact commands for me to run, then wait for the output. Never pretend something ran.

- Never print secrets (.env values, passwords, keys).

#

# \## Stack

# \- Frontend: Next.js (App Router), TypeScript, Tailwind, React Flow (graph canvas), Recharts (charts). Rebuild the 13 pages from docs/design/preview.html exactly in look and wording.

# \- Backend: FastAPI (Python 3.11), NetworkX, SQLAlchemy 2, Alembic, Pydantic and pydantic-settings, JWT auth (bcrypt password hashing, access plus refresh tokens), WebSocket

# \- Database: PostgreSQL

# \- AI/ML: scikit-learn, numpy, pandas, joblib (model saving)

# \- LLM: official Anthropic Python SDK. API key in .env as ANTHROPIC\_API\_KEY and model name in .env as ANTHROPIC\_MODEL (never hardcoded). Check the official Anthropic docs for current SDK usage before writing code.

# \- PDF reports: reportlab

# \- Tests: pytest (backend), Playwright (end-to-end)

# \- DevOps: Docker and docker-compose for all services, GitHub Actions CI, environment-based config (dev, test, prod)

#

# \## Hard rules

# 1\. No hardcoded data in frontend or business logic. Hospitals, nodes, edges, patients, staff, scenarios, users, numbers, reports and results come from the database via the REST API. The frontend contains no sample names, numbers or graphs.

# 2\. docs/design/preview.html is a VISUAL SPEC ONLY (layout, colors, spacing, page list, wording). Its sample data, hardcoded graph and browser-side routing code must never be copied into the real app.

# 3\. Every button works end-to-end: UI, API, database, UI. No dummy handlers, no random or fake results.

# 4\. Every page has loading, empty and error states. Responsive. Light theme only. Accessible (contrast, keyboard navigation, labels).

# 5\. Never invent libraries, functions, versions or data. If unsure, ask. Check that a package version exists before pinning it.

# 6\. Pin all dependency versions.

# 7\. AI honesty: every AI feature shows in the UI how it works and its real accuracy or limits ("About this prediction"). If data is insufficient, show a clear message instead of a fake number. Never invent metrics.

# 8\. Secrets (API keys, database passwords, JWT secret) live only in .env, never in code or git. Provide .env.example without real values.

# 9\. Multi-tenant isolation is mandatory (see the Multi-hospital section). Every query and every WebSocket is filtered by the logged-in user's organization\_id, taken from the token, never from the request body.

# 10\. Treat all user input, uploaded files and AI text as untrusted. Validate everything.

# 11\. Tests use a separate database (health11\_test) and must never touch the development database. Never weaken or delete a test to make it pass; fix the code. Change a test only if the test itself is wrong, and explain why.

#

# \## Build order (do not skip or reorder)

# 1\. Project skeleton, Docker, CI (done)

# 2\. Database schema and migration (done)

# 3\. Database tests on a separate test database

# 4\. Backend foundation: pinned dependencies, settings from .env, database session, GET /health, error format, logging, CORS

# 5\. Authentication, roles, tenant isolation (with tests proving organization A cannot see organization B)

# 6\. Data CRUD APIs, floor import and export

# 7\. Routing engine (BFS, DFS, Dijkstra, A\*) with the Test case

# 8\. Hazards, bottleneck detection, recommendations

# 9\. Simulation, WebSocket streaming, algorithm comparison, dynamic re-routing

# 10\. AI features 1, 2 and 5 (predictor, priority scoring, alerts)

# 11\. AI Assistant (LLM)

# 12\. Reports (PDF and CSV)

# 13\. Frontend foundation (layout, login, sign-up, API client)

# 14\. Frontend pages in groups (onboarding, dashboard, facility manager; graph and scenario builders; live simulation and comparison; patients, AI assistant, reports; admin, settings, landing)

# 15\. Security and quality review

# 16\. End-to-end tests (Playwright)

# 17\. Deployment preparation

# 18\. Documentation and demo

# Do one step at a time. After each step: run the tests, show the real output, and commit.

#

# \## Multi-hospital (multi-tenant)

# \- Every table that holds hospital data has organization\_id. One hospital (organization) must never see another's data. Tests must prove this for every API and WebSocket.

# \- New hospitals register themselves through organization sign-up. The first user becomes Administrator of that organization.

# \- Onboarding wizard for a new organization: 1) create hospital, 2) create building and floor, 3) import or draw the floor graph, 4) run a first simulation.

# \- Roles are per organization. Administrators can invite and manage users of their own organization only.

#

# \## Production quality

# \- Input validation on every endpoint, request size limits, file upload size and type limits.

# \- Rate limiting on login, sign-up and the AI endpoint. Password rules. JWT expiry plus refresh token. Logout invalidates the refresh token.

# \- CORS origins from .env. Structured logging. Health endpoint GET /health (also checks the database). Error messages must not leak internals; one consistent JSON error format.

# \- Database indexes, pagination and search on every list endpoint, soft delete (deleted\_at) for hospital data, created\_at and updated\_at everywhere.

# \- Full audit log of every create, update and delete, and of logins and failed logins.

# \- Automated tests (pytest, Playwright), GitHub Actions CI, production Dockerfiles, backup and restore script.

# \- API versioned under /api/v1 with OpenAPI docs.

#

# \## Safety notice

# HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals. Show this notice in the UI (footer and simulation pages) and on every report.

#

# \## Design

# Light theme only. Background #F8FAFC, white cards with 1px #E2E8F0 border and soft shadow, 12px radius, primary #7DB8E8, success #BFE8D0, warning #FCE9B2, danger #F9C5C5, ink #1E3A5F, text #334155 and #64748B, Inter font, minimal and spacious, left sidebar plus content area. Match docs/design/preview.html.

# The Live Simulation page follows the Evac1 digital-twin layout embedded in the preview (left controls, central floor map, right results panel), but in the real app it uses the light theme colors above and shows only data from the API.

#

# \## Roles

# Administrator, Emergency Commander, Staff User.

# \- Administrator: all pages, user management and audit log for their own organization.

# \- Emergency Commander: all pages except Admin.

# \- Staff User: read-only on Dashboard, Live Simulation, Patients \& Staff, Reports.

#

# \## Data model

# organizations, users(organization\_id, role), hospitals, buildings, floors, nodes(type: room/ward/icu/corridor/stair/ramp/lift/exit/assembly, x, y, floor, capacity, is\_blocked), edges(from\_node, to\_node, distance in metres, width, max\_flow, wheelchair\_accessible, stretcher\_accessible, is\_blocked), patients(mobility: ambulatory/wheelchair/stretcher/ventilator, criticality, node\_id, is\_synthetic), staff, hazards(type: fire/smoke/hazmat/structural, origin\_node, spread\_rate, severity), scenarios, simulation\_runs(algorithm, params, results JSON), evacuation\_plans, parameters(name, value, unit, source), audit\_log, ml\_models(organization\_id, type, metrics, trained\_at, file\_path).

# All hospital-data tables carry organization\_id, created\_at, updated\_at, deleted\_at. Add a refresh\_tokens table (or equivalent) when authentication is built, with an Alembic migration.

#

# \## Features

# \- Floor-plan graph builder with CSV, GeoJSON and JSON import and export

# \- Hazard scenario creator; hazards spread over time and block nodes and edges

# \- Routing engine: BFS, DFS, Dijkstra, A\*, nearest safe exit, capacity-aware flow, mobility-aware edges

# \- Tick-based simulation with congestion, evacuation time, per-exit load, streamed live over an authenticated WebSocket

# \- Algorithm comparison (time, distance, risk)

# \- Bottleneck detection (betweenness centrality plus flow saturation) with plain-language recommendations

# \- Dynamic re-routing when a new hazard appears mid-simulation

# \- Reports (PDF and CSV): timeline, routes, bottlenecks, recommendations, parameters used, model accuracy, safety notice

# \- Onboarding wizard, user management, audit log, editable simulation parameters

#

# \## AI features (be honest about what each one is)

# 1\. Evacuation-time predictor: scikit-learn regression model (ML) trained on simulation\_runs generated by our own simulator for that organization, so it is a surrogate model. Report real MAE and R2 on a held-out test set. If there is not enough data, say so.

# 2\. Patient priority scoring: transparent weighted formula (mobility, criticality, distance to hazard). Rule-based, not ML. Show the score breakdown in the UI.

# 3\. Fire and smoke spread prediction: cellular-automaton model using spread\_rate, giving a risk score per node that is added as extra cost in A\*. Algorithmic, not ML.

# 4\. Natural-language commander assistant: Anthropic API converts text into scenario JSON validated with Pydantic. It receives only the node names of the chosen floor. It may only reference node and edge names that exist in the database. If a name is missing or unclear it must return a clarification question, never guess. It never runs anything by itself; the user confirms with a "Run it" button. User text is untrusted and must not be able to change the assistant's instructions or reach other organizations' data. It also writes a plain-language summary of results using only stored results.

# 5\. Anomaly and bottleneck alerts: scikit-learn IsolationForest on features of past simulation\_runs (evacuation time, max edge saturation, number of blocked nodes) to flag unusual runs, combined with the bottleneck detector. If fewer than 50 runs exist, show "more data needed".

#

# \## Data policy and datasets

# \- Hospital layouts: created by users in the Graph Builder or imported by CSV, GeoJSON or JSON. Real hospitals enter or import their own data.

# \- Seed script (development only, never runs in production): loads one clearly labelled DEMO organization with one demo hospital and the Test case graph below, synthetic patients and staff labelled as synthetic, and default parameters.

# \- Optional context imports: OpenStreetMap (Overpass API) for hospital locations, NASA FIRMS for fire hotspots, Open-Meteo for weather and wind, data.gov.in and NDMA for health and hazard data.

# \- Parameters (walking, wheelchair and stretcher speeds, exit capacities) are stored in the parameters table with unit and source columns (for example NFPA or NIST research). If no real citation exists, write "assumed, to be validated".

# \- No hospital data, number or user exists in frontend code.

#

# \## Pages (13)

# Landing, Login/Register, Dashboard, Facility Manager, Graph Builder, Scenario Builder, Live Simulation, Algorithm Comparison, Patients \& Staff, AI Assistant, Reports \& History, Admin (users, audit log), Settings/Profile. Plus an Onboarding wizard shown to new organizations.

#

# \## API contract (the frontend expects this; keep it unless I approve a change)

# All paths start with /api/v1. Header: Authorization: Bearer <token>. List endpoints return a JSON array or {items:\[...]} and support pagination. The organization always comes from the token.

# \- Auth: POST /auth/register-organization, POST /auth/login, POST /auth/refresh, POST /auth/logout. Login returns {access\_token, refresh\_token, user:{id,email,full\_name,role}}. Roles are exactly "Administrator", "Emergency Commander", "Staff User".

# \- CRUD (GET list, GET /{id}, POST, PATCH /{id}, DELETE /{id} as soft delete): /hospitals, /buildings, /floors, /nodes (filter ?floor\_id=), /edges (filter ?floor\_id=), /patients, /staff, /users, /parameters, /scenarios (with hazards).

# \- GET /audit\_log. GET /dashboard returns {hospitals, scenarios, last\_evacuation\_time\_s, bottlenecks}.

# \- POST /simulate {scenario\_id, algorithm: bfs|dfs|dijkstra|astar} returns {run\_id}. GET /simulation\_runs and GET /simulation\_runs/{id} (timeline, routes, bottlenecks, recommendations).

# \- WebSocket /ws/simulations/{run\_id}?token=... sends ticks {t, total, evacuated, positions:\[{id,x,y,mobility}], blocked\_nodes, congested\_edges, exit\_load, done}; accepts {action:"pause"|"resume"}. Authenticated and organization-checked.

# \- POST /simulations/{run\_id}/hazards (dynamic re-routing). POST /compare {scenario\_id} returns \[{algorithm, evacuation\_time\_s, distance\_m, risk}].

# \- POST /predict {scenario\_id} returns {predicted\_time\_s, method, mae, r2, note}; predicted\_time\_s is null with a note if there is not enough data. GET /alerts returns {message?, alerts:\[{run\_id, reason}]}.

# \- POST /assistant {text, floor\_id} returns {clarification} or {scenario}. GET /reports/{run\_id}?format=pdf|csv returns a file.

# \- POST /floors/{id}/import (CSV, GeoJSON or JSON, size-limited) and GET /floors/{id}/export.

# \- GET /health (no login) checks the API and the database.

#

# \## Test case (must pass)

# Nodes: ICU (type icu), WardA (ward), C1 and C2 (corridor), S1 and S2 (stair), R1 and R2 (ramp), E1 and E2 (exit).

# Edges (distance in metres): ICU-C1 10, C1-S1 12, S1-E1 20, C1-R1 18, R1-E1 15, ICU-C2 14, C1-WardA 8, WardA-C2 12, C2-S2 10, S2-E2 25, C2-R2 16, R2-E2 20.

# Rule: stretcher and wheelchair patients cannot pass through any node of type stair, and cannot use any edge flagged not accessible. Ambulatory patients can use stairs and ramps.

# Expected: walking from WardA = WardA,C1,S1,E1 (40 m). Stretcher from ICU = ICU,C1,R1,E1 (43 m).

# With C1 blocked: walking = WardA,C2,S2,E2 (47 m). Stretcher = ICU,C2,R2,E2 (50 m). E1 unreachable.

# Never change these expected values to make a test pass; fix the code instead.

#

# \## Working rules for the AI assistant

# Read this file at the start of every task. Do one small task at a time, in the Build order. Do not change unrelated files. Do not invent libraries, functions, versions or data. After coding, run it and show real output. Never claim something works unless you ran it. If unsure, ask instead of guessing. Commit to git after each working step, only the files of that step, and show git status --short and git log -3 --oneline. End every task with a table: Step, What you ran, Real result (passed, failed or not run).



