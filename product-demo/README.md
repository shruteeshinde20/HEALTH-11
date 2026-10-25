# HEALTH-11 end-product demo: Bharati Hospital, Pune (Dhankawadi)

A demo of what the finished HEALTH-11 app will look like, with the five
research gaps built in. It runs in the browser from local files. It does not
change the main HEALTH-11 app.

**Made-up data.** The floor plan, departments, patients, staff, visitors,
sensors, drill records and sensor recording are all made up for a student
project. They are **not** Bharati Hospital's real plan or data. The page says
this at the top of every screen. Keep this demo local: do not publish it under
the hospital's name.

## Run it on Windows (PowerShell)

The page uses JavaScript modules and a background worker, so open it through a
small local web server. Do not double-click the file.

```powershell
cd C:\Users\shrut\HEALTH-11\product-demo
python -m http.server 8765
```

Open http://127.0.0.1:8765/index.html in Chrome or Edge. To stop the server,
press Ctrl+C.

Demo log-ins (no password is stored, any password works):

| Role | Email | Pages |
|---|---|---|
| Administrator | admin@bharati-demo.example | all 11 pages |
| Emergency Commander | commander@bharati-demo.example | all except Admin |
| Staff User | staff@bharati-demo.example | Dashboard, Live Simulation, Patients & Staff, Reports & History, Settings |

Everything you change is saved in this browser only (localStorage). To start
again, go to Settings / Profile and choose "Reset all demo data".

## The building

The Main Block has 6 floors (ground to 5) with 265 places and 296 paths.

| Floor | Departments |
|---|---|
| Ground | Casualty, imaging, kitchen, pharmacy, entrance hall, stores |
| 1 | OPD clinics, dialysis, blood bank |
| 2 | Medical and surgical wards |
| 3 | ICUs: MICU, SICU, HDU, CCU, Neuro ICU |
| 4 | Operation theatres, recovery, CSSD |
| 5 | NICU, labour room, paediatric and postnatal wards |

The building also has:

- 3 protected stairs and 2 evacuation lifts;
- refuges in each fire compartment, plus 7 exits;
- 263 sensors and 10 people-counting cameras.

There are 431 people in the building:

- 205 patients: 94 walking, 36 in wheelchairs, 51 on stretchers and 24 on ventilators;
- 140 staff;
- 86 visitors.

There are 7 scenarios:

- fire in a store room beside the ICUs;
- fire in a NICU bay;
- fire in the central store;
- kitchen fire;
- fire in the entrance hall;
- evacuation drill;
- drill with the main entrance closed.

## Pages

These are the same pages and role rules as the main app.

| Page | What it shows | Research gap |
|---|---|---|
| Landing, Log in, Register, Get started (4 steps) | Product start, demo accounts, setup wizard that runs a first drill | |
| Dashboard | Building at a glance, recent runs, evacuation-time predictor, alerts | |
| Facility Manager | Hospitals, buildings, floors | |
| Graph Builder | Architectural floor plan. Click a room to edit it, add or delete places and paths, check for places with no way out, import or export JSON | 1 (step-free routes) |
| Scenario Builder | Fire origin, smoke speed, closed exits. Information settings per scenario (sensor faults, phones, compliance, failing signs) | 4 |
| Live Simulation | 2D plan and realistic 3D building (rooms, beds, people, smoke and flames, outside view, camera tour). Tabs for sensors, smart exit signs and fire brigade. Commander alerts, false alarm test, "Block a place now" | 1, 3, 4, 5 |
| Algorithm Comparison | BFS, DFS, Dijkstra and A* (static plan) against the hazard-aware method. Research methods under realistic and perfect information | 3, 4, 5 |
| Patients & Staff | Patients by code only, mobility, priority score with its rule, staff needed per floor, visitor counts, CSV import and export | 1 |
| AI Assistant | Type "fire in NICU Bay 2, spreading fast" and get a scenario to check and run | |
| Reports & History | Report for every run (print or PDF, CSV), drill check with calibration and hold-out test, sensor recording replay | 2, 5 |
| Admin | Users, roles, audit log | |
| Settings / Profile | Profile, password rules, every model parameter with its source | |

## What is honest to say about it

- **The assistant uses fixed rules, not an AI model.** It works in the browser
  and sends nothing. The main app sends this step to an AI model, using made-up
  data only.
- **The predictor is a simple model.** It is a straight-line (least-squares)
  model trained on your own saved runs. It needs at least 12 runs and is tested
  on held-out runs. It copies this simulator and does not measure real
  evacuations.
- **Unusual-run alerts need data.** They appear only after 50 runs.
- **The drill records are made up.** They come from this simulator, using
  hidden settings: people 10% slower and delays 25% longer. They only show that
  the drill check works.
  - In our browser check, calibration on drill A chose speed ×0.8 and delay
    ×1.25. On drill B, which was not used for fitting, the fit improved from
    4.77% to 1.37%.
  - This does not show that the model matches a real hospital.

## Tests

You need Node.js 22 or newer. There are no packages to install.

```powershell
cd C:\Users\shrut\HEALTH-11
node --test "product-demo/tests/*.test.mjs"
```

There are 15 tests. They cover:

- the building;
- the four classic algorithms;
- blocking a place during a run;
- all 7 scenarios, including the drills;
- the drill files and sensor replay;
- the store (log-in, audit, checking changes, saved runs);
- the assistant;
- the predictor, the priority score and the recommendations.

The tests read only the files in `examples/`. They use no database and no
network.

## Example files

```powershell
python product-demo/tools/make_bharati.py    # examples/bharati.json
node product-demo/tools/make_drills.mjs      # drill-a, drill-b, sensor-readings-kitchen
```

## Change to the engine compared with `hazard-routing/`

`engine.js` comes from the hazard-routing prototype, with these additions:

- the four classic algorithms (`classicRoute`, `options.algorithm`);
- `sim.blockPlace`;
- a coincidence check.

**The coincidence check.** It fixes a problem found by the tests: in a drill,
a single faulty sensor could make the planner move patients out of refuges on
several floors. Now people already safe in a refuge are moved again on a
forecast only in one of these cases:

- at least 2 detections come within 300 s of each other;
- someone sends a phone report;
- the commander confirms the alert (in manual mode).

Without one of these, people in a refuge move only on what is measured at that
refuge. One detection still raises the alarm and is still used for routing.

Results before and after the change, for runs 1 to 5:

- The fire scenarios gave the same results.
- In the drill, run 2 went from 394 of 431 people safe to 431.

The two new settings are in Settings / Profile:

- "Detections needed before people in a refuge are moved again on a forecast";
- "Detections confirm each other only within".

## Files

- `index.html`, `app.js` (shell, roles, navigation), `store.js` (demo data and audit log), `ui.js`
- `engine.js`, `io.js`, `worker.js`, `layout.js`, `plan2d.js`, `view3d.js`, `charts.js`
- `pages/` (one file per page, plus `shared.js` and `assistant-parse.js`)
- `vendor/` (three.js r185 and its licence), `examples/`, `tools/`, `tests/`

HEALTH-11 supports planning and training. It does not replace a hospital's
official emergency procedures or fire-safety professionals.
