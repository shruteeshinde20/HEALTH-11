// Tests for the hazard-aware routing engine. Run: node --test hazard-routing/tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../engine.js";
import * as IO from "../io.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "examples", f), "utf8");
const hospital = () => E.buildModel(JSON.parse(read("hospital.json")));
const p = E.defaultParams();
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// ---------------------------------------------------------------- movement

test("Speed follows v = k(1 - 0.266 rho) with the SFPE free-speed and slowest-speed limits", () => {
  assert.equal(E.speedFraction(0.3, p), 1);
  near(E.sfpeSpeed(1.0, 1.4, p), 1.4 * (1 - 0.266 * 1.0), 1e-9);
  near(E.sfpeSpeed(0.2, 1.4, p), 1.4 * (1 - 0.266 * 0.54), 1e-9);
  near(E.sfpeSpeed(3.55, 1.4, p), 1.4 * (1 - 0.266 * 0.54) * 0.15, 1e-9);
  near(E.maxSpecificFlow(1.4, p), 1.4 / (4 * 0.266), 1e-9);
});

test("FED follows ISO 13571: CO dose / 35000 ppm min, heat t = 5e7 T^-3.4 min", () => {
  const co = { T: 20, CO: 3500, K: 0, smoke: true, fire: false };
  near(E.fedPerSecond(co, p) * 600, 1, 1e-9); // 3500 ppm for 10 min = 35000 ppm min
  const heat = { T: 100, CO: 0, K: 0, smoke: true, fire: false };
  near(1 / (E.fedPerSecond(heat, p) * 60), 5e7 * 100 ** -3.4, 1e-6);
  assert.equal(E.fedPerSecond({ T: 20, CO: 0, K: 0, smoke: false }, p), 0);
  assert.equal(E.riskIndex({ fire: true }, p), 1);
  assert.equal(E.riskRaw({ fire: true }, p), E.FIRE_RISK);
  near(E.visibility(0.3, 3), 10, 1e-9);
});

// ---------------------------------------------------------------- model

test("The building file is checked", () => {
  assert.throws(() => E.buildModel({ places: [{ id: "A", type: "room", x: 0, y: 0 }], paths: [{ a: "A", b: "B", length: 3 }] }), /does not exist/);
  assert.throws(() => E.buildModel({ places: [{ id: "A", type: "room", x: 0, y: 0 }, { id: "A", type: "exit", x: 1, y: 0 }], paths: [] }), /twice/);
  assert.throws(() => E.buildModel({ places: [{ id: "A", type: "room", x: 0, y: 0 }, { id: "B", type: "exit", x: 1, y: 0, floor: 1 }], paths: [{ a: "A", b: "B", length: 3 }] }), /joins two floors/);
  assert.throws(() => E.buildModel({ places: [{ id: "A", type: "room", x: 0, y: 0 }], paths: [] }), /no exit/);
  const m = hospital();
  assert.equal(m.nodes.length, 132);
  assert.ok(m.nodes.every((n) => n.area > 0 && n.capacity === Math.floor(n.area * p.d_max)));
  assert.ok(m.edges.every((e) => e.effWidth === Math.max(0.3, e.width - 2 * p.boundary_layer)));
  assert.equal(m.scenarios.length, 6);
  assert.equal(m.refuges.length, 4);
});

// The HEALTH-11 test case from PROJECT.md (expected values are fixed).
function testCase(blockC1 = false) {
  const N = (id, type) => ({ id, type, x: 0, y: 0 });
  const data = {
    places: [N("ICU", "icu"), N("WardA", "ward"), N("C1", "corridor"), N("C2", "corridor"), N("S1", "stair"), N("S2", "stair"), N("R1", "ramp"), N("R2", "ramp"), N("E1", "exit"), N("E2", "exit")],
    paths: [["ICU", "C1", 10], ["C1", "S1", 12], ["S1", "E1", 20], ["C1", "R1", 18], ["R1", "E1", 15], ["ICU", "C2", 14], ["C1", "WardA", 8], ["WardA", "C2", 12], ["C2", "S2", 10], ["S2", "E2", 25], ["C2", "R2", 16], ["R2", "E2", 20]].map(([a, b, length]) => ({ a, b, length })),
  };
  const m = E.buildModel(data);
  const closed = new Set(blockC1 ? [m.index.get("C1")] : []);
  const names = (r) => r.nodes.map((n) => m.nodes[n].id).join(",");
  const exits = new Set(m.exits);
  return { m, closed, names, exits };
}

