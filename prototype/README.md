# HEALTH-11 evacuation prototype

A separate prototype that fills the gaps and known limits named in the
seminar slides. It does not change the main HEALTH-11 app. All example data is
made up.

## What it adds

| Gap or limit from the slides | In this prototype |
|---|---|
| Visitors not counted | Camera people counts become visitors |
| No live sensors | Smoke, heat and gas sensors raise alerts; the commander confirms or dismisses; a device simulator adds test alarms |
| No alarm delay | Alarm from sensor response + confirmation (or people who find the hazard); each person then has a reaction or preparation time |
| No crowd density, no slower stairs | SFPE speed-density relation S = k - a k D (a = 0.266, k = 1.40 m/s level, 1.08 m/s stairs) and flow limits per path |
| Staff not helping patients | Staff walk to patients, prepare them, escort them (2 per bed, 1 per wheelchair) and go back for others |
| Simplified hazards | Import of fire-model arrival times; protected stairs and lifts |
| Exit balancing was future work | Dijkstra and A* can count people already sent to each exit |
| Not validated | Drill check page compares a drill record with many runs (the example record is made up) |
| 3D view | three.js r185 (MIT, in `vendor/`), stacked floors, walls with doors, people, beds, wheelchairs, fire and smoke |

Every number and its source is on the Parameters page. Values without a
published source are marked "Assumed".

Sources: NIST TN 1722 (SFPE hydraulic model), Alonso-Gutierrez & Ronchi 2016
(FEMTC, hospital preparation times and speeds), Thunderhead Pathfinder SFPE
technical reference (minimum speed fraction, maximum density, stair k).

## Run it on Windows (PowerShell)

The page uses JavaScript modules, so open it through a small local web server,
not by double-clicking the file.

```powershell
cd C:\Users\shrut\HEALTH-11\prototype
python -m http.server 8765
```

Then open http://127.0.0.1:8765/index.html in Chrome or Edge. Stop the server
with Ctrl+C.

## Tests

Needs Node.js 22 or newer (no packages to install).

```powershell
cd C:\Users\shrut\HEALTH-11
node --test prototype/tests/engine.test.mjs prototype/tests/io.test.mjs
```

## Example files

`python prototype/tools/make_examples.py` rewrites the made-up files in
`examples/`. The drill record there is random numbers, not a real drill.

## Still open

- Validation with a real drill record.
- Connection to real sensors and cameras.
- Running a fire model (only its results are imported).
- Progressive horizontal evacuation to a neighbouring fire compartment
  (people without a safe route are shown as sheltering).
- Lift numbers and the space beds take are assumed until measured.
