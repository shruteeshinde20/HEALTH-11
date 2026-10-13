"""Phase 8: PDF and CSV reports of saved simulation runs (PROJECT.md build step 12).

PDF text is read back with the standard library only (ASCII85 + Flate page
streams, as reportlab writes them), so no extra package is needed.
"""

import base64
import csv
import io
import re
import zlib
from datetime import datetime, timezone
from pathlib import Path

import pytest
import reportlab
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import _password_hash
from app.config import Settings, get_settings
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, SimulationRun, User, UserRole
from app.models.simulation import MLModel
from app.services import ml, reports

API = "/api/v1"
PASSWORD = "StrongPassword!234"
VERA = Path(reportlab.__file__).parent / "fonts" / "Vera.ttf"  # ships with reportlab


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


class Site:
    def __init__(self, client, db_session, name, ward="Ward A"):
        self.client, self.db = client, db_session
        body = client.post(f"{API}/auth/register-organization", json={
            "organization_name": name, "full_name": "Admin",
            "email": "admin@example.com", "password": PASSWORD}).json()
        self.org_id, self.slug = body["organization"]["id"], body["organization"]["slug"]
        self.headers = {"Authorization": f"Bearer {body['access_token']}"}
        hospital = self.post("/hospitals", {"name": "General Hospital", "timezone": "UTC"})
        self.building = self.post("/buildings", {"hospital_id": hospital["id"], "name": "Main Block"})["id"]
        self.floor = self.post("/floors", {"building_id": self.building, "floor_number": 0,
                                           "name": "Ground"})["id"]
        self.ids = {n: self.post("/nodes", {"floor_id": self.floor, "name": n, "type": k})["id"]
                    for n, k in ((ward, "ward"), ("Corridor 1", "corridor"), ("Exit 1", "exit"))}
        self.ward = ward
        self.post("/edges", {"from_node_id": self.ids[ward], "to_node_id": self.ids["Corridor 1"],
                             "distance": 12, "width": 2, "max_flow": 60})
        self.post("/edges", {"from_node_id": self.ids["Corridor 1"], "to_node_id": self.ids["Exit 1"],
                             "distance": 12, "width": 2, "max_flow": 60})

    def post(self, path, payload, expect=201):
        response = self.client.post(f"{API}{path}", headers=self.headers, json=payload)
        assert response.status_code == expect, response.text
        return response.json()

    def run(self, people=1, hazard=False):
        for i in range(people):
            self.post("/staff", {"staff_code": f"S{i}", "full_name": f"Nurse {i}", "role": "nurse",
                                 "node_id": self.ids[self.ward]})
        scenario = {"name": "Night drill"}
        if hazard:
            scenario["hazards"] = [{"name": "Kitchen fire", "type": "fire",
                                    "origin_node_id": self.ids["Exit 1"], "spread_rate": 0,
                                    "severity": 2}]
        scenario_id = self.post("/scenarios", scenario)["id"]
        return self.post("/simulate", {"scenario_id": scenario_id, "building_id": self.building})["run_id"]

    def stored(self, run_id):
        return self.client.get(f"{API}/simulation_runs/{run_id}", headers=self.headers).json()

    def report(self, run_id, fmt="csv", headers=None):
        return self.client.get(f"{API}/reports/{run_id}", params={"format": fmt},
                               headers=headers or self.headers)

    def member(self, role, email):
        self.db.add(User(organization_id=self.org_id, email=email, full_name=email,
                         password_hash=_password_hash(PASSWORD), role=role, is_active=True))
        self.db.flush()
        token = self.client.post(f"{API}/auth/login", json={
            "organization_slug": self.slug, "email": email, "password": PASSWORD}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}


def csv_sections(content: bytes) -> dict[str, list[list[str]]]:
    assert content.startswith(b"\xef\xbb\xbf")  # BOM, so Excel reads UTF-8
    rows = list(csv.reader(io.StringIO(content.decode("utf-8-sig"))))
    sections, current = {"_top": []}, "_top"
    for i, row in enumerate(rows):
        if len(row) == 1 and (i == 0 or rows[i - 1] == []) and row[0] in TITLES:
            current = row[0]
            sections[current] = []
        elif row:
            sections[current].append(row)
    return sections


