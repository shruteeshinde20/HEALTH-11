"""Load the DEMO organization into the DEVELOPMENT database (PROJECT.md, Data policy).

What it creates, all clearly labelled as made-up:
  - organization "DEMO Organization (made-up data)" with one Administrator;
  - "DEMO Hospital" > "DEMO Block A" > "Ground floor", holding PROJECT.md's
    Test case graph (ICU, WardA, C1, C2, S1, S2, R1, R2, E1, E2);
  - synthetic patients and staff (is_synthetic = true, codes start with DEMO-);
  - the default simulation parameters, with source "assumed, to be validated";
  - two scenarios: a drill without hazards, and the Test case fire at C1.

Everything goes through the app's own API (the same checks and audit log as
the website) inside ONE database transaction: either all of it is saved or
nothing is. It refuses to run unless ENVIRONMENT=development, refuses the test
databases, and does nothing if the DEMO organization already exists.

Run from the project folder (PowerShell):
    .\\.venv\\Scripts\\python.exe scripts\\seed_demo.py

The Administrator's password is asked for (typed twice, never shown), or read
from the DEMO_ADMIN_PASSWORD environment variable. It is never printed.
"""

from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

API = "/api/v1"

DEMO_ORGANIZATION = "DEMO Organization (made-up data)"
DEMO_ADMIN_NAME = "Demo Administrator"
DEMO_ADMIN_EMAIL = "demo.admin@example.com"  # example.com is reserved for examples
DEMO_HOSPITAL = "DEMO Hospital"
DEMO_ADDRESS = "Made-up address, for demonstration only (not a real hospital)"
DEMO_BUILDING = "DEMO Block A"
DEMO_FLOOR = "Ground floor"
PARAMETER_SOURCE = "assumed, to be validated"
REFUSED_DATABASES = {"health11_test", "health11_e2e"}

# PROJECT.md "Test case (must pass)". Coordinates only place the drawing.
# (name, type, x, y, capacity)
NODES = [
    ("ICU", "icu", 0, 0, 10),
    ("WardA", "ward", 200, 0, 20),
    ("C1", "corridor", 100, 100, 30),
    ("C2", "corridor", 300, 100, 30),
    ("S1", "stair", 0, 200, 20),
    ("S2", "stair", 400, 200, 20),
    ("R1", "ramp", 150, 200, 20),
    ("R2", "ramp", 300, 200, 20),
    ("E1", "exit", 100, 300, 0),
    ("E2", "exit", 350, 300, 0),
]
# (from, to, distance in metres); width 2 m and 60 people/min, accessible.
EDGES = [
    ("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18),
    ("R1", "E1", 15), ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12),
    ("C2", "S2", 10), ("S2", "E2", 25), ("C2", "R2", 16), ("R2", "E2", 20),
]
# Synthetic patients: (code, mobility, criticality 1-5, place)
PATIENTS = [
    ("DEMO-P01", "stretcher", 5, "ICU"),
    ("DEMO-P02", "ventilator", 5, "ICU"),
    ("DEMO-P03", "stretcher", 4, "ICU"),
    ("DEMO-P04", "wheelchair", 3, "WardA"),
    ("DEMO-P05", "wheelchair", 2, "WardA"),
    ("DEMO-P06", "ambulatory", 3, "WardA"),
    ("DEMO-P07", "ambulatory", 2, "WardA"),
    ("DEMO-P08", "ambulatory", 2, "WardA"),
    ("DEMO-P09", "ambulatory", 1, "WardA"),
    ("DEMO-P10", "ambulatory", 1, "WardA"),
]
# Synthetic staff: (code, full name, role, place)
STAFF = [
    ("DEMO-S01", "Synthetic Nurse 1", "nurse", "ICU"),
    ("DEMO-S02", "Synthetic Nurse 2", "nurse", "WardA"),
    ("DEMO-S03", "Synthetic Doctor 1", "doctor", "ICU"),
    ("DEMO-S04", "Synthetic Porter 1", "porter", "C2"),
]


class SeedError(Exception):
    """Something refused or failed; nothing was saved."""


def floor_csv() -> str:
    """The Test case graph in the floor import format (see README, floor import)."""
    header = ("record_type,name,type,x,y,capacity,is_blocked,is_evacuation_lift,"
              "from_node,to_node,distance,width,max_flow,wheelchair_accessible,stretcher_accessible")
    rows = [header]
    rows += [f"node,{name},{kind},{x},{y},{capacity},false,false,,,,,,," for name, kind, x, y, capacity in NODES]
    rows += [f"edge,,,,,,false,,{a},{b},{metres},2,60,true,true" for a, b, metres in EDGES]
    return "\r\n".join(rows) + "\r\n"


