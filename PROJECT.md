# \# HEALTH-11: Emergency Evac Graph

# AI-driven hospital evacuation planning under fire and hazard scenarios (SDG 11 and SDG 13). Users: hospitals and disaster management agencies. Tagline: "Smarter Paths. Safer People. Healthier Tomorrows."

#

# \## Stack

# \- Frontend: Next.js (App Router), TypeScript, Tailwind, React Flow (graph canvas), Recharts (charts). Rebuild the 13 pages from docs/design/preview.html exactly in look and wording.

# \- Backend: FastAPI (Python 3.11), NetworkX, SQLAlchemy 2, Alembic, Pydantic, JWT auth (bcrypt password hashing, access plus refresh tokens), WebSocket

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

# 5\. Never invent libraries or functions. If unsure, ask.

# 6\. Pin all dependency versions.

# 7\. AI honesty: every AI feature shows in the UI how it works and its real accuracy or limits ("About this prediction"). If data is insufficient, show a clear message instead of a fake number. Never invent metrics.

# 8\. Secrets (API keys, database passwords, JWT secret) live only in .env, never in code or git. Provide .env.example without real values.

# 9\. Multi-tenant isolation is mandatory (see the Multi-hospital section). Every query and every WebSocket is filtered by the logged-in user's organization\_id.

# 10\. Treat all user input, uploaded files and AI text as untrusted. Validate everything.

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

# \- CORS origins from .env. Structured logging. Health endpoint GET /health. Error messages must not leak internals.

# \- Database indexes, pagination and search on every list endpoint, soft delete (deleted\_at) for hospital data, created\_at and updated\_at everywhere.

# \- Full audit log of every create, update and delete, and of logins.

# \- Automated tests (pytest, Playwright), GitHub Actions CI, production Dockerfiles, backup and restore script.

# \- API versioned under /api/v1 with OpenAPI docs.

#

# \## Safety notice

# HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals. Show this notice in the UI (footer and simulation pages) and on every report.

#

# \## Design

# Light theme only. Background #F8FAFC, white cards with 1px #E2E8F0 border and soft shadow, 12px radius, primary #7DB8E8, success #BFE8D0, warning #FCE9B2, danger #F9C5C5, ink #1E3A5F, text #334155 and #64748B, Inter font, minimal and spacious, left sidebar plus content area. Match docs/design/preview.html.

#

# \## Roles

# Administrator, Emergency Commander, Staff User.

# \- Administrator: all pages, user management and audit log for their own organization.

# \- Emergency Commander: all pages except Admin.

# \- Staff User: read-only on Dashboard, Live Simulation, Patients \& Staff, Reports.

#

# \## Data model

# organizations, users(organization\_id, role), hospitals, buildings, floors, nodes(type: room/ward/icu/corridor/stair/ramp/lift/exit/assembly, x, y, floor, capacity, is\_blocked), edges(from\_node, to\_node, distance in metres, width, max\_flow, wheelchair\_accessible, stretcher\_accessible, is\_blocked), patients(mobility: ambulatory/wheelchair/stretcher/ventilator, criticality, node\_id, is\_synthetic), staff, hazards(type: fire/smoke/hazmat/structural, origin\_node, spread\_rate, severity), scenarios, simulation\_runs(algorithm, params, results JSON), evacuation\_plans, parameters(name, value, unit, source), audit\_log, ml\_models(organization\_id, type, metrics, trained\_at, file\_path).

# All hospital-data tables carry organization\_id, created\_at, updated\_at, deleted\_at.

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

# \## Test case (must pass)

# Nodes: ICU (type icu), WardA (ward), C1 and C2 (corridor), S1 and S2 (stair), R1 and R2 (ramp), E1 and E2 (exit).

# Edges (distance in metres): ICU-C1 10, C1-S1 12, S1-E1 20, C1-R1 18, R1-E1 15, ICU-C2 14, C1-WardA 8, WardA-C2 12, C2-S2 10, S2-E2 25, C2-R2 16, R2-E2 20.

# Rule: stretcher and wheelchair patients cannot pass through any node of type stair, and cannot use any edge flagged not accessible. Ambulatory patients can use stairs and ramps.

# Expected: walking from WardA = WardA,C1,S1,E1 (40 m). Stretcher from ICU = ICU,C1,R1,E1 (43 m).

# With C1 blocked: walking = WardA,C2,S2,E2 (47 m). Stretcher = ICU,C2,R2,E2 (50 m). E1 unreachable.

# Never change these expected values to make a test pass; fix the code instead.

#

# \## Working rules for the AI assistant

# Read this file at the start of every task. Do one small task at a time. Do not change unrelated files. Do not invent libraries, functions or data. After coding, run it and show real output. Never claim something works unless you ran it. If unsure, ask instead of guessing. Commit to git after each working step.