TITLES = {"Summary", "Hazards", "Recommendations", "Bottlenecks", "People per exit", "Timeline",
          "Hazard spread", "Routes", "Parameters used", "Model accuracy"}


def pdf_text(content: bytes) -> str:
    """All text drawn on the pages, joined with spaces."""
    texts = []
    for raw in re.findall(rb"stream\r?\n(.*?)endstream", content, re.S):
        data = raw.strip()
        if data.endswith(b"~>"):
            data = base64.a85decode(data[:-2], adobe=False)
        try:
            data = zlib.decompress(data)
        except zlib.error:
            continue
        for chunk in re.findall(rb"\((?:\\.|[^\\)])*\)", data):
            texts.append(re.sub(rb"\\(.)", rb"\1", chunk[1:-1]).decode("latin-1"))
    return re.sub(r"\s+", " ", " ".join(texts))


def page_count(content: bytes) -> int:
    return len(re.findall(rb"/Type /Page\b(?!s)", content))


# --- CSV -------------------------------------------------------------------------------------

def test_csv_report_contains_every_section_from_the_stored_run(client, db_session):
    site = Site(client, db_session, "Report Org")
    run_id = site.run(people=2)
    stored = site.stored(run_id)
    response = site.report(run_id, "csv")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == f'attachment; filename="health11-run-{run_id}.csv"'
    assert response.headers["cache-control"] == "no-store"

    sections = csv_sections(response.content)
    assert TITLES <= set(sections)
    assert sections["_top"][1] == [reports.SAFETY_NOTICE]
    summary = dict(sections["Summary"][1:])
    assert summary["Scenario"] == "Night drill" and summary["Building"] == "Main Block"
    assert summary["People simulated"] == "2" and summary["Everyone evacuated"] == "yes"
    assert summary["Evacuation time (s)"] == f"{stored['summary']['evacuation_time_s']:.0f}"

    routes = sections["Routes"]
    header = routes[1]
    assert header[:5] == ["Person", "Kind", "Mobility", "Start", "Outcome"]
    rows = [dict(zip(header, r)) for r in routes[2:]]
    assert len(rows) == len(stored["routes"]) == 2
    assert all(r["Planned route"] == "Ward A > Corridor 1 > Exit 1" for r in rows)
    assert {r["Person"] for r in rows} == {r["id"] for r in stored["routes"]}
    assert not any("Nurse" in cell for r in routes for cell in r)  # no personal names

    assert len(sections["Timeline"]) - 1 == len(stored["timeline"])
    parameters = {r[0]: r for r in sections["Parameters used"][2:]}
    assert parameters["speed_ambulatory_m_per_s"][1] == "1.2"
    assert "assumed, to be validated" in parameters["speed_ambulatory_m_per_s"][3]
    assert [r[1] for r in sections["Recommendations"][1:]] == [r["text"] for r in stored["recommendations"]]
    assert "No evacuation-time predictor has been trained" in sections["Model accuracy"][0][0]


def test_report_uses_place_names_from_the_time_of_the_run(client, db_session):
    site = Site(client, db_session, "Rename Org")
    run_id = site.run()
    renamed = client.patch(f"{API}/nodes/{site.ids['Corridor 1']}", headers=site.headers,
                           json={"name": "New Corridor"})
    assert renamed.status_code == 200
    content = site.report(run_id, "csv").content.decode("utf-8-sig")
    assert "Ward A > Corridor 1 > Exit 1" in content and "New Corridor" not in content


