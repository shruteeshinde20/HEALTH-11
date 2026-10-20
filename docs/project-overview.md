# HEALTH-11 project overview

What HEALTH-11 does, where its data comes from and where it is kept, what is
AI and what is not, what is checked automatically, what is still open, and
ideas for the future. Details: [user guide](user-guide.md),
[architecture](architecture.md), [security review](security-review.md),
[README](../README.md).

> HEALTH-11 supports planning and training. It does not replace a hospital's
> official emergency procedures or fire-safety professionals.

## 1. What it is

A website for hospitals to plan and practise evacuations. A hospital draws or
imports its floors as a map of places (rooms, wards, ICUs, corridors, stairs,
ramps, lifts, exits, assembly points) and paths. It adds its patients and
staff, then creates emergency scenarios such as fire, smoke, hazmat or
structural damage. HEALTH-11 then:

- finds routes that respect each patient's mobility;
- simulates the evacuation second by second, with queues;
- finds bottlenecks and suggests improvements;
- compares four routing methods;
- writes PDF and CSV reports.

Many hospitals can use one installation; each organization sees only its own
data.

## 2. Features

| Area | What you can do |
|---|---|
| Accounts | Organization sign-up; log in and out. Roles: Administrator, Emergency Commander, Staff User (read-only). Users are added by an Administrator. Passwords follow strong rules. Sessions are renewed automatically. "Forgot password?" by e-mail code, when e-mail is set up. A password reset tool is available for the server operator. |
| Facilities | Hospitals (address, time zone, map position), buildings and floors. Floor files can be imported and exported as CSV, GeoJSON or JSON. |
| Graph Builder | Draw the places and paths of each floor on a map. Paths have length, width, flow, wheelchair and stretcher access, and can be blocked. Floors are linked by stairs, ramps and lifts. Evacuation lifts can be marked. |
| People | Patients by code only (no names): mobility and criticality. Staff with roles. Both can be imported from and exported to CSV, and the import shows all changes before saving. Patients get an evacuation priority score. |
| Scenarios | Hazards with type, start place, severity and spread rate, or none (a drill). The building to evacuate. The current weather at the hospital is shown as information. |
| Routing | BFS, DFS, Dijkstra, A*, nearest safe exit, and mobility rules (no stairs for wheelchairs, stretchers or ventilators). Routes avoid places the hazard will reach soon. |
| Simulation | A tick-based run with congestion on paths, evacuation time, exit loads, and people needing assisted evacuation. A live replay over a secure WebSocket can be paused, played at different speeds, and given a hazard mid-run, after which everyone is re-routed. |
| Analysis | Bottleneck detection (betweenness centrality plus how full each path gets), plain-language recommendations, and a four-method comparison (time, distance, risk). |
| AI | Evacuation-time predictor, unusual-run alerts, commander assistant, patient priority score, and hazard spread model (see section 5). |
| Reports | Run history with timeline, routes, bottlenecks and recommendations. PDF and CSV downloads that include the parameters used, model accuracy and the safety notice. |
| Administration | User management, a full audit log (every create, update and delete, logins and failed logins), and editable simulation parameters with unit and source. |
| Onboarding | A wizard for a new organization: hospital, then building and floor, then floor map, then a first simulation. |
| Operation | Docker production setup with HTTPS (Caddy), backup and restore scripts, a demo data seed, and GitHub CI. |

13 pages plus the onboarding wizard and the Forgot password page. 86 API
endpoints under `/api/v1`, with OpenAPI documentation at `/docs`.

## 3. Where the data comes from

| Data | Comes from |
|---|---|
| Hospitals, buildings, floors, places, paths | Typed in by users, drawn in the Graph Builder, or imported from their files |
| Patients and staff | Typed in or imported from CSV by users |
| Scenarios and hazards | Created by users, or drafted by the AI assistant from their text and confirmed by them |
| Simulation results, bottlenecks, recommendations | Calculated by HEALTH-11 from the data above |
| Parameters (speeds, thresholds) | Defaults marked "assumed, to be validated", or values the organization enters with their source |
| AI predictions and alerts | Models trained on the organization's own simulation runs |
| Assistant text | The chosen AI service (Groq, Anthropic, Gemini or local Ollama), from the user's text and stored results only |
| Weather | Open-Meteo, from the hospital's map position (information only) |
| Demo data | `scripts/seed_demo.py`, made-up and clearly labelled, development only |

Nothing about a hospital is built into the program.

## 4. Where the data is kept

