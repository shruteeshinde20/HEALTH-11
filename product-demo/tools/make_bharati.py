"""Writes the MADE-UP six-floor demo building used by the product demo.

    python product-demo/tools/make_bharati.py

The building is named after Bharati Hospital, Pune (Dhankawadi) for a student
demo only. The layout, departments, people, devices and scenarios are made up:
this is NOT the hospital's real floor plan, staff, patients or equipment, and
it must not be presented as such.

Layout (same on every floor): two long corridors joined at both ends and in
the middle, rooms on the outside of the corridors, a core between them, three
protected stairs (A north-west, C south-west, B east), two evacuation lifts (centre and west),
two fire compartments per floor (west and east, fire doors between them) and a
refuge on each side.

Output: product-demo/examples/bharati.json
"""

import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "examples"
RNG = random.Random(1964)

SEG_X = [14, 26, 38, 50, 62, 74, 86]
N_Y, S_Y = 14.0, 30.0
CORR_W = 2.4
ROOM_DOOR = 1.2
BED_DOOR = 1.4
FIRE_DOOR = 1.8
STAIR_DOOR = 1.2
COMPARTMENT_LINE = 44.0
FLOORS = 6

# north row (7), south row (7), core west (3: first is refuge on upper floors), core east (4: first next to the lift)
PROGRAM = {
    0: {
        "north": ["Casualty Resus", "Casualty Bays", "Triage", "X-Ray", "CT Scan", "MRI", "Kitchen"],
        "south": ["Pharmacy", "Entrance Hall", "OPD Waiting", "Cafeteria", "Laboratory", "Medical Records", "Plant Room"],
        "core_west": ["Waiting Area", "Billing", "Security Office"],
        "core_east": ["Porters", "Central Store", "Laundry", "Workshop"],
    },
    1: {
        "north": ["OPD Medicine", "OPD Surgery", "OPD Orthopaedics", "OPD ENT", "OPD Eye", "Physiotherapy", "Dialysis Unit"],
        "south": ["OPD Paediatrics", "Day Care", "OPD Gynaecology", "Blood Bank", "Dental", "Doctors Lounge", "Dialysis Recovery"],
        "core_west": ["Refuge West 1", "Sample Collection", "Sluice 1"],
        "core_east": ["Refuge East 1", "Store Room 1", "Staff Base 1", "Clean Utility 1"],
    },
    2: {
        "north": ["Male Medical Bay 1", "Male Medical Bay 2", "Male Medical Bay 3", "Nurses Station 2", "Female Medical Bay 1", "Female Medical Bay 2", "Female Medical Bay 3"],
        "south": ["Surgical Bay 1", "Day Room 2", "Surgical Bay 2", "Private Rooms 2", "Surgical Bay 3", "Isolation Rooms", "Store Room 2"],
        "core_west": ["Refuge West 2", "Treatment Room 2", "Sluice 2"],
        "core_east": ["Refuge East 2", "Linen Store 2", "Staff Base 2", "Clean Utility 2"],
    },
    3: {
        "north": ["MICU Bay 1", "MICU Bay 2", "MICU Bay 3", "ICU Nurses Station", "SICU Bay 1", "SICU Bay 2", "SICU Bay 3"],
        "south": ["HDU Bay 1", "ICU Relatives Room", "HDU Bay 2", "Cardiac Care Unit", "Neuro ICU", "ICU Doctors Room", "Store Room 3"],
        "core_west": ["Refuge West 3", "ICU Pharmacy", "Sluice 3"],
        "core_east": ["Refuge East 3", "Equipment Store 3", "Staff Base 3", "Clean Utility 3"],
    },
    4: {
        "north": ["OT 1", "OT 2", "OT 3", "Anaesthesia", "Recovery", "Pre-op Bay", "OT 4"],
        "south": ["CSSD", "Scrub Area", "Post-op Ward 1", "Post-op Ward 2", "Day Room 4", "Private Rooms 4", "Store Room 4"],
        "core_west": ["Refuge West 4", "Sterile Store", "Sluice 4"],
        "core_east": ["Refuge East 4", "Gas Manifold Room", "Staff Base 4", "Clean Utility 4"],
    },
    5: {
        "north": ["NICU Bay 1", "NICU Bay 2", "NICU Bay 3", "Labour Room", "Paediatric Ward 1", "Paediatric Ward 2", "PICU"],
        "south": ["Postnatal Ward 1", "Postnatal Ward 2", "Antenatal Ward", "Day Room 5", "Feeding Room", "Play Room", "Store Room 5"],
        "core_west": ["Refuge West 5", "Milk Room", "Sluice 5"],
        "core_east": ["Refuge East 5", "Incubator Store", "Staff Base 5", "Clean Utility 5"],
    },
}