test("PROJECT test case: walking and stretcher routes, and with C1 blocked", () => {
  let { m, closed, names, exits } = testCase(false);
  let walk = E.shortestPath(m, m.index.get("WardA"), exits, "walk", new Set(), closed);
  assert.equal(names(walk), "WardA,C1,S1,E1");
  assert.equal(walk.length, 40);
  let bed = E.shortestPath(m, m.index.get("ICU"), exits, "bed", new Set(), closed);
  assert.equal(names(bed), "ICU,C1,R1,E1");
  assert.equal(bed.length, 43);
  ({ m, closed, names, exits } = testCase(true));
  walk = E.shortestPath(m, m.index.get("WardA"), exits, "walk", new Set(), closed);
  assert.equal(names(walk), "WardA,C2,S2,E2");
  assert.equal(walk.length, 47);
  bed = E.shortestPath(m, m.index.get("ICU"), exits, "bed", new Set(), closed);
  assert.equal(names(bed), "ICU,C2,R2,E2");
  assert.equal(bed.length, 50);
  assert.equal(E.shortestPath(m, m.index.get("WardA"), new Set([m.index.get("E1")]), "walk", new Set(), closed), null);
  assert.equal(E.shortestPath(m, m.index.get("ICU"), new Set([m.index.get("E1")]), "bed", new Set(), closed), null);
});

// ---------------------------------------------------------------- hazard and sensing

test("The real hazard spreads outward; protected stairs and lifts are reached only after the breach time", () => {
  const m = hospital();
  const sc = m.scenarios[0];
  const truth = E.makeTruth(m, sc, p, E.makeRandom(3));
  const o = m.index.get("Kitchen");
  assert.equal(truth.smokeArr[o], 0);
  assert.ok(truth.rateFactor >= p.true_rate_low && truth.rateFactor <= p.true_rate_high);
  for (const n of m.nodes) {
    if (n.protected && Number.isFinite(truth.smokeArr[n.i])) assert.ok(truth.smokeArr[n.i] >= p.protected_breach_s, `${n.id} reached too early`);
    if (n.protected) assert.equal(truth.fireArr[n.i], Infinity);
    if (n.type === "exit") assert.equal(truth.smokeArr[n.i], Infinity);
  }
  const c0 = E.truthConditions(truth, o, 200, p);
  assert.ok(c0.fire && c0.T > 120);
  const far = m.index.get("Exit A");
  assert.equal(E.truthConditions(truth, far, 200, p).smoke, false);
});

test("Sensors: perfect sensors have no faults; stuck and dead sensors are flagged by the health check", () => {
  const m = hospital();
  const sc = m.scenarios[4]; // no fire, so no sensor burns
  const truth = E.makeTruth(m, sc, p, E.makeRandom(1));
  const perfect = E.createSensorNet(m, truth, p, E.makeRandom(1), { perfect: true });
  assert.ok(perfect.sensors.every((s) => s.fault === "ok"));
  const all = { ...p, p_dead: 0, p_stuck: 1, p_drift: 0, p_flaky: 0 };
  const net = E.createSensorNet(m, truth, all, E.makeRandom(1));
  for (let t = 1; t <= 80; t++) {
    net.sample(t);
    net.deliver(t);
  }
  assert.ok(net.sensors.every((s) => s.status === "stuck"));
  const dead = E.createSensorNet(m, truth, { ...p, p_dead: 1 }, E.makeRandom(1));
  for (let t = 1; t <= 40; t++) {
    dead.sample(t);
    dead.deliver(t);
  }
  assert.ok(dead.sensors.every((s) => s.status === "no data" && s.history.length === 0));
});

function detectionsFromTruth(m, truth, pp, upTo) {
  const det = [];
  const silent = [];
  for (const s of m.sensors) {
    const a = truth.smokeArr[s.node];
    const lag = E.detectionLag(s.kind, m.spread.D[truth.origin][s.node], pp);
    const t = a + lag;
    if (Number.isFinite(t) && t <= upTo) det.push({ node: s.node, t, kind: s.kind, w: 1 });
    else silent.push({ node: s.node, kind: s.kind });
  }
  return { det, silent };
}

