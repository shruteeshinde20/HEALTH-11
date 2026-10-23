// HEALTH-11 prototype: evacuation simulation engine.
// Pure functions, no browser code, so the same file runs in the page and in
// `node --test`. All distances are metres, times seconds, speeds m/s.

// ---------------------------------------------------------------------------
// Sources and parameters
// ---------------------------------------------------------------------------

export const SOURCES = {
  NIST1722: {
    short: "NIST TN 1722 (SFPE hydraulic model)",
    full: "P. A. Reneke, P. Tofilo, R. D. Peacock, B. L. Hoskins, \"Simple Estimates of Combined Stairwell / Elevator Egress in Buildings\", NIST Technical Note 1722, Feb. 2013. It restates the SFPE Handbook speed-density relation S = k - a k D with a = 0.266, k = 1.40 m/s for corridors and 1.00-1.23 m/s for stairs; below 0.54 people/m2 the speed is S(0.54).",
    url: "https://www.govinfo.gov/content/pkg/GOVPUB-C13-44695726b38382de9cb5d09b30afe045/pdf/GOVPUB-C13-44695726b38382de9cb5d09b30afe045.pdf",
  },
  ALONSO2016: {
    short: "Alonso-Gutierrez & Ronchi 2016",
    full: "V. Alonso-Gutierrez, E. Ronchi, \"The simulation of assisted evacuation in hospitals\", Fire and Evacuation Modeling Technical Conference (FEMTC), 2016. Tables 1 and 2: patient preparation times, staff pre-evacuation time, unimpeded and transport speeds, at least two personnel per assisted patient.",
    url: "https://files.thunderheadeng.com/femtc/2016_d2-05-alonso-paper.pdf",
  },
  PATHFINDER: {
    short: "Pathfinder SFPE technical reference",
    full: "Thunderhead Engineering, Pathfinder Technical Reference, SFPE mode: minimum speed fraction default 0.15; maximum room density default 3.55 people/m2; SFPE stair k table (7 in riser / 11 in tread gives k = 1.08).",
    url: "https://www.thunderheadeng.com/docs/2026-1/pathfinder/appendices/technical-reference/sfpe",
  },
  CCRP: {
    short: "Lu, George & Shekhar 2005 (CCRP) [12]",
    full: "Q. Lu, B. George, S. Shekhar, \"Capacity Constrained Routing Algorithms for Evacuation Planning: A Summary of Results\", SSTD 2005. The exit balancing here is a simpler idea in the same spirit: each route counts the people already sent to an exit.",
    url: "",
  },
  ASSUMED: { short: "Assumed, to be validated", full: "No published value was found; the hospital should replace it with its own measured value.", url: "" },
  DERIVED: { short: "Derived", full: "Calculated from the sourced values above.", url: "" },
  HEALTH11: { short: "HEALTH-11 default", full: "Same rule as the main HEALTH-11 application.", url: "" },
};