def test_hazards_added_during_the_run_are_listed(client, db_session):
    site = Site(client, db_session, "Hazard Org")
    run_id = site.run(people=1, hazard=True)
    site.post(f"/simulations/{run_id}/hazards", {"name": "Smoke", "type": "smoke", "severity": 1,
                                                 "origin_node_id": site.ids["Corridor 1"],
                                                 "at_seconds": 3})
    sections = csv_sections(site.report(run_id, "csv").content)
    hazards = sections["Hazards"][1:]  # after the header
    # The smoke strands the person: no evacuation time is claimed for an incomplete run.
    summary = dict(sections["Summary"][1:])
    assert summary["Everyone evacuated"] == "no" and summary["Evacuation time (s)"] == "not complete"
    assert ["Kitchen fire", "fire", "Exit 1", "2", "0.0", "scenario"] in hazards
    assert ["Smoke", "smoke", "Corridor 1", "1", "0.0", "added at 3 s"] in hazards


def test_a_run_with_nobody_placed_is_not_reported_as_a_failed_evacuation(client, db_session):
    site = Site(client, db_session, "Empty Org")
    run_id = site.run(people=0, hazard=True)
    assert site.stored(run_id)["summary"]["total"] == 0
    summary = dict(csv_sections(site.report(run_id, "csv").content)["Summary"][1:])
    assert summary["People simulated"] == "0"
    assert summary["Everyone evacuated"] == reports.NOBODY_PLACED
    assert summary["Evacuation time (s)"] == reports.NOBODY_PLACED
    text = pdf_text(site.report(run_id, "pdf").content)
    assert "not complete" not in text
    assert "nobody to evacuate" in text


def test_spreadsheet_formulas_in_names_are_neutralised(client, db_session):
    site = Site(client, db_session, "Formula Org", ward='=HYPERLINK("http://evil","x")')
    content = site.report(site.run(), "csv").content.decode("utf-8-sig")
    assert "'=HYPERLINK" in content
    assert not re.search(r'(^|,|")=HYPERLINK', content.replace("'=HYPERLINK", ""))


@pytest.mark.parametrize("value, expected", [
    ("=1+1", "'=1+1"), ("+cmd", "'+cmd"), ("-2+3", "'-2+3"), ("@SUM(A1)", "'@SUM(A1)"),
    ("\tx", "'\tx"), ("Ward A", "Ward A"), (12.5, 12.5), (-3, -3), (None, ""), (True, "yes"),
])
def test_safe_cell(value, expected):
    assert reports.safe_cell(value) == expected


# --- PDF -------------------------------------------------------------------------------------

def test_pdf_report_has_every_section_and_the_notice_on_every_page(client, db_session):
    site = Site(client, db_session, "Pdf Org")
    run_id = site.run(people=60)  # enough rows for several pages
    response = site.report(run_id, "pdf")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == f'attachment; filename="health11-run-{run_id}.pdf"'
    assert response.content.startswith(b"%PDF-")

    text = pdf_text(response.content)
    for title in TITLES:
        assert title in text, title
    pages = page_count(response.content)
    assert pages > 1
    # Footer on every page, plus the notice once under the title.
    assert text.count(reports.SAFETY_NOTICE) == pages + 1
    assert "Night drill" in text and "Main Block" in text
    assert "Ward A > Corridor 1 > Exit 1" in text


def test_pdf_shows_names_as_text_never_as_markup(client, db_session):
    site = Site(client, db_session, "Markup Org", ward="<b>Ward & Co</b>")
    response = site.report(site.run(), "pdf")
    assert response.status_code == 200
    # Drawn literally (not bold); reportlab draws it in pieces, so compare without spaces.
    assert "<b>Ward&Co</b>>Corridor1>Exit1" in pdf_text(response.content).replace(" ", "")


def test_pdf_can_use_a_unicode_font(client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "report_font_path", VERA)
    site = Site(client, db_session, "Font Org")
    response = site.report(site.run(), "pdf")
    assert response.status_code == 200
    assert b"/FontFile2" in response.content  # the TrueType font is embedded


def test_report_font_setting_must_be_an_existing_ttf(tmp_path):
    assert Settings(_env_file=None, report_font_path=VERA).report_font_path == VERA
    assert Settings(_env_file=None, report_font_path="").report_font_path is None
    with pytest.raises(ValueError, match="REPORT_FONT_PATH"):
        Settings(_env_file=None, report_font_path=tmp_path / "missing.ttf")
    other = tmp_path / "font.otf"
    other.write_bytes(b"x")
    with pytest.raises(ValueError, match="REPORT_FONT_PATH"):
        Settings(_env_file=None, report_font_path=other)