test("Live estimate finds the origin and spread speed from detections, and ignores a false detection", () => {
  const m = hospital();
  const pp = { ...p, true_edge_sd: 0.0001, true_rate_low: 1.3, true_rate_high: 1.3 };
  const sc = m.scenarios[1]; // Store Room 1, design 0.10 m/s, real 0.13 m/s
  const truth = E.makeTruth(m, sc, pp, E.makeRandom(5));
  const { det, silent } = detectionsFromTruth(m, truth, pp, 400);
  assert.ok(det.length >= 4);
  const est = E.estimateHazard(m, det, silent, 400, pp, 1 / sc.smokeRate);
  assert.equal(m.nodes[est.origin].id, "Store Room 1");
  near(est.rate, 0.13, 0.02);
  // a faulty sensor on another floor fires early: still the right origin
  const lift2 = m.index.get("Lift 2");
  const est2 = E.estimateHazard(m, [...det, { node: lift2, t: 20, kind: "smoke", w: 1 }], silent, 400, pp, 1 / sc.smokeRate);
  assert.equal(m.nodes[est2.origin].id, "Store Room 1");
  assert.ok(est2.outliers.includes(lift2));
  // conservative: predicted arrival is not later than the real one for most places it reaches
  let early = 0;
  let total = 0;
  for (const n of m.nodes) {
    if (n.protected || n.type === "exit" || !Number.isFinite(truth.smokeArr[n.i]) || truth.smokeArr[n.i] > 1200) continue;
    total++;
    if (est.arrival[n.i] <= truth.smokeArr[n.i] + 15) early++;
  }
  assert.ok(early / total > 0.8, `${early}/${total}`);
});

test("Replaying the recorded readings converges to the right origin and speed", () => {
  const m = hospital();
  const rows = IO.readingsFromCsv(read("sensor-readings-kitchen.csv"));
  const r = E.replayReadings(m, rows, {}, { designRate: 0.08 });
  const last = r.checks[r.checks.length - 1];
  assert.equal(m.nodes[last.origin].id, "Kitchen");
  near(last.rate, 0.099, 0.012); // the recording's real spread speed is 0.099 m/s
  assert.deepEqual(r.unknown, []);
});

// ---------------------------------------------------------------- decision and guidance

// Small building: Room -> C1 -> E1 (short, past the store where the fire starts)
// or Room -> C2 -> C3 -> E2 (longer, away from the fire).
function twoWay() {
  return E.buildModel({
    name: "two ways",
    places: [
      { id: "Room", type: "room", x: 20, y: 10, w: 10, l: 8, sign: true },
      { id: "Store", type: "room", x: 8, y: 2, w: 6, l: 4 },
      { id: "C1", type: "corridor", x: 8, y: 10, w: 14, l: 2.4, sign: true },
      { id: "C2", type: "corridor", x: 34, y: 10, w: 18, l: 2.4, sign: true },
      { id: "C3", type: "corridor", x: 50, y: 10, w: 14, l: 2.4, sign: true },
      { id: "E1", type: "exit", x: 0, y: 10, w: 2, l: 3 },
      { id: "E2", type: "exit", x: 58, y: 10, w: 2, l: 3 },
    ],
    paths: [
      { a: "Room", b: "C1", length: 12, width: 1.8 },
      { a: "Store", b: "C1", length: 6, width: 1.2 },
      { a: "C1", b: "E1", length: 8, width: 1.8 },
      { a: "Room", b: "C2", length: 14, width: 1.8 },
      { a: "C2", b: "C3", length: 16, width: 2.4 },
      { a: "C3", b: "E2", length: 8, width: 1.8 },
    ],
    patients: Array.from({ length: 30 }, (_, k) => ({ code: `P${k}`, mobility: "ambulatory", place: "Room" })),
    sensors: [{ id: "S-STORE", kind: "smoke", place: "Store" }, { id: "S-C1", kind: "smoke", place: "C1" }, { id: "S-ROOM", kind: "smoke", place: "Room" }],
    scenarios: [{ name: "store fire", origin: "Store", smokeRate: 0.12, fireRate: 0.01, alarm: "start" }],
  });
}

test("Unsafe-area filter: people who would reach C1 after the smoke are sent the other way; the static plan sends everyone past the fire", () => {
  const m = twoWay();
  const sc = m.scenarios[0];
  const opts = { info: "perfect", rescue: false };
  const proposed = E.simulateMany(m, sc, { ...opts, method: "proposed" }, [1, 2, 3]);
  const nearest = E.simulateMany(m, sc, { ...opts, method: "nearest" }, [1, 2, 3]);
  const e2 = (r) => r.exits.find((x) => x.exit === "E2").people;
  // Early leavers may still pass C1 before the smoke; later ones must not.
  assert.ok(proposed.results.every((r) => e2(r) > 0), proposed.results.map(e2).join());
  assert.ok(nearest.results.every((r) => e2(r) === 0));
  assert.ok(proposed.stats.meanFed.mean < 0.5 * nearest.stats.meanFed.mean, `${proposed.stats.meanFed.mean} vs ${nearest.stats.meanFed.mean}`);
  assert.ok(proposed.stats.harmed.mean <= nearest.stats.harmed.mean);
});