| What | Where | Protection |
|---|---|---|
| Everything above: 19 tables, for example organizations, users, hospitals, nodes, edges, patients, scenarios, simulation_runs, audit_log | PostgreSQL 16, in a Docker volume on the server | Every hospital-data row carries its organization; the database itself refuses links between organizations. Deleting a record only marks it as deleted (soft delete). |
| Trained AI models | Files under `var/models/org-<id>/` (the `models` volume in production) | One folder per organization; only files written by the server are loaded |
| Passwords | Only as bcrypt hashes in the users table | Never shown or logged |
| Reset codes | Only as keyed hashes (HMAC-SHA256) | Valid 10 minutes, single use |
| Login sessions | httpOnly, SameSite=Strict cookies in the browser, plus revocable refresh tokens in the database | Page scripts cannot read them |
| Browser storage | Only the last Organization ID typed, for convenience | Contains no secrets |
| Secrets (database password, JWT secret, AI keys, SMTP) | `.env` / `.env.production` on the server | Never committed to git (checked) |
| Backups | `backups/` on the server (`scripts/backup.ps1`) | Not in git; restore asks first and keeps a safety copy |
| Logs | The server console, as structured JSON | No passwords, codes or submitted values |

## 5. AI: what is AI, and what is not

| Feature | What it really is | Honesty in the app |
|---|---|---|
| Evacuation-time predictor | **Machine learning**: a scikit-learn regression model trained on the organization's own simulation runs (a surrogate of the simulator) | Shows real MAE and R² on held-out runs; gives no number when there are too few runs |
| Unusual-run alerts | **Machine learning**: scikit-learn IsolationForest on past runs, together with the bottleneck detector | "More data needed" below 50 runs |
| Commander assistant | **A large language model** (Groq, Anthropic Claude, Google Gemini or a local Ollama model, chosen in `.env`). It turns text into a scenario draft, and writes run summaries from stored results only. | Uses only places that exist on the floor; asks instead of guessing; nothing runs without "Run it"; user text cannot change its instructions |
| Patient priority score | **A rule-based formula** of mobility, criticality and distance to the hazard; not ML | The breakdown is shown |
| Fire and smoke spread | **An algorithm**: a cellular-automaton-style spread with risk per place; not ML | Explained as a rule-based model |
| Routing, simulation, bottlenecks | **Algorithms** (graph search, tick simulation, centrality); not AI | "Not machine learning" is stated on the pages and in reports |

## 6. How it is checked

| Check | What it covers |
|---|---|
| Backend tests (pytest) | More than 450 tests: every API, isolation between organizations, the PROJECT.md test case (40 m, 43 m, and 47 m / 50 m with C1 blocked), simulation, AI honesty, security, migrations, deployment files and the demo seed. They run against the separate `health11_test` database. |
| Website unit tests | Pure helpers: sessions, CSP, files, graph, people, positions, weather text and more |
| End-to-end tests (Playwright) | A real browser goes through one organization's whole journey, including the e-mail reset and the weather. They use fake AI, mail and weather servers, so nothing leaves the computer. There is also an accessibility check (WCAG 2.1 A and AA) of every page and a CSP check. |
| GitHub CI | All of the above, plus a lint and type check, `npm audit` of what ships, migrations up → down → up, a model/migration drift check, and production Docker image builds. It runs on every push. |

## 7. Known limits and open items

- **Parameters are assumptions.** Walking, wheelchair, stretcher and
  ventilator speeds and the thresholds are marked "assumed, to be validated".
  The hospital's fire-safety officer should confirm them.
- **The `evacuation_plans` table is not used yet.** PROJECT.md's data model
  lists it, but no page or endpoint saves a plan yet; simulation runs hold the
  routes instead. See the future scope.
- **E-mail reset is off** until an app Gmail (or other SMTP) is set up.
- **Weather is information only.** The simulation does not use wind. Open-Meteo's
  free use is non-commercial.
- **Not done:** OpenStreetMap lookup (built, but dropped because the free
  servers are often overloaded; on the `data-2-openstreetmap` branch), official
  NDMA alerts, NASA FIRMS, data.gov.in.
- **The real AI services and real weather** are checked on the developer's PC;
  the automated tests use fakes, on purpose.
- **Production so far ran on one PC** (https://localhost). A real server needs
  a domain, three settings, and regular off-site backups.
- **Not certified for life-safety use.** An independent security test and a
  data-protection review (for example India's DPDP Act 2023) are wise before
  real hospital use.

## 8. Future scope

- **Approved evacuation plans:** save a run's routes as a named plan
  (draft → approved), print it per ward, and compare plans over time. This
  uses the existing `evacuation_plans` table.
- **Official alerts:** current NDMA SACHET alerts for the hospital's state on
  the Dashboard (free public feeds).
- **Wind-aware smoke:** use the wind direction in the smoke spread model,
  validated against fire-safety guidance before use.
- **Wildfire context:** NASA FIRMS satellite fire hotspots near the hospital
  (free key).
- **Drills:** compare a real drill's timings with the simulation to
  calibrate the speed parameters.
- **Floor plans from drawings:** import a scanned floor plan as a background
  for the Graph Builder.
- **Notifications:** e-mail or messaging alerts to staff during an exercise.
- **Mobile view for staff** during drills, and other languages (Hindi,
  Marathi).
- **More hospitals on one server:** tested hosting on a real server with
  monitoring and off-site backups.
