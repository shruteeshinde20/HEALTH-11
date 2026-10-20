"""'Forgot password?' by e-mail code (backend/app/password_reset.py, services/mailer.py).

No real e-mail is sent: the sender is replaced by a fake that keeps the
messages, and the SMTP tests use a fake SMTP class.
"""

import re
import smtplib

import pytest
from app.config import Settings, get_settings
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, PasswordResetCode, User
from app.services import mailer
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select, text, update

API = "/api/v1"
OLD = "OldPassword!2345"
NEW = "BrandNew-Pass-9876"
REQUEST = f"{API}/auth/password-reset/request"
CONFIRM = f"{API}/auth/password-reset/confirm"


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
def outbox(monkeypatch):
    """E-mail switched on, with a fake sender that keeps every message."""
    sent = []
    settings = get_settings()
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "smtp_from", "health11.test@example.com")
    monkeypatch.setattr(settings, "smtp_security", "none")
    monkeypatch.setattr("app.password_reset.send_email",
                        lambda to, subject, text: sent.append({"to": to, "subject": subject, "text": text}))
    return sent


def register(client, org="Reset Org", email="admin@example.com"):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": org, "full_name": "Admin", "email": email, "password": OLD}).json()
    return body


def ask(client, slug, email="admin@example.com"):
    return client.post(REQUEST, json={"organization_slug": slug, "email": email})


def code_in(message) -> str:
    return re.search(r"Your code: (\d{6})", message["text"]).group(1)


def confirm(client, slug, code, password=NEW, email="admin@example.com"):
    return client.post(CONFIRM, json={"organization_slug": slug, "email": email,
                                      "code": code, "new_password": password})


def login(client, slug, password, email="admin@example.com"):
    return client.post(f"{API}/auth/login", json={"organization_slug": slug, "email": email,
                                                  "password": password})


def test_the_whole_reset(client, db_session, outbox):
    account = register(client)
    slug = account["organization"]["slug"]
    response = ask(client, slug)
    assert response.status_code == 202
    assert "If an account" in response.json()["message"]
    assert len(outbox) == 1 and outbox[0]["to"] == "admin@example.com"
    code = code_in(outbox[0])

    # Only a keyed hash is stored, never the code.
    row = db_session.scalars(select(PasswordResetCode)).one()
    assert code not in row.code_hash and len(row.code_hash) == 64

    done = confirm(client, slug, code)
    assert done.status_code == 200, done.text
    assert login(client, slug, NEW).status_code == 200
    assert login(client, slug, OLD).status_code == 401
    # A code works once.
    assert confirm(client, slug, code, password="Another-Pass-1234").status_code == 400

    actions = set(db_session.scalars(select(AuditLog.action).where(
        AuditLog.organization_id == account["organization"]["id"])).all())
    assert {"auth.password_reset_requested", "auth.password_reset_completed"} <= actions


@pytest.mark.parametrize("who", ["unknown organization", "unknown email", "deactivated"])
def test_unknown_or_inactive_accounts_get_the_same_answer_and_no_email(client, db_session, outbox, who):
    account = register(client)
    slug = account["organization"]["slug"]
    known = ask(client, slug).json()
    outbox.clear()
    if who == "deactivated":
        db_session.execute(update(User).where(User.email == "admin@example.com").values(is_active=False))
    response = ask(client, "no-such-org" if who == "unknown organization" else slug,
                   "nobody@example.com" if who == "unknown email" else "admin@example.com")
    assert response.status_code == 202 and response.json() == known
    assert outbox == []


def test_wrong_codes_count_and_then_even_the_right_one_fails(client, db_session, outbox):
    slug = register(client)["organization"]["slug"]
    ask(client, slug)
    code = code_in(outbox[0])
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(get_settings().password_reset_max_attempts):
        response = confirm(client, slug, wrong)
        assert response.status_code == 400 and "wrong" in response.json()["error"]["message"]
    assert confirm(client, slug, code).status_code == 400
    assert login(client, slug, OLD).status_code == 200


def test_an_expired_code_fails(client, db_session, outbox):
    slug = register(client)["organization"]["slug"]
    ask(client, slug)
    db_session.execute(update(PasswordResetCode).values(expires_at=text("now() - interval '1 minute'")))
    assert confirm(client, slug, code_in(outbox[0])).status_code == 400


def test_a_new_code_ends_the_older_one(client, outbox):
    slug = register(client)["organization"]["slug"]
    ask(client, slug)
    ask(client, slug)
    first, second = code_in(outbox[0]), code_in(outbox[1])
    if first != second:
        assert confirm(client, slug, first).status_code == 400
    assert confirm(client, slug, second).status_code == 200


def test_requests_per_account_are_limited_quietly(client, outbox):
    slug = register(client)["organization"]["slug"]
    limit = get_settings().password_reset_requests_per_account
    answers = {ask(client, slug).status_code for _ in range(limit + 2)}
    assert answers == {202}
    assert len(outbox) == limit


def test_requests_per_network_address_are_limited(client, outbox):
    slug = register(client)["organization"]["slug"]
    limit = get_settings().password_reset_requests_per_ip
    statuses = [ask(client, slug, f"user{i}@example.com").status_code for i in range(limit + 1)]
    assert statuses[:limit] == [202] * limit and statuses[-1] == 429


def test_earlier_logins_end_and_the_lockout_is_cleared(client, outbox):
    account = register(client)
    slug = account["organization"]["slug"]
    for _ in range(5):
        login(client, slug, "Wrong-Password-111")
    assert login(client, slug, OLD).status_code == 429
    ask(client, slug)
    assert confirm(client, slug, code_in(outbox[0])).status_code == 200
    assert client.post(f"{API}/auth/refresh",
                       json={"refresh_token": account["refresh_token"]}).status_code == 401
    assert login(client, slug, NEW).status_code == 200


