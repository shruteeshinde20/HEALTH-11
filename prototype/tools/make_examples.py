"""Writes the prototype's MADE-UP example files (nothing here is real data).

    python prototype/tools/make_examples.py

Outputs in prototype/examples/:
  demo-building.json        three-storey made-up hospital: places, paths,
                            patients, staff, sensors, cameras, scenarios
  fire-model-arrivals.csv   made-up "fire model" smoke arrival times, in the
                            format a hospital would export from its own model
  drill-observations.csv    made-up drill record, only to show the Drill check
                            page; real validation needs a real drill
  camera-counts.csv         made-up people counts per camera
"""

import csv
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "examples"
RNG = random.Random(11)

FLAT = {"width": 2.4}
DOOR = {"width": 1.2}
STAIR = {"width": 1.2, "wheelchair": False, "stretcher": False}


def floor(level):
    p = "G" if level == 0 else str(level)
    places = [
        {"id": f"{p} Corridor West", "type": "corridor", "x": 24, "y": 30, "w": 14, "l": 3},
        {"id": f"{p} Corridor Centre", "type": "corridor", "x": 48, "y": 30, "w": 34, "l": 3},
        {"id": f"{p} Corridor East", "type": "corridor", "x": 72, "y": 30, "w": 14, "l": 3},
        {"id": f"Stair A {p}", "type": "stair", "x": 15, "y": 30, "w": 4, "l": 4},
        {"id": f"Stair B {p}", "type": "stair", "x": 81, "y": 30, "w": 4, "l": 4},
        {"id": f"Lift E {p}", "type": "lift", "x": 48, "y": 41, "w": 3, "l": 3, "evacLift": True},
    ]
    paths = [
        (f"{p} Corridor West", f"{p} Corridor Centre", 24, FLAT),
        (f"{p} Corridor Centre", f"{p} Corridor East", 24, FLAT),
        (f"{p} Corridor West", f"Stair A {p}", 9, DOOR),
        (f"{p} Corridor East", f"Stair B {p}", 9, DOOR),
        (f"{p} Corridor Centre", f"Lift E {p}", 11, DOOR),
    ]
    if level == 0:
        rooms = [("Emergency", "ward", 24, 22, 20, 12, "West", 8), ("OPD", "room", 48, 22, 16, 12, "Centre", 8),
                 ("Pharmacy", "room", 72, 22, 10, 12, "East", 8), ("Radiology", "room", 30, 38, 8, 6, "West", 10),
                 ("Kitchen", "room", 66, 38, 8, 6, "East", 10)]
        places += [
            {"id": "Entrance Ramp", "type": "ramp", "x": 18, "y": 38, "w": 4, "l": 6},
            {"id": "Main Entrance Exit", "type": "exit", "x": 10, "y": 38, "w": 2, "l": 3},
            {"id": "East Exit", "type": "exit", "x": 85, "y": 30, "w": 2, "l": 3},
        ]
        paths += [
            ("G Corridor West", "Entrance Ramp", 10, FLAT),
            ("Entrance Ramp", "Main Entrance Exit", 8, FLAT),
            ("G Corridor East", "East Exit", 13, DOOR),
        ]
    elif level == 1:
        rooms = [("Ward 1A", "ward", 24, 22, 20, 12, "West", 8), ("Ward 1B", "ward", 72, 22, 20, 12, "East", 8),
                 ("ICU", "icu", 48, 22, 12, 12, "Centre", 8), ("Nurses Station 1", "room", 42, 38, 6, 6, "Centre", 10),
                 ("Store Room 1", "room", 54, 38, 6, 6, "Centre", 10)]
    else:
        rooms = [("Ward 2A", "ward", 24, 22, 20, 12, "West", 8), ("Ward 2B", "ward", 72, 22, 20, 12, "East", 8),
                 ("Operating Theatre", "room", 48, 22, 14, 12, "Centre", 8), ("Recovery", "ward", 42, 38, 6, 6, "Centre", 10),
                 ("Store Room 2", "room", 54, 38, 6, 6, "Centre", 10)]
    for name, kind, x, y, w, l, corridor, metres in rooms:
        places.append({"id": name, "type": kind, "x": x, "y": y, "w": w, "l": l})
        paths.append((name, f"{p} Corridor {corridor}", metres, DOOR))
    for place in places:
        place["floor"] = level
    return places, paths