WARD_WORDS = ("Bay", "Ward", "Recovery", "Dialysis", "Casualty", "HDU", "Unit", "Rooms", "Labour", "Pre-op", "PICU", "ICU")
ICU_WORDS = ("MICU", "SICU", "NICU", "PICU", "HDU", "Cardiac", "Neuro ICU")


def tag(level):
    return "G" if level == 0 else str(level)


def room_type(name):
    if any(name.startswith(w) or w in name for w in ICU_WORDS):
        return "icu"
    if any(w in name for w in WARD_WORDS) and "Store" not in name and "Doctors" not in name and "Relatives" not in name:
        return "ward"
    return "room"


def comp(x):
    return "west" if x < COMPARTMENT_LINE else "east"


def manhattan(a, b):
    return round(abs(a["x"] - b["x"]) + abs(a["y"] - b["y"]), 1)


def build():
    places, paths = [], []
    byid = {}

    def add(p):
        places.append(p)
        byid[p["id"]] = p
        return p

    def link(a, b, width, length=None, **flags):
        paths.append({"a": a, "b": b, "length": length if length is not None else manhattan(byid[a], byid[b]), "width": width, **flags})

    for level in range(FLOORS):
        t = tag(level)
        prog = PROGRAM[level]
        n_ids, s_ids = [], []
        for k, x in enumerate(SEG_X):
            n_ids.append(add({"id": f"{t} North {k + 1}", "type": "corridor", "x": x, "y": N_Y, "w": 12, "l": CORR_W, "floor": level, "compartment": comp(x), "sign": True})["id"])
            s_ids.append(add({"id": f"{t} South {k + 1}", "type": "corridor", "x": x, "y": S_Y, "w": 12, "l": CORR_W, "floor": level, "compartment": comp(x), "sign": True})["id"])
        xw = add({"id": f"{t} Cross West", "type": "corridor", "x": 6.8, "y": 22, "w": CORR_W, "l": 18.4, "floor": level, "compartment": "west", "sign": True})
        xc = add({"id": f"{t} Cross Centre", "type": "corridor", "x": 50, "y": 22, "w": CORR_W, "l": 13.6, "floor": level, "compartment": "east", "sign": True})
        xe = add({"id": f"{t} Cross East", "type": "corridor", "x": 93.2, "y": 22, "w": CORR_W, "l": 18.4, "floor": level, "compartment": "east", "sign": True})
        for k in range(6):
            fire_door = SEG_X[k] < COMPARTMENT_LINE < SEG_X[k + 1]
            w = FIRE_DOOR if fire_door else CORR_W
            link(n_ids[k], n_ids[k + 1], w, 12, fireDoor=fire_door)
            link(s_ids[k], s_ids[k + 1], w, 12, fireDoor=fire_door)
        for a, b in ((n_ids[0], xw["id"]), (s_ids[0], xw["id"]), (n_ids[3], xc["id"]), (s_ids[3], xc["id"]), (n_ids[6], xe["id"]), (s_ids[6], xe["id"])):
            link(a, b, CORR_W)

        for k, x in enumerate(SEG_X):
            for side, y, corridor in (("north", 7.4, n_ids[k]), ("south", 36.6, s_ids[k])):
                name = prog[side][k]
                rt = room_type(name)
                add({"id": name, "type": rt, "x": x, "y": y, "w": 12, "l": 10.8, "floor": level, "compartment": comp(x)})
                link(name, corridor, BED_DOOR if rt in ("ward", "icu") or name.startswith("OT ") else ROOM_DOOR)

        # West evacuation lift beside Cross West, then the core rooms
        lift_w = add({"id": f"Lift W {t}", "type": "lift", "x": 10.4, "y": 18.2, "w": 4.8, "l": 6, "floor": level, "compartment": "west", "evacLift": True})
        link(lift_w["id"], xw["id"], STAIR_DOOR)
        for (x0, x1), name in zip([(12.8, 21.6), (21.6, 35.2), (35.2, 48.8)], prog["core_west"]):
            cx = round((x0 + x1) / 2, 1)
            refuge = name.startswith("Refuge")
            add({"id": name, "type": "room", "x": cx, "y": 22, "w": round(x1 - x0, 1), "l": 13.6, "floor": level, "compartment": "west", **({"refuge": True} if refuge else {})})
            if refuge or cx < 20:
                link(name, n_ids[0], FIRE_DOOR if refuge else ROOM_DOOR)
            elif cx < 30:
                link(name, s_ids[1], ROOM_DOOR)
            else:
                link(name, n_ids[2], ROOM_DOOR)
        lift = add({"id": f"Lift {t}", "type": "lift", "x": 53.6, "y": 18.2, "w": 4.8, "l": 6, "floor": level, "compartment": "east", "evacLift": True})
        link(lift["id"], xc["id"], STAIR_DOOR)
        east = prog["core_east"]
        add({"id": east[0], "type": "room", "x": 53.6, "y": 25, "w": 4.8, "l": 7.6, "floor": level, "compartment": "east", **({"refuge": True} if east[0].startswith("Refuge") else {})})
        link(east[0], xc["id"], FIRE_DOOR)
        for (x0, x1), name, corridor in zip([(56.0, 68.0), (68.0, 80.0), (80.0, 92.0)], east[1:], [n_ids[4], s_ids[5], n_ids[6]]):
            add({"id": name, "type": "room", "x": (x0 + x1) / 2, "y": 22, "w": 12, "l": 13.6, "floor": level, "compartment": "east"})
            link(name, corridor, ROOM_DOOR)
        for sid, x, y in (("A", 3.6, 12.0), ("C", 3.6, 32.0), ("B", 96.4, 22.0)):
            st = add({"id": f"Stair {sid} {t}", "type": "stair", "x": x, "y": y, "w": 4, "l": 6, "floor": level, "compartment": "west" if sid != "B" else "east"})
            link(st["id"], xw["id"] if sid != "B" else xe["id"], STAIR_DOOR)

    for sid in ("A", "B", "C"):
        for level in range(FLOORS - 1):
            paths.append({"a": f"Stair {sid} {tag(level)}", "b": f"Stair {sid} {tag(level + 1)}", "length": 12, "width": STAIR_DOOR, "wheelchair": False, "stretcher": False})
    for level in range(FLOORS - 1):
        paths.append({"a": f"Lift {tag(level)}", "b": f"Lift {tag(level + 1)}", "length": 4, "width": 1.2})
        paths.append({"a": f"Lift W {tag(level)}", "b": f"Lift W {tag(level + 1)}", "length": 4, "width": 1.2})

    for p in (
        {"id": "Exit A", "type": "exit", "x": 0.6, "y": 12, "w": 2, "l": 3, "floor": 0},
        {"id": "Exit C", "type": "exit", "x": 0.6, "y": 32, "w": 2, "l": 3, "floor": 0},
        {"id": "Exit B", "type": "exit", "x": 99.4, "y": 22, "w": 2, "l": 3, "floor": 0},
        {"id": "Main Entrance", "type": "exit", "x": 26, "y": 43.5, "w": 6, "l": 3, "floor": 0},
        {"id": "Ambulance Bay", "type": "exit", "x": 14, "y": 0.5, "w": 6, "l": 3, "floor": 0},
        {"id": "West Door", "type": "exit", "x": 4.6, "y": 22, "w": 2, "l": 3, "floor": 0},
        {"id": "East Door", "type": "exit", "x": 93.2, "y": 32.7, "w": 2.4, "l": 3, "floor": 0},
    ):
        add({**p, "compartment": "outside"})
    paths += [
        {"a": "Stair A G", "b": "Exit A", "length": 4, "width": STAIR_DOOR},
        {"a": "Stair C G", "b": "Exit C", "length": 4, "width": STAIR_DOOR},
        {"a": "Stair B G", "b": "Exit B", "length": 4, "width": STAIR_DOOR},
        {"a": "Entrance Hall", "b": "Main Entrance", "length": 7, "width": 3.0},
        {"a": "Casualty Resus", "b": "Ambulance Bay", "length": 7, "width": 2.4},
        {"a": "G Cross West", "b": "West Door", "length": 3, "width": 1.8},
        {"a": "G Cross East", "b": "East Door", "length": 11, "width": 1.8},
    ]
    return places, paths