def load_demo(client, password: str) -> dict:
    """Create the DEMO organization through the API. `client` is a FastAPI
    TestClient whose database session belongs to the caller's transaction."""

    def call(method: str, path: str, expected: int, **kwargs) -> dict:
        response = client.request(method, f"{API}{path}", **kwargs)
        if response.status_code != expected:
            # The API's error message never contains submitted values (passwords).
            try:
                message = response.json().get("error", {}).get("message", "")
            except ValueError:
                message = ""
            raise SeedError(f"{method} {path} answered {response.status_code}: {message}")
        return response.json()

    registered = call("POST", "/auth/register-organization", 201, json={
        "organization_name": DEMO_ORGANIZATION, "full_name": DEMO_ADMIN_NAME,
        "email": DEMO_ADMIN_EMAIL, "password": password,
    })
    auth = {"Authorization": f"Bearer {registered['access_token']}"}

    def post(path: str, body: dict) -> dict:
        return call("POST", path, 201, headers=auth, json=body)

    hospital = post("/hospitals", {"name": DEMO_HOSPITAL, "address": DEMO_ADDRESS, "timezone": "UTC"})
    building = post("/buildings", {"hospital_id": hospital["id"], "name": DEMO_BUILDING,
                                   "description": "Made-up building for demonstration"})
    floor = post("/floors", {"building_id": building["id"], "floor_number": 0, "name": DEMO_FLOOR})
    imported = call("POST", f"/floors/{floor['id']}/import", 201,
                    headers={**auth, "Content-Type": "text/csv"}, content=floor_csv().encode("utf-8"))

    graph = call("GET", f"/floors/{floor['id']}/graph", 200, headers=auth)
    ids = {node["name"]: node["id"] for node in graph["nodes"]}

    specs = call("GET", "/parameters/specs", 200, headers=auth)
    for spec in specs:
        post("/parameters", {"name": spec["name"], "value": f"{spec['default']:g}",
                             "unit": spec["unit"], "source": PARAMETER_SOURCE})

    for code, mobility, criticality, place in PATIENTS:
        post("/patients", {"patient_code": code, "mobility": mobility, "criticality": criticality,
                           "node_id": ids[place], "is_synthetic": True})
    for code, name, role, place in STAFF:
        post("/staff", {"staff_code": code, "full_name": name, "role": role,
                        "node_id": ids[place], "is_synthetic": True})

    drill = post("/scenarios", {
        "name": "DEMO: evacuation drill (no hazard)",
        "description": "Made-up demonstration scenario: everyone leaves by the shortest usable route.",
        "hazards": [],
    })
    fire = post("/scenarios", {
        "name": "DEMO: fire at corridor C1 (PROJECT.md Test case)",
        "description": ("Made-up demonstration scenario. A fire blocks C1: walking from WardA goes "
                        "WardA, C2, S2, E2 (47 m); a stretcher from ICU goes ICU, C2, R2, E2 (50 m)."),
        "hazards": [{"name": "Fire at C1", "type": "fire", "origin_node_id": ids["C1"],
                     "spread_rate": 0, "severity": 5}],
    })

    return {
        "organization": registered["organization"],
        "admin_email": registered["user"]["email"],
        "hospital_id": hospital["id"],
        "building_id": building["id"],
        "floor_id": floor["id"],
        "nodes": imported["nodes_imported"],
        "edges": imported["edges_imported"],
        "parameters": len(specs),
        "patients": len(PATIENTS),
        "staff": len(STAFF),
        "scenario_ids": [drill["id"], fire["id"]],
    }


def _password() -> str:
    from app.auth import check_password_strength

    password = os.environ.get("DEMO_ADMIN_PASSWORD")
    if password is None:
        print("Choose a password for the DEMO Administrator (it is not shown while you type).")
        print("At least 12 characters, with a lowercase and an uppercase letter, a digit and a symbol.")
        password = getpass.getpass("Password: ")
        if getpass.getpass("Same password again: ") != password:
            raise SeedError("The two passwords are different; nothing was saved.")
    try:
        check_password_strength(password)
    except ValueError as exc:
        raise SeedError(f"{exc}; nothing was saved.") from None
    return password


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

            existing = connection.execute(
                select(Organization.slug).where(Organization.name == DEMO_ORGANIZATION,
                                                Organization.deleted_at.is_(None))
            ).scalar()
        if existing:
            print(f"The DEMO organization is already loaded (organization ID {existing}); nothing was changed.")
            return 0

        password = _password()

        # One transaction for everything: the API's own commits become
        # savepoints inside it, so a failure anywhere saves nothing.
        from fastapi.testclient import TestClient

        from app.db_session import get_db
        from app.main import app

        connection = engine.connect()
        transaction = connection.begin()
        DemoSession = sessionmaker(bind=connection, class_=Session, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")
        session = DemoSession()

        def demo_db():
            yield session

        app.dependency_overrides[get_db] = demo_db
        try:
            with TestClient(app) as client:
                summary = load_demo(client, password)
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

    organization = summary["organization"]
    print("")
    print("DEMO data loaded (all made-up):")
    print(f"  Organization:    {organization['name']}")
    print(f"  Hospital:        {DEMO_HOSPITAL} > {DEMO_BUILDING} > {DEMO_FLOOR}")
    print(f"  Floor graph:     {summary['nodes']} places, {summary['edges']} connections (PROJECT.md Test case)")
    print(f"  Parameters:      {summary['parameters']} defaults, source '{PARAMETER_SOURCE}'")
    print(f"  Patients, staff: {summary['patients']} and {summary['staff']}, all marked synthetic")
    print("  Scenarios:       2 (a drill, and the Test case fire at C1)")
    print("")
    print("Log in on the website with:")
    print(f"  Organization ID: {organization['slug']}")
    print(f"  Email:           {summary['admin_email']}")
    print("  Password:        the one you just chose")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SeedError as error:
        print(f"Not loaded: {error}", file=sys.stderr)
        sys.exit(1)
