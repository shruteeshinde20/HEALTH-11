"""Hospital map position (latitude and longitude), needed by the outside data sources.

Optional, decimal degrees (WGS 84), both or neither; the database refuses
anything else too.
"""

import pytest
from app.db_session import get_db
from app.main import app
from app.models.facility import Hospital
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


def register(client, name="Location Org"):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": name, "full_name": "Admin", "email": "admin@example.com",
        "password": PASSWORD}).json()
    return {"Authorization": f"Bearer {body['access_token']}"}


def create(client, h, **extra):
    return client.post(f"{API}/hospitals", headers=h,
                       json={"name": "City Hospital", "timezone": "Asia/Kolkata", **extra})


def test_position_is_optional_and_round_trips(client):
    h = register(client)
    plain = create(client, h)
    assert plain.status_code == 201, plain.text
    assert plain.json()["latitude"] is None and plain.json()["longitude"] is None

    placed = create(client, h, name="Placed Hospital", latitude=18.5204, longitude=73.8567)
    assert placed.status_code == 201, placed.text
    body = client.get(f"{API}/hospitals/{placed.json()['id']}", headers=h).json()
    assert (body["latitude"], body["longitude"]) == (18.5204, 73.8567)


@pytest.mark.parametrize("extra", [
    {"latitude": 18.5},                      # only one of the two
    {"longitude": 73.8},
    {"latitude": 90.0001, "longitude": 0},   # out of range
    {"latitude": -91, "longitude": 0},
    {"latitude": 0, "longitude": 180.5},
    {"latitude": 0, "longitude": -181},
    {"latitude": "north", "longitude": 0},   # not a number
])
def test_impossible_positions_are_refused(client, extra):
    h = register(client)
    response = create(client, h, **extra)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"]


def test_edges_of_the_ranges_are_accepted(client):
    h = register(client)
    for i, (lat, lon) in enumerate([(90, 180), (-90, -180), (0, 0)]):
        response = create(client, h, name=f"Edge {i}", latitude=lat, longitude=lon)
        assert response.status_code == 201, response.text


def test_update_sets_changes_and_clears_the_position(client):
    h = register(client)
    hospital_id = create(client, h).json()["id"]
    path = f"{API}/hospitals/{hospital_id}"

    assert client.patch(path, headers=h, json={"latitude": 19.076}).status_code == 422
    set_both = client.patch(path, headers=h, json={"latitude": 19.076, "longitude": 72.8777})
    assert set_both.status_code == 200 and set_both.json()["latitude"] == 19.076

    # Changing one keeps the other; other edits keep the position.
    moved = client.patch(path, headers=h, json={"longitude": 72.9})
    assert (moved.json()["latitude"], moved.json()["longitude"]) == (19.076, 72.9)
    renamed = client.patch(path, headers=h, json={"name": "Renamed Hospital"})
    assert renamed.json()["latitude"] == 19.076

    # Clearing only one is refused; clearing both works.
    assert client.patch(path, headers=h, json={"latitude": None}).status_code == 422
    cleared = client.patch(path, headers=h, json={"latitude": None, "longitude": None})
    assert cleared.status_code == 200
    assert cleared.json()["latitude"] is None and cleared.json()["longitude"] is None


def test_the_database_refuses_a_half_or_impossible_position(client, db_session):
    h = register(client)
    hospital_id = create(client, h).json()["id"]
    for values in ({"latitude": 10.0}, {"latitude": 95.0, "longitude": 0.0},
                   {"latitude": 0.0, "longitude": 200.0}):
        savepoint = db_session.begin_nested()
        with pytest.raises(IntegrityError):
            db_session.execute(update(Hospital).where(Hospital.id == hospital_id).values(**values))
            db_session.flush()
        savepoint.rollback()


def test_another_organization_cannot_read_or_move_the_position(client):
    owner = register(client, "Owner Org")
    hospital_id = create(client, owner, latitude=12.9716, longitude=77.5946).json()["id"]
    other = client.post(f"{API}/auth/register-organization", json={
        "organization_name": "Other Org", "full_name": "Admin", "email": "other@example.com",
        "password": PASSWORD}).json()
    stranger = {"Authorization": f"Bearer {other['access_token']}"}
    assert client.get(f"{API}/hospitals/{hospital_id}", headers=stranger).status_code == 404
    assert client.patch(f"{API}/hospitals/{hospital_id}", headers=stranger,
                        json={"latitude": 0, "longitude": 0}).status_code == 404
    assert client.get(f"{API}/hospitals/{hospital_id}", headers=owner).json()["latitude"] == 12.9716