def mobility_mix(name):
    if name.startswith("NICU") or name.startswith("PICU"):
        return [("stretcher", 0.7), ("ventilator", 0.3)]
    if any(w in name for w in ("MICU", "SICU", "Neuro ICU", "Cardiac")):
        return [("ventilator", 0.5), ("stretcher", 0.5)]
    if name.startswith("HDU"):
        return [("stretcher", 0.6), ("wheelchair", 0.4)]
    if name.startswith("OT ") or name in ("Recovery",):
        return [("stretcher", 0.7), ("ventilator", 0.3)]
    if name.startswith("Casualty"):
        return [("ambulatory", 0.4), ("wheelchair", 0.2), ("stretcher", 0.4)]
    if name.startswith("Dialysis"):
        return [("ambulatory", 0.5), ("wheelchair", 0.5)]
    if name.startswith("OPD") or name.startswith("Day Room") or name in ("Triage", "X-Ray", "CT Scan", "MRI", "Physiotherapy", "Day Care", "Dental"):
        return [("ambulatory", 0.85), ("wheelchair", 0.15)]
    if name.startswith("Postnatal") or name == "Antenatal Ward":
        return [("ambulatory", 0.7), ("wheelchair", 0.2), ("stretcher", 0.1)]
    if name == "Labour Room":
        return [("stretcher", 1.0)]
    return [("ambulatory", 0.5), ("wheelchair", 0.25), ("stretcher", 0.25)]


