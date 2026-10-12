
import pytest
from fastapi.testclient import TestClient

from app.auth import get_current_user
from app.db_session import get_db
from app.main import app
from app.models.facility import Building, Floor, Hospital
from app.models.organization import Organization


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


def register_admin(client, organization_name):
    response = client.post(
        "/api/v1/auth/register-organization",
        json={
            "organization_name": organization_name,
            "full_name": "Test Administrator",
            "email": "admin@example.com",
            "password": "StrongPassword!234",
        },
    )
    assert response.status_code == 201, response.text
    result = response.json()
    return {
        "organization_id": result["organization"]["id"],
        "headers": {
            "Authorization": f"Bearer {result['access_token']}"
        },
    }


def create_floor(db_session, organization_id, suffix):
    hospital = Hospital(
        organization_id=organization_id,
        name=f"Hospital {suffix}",
    )
    db_session.add(hospital)
    db_session.flush()

    building = Building(
        organization_id=organization_id,
        hospital_id=hospital.id,
        name=f"Building {suffix}",
    )
    db_session.add(building)
    db_session.flush()

    floor = Floor(
        organization_id=organization_id,
        building_id=building.id,
        floor_number=0,
        name=f"Ground Floor {suffix}",
    )
    db_session.add(floor)
    db_session.flush()
    return floor.id


