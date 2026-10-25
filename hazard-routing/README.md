# Hazard-aware evacuation routing prototype

A separate prototype for the seminar "Dynamic Hazard-Aware Evacuation Routing:
Adaptive Path Planning under Fire and Smoke". It does not change the main
HEALTH-11 app. The hospital, people, sensors, drill records and sensor
recordings in `examples/` are all made up.

## What it implements

The four layers of the proposed approach, repeated every 10 s (delta t):

| Layer | In the prototype |
|---|---|
| Sensing | Smoke, heat and CO sensors read every 5 s with noise; some are dead, stuck, read too high, lose readings, or burn out; camera counts give visitors; the building graph (places with area and capacity, paths with length and effective width) |
| Situation | Risk index and FED (ISO 13571 CO and heat terms); live estimate of the fire origin and smoke spread speed from debounced detections and phone reports, with outlier rejection; predicted smoke arrival at every place; crowd density per path |
| Decision | Places at or above theta at the time you would reach them are filtered out; route cost c(e,t) = d(e)/v(rho) + alpha * exposure(e, t_arrival) with v = k(1 - 0.266 rho), k = 1.40 m/s; congestion forecast from routes already given; Dijkstra to a virtual exit node; most exposed groups planned first; gamma-efficient alternatives; least-risk fallback or shelter; the commander confirms or dismisses alerts |
| Guidance | Dynamic exit signs (one backward search from the virtual exit); phone messages (delayed, some lost); radio for staff; rescue-team routes |

How it fills the five research gaps:

1. Mobility: walking patients, wheelchair and bed patients, staff and visitors; staff escort (2 per bed, 1 per wheelchair); no stairs for wheelchairs and beds; evacuation lift or refuge in the other fire compartment.
2. Validation: Drill check page compares the model with a drill record (curve, T50, T90, last out, per group, per exit) and calibrates speed and delay on one drill, then tests on another.
3. Hazard and crowding together: one cost with travel time at forecast density plus expected dose.
4. Imperfect information: phone share, compliance, familiar-exit behaviour, failed or smoke-hidden signs, lost messages, faulty sensors, false alarms.
5. Live hazard data: estimate from live or recorded readings (Sensors page, "Replay recorded readings"), compared with a fire model run before the event.

Methods compared: nearest exit (static plan), shortest safe path (filter only),
congestion-aware (no hazard forecast) and the proposed method; under realistic
information (live estimate or fire model run before) and perfect information.

## Run it on Windows (PowerShell)

The page uses JavaScript modules and a background worker, so open it through a
small local web server, not by double-clicking the file.

```powershell
cd C:\Users\shrut\HEALTH-11\hazard-routing
python -m http.server 8765
```

Then open http://127.0.0.1:8765/index.html in Chrome or Edge. Stop the server
with Ctrl+C.

## Tests

Needs Node.js 22 or newer (no packages to install).

```powershell
cd C:\Users\shrut\HEALTH-11
node --test hazard-routing/tests/engine.test.mjs hazard-routing/tests/io.test.mjs
```

The tests include the HEALTH-11 test case from PROJECT.md (walking and
stretcher routes, and with C1 blocked).

## Example files

```powershell
python hazard-routing/tools/make_examples.py   # examples/hospital.json
node hazard-routing/tools/make_drills.mjs      # drill-a, drill-b, sensor-readings-kitchen
```

The drill files are made by the simulator itself with hidden settings (people
10% slower, delays 25% longer, another seed, timing noise). They only show that
the comparison and calibration code work. They say nothing about how well the
model matches a real hospital.

## Known limits

- The fire and smoke are a simple spread model on the graph with assumed constants, not a CFD fire model.
- People move as a network flow (SFPE speed and density), not as individual agents.
- The live estimate assumes one origin and one spread speed.
- One drill record cannot separate walking speed from delay well, and run-to-run spread is large.
- Phone share, compliance and many hazard values are assumed; each is marked on the Parameters page.
- In the example hospital, crowding is light (patients leave a few at a time after staff prepare them), so the congestion term changes little there; the test with a crowded hall shows it splitting a crowd between two exits.