def patient_count(name, rtype):
    if name.startswith("NICU"):
        return 4
    if rtype == "icu":
        return 3
    if name.startswith("OT "):
        return 1
    if name in ("Recovery", "Pre-op Bay", "Labour Room"):
        return 3
    if rtype == "ward":
        return 4
    if name.startswith("OPD") or name in ("Triage", "X-Ray", "CT Scan", "MRI", "Physiotherapy", "Dental") or name.startswith("Day Room"):
        return 3
    return 0


def people(places):
    patients, staff = [], []
    k = 0
    for p in places:
        n = p["id"]
        c = patient_count(n, p["type"])
        for _ in range(c):
            k += 1
            r = RNG.random()
            acc = 0
            mob = mobility_mix(n)[-1][0]
            for m, w in mobility_mix(n):
                acc += w
                if r <= acc:
                    mob = m
                    break
            crit = RNG.choice([4, 5]) if mob in ("ventilator", "stretcher") else RNG.choice([1, 2, 3])
            patients.append({"code": f"BH-P{k:03d}", "mobility": mob, "criticality": crit, "place": n})
    s = 0
    for p in places:
        n = p["id"]
        if p["type"] == "icu":
            c = 3
        elif p["type"] == "ward" or n.startswith("OT ") or n.startswith("Staff Base") or "Nurses Station" in n or n == "Anaesthesia":
            c = 2
        elif n in ("Pharmacy", "Kitchen", "Laboratory", "X-Ray", "CT Scan", "MRI", "Triage", "Porters", "Billing", "Security Office", "CSSD", "Blood Bank", "ICU Doctors Room", "Doctors Lounge") or n.startswith("OPD"):
            c = 1
        else:
            continue
        for _ in range(c):
            s += 1
            role = "doctor" if s % 4 == 0 else ("porter" if s % 9 == 0 else "nurse")
            staff.append({"code": f"BH-S{s:03d}", "role": role, "place": n})
    return patients, staff