// kind: "sourced" | "derived" | "assumed" | "policy"
export const PARAMS = [
  // Crowd movement (SFPE hydraulic model)
  { key: "sfpe_a", group: "Crowd movement", label: "Speed-density constant a", value: 0.266, unit: "m2/person", source: "NIST1722", kind: "sourced" },
  { key: "k_level", group: "Crowd movement", label: "k for corridors, rooms and ramps", value: 1.40, unit: "m/s", source: "NIST1722", kind: "sourced" },
  { key: "k_stair", group: "Crowd movement", label: "k for stairs (7 in riser, 11 in tread)", value: 1.08, unit: "m/s", source: "PATHFINDER", kind: "sourced" },
  { key: "d_free", group: "Crowd movement", label: "Density below which people walk freely", value: 0.54, unit: "people/m2", source: "NIST1722", kind: "sourced" },
  { key: "min_speed_fraction", group: "Crowd movement", label: "Slowest speed in a crowd (fraction of free speed)", value: 0.15, unit: "-", source: "PATHFINDER", kind: "sourced" },
  { key: "d_max", group: "Crowd movement", label: "Most people per m2 on a path", value: 3.55, unit: "people/m2", source: "PATHFINDER", kind: "sourced" },
  // Speeds
  { key: "speed_staff", group: "Speeds", label: "Staff walking speed (mean)", value: 1.35, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_staff_sd", group: "Speeds", label: "Staff walking speed (standard deviation)", value: 0.25, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_patient_min", group: "Speeds", label: "Walking patient speed, lowest", value: 0.84, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_patient_max", group: "Speeds", label: "Walking patient speed, highest", value: 1.40, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_visitor", group: "Speeds", label: "Visitor walking speed (SFPE free speed: 1.40 x (1 - 0.266 x 0.54))", value: 1.199, unit: "m/s", source: "DERIVED", kind: "derived" },
  { key: "speed_wheelchair", group: "Speeds", label: "Wheelchair pushed by staff (mean)", value: 0.63, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_bed", group: "Speeds", label: "Stretcher or bed moved by staff (mean)", value: 0.40, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_transport_sd", group: "Speeds", label: "Wheelchair and stretcher speed (standard deviation)", value: 0.04, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  // Delays before moving
  { key: "staff_premove_mean", group: "Delays", label: "Staff reaction time after the alarm (log-normal mean)", value: 71, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "staff_premove_sd", group: "Delays", label: "Staff reaction time (log-normal standard deviation)", value: 60, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_ambulatory_mean", group: "Delays", label: "Walking patient preparation (mean; range 30-90 s)", value: 60, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_ambulatory_sd", group: "Delays", label: "Walking patient preparation (standard deviation)", value: 20, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_wheelchair_mean", group: "Delays", label: "Wheelchair patient preparation (mean; range 100-120 s)", value: 110, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_wheelchair_sd", group: "Delays", label: "Wheelchair patient preparation (standard deviation)", value: 36, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_bed_mean", group: "Delays", label: "Stretcher patient preparation (mean; range 180-900 s)", value: 360, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_bed_sd", group: "Delays", label: "Stretcher patient preparation (standard deviation)", value: 40, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_ventilator_extra", group: "Delays", label: "Extra preparation for a ventilator patient", value: 0, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "visitor_premove_mean", group: "Delays", label: "Visitor reaction time (mean; uses the walking patient figure)", value: 60, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "visitor_premove_sd", group: "Delays", label: "Visitor reaction time (standard deviation)", value: 20, unit: "s", source: "ASSUMED", kind: "assumed" },
  // Staff help
  { key: "escort_wheelchair", group: "Staff help", label: "Staff needed for a wheelchair patient", value: 1, unit: "staff", source: "ASSUMED", kind: "assumed" },
  { key: "escort_bed", group: "Staff help", label: "Staff needed for a stretcher or ventilator patient", value: 2, unit: "staff", source: "ALONSO2016", kind: "sourced" },
  { key: "space_wheelchair", group: "Staff help", label: "Space taken by a wheelchair and helper (in walking people)", value: 2, unit: "people", source: "ASSUMED", kind: "assumed" },
  { key: "space_bed", group: "Staff help", label: "Space taken by a bed and its staff (in walking people)", value: 4, unit: "people", source: "ASSUMED", kind: "assumed" },
  // Lifts
  { key: "lift_capacity", group: "Lifts", label: "Lift load per trip (in walking people)", value: 4, unit: "people", source: "ASSUMED", kind: "assumed" },
  { key: "lift_speed", group: "Lifts", label: "Lift speed", value: 1.0, unit: "m/s", source: "ASSUMED", kind: "assumed" },
  { key: "lift_door_s", group: "Lifts", label: "Lift loading and unloading time per trip", value: 20, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "floor_height", group: "Lifts", label: "Height of one floor", value: 4, unit: "m", source: "ASSUMED", kind: "assumed" },
  { key: "lifts_for_walkers", group: "Lifts", label: "People who can walk may use lifts (1 = yes, 0 = no)", value: 0, unit: "-", source: "HEALTH11", kind: "policy" },
  // Hazards, sensors and alarm
  { key: "risk_penalty_m", group: "Hazards and alarm", label: "Extra route cost for a place at full risk", value: 50, unit: "m", source: "HEALTH11", kind: "policy" },
  { key: "risk_horizon_s", group: "Hazards and alarm", label: "A hazard this many seconds away starts to count as risk", value: 300, unit: "s", source: "HEALTH11", kind: "policy" },
  { key: "smoke_block_severity", group: "Hazards and alarm", label: "Smoke of this severity or more blocks a place", value: 4, unit: "1-5", source: "HEALTH11", kind: "policy" },
  { key: "sensor_delay_s", group: "Hazards and alarm", label: "Sensor response time after the hazard arrives", value: 30, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "confirm_delay_s", group: "Hazards and alarm", label: "Commander confirmation time (automatic runs)", value: 30, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "discovery_delay_s", group: "Hazards and alarm", label: "Time for people to raise the alarm when a hazard reaches them and no sensor did", value: 30, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "time_limit_s", group: "Hazards and alarm", label: "Longest time simulated", value: 3600, unit: "s", source: "HEALTH11", kind: "policy" },
];

export function defaultParams() {
  return Object.fromEntries(PARAMS.map((p) => [p.key, p.value]));
}

export const PLACE_TYPES = ["room", "ward", "icu", "corridor", "stair", "ramp", "lift", "exit", "assembly"];
export const MOBILITIES = ["ambulatory", "wheelchair", "stretcher", "ventilator"];
export const HAZARD_TYPES = ["fire", "smoke", "hazmat", "structural"];
export const SENSOR_KINDS = ["smoke", "heat", "gas"];
export const ALGORITHMS = ["bfs", "dfs", "dijkstra", "astar"];

// Which sensor sees which hazard.
export const SENSOR_SEES = { smoke: ["smoke", "fire"], heat: ["fire"], gas: ["hazmat"] };

// ---------------------------------------------------------------------------
// Random numbers (seeded, so every run can be repeated)
// ---------------------------------------------------------------------------

export function makeRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(random, mean, sd) {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Log-normal with the given mean and standard deviation of the result.
export function logNormal(random, mean, sd) {
  const s2 = Math.log(1 + (sd / mean) ** 2);
  const mu = Math.log(mean) - s2 / 2;
  return Math.exp(normal(random, mu, Math.sqrt(s2)));
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Crowd movement: SFPE speed-density relation
// ---------------------------------------------------------------------------

// Fraction of free walking speed at density D (people/m2):
// S(D) = k (1 - a D); free speed is S(d_free); never below min_speed_fraction.
export function speedFraction(density, p) {
  if (density <= p.d_free) return 1;
  const f = (1 - p.sfpe_a * density) / (1 - p.sfpe_a * p.d_free);
  return clamp(f, p.min_speed_fraction, 1);
}

// Highest flow per metre of width: F = k (1 - a D) D is largest at D = 1/(2a),
// where it equals k / (4a).
export function maxSpecificFlow(k, p) {
  return k / (4 * p.sfpe_a);
}

// ---------------------------------------------------------------------------
// Building model
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}

function num(value, what, { min = -Infinity, max = Infinity, positive = false } = {}) {
  const v = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what} must be a number`);
  if (positive && v <= 0) fail(`${what} must be more than 0`);
  if (v < min || v > max) fail(`${what} must be between ${min} and ${max}`);
  return v;
}

function text(value, what, max = 80) {
  if (typeof value !== "string" || !value.trim()) fail(`${what} is missing`);
  const v = value.trim();
  if (v.length > max) fail(`${what} is longer than ${max} characters`);
  return v;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  fail(`"${value}" is not true or false`);
}

export const LIMITS = { places: 2000, paths: 5000, people: 5000, sensors: 2000 };

// Checks building data and returns the model the simulator uses.
export function buildModel(data) {
  if (!data || typeof data !== "object") fail("The building file is empty");
  const name = text(data.name ?? "Imported building", "Building name", 120);
  const places = Array.isArray(data.places) ? data.places : fail("The file has no places");
  const paths = Array.isArray(data.paths) ? data.paths : fail("The file has no paths");
  if (places.length > LIMITS.places) fail(`Too many places (most ${LIMITS.places})`);
  if (paths.length > LIMITS.paths) fail(`Too many paths (most ${LIMITS.paths})`);

  const nodes = [];
  const index = new Map();
  for (const [i, raw] of places.entries()) {
    const id = text(raw.id ?? raw.name, `Place ${i + 1}: name`);
    if (index.has(id)) fail(`Place "${id}" appears twice`);
    const type = text(raw.type, `Place "${id}": type`).toLowerCase();
    if (!PLACE_TYPES.includes(type)) fail(`Place "${id}": type "${type}" is not one of ${PLACE_TYPES.join(", ")}`);
    const node = {
      i: nodes.length,
      id,
      type,
      floor: Math.round(num(raw.floor ?? 0, `Place "${id}": floor`, { min: -10, max: 200 })),
      x: num(raw.x, `Place "${id}": x`, { min: -10000, max: 10000 }),
      y: num(raw.y, `Place "${id}": y`, { min: -10000, max: 10000 }),
      w: num(raw.w ?? raw.width_m ?? 4, `Place "${id}": width`, { positive: true, max: 1000 }),
      l: num(raw.l ?? raw.length_m ?? 4, `Place "${id}": length`, { positive: true, max: 1000 }),
      evacLift: bool(raw.evacLift ?? raw.is_evacuation_lift, false),
      blocked: bool(raw.blocked ?? raw.is_blocked, false),
    };
    index.set(id, node.i);
    nodes.push(node);
  }

  const edges = [];
  const adj = nodes.map(() => []);
  const seen = new Set();
  for (const [i, raw] of paths.entries()) {
    const a = text(raw.a ?? raw.from ?? raw.from_node, `Path ${i + 1}: from`);
    const b = text(raw.b ?? raw.to ?? raw.to_node, `Path ${i + 1}: to`);
    if (!index.has(a)) fail(`Path ${i + 1}: place "${a}" does not exist`);
    if (!index.has(b)) fail(`Path ${i + 1}: place "${b}" does not exist`);
    if (a === b) fail(`Path ${i + 1}: a path cannot join "${a}" to itself`);
    const key = [a, b].sort().join("\u0000");
    if (seen.has(key)) fail(`Path ${a} - ${b} appears twice`);
    seen.add(key);
    const u = index.get(a);
    const v = index.get(b);
    const nu = nodes[u];
    const nv = nodes[v];
    let kind = "flat";
    if (nu.type === "stair" && nv.type === "stair" && nu.floor !== nv.floor) kind = "stair";
    else if (nu.type === "lift" && nv.type === "lift" && nu.floor !== nv.floor) kind = "lift";
    else if (nu.floor !== nv.floor) fail(`Path ${a} - ${b} joins two floors but is not stair-to-stair or lift-to-lift`);
    const edge = {
      i: edges.length,
      u,
      v,
      kind,
      length: num(raw.length ?? raw.distance, `Path ${a} - ${b}: length`, { positive: true, max: 10000 }),
      width: num(raw.width ?? 1.2, `Path ${a} - ${b}: width`, { positive: true, max: 100 }),
      wheelchair: bool(raw.wheelchair ?? raw.wheelchair_accessible, true),
      stretcher: bool(raw.stretcher ?? raw.stretcher_accessible, true),
      blocked: bool(raw.blocked ?? raw.is_blocked, false),
    };
    edges.push(edge);
    adj[u].push(edge.i);
    adj[v].push(edge.i);
  }

  // A lift car passes floors inside its shaft, so every pair of stops in one
  // shaft gets a direct (virtual) lift path: smoke in a middle lobby does not
  // stop a ride between two other floors.
  const liftGroup = new Map();
  for (const n of nodes) {
    if (n.type !== "lift" || liftGroup.has(n.i)) continue;
    const members = [];
    const stack = [n.i];
    liftGroup.set(n.i, members);
    while (stack.length) {
      const u = stack.pop();
      members.push(u);
      for (const ei of adj[u]) {
        const e = edges[ei];
        if (e.kind !== "lift") continue;
        const v = e.u === u ? e.v : e.u;
        if (!liftGroup.has(v)) {
          liftGroup.set(v, members);
          stack.push(v);
        }
      }
    }
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const u = members[x];
        const v = members[y];
        if (adj[u].some((ei) => edges[ei].u === v || edges[ei].v === v)) continue;
        const edge = { i: edges.length, u, v, kind: "lift", virtual: true, length: Math.abs(nodes[u].floor - nodes[v].floor) * 4, width: 1.2, wheelchair: true, stretcher: true, blocked: false };
        edges.push(edge);
        adj[u].push(edge.i);
        adj[v].push(edge.i);
      }
    }
  }

  const exits = nodes.filter((n) => n.type === "exit").map((n) => n.i);
  if (exits.length === 0) fail("The building has no exit");

  const place = (value, what) => {
    const id = text(value, what);
    if (!index.has(id)) fail(`${what}: place "${id}" does not exist`);
    return index.get(id);
  };

  const people = [];
  const codes = new Set();
  const addCode = (code) => {
    if (codes.has(code)) fail(`Code "${code}" is used twice`);
    codes.add(code);
  };
  for (const [i, raw] of (data.patients ?? []).entries()) {
    const code = text(raw.code ?? raw.patient_code, `Patient ${i + 1}: code`, 40);
    addCode(code);
    const mobility = text(raw.mobility, `Patient ${code}: mobility`).toLowerCase();
    if (!MOBILITIES.includes(mobility)) fail(`Patient ${code}: mobility "${mobility}" is not one of ${MOBILITIES.join(", ")}`);
    people.push({ kind: "patient", code, mobility, criticality: Math.round(num(raw.criticality ?? 1, `Patient ${code}: criticality`, { min: 1, max: 5 })), home: place(raw.place, `Patient ${code}`) });
  }
  for (const [i, raw] of (data.staff ?? []).entries()) {
    const code = text(raw.code ?? raw.staff_code, `Staff ${i + 1}: code`, 40);
    addCode(code);
    people.push({ kind: "staff", code, role: String(raw.role ?? "staff").slice(0, 40), mobility: "ambulatory", criticality: 1, home: place(raw.place, `Staff ${code}`) });
  }
  if (people.length > LIMITS.people) fail(`Too many people (most ${LIMITS.people})`);

  const sensors = [];
  const sensorIds = new Set();
  for (const [i, raw] of (data.sensors ?? []).entries()) {
    const id = text(raw.id, `Sensor ${i + 1}: id`, 40);
    if (sensorIds.has(id)) fail(`Sensor "${id}" appears twice`);
    sensorIds.add(id);
    const kind = text(raw.kind, `Sensor ${id}: kind`).toLowerCase();
    if (!SENSOR_KINDS.includes(kind)) fail(`Sensor ${id}: kind "${kind}" is not one of ${SENSOR_KINDS.join(", ")}`);
    sensors.push({ id, kind, node: place(raw.place, `Sensor ${id}`) });
  }
  const cameras = [];
  for (const [i, raw] of (data.cameras ?? []).entries()) {
    const id = text(raw.id, `Camera ${i + 1}: id`, 40);
    if (sensorIds.has(id)) fail(`Device "${id}" appears twice`);
    sensorIds.add(id);
    cameras.push({ id, node: place(raw.place, `Camera ${id}`), count: Math.round(num(raw.count ?? 0, `Camera ${id}: count`, { min: 0, max: 2000 })) });
  }
  if (sensors.length + cameras.length > LIMITS.sensors) fail(`Too many devices (most ${LIMITS.sensors})`);

  const floors = [...new Set(nodes.map((n) => n.floor))].sort((a, b) => a - b);
  return { name, synthetic: bool(data.synthetic, false), nodes, edges, adj, index, exits, people, sensors, cameras, floors };
}

export function other(edge, node) {
  return edge.u === node ? edge.v : edge.u;
}

// ---------------------------------------------------------------------------
// Hazards
// ---------------------------------------------------------------------------

export function blocks(type, severity, p) {
  if (type === "smoke") return severity >= p.smoke_block_severity;
  return true;
}

// Each hazard gets the time it reaches every place (Infinity = never).
// Spread: along paths at spreadRate m/s from the origin, starting at startS.
// Imported hazards (from a fire model) give the times directly.
export function hazardArrivals(model, scenario, p) {
  const out = [];
  for (const [i, h] of (scenario.hazards ?? []).entries()) {
    const type = String(h.type).toLowerCase();
    if (!HAZARD_TYPES.includes(type)) fail(`Hazard ${i + 1}: type "${h.type}" is not one of ${HAZARD_TYPES.join(", ")}`);
    const severity = Math.round(num(h.severity ?? 3, `Hazard ${i + 1}: severity`, { min: 1, max: 5 }));
    const arrival = new Array(model.nodes.length).fill(Infinity);
    if (Array.isArray(h.arrivals)) {
      for (const row of h.arrivals) {
        const id = text(row.place, `Hazard ${i + 1}: place`);
        if (!model.index.has(id)) fail(`Hazard ${i + 1}: place "${id}" does not exist`);
        const t = num(row.arrival_s, `Hazard ${i + 1}: time for ${id}`, { min: 0, max: 86400 });
        const n = model.index.get(id);
        arrival[n] = Math.min(arrival[n], t);
      }
    } else {
      const originId = text(h.origin, `Hazard ${i + 1}: origin`);
      if (!model.index.has(originId)) fail(`Hazard ${i + 1}: place "${originId}" does not exist`);
      const rate = num(h.spreadRate ?? 0, `Hazard ${i + 1}: spread rate`, { min: 0, max: 100 });
      const start = num(h.startS ?? 0, `Hazard ${i + 1}: start time`, { min: 0, max: 86400 });
      // Stairs and lifts are assumed to be protected by fire doors, so a hazard
      // does not enter them (or move between floors) unless the scenario says so.
      const dist = shortestDistances(model, model.index.get(originId), Boolean(h.throughShafts));
      for (let n = 0; n < arrival.length; n++) {
        if (dist[n] === 0) arrival[n] = start;
        else if (rate > 0 && Number.isFinite(dist[n])) arrival[n] = start + dist[n] / rate;
      }
    }
    out.push({ i, name: String(h.name ?? `${type} ${i + 1}`).slice(0, 80), type, severity, blocking: blocks(type, severity, p), arrival, imported: Array.isArray(h.arrivals) });
  }
  return out;
}

// Plain path distances from one place (all paths, used for hazard spread).
export function shortestDistances(model, from, throughShafts = true) {
  const dist = new Array(model.nodes.length).fill(Infinity);
  dist[from] = 0;
  const heap = new MinHeap();
  heap.push(0, from);
  while (heap.size) {
    const [d, n] = heap.pop();
    if (d > dist[n]) continue;
    for (const ei of model.adj[n]) {
      const e = model.edges[ei];
      const m = other(e, n);
      if (!throughShafts && (e.kind !== "flat" || model.nodes[m].type === "stair" || model.nodes[m].type === "lift")) continue;
      const nd = d + e.length;
      if (nd < dist[m]) {
        dist[m] = nd;
        heap.push(nd, m);
      }
    }
  }
  return dist;
}

export class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, value) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(value);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < k.length && k[l] < k[s]) s = l;
        if (r < k.length && k[r] < k[s]) s = r;
        if (s === i) break;
        [k[s], k[i]] = [k[i], k[s]];
        [v[s], v[i]] = [v[i], v[s]];
        i = s;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const STEP_FREE = new Set(["wheelchair", "stretcher", "ventilator"]);

// Can someone with this mobility use this edge into node `to`?
export function edgeAllowed(model, edge, to, mobility, ctx) {
  if (edge.blocked) return false;
  const node = model.nodes[to];
  if (node.blocked || ctx.blocked.has(to)) return false;
  const stepFree = STEP_FREE.has(mobility);
  if (stepFree) {
    if (node.type === "stair" || edge.kind === "stair") return false;
    if (mobility === "wheelchair" && !edge.wheelchair) return false;
    if ((mobility === "stretcher" || mobility === "ventilator") && !edge.stretcher) return false;
  }
  if (edge.kind === "lift") {
    if (!stepFree && !ctx.liftsForWalkers) return false;
    if (ctx.fireOrSmoke) {
      const a = model.nodes[edge.u];
      const b = model.nodes[edge.v];
      if (!a.evacLift || !b.evacLift) return false;
    }
  }
  return true;
}

// Admissible A* scale: no edge is shorter than its straight line times this.
export function heuristicScale(model, floorHeight) {
  let scale = 1;
  for (const e of model.edges) {
    const d = straight(model.nodes[e.u], model.nodes[e.v], floorHeight);
    if (d > 0) scale = Math.min(scale, e.length / d);
  }
  return scale;
}

export function straight(a, b, floorHeight) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.floor - b.floor) * floorHeight);
}

// Finds a route from `from` to any target. Returns {nodes, edges, cost, length} or null.
// ctx: {blocked:Set, risk(n)->0..1, exitCost(n)->metres, liftsForWalkers, fireOrSmoke, stairCost}
export function findRoute(model, from, targets, mobility, algorithm, ctx) {
  const targetSet = targets instanceof Set ? targets : new Set(targets);
  if (targetSet.has(from)) return { nodes: [from], edges: [], cost: 0, length: 0 };
  const n = model.nodes.length;
  const prevEdge = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  let found = -1;

  if (algorithm === "bfs") {
    const queue = [from];
    seen[from] = 1;
    for (let qi = 0; qi < queue.length && found < 0; qi++) {
      const u = queue[qi];
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (seen[v] || !edgeAllowed(model, e, v, mobility, ctx)) continue;
        seen[v] = 1;
        prevEdge[v] = ei;
        if (targetSet.has(v)) {
          found = v;
          break;
        }
        queue.push(v);
      }
    }
  } else if (algorithm === "dfs") {
    const stack = [[from, 0]];
    seen[from] = 1;
    while (stack.length && found < 0) {
      const top = stack[stack.length - 1];
      const [u, k] = top;
      if (k >= model.adj[u].length) {
        stack.pop();
        continue;
      }
      top[1]++;
      const ei = model.adj[u][k];
      const e = model.edges[ei];
      const v = other(e, u);
      if (seen[v] || !edgeAllowed(model, e, v, mobility, ctx)) continue;
      seen[v] = 1;
      prevEdge[v] = ei;
      if (targetSet.has(v)) found = v;
      else stack.push([v, 0]);
    }
  } else if (algorithm === "dijkstra" || algorithm === "astar") {
    const g = new Float64Array(n).fill(Infinity);
    g[from] = 0;
    const h = new Float64Array(n);
    if (algorithm === "astar") {
      const tl = [...targetSet].map((t) => model.nodes[t]);
      for (let i = 0; i < n; i++) {
        let best = Infinity;
        for (const t of tl) best = Math.min(best, straight(model.nodes[i], t, ctx.floorHeight));
        h[i] = ctx.hScale * best;
      }
    }
    const heap = new MinHeap();
    heap.push(h[from], from);
    while (heap.size) {
      const [f, u] = heap.pop();
      if (seen[u]) continue;
      seen[u] = 1;
      if (targetSet.has(u)) {
        found = u;
        break;
      }
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (seen[v] || !edgeAllowed(model, e, v, mobility, ctx)) continue;
        let cost = e.length * (e.kind === "stair" ? ctx.stairCost : 1) + ctx.riskPenalty * ctx.risk(v);
        if (targetSet.has(v) && ctx.exitCost) cost += ctx.exitCost(v);
        const nd = g[u] + cost;
        if (nd < g[v]) {
          g[v] = nd;
          prevEdge[v] = ei;
          heap.push(nd + h[v], v);
        }
      }
    }
  } else {
    fail(`Unknown method "${algorithm}"`);
  }
  if (found < 0) return null;
  const nodes = [found];
  const edges = [];
  let length = 0;
  let cur = found;
  while (cur !== from) {
    const e = model.edges[prevEdge[cur]];
    edges.push(e.i);
    length += e.length;
    cur = other(e, cur);
    nodes.push(cur);
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges, length };
}

// ---------------------------------------------------------------------------
// Priority (rule-based, same weights as HEALTH-11)
// ---------------------------------------------------------------------------

export const MOBILITY_SCORE = { ambulatory: 0.25, wheelchair: 0.5, stretcher: 0.75, ventilator: 1 };
export const PRIORITY_WEIGHTS = { mobility: 0.4, criticality: 0.3, hazard: 0.3 };

export function priority(mobility, criticality, hazardRisk) {
  const parts = {
    mobility: PRIORITY_WEIGHTS.mobility * MOBILITY_SCORE[mobility],
    criticality: PRIORITY_WEIGHTS.criticality * ((criticality - 1) / 4),
    hazard: PRIORITY_WEIGHTS.hazard * clamp(hazardRisk, 0, 1),
  };
  return { score: parts.mobility + parts.criticality + parts.hazard, parts };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const DONE = new Set(["out", "reached", "stuck"]);

export function escortsNeeded(mobility, p) {
  if (mobility === "wheelchair") return Math.max(1, Math.round(p.escort_wheelchair));
  if (mobility === "stretcher" || mobility === "ventilator") return Math.max(1, Math.round(p.escort_bed));
  return 0;
}

// options: {algorithm, seed, balanceExits, alarm: "start"|"sensors", confirm: "auto"|"manual",
//           visitors: true, falseAlarms: [{t, sensor}], frameEvery}
export function createSimulation(model, scenario, params = {}, options = {}) {
  const p = { ...defaultParams(), ...params };
  const algorithm = options.algorithm ?? "dijkstra";
  if (!ALGORITHMS.includes(algorithm)) fail(`Unknown method "${algorithm}"`);
  const random = makeRandom(options.seed ?? 1);
  const alarmMode = options.alarm ?? scenario.alarm ?? "start";
  const confirmMode = options.confirm ?? "auto";
  const balance = Boolean(options.balanceExits);
  const frameEvery = options.frameEvery ?? 0;
  const hazards = hazardArrivals(model, scenario, p);
  const fireOrSmoke = hazards.some((h) => h.type === "fire" || h.type === "smoke");
  const exitSet = new Set(model.exits);
  const hScale = heuristicScale(model, p.floor_height);
  const nN = model.nodes.length;

  // Edge state
  const edgeState = model.edges.map((e) => {
    const k = e.kind === "stair" ? p.k_stair : p.k_level;
    return {
      load: 0, // space units on the edge
      tokens: 0,
      rate: maxSpecificFlow(k, p) * e.width, // people per second that can enter
      storage: Math.max(4, e.length * e.width * p.d_max),
      maxDensity: 0,
      maxQueue: 0,
      used: 0,
      waiting: 0,
    };
  });

  const biggest = Math.max(1, p.space_bed, p.space_wheelchair);
  const tokenCap = (es) => Math.max(es.rate, biggest);

  // Exit capacity: widest path into each exit
  const exitRate = new Map();
  for (const x of model.exits) {
    let r = 0;
    for (const ei of model.adj[x]) r = Math.max(r, edgeState[ei].rate);
    exitRate.set(x, r || 1);
  }
  const exitLoad = new Map(model.exits.map((x) => [x, 0]));
  const exitCount = new Map(model.exits.map((x) => [x, 0]));

  // Lift shafts: connected groups of lift places joined by lift paths.
  const shaftOf = new Int32Array(nN).fill(-1);
  const shafts = [];
  for (const n of model.nodes) {
    if (n.type !== "lift" || shaftOf[n.i] >= 0) continue;
    const id = shafts.length;
    const members = [];
    const stack = [n.i];
    shaftOf[n.i] = id;
    while (stack.length) {
      const u = stack.pop();
      members.push(u);
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        if (e.kind !== "lift") continue;
        const v = other(e, u);
        if (shaftOf[v] < 0) {
          shaftOf[v] = id;
          stack.push(v);
        }
      }
    }
    const ground = members.reduce((a, b) => (model.nodes[a].floor <= model.nodes[b].floor ? a : b));
    shafts.push({ id, members, carFloor: model.nodes[ground].floor, freeAt: 0, queue: [], trips: 0 });
  }

  // People
  const agents = [];
  const add = (a) => {
    a.id = agents.length;
    agents.push(a);
    return a;
  };
  for (const person of model.people) {
    const a = add({
      kind: person.kind,
      code: person.code,
      role: person.role,
      mobility: person.mobility,
      criticality: person.criticality,
      home: person.home,
      node: person.home,
      state: "waiting",
      route: null,
      ri: 0,
      edge: -1,
      pos: 0,
      waitSince: 0,
      startAt: Infinity,
      exposure: 0,
      outAt: null,
      exit: null,
      helpers: [],
      helping: -1,
      needs: 0,
      helpStartedAt: null,
      helpArrivedAt: null,
      trips: 0,
      space: 1,
      speed: 0,
      lift: null,
      reroute: false,
      seenBlocked: new Set(),
    });
    if (a.kind === "staff") {
      a.free = clamp(normal(random, p.speed_staff, p.speed_staff_sd), 0.65, 2.05);
      a.premove = logNormal(random, p.staff_premove_mean, p.staff_premove_sd);
    } else if (a.mobility === "ambulatory") {
      a.free = p.speed_patient_min + random() * (p.speed_patient_max - p.speed_patient_min);
      a.premove = clamp(normal(random, p.prep_ambulatory_mean, p.prep_ambulatory_sd), 30, 90);
    } else if (a.mobility === "wheelchair") {
      a.free = Math.max(0.1, normal(random, p.speed_wheelchair, p.speed_transport_sd));
      a.prep = clamp(normal(random, p.prep_wheelchair_mean, p.prep_wheelchair_sd), 100, 120);
      a.needs = escortsNeeded("wheelchair", p);
      a.space = p.space_wheelchair;
    } else {
      a.free = Math.max(0.1, normal(random, p.speed_bed, p.speed_transport_sd));
      a.prep = clamp(normal(random, p.prep_bed_mean, p.prep_bed_sd), 180, 900) + (a.mobility === "ventilator" ? p.prep_ventilator_extra : 0);
      a.needs = escortsNeeded(a.mobility, p);
      a.space = p.space_bed;
    }
  }
  const visitorsFrom = [];
  if (options.visitors !== false) {
    for (const cam of model.cameras) {
      const count = options.cameraCounts?.[cam.id] ?? cam.count;
      for (let k = 0; k < count; k++) {
        const a = add({
          kind: "visitor",
          code: `${cam.id}-V${k + 1}`,
          mobility: "ambulatory",
          criticality: 1,
          home: cam.node,
          node: cam.node,
          state: "waiting",
          route: null,
          ri: 0,
          edge: -1,
          pos: 0,
          waitSince: 0,
          startAt: Infinity,
          exposure: 0,
          outAt: null,
          exit: null,
          helpers: [],
          helping: -1,
          needs: 0,
          trips: 0,
          space: 1,
          lift: null,
          reroute: false,
          seenBlocked: new Set(),
          free: p.speed_visitor,
          premove: Math.max(0, normal(random, p.visitor_premove_mean, p.visitor_premove_sd)),
        });
        visitorsFrom.push(a.id);
      }
    }
  }

  // Sensors and alerts
  const alerts = [];
  const sensorFired = new Set();
  const falseAlarms = [...(options.falseAlarms ?? [])].sort((a, b) => a.t - b.t);
  // With the alarm at the start (drill, or an emergency already reported) the
  // commander knows the hazards; otherwise they learn them from confirmed alerts.
  const knownHazard = new Set(alarmMode === "start" ? hazards.map((h) => h.i) : []);
  const knownPlaces = new Set(); // places observed blocked by someone
  const sim = {
    model, p, algorithm, hazards, agents, alerts, shafts, edgeState, exitCount, scenario,
    t: 0, alarmAt: alarmMode === "start" ? 0 : null, alarmReason: alarmMode === "start" ? "Alarm at start (drill or confirmed emergency)" : null,
    events: [], frames: [], curve: [[0, 0]], done: false, knowledgeVersion: 0,
  };
  const log = (message) => sim.events.push({ t: sim.t, message });

  const raiseAlarm = (reason) => {
    if (sim.alarmAt !== null) return;
    sim.alarmAt = sim.t;
    sim.alarmReason = reason;
    log(`Alarm: ${reason}`);
    for (const a of agents) a.startAt = sim.t + (a.premove ?? 0);
  };
  if (sim.alarmAt === 0) for (const a of agents) a.startAt = a.premove ?? 0;

  const arrived = (h, n) => h.arrival[n] <= sim.t;
  const blockedNow = (n) => hazards.some((h) => h.blocking && arrived(h, n));

  // What routing knows: confirmed hazards plus places people have seen blocked.
  const knownBlocked = () => {
    const s = new Set(knownPlaces);
    for (const h of hazards) {
      if (!knownHazard.has(h.i) || !h.blocking) continue;
      for (let n = 0; n < nN; n++) if (arrived(h, n)) s.add(n);
    }
    return s;
  };
  const riskOf = (n) => {
    let r = 0;
    for (const h of hazards) {
      if (!knownHazard.has(h.i)) continue;
      const dt = h.arrival[n] - sim.t;
      if (!Number.isFinite(dt)) continue;
      r = Math.max(r, dt <= 0 ? 1 : clamp(1 - dt / p.risk_horizon_s, 0, 1));
    }
    return r;
  };
  let cachedBlocked = null;
  let cachedAt = -1;
  let cachedVersion = -1;
  const ctxFor = (agent, useExitCost) => {
    if (cachedAt !== sim.t || cachedVersion !== sim.knowledgeVersion) {
      cachedBlocked = knownBlocked();
      cachedAt = sim.t;
      cachedVersion = sim.knowledgeVersion;
    }
    const blocked = new Set(cachedBlocked);
    for (const n of agent.seenBlocked) blocked.add(n);
    blocked.delete(agent.node);
    return {
      blocked,
      risk: riskOf,
      riskPenalty: p.risk_penalty_m,
      stairCost: p.k_level / p.k_stair,
      liftsForWalkers: p.lifts_for_walkers >= 1,
      fireOrSmoke: fireOrSmoke && hazards.some((h) => (h.type === "fire" || h.type === "smoke") && (knownHazard.has(h.i) || sim.alarmAt !== null)),
      floorHeight: p.floor_height,
      hScale,
      exitCost: useExitCost && balance ? (x) => ((exitLoad.get(x) ?? 0) / exitRate.get(x)) * p.speed_visitor : null,
    };
  };

  const learn = () => {
    sim.knowledgeVersion++;
    for (const a of agents) if (a.state === "moving" || a.state === "toPatient" || a.state === "stuck_wait") a.reroute = true;
  };

  const confirmAlert = (id) => {
    const al = alerts.find((x) => x.id === id);
    if (!al || al.status !== "new") return false;
    al.status = "confirmed";
    al.decidedAt = sim.t;
    log(`Commander confirmed ${al.kind} alert at ${model.nodes[al.node].id}`);
    for (const hi of al.hazards) knownHazard.add(hi);
    if (al.hazards.length) learn();
    raiseAlarm(`${al.kind} alert at ${model.nodes[al.node].id} confirmed`);
    return true;
  };
  const dismissAlert = (id) => {
    const al = alerts.find((x) => x.id === id);
    if (!al || al.status !== "new") return false;
    al.status = "dismissed";
    al.decidedAt = sim.t;
    log(`Commander dismissed ${al.kind} alert at ${model.nodes[al.node].id}`);
    return true;
  };
  const newAlert = (sensor, hazardIdx, falseAlarm) => {
    const al = { id: alerts.length + 1, t: sim.t, sensor: sensor.id, kind: sensor.kind, node: sensor.node, hazards: hazardIdx, falseAlarm, status: "new", decidedAt: null };
    alerts.push(al);
    log(`${sensor.kind} sensor ${sensor.id} at ${model.nodes[sensor.node].id} raised an alert`);
    if (alarmMode === "start") {
      // Alarm already sounding: the commander still learns where the hazard is.
      if (confirmMode === "auto") al.autoAt = sim.t + p.confirm_delay_s;
    } else if (confirmMode === "auto") al.autoAt = sim.t + p.confirm_delay_s;
    return al;
  };

  const releaseEdge = (a) => {
    if (a.edge >= 0) {
      edgeState[a.edge].load -= a.space;
      a.edge = -1;
    }
  };

  const planRoute = (a, targets, mobility, useExitCost) => {
    const r = findRoute(model, a.node, targets, mobility, algorithm, ctxFor(a, useExitCost));
    if (!r) return false;
    if (a.exit !== null && useExitCost) exitLoad.set(a.exit, (exitLoad.get(a.exit) ?? 0) - a.space);
    a.route = r;
    a.ri = 0;
    if (useExitCost) {
      a.exit = r.nodes[r.nodes.length - 1];
      exitLoad.set(a.exit, (exitLoad.get(a.exit) ?? 0) + a.space);
    }
    return true;
  };

  const groupMobility = (a) => a.mobility;
  const startEvacuating = (a) => {
    if (planRoute(a, exitSet, groupMobility(a), true)) {
      a.state = "moving";
      a.waitSince = sim.t;
      return true;
    }
    a.state = "stuck_wait";
    a.retryAt = sim.t + 15;
    return false;
  };

  const finish = (a, exitNode) => {
    a.state = "out";
    a.outAt = sim.t;
    a.exit = exitNode;
    exitLoad.set(exitNode, (exitLoad.get(exitNode) ?? 0) - a.space);
    exitCount.set(exitNode, (exitCount.get(exitNode) ?? 0) + 1);
    for (const s of a.helpers) {
      // Staff are counted out only when they finally leave (they may go back in).
      const st = agents[s];
      st.node = exitNode;
      st.helping = -1;
      st.trips++;
      st.state = "free";
      st.exit = null;
      st.waitSince = sim.t;
    }
  };

  const markReached = (a, where) => {
    if (DONE.has(a.state)) return;
    releaseEdge(a);
    a.state = "reached";
    a.reachedAt = sim.t;
    a.node = where;
    for (const s of a.helpers) {
      const st = agents[s];
      st.state = "reached";
      st.reachedAt = sim.t;
      st.node = where;
    }
  };

  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] > b[i] + 1e-9) return true;
      if (a[i] < b[i] - 1e-9) return false;
    }
    return false;
  };

  // Staff choose the next patient who needs help.
  const chooseTask = (s) => {
    const waiting = agents.filter((x) => x.kind === "patient" && x.needs > 0 && (x.state === "needsHelp" || x.state === "waiting") && x.helpers.length + (x.coming?.length ?? 0) < x.needs);
    if (!waiting.length) return false;
    const ctx = ctxFor(s, false);
    // distances from the staff member (walking rules)
    const dist = new Float64Array(nN).fill(Infinity);
    dist[s.node] = 0;
    const heap = new MinHeap();
    heap.push(0, s.node);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (!edgeAllowed(model, e, v, "ambulatory", ctx)) continue;
        const nd = d + e.length;
        if (nd < dist[v]) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    }
    let best = null;
    for (const x of waiting) {
      if (!Number.isFinite(dist[x.node])) continue;
      const pr = priority(x.mobility, x.criticality, riskOf(x.node)).score;
      // Staff help patients on their own floor first (zone duty), then finish a
      // partly staffed patient, then the highest priority, then the nearest.
      const sameFloor = model.nodes[x.node].floor === model.nodes[s.home].floor ? 1 : 0;
      const partly = (x.coming?.length ?? 0) + x.helpers.length > 0 ? 1 : 0;
      const key = [sameFloor, partly, pr, -dist[x.node]];
      if (!best || better(key, best.key)) best = { x, key };
    }
    if (!best) return false;
    const target = best.x;
    if (!planRoute(s, new Set([target.node]), "ambulatory", false)) return false;
    target.coming = target.coming ?? [];
    target.coming.push(s.id);
    if (target.helpStartedAt === null) target.helpStartedAt = sim.t;
    s.helping = target.id;
    s.state = "toPatient";
    s.waitSince = sim.t;
    return true;
  };

  const staffArrives = (s) => {
    const x = agents[s.helping];
    if (!x || DONE.has(x.state)) {
      s.helping = -1;
      s.state = "free";
      return;
    }
    x.coming = x.coming.filter((id) => id !== s.id);
    x.helpers.push(s.id);
    s.state = "escorting";
    if (x.helpers.length >= x.needs) {
      x.state = "prep";
      x.helpArrivedAt = sim.t;
      x.prepEnds = sim.t + x.prep;
    }
  };

  // Moves one agent that has a route: along an edge or into the next one.
  const advance = (a, dt) => {
    let budget = dt;
    let guard = 0;
    while (budget > 1e-9 && guard++ < 50) {
      if (a.edge >= 0) {
        const e = model.edges[a.edge];
        const es = edgeState[a.edge];
        const density = es.load / (e.length * e.width);
        let v = a.free * speedFraction(density, p);
        if (e.kind === "stair") v *= p.k_stair / p.k_level;
        const left = e.length - a.pos;
        if (v * budget < left) {
          a.pos += v * budget;
          return;
        }
        budget -= left / v;
        releaseEdge(a);
        a.node = a.route.nodes[a.ri + 1];
        a.ri++;
        a.pos = 0;
        a.waitSince = sim.t;
        if (blockedNow(a.node)) {
          markReached(a, a.node);
          return;
        }
        if (a.ri >= a.route.nodes.length - 1) return; // arrived at the route end
        if (a.reroute) return;
      } else {
        if (a.ri >= a.route.nodes.length - 1) return;
        const ei = a.route.edges[a.ri];
        const e = model.edges[ei];
        const next = a.route.nodes[a.ri + 1];
        if (blockedNow(next) && !a.seenBlocked.has(next)) {
          // Someone sees the hazard ahead: they learn it and look for another way.
          a.seenBlocked.add(next);
          knownPlaces.add(next);
          if (alarmMode !== "start" && sim.alarmAt === null) {
            sim.pendingDiscovery = sim.pendingDiscovery ?? sim.t + p.discovery_delay_s;
          }
          learn();
          return;
        }
        if (e.kind === "lift") {
          // Ride to the last lift stop in this route.
          let j = a.ri + 1;
          while (j < a.route.edges.length && model.edges[a.route.edges[j]].kind === "lift") j++;
          const shaft = shafts[shaftOf[a.node]];
          a.state = "lift";
          a.lift = { shaft: shaft.id, from: a.node, to: a.route.nodes[j], toIndex: j, since: sim.t };
          shaft.queue.push(a.id);
          return;
        }
        const es = edgeState[ei];
        if (es.tokens + 1e-9 < a.space || es.load + a.space > es.storage + 1e-9) {
          es.waiting++;
          return;
        }
        es.tokens -= a.space;
        es.load += a.space;
        es.used++;
        a.edge = ei;
        a.pos = 0;
        // re-check direction: route edges run from route.nodes[ri] to [ri+1]
      }
    }
  };

  const serveLifts = () => {
    for (const sh of shafts) {
      if (sim.t < sh.freeAt) continue;
      sh.queue = sh.queue.filter((id) => agents[id].state === "lift" && !agents[id].lift.riding);
      if (!sh.queue.length) continue;
      const first = agents[sh.queue[0]];
      const fromFloor = model.nodes[first.lift.from].floor;
      const toFloor = model.nodes[first.lift.to].floor;
      let load = 0;
      const riders = [];
      for (const id of sh.queue) {
        const a = agents[id];
        if (a.lift.from !== first.lift.from || a.lift.to !== first.lift.to) continue;
        if (riders.length && load + a.space > p.lift_capacity) break;
        riders.push(a);
        load += a.space;
      }
      const reach = (Math.abs(sh.carFloor - fromFloor) * p.floor_height) / p.lift_speed;
      const ride = (Math.abs(fromFloor - toFloor) * p.floor_height) / p.lift_speed;
      const arriveAt = sim.t + reach + p.lift_door_s + ride;
      for (const a of riders) {
        a.lift.riding = true;
        a.lift.departAt = sim.t + reach + p.lift_door_s / 2;
        a.lift.arriveAt = arriveAt;
      }
      sh.carFloor = toFloor;
      sh.freeAt = arriveAt;
      sh.trips++;
    }
  };

  const recordFrame = () => {
    sim.frames.push({ t: sim.t, people: snapshotPeople() });
  };

  const snapshotPeople = () =>
    agents
      .filter((a) => !(a.state === "escorting"))
      .map((a) => {
        const s = { id: a.id, kind: a.kind, mobility: a.mobility, state: a.state, node: a.node, helpers: a.helpers.length };
        if (a.edge >= 0) {
          const e = model.edges[a.edge];
          const forward = e.u === a.node;
          s.edge = a.edge;
          s.frac = forward ? a.pos / e.length : 1 - a.pos / e.length;
        }
        if (a.state === "lift" && a.lift?.riding) {
          s.lift = { from: a.lift.from, to: a.lift.to, frac: clamp((sim.t - a.lift.departAt) / Math.max(1, a.lift.arriveAt - a.lift.departAt), 0, 1) };
        }
        return s;
      });

  sim.confirm = confirmAlert;
  sim.dismiss = dismissAlert;
  sim.snapshot = () => ({ t: sim.t, people: snapshotPeople(), hazards: hazardState(), alerts: alerts.map((x) => ({ ...x })), alarmAt: sim.alarmAt });

  const hazardState = () =>
    hazards.map((h) => ({ i: h.i, type: h.type, severity: h.severity, known: knownHazard.has(h.i), places: h.arrival.map((a, n) => (a <= sim.t ? n : -1)).filter((n) => n >= 0) }));
  sim.hazardState = hazardState;

  // One tick of dt seconds.
  sim.step = (dt = 1) => {
    if (sim.done) return sim;
    sim.t += dt;
    const t = sim.t;

    // 1. Sensors
    for (const s of model.sensors) {
      if (sensorFired.has(s.id)) continue;
      const seen = hazards.filter((h) => SENSOR_SEES[s.kind].includes(h.type) && h.arrival[s.node] + p.sensor_delay_s <= t);
      if (seen.length) {
        sensorFired.add(s.id);
        newAlert(s, seen.map((h) => h.i), false);
      }
    }
    while (falseAlarms.length && falseAlarms[0].t <= t) {
      const fa = falseAlarms.shift();
      const s = model.sensors.find((x) => x.id === fa.sensor);
      if (s) newAlert(s, [], true);
    }
    for (const al of alerts) if (al.status === "new" && al.autoAt !== undefined && t >= al.autoAt) confirmAlert(al.id);
    if (sim.pendingDiscovery !== undefined && sim.alarmAt === null && t >= sim.pendingDiscovery) {
      raiseAlarm("people found the hazard and raised the alarm");
    }

    // 2. Hazard reaches people who are not moving
    for (const a of agents) {
      if (DONE.has(a.state) || a.state === "escorting" || a.edge >= 0) continue;
      if (a.state === "lift" && a.lift?.riding) continue;
      if (blockedNow(a.node)) {
        markReached(a, a.node);
        if (alarmMode !== "start" && sim.alarmAt === null && sim.pendingDiscovery === undefined) {
          sim.pendingDiscovery = t + p.discovery_delay_s;
        }
      }
    }

    // 3. Tokens for entering paths
    for (const es of edgeState) {
      es.tokens = Math.min(es.tokens + es.rate * dt, tokenCap(es));
      es.waiting = 0;
    }

    // 4. Lifts
    serveLifts();
    for (const a of agents) {
      if (a.state !== "lift" || !a.lift?.riding || t < a.lift.arriveAt) continue;
      a.node = a.lift.to;
      a.ri = a.lift.toIndex;
      a.lift = null;
      a.state = a.kind === "staff" && a.helping >= 0 && !a.escortingGroup ? "toPatient" : "moving";
      if (exitSet.has(a.node) && a.state === "moving") finish(a, a.node);
    }

    // 5. Decisions and movement (people waiting longest go first)
    const order = agents.filter((a) => !DONE.has(a.state) && a.state !== "escorting").sort((x, y) => x.waitSince - y.waitSince || x.id - y.id);
    for (const a of order) {
      if (DONE.has(a.state)) continue;
      if (sim.alarmAt === null) continue;
      if (a.state === "waiting") {
        if (t < a.startAt) continue;
        if (a.kind === "staff") {
          a.state = "free";
        } else if (a.needs > 0) {
          a.state = "needsHelp";
          a.waitSince = t;
          continue;
        } else {
          startEvacuating(a);
          continue;
        }
      }
      if (a.state === "needsHelp") continue;
      if (a.state === "prep") {
        if (t >= a.prepEnds) {
          if (startEvacuating(a)) log(`${a.code} (${a.mobility}) leaves with ${a.helpers.length} staff`);
        }
        continue;
      }
      if (a.state === "stuck_wait") {
        if (t >= a.retryAt || a.reroute) {
          a.reroute = false;
          if (a.kind === "staff" && a.helping >= 0) {
            if (!planRoute(a, new Set([agents[a.helping].node]), "ambulatory", false)) a.retryAt = t + 15;
            else a.state = "toPatient";
          } else if (startEvacuating(a)) {
            /* moving again */
          }
        }
        continue;
      }
      if (a.state === "free") {
        if (chooseTask(a)) {
          /* now toPatient */
        } else if (exitSet.has(a.node)) {
          a.state = "out";
          a.outAt = t;
          exitCount.set(a.node, (exitCount.get(a.node) ?? 0) + 1);
          continue;
        } else {
          startEvacuating(a);
          continue;
        }
      }
      if (a.state === "toPatient" || a.state === "moving") {
        if (a.reroute && a.edge < 0) {
          a.reroute = false;
          const ok = a.state === "toPatient" ? planRoute(a, new Set([agents[a.helping].node]), "ambulatory", false) : planRoute(a, exitSet, a.mobility, true);
          if (!ok) {
            if (a.state === "toPatient") {
              const x = agents[a.helping];
              x.coming = x.coming.filter((id) => id !== a.id);
              a.helping = -1;
              a.state = "free";
              if (!startEvacuating(a)) continue;
            } else {
              a.state = "stuck_wait";
              a.retryAt = t + 15;
              continue;
            }
          }
        }
        advance(a, dt);
        if (DONE.has(a.state)) continue;
        if (a.edge < 0 && a.route && a.ri >= a.route.nodes.length - 1) {
          if (a.state === "toPatient") staffArrives(a);
          else if (exitSet.has(a.node)) finish(a, a.node);
        }
      }
    }

    // 6. Exposure to smoke that does not block
    for (const a of agents) {
      if (DONE.has(a.state) || a.state === "escorting") continue;
      if (hazards.some((h) => h.type === "smoke" && !h.blocking && arrived(h, a.node))) a.exposure += dt;
    }

    // 7. Measurements
    for (const [i, es] of edgeState.entries()) {
      const e = model.edges[i];
      es.maxDensity = Math.max(es.maxDensity, es.load / (e.length * e.width));
      es.maxQueue = Math.max(es.maxQueue, es.waiting);
    }
    const out = agents.filter((a) => a.state === "out").length;
    if (t % 10 === 0) sim.curve.push([t, out]);
    if (frameEvery && t % frameEvery === 0) recordFrame();

    // 8. Finished?
    const active = agents.some((a) => !DONE.has(a.state) && !(a.state === "needsHelp" && noHelpLeft()));
    const waitingForAlarm = sim.alarmAt === null && (hazards.some((h) => h.arrival.some((x) => x > t && Number.isFinite(x))) || alerts.some((x) => x.status === "new") || falseAlarms.length || sim.pendingDiscovery !== undefined);
    if ((!active && !(sim.alarmAt === null && waitingForAlarm && t < p.time_limit_s)) || t >= p.time_limit_s) {
      sim.done = true;
      if (sim.curve[sim.curve.length - 1][0] !== t) sim.curve.push([t, out]);
    } else if (sim.alarmAt === null && !waitingForAlarm) {
      sim.done = true;
    }
    return sim;
  };

  const noHelpLeft = () => !agents.some((s) => s.kind === "staff" && !DONE.has(s.state));

  sim.run = () => {
    if (frameEvery) recordFrame();
    while (!sim.done) sim.step(1);
    return summarize(sim);
  };
  sim.summary = () => summarize(sim);
  return sim;
}

export function summarize(sim) {
  const { agents, model, edgeState, p } = sim;
  const count = (f) => agents.filter(f).length;
  const total = agents.length;
  const out = count((a) => a.state === "out");
  const reached = count((a) => a.state === "reached");
  const helpLeft = count((a) => a.state === "needsHelp" || a.state === "prep");
  const stuck = total - out - reached;
  const outTimes = agents.filter((a) => a.state === "out").map((a) => a.outAt).sort((x, y) => x - y);
  const pct = (q) => {
    const idx = Math.max(0, Math.ceil(q * total) - 1);
    return idx < outTimes.length ? outTimes[idx] : null;
  };
  const byKind = {};
  for (const kind of ["patient", "staff", "visitor"]) {
    const g = agents.filter((a) => a.kind === kind);
    byKind[kind] = { total: g.length, out: g.filter((a) => a.state === "out").length, reached: g.filter((a) => a.state === "reached").length };
  }
  const helped = agents.filter((a) => a.needs > 0);
  const waits = helped.filter((a) => a.helpArrivedAt !== null && sim.alarmAt !== null).map((a) => a.helpArrivedAt - (a.startAt ?? sim.alarmAt));
  const busy = edgeState
    .map((es, i) => ({ i, path: `${model.nodes[model.edges[i].u].id} - ${model.nodes[model.edges[i].v].id}`, kind: model.edges[i].kind, maxDensity: round(es.maxDensity, 2), maxQueue: es.maxQueue, used: es.used }))
    .filter((x) => x.used > 0)
    .sort((a, b) => b.maxDensity - a.maxDensity || b.maxQueue - a.maxQueue)
    .slice(0, 8);
  const exits = model.exits.map((x) => ({ exit: model.nodes[x].id, people: sim.exitCount.get(x) ?? 0 }));
  return {
    algorithm: sim.algorithm,
    t: sim.t,
    total,
    out,
    reached,
    stuck,
    leftWaitingForHelp: helpLeft,
    allOut: out === total,
    alarmAt: sim.alarmAt,
    alarmReason: sim.alarmReason,
    evacuationTime: out === total ? outTimes[outTimes.length - 1] : null,
    lastOut: outTimes.length ? outTimes[outTimes.length - 1] : null,
    t50: pct(0.5),
    t90: pct(0.9),
    byKind,
    exits,
    busiest: busy,
    meanHelpWait: waits.length ? round(waits.reduce((s, x) => s + x, 0) / waits.length, 1) : null,
    maxHelpWait: waits.length ? round(Math.max(...waits), 1) : null,
    staffTrips: agents.filter((a) => a.kind === "staff").reduce((s, a) => s + a.trips, 0),
    smokeExposure: round(agents.reduce((s, a) => s + a.exposure, 0), 0),
    liftTrips: sim.shafts.reduce((s, x) => s + x.trips, 0),
    alerts: sim.alerts.map((x) => ({ id: x.id, t: x.t, sensor: x.sensor, kind: x.kind, place: model.nodes[x.node].id, status: x.status, falseAlarm: x.falseAlarm, decidedAt: x.decidedAt })),
    curve: sim.curve,
    events: sim.events,
    params: p,
  };
}

export function round(v, d = 0) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function simulate(model, scenario, params, options) {
  return createSimulation(model, scenario, params, options).run();
}

// Several runs with different random seeds (people's speeds and delays vary).
export function simulateMany(model, scenario, params, options, seeds) {
  const results = seeds.map((seed) => simulate(model, scenario, params, { ...options, seed }));
  const times = results.map((r) => r.lastOut).filter((x) => x !== null);
  const outs = results.map((r) => r.out);
  return {
    results,
    runs: results.length,
    allOutRuns: results.filter((r) => r.allOut).length,
    meanTime: times.length ? round(times.reduce((s, x) => s + x, 0) / times.length, 1) : null,
    minTime: times.length ? Math.min(...times) : null,
    maxTime: times.length ? Math.max(...times) : null,
    meanOut: round(outs.reduce((s, x) => s + x, 0) / outs.length, 1),
    total: results[0]?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Drill comparison (validation)
// ---------------------------------------------------------------------------

// rows: [{code, kind, exit, exit_time_s}] observed in a drill.
export function drillSummary(rows) {
  const times = rows.map((r) => r.exit_time_s).sort((a, b) => a - b);
  const exits = {};
  for (const r of rows) exits[r.exit] = (exits[r.exit] ?? 0) + 1;
  return { people: rows.length, total: times.length ? times[times.length - 1] : null, times, exits };
}

// Cumulative count of people out at each time on a grid.
export function cumulative(times, grid) {
  const sorted = [...times].sort((a, b) => a - b);
  let j = 0;
  return grid.map((t) => {
    while (j < sorted.length && sorted[j] <= t) j++;
    return j;
  });
}

export function curveFromResult(result, grid) {
  // result.curve is [[t, out]] every 10 s; step function
  return grid.map((t) => {
    let v = 0;
    for (const [ct, c] of result.curve) {
      if (ct <= t) v = c;
      else break;
    }
    return v;
  });
}

export function compareWithDrill(drillRows, many, step = 10) {
  const drill = drillSummary(drillRows);
  const end = Math.max(drill.total ?? 0, many.maxTime ?? 0, ...many.results.map((r) => r.t));
  const grid = [];
  for (let t = 0; t <= end + step; t += step) grid.push(t);
  const observed = cumulative(drill.times, grid);
  const sims = many.results.map((r) => curveFromResult(r, grid));
  const mean = grid.map((_, i) => sims.reduce((s, c) => s + c[i], 0) / sims.length);
  const low = grid.map((_, i) => Math.min(...sims.map((c) => c[i])));
  const high = grid.map((_, i) => Math.max(...sims.map((c) => c[i])));
  let se = 0;
  let maxGap = 0;
  for (let i = 0; i < grid.length; i++) {
    const d = mean[i] - observed[i];
    se += d * d;
    maxGap = Math.max(maxGap, Math.abs(d));
  }
  const rmse = Math.sqrt(se / grid.length);
  const inside = grid.filter((_, i) => observed[i] >= low[i] && observed[i] <= high[i]).length / grid.length;
  const timeError = drill.total !== null && many.meanTime !== null ? round(many.meanTime - drill.total, 1) : null;
  const relError = timeError !== null && drill.total > 0 ? round((100 * timeError) / drill.total, 1) : null;
  const simExits = {};
  for (const r of many.results) for (const x of r.exits) simExits[x.exit] = (simExits[x.exit] ?? 0) + x.people / many.results.length;
  const exitNames = [...new Set([...Object.keys(drill.exits), ...Object.keys(simExits)])].sort();
  const exits = exitNames.map((name) => ({ exit: name, observed: drill.exits[name] ?? 0, simulated: round(simExits[name] ?? 0, 1) }));
  return {
    grid, observed, mean: mean.map((v) => round(v, 1)), low, high,
    observedTotal: drill.total, observedPeople: drill.people,
    simulatedMean: many.meanTime, simulatedMin: many.minTime, simulatedMax: many.maxTime,
    timeError, relError, rmse: round(rmse, 2), maxGap: round(maxGap, 1), inside: round(inside * 100, 0), exits,
  };
}
