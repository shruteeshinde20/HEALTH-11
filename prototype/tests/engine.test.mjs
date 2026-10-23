// Run: node --test prototype/tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as E from "../engine.js";

const demo = JSON.parse(readFileSync(new URL("../examples/demo-building.json", import.meta.url), "utf8"));
const P = E.defaultParams();
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not close to ${b}`);

// The PROJECT.md test case, on one floor.
function testCase(extra = {}) {
  const t = (id, type, x, y) => ({ id, type, x, y, floor: 0 });
  return {
    name: "Test case",
    places: [t("ICU", "icu", 0, 0), t("WardA", "ward", 8, 5), t("C1", "corridor", 10, 0), t("C2", "corridor", 14, 10),
      t("S1", "stair", 22, 0), t("S2", "stair", 24, 12), t("R1", "ramp", 18, -10), t("R2", "ramp", 20, 20),
      t("E1", "exit", 30, 0), t("E2", "exit", 40, 15)],
    paths: [["ICU", "C1", 10], ["C1", "S1", 12], ["S1", "E1", 20], ["C1", "R1", 18], ["R1", "E1", 15], ["ICU", "C2", 14],
      ["C1", "WardA", 8], ["WardA", "C2", 12], ["C2", "S2", 10], ["S2", "E2", 25], ["C2", "R2", 16], ["R2", "E2", 20]]
      .map(([a, b, length]) => ({ a, b, length })),
    ...extra,
  };
}
const ctx = (model, blocked = []) => ({
  blocked: new Set(blocked.map((id) => model.index.get(id))), risk: () => 0, riskPenalty: 50, stairCost: 1,
  liftsForWalkers: false, fireOrSmoke: false, floorHeight: 4, hScale: E.heuristicScale(model, 4), exitCost: null,
});
const names = (model, r) => r.nodes.map((n) => model.nodes[n].id).join(",");

test("SFPE speed-density: free below 0.54 people/m2, k(1 - aD) above, highest flow k/(4a)", () => {
  assert.equal(E.speedFraction(0.3, P), 1);
  assert.equal(E.speedFraction(0.54, P), 1);
  near(E.speedFraction(1.88, P), (1 - 0.266 * 1.88) / (1 - 0.266 * 0.54));
  assert.equal(E.speedFraction(3.7, P), 0.15); // never below the minimum fraction
  near(E.maxSpecificFlow(1.40, P), 1.3158);
  near(1.40 * (1 - 0.266 * 0.54), P.speed_visitor, 1e-3); // derived visitor speed
});

test("Test case routes from PROJECT.md hold for Dijkstra and A*", () => {
  const model = E.buildModel(testCase());
  const exits = new Set(model.exits);
  for (const alg of ["dijkstra", "astar"]) {
    const walk = E.findRoute(model, model.index.get("WardA"), exits, "ambulatory", alg, ctx(model));
    assert.equal(names(model, walk), "WardA,C1,S1,E1");
    assert.equal(walk.length, 40);
    const bed = E.findRoute(model, model.index.get("ICU"), exits, "stretcher", alg, ctx(model));
    assert.equal(names(model, bed), "ICU,C1,R1,E1");
    assert.equal(bed.length, 43);
    const walk2 = E.findRoute(model, model.index.get("WardA"), exits, "ambulatory", alg, ctx(model, ["C1"]));
    assert.equal(names(model, walk2), "WardA,C2,S2,E2");
    assert.equal(walk2.length, 47);
    const bed2 = E.findRoute(model, model.index.get("ICU"), exits, "stretcher", alg, ctx(model, ["C1"]));
    assert.equal(names(model, bed2), "ICU,C2,R2,E2");
    assert.equal(bed2.length, 50);
    const toE1 = E.findRoute(model, model.index.get("ICU"), new Set([model.index.get("E1")]), "ambulatory", alg, ctx(model, ["C1"]));
    assert.equal(toE1, null);
  }
});

test("BFS takes fewest steps, DFS takes the first path; both avoid blocked places", () => {
  const model = E.buildModel(testCase());
  const exits = new Set(model.exits);
  const bfs = E.findRoute(model, model.index.get("WardA"), exits, "ambulatory", "bfs", ctx(model));
  assert.equal(bfs.nodes.length, 4);
  const dfs = E.findRoute(model, model.index.get("WardA"), exits, "ambulatory", "dfs", ctx(model, ["C1"]));
  assert.ok(!dfs.nodes.includes(model.index.get("C1")));
});

test("Lifts: walkers keep to stairs, step-free patients use evacuation lifts only in a fire", () => {
  const model = E.buildModel(demo);
  const from = model.index.get("Ward 2A");
  const exits = new Set(model.exits);
  const c = ctx(model);
  const walk = E.findRoute(model, from, exits, "ambulatory", "dijkstra", c);
  assert.ok(walk.edges.every((ei) => model.edges[ei].kind !== "lift"));
  assert.ok(walk.edges.some((ei) => model.edges[ei].kind === "stair"));
  const bed = E.findRoute(model, from, exits, "stretcher", "dijkstra", { ...c, fireOrSmoke: true });
  assert.ok(bed.edges.some((ei) => model.edges[ei].kind === "lift"));
  assert.ok(bed.nodes.every((n) => model.nodes[n].type !== "stair"));
  const noEvacLift = E.buildModel({ ...demo, places: demo.places.map((p) => ({ ...p, evacLift: false })) });
  assert.equal(E.findRoute(noEvacLift, noEvacLift.index.get("Ward 2A"), new Set(noEvacLift.exits), "stretcher", "dijkstra", { ...ctx(noEvacLift), fireOrSmoke: true }), null);
});

test("Hazards spread along paths and stay out of protected stairs and lifts", () => {
  const model = E.buildModel(demo);
  const [h] = E.hazardArrivals(model, { hazards: [{ type: "fire", origin: "Kitchen", severity: 4, spreadRate: 0.5 }] }, P);
  assert.equal(h.arrival[model.index.get("Kitchen")], 0);
  assert.equal(h.arrival[model.index.get("G Corridor East")], 20); // 10 m at 0.5 m/s
  assert.equal(h.arrival[model.index.get("Stair B G")], Infinity);
  assert.equal(h.arrival[model.index.get("Ward 1B")], Infinity);
  const [open] = E.hazardArrivals(model, { hazards: [{ type: "smoke", origin: "Kitchen", severity: 3, spreadRate: 0.5, throughShafts: true }] }, P);
  assert.ok(Number.isFinite(open.arrival[model.index.get("Ward 1B")]));
  assert.equal(open.blocking, false); // smoke below severity 4 does not block
});

test("Imported fire-model arrival times are used as given", () => {
  const model = E.buildModel(demo);
  const [h] = E.hazardArrivals(model, { hazards: [{ type: "smoke", severity: 4, arrivals: [{ place: "OPD", arrival_s: 120 }, { place: "Kitchen", arrival_s: 0 }] }] }, P);
  assert.equal(h.arrival[model.index.get("OPD")], 120);
  assert.equal(h.arrival[model.index.get("Pharmacy")], Infinity);
  assert.throws(() => E.hazardArrivals(model, { hazards: [{ type: "smoke", arrivals: [{ place: "Nowhere", arrival_s: 1 }] }] }, P), /does not exist/);
});

test("Drill: everyone gets out, staff escort patients, lifts carry beds, same seed gives same result", () => {
  const model = E.buildModel(demo);
  const drill = demo.scenarios.find((s) => s.alarm === "start");
  const a = E.simulate(model, drill, {}, { seed: 7 });
  const b = E.simulate(model, drill, {}, { seed: 7 });
  const c = E.simulate(model, drill, {}, { seed: 8 });
  assert.equal(a.total, 40 + 15 + 25); // patients + staff + camera visitors
  assert.equal(a.out, a.total);
  assert.ok(a.staffTrips >= 20, `staff trips ${a.staffTrips}`);
  assert.ok(a.liftTrips > 0);
  assert.equal(a.lastOut, b.lastOut);
  assert.notEqual(a.lastOut, c.lastOut);
  assert.equal(a.byKind.visitor.out, 25);
});

test("Nobody moves before the alarm plus their reaction or preparation time", () => {
  const model = E.buildModel(demo);
  const drill = demo.scenarios.find((s) => s.alarm === "start");
  const sim = E.createSimulation(model, drill, {}, { seed: 3 });
  for (let i = 0; i < 29; i++) sim.step();
  // Everyone whose reaction or preparation time has not passed is still in place.
  const notYet = sim.agents.filter((x) => x.startAt > sim.t);
  assert.ok(notYet.length > 40);
  assert.ok(notYet.every((x) => x.state === "waiting" && x.node === x.home));
  assert.ok(sim.agents.filter((x) => x.kind === "patient" && x.mobility === "ambulatory").every((x) => x.state === "waiting"));
  for (const x of sim.agents.filter((x) => x.kind === "patient" && x.mobility === "ambulatory")) assert.ok(x.premove >= 30 && x.premove <= 90);
});

test("Crowding slows people: 60 people take longer through one corridor than 1", () => {
  const place = (id, type, x) => ({ id, type, x, y: 0, floor: 0 });
  const one = (n) => ({
    places: [place("Room", "room", 0), place("Corridor", "corridor", 30), place("Exit", "exit", 60)],
    paths: [{ a: "Room", b: "Corridor", length: 30, width: 1.2 }, { a: "Corridor", b: "Exit", length: 30, width: 1.2 }],
    staff: Array.from({ length: n }, (_, i) => ({ code: `S${i}`, place: "Room" })),
  });
  const params = { staff_premove_mean: 1, staff_premove_sd: 0.01, speed_staff_sd: 0.0001 };
  const alone = E.simulate(E.buildModel(one(1)), { alarm: "start", hazards: [] }, params, { seed: 1 });
  const crowd = E.simulate(E.buildModel(one(60)), { alarm: "start", hazards: [] }, params, { seed: 1 });
  assert.ok(crowd.lastOut > alone.lastOut + 30, `${crowd.lastOut} vs ${alone.lastOut}`);
  assert.ok(crowd.busiest[0].maxDensity > 0.54);
});

test("Stairs are slower than a flat path of the same length", () => {
  const build = (stairs) => ({
    places: [{ id: "A", type: stairs ? "stair" : "corridor", x: 0, y: 0, floor: 1 }, { id: "B", type: stairs ? "stair" : "corridor", x: 0, y: 0, floor: stairs ? 0 : 1 },
      { id: "X", type: "exit", x: 5, y: 0, floor: stairs ? 0 : 1 }],
    paths: [{ a: "A", b: "B", length: 30 }, { a: "B", b: "X", length: 1 }],
    staff: [{ code: "S1", place: "A" }],
  });
  const params = { staff_premove_mean: 1, staff_premove_sd: 0.01 };
  const flat = E.simulate(E.buildModel(build(false)), { alarm: "start", hazards: [] }, params, { seed: 2 });
  const stair = E.simulate(E.buildModel(build(true)), { alarm: "start", hazards: [] }, params, { seed: 2 });
  assert.ok(stair.lastOut > flat.lastOut, `${stair.lastOut} vs ${flat.lastOut}`);
});

test("A stretcher patient waits for two staff; with one staff member they are left waiting", () => {
  const place = (id, type, x) => ({ id, type, x, y: 0, floor: 0 });
  const data = (staff) => ({
    places: [place("Ward", "ward", 0), place("Corridor", "corridor", 10), place("Exit", "exit", 20)],
    paths: [{ a: "Ward", b: "Corridor", length: 10 }, { a: "Corridor", b: "Exit", length: 10 }],
    patients: [{ code: "P1", mobility: "stretcher", criticality: 3, place: "Ward" }],
    staff: staff.map((code) => ({ code, place: "Corridor" })),
  });
  const two = E.simulate(E.buildModel(data(["S1", "S2"])), { alarm: "start", hazards: [] }, {}, { seed: 1 });
  assert.equal(two.out, 3);
  assert.ok(two.lastOut >= 180, "stretcher preparation is at least 180 s");
  const single = E.simulate(E.buildModel(data(["S1"])), { alarm: "start", hazards: [] }, {}, { seed: 1 });
  assert.equal(single.leftWaitingForHelp, 1);
  assert.equal(single.byKind.patient.out, 0);
});

test("Sensors: alarm waits for detection and confirmation; manual mode waits for the commander", () => {
  const model = E.buildModel(demo);
  const fire = demo.scenarios[0];
  const auto = E.simulate(model, fire, {}, { seed: 1 });
  assert.equal(auto.alarmAt, P.sensor_delay_s + P.confirm_delay_s);
  const sim = E.createSimulation(model, fire, {}, { seed: 1, confirm: "manual" });
  for (let i = 0; i < 200; i++) sim.step();
  assert.equal(sim.alarmAt, null);
  assert.ok(sim.alerts.length >= 1);
  assert.ok(sim.agents.every((a) => a.state === "waiting"));
  sim.dismiss(sim.alerts[0].id);
  assert.equal(sim.alarmAt, null);
  assert.ok(sim.confirm(sim.alerts[1].id));
  assert.equal(sim.alarmAt, 200);
});

test("A false alarm can be injected and dismissed; no sensors means people raise the alarm", () => {
  const model = E.buildModel(demo);
  const drillWithSensors = { alarm: "sensors", hazards: [] };
  const sim = E.createSimulation(model, drillWithSensors, {}, { confirm: "manual", falseAlarms: [{ t: 5, sensor: "SD-01" }] });
  for (let i = 0; i < 6; i++) sim.step();
  assert.equal(sim.alerts.length, 1);
  assert.equal(sim.alerts[0].falseAlarm, true);
  sim.dismiss(1);
  for (let i = 0; i < 5; i++) sim.step();
  assert.equal(sim.done, true); // nothing else will raise an alarm
  const noSensors = E.buildModel({ ...demo, sensors: [] });
  const r = E.simulate(noSensors, demo.scenarios[0], {}, { seed: 1 });
  assert.match(r.alarmReason, /people found the hazard/);
  assert.ok(r.alarmAt > 0);
});

test("Camera counts set the number of visitors", () => {
  const model = E.buildModel(demo);
  const drill = demo.scenarios.find((s) => s.alarm === "start");
  const r = E.simulate(model, drill, {}, { cameraCounts: { "CAM-OPD": 0, "CAM-ED": 20 } });
  assert.equal(r.byKind.visitor.total, 25 - 10 - 6 + 20);
  const none = E.simulate(model, drill, {}, { visitors: false });
  assert.equal(none.byKind.visitor.total, 0);
});

test("Exit balancing sends more people to the less used exit", () => {
  const model = E.buildModel(demo);
  const drill = demo.scenarios.find((s) => s.alarm === "start");
  const plain = E.simulate(model, drill, {}, { seed: 1 });
  const balanced = E.simulate(model, drill, {}, { seed: 1, balanceExits: true });
  const spread = (r) => Math.abs(r.exits[0].people - r.exits[1].people);
  assert.ok(spread(balanced) < spread(plain), `${spread(balanced)} vs ${spread(plain)}`);
});

test("Drill comparison: errors and curves", () => {
  const drill = [{ code: "a", exit: "E1", exit_time_s: 10 }, { code: "b", exit: "E1", exit_time_s: 20 }, { code: "c", exit: "E2", exit_time_s: 40 }];
  const fake = (curve, last) => ({ curve, t: last, lastOut: last, exits: [{ exit: "E1", people: 2 }, { exit: "E2", people: 1 }] });
  const many = { results: [fake([[0, 0], [10, 1], [20, 2], [30, 2], [40, 3]], 40), fake([[0, 0], [10, 1], [20, 2], [30, 3]], 30)], meanTime: 35, minTime: 30, maxTime: 40 };
  const c = E.compareWithDrill(drill, many, 10);
  assert.equal(c.observedTotal, 40);
  assert.equal(c.timeError, -5);
  assert.equal(c.relError, -12.5);
  assert.deepEqual(c.observed.slice(0, 5), [0, 1, 2, 2, 3]);
  assert.deepEqual(c.exits, [{ exit: "E1", observed: 2, simulated: 2 }, { exit: "E2", observed: 1, simulated: 1 }]);
  assert.equal(c.inside, 100);
});

test("Bad building files are refused with a readable message", () => {
  assert.throws(() => E.buildModel({ places: [], paths: [] }), /no exit/);
  assert.throws(() => E.buildModel(testCase({ paths: [{ a: "ICU", b: "Nowhere", length: 3 }] })), /does not exist/);
  assert.throws(() => E.buildModel(testCase({ patients: [{ code: "X", mobility: "flying", place: "ICU" }] })), /mobility/);
  assert.throws(() => E.buildModel({ ...testCase(), places: [...testCase().places, { id: "ICU", type: "icu", x: 0, y: 0 }] }), /appears twice/);
  const two = testCase();
  two.places.push({ id: "Up", type: "corridor", x: 0, y: 0, floor: 1 });
  two.paths.push({ a: "C1", b: "Up", length: 5 });
  assert.throws(() => E.buildModel(two), /joins two floors/);
});

test("Priority score uses the HEALTH-11 weights", () => {
  const p = E.priority("ventilator", 5, 1);
  near(p.score, 1);
  near(E.priority("ambulatory", 1, 0).score, 0.1);
});
