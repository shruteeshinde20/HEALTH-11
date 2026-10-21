"""Load a complete DEMO hospital into the DEVELOPMENT database, for demonstrations.

Everything is made up and labelled so:
  - organization "DEMO City Hospital Group (made-up data)" with three accounts
    (Administrator, Emergency Commander, Staff User) sharing one password;
  - "DEMO City Hospital" (map position: central Pune, address made up), one
    building with three floors: wards, ICU, operating theatre, emergency,
    pharmacy, kitchen, store rooms, corridors, two stair cores (A and B), a
    protected evacuation lift on every floor, an entrance ramp, two exits and
    an assembly point; floors joined by the stairs and the lift;
  - about 40 synthetic patients (every mobility type) and 15 synthetic staff,
    drawn with a fixed random seed (same people every time, none typed in);
  - default simulation parameters (source "assumed, to be validated");
  - 5 showcase scenarios and 10 varied training scenarios (seeded);
  - 60 real simulation runs (15 scenarios x BFS, DFS, Dijkstra, A*), so the
    evacuation-time predictor (needs 30) and unusual-run alerts (need 50) work.

Everything goes through the app's own API (same checks and audit log as the
website) in ONE database transaction: all of it is saved or nothing is. It
refuses unless ENVIRONMENT=development, refuses the test databases, and does
nothing if this organization already exists. It runs about a minute.

    .\\.venv\\Scripts\\python.exe scripts\\seed_full_demo.py

The password is asked for (twice, never shown) or read from DEMO_ADMIN_PASSWORD.
"""

from __future__ import annotations

import logging
import random
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from seed_demo import PARAMETER_SOURCE, REFUSED_DATABASES, SeedError, _password  # noqa: E402

API = "/api/v1"
SEED = 2026

ORGANIZATION = "DEMO City Hospital Group (made-up data)"
HOSPITAL = "DEMO City Hospital"
ADDRESS = "Made-up address, central Pune (not a real hospital)"
POSITION = (18.5204, 73.8567)        # central Pune, so the weather box has a place
BUILDING = "DEMO Main Block"
ACCOUNTS = [  # (full name, e-mail, role); example.com is reserved for examples
    ("Demo Administrator", "city.admin@example.com", "Administrator"),
    ("Demo Commander", "city.commander@example.com", "Emergency Commander"),
    ("Demo Staff", "city.staff@example.com", "Staff User"),
]
ALGORITHMS = ("bfs", "dfs", "dijkstra", "astar")

# Stairs and corridors cannot take wheelchairs or stretchers; everything else can.
STAIR = {"width": 1.5, "max_flow": 40, "wheelchair_accessible": False, "stretcher_accessible": False}
FLAT = {"width": 2.4, "max_flow": 60}
LIFT = {"width": 2.0, "max_flow": 6}


