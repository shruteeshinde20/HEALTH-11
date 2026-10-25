"""Writes the MADE-UP example hospital for the hazard-aware routing prototype.

    python hazard-routing/tools/make_examples.py

Nothing here is a real hospital, real patient or real measurement. The layout
is a plain three-storey block chosen so that routes have real choices:
two long corridors joined at both ends and in the middle, three protected
stairs, one evacuation lift, two fire compartments per floor (west and east)
with fire doors between them, and a refuge next to the stairs and the lift.

Output: hazard-routing/examples/hospital.json
(The drill files are made by tools/make_drills.mjs, because they need the
simulator itself.)
"""

import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "examples"
RNG = random.Random(2026)

SEG_X = [14, 26, 38, 50, 62, 74, 86]  # centres of the 12 m corridor segments
N_Y, S_Y = 14.0, 30.0  # north and south corridor centre lines
CORR_W = 2.4  # clear corridor width (m)
ROOM_DOOR = 1.2
BED_DOOR = 1.4
FIRE_DOOR = 1.8
STAIR_DOOR = 1.2
COMPARTMENT_LINE = 44.0  # fire doors between segment 3 and 4

PROGRAM = {
    0: {
        "north": ["Emergency Resus", "Emergency Bays", "Triage", "Radiology", "CT Scan", "Pharmacy", "Kitchen"],
        "south": ["Outpatients 1", "Entrance Hall", "Outpatients 2", "Cafe", "Laboratory", "Medical Records", "Plant Room"],
        "core_west": ["Waiting Area", "Admin", "Staff Room"],
        "core_east": ["Porters", "Store G", "Laundry", "Workshop"],
    },
    1: {
        "north": ["Ward 1A Bay 1", "Ward 1A Bay 2", "Ward 1A Bay 3", "Nurses Station 1", "ICU Bay 1", "ICU Bay 2", "ICU Bay 3"],
        "south": ["Ward 1A Bay 4", "Day Room 1", "Ward 1A Side Rooms", "Dialysis", "ICU Bay 4", "Ward 1B Bay 1", "Ward 1B Bay 2"],
        "core_west": ["Refuge West 1", "Treatment Room 1", "Sluice 1"],
        "core_east": ["Refuge East 1", "Store Room 1", "Staff Base 1", "Clean Utility 1"],
    },
    2: {
        "north": ["Theatre 1", "Theatre 2", "Theatre 3", "Anaesthesia", "Recovery", "Ward 2B Bay 1", "Ward 2B Bay 2"],
        "south": ["Ward 2A Bay 1", "Ward 2A Bay 2", "Ward 2A Bay 3", "Day Room 2", "Ward 2B Bay 3", "Ward 2B Side Rooms", "Store Room 2"],
        "core_west": ["Refuge West 2", "Sterile Store", "Scrub Room"],
        "core_east": ["Refuge East 2", "Sluice 2", "Staff Base 2", "Linen Store 2"],
    },
}


def tag(level):
    return "G" if level == 0 else str(level)


