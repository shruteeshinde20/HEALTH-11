"""Crowd model in the simulation: corridor flow from usable width, people side
by side, slower in crowds and on stairs (SFPE hydraulic relations, NIST TN 1722).

Numbers worked out by hand:
- usable width = width - 2 x 0.15 m;
- most people per second into a level path = 1.40 / (4 x 0.266) x usable width
  = 1.3158 x usable width (stairs: 1.08 / 1.064 = 1.0150 x usable width);
- speed share above 0.54 people/m2 = (1 - 0.266 D) / (1 - 0.266 x 0.54),
  never below 0.15; stairs x 1.08 / 1.40.
"""

import math
from types import SimpleNamespace as N

import pytest

from app.services.simulation import ModelSettings, Simulation
from app.services.simulation_runner import settings_from

SPEEDS = {"ambulatory": 1.2, "wheelchair": 0.8, "stretcher": 0.5, "ventilator": 0.4}


def settings(crowd=True, **kw):
    return ModelSettings(speeds=SPEEDS, tick_seconds=1.0, max_seconds=3600, horizon_minutes=5.0,
                         risk_cost_metres=50.0, smoke_blocking_severity=4, crowd_model=crowd, **kw)


def node(i, name, kind, x=0.0, y=0.0):
    return N(id=i, name=name, type=kind, x=float(x), y=float(y), floor_id=1,
             is_blocked=False, is_evacuation_lift=False)


def edge(i, a, b, metres, width, max_flow):
    return N(id=i, from_node_id=a, to_node_id=b, distance=metres, width=width, max_flow=max_flow,
             wheelchair_accessible=True, stretcher_accessible=True, is_blocked=False)


def people(n, node_id=1):
    return [N(id=f"s{i}", kind="staff", mobility="ambulatory", node_id=node_id) for i in range(n)]


def corridor_sim(n, metres=12, width=2.4, max_flow=600, crowd=True):
    nodes = [node(1, "Ward", "ward"), node(2, "Exit", "exit", x=metres)]
    return Simulation(nodes, [edge(1, 1, 2, metres, width, max_flow)], people(n), [], "dijkstra",
                      settings(crowd))


def entry_times(sim):
    """Second at which each person entered the corridor (from the per-tick frames)."""
    entered, seen = [], set()
    while not sim.done:
        sim.step()
        for agent in sim.agents:
            if agent.id not in seen and (agent.on_edge or agent.status != "active"):
                seen.add(agent.id)
                entered.append(sim.t)
    return entered


def test_a_wide_corridor_lets_several_people_in_at_once():
    sim = corridor_sim(12, width=2.4, max_flow=600)
    assert sim.flow_rate[1] == pytest.approx(1.40 / (4 * 0.266) * 2.1)  # 2.763 people/s
    times = entry_times(sim)
    # Whole people enter per 1 s step and the unused part of a person carries
    # over: 3, 3, 3, 2 and then the last one, so all 12 are inside after 5 s
    # (a 1-person-per-second door would need 12 s).
    assert [times.count(float(t)) for t in range(1, 6)] == [3, 3, 3, 2, 1]
    assert all(a.status == "evacuated" for a in sim.agents)


def test_without_the_crowd_model_the_same_corridor_uses_max_flow_only():
    sim = corridor_sim(12, width=2.4, max_flow=600, crowd=False)
    assert sim.flow_rate[1] == pytest.approx(10.0)
    assert sim.max_occupancy[1] is None


def test_max_flow_still_caps_a_wide_corridor():
    sim = corridor_sim(5, width=2.4, max_flow=60)  # 1 person per second
    assert sim.flow_rate[1] == pytest.approx(1.0)
    assert entry_times(sim) == [1.0, 2.0, 3.0, 4.0, 5.0]


def test_a_narrow_door_slows_the_flow():
    sim = corridor_sim(10, metres=12, width=0.9, max_flow=600)
    rate = 1.40 / (4 * 0.266) * 0.6  # 0.789 people/s
    assert sim.flow_rate[1] == pytest.approx(rate)
    times = entry_times(sim)
    # The first person enters at once; the other 9 one every 1 / 0.789 s.
    assert max(times) == pytest.approx(math.ceil(1 + 9 / rate), abs=1.0)


def test_a_short_path_never_holds_more_than_its_maximum_density():
    sim = corridor_sim(10, metres=2, width=0.9, max_flow=600)
    limit = math.floor(3.55 * 2 * 0.6)  # 4 people on 1.2 m2
    assert sim.max_occupancy[1] == limit
    most = 0
    while not sim.done:
        sim.step()
        most = max(most, sum(1 for a in sim.agents if a.on_edge))
        assert sim.on_edge_count[1] == sum(1 for a in sim.agents if a.on_edge)
    assert 1 <= most <= limit
    assert all(a.status == "evacuated" for a in sim.agents)