PATIENTS = [  # (place, count, {mobility: weight}, (lowest, highest criticality))
    ("Emergency", 4, {"ambulatory": 2, "wheelchair": 1, "stretcher": 1}, (2, 5)),
    ("OPD", 5, {"ambulatory": 4, "wheelchair": 1}, (1, 2)),
    ("Ward 1A", 6, {"ambulatory": 3, "wheelchair": 2, "stretcher": 1}, (1, 4)),
    ("Ward 1B", 6, {"ambulatory": 3, "wheelchair": 2, "stretcher": 1}, (1, 4)),
    ("ICU", 4, {"stretcher": 1, "ventilator": 1}, (4, 5)),
    ("Ward 2A", 6, {"ambulatory": 3, "wheelchair": 2, "stretcher": 1}, (1, 4)),
    ("Ward 2B", 5, {"ambulatory": 3, "wheelchair": 1, "stretcher": 1}, (1, 4)),
    ("Recovery", 3, {"stretcher": 2, "wheelchair": 1}, (3, 4)),
    ("Operating Theatre", 1, {"ventilator": 1}, (5, 5)),
]
STAFF = [("Emergency", "doctor", 1), ("Emergency", "nurse", 2), ("G Corridor Centre", "porter", 1),
         ("Nurses Station 1", "nurse", 3), ("ICU", "doctor", 1), ("1 Corridor East", "porter", 1),
         ("Recovery", "nurse", 2), ("Operating Theatre", "doctor", 1), ("Operating Theatre", "nurse", 1),
         ("2 Corridor West", "porter", 2)]
CAMERAS = [("CAM-ED", "Emergency", 6), ("CAM-OPD", "OPD", 10), ("CAM-LOBBY", "G Corridor Centre", 4),
           ("CAM-1A", "Ward 1A", 3), ("CAM-2B", "Ward 2B", 2)]

SCENARIOS = [
    {"name": "Kitchen fire, ground floor", "alarm": "sensors",
     "note": "Fire starts in the Kitchen. Sensors must detect it and the commander confirms.",
     "hazards": [{"type": "fire", "origin": "Kitchen", "severity": 4, "spreadRate": 0.03},
                 {"type": "smoke", "origin": "Kitchen", "severity": 3, "spreadRate": 0.1}]},
    {"name": "Fire beside the ICU, floor 1", "alarm": "sensors",
     "note": "Fast fire in Store Room 1, next to the ICU and the evacuation lift lobby.",
     "hazards": [{"type": "fire", "origin": "Store Room 1", "severity": 5, "spreadRate": 0.05},
                 {"type": "smoke", "origin": "Store Room 1", "severity": 4, "spreadRate": 0.1}]},
    {"name": "Smoke spreading on floor 2", "alarm": "sensors",
     "note": "Heavy smoke from Store Room 2 blocks places as it spreads.",
     "hazards": [{"type": "smoke", "origin": "Store Room 2", "severity": 4, "spreadRate": 0.1}]},
    {"name": "Chemical spill in the Pharmacy", "alarm": "sensors",
     "note": "Hazardous material spreads slowly; gas sensors detect it.",
     "hazards": [{"type": "hazmat", "origin": "Pharmacy", "severity": 3, "spreadRate": 0.02}]},
    {"name": "Evacuation drill (no hazard)", "alarm": "start",
     "note": "Alarm sounds at the start; everyone leaves by the best usable route.", "hazards": []},
]