def room_type(name):
    if name.startswith("ICU"):
        return "icu"
    if "Ward" in name or name in ("Emergency Bays", "Emergency Resus", "Recovery", "Dialysis"):
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
        pa, pb = byid[a], byid[b]
        paths.append({"a": a, "b": b, "length": length if length is not None else manhattan(pa, pb), "width": width, **flags})

    for level in (0, 1, 2):
        t = tag(level)
        prog = PROGRAM[level]
        n_ids, s_ids = [], []
        for k, x in enumerate(SEG_X):
            n = add({"id": f"{t} North {k + 1}", "type": "corridor", "x": x, "y": N_Y, "w": 12, "l": CORR_W, "floor": level, "compartment": comp(x), "sign": True})
            s = add({"id": f"{t} South {k + 1}", "type": "corridor", "x": x, "y": S_Y, "w": 12, "l": CORR_W, "floor": level, "compartment": comp(x), "sign": True})
            n_ids.append(n["id"])
            s_ids.append(s["id"])
        xw = add({"id": f"{t} Cross West", "type": "corridor", "x": 6.8, "y": 22, "w": CORR_W, "l": 18.4, "floor": level, "compartment": "west", "sign": True})
        xc = add({"id": f"{t} Cross Centre", "type": "corridor", "x": 50, "y": 22, "w": CORR_W, "l": 13.6, "floor": level, "compartment": "east", "sign": True})
        xe = add({"id": f"{t} Cross East", "type": "corridor", "x": 93.2, "y": 22, "w": CORR_W, "l": 18.4, "floor": level, "compartment": "east", "sign": True})
        for k in range(6):
            fire_door = SEG_X[k] < COMPARTMENT_LINE < SEG_X[k + 1]
            w = FIRE_DOOR if fire_door else CORR_W
            link(n_ids[k], n_ids[k + 1], w, 12, fireDoor=fire_door)
            link(s_ids[k], s_ids[k + 1], w, 12, fireDoor=fire_door)
        link(n_ids[0], xw["id"], CORR_W)
        link(s_ids[0], xw["id"], CORR_W)
        link(n_ids[3], xc["id"], CORR_W)
        link(s_ids[3], xc["id"], CORR_W)
        link(n_ids[6], xe["id"], CORR_W)
        link(s_ids[6], xe["id"], CORR_W)

        # Rooms along the outside of each corridor
        for k, x in enumerate(SEG_X):
            for side, y, corridor in (("north", 7.4, n_ids[k]), ("south", 36.6, s_ids[k])):
                name = prog[side][k]
                rt = room_type(name)
                add({"id": name, "type": rt, "x": x, "y": y, "w": 12, "l": 10.8, "floor": level, "compartment": comp(x)})
                link(name, corridor, BED_DOOR if rt in ("ward", "icu") or name in ("Theatre 1", "Theatre 2", "Theatre 3", "Recovery") else ROOM_DOOR)

        # Core between the corridors
        west_x = [(8.0, 21.6), (21.6, 35.2), (35.2, 48.8)]
        for (x0, x1), name in zip(west_x, prog["core_west"]):
            cx = round((x0 + x1) / 2, 1)
            refuge = name.startswith("Refuge")
            add({"id": name, "type": "room", "x": cx, "y": 22, "w": round(x1 - x0, 1), "l": 13.6, "floor": level, "compartment": "west", **({"refuge": True} if refuge else {})})
            if refuge:
                link(name, xw["id"], FIRE_DOOR)
            elif cx < 30:
                link(name, s_ids[1], ROOM_DOOR)
            else:
                link(name, n_ids[2], ROOM_DOOR)
        lift = add({"id": f"Lift {t}", "type": "lift", "x": 53.6, "y": 18.2, "w": 4.8, "l": 6, "floor": level, "compartment": "east", "evacLift": True})
        link(lift["id"], xc["id"], STAIR_DOOR)
        east_rest = prog["core_east"]
        refuge_e = add({"id": east_rest[0], "type": "room", "x": 53.6, "y": 25, "w": 4.8, "l": 7.6, "floor": level, "compartment": "east", **({"refuge": True} if east_rest[0].startswith("Refuge") else {})})
        link(refuge_e["id"], xc["id"], FIRE_DOOR)
        for (x0, x1), name, corridor in zip([(56.0, 68.0), (68.0, 80.0), (80.0, 92.0)], east_rest[1:], [n_ids[4], s_ids[5], n_ids[6]]):
            cx = (x0 + x1) / 2
            add({"id": name, "type": "room", "x": cx, "y": 22, "w": 12, "l": 13.6, "floor": level, "compartment": "east"})
            link(name, corridor, ROOM_DOOR)

        # Protected stairs: A (north-west), C (south-west), B (east)
        for sid, x, y in (("A", 3.6, 12.0), ("C", 3.6, 32.0), ("B", 96.4, 22.0)):
            st = add({"id": f"Stair {sid} {t}", "type": "stair", "x": x, "y": y, "w": 4, "l": 6, "floor": level, "compartment": "west" if sid != "B" else "east"})
            link(st["id"], xw["id"] if sid != "B" else xe["id"], STAIR_DOOR)

    # Stairs and lift between floors (12 m along a flight pair and landing; 4 m per floor for the lift)
    for sid in ("A", "B", "C"):
        for level in (0, 1):
            paths.append({"a": f"Stair {sid} {tag(level)}", "b": f"Stair {sid} {tag(level + 1)}", "length": 12, "width": STAIR_DOOR, "wheelchair": False, "stretcher": False})
    for level in (0, 1):
        paths.append({"a": f"Lift {tag(level)}", "b": f"Lift {tag(level + 1)}", "length": 4, "width": 1.2})

    # Exits on the ground floor
    for p in (
        {"id": "Exit A", "type": "exit", "x": 0.6, "y": 12, "w": 2, "l": 3, "floor": 0},
        {"id": "Exit C", "type": "exit", "x": 0.6, "y": 32, "w": 2, "l": 3, "floor": 0},
        {"id": "Exit B", "type": "exit", "x": 99.4, "y": 22, "w": 2, "l": 3, "floor": 0},
        {"id": "Main Entrance", "type": "exit", "x": 26, "y": 43.5, "w": 6, "l": 3, "floor": 0},
        {"id": "West Door", "type": "exit", "x": 4.6, "y": 22, "w": 2, "l": 3, "floor": 0},
        {"id": "East Door", "type": "exit", "x": 93.2, "y": 32.7, "w": 2.4, "l": 3, "floor": 0},
    ):
        add({**p, "compartment": "outside"})
    paths += [
        {"a": "Stair A G", "b": "Exit A", "length": 4, "width": STAIR_DOOR},
        {"a": "Stair C G", "b": "Exit C", "length": 4, "width": STAIR_DOOR},
        {"a": "Stair B G", "b": "Exit B", "length": 4, "width": STAIR_DOOR},
        {"a": "Entrance Hall", "b": "Main Entrance", "length": 7, "width": 3.0},
        {"a": "G Cross West", "b": "West Door", "length": 3, "width": 1.8},
        {"a": "G Cross East", "b": "East Door", "length": 11, "width": 1.8},
    ]
    return places, paths


