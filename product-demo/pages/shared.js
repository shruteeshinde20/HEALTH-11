// Helpers shared by several pages.
import * as E from "../engine.js";

export const METHOD_LABEL = {
  proposed: "Hazard-aware (proposed): time, crowding and smoke dose",
  congestion: "Congestion-aware (no smoke forecast)",
  safe: "Shortest safe path (smoke filter only)",
  nearest: "Static plan, nearest exit",
};
export const ALGO_LABEL = { bfs: "BFS", dfs: "DFS", dijkstra: "Dijkstra", astar: "A*" };
export const METHOD_COLOUR = { nearest: "#6250D6", safe: "#EDA100", congestion: "#2A78D6", proposed: "#0B7A4B", bfs: "#6250D6", dfs: "#E34948", dijkstra: "#2A78D6", astar: "#0B7A4B" };

// The raw scenario (as stored) and its extra settings for imperfect information.
export function scenarioList(store) {
  return store.data().scenarios ?? [];
}
export function scenarioParams(raw) {
  return raw?.params ?? {};
}
export function optionsFor(store, raw, extra = {}) {
  return { params: { ...store.state.params, ...scenarioParams(raw) }, ...extra };
}

export function methodName(method, algorithm) {
  if (method === "nearest") return `Static plan (${ALGO_LABEL[algorithm ?? "dijkstra"]})`;
  return METHOD_LABEL[method] ?? method;
}

// Plain-language recommendations from a run (rule-based; every rule says why).
export function recommendations(summary, model) {
  const out = [];
  const busy = (summary.busiest ?? []).filter((b) => b.maxDensity >= 2);
  for (const b of busy.slice(0, 3)) out.push({ tone: "warn", text: `The path ${b.path} reached ${b.maxDensity} people per m². Send some groups another way earlier, or widen this path.` });
  if ((summary.maxHelpWait ?? 0) > 300) out.push({ tone: "warn", text: `Some patients waited ${Math.round(summary.maxHelpWait / 60)} minutes for staff. Put more staff on duty near wheelchair and bed patients, or practise faster preparation.` });
  if ((summary.incapacitated ?? 0) > 0) out.push({ tone: "bad", text: `${summary.incapacitated} people were overcome by smoke. Check which rooms they were in (People reached by the hazard) and plan to move those rooms first.` });
  if ((summary.shelter ?? 0) > 0) out.push({ tone: "warn", text: `${summary.shelter} people had to shelter with no safe route. Their rooms need a second way out or a protected refuge nearby.` });
  const faults = summary.sensorFaults ?? {};
  const bad = (faults.dead ?? 0) + (faults.stuck ?? 0) + (faults.biased ?? 0) + (faults.flaky ?? 0);
  if (bad > 0) out.push({ tone: "pri", text: `${bad} sensors had a fault in this run (dead, stuck, reading too high or losing readings). Test sensors regularly; the system works around faults but sees less.` });
  if (summary.t90 === null && summary.total) out.push({ tone: "bad", text: "Fewer than 90% of people reached safety in the simulated time. Review the plan before relying on it." });
  const lift = (summary.byMobility?.stretcher?.meanSafe ?? 0) > 1200;
  if (lift) out.push({ tone: "pri", text: "Bed patients took on average more than 20 minutes to reach safety. Moving them sideways to a refuge first is usually faster than taking them down by lift." });
  if (!out.length) out.push({ tone: "ok", text: "No problem stood out in this run. Run more scenarios and seeds before drawing conclusions." });
  void model;
  return out;
}

// ---------------------------------------------------------------- AI features (honest, small)