# --- Model accuracy ----------------------------------------------------------------------------

def test_model_accuracy_comes_from_the_stored_predictor_metrics(client, db_session):
    site = Site(client, db_session, "Accuracy Org")
    run_id = site.run()
    db_session.add(MLModel(organization_id=site.org_id, model_type=ml.PREDICTOR_TYPE, metrics={
        "algorithm": "RandomForestRegressor", "training_runs": 30, "test_runs": 10,
        "mae_s": 4.25, "baseline_mae_s": 19.5, "r2": 0.91}))
    db_session.flush()
    rows = dict(csv_sections(site.report(run_id, "csv").content)["Model accuracy"][2:])
    assert rows["Model"] == "RandomForestRegressor"
    assert rows["Mean absolute error on test runs (s)"] == "4.25"
    assert rows["Error of always guessing the average (s)"] == "19.5"
    assert rows["R2 on test runs"] == "0.91"
    assert rows["Training runs"] == "30" and rows["Held-out test runs"] == "10"


def test_model_accuracy_of_another_organization_is_never_used(client, db_session):
    site = Site(client, db_session, "Own Org")
    other = Site(client, db_session, "Other Org")
    db_session.add(MLModel(organization_id=other.org_id, model_type=ml.PREDICTOR_TYPE,
                           metrics={"algorithm": "Other", "mae_s": 1.0}))
    db_session.flush()
    section = csv_sections(site.report(site.run(), "csv").content)["Model accuracy"]
    assert "No evacuation-time predictor has been trained" in section[0][0]


# --- Access, errors, audit, limits ---------------------------------------------------------------

def test_reports_rules_roles_isolation_and_audit(client, db_session):
    site = Site(client, db_session, "Rules Org")
    run_id = site.run()
    staff = site.member(UserRole.STAFF_USER, "staff@example.com")
    assert site.report(run_id, "pdf", headers=staff).status_code == 200  # Staff can read reports

    other = Site(client, db_session, "Stranger Org")
    response = other.report(run_id, "csv")
    assert response.status_code == 404
    assert response.json()["error"]["message"] == "Simulation run not found"
    assert site.report(999_999, "csv").status_code == 404
    bad = site.report(run_id, "docx")
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "VALIDATION_ERROR"
    assert client.get(f"{API}/reports/{run_id}").status_code == 401

    entries = db_session.scalars(select(AuditLog).where(
        AuditLog.organization_id == site.org_id, AuditLog.action == "report.downloaded")).all()
    assert [(e.entity_id, e.details) for e in entries] == [(run_id, {"format": "pdf"})]


def test_deleted_runs_and_runs_without_results(client, db_session):
    site = Site(client, db_session, "Edge Org")
    run_id = site.run()
    empty = SimulationRun(organization_id=site.org_id, scenario_id=site.stored(run_id)["scenario_id"],
                          algorithm="astar", params={}, results=None, status="pending")
    db_session.add(empty)
    db_session.flush()
    response = site.report(empty.id, "csv")
    assert response.status_code == 409
    assert response.json()["error"]["message"] == "This simulation run has no results yet"

    db_session.get(SimulationRun, run_id).deleted_at = datetime.now(timezone.utc)  # soft-deleted
    db_session.flush()
    assert site.report(run_id, "csv").status_code == 404


def test_reports_are_rate_limited_per_user(client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "report_max_requests_per_user", 2)
    site = Site(client, db_session, "Limit Org")
    run_id = site.run()
    assert [site.report(run_id).status_code for _ in range(2)] == [200, 200]
    blocked = site.report(run_id)
    assert blocked.status_code == 429 and "retry-after" in blocked.headers


def test_every_pdf_table_has_one_width_per_column():
    run = SimulationRun(id=1, algorithm="astar", params={}, results={})
    report = reports.build_report(run, scenario_name=None, building_name=None,
                                  accuracy_rows=[], accuracy_note=None)
    assert all(t.widths is None or len(t.widths) == len(t.columns) for t in report.tables)