def floor_plan(level: int) -> tuple[list[dict], list[tuple[str, str, float, dict]]]:
    """Places and paths of one floor. Distances in metres; x, y only place the drawing."""
    p = "G" if level == 0 else str(level)
    nodes = [
        {"name": f"{p} Corridor West", "type": "corridor", "x": 100, "y": 100, "capacity": 40},
        {"name": f"{p} Corridor Centre", "type": "corridor", "x": 220, "y": 100, "capacity": 40},
        {"name": f"{p} Corridor East", "type": "corridor", "x": 340, "y": 100, "capacity": 40},
        {"name": f"Stair A {p}", "type": "stair", "x": 60, "y": 180, "capacity": 30},
        {"name": f"Stair B {p}", "type": "stair", "x": 380, "y": 180, "capacity": 30},
        {"name": f"Lift E {p}", "type": "lift", "x": 220, "y": 190, "capacity": 8, "is_evacuation_lift": True},
    ]
    edges = [
        (f"{p} Corridor West", f"{p} Corridor Centre", 24, FLAT),
        (f"{p} Corridor Centre", f"{p} Corridor East", 24, FLAT),
        (f"{p} Corridor West", f"Stair A {p}", 9, FLAT),
        (f"{p} Corridor East", f"Stair B {p}", 9, FLAT),
        (f"{p} Corridor Centre", f"Lift E {p}", 11, FLAT),
    ]
    if level == 0:
        rooms = [("Emergency", "ward", 100, 30, 12), ("OPD", "room", 220, 30, 20),
                 ("Pharmacy", "room", 340, 30, 6), ("Radiology", "room", 100, 170, 8),
                 ("Kitchen", "room", 300, 170, 6)]
        nodes += [
            {"name": "Entrance Ramp", "type": "ramp", "x": 20, "y": 100, "capacity": 20},
            {"name": "Main Entrance Exit", "type": "exit", "x": -40, "y": 100, "capacity": 0},
            {"name": "East Exit", "type": "exit", "x": 440, "y": 100, "capacity": 0},
            {"name": "Assembly Point", "type": "assembly", "x": -100, "y": 100, "capacity": 0},
        ]
        edges += [
            ("G Corridor West", "Entrance Ramp", 10, FLAT),
            ("Entrance Ramp", "Main Entrance Exit", 8, FLAT),
            ("G Corridor East", "East Exit", 12, FLAT),
            ("Main Entrance Exit", "Assembly Point", 30, FLAT),
        ]
    elif level == 1:
        rooms = [("Ward 1A", "ward", 100, 30, 20), ("Ward 1B", "ward", 340, 30, 20),
                 ("ICU", "icu", 220, 30, 8), ("Nurses Station 1", "room", 160, 170, 6),
                 ("Store Room 1", "room", 280, 170, 2)]
    else:
        rooms = [("Ward 2A", "ward", 100, 30, 20), ("Ward 2B", "ward", 340, 30, 20),
                 ("Operating Theatre", "room", 220, 30, 6), ("Recovery", "ward", 160, 170, 6),
                 ("Store Room 2", "room", 280, 170, 2)]
    corridor_for = {100: "West", 160: "Centre", 220: "Centre", 280: "Centre", 300: "East", 340: "East"}
    for name, kind, x, y, capacity in rooms:
        nodes.append({"name": name, "type": kind, "x": x, "y": y, "capacity": capacity})
        corridor = f"{p} Corridor {corridor_for[x]}"
        edges.append((name, corridor, 8 if y < 100 else 10, FLAT))
    return nodes, edges