def people(places):
    patients, staff = [], []
    rooms = {p["id"]: p for p in places}

    def mix(name):
        if name.startswith("ICU"):
            return [("ventilator", 0.6), ("stretcher", 0.4)]
        if name.startswith("Theatre") or name == "Recovery":
            return [("stretcher", 0.7), ("ventilator", 0.3)]
        if name.startswith("Emergency"):
            return [("ambulatory", 0.4), ("wheelchair", 0.2), ("stretcher", 0.4)]
        if name == "Dialysis":
            return [("ambulatory", 0.5), ("wheelchair", 0.5)]
        if name.startswith("Outpatients") or name.startswith("Day Room") or name in ("Triage", "Radiology", "CT Scan"):
            return [("ambulatory", 0.85), ("wheelchair", 0.15)]
        return [("ambulatory", 0.5), ("wheelchair", 0.25), ("stretcher", 0.25)]

    counts = {}
    for p in places:
        n = p["id"]
        if p["type"] in ("ward", "icu"):
            counts[n] = 3 if p["type"] == "icu" else 4
        elif n.startswith("Theatre"):
            counts[n] = 1
        elif n in ("Triage", "Radiology", "CT Scan", "Outpatients 1", "Outpatients 2", "Day Room 1", "Day Room 2"):
            counts[n] = 3
    k = 0
    for name, c in counts.items():
        for _ in range(c):
            k += 1
            r = RNG.random()
            acc = 0
            mob = mix(name)[-1][0]
            for m, w in mix(name):
                acc += w
                if r <= acc:
                    mob = m
                    break
            crit = RNG.choice([4, 5]) if mob in ("ventilator", "stretcher") else RNG.choice([1, 2, 3])
            patients.append({"code": f"DEMO-P{k:03d}", "mobility": mob, "criticality": crit, "place": name})

    # Staff: two or three per clinical area, one in support rooms
    s = 0
    for p in places:
        n = p["id"]
        if p["type"] in ("ward", "icu") or n.startswith("Theatre") or n in ("Nurses Station 1", "Staff Base 1", "Staff Base 2", "Anaesthesia"):
            c = 3 if p["type"] == "icu" or n.startswith("Emergency") else 2
        elif n in ("Pharmacy", "Kitchen", "Laboratory", "Radiology", "Triage", "Porters", "Admin"):
            c = 1
        else:
            continue
        for _ in range(c):
            s += 1
            role = "nurse" if s % 3 else ("doctor" if p["type"] in ("ward", "icu") else "porter")
            staff.append({"code": f"DEMO-S{s:03d}", "role": role, "place": n})
    assert rooms
    return patients, staff


