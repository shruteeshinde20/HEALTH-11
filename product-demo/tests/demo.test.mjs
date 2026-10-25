// Tests for the Bharati product demo. Run: node --test product-demo/tests/
// Nothing here touches a database or the network: only the files in examples/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../engine.js";
import * as IO from "../io.js";
import { createStore } from "../store.js";
import { parseRequest, floorIn } from "../pages/assistant-parse.js";
import { predictor, anomalies, priority, recommendations } from "../pages/shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", "examples", f), "utf8");
const raw = () => JSON.parse(read("bharati.json"));
const MODEL = E.buildModel(raw());
const byName = (name) => MODEL.scenarios.find((s) => s.name === name);
const rooms = MODEL.nodes.filter((n) => !["corridor", "exit", "stair", "lift"].includes(n.type));
const exits = new Set(MODEL.exits);

// ---------------------------------------------------------------- building

test("The Bharati building has 6 floors, 265 places and 431 people, and says it is made up", () => {
  const d = raw();
  assert.deepEqual(MODEL.floors, [0, 1, 2, 3, 4, 5]);
  assert.equal(MODEL.nodes.length, 265);
  const visitors = MODEL.cameras.reduce((s, c) => s + c.count, 0);
  assert.equal(MODEL.people.filter((p) => p.kind === "patient").length, 205);
  assert.equal(MODEL.people.filter((p) => p.kind === "staff").length, 140);
  assert.equal(MODEL.people.length + visitors, 431);
  assert.equal(d.synthetic, true);
  assert.match(d.note, /Made-up/);
  assert.match(d.note, /Not the hospital's real floor plan or data/);
  // patients by code only
  for (const p of d.patients) assert.deepEqual(Object.keys(p).sort(), ["code", "criticality", "mobility", "place"]);
});

test("Every place has a way out on foot, and every place but a stair has a step-free way out for beds", () => {
  for (const n of MODEL.nodes) {
    if (n.type === "exit") continue;
    assert.ok(E.shortestPath(MODEL, n.i, exits, "walk"), `no walking route from ${n.id}`);
    if (n.type !== "stair") assert.ok(E.shortestPath(MODEL, n.i, exits, "bed"), `no bed route from ${n.id}`);
  }
});

// ---------------------------------------------------------------- classic algorithms

function validPath(r, from, cls) {
  assert.equal(r.nodes[0], from);
  assert.ok(exits.has(r.nodes[r.nodes.length - 1]));
  assert.equal(r.edges.length, r.nodes.length - 1);
  let len = 0;
  r.edges.forEach((ei, k) => {
    const e = MODEL.edges[ei];
    assert.ok((e.u === r.nodes[k] && e.v === r.nodes[k + 1]) || (e.v === r.nodes[k] && e.u === r.nodes[k + 1]), "edges do not join the nodes");
    assert.ok(E.edgeAllowed(MODEL, e, r.nodes[k + 1], cls, new Set()), "a path not allowed for this person");
    len += e.length;
  });
  assert.ok(Math.abs(len - r.length) < 1e-6);
}

test("BFS, DFS, Dijkstra and A* give valid routes; Dijkstra and A* are equally short and A* explores no more", () => {
  for (const cls of ["walk", "bed"]) {
    for (const n of rooms) {
      const r = Object.fromEntries(E.CLASSIC.map((a) => [a, E.classicRoute(MODEL, n.i, exits, cls, a)]));
      for (const a of E.CLASSIC) validPath(r[a], n.i, cls);
      assert.ok(Math.abs(r.dijkstra.length - r.astar.length) < 1e-6, `${n.id}: Dijkstra ${r.dijkstra.length} vs A* ${r.astar.length}`);
      assert.ok(r.astar.explored <= r.dijkstra.explored, `${n.id}: A* explored more`);
      assert.ok(r.bfs.nodes.length <= r.dijkstra.nodes.length, `${n.id}: BFS took more steps`);
      assert.ok(r.dfs.length >= r.dijkstra.length - 1e-6);
      for (const a of ["bfs", "dfs"]) assert.ok(r[a].length >= r.dijkstra.length - 1e-6);
    }
  }
  // Dijkstra matches the engine's own shortest path
  const k = MODEL.index.get("Kitchen");
  const sp = E.shortestPath(MODEL, k, exits, "walk");
  assert.ok(Math.abs(E.classicRoute(MODEL, k, exits, "walk", "dijkstra").length - sp.length) < 1e-6);
  assert.throws(() => E.createSimulation(MODEL, byName("Kitchen fire, ground floor"), { method: "nearest", algorithm: "greedy" }), /Unknown algorithm/);
});

test("A static plan with Dijkstra and with A* gives the same run, and the summary names the algorithm", () => {
  const sc = byName("Kitchen fire, ground floor");
  const a = E.simulate(MODEL, sc, { seed: 4, method: "nearest", algorithm: "dijkstra" });
  const b = E.simulate(MODEL, sc, { seed: 4, method: "nearest", algorithm: "astar" });
  assert.equal(a.algorithm, "dijkstra");
  assert.equal(b.algorithm, "astar");
  for (const k of ["safe", "t50", "t90", "lastSafe", "harmed", "meanFed"]) assert.equal(a[k], b[k], k);
});

// ---------------------------------------------------------------- new hazard during the run

test("Blocking a place during a run: routes are planned again and nobody new enters it", () => {
  const sc = byName("Evacuation drill (no hazard)");
  const sim = E.createSimulation(MODEL, sc, { seed: 2, method: "proposed" });
  for (let k = 0; k < 150; k++) sim.step();
  const n = MODEL.index.get("2 North 4");
  assert.ok(n !== undefined, "corridor 2 North 4 exists");
  const before = new Set(sim.agents.filter((a) => a.node === n).map((a) => a.id));
  assert.equal(sim.blockPlace(n, "blocked in the test"), true);
  assert.ok(sim.events.some((e) => /2 North 4 is blocked in the test/.test(e.message)));
  let entered = 0;
  const seen = new Set(before);
  while (!sim.done) {
    sim.step();
    for (const a of sim.agents) if (a.node === n && !seen.has(a.id)) {
      entered++;
      seen.add(a.id);
    }
  }
  assert.equal(entered, 0);
  assert.equal(sim.blockPlace(-1), false);
  // Places whose only way out was through the blocked corridor are cut off:
  // people there shelter; everybody else reaches safety by another way.
  const cut = new Set(MODEL.nodes.filter((x) => x.type !== "exit" && x.i !== n && !E.shortestPath(MODEL, x.i, exits, "walk", new Set(), new Set([n]))).map((x) => x.i));
  assert.deepEqual([...cut].map((i) => MODEL.nodes[i].id), ["Nurses Station 2"]);
  for (const a of sim.agents) {
    if (a.kind === "rescue") continue;
    if (cut.has(a.node)) assert.equal(a.state, "shelter", `${a.code} in a cut-off place`);
    else assert.ok(a.state === "out" || a.state === "refuge", `${a.code} is ${a.state} at ${MODEL.nodes[a.node].id}`);
  }
});

// ---------------------------------------------------------------- scenarios

test("All seven Bharati scenarios finish; drills get everyone out; the ICU and NICU fires are the hard ones", () => {
  assert.equal(MODEL.scenarios.length, 7);
  const out = {};
  for (const sc of MODEL.scenarios) {
    const r = E.simulate(MODEL, sc, { seed: 1, method: "proposed" });
    assert.equal(r.total, 431, sc.name);
    assert.ok(r.safe > 0.9 * r.total, `${sc.name}: only ${r.safe} safe`);
    out[sc.name] = r;
  }
  for (const name of ["Evacuation drill (no hazard)", "Drill with the Main Entrance closed"]) {
    assert.equal(out[name].safe, 431, name);
    assert.equal(out[name].harmed, 0, name);
    // a faulty sensor in a drill must not send people out of refuges again (run 2 had three)
    for (const seed of [2, 3]) assert.equal(E.simulate(MODEL, byName(name), { seed, method: "proposed" }).safe, 431, `${name}, run ${seed}`);
  }
  assert.equal(out["Drill with the Main Entrance closed"].exits.find((x) => x.exit === "Main Entrance").people, 0);
});

// ---------------------------------------------------------------- drill files and sensor recording

test("The example drill records load and the drill check runs against the model", () => {
  const a = IO.drillFromCsv(read("drill-a-full.csv"));
  const b = IO.drillFromCsv(read("drill-b-main-entrance-closed.csv"));
  assert.equal(a.length, 431);
  assert.equal(b.length, 431);
  assert.ok(!b.some((r) => r.exit === "Main Entrance"));
  const runs = [1, 2].map((seed) => E.simulate(MODEL, byName("Evacuation drill (no hazard)"), { seed, rescue: false, sensorFaults: false, strategy: "full" }));
  const cmp = E.compareWithDrill(a, runs);
  assert.ok(Number.isFinite(cmp.rmse) && cmp.rmse >= 0);
  assert.ok(Number.isFinite(cmp.fit));
  assert.deepEqual(Object.keys(cmp.groups).sort(), ["assisted", "staff", "walk"]);
});

test("Replaying the example kitchen sensor recording finds the fire on the ground floor near the kitchen", () => {
  const rows = IO.readingsFromCsv(read("sensor-readings-kitchen.csv"));
  const r = E.replayReadings(MODEL, rows, {}, { designRate: 0.08 });
  assert.equal(r.unknown.length, 0);
  const last = [...r.checks].reverse().find((c) => c.origin !== null);
  assert.ok(last, "an estimate was made");
  const o = MODEL.nodes[last.origin];
  assert.equal(o.floor, 0);
  const d = MODEL.spread.D[MODEL.index.get("Kitchen")][last.origin];
  assert.ok(d <= 30, `estimated origin ${o.id} is ${d} m from the Kitchen`);
  assert.ok(last.rate > 0.04 && last.rate < 0.25, `rate ${last.rate}`);
});

// ---------------------------------------------------------------- store (browser storage replaced by a map)

function fakeStorage() {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  return m;
}

test("Store: log-in is audited, failed log-ins too, deactivated users cannot log in", () => {
  fakeStorage();
  const s = createStore(raw());
  assert.equal(s.login("nobody@example.com").ok, false);
  assert.equal(s.state.audit[0].action, "failed login");
  const r = s.login("COMMANDER@bharati-demo.example ");
  assert.equal(r.ok, true);
  assert.equal(s.user().role, "Emergency Commander");
  assert.equal(s.state.audit[0].action, "login");
  s.state.users.find((u) => u.role === "Staff User").active = false;
  assert.equal(s.login("staff@bharati-demo.example").ok, false);
  s.logout();
  assert.equal(s.user(), null);
});

test("Store: a building change is checked first; a bad change leaves the data as it was", () => {
  fakeStorage();
  const s = createStore(raw());
  s.login("admin@bharati-demo.example");
  const before = JSON.stringify(s.data());
  assert.throws(() => s.updateData((d) => d.paths.push({ a: "Kitchen", b: "No Such Room", length: 3 }), "create", "bad path"), /does not exist/);
  assert.equal(JSON.stringify(s.data()), before);
  const rev = s.building().rev ?? 0;
  s.updateData((d) => (d.cameras[0].count = 30), "update", "count");
  assert.equal(s.building().rev, rev + 1);
  assert.equal(s.model().cameras[0].count, 30);
  assert.equal(s.state.audit[0].detail, "count");
});

test("Store: runs are saved with a short event list and at most 80 are kept; data survives a reload", () => {
  const storage = fakeStorage();
  const s = createStore(raw());
  s.login("admin@bharati-demo.example");
  const r = E.simulate(MODEL, byName("Kitchen fire, ground floor"), { seed: 1 });
  for (let k = 0; k < 85; k++) s.addRun(r, { scenario: "Kitchen", methodLabel: "Proposed", method: "proposed", seed: k });
  assert.equal(s.state.runs.length, 80);
  assert.ok(s.state.runs[0].summary.events.length <= 80);
  assert.equal(s.state.runs[0].summary.estimates, undefined);
  assert.ok(storage.size >= 1);
  const again = createStore(raw());
  assert.equal(again.state.runs.length, 80);
  assert.equal(again.user().email, "admin@bharati-demo.example");
});

// ---------------------------------------------------------------- assistant

const places = MODEL.nodes.map((n) => ({ id: n.id, type: n.type, floor: n.floor }));

test("Assistant: reads the place, the floor, the smoke speed, closed exits and information problems", () => {
  let r = parseRequest("Fire in NICU Bay 2, spreading fast", places);
  assert.equal(r.kind, "scenario");
  assert.equal(r.scenario.origin, "NICU Bay 2");
  assert.equal(r.scenario.smokeRate, 0.15);
  r = parseRequest("short circuit in the store room on the third floor", places);
  assert.equal(r.scenario.origin, "Store Room 3");
  r = parseRequest("smoke in the store room", places);
  assert.equal(r.kind, "clarify");
  assert.ok(r.options.includes("Store Room 1") && r.options.includes("Store Room 5"));
  r = parseRequest("Kitchen fire with the Main Entrance closed and broken sensors, no phones", places);
  assert.equal(r.scenario.origin, "Kitchen");
  assert.deepEqual(r.scenario.closed, ["Main Entrance"]);
  assert.equal(r.scenario.params.p_dead, 0.2);
  assert.equal(r.scenario.params.phone_patient, 0);
  r = parseRequest("fire in OT 3 at 0.12 m/s", places);
  assert.equal(r.scenario.smokeRate, 0.12);
  r = parseRequest("Run a drill with Stair A closed", places);
  assert.equal(r.scenario.origin, null);
  assert.equal(r.scenario.closed.length, 6);
  assert.equal(parseRequest("summarise the last run", places).kind, "summary");
  assert.equal(parseRequest("what is the weather", places).kind, "unknown");
  assert.equal(parseRequest("", places).kind, "unknown");
  assert.equal(floorIn("the 2nd floor"), 2);
  assert.equal(floorIn("ground floor kitchen"), 0);
  // every scenario it writes is accepted by the engine
  for (const q of ["Fire in NICU Bay 2", "Kitchen fire with the Main Entrance closed", "drill with stair B closed"]) {
    const x = parseRequest(q, places);
    assert.doesNotThrow(() => E.normaliseScenario(x.scenario, MODEL.index));
  }
});

// ---------------------------------------------------------------- AI features

test("Predictor needs 12 runs, fits a straight line and is tested on held-out runs; alerts need 50 runs", () => {
  const few = Array.from({ length: 11 }, (_, i) => ({ summary: { t90: 600 + i }, features: { people: 400, smokeRate: 0.08, bedShare: 0.1, method: "proposed" } }));
  assert.equal(predictor(few).ready, false);
  // t90 = 300 + 2*people + 4000*smokeRate + 500*bedShare - 100*proposed, exactly
  const runs = [];
  for (let i = 0; i < 24; i++) {
    const f = { people: 300 + 10 * i, smokeRate: 0.05 + 0.01 * (i % 7), bedShare: 0.05 + 0.02 * (i % 5), method: i % 2 ? "proposed" : "nearest" };
    runs.push({ summary: { t90: 300 + 2 * f.people + 4000 * f.smokeRate + 500 * f.bedShare - (f.method === "proposed" ? 100 : 0) }, features: f });
  }
  const p = predictor(runs);
  assert.equal(p.ready, true);
  assert.equal(p.test, 6);
  assert.ok(p.mae < 1e-3, `mean error ${p.mae}`);
  assert.ok(Math.abs(p.predict({ people: 400, smokeRate: 0.1, bedShare: 0.1, method: "proposed" }) - (300 + 800 + 400 + 50 - 100)) < 1e-3);
  assert.equal(anomalies(runs).ready, false);
});

test("Priority: a ventilated patient near the fire comes before a walking patient far away", () => {
  const sc = byName("Short circuit in Store Room 3 beside the ICUs (floor 3)");
  const pats = MODEL.people.filter((x) => x.kind === "patient");
  const vent = pats.find((x) => x.mobility === "ventilator" && MODEL.nodes[x.home].floor === 3);
  const walk = pats.find((x) => x.mobility === "ambulatory" && MODEL.nodes[x.home].floor === 0);
  assert.ok(vent && walk);
  const a = priority(MODEL, vent, sc);
  const b = priority(MODEL, walk, sc);
  assert.ok(a.score > b.score, `${a.score} vs ${b.score}`);
  assert.ok(a.score >= 0 && a.score <= 100 && b.score >= 0);
  assert.equal(b.parts.hazard, 0);
});

test("Recommendations name a bottleneck and harm, and say so when nothing stood out", () => {
  const rec = recommendations({ busiest: [{ path: "A - B", maxDensity: 2.6 }], incapacitated: 2, t90: 500, total: 10 }, MODEL);
  assert.ok(rec.some((r) => /A - B/.test(r.text)));
  assert.ok(rec.some((r) => r.tone === "bad"));
  assert.equal(recommendations({ busiest: [], t90: 100, total: 10 }, MODEL)[0].tone, "ok");
});
