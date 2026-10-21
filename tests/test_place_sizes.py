"""Place sizes in metres (width_m, length_m) for the floor-plan drawing:
API, database rules, and floor import / export."""

import csv
import io
import json

import pytest
from app.db_session import get_db
from app.main import app
from app.models import Node
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

API = "/api/v1"
PASSWORD = "StrongPassword!234"


@pytest.fixture
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


def setup_floor(client):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": "Size Org", "full_name": "Admin", "email": "admin@example.com",
        "password": PASSWORD}).json()
    h = {"Authorization": f"Bearer {body['access_token']}"}
    hospital = client.post(f"{API}/hospitals", headers=h, json={"name": "H", "timezone": "Asia/Kolkata"}).json()
    building = client.post(f"{API}/buildings", headers=h, json={"hospital_id": hospital["id"], "name": "B"}).json()
    floor = client.post(f"{API}/floors", headers=h, json={"building_id": building["id"], "name": "G",
                                                          "floor_number": 0}).json()
    return h, floor["id"]


def place(client, h, floor_id, name="Ward A", **extra):
    return client.post(f"{API}/nodes", headers=h, json={"floor_id": floor_id, "name": name, "type": "ward",
                                                        **extra})


def test_a_place_can_have_a_size_and_it_shows_everywhere(client):
    h, floor_id = setup_floor(client)
    created = place(client, h, floor_id, width_m=20, length_m=12.5)
    assert created.status_code == 201, created.text
    node = created.json()
    assert (node["width_m"], node["length_m"]) == (20, 12.5)

    graph = client.get(f"{API}/floors/{floor_id}/graph", headers=h).json()
    assert (graph["nodes"][0]["width_m"], graph["nodes"][0]["length_m"]) == (20, 12.5)

    changed = client.patch(f"{API}/nodes/{node['id']}", headers=h, json={"width_m": 22, "length_m": 14}).json()
    assert (changed["width_m"], changed["length_m"]) == (22, 14)
    cleared = client.patch(f"{API}/nodes/{node['id']}", headers=h, json={"width_m": None, "length_m": None})
    assert cleared.status_code == 200 and cleared.json()["width_m"] is None and cleared.json()["length_m"] is None


def test_without_a_size_nothing_changes(client):
    h, floor_id = setup_floor(client)
    node = place(client, h, floor_id).json()
    assert node["width_m"] is None and node["length_m"] is None
    renamed = client.patch(f"{API}/nodes/{node['id']}", headers=h, json={"name": "Ward B"})
    assert renamed.status_code == 200 and renamed.json()["width_m"] is None


@pytest.mark.parametrize("size", [
    {"width_m": 20},                       # one without the other
    {"length_m": 12},
    {"width_m": 0, "length_m": 5},         # not above 0
    {"width_m": 5, "length_m": -1},
    {"width_m": 1000.5, "length_m": 5},    # over 1,000 m
])
def test_bad_sizes_are_refused(client, size):
    h, floor_id = setup_floor(client)
    assert place(client, h, floor_id, **size).status_code == 422


def test_a_patch_cannot_leave_half_a_size(client):
    h, floor_id = setup_floor(client)
    node = place(client, h, floor_id, width_m=20, length_m=12).json()
    response = client.patch(f"{API}/nodes/{node['id']}", headers=h, json={"width_m": None})
    assert response.status_code == 422 and "both width and length" in response.json()["error"]["message"]
    other = place(client, h, floor_id, "Ward C").json()
    assert client.patch(f"{API}/nodes/{other['id']}", headers=h, json={"length_m": 8}).status_code == 422


def test_the_database_refuses_half_a_size(client, db_session):
    h, floor_id = setup_floor(client)
    node = place(client, h, floor_id, width_m=20, length_m=12).json()
    for values, rule in (({"length_m": None}, "ck_node_size_pair"), ({"width_m": 0.0}, "ck_node_width_range"),
                         ({"length_m": 1001.0}, "ck_node_length_range")):
        savepoint = db_session.begin_nested()
        with pytest.raises(IntegrityError, match=rule):
            db_session.execute(update(Node).where(Node.id == node["id"]).values(**values))
            db_session.flush()
        savepoint.rollback()


def test_sizes_go_out_and_come_back_in_every_file_format(client):
    h, floor_id = setup_floor(client)
    place(client, h, floor_id, "Ward A", width_m=20, length_m=12)
    place(client, h, floor_id, "Exit 1", type="exit")   # no size

    exported = {fmt: client.get(f"{API}/floors/{floor_id}/export", headers=h, params={"format": fmt}).text
                for fmt in ("json", "geojson", "csv")}
    nodes = {n["name"]: n for n in json.loads(exported["json"])["nodes"]}
    assert (nodes["Ward A"]["width_m"], nodes["Ward A"]["length_m"]) == (20, 12)
    assert nodes["Exit 1"]["width_m"] is None
    rows = {r["name"]: r for r in csv.DictReader(io.StringIO(exported["csv"])) if r["record_type"] == "node"}
    assert (rows["Ward A"]["width_m"], rows["Ward A"]["length_m"]) == ("20.0", "12.0")
    assert rows["Exit 1"]["width_m"] == ""

    for fmt, content_type in (("json", "application/json"), ("geojson", "application/geo+json"),
                              ("csv", "text/csv")):
        floor = client.post(f"{API}/floors", headers=h, json={
            "building_id": client.get(f"{API}/buildings", headers=h).json()["items"][0]["id"],
            "name": f"Copy {fmt}", "floor_number": {"json": 1, "geojson": 2, "csv": 3}[fmt]}).json()
        imported = client.post(f"{API}/floors/{floor['id']}/import", content=exported[fmt].encode(),
                               headers={**h, "Content-Type": content_type})
        assert imported.status_code == 201, (fmt, imported.text)
        copy = {n["name"]: n for n in client.get(f"{API}/floors/{floor['id']}/graph", headers=h).json()["nodes"]}
        assert (copy["Ward A"]["width_m"], copy["Ward A"]["length_m"]) == (20, 12), fmt
        assert copy["Exit 1"]["width_m"] is None and copy["Exit 1"]["length_m"] is None, fmt


def test_an_import_with_half_a_size_is_refused(client):
    h, floor_id = setup_floor(client)
    body = json.dumps({"nodes": [{"name": "Ward A", "type": "ward", "width_m": 20}], "edges": []})
    response = client.post(f"{API}/floors/{floor_id}/import", content=body.encode(),
                           headers={**h, "Content-Type": "application/json"})
    assert response.status_code == 422
