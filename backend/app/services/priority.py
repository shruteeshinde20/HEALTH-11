"""Patient priority scoring (PROJECT.md AI feature 2).

A transparent, rule-based weighted formula, not machine learning:

    score = 100 x (w_m x mobility + w_c x criticality + w_h x hazard) / (w_m + w_c + w_h)

- mobility factor (0-1): from the patient's mobility type
  (priority_mobility_<type> parameters; slower patients need more time).
- criticality factor (0-1): (criticality - 1) / 4 for criticality 1-5.
- hazard factor (0-1): 1 at a hazard's origin, falling linearly to 0 at
  priority_hazard_distance_m metres of walking distance along the building
  graph; 0 when there is no scenario or no path.
Weights are the priority_weight_* parameters. Every result includes the full
breakdown so people can see exactly why a patient ranks where they do.
"""

import networkx as nx

MOBILITIES = ("ambulatory", "wheelchair", "stretcher", "ventilator")

METHOD = (
    "Rule-based weighted score (not machine learning): mobility, clinical criticality and "
    "walking distance to the nearest hazard origin, each scaled 0-1 and combined with the "
    "weights in Settings. Higher score = evacuate earlier. It supports, and does not "
    "replace, clinical judgement."
)


def hazard_distances(nodes, edges, hazards) -> dict[int, float]:
    """Walking distance from every node to the nearest active hazard origin."""
    graph = nx.Graph()
    graph.add_nodes_from(n.id for n in nodes)
    for edge in edges:
        if edge.from_node_id in graph and edge.to_node_id in graph:
            graph.add_edge(edge.from_node_id, edge.to_node_id, distance=float(edge.distance))
    origins = {h.origin_node_id for h in hazards
               if getattr(h, "is_active", True) and h.origin_node_id in graph}
    if not origins:
        return {}
    return nx.multi_source_dijkstra_path_length(graph, origins, weight="distance")


def score_patients(patients, nodes, edges, hazards, values: dict, has_scenario: bool) -> list[dict]:
    weights = {
        "mobility": values["priority_weight_mobility"],
        "criticality": values["priority_weight_criticality"],
        "hazard": values["priority_weight_hazard"],
    }
    total_weight = sum(weights.values())
    names = {n.id: n.name for n in nodes}
    distances = hazard_distances(nodes, edges, hazards) if has_scenario else {}
    reach = values["priority_hazard_distance_m"]

    rows = []
    for patient in patients:
        mobility = getattr(patient.mobility, "value", patient.mobility)
        mobility_factor = values[f"priority_mobility_{mobility}"]
        criticality_factor = (patient.criticality - 1) / 4
        distance = distances.get(patient.node_id) if patient.node_id is not None else None
        hazard_factor = 0.0 if distance is None else max(0.0, 1.0 - distance / reach)
        parts = {
            "mobility": {"value": mobility, "factor": round(mobility_factor, 4)},
            "criticality": {"value": patient.criticality, "factor": round(criticality_factor, 4)},
            "hazard": {
                "distance_m": None if distance is None else round(distance, 2),
                "factor": round(hazard_factor, 4),
                "explanation": (
                    "no scenario selected" if not has_scenario
                    else "location unknown" if patient.node_id is None
                    else "no path to a hazard" if distance is None
                    else f"{distance:.0f} m from the nearest hazard origin"
                ),
            },
        }
        points = 0.0
        for key, part in parts.items():
            part["weight"] = weights[key]
            part["points"] = round(100 * part["factor"] * weights[key] / total_weight, 2)
            points += part["factor"] * weights[key]
        rows.append({
            "patient_id": patient.id,
            "patient_code": patient.patient_code,
            "mobility": mobility,
            "criticality": patient.criticality,
            "node_id": patient.node_id,
            "node_name": names.get(patient.node_id),
            "is_synthetic": patient.is_synthetic,
            "score": round(100 * points / total_weight, 2),
            "breakdown": parts,
        })
    rows.sort(key=lambda r: (-r["score"], -r["criticality"], r["patient_id"]))
    for rank, row in enumerate(rows, start=1):
        row["rank"] = rank
    return rows