def devices(places):
    sensors, cameras = [], []
    k = 0
    for p in places:
        n = p["id"]
        if p["type"] in ("exit",):
            continue
        smoke = p["type"] in ("corridor", "lift") or (p["type"] != "stair" and RNG.random() < 0.7)
        if p["type"] == "stair":
            smoke = True
        if smoke:
            k += 1
            sensors.append({"id": f"SD-{k:03d}", "kind": "smoke", "place": n})
        if any(w in n for w in ("Kitchen", "Plant", "Laundry", "Store", "Theatre", "Linen", "Workshop")):
            k += 1
            sensors.append({"id": f"HD-{k:03d}", "kind": "heat", "place": n})
        if "Cross" in n:
            k += 1
            sensors.append({"id": f"CO-{k:03d}", "kind": "co", "place": n})
    for cid, place, count in (
        ("CAM-HALL", "Entrance Hall", 14), ("CAM-CAFE", "Cafe", 9), ("CAM-OPD1", "Outpatients 1", 6),
        ("CAM-OPD2", "Outpatients 2", 6), ("CAM-DAY1", "Day Room 1", 4), ("CAM-DAY2", "Day Room 2", 4),
        ("CAM-ICU", "ICU Bay 2", 3),
    ):
        cameras.append({"id": cid, "place": place, "count": count})
    return sensors, cameras


SCENARIOS = [
    {"name": "Kitchen fire, ground floor", "alarm": "sensors", "origin": "Kitchen", "start": 0, "smokeRate": 0.08, "fireRate": 0.012,
     "note": "Fire starts in the kitchen at the east end. Smoke moves west along the north corridor and towards Stair B."},
    {"name": "Store room fire beside the ICU, floor 1", "alarm": "sensors", "origin": "Store Room 1", "start": 0, "smokeRate": 0.10, "fireRate": 0.012,
     "note": "Fire in the store room next to the lift and the ICU. Ventilated patients need staff, the lift lobby is close to the fire."},
    {"name": "Fast smoke from Store Room 2, floor 2", "alarm": "sensors", "origin": "Store Room 2", "start": 0, "smokeRate": 0.18, "fireRate": 0.015,
     "note": "Fast smoke on the theatre floor; the south corridor fills first."},
    {"name": "Fire in the Entrance Hall", "alarm": "sensors", "origin": "Entrance Hall", "start": 0, "smokeRate": 0.10, "fireRate": 0.012,
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
        "name": "Demo hospital (made up)",
        "synthetic": True,
        "note": "Made-up building, people and devices for the prototype. Not a real hospital.",
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
    (OUT / "hospital.json").write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    mob = {}
    for p in patients:
        mob[p["mobility"]] = mob.get(p["mobility"], 0) + 1
    print(f"places {len(places)}, paths {len(paths)}, patients {len(patients)} {mob}, staff {len(staff)}, sensors {len(sensors)}, cameras {len(cameras)} ({sum(c['count'] for c in cameras)} visitors)")


if __name__ == "__main__":
    main()