# Who is where: (place, count, {mobility: weight}, (lowest, highest criticality))
PATIENT_PLACES = [
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
STAFF_PLACES = [  # (place, role, count)
    ("Emergency", "doctor", 1), ("Emergency", "nurse", 2), ("G Corridor Centre", "porter", 1),
    ("Nurses Station 1", "nurse", 3), ("ICU", "doctor", 1), ("1 Corridor East", "porter", 1),
    ("Recovery", "nurse", 2), ("Operating Theatre", "doctor", 1), ("Operating Theatre", "nurse", 1),
    ("2 Corridor West", "porter", 2),
]
SHOWCASE = [  # (name, description, hazard type, origin, severity, spread m/min); None = drill
    ("DEMO: kitchen fire on the ground floor", "A fire starts in the Kitchen and spreads slowly.",
     "fire", "Kitchen", 4, 2.0),
    ("DEMO: fire in Store Room 1, next to the ICU", "A fast fire beside the ICU on floor 1.",
     "fire", "Store Room 1", 5, 3.0),
    ("DEMO: smoke spreading on floor 2", "Smoke from Store Room 2 spreads along floor 2.",
     "smoke", "Store Room 2", 4, 6.0),
    ("DEMO: chemical spill in the Pharmacy", "A hazardous-material spill on the ground floor.",
     "hazmat", "Pharmacy", 3, 1.0),
    ("DEMO: evacuation drill (no hazard)", "A calm drill: everyone leaves by the best usable route.",
     None, None, 0, 0.0),
]
TRAINING_SCENARIOS = 10


def build_people(rng: random.Random) -> tuple[list[dict], list[dict]]:
    patients, number = [], 0
    for place, count, weights, (low, high) in PATIENT_PLACES:
        kinds, w = list(weights), list(weights.values())
        for _ in range(count):
            number += 1
            patients.append({"patient_code": f"DEMO-P{number:03d}", "mobility": rng.choices(kinds, w)[0],
                             "criticality": rng.randint(low, high), "place": place})
    staff, number = [], 0
    for place, role, count in STAFF_PLACES:
        for _ in range(count):
            number += 1
            staff.append({"staff_code": f"DEMO-S{number:03d}", "role": role, "place": place,
                          "full_name": f"Synthetic {role.title()} {number:02d}"})
    return patients, staff


def training_scenarios(rng: random.Random, places: list[str]) -> list[tuple]:
    out = []
    for i in range(1, TRAINING_SCENARIOS + 1):
        kind = rng.choice(["fire", "smoke", "hazmat", "structural"])
        origin = rng.choice(places)
        severity = rng.randint(2, 5)
        spread = round(rng.uniform(0.5, 8.0), 1)
        out.append((f"DEMO training {i:02d}: {kind} at {origin}",
                    f"Generated for training the evacuation-time predictor (severity {severity}, "
                    f"spreads {spread} m/min).", kind, origin, severity, spread))
    return out


def load_full_demo(client, password: str, *, run_simulations: bool = True) -> dict:
    """Create the full demo through the API. `client` is a FastAPI TestClient
    whose database session belongs to the caller's transaction."""
    rng = random.Random(SEED)

    def call(method: str, path: str, expected: int, **kwargs) -> dict:
        response = client.request(method, f"{API}{path}", **kwargs)
        if response.status_code != expected:
            try:
                message = response.json().get("error", {}).get("message", "")
            except ValueError:
                message = ""
            raise SeedError(f"{method} {path} answered {response.status_code}: {message}")
        return response.json()

    admin_name, admin_email, _ = ACCOUNTS[0]
    registered = call("POST", "/auth/register-organization", 201, json={
        "organization_name": ORGANIZATION, "full_name": admin_name, "email": admin_email, "password": password})
    auth = {"Authorization": f"Bearer {registered['access_token']}"}

    def post(path: str, body: dict) -> dict:
        return call("POST", path, 201, headers=auth, json=body)

    for full_name, email, role in ACCOUNTS[1:]:
        post("/users", {"email": email, "full_name": full_name, "role": role, "password": password})

    hospital = post("/hospitals", {"name": HOSPITAL, "address": ADDRESS, "timezone": "Asia/Kolkata",
                                   "latitude": POSITION[0], "longitude": POSITION[1]})
    building = post("/buildings", {"hospital_id": hospital["id"], "name": BUILDING,
                                   "description": "Made-up three-storey block for demonstration"})

    ids: dict[str, int] = {}
    for level, name in enumerate(("Ground floor", "First floor", "Second floor")):
        floor = post("/floors", {"building_id": building["id"], "floor_number": level, "name": name,
                                 "elevation_metres": level * 4.0})
        nodes, edges = floor_plan(level)
        for node in nodes:
            ids[node["name"]] = post("/nodes", {"floor_id": floor["id"], **node})["id"]
        for a, b, metres, flags in edges:
            post("/edges", {"from_node_id": ids[a], "to_node_id": ids[b], "distance": metres, **flags})
    for lower, upper in (("G", "1"), ("1", "2")):
        post("/edges", {"from_node_id": ids[f"Stair A {lower}"], "to_node_id": ids[f"Stair A {upper}"],
                        "distance": 12, **STAIR})
        post("/edges", {"from_node_id": ids[f"Stair B {lower}"], "to_node_id": ids[f"Stair B {upper}"],
                        "distance": 12, **STAIR})
        post("/edges", {"from_node_id": ids[f"Lift E {lower}"], "to_node_id": ids[f"Lift E {upper}"],
                        "distance": 4, **LIFT})

    specs = call("GET", "/parameters/specs", 200, headers=auth)
    for spec in specs:
        post("/parameters", {"name": spec["name"], "value": f"{spec['default']:g}",
                             "unit": spec["unit"], "source": PARAMETER_SOURCE})

    patients, staff = build_people(rng)
    for person in patients:
        place = person.pop("place")
        post("/patients", {**person, "node_id": ids[place], "is_synthetic": True})
    for person in staff:
        place = person.pop("place")
        post("/staff", {**person, "node_id": ids[place], "is_synthetic": True})

    hazard_places = [n["name"] for level in range(3) for n in floor_plan(level)[0]
                     if n["type"] in {"room", "ward", "icu", "corridor"}]
    scenario_ids = []
    for name, description, kind, origin, severity, spread in SHOWCASE + training_scenarios(rng, hazard_places):
        hazards = [] if kind is None else [{"name": f"{kind.title()} at {origin}", "type": kind,
                                            "origin_node_id": ids[origin], "severity": severity,
                                            "spread_rate": spread}]
        scenario_ids.append(post("/scenarios", {"name": name, "description": f"Made-up. {description}",
                                                "hazards": hazards})["id"])

    runs = 0
    if run_simulations:
        for scenario_id in scenario_ids:
            for algorithm in ALGORITHMS:
                post("/simulate", {"scenario_id": scenario_id, "algorithm": algorithm,
                                   "building_id": building["id"]})
                runs += 1

    return {"organization": registered["organization"], "hospital_id": hospital["id"],
            "building_id": building["id"], "node_ids": ids, "places": len(ids),
            "patients": len(patients), "staff": len(staff), "parameters": len(specs),
            "scenario_ids": scenario_ids, "runs": runs, "accounts": [a[1] for a in ACCOUNTS]}


def main() -> int:
    from sqlalchemy import create_engine, make_url, select
    from sqlalchemy.orm import Session, sessionmaker

    from app.config import get_settings

    settings = get_settings()
    if settings.environment != "development":
        raise SeedError(f"ENVIRONMENT is {settings.environment!r}. The demo data is for development "
                        "only and is never loaded into production or test databases.")
    url = make_url(settings.resolved_database_url)
    print(f"Target database: {url.host}:{url.port}/{url.database}")
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with engine.connect() as connection:
            name = connection.exec_driver_sql("SELECT current_database()").scalar_one()
            if name in REFUSED_DATABASES:
                raise SeedError(f"Refusing {name!r}: that database belongs to the automated tests.")
            from app.models import Organization

            existing = connection.execute(select(Organization.slug).where(
                Organization.name == ORGANIZATION, Organization.deleted_at.is_(None))).scalar()
        if existing:
            print(f"The full demo is already loaded (Organization ID {existing}); nothing was changed.")
            return 0

        password = _password()
        logging.getLogger("httpx").setLevel(logging.WARNING)
        print("Loading the demo hospital and running 60 simulations (about a minute) ...")

        from fastapi.testclient import TestClient

        from app.db_session import get_db
        from app.main import app

        connection = engine.connect()
        transaction = connection.begin()
        session = sessionmaker(bind=connection, class_=Session, expire_on_commit=False,
                               join_transaction_mode="create_savepoint")()

        def demo_db():
            yield session

        app.dependency_overrides[get_db] = demo_db
        try:
            with TestClient(app) as client:
                summary = load_full_demo(client, password)
            transaction.commit()
        except BaseException:
            transaction.rollback()
            raise
        finally:
            app.dependency_overrides.pop(get_db, None)
            session.close()
            connection.close()
    finally:
        engine.dispose()

    print("")
    print("Full DEMO hospital loaded (all made-up):")
    print(f"  Organization:    {summary['organization']['name']}")
    print(f"  Hospital:        {HOSPITAL} > {BUILDING} > 3 floors, {summary['places']} places")
    print(f"  People:          {summary['patients']} patients and {summary['staff']} staff, all synthetic")
    print(f"  Scenarios, runs: {len(summary['scenario_ids'])} scenarios, {summary['runs']} simulation runs")
    print("")
    print("Log in on the website with:")
    print(f"  Organization ID: {summary['organization']['slug']}")
    for full_name, email, role in ACCOUNTS:
        print(f"  {role + ':':22} {email}")
    print("  Password:              the one you just chose (the same for all three)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SeedError as error:
        print(f"Not loaded: {error}", file=sys.stderr)
        sys.exit(1)
