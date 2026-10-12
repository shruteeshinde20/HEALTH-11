import pytest
from fastapi.testclient import TestClient

from app.auth import get_current_user
from app.db_session import get_db
from app.main import app


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
def registration_payload():
    return {
        "organization_name": "Example Hospital",
        "full_name": "Test Administrator",
        "email": "admin@example.com",
        "password": "StrongPassword!234",
    }


def register(client, payload):
    response = client.post("/api/v1/auth/register-organization", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_register_creates_admin_and_authenticates(client, registration_payload):
    result = register(client, registration_payload)

    assert result["user"]["role"] == "administrator"
    assert result["user"]["email"] == "admin@example.com"
    assert result["organization"]["id"] == result["user"]["organization_id"]
    assert result["access_token"]
    assert result["refresh_token"]

    response = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {result['access_token']}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["id"] == result["user"]["id"]


def test_login_rejects_wrong_password(client, registration_payload):
    register(client, registration_payload)

    response = client.post(
        "/api/v1/auth/login",
        json={
            "organization_slug": "example-hospital",
            "email": "admin@example.com",
            "password": "WrongPassword!234",
        },
    )
    assert response.status_code == 401


def test_refresh_rotates_token_and_rejects_reuse(client, registration_payload):
    result = register(client, registration_payload)
    old_refresh = result["refresh_token"]

    response = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": old_refresh},
    )
    assert response.status_code == 200, response.text
    new_refresh = response.json()["refresh_token"]
    assert new_refresh != old_refresh

    reused = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": old_refresh},
    )
    assert reused.status_code == 401

    valid_new_token = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": new_refresh},
    )
    assert valid_new_token.status_code == 200, valid_new_token.text


def test_logout_revokes_refresh_token(client, registration_payload):
    result = register(client, registration_payload)

    response = client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": result["refresh_token"]},
    )
    assert response.status_code == 204, response.text

    reused = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": result["refresh_token"]},
    )
    assert reused.status_code == 401


def test_me_rejects_missing_or_invalid_access_token(client):
    missing = client.get("/api/v1/auth/me")
    assert missing.status_code == 401

    invalid = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": "Bearer not-a-valid-token"},
    )
    assert invalid.status_code == 401