def create_node(client, floor_id, headers, name):
    response = client.post(
        "/api/v1/nodes",
        headers=headers,
        json={"floor_id": floor_id, 
            "name": name,
            "type": "corridor",
            "x": 0,
            "y": 0,
            "capacity": 20,
            "is_blocked": False,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_graph_create_read_and_update(client, db_session):
    admin = register_admin(client, "Graph Test Hospital")
    floor_id = create_floor(
        db_session, admin["organization_id"], "GraphTest"
    )
    headers = admin["headers"]

    first = create_node(client, floor_id, headers, "Corridor A")
    second = create_node(client, floor_id, headers, "Exit A")

    edge_response = client.post(
        "/api/v1/edges",
        headers=headers,
        json={
            "from_node_id": first["id"],
            "to_node_id": second["id"],
            "distance": 12,
            "width": 2,
            "max_flow": 10,
            "wheelchair_accessible": True,
            "stretcher_accessible": True,
            "is_blocked": False,
        },
    )
    assert edge_response.status_code == 201, edge_response.text
    edge = edge_response.json()

    graph_response = client.get(
        f"/api/v1/floors/{floor_id}/graph",
        headers=headers,
    )
    assert graph_response.status_code == 200, graph_response.text
    graph = graph_response.json()
    assert len(graph["nodes"]) == 2
    assert len(graph["edges"]) == 1

    node_update = client.patch(
        f"/api/v1/nodes/{first['id']}",
        headers=headers,
        json={"capacity": 35, "is_blocked": True},
    )
    assert node_update.status_code == 200, node_update.text
    assert node_update.json()["capacity"] == 35
    assert node_update.json()["is_blocked"] is True

    edge_update = client.patch(
        f"/api/v1/edges/{edge['id']}",
        headers=headers,
        json={"distance": 15},
    )
    assert edge_update.status_code == 200, edge_update.text
    assert edge_update.json()["distance"] == 15


def test_graph_rejects_edge_between_different_floors(
    client, db_session
):
    admin = register_admin(client, "Different Floor Hospital")
    first_floor = create_floor(
        db_session, admin["organization_id"], "First"
    )

    # A second building avoids the unique floor-number constraint.
    hospital = db_session.query(Hospital).filter_by(
        organization_id=admin["organization_id"]
    ).first()
    building = Building(
        organization_id=admin["organization_id"],
        hospital_id=hospital.id,
        name="Second Building",
    )
    db_session.add(building)
    db_session.flush()

    other_floor = Floor(
        organization_id=admin["organization_id"],
        building_id=building.id,
        floor_number=0,
        name="Other Ground Floor",
    )
    db_session.add(other_floor)
    db_session.flush()

    first_node = create_node(
        client, first_floor, admin["headers"], "First Corridor"
    )
    other_node = create_node(
        client, other_floor.id, admin["headers"], "Other Corridor"
    )

    response = client.post(
        "/api/v1/edges",
        headers=admin["headers"],
        json={
            "from_node_id": first_node["id"],
            "to_node_id": other_node["id"],
            "distance": 5,
            "width": 2,
            "max_flow": 5,
        },
    )
    assert response.status_code == 422, response.text


def test_organization_cannot_read_another_organizations_floor(
    client, db_session
):
    first_admin = register_admin(client, "Organization Alpha")
    second_admin = register_admin(client, "Organization Beta")

    floor_id = create_floor(
        db_session, first_admin["organization_id"], "Alpha"
    )

    response = client.get(
        f"/api/v1/floors/{floor_id}/graph",
        headers=second_admin["headers"],
    )
    assert response.status_code == 404, response.text


def test_graph_requires_authentication(client):
    response = client.get("/api/v1/floors/1/graph")
    assert response.status_code == 401, response.text


def test_graph_rejects_invalid_node_input(client, db_session):
    admin = register_admin(client, "Invalid Node Hospital")
    floor_id = create_floor(
        db_session, admin["organization_id"], "Invalid"
    )

    response = client.post(
        "/api/v1/nodes",
        headers=admin["headers"],
        json={"floor_id": floor_id, 
            "name": "",
            "type": "not-a-real-node-type",
            "capacity": -1,
        },
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    ("export_format", "content_type"),
    [
        ("json", "application/json"),
        ("geojson", "application/geo+json"),
        ("csv", "text/csv"),
    ],
)
def test_floor_import_export_round_trip(
    client, db_session, export_format, content_type
):
    admin = register_admin(client, f"Import Export {export_format}")
    headers = admin["headers"]

    source_floor = create_floor(
        db_session, admin["organization_id"], f"Source{export_format}"
    )
    destination_floor = create_floor(
        db_session, admin["organization_id"], f"Destination{export_format}"
    )

    first = create_node(client, source_floor, headers, "Corridor A")
    second = create_node(client, source_floor, headers, "Exit A")

    edge_response = client.post(
        "/api/v1/edges",
        headers=headers,
        json={
            "from_node_id": first["id"],
            "to_node_id": second["id"],
            "distance": 12,
            "width": 2,
            "max_flow": 10,
            "wheelchair_accessible": True,
            "stretcher_accessible": True,
            "is_blocked": False,
        },
    )
    assert edge_response.status_code == 201, edge_response.text

    export_response = client.get(
        f"/api/v1/floors/{source_floor}/export",
        params={"format": export_format},
        headers=headers,
    )
    assert export_response.status_code == 200, export_response.text
    assert content_type in export_response.headers["content-type"]

    import_response = client.post(
        f"/api/v1/floors/{destination_floor}/import",
        content=export_response.content,
        headers={**headers, "Content-Type": content_type},
    )
    assert import_response.status_code == 201, import_response.text
    assert import_response.json()["nodes_imported"] == 2
    assert import_response.json()["edges_imported"] == 1

    graph_response = client.get(
        f"/api/v1/floors/{destination_floor}/graph",
        headers=headers,
    )
    assert graph_response.status_code == 200, graph_response.text
    graph = graph_response.json()
    assert {node["name"] for node in graph["nodes"]} == {
        "Corridor A",
        "Exit A",
    }
    assert len(graph["edges"]) == 1
    assert graph["edges"][0]["distance"] == 12


def test_floor_import_rejects_invalid_json(client, db_session):
    admin = register_admin(client, "Invalid Import")
    floor_id = create_floor(
        db_session, admin["organization_id"], "InvalidImport"
    )

    response = client.post(
        f"/api/v1/floors/{floor_id}/import",
        content=b'{"nodes":',
        headers={
            **admin["headers"],
            "Content-Type": "application/json",
        },
    )
    assert response.status_code == 422, response.text


def test_floor_import_rejects_unsupported_content_type(
    client, db_session
):
    admin = register_admin(client, "Unsupported Import")
    floor_id = create_floor(
        db_session, admin["organization_id"], "UnsupportedImport"
    )

    response = client.post(
        f"/api/v1/floors/{floor_id}/import",
        content=b"some data",
        headers={
            **admin["headers"],
            "Content-Type": "text/plain",
        },
    )
    assert response.status_code == 415, response.text


def test_floor_import_and_export_enforce_tenant_isolation(
    client, db_session
):
    first_admin = register_admin(client, "Import Organization A")
    second_admin = register_admin(client, "Import Organization B")

    floor_id = create_floor(
        db_session, first_admin["organization_id"], "PrivateFloor"
    )

    import_response = client.post(
        f"/api/v1/floors/{floor_id}/import",
        content=b'{"nodes":[],"edges":[]}',
        headers={
            **second_admin["headers"],
            "Content-Type": "application/json",
        },
    )
    export_response = client.get(
        f"/api/v1/floors/{floor_id}/export",
        headers=second_admin["headers"],
    )

    assert import_response.status_code == 404, import_response.text
    assert export_response.status_code == 404, export_response.text




def test_organization_cannot_modify_another_organizations_graph(
    client, db_session
):
    first_admin = register_admin(client, "Isolation Alpha")
    second_admin = register_admin(client, "Isolation Beta")

    floor_id = create_floor(
        db_session, first_admin["organization_id"], "Isolation"
    )

    first_node = create_node(
        client, floor_id, first_admin["headers"], "Corridor A"
    )
    second_node = create_node(
        client, floor_id, first_admin["headers"], "Exit A"
    )

    edge_response = client.post(
        "/api/v1/edges",
        headers=first_admin["headers"],
        json={
            "from_node_id": first_node["id"],
            "to_node_id": second_node["id"],
            "distance": 10,
            "width": 2,
            "max_flow": 10,
        },
    )
    assert edge_response.status_code == 201, edge_response.text
    edge = edge_response.json()

    node_attack = client.patch(
        f"/api/v1/nodes/{first_node['id']}",
        headers=second_admin["headers"],
        json={"name": "Unauthorized Change"},
    )
    assert node_attack.status_code == 404, node_attack.text

    edge_attack = client.patch(
        f"/api/v1/edges/{edge['id']}",
        headers=second_admin["headers"],
        json={"distance": 999},
    )
    assert edge_attack.status_code == 404, edge_attack.text

    owner_graph = client.get(
        f"/api/v1/floors/{floor_id}/graph",
        headers=first_admin["headers"],
    )
    assert owner_graph.status_code == 200, owner_graph.text

    graph = owner_graph.json()
    saved_node = next(
        node for node in graph["nodes"] if node["id"] == first_node["id"]
    )
    saved_edge = next(
        item for item in graph["edges"] if item["id"] == edge["id"]
    )

    assert saved_node["name"] == "Corridor A"
    assert saved_edge["distance"] == 10
