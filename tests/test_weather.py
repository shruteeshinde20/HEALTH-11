"""Part 3 of the outside data: current weather at a hospital, from Open-Meteo.

Open-Meteo is never really called: requests go to httpx.MockTransport.
"""

import httpx
import pytest
from app import outside_data_api
from app.config import Settings, get_settings
from app.db_session import get_db
from app.main import app
from app.services import weather
from fastapi.testclient import TestClient
from pydantic import ValidationError

API = "/api/v1"
PASSWORD = "StrongPassword!234"

# Shaped like Open-Meteo's answer for current conditions.
ANSWER = {
    "latitude": 18.52, "longitude": 73.86, "utc_offset_seconds": 19800, "timezone": "Asia/Kolkata",
    "current": {"time": "2026-10-21T14:15", "interval": 900, "temperature_2m": 28.4,
                "relative_humidity_2m": 61, "wind_speed_10m": 12.6, "wind_direction_10m": 315,
                "wind_gusts_10m": 22.3},
}


@pytest.fixture(autouse=True)
def fresh_cache():
    weather.clear_cache()
    yield
    weather.clear_cache()


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
def meteo(monkeypatch):
    state = {"requests": [], "reply": (200, ANSWER)}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        status, body = state["reply"]
        if isinstance(body, Exception):
            raise body
        return httpx.Response(status, json=body)

    monkeypatch.setattr(outside_data_api, "WEATHER_TRANSPORT", httpx.MockTransport(handler))
    return state


def register(client, name="Weather Org", email="admin@example.com"):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": name, "full_name": "Admin", "email": email, "password": PASSWORD}).json()
    return {"Authorization": f"Bearer {body['access_token']}"}


def hospital(client, h, **extra):
    body = {"name": "City Hospital", "timezone": "Asia/Kolkata", "latitude": 18.5204, "longitude": 73.8567}
    response = client.post(f"{API}/hospitals", headers=h, json={**body, **extra})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def ask(client, h, hospital_id):
    return client.get(f"{API}/hospitals/{hospital_id}/weather", headers=h)


def test_compass_and_where_smoke_drifts():
    assert [weather.compass(d) for d in (0, 22.4, 22.5, 90, 180, 270, 315, 359.9)] == \
        ["N", "N", "NE", "E", "S", "W", "NW", "N"]
    w = weather.parse(ANSWER)
    assert (w.wind_from, w.smoke_drifts_toward) == ("NW", "SE")


def test_weather_with_source_licence_and_time(client, meteo):
    h = register(client)
    response = ask(client, h, hospital(client, h))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["attribution"] == "Weather data by Open-Meteo.com (CC BY 4.0)"
    assert "does not use the weather" in body["note"]
    assert (body["valid_at"], body["interval_seconds"], body["utc_offset_seconds"]) == ("2026-10-21T14:15", 900, 19800)
    assert (body["wind_speed_kmh"], body["wind_gusts_kmh"], body["wind_direction_deg"]) == (12.6, 22.3, 315)
    assert (body["wind_from"], body["smoke_drifts_toward"]) == ("NW", "SE")
    assert (body["temperature_c"], body["humidity_percent"]) == (28.4, 61)

    sent = meteo["requests"][0]
    assert str(sent.url).startswith("https://api.open-meteo.com/v1/forecast?")
    params = dict(sent.url.params)
    assert params["latitude"] == "18.5204" and params["longitude"] == "73.8567"
    assert params["current"] == ",".join(weather.VARIABLES)
    assert params["wind_speed_unit"] == "kmh" and params["timezone"] == "auto"
    assert "HEALTH-11" in sent.headers["user-agent"]


def test_answers_are_kept_for_a_while(client, meteo):
    h = register(client)
    hospital_id = hospital(client, h)
    assert ask(client, h, hospital_id).status_code == 200
    assert ask(client, h, hospital_id).status_code == 200
    assert len(meteo["requests"]) == 1


def test_missing_values_stay_missing(client, meteo):
    meteo["reply"] = (200, {"current": {"time": "2026-10-21T14:15", "wind_speed_10m": None}})
    h = register(client)
    body = ask(client, h, hospital(client, h)).json()
    assert body["wind_speed_kmh"] is None and body["wind_from"] is None and body["smoke_drifts_toward"] is None


def test_a_position_is_needed(client, meteo):
    h = register(client)
    response = ask(client, h, hospital(client, h, latitude=None, longitude=None))
    assert response.status_code == 422 and "map position" in response.json()["error"]["message"]
    assert meteo["requests"] == []


@pytest.mark.parametrize("reply, words", [
    ((429, {}), "limit"), ((500, {}), "error (500)"), ((200, {"no": "current"}), "without current"),
    ((200, httpx.ConnectError("down")), "could not be reached"),
])
def test_problems_are_explained(client, meteo, reply, words):
    meteo["reply"] = reply
    h = register(client)
    response = ask(client, h, hospital(client, h))
    assert response.status_code == 503 and words in response.json()["error"]["message"]


def test_calls_per_day_are_limited(client, meteo, monkeypatch):
    monkeypatch.setattr(get_settings(), "weather_requests_per_day", 1)
    h = register(client)
    first = hospital(client, h)
    second = hospital(client, h, name="Other Hospital", latitude=19.076, longitude=72.8777)
    assert ask(client, h, first).status_code == 200
    assert ask(client, h, second).status_code == 429


def test_switched_off_and_other_organizations(client, meteo, monkeypatch):
    h = register(client)
    hospital_id = hospital(client, h)
    other = register(client, "Other Org", "other@example.com")
    assert ask(client, other, hospital_id).status_code == 404
    monkeypatch.setattr(get_settings(), "weather_enabled", False)
    assert ask(client, h, hospital_id).status_code == 503
    assert meteo["requests"] == []


def test_open_meteo_address_must_be_https_unless_on_this_computer():
    with pytest.raises(ValidationError, match="OPEN_METEO_URL"):
        Settings(_env_file=None, open_meteo_url="http://weather.example.org/v1/forecast")
    Settings(_env_file=None, open_meteo_url="http://127.0.0.1:9999/v1/forecast")