def devices(places):
    sensors, cameras = [], []
    k = 0
    for p in places:
        n = p["id"]
        if p["type"] == "exit":
            continue
        if p["type"] in ("corridor", "lift", "stair") or RNG.random() < 0.7:
            k += 1
            sensors.append({"id": f"SD-{k:03d}", "kind": "smoke", "place": n})
        if any(w in n for w in ("Kitchen", "Plant", "Laundry", "Store", "OT ", "Workshop", "Gas Manifold", "Incubator")):
            k += 1
            sensors.append({"id": f"HD-{k:03d}", "kind": "heat", "place": n})
        if "Cross" in n:
            k += 1
            sensors.append({"id": f"CO-{k:03d}", "kind": "co", "place": n})
    for cid, place, count in (
        ("CAM-HALL", "Entrance Hall", 18), ("CAM-OPDW", "OPD Waiting", 16), ("CAM-CAFE", "Cafeteria", 12), ("CAM-WAIT", "Waiting Area", 8),
        ("CAM-ICUR", "ICU Relatives Room", 8), ("CAM-PN1", "Postnatal Ward 1", 5), ("CAM-PN2", "Postnatal Ward 2", 5),
        ("CAM-DAY2", "Day Room 2", 4), ("CAM-DAY5", "Day Room 5", 4), ("CAM-DCARE", "Day Care", 6),
    ):
        cameras.append({"id": cid, "place": place, "count": count})
    return sensors, cameras


SCENARIOS = [
    {"name": "Short circuit in Store Room 3 beside the ICUs (floor 3)", "alarm": "sensors", "origin": "Store Room 3", "start": 0, "smokeRate": 0.10, "fireRate": 0.012,
     "note": "A store room next to intensive care catches fire; ventilated patients need two staff each. Similar in type to the 2016 Bhubaneswar hospital fire, where a store room next to an ICU burned."},
    {"name": "Equipment fire in NICU Bay 2 (floor 5)", "alarm": "sensors", "origin": "NICU Bay 2", "start": 0, "smokeRate": 0.12, "fireRate": 0.015,
     "note": "Fire starts inside a newborn unit; incubators must be moved by staff. Similar in type to the 2021 Bhandara and 2024 Jhansi newborn-unit fires."},
    {"name": "Fire in the Central Store, ground floor (smoke rises)", "alarm": "sensors", "origin": "Central Store", "start": 0, "smokeRate": 0.09, "fireRate": 0.012,
     "note": "A store fire on the ground floor; smoke reaches the stairs after the protected doors fail. Similar in type to the 2011 Kolkata hospital fire that began in a store area."},
    {"name": "Kitchen fire, ground floor", "alarm": "sensors", "origin": "Kitchen", "start": 0, "smokeRate": 0.08, "fireRate": 0.012,
     "note": "Fire in the kitchen at the north-east corner of the ground floor."},
    {"name": "Fire in the Entrance Hall (main exit lost)", "alarm": "sensors", "origin": "Entrance Hall", "start": 0, "smokeRate": 0.10, "fireRate": 0.012,
     "note": "The main entrance, the exit most visitors know, is lost. Shows what happens when people do not follow guidance."},
    {"name": "Evacuation drill (no hazard)", "alarm": "start", "origin": None, "start": 0, "smokeRate": 0, "fireRate": 0,
     "note": "Alarm at the start, no fire. Used for the drill check."},
    {"name": "Drill with the Main Entrance closed", "alarm": "start", "origin": None, "start": 0, "smokeRate": 0, "fireRate": 0, "closed": ["Main Entrance"],
     "note": "Same drill with the main entrance out of use. Used as the second (hold-out) drill."},
]


def main():
    places, paths = build()
    patients, staff = people(places)
    sensors, cameras = devices(places)
    data = {
        "name": "Bharati Hospital, Pune (Dhankawadi) - Main Block",
        "synthetic": True,
        "note": "Made-up layout, departments, people and devices for a student demo. Not the hospital's real floor plan or data.",
        "familiarExit": "Main Entrance",
        "places": places,
        "paths": paths,
        "patients": patients,
        "staff": staff,
        "sensors": sensors,
        "cameras": cameras,
        "scenarios": SCENARIOS,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "bharati.json").write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    mob = {}
    for p in patients:
        mob[p["mobility"]] = mob.get(p["mobility"], 0) + 1
    vis = sum(c["count"] for c in cameras)
    print(f"places {len(places)}, paths {len(paths)}, patients {len(patients)} {mob}, staff {len(staff)}, visitors {vis}, total {len(patients) + len(staff) + vis}, sensors {len(sensors)}")


if __name__ == "__main__":
    main()