def main():
    places, paths = [], []
    for level in range(3):
        f_places, f_paths = floor(level)
        places += f_places
        paths += f_paths
    for lower, upper in (("G", "1"), ("1", "2")):
        paths.append((f"Stair A {lower}", f"Stair A {upper}", 12, STAIR))
        paths.append((f"Stair B {lower}", f"Stair B {upper}", 12, STAIR))
        paths.append((f"Lift E {lower}", f"Lift E {upper}", 4, DOOR))
    patients = []
    for place, count, weights, (low, high) in PATIENTS:
        for _ in range(count):
            patients.append({"code": f"DEMO-P{len(patients) + 1:03d}",
                             "mobility": RNG.choices(list(weights), list(weights.values()))[0],
                             "criticality": RNG.randint(low, high), "place": place})
    staff = []
    for place, role, count in STAFF:
        for _ in range(count):
            staff.append({"code": f"DEMO-S{len(staff) + 1:03d}", "role": role, "place": place})
    sensors = []
    for place in places:
        if place["type"] in ("ward", "icu", "room", "corridor"):
            sensors.append({"id": f"SD-{len(sensors) + 1:02d}", "kind": "smoke", "place": place["id"]})
    sensors.append({"id": "HD-01", "kind": "heat", "place": "Kitchen"})
    sensors.append({"id": "HD-02", "kind": "heat", "place": "Store Room 1"})
    sensors.append({"id": "GD-01", "kind": "gas", "place": "Pharmacy"})
    sensors.append({"id": "GD-02", "kind": "gas", "place": "G Corridor East"})
    building = {
        "name": "Demo Hospital (made-up)",
        "synthetic": True,
        "note": "MADE-UP data for demonstration. Not a real hospital, patient or staff member.",
        "floors": [{"number": 0, "name": "Ground floor"}, {"number": 1, "name": "First floor"},
                   {"number": 2, "name": "Second floor"}],
        "places": places,
        "paths": [{"a": a, "b": b, "length": m, **flags} for a, b, m, flags in paths],
        "patients": patients,
        "staff": staff,
        "sensors": sensors,
        "cameras": [{"id": i, "place": p, "count": c} for i, p, c in CAMERAS],
        "scenarios": SCENARIOS,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "demo-building.json").write_text(json.dumps(building, indent=1) + "\n", encoding="utf-8")

    # A made-up "fire model" export: smoke arrival time per place, from the Kitchen.
    with (OUT / "fire-model-arrivals.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["place", "hazard", "arrival_s", "severity"])
        for place, t in [("Kitchen", 0), ("G Corridor East", 95), ("Pharmacy", 160), ("G Corridor Centre", 210),
                         ("Stair B G", 150), ("East Exit", 240), ("OPD", 300), ("Stair B 1", 260),
                         ("1 Corridor East", 330), ("Ward 1B", 420), ("G Corridor West", 450)]:
            w.writerow([place, "smoke", t, 4])

    # A made-up drill record (random numbers, NOT from the simulator and NOT real).
    with (OUT / "drill-observations.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["code", "kind", "exit", "exit_time_s"])
        rows = []
        for p in patients:
            base = {"ambulatory": 150, "wheelchair": 420, "stretcher": 720, "ventilator": 840}[p["mobility"]]
            rows.append([p["code"], "patient", RNG.choice(["Main Entrance Exit", "East Exit"]),
                         round(base + RNG.uniform(-60, 240))])
        for s in staff:
            rows.append([s["code"], "staff", RNG.choice(["Main Entrance Exit", "East Exit"]),
                         round(900 + RNG.uniform(0, 300))])
        for row in sorted(rows, key=lambda r: r[3]):
            w.writerow(row)
    # Made-up camera people counts, as a people-counting system could export them.
    with (OUT / "camera-counts.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["camera", "count", "time"])
        for cam, place, count in CAMERAS:
            w.writerow([cam, max(0, count - 2), "2026-10-24T09:00:00"])
            w.writerow([cam, count + 3, "2026-10-24T09:05:00"])

    print("wrote", ", ".join(sorted(x.name for x in OUT.iterdir())))


if __name__ == "__main__":
    main()