// Evacuation-time predictor: least-squares line on the stored runs
// (features: people, smoke spread speed, share of bed patients, method).
// It is a surrogate of this simulator, not a measurement.
export function predictor(runs) {
  const rows = runs.filter((r) => r.summary.t90 !== null && r.features);
  const need = 12;
  if (rows.length < need) return { ready: false, have: rows.length, need };
  const X = rows.map((r) => [1, r.features.people / 100, r.features.smokeRate * 10, r.features.bedShare * 10, r.features.method === "proposed" ? 1 : 0]);
  const y = rows.map((r) => r.summary.t90);
  // hold out every fourth run for testing
  const train = X.map((x, i) => i).filter((i) => i % 4 !== 3);
  const test = X.map((x, i) => i).filter((i) => i % 4 === 3);
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const bvec = new Array(k).fill(0);
  for (const i of train) for (let a = 0; a < k; a++) {
    bvec[a] += X[i][a] * y[i];
    for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c];
  }
  for (let a = 0; a < k; a++) A[a][a] += 1e-6;
  const w = solve(A, bvec);
  if (!w) return { ready: false, have: rows.length, need, note: "The data does not vary enough to fit a model." };
  const pred = (x) => x.reduce((s, v, j) => s + v * w[j], 0);
  const errs = test.map((i) => pred(X[i]) - y[i]);
  const mae = errs.reduce((s, e) => s + Math.abs(e), 0) / Math.max(1, errs.length);
  const mean = test.reduce((s, i) => s + y[i], 0) / Math.max(1, test.length);
  const ssTot = test.reduce((s, i) => s + (y[i] - mean) ** 2, 0);
  const ssRes = errs.reduce((s, e) => s + e * e, 0);
  return { ready: true, have: rows.length, w, mae, r2: ssTot > 0 ? 1 - ssRes / ssTot : null, test: test.length, predict: (f) => pred([1, f.people / 100, f.smokeRate * 10, f.bedShare * 10, f.method === "proposed" ? 1 : 0]) };
}
function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Unusual runs: the main app uses IsolationForest with at least 50 runs.
// Here: a simple distance from the median on three features, only with 50+ runs.
export function anomalies(runs) {
  const need = 50;
  if (runs.length < need) return { ready: false, have: runs.length, need };
  const feats = runs.map((r) => [r.summary.lastSafe ?? r.summary.t, r.summary.busiest?.[0]?.maxDensity ?? 0, r.summary.harmed ?? 0]);
  const med = [0, 1, 2].map((j) => median(feats.map((f) => f[j])));
  const mad = [0, 1, 2].map((j) => median(feats.map((f) => Math.abs(f[j] - med[j]))) || 1);
  const flagged = [];
  runs.forEach((r, i) => {
    const z = Math.max(...[0, 1, 2].map((j) => Math.abs(feats[i][j] - med[j]) / (1.4826 * mad[j])));
    if (z > 3.5) flagged.push({ run: r, z });
  });
  return { ready: true, have: runs.length, flagged };
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

export function runFeatures(model, raw, method) {
  const people = model.people.length + model.cameras.reduce((s, c) => s + c.count, 0);
  const beds = model.people.filter((p) => p.mobility === "stretcher" || p.mobility === "ventilator").length;
  return { people, smokeRate: raw?.smokeRate ?? 0, bedShare: beds / Math.max(1, people), method };
}

// Patient priority (rule-based, the main app's AI feature 2): mobility, criticality, distance to the hazard.
export const PRIORITY_WEIGHTS = { mobility: 0.4, criticality: 0.3, hazard: 0.3 };
const MOB = { ambulatory: 0.25, wheelchair: 0.5, stretcher: 0.75, ventilator: 1 };
export function priority(model, person, scenario) {
  const mob = MOB[person.mobility] ?? 0.25;
  const crit = (person.criticality - 1) / 4;
  let haz = 0;
  if (scenario && scenario.origin) {
    const o = model.index.get(scenario.origin);
    const d = model.spread.D[o][person.home];
    haz = Number.isFinite(d) ? Math.max(0, 1 - d / 120) : 0;
  }
  const score = PRIORITY_WEIGHTS.mobility * mob + PRIORITY_WEIGHTS.criticality * crit + PRIORITY_WEIGHTS.hazard * haz;
  return { score: Math.round(score * 100), parts: { mobility: mob, criticality: crit, hazard: haz } };
}

export { E };