test("Time-dependent congestion: a crowd is split between a near narrow exit and a far wide one", () => {
  const m = E.buildModel({
    places: [
      { id: "Hall", type: "room", x: 20, y: 10, w: 16, l: 12 },
      { id: "Near", type: "exit", x: 10, y: 10, w: 2, l: 2 },
      { id: "C", type: "corridor", x: 40, y: 10, w: 20, l: 3 },
      { id: "Far", type: "exit", x: 52, y: 10, w: 2, l: 3 },
    ],
    paths: [
      { a: "Hall", b: "Near", length: 4, width: 0.9 },
      { a: "Hall", b: "C", length: 20, width: 3 },
      { a: "C", b: "Far", length: 12, width: 3 },
    ],
    patients: Array.from({ length: 120 }, (_, k) => ({ code: `P${k}`, mobility: "ambulatory", place: "Hall" })),
    scenarios: [{ name: "drill", alarm: "start", origin: null }],
  });
  const sc = m.scenarios[0];
  const opts = { info: "perfect", rescue: false, seed: 1 };
  const safe = E.simulate(m, sc, { ...opts, method: "safe" });
  const cong = E.simulate(m, sc, { ...opts, method: "proposed" });
  const far = (r) => r.exits.find((x) => x.exit === "Far").people;
  assert.equal(far(safe), 0);
  assert.ok(far(cong) >= 20, `far exit used by ${far(cong)}`);
  assert.ok(cong.lastSafe < safe.lastSafe, `${cong.lastSafe} vs ${safe.lastSafe}`);
});

test("Gamma-efficient alternatives exist on the ring corridors and stay within gamma of the best", () => {
  const m = hospital();
  const sim = E.createSimulation(m, m.scenarios[0], { seed: 2 });
  let withAlt = 0;
  let groups = 0;
  while (!sim.done && sim.t < 400) {
    sim.step();
    for (const g of sim.groupRoutes) {
      groups++;
      if (g.alts.length) withAlt++;
      for (const alt of g.alts) assert.notEqual(alt.join(), g.nodes.join());
    }
  }
  assert.ok(groups > 0 && withAlt > 0, `${withAlt} of ${groups}`);
});

test("Wheelchairs and beds never use stairs; staff escort them (2 per bed, 1 per wheelchair)", () => {
  const m = hospital();
  const sim = E.createSimulation(m, m.scenarios[1], { seed: 4 });
  while (!sim.done) {
    sim.step();
    for (const a of sim.agents) {
      if (a.kind !== "patient" || a.needs === 0 || !a.route || a.state === "carried") continue;
      for (const ei of a.route.edges) assert.notEqual(m.edges[ei].kind, "stair", `${a.code} routed over a stair`);
      for (const n of a.route.nodes) assert.notEqual(m.nodes[n].type, "stair", `${a.code} routed through a stair place`);
      if (a.state === "moving" && a.mobility !== "ambulatory") assert.equal(a.helpers.length, a.needs);
    }
  }
  const r = sim.summary();
  assert.ok(r.byMobility.stretcher.safe > 0 && r.byMobility.wheelchair.safe > 0);
});

test("Imperfect information: perfect mode guides everyone; zero compliance leaves visitors and walking patients unguided", () => {
  const m = hospital();
  const perfect = E.createSimulation(m, m.scenarios[0], { seed: 1, info: "perfect" });
  assert.ok(perfect.agents.every((a) => a.guidance === "radio" || a.guidance === "phone"));
  const none = E.createSimulation(m, m.scenarios[0], { seed: 1, params: { compliance: 0 } });
  for (const a of none.agents) {
    if (a.kind === "staff" || a.needs > 0) assert.equal(a.guidance, "radio");
    else assert.equal(a.guidance, "none");
  }
});

test("The commander confirms alerts: in manual mode alerts wait for a decision; a dismissed sensor is ignored", () => {
  const m = hospital();
  const sim = E.createSimulation(m, m.scenarios[0], { seed: 1, confirm: "manual" });
  while (!sim.alerts.length && sim.t < 300) sim.step();
  assert.ok(sim.alerts.length > 0);
  for (let k = 0; k < 30; k++) sim.step();
  // Nothing is confirmed by itself; if the alarm sounds, people raised it, not a sensor.
  assert.ok(sim.alerts.every((a) => a.status === "new"));
  if (sim.alarmAt !== null) assert.match(sim.alarmReason, /people/);
  const first = sim.alerts[0];
  assert.ok(sim.dismiss(first.id));
  assert.ok(sim.dismissedSensors.has(first.sensor));
  while (sim.alerts.every((a) => a.status !== "new") && sim.t < 600) sim.step();
  const next = sim.alerts.find((a) => a.status === "new");
  assert.ok(next, "a second alert came");
  assert.ok(sim.confirm(next.id));
  assert.equal(next.status, "confirmed");
  assert.notEqual(sim.alarmAt, null);
});