@pytest.mark.parametrize("people_on_it, expected", [
    (0, 1.0),
    (6, 1.0),                                              # 6 / (10 x 2.1) = 0.29 /m2
    (round(1.88 * 21), (1 - 0.266 * 39 / 21) / (1 - 0.266 * 0.54)),  # about 1.86 /m2
    (80, 0.15),                                            # 3.8 /m2: the minimum share
])
def test_people_slow_down_as_the_corridor_fills(people_on_it, expected):
    sim = corridor_sim(1, metres=10, width=2.4)
    assert sim.speed_factor(sim.edge_by_id[1], people_on_it) == pytest.approx(expected)


def test_people_move_slower_on_stairs():
    nodes = [node(1, "S1 floor 1", "stair"), node(2, "S1 ground", "stair"), node(3, "Exit", "exit", x=20)]
    edges = [edge(1, 1, 2, 12, 1.5, 600), edge(2, 2, 3, 8, 2.4, 600)]
    sim = Simulation(nodes, edges, people(1), [], "dijkstra", settings())
    assert sim.stair_edges == {1}
    assert sim.speed_factor(sim.edge_by_id[1], 1) == pytest.approx(1.08 / 1.40)
    assert sim.speed_factor(sim.edge_by_id[2], 1) == pytest.approx(1.0)
    assert sim.flow_rate[1] == pytest.approx(1.08 / (4 * 0.266) * 1.2)
    sim.run_to_end()
    # 12 m at 1.2 x 0.771 m/s takes 12.96 s -> 13 ticks; then 8 m at 1.2 m/s -> 7 ticks.
    assert sim.agents[0].evacuated_at == 13 + 7


def test_crowded_corridors_take_longer_than_empty_ones():
    alone = corridor_sim(1, metres=20, width=1.2, max_flow=6000)
    alone.run_to_end()
    crowded = corridor_sim(40, metres=20, width=1.2, max_flow=6000)
    crowded.run_to_end()
    assert crowded.summary()["all_evacuated"]
    slowest = max(a.evacuated_at - a.wait for a in crowded.agents)
    assert slowest > alone.agents[0].evacuated_at


def test_people_walk_side_by_side_in_lanes():
    nodes = [node(1, "Ward", "ward"), node(2, "Exit", "exit", x=12)]
    sim = Simulation(nodes, [edge(1, 1, 2, 12, 2.4, 600)], people(3), [], "dijkstra", settings())
    sim.step()
    inside = [p for p in sim.frame()["positions"] if p["status"] == "active"]
    by_id = {a.id: a for a in sim.agents}
    on_corridor = [p for p in inside if by_id[p["id"]].on_edge]
    assert len(on_corridor) >= 2
    # The corridor runs along x, so lanes differ in y; 2.1 m usable = 3 lanes of 0.7 m.
    assert len({p["y"] for p in on_corridor}) == len(on_corridor)
    assert all(abs(p["y"]) <= 2.1 / 2 for p in on_corridor)

    plain = Simulation(nodes, [edge(1, 1, 2, 12, 2.4, 600)], people(3), [], "dijkstra", settings(False))
    plain.step()
    assert {p["y"] for p in plain.frame()["positions"]} == {0.0}


def test_crowd_runs_are_deterministic():
    first, second = corridor_sim(25, width=1.5), corridor_sim(25, width=1.5)
    first.run_to_end()
    second.run_to_end()
    assert [a.evacuated_at for a in first.agents] == [a.evacuated_at for a in second.agents]


def test_settings_from_parameters():
    values = {"speed_ambulatory_m_per_s": 1.2, "speed_wheelchair_m_per_s": 0.8,
              "speed_stretcher_m_per_s": 0.5, "speed_ventilator_m_per_s": 0.4,
              "simulation_tick_seconds": 1.0, "simulation_max_minutes": 60.0,
              "hazard_risk_horizon_minutes": 5.0, "hazard_risk_cost_metres": 50.0,
              "smoke_blocking_severity": 4.0}
    # A run saved before the crowd model existed is replayed as it was made.
    assert settings_from(values).crowd_model is False
    on = settings_from({**values, "crowd_model_enabled": 1.0, "crowd_boundary_layer_m": 0.2,
                        "crowd_max_density_per_m2": 3.0, "crowd_min_speed_fraction": 0.2})
    assert (on.crowd_model, on.boundary_layer_m, on.max_density_per_m2, on.min_speed_fraction) == (
        True, 0.2, 3.0, 0.2)
    assert settings_from({**values, "crowd_model_enabled": 0.0}).crowd_model is False