def test_a_weak_new_password_is_refused_and_keeps_the_code(client, db_session, outbox):
    slug = register(client)["organization"]["slug"]
    ask(client, slug)
    code = code_in(outbox[0])
    weak = confirm(client, slug, code, password="weak")
    assert weak.status_code == 422
    assert db_session.scalars(select(PasswordResetCode.attempts)).one() == 0
    assert confirm(client, slug, code).status_code == 200


def test_codes_do_not_cross_organizations(client, outbox):
    slug_a = register(client, "Org A")["organization"]["slug"]
    slug_b = register(client, "Org B")["organization"]["slug"]   # same e-mail, other organization
    ask(client, slug_a)
    code = code_in(outbox[0])
    assert confirm(client, slug_b, code).status_code == 400
    assert login(client, slug_b, OLD).status_code == 200


def test_a_mail_failure_does_not_break_the_answer(client, monkeypatch, outbox):
    slug = register(client)["organization"]["slug"]

    def broken(*_args):
        raise mailer.MailError("mail server down")

    monkeypatch.setattr("app.password_reset.send_email", broken)
    assert ask(client, slug).status_code == 202


def test_without_email_settings_the_feature_says_it_is_off(client):
    slug = register(client)["organization"]["slug"]
    for response in (ask(client, slug), confirm(client, slug, "123456")):
        assert response.status_code == 503
        assert "not set up" in response.json()["error"]["message"]


def test_bad_input_is_refused(client, outbox):
    slug = register(client)["organization"]["slug"]
    assert client.post(REQUEST, json={"organization_slug": slug, "email": "not-an-email"}).status_code == 422
    assert confirm(client, slug, "12ab56").status_code == 422
    assert confirm(client, slug, "1234567").status_code == 422
    assert client.post(REQUEST, json={"organization_slug": slug, "email": "a@b.co", "extra": 1}).status_code == 422


# --- The SMTP sender -------------------------------------------------------------------------

class FakeSMTP:
    instances: list["FakeSMTP"] = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.calls = host, port, []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        self.calls.append("ehlo")

    def starttls(self, context=None):
        self.calls.append("starttls")

    def login(self, username, password):
        self.calls.append(("login", username))
        if password != "app-password":
            raise smtplib.SMTPAuthenticationError(535, b"bad")

    def send_message(self, message):
        self.calls.append(("send", message["To"], message["Subject"]))


@pytest.fixture
def smtp(monkeypatch):
    FakeSMTP.instances = []
    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", FakeSMTP)
    settings = get_settings()
    for name, value in {"smtp_host": "smtp.gmail.com", "smtp_port": 587, "smtp_security": "starttls",
                        "smtp_username": "health11.alerts@gmail.com",
                        "smtp_from": "health11.alerts@gmail.com"}.items():
        monkeypatch.setattr(settings, name, value)
    from pydantic import SecretStr
    monkeypatch.setattr(settings, "smtp_password", SecretStr("app-password"))
    return settings


def test_starttls_login_and_send(smtp):
    mailer.send_email("someone@example.com", "Subject", "Body")
    server = FakeSMTP.instances[0]
    assert (server.host, server.port) == ("smtp.gmail.com", 587)
    assert server.calls == ["ehlo", "starttls", "ehlo", ("login", "health11.alerts@gmail.com"),
                            ("send", "someone@example.com", "Subject")]


def test_a_refused_password_is_reported_without_the_password(smtp, monkeypatch):
    from pydantic import SecretStr
    monkeypatch.setattr(smtp, "smtp_password", SecretStr("wrong-secret-value"))
    with pytest.raises(mailer.MailError) as caught:
        mailer.send_email("someone@example.com", "Subject", "Body")
    assert "app password" in str(caught.value) and "wrong-secret-value" not in str(caught.value)


def test_a_hang_up_at_login_is_explained_as_a_refused_login(smtp, monkeypatch):
    def hang_up(self, username, password):
        raise smtplib.SMTPServerDisconnected("Connection unexpectedly closed")

    monkeypatch.setattr(FakeSMTP, "login", hang_up)
    with pytest.raises(mailer.MailError, match="16-letter app password") as caught:
        mailer.send_email("someone@example.com", "Subject", "Body")
    assert "app-password" not in str(caught.value)


def test_the_message_has_a_sender_name_and_plain_text(smtp):
    message = mailer.build_message("someone@example.com", "Subject", "Your code: 123456")
    assert message["From"] == "HEALTH-11 <health11.alerts@gmail.com>"
    assert message.get_content().strip() == "Your code: 123456"


# --- Settings ----------------------------------------------------------------------------------

PRODUCTION = {"environment": "production", "jwt_secret_key": "x" * 40,
              "database_url": "postgresql+psycopg://u:strong@db:5432/health11",
              "ai_provider": "groq", "smtp_host": "smtp.gmail.com", "smtp_from": "a@example.com"}


def test_production_refuses_unencrypted_mail_to_another_computer():
    with pytest.raises(ValidationError, match="SMTP_SECURITY=none"):
        Settings(_env_file=None, **PRODUCTION, smtp_security="none")
    Settings(_env_file=None, **PRODUCTION, smtp_security="starttls")
    Settings(_env_file=None, **{**PRODUCTION, "smtp_host": "127.0.0.1"}, smtp_security="none")


def test_settings_check_the_security_value_and_blank_host():
    with pytest.raises(ValidationError, match="SMTP_SECURITY"):
        Settings(_env_file=None, smtp_security="tls")
    assert Settings(_env_file=None, smtp_host="  ", smtp_from="a@example.com").email_configured is False
