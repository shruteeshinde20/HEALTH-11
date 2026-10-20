"""Part 2 of the outside data: hospitals near a position from OpenStreetMap.

OpenStreetMap is never really called: requests go to httpx.MockTransport,
which plays the Overpass API.
"""

from urllib.parse import parse_qs

import httpx
import pytest
from app import outside_data_api
from app.config import Settings, get_settings
from app.db_session import get_db
from app.main import app
from app.services import openstreetmap
from fastapi.testclient import TestClient
from pydantic import ValidationError

API = "/api/v1"
PASSWORD = "StrongPassword!234"

# Shaped like a real Overpass answer: a node with an address, a way with a centre.
OVERPASS_ANSWER = {
    "version": 0.6, "generator": "Overpass API",
    "elements": [
        {"type": "way", "id": 222, "center": {"lat": 18.5300, "lon": 73.8567},
         "tags": {"amenity": "hospital", "name": "Far Hospital"}},
        {"type": "node", "id": 111, "lat": 18.5210, "lon": 73.8570,
         "tags": {"amenity": "hospital", "name": "Near Hospital", "addr:housenumber": "12",
                  "addr:street": "Station Road", "addr:city": "Pune", "addr:postcode": "411001"}},
        {"type": "node", "id": 333, "tags": {"name": "No position"}},
    ],
}


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


@pytest.fixture
def overpass(monkeypatch):
    """Fake Overpass server; records each request and answers `reply`."""
    state = {"requests": [], "reply": (200, OVERPASS_ANSWER)}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        status, body = state["reply"]
        if isinstance(body, Exception):
            raise body
        return httpx.Response(status, json=body)

    monkeypatch.setattr(outside_data_api, "OSM_TRANSPORT", httpx.MockTransport(handler))
    return state


def register(client, name="OSM Org", email="admin@example.com"):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": name, "full_name": "Admin", "email": email, "password": PASSWORD}).json()
    return {"Authorization": f"Bearer {body['access_token']}"}


def hospital(client, h, **extra):
    body = {"name": "City Hospital", "timezone": "Asia/Kolkata", "latitude": 18.5204, "longitude": 73.8567}
    response = client.post(f"{API}/hospitals", headers=h, json={**body, **extra})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def search(client, h, hospital_id, **params):
    return client.get(f"{API}/hospitals/{hospital_id}/openstreetmap", headers=h, params=params)


# --- The service ---------------------------------------------------------------------------

def test_query_asks_only_for_hospitals_around_the_position():
    query = openstreetmap.overpass_query(18.5204, 73.8567, 1500)
    assert 'nwr["amenity"="hospital"](around:1500,18.520400,73.856700);' in query
    assert query.startswith("[out:json]") and query.endswith("out center 25;")


def test_answers_are_parsed_sorted_and_given_addresses():
    places = openstreetmap.parse(OVERPASS_ANSWER, 18.5204, 73.8567)
    assert [p.name for p in places] == ["Near Hospital", "Far Hospital"]
    near, far = places
    assert near.address == "12 Station Road, Pune, 411001"
    assert near.url == "https://www.openstreetmap.org/node/111"
    assert (far.latitude, far.longitude, far.address) == (18.53, 73.8567, None)
    assert near.distance_m < far.distance_m


def test_distance_is_right():
    # 0.0096 degrees of latitude is about 1,067 m.
    assert openstreetmap.distance_m(18.5204, 73.8567, 18.5300, 73.8567) == pytest.approx(1067.5, abs=1)
    assert openstreetmap.parse({"elements": "not a list"}, 0, 0) == []


# --- The endpoint ----------------------------------------------------------------------------

def test_search_returns_places_with_source_and_licence(client, overpass):
    h = register(client)
    hospital_id = hospital(client, h)
    response = search(client, h, hospital_id, radius_m=2000)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["attribution"] == "© OpenStreetMap contributors (ODbL)"
    assert body["attribution_url"] == "https://www.openstreetmap.org/copyright"
    assert body["radius_m"] == 2000 and body["searched_at"]
    assert [p["name"] for p in body["places"]] == ["Near Hospital", "Far Hospital"]

    sent = overpass["requests"][0]
    assert sent.method == "POST" and str(sent.url) == "https://overpass-api.de/api/interpreter"
    assert "HEALTH-11" in sent.headers["user-agent"]
    assert "(around:2000,18.520400,73.856700)" in parse_qs(sent.content.decode())["data"][0]


def test_a_position_is_needed_first(client, overpass):
    h = register(client)
    hospital_id = hospital(client, h, latitude=None, longitude=None)
    response = search(client, h, hospital_id)
    assert response.status_code == 422 and "map position" in response.json()["error"]["message"]
    assert overpass["requests"] == []


@pytest.mark.parametrize("radius", [99, 5001, "far"])
def test_the_radius_is_limited(client, overpass, radius):
    h = register(client)
    assert search(client, h, hospital(client, h), radius_m=radius).status_code == 422


@pytest.mark.parametrize("reply, words", [
    ((429, {}), "busy"), ((504, {}), "busy"), ((500, {}), "error (500)"),
    ((200, ["not", "an", "object"]), None),
    ((200, httpx.ConnectError("down")), "could not be reached"),
])
def test_problems_at_openstreetmap_are_explained(client, overpass, reply, words):
    h = register(client)
    hospital_id = hospital(client, h)
    overpass["reply"] = reply
    response = search(client, h, hospital_id)
    if words is None:      # unreadable shape: simply nothing found
        assert response.status_code == 200 and response.json()["places"] == []
    else:
        assert response.status_code == 503 and words in response.json()["error"]["message"]


def test_searches_per_organization_are_limited(client, overpass, monkeypatch):
    monkeypatch.setattr(get_settings(), "osm_searches_per_organization_per_day", 2)
    h = register(client)
    hospital_id = hospital(client, h)
    assert [search(client, h, hospital_id).status_code for _ in range(3)] == [200, 200, 429]
    assert len(overpass["requests"]) == 2


def test_switched_off(client, overpass, monkeypatch):
    monkeypatch.setattr(get_settings(), "osm_enabled", False)
    h = register(client)
    response = search(client, h, hospital(client, h))
    assert response.status_code == 503 and overpass["requests"] == []


def test_only_editors_of_the_same_organization(client, overpass):
    h = register(client)
    hospital_id = hospital(client, h)
    other = register(client, "Other Org", "other@example.com")
    assert search(client, other, hospital_id).status_code == 404

    created = client.post(f"{API}/users", headers=h, json={
        "email": "staff@example.com", "full_name": "Staff", "role": "Staff User", "password": PASSWORD})
    assert created.status_code == 201, created.text
    login = client.post(f"{API}/auth/login", json={
        "organization_slug": "osm-org", "email": "staff@example.com", "password": PASSWORD})
    assert login.status_code == 200, login.text
    staff = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert search(client, staff, hospital_id).status_code == 403


def test_overpass_address_must_be_https_unless_on_this_computer():
    with pytest.raises(ValidationError, match="OVERPASS_URL"):
        Settings(_env_file=None, overpass_url="http://overpass.example.org/api/interpreter")
    Settings(_env_file=None, overpass_url="http://127.0.0.1:12345/api/interpreter")