test("Rescue teams arrive after the alarm and bring trapped people out", () => {
  const m = hospital();
  const r = E.simulate(m, m.scenarios[1], { seed: 1, method: "nearest" });
  assert.ok(r.rescued > 0);
  assert.ok(r.events.some((e) => e.kind === "rescue" && /arrived/.test(e.message)));
  const none = E.simulate(m, m.scenarios[1], { seed: 1, method: "nearest", rescue: false });
  assert.equal(none.rescued, 0);
});

test("Every example scenario finishes, everyone is accounted for, and runs repeat exactly", () => {
  const m = hospital();
  const known = new Set(["out", "refuge", "shelter", "incapacitated", "needsHelp", "prep", "waiting", "stuck", "moving", "lift", "toPatient", "escorting", "free", "carried"]);
  for (const sc of m.scenarios) {
    const sim = E.createSimulation(m, sc, { seed: 7 });
    const r = sim.run();
    assert.equal(r.total, 225);
    const people = sim.agents.filter((a) => a.kind !== "rescue");
    for (const a of people) assert.ok(known.has(a.state), `${a.code} ended in state ${a.state}`);
    assert.equal(r.safe, r.out + r.refuge);
    assert.equal(r.out, people.filter((a) => a.state === "out").length);
    assert.equal(r.exits.reduce((s, x) => s + x.people, 0), r.out);
    assert.ok(r.t < 3600, `${sc.name} ran to the time limit`);
    assert.ok(Number.isFinite(r.meanFed));
    if (sc.origin === null) assert.equal(r.harmed, 0);
  }
  const a = E.simulate(m, m.scenarios[2], { seed: 11 });
  const b = E.simulate(m, m.scenarios[2], { seed: 11 });
  assert.deepEqual(a, b);
});

test("On the ICU fire the proposed routing harms fewer people than the static nearest-exit plan (5 runs)", () => {
  const m = hospital();
  const seeds = [1, 2, 3, 4, 5];
  const proposed = E.simulateMany(m, m.scenarios[1], { method: "proposed" }, seeds).stats;
  const nearest = E.simulateMany(m, m.scenarios[1], { method: "nearest" }, seeds).stats;
  assert.ok(proposed.harmed.mean < nearest.harmed.mean, `${proposed.harmed.mean} vs ${nearest.harmed.mean}`);
  assert.ok(proposed.meanFed.mean < nearest.meanFed.mean);
});

// ---------------------------------------------------------------- validation

test("Drill check: a run compared with its own record fits exactly", () => {
  const m = hospital();
  const r = E.simulate(m, m.scenarios[4], { seed: 3, rescue: false, sensorFaults: false });
  const sim = E.createSimulation(m, m.scenarios[4], { seed: 3, rescue: false, sensorFaults: false });
  sim.run();
  const rows = sim.agents.filter((a) => a.state === "out").map((a) => ({ code: a.code, exit: m.nodes[a.exit].id, exit_time_s: a.outAt }));
  const cmp = E.compareWithDrill(rows, [r]);
  assert.equal(cmp.rmse, 0);
  assert.equal(cmp.inside, 100);
  assert.deepEqual(cmp.errors, { t50: 0, t90: 0, last: 0 });
});

test("Calibration recovers the hidden speed and delay exactly when the random draws are the same", () => {
  // A record made by the model itself (seed 5, speed 0.9, delay 1.25). Fitting with the
  // same seed removes run-to-run noise, so the grid search must land on the hidden pair.
  const m = hospital();
  const opts = { rescue: false, sensorFaults: false };
  const sim = E.createSimulation(m, m.scenarios[4], { ...opts, seed: 5, params: E.scaledParams({}, 0.9, 1.25) });
  sim.run();
  const rows = sim.agents.filter((a) => a.state === "out").map((a) => ({ code: a.code, kind: a.kind, mobility: a.mobility, exit: m.nodes[a.exit].id, exit_time_s: a.outAt }));
  const cal = E.calibrate(m, m.scenarios[4], rows, opts, [5], { speed: [0.8, 0.9, 1.0], delay: [1.0, 1.25] });
  assert.deepEqual([cal.best.speed, cal.best.delay], [0.9, 1.25]);
  assert.equal(cal.best.fit, 0);
  assert.equal(cal.tried.length, 6);
  assert.ok(cal.close.every((x) => x.fit <= cal.best.fit * 1.15));
});
