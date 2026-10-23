// HEALTH-11 prototype: page logic.
import * as E from "./engine.js";
import * as IO from "./io.js";
import { edgePolyline, placePeople } from "./layout.js";
import { createPlan2D } from "./plan2d.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mmss = (t) => {
  if (t === null || t === undefined || !Number.isFinite(t)) return "–";
  const s = Math.round(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const pause = () => new Promise((r) => setTimeout(r, 0));
const MOBILITY_WORD = { ambulatory: "walks", wheelchair: "wheelchair", stretcher: "stretcher", ventilator: "ventilator" };
const ALG_WORD = { dijkstra: "Dijkstra", astar: "A*", bfs: "BFS", dfs: "DFS" };

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  data: null,
  model: null,
  scenarios: [],
  params: E.defaultParams(),
  cameraCounts: {},
  falseAlarms: [],
  drillRows: null,
  drillMadeUp: true,
  lines: [],
  view: "3d",
  floor: null,
  labels: true,
};

function store(key, value) {
  try {
    localStorage.setItem(`h11proto:${key}`, JSON.stringify(value));
  } catch {
    /* storage can be unavailable; the page works without it */
  }
}
function recall(key, fallback) {
  try {
    const v = localStorage.getItem(`h11proto:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const PAGES = ["live", "devices", "compare", "drill", "building", "parameters", "gaps"];
function showPage(name) {
  const page = PAGES.includes(name) ? name : "live";
  for (const p of PAGES) $(`page-${p}`).hidden = p !== page;
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (page === "devices") renderDevices();
  if (page === "building") renderBuilding();
  if (page === "parameters") renderParameters();
  if (page === "live") requestAnimationFrame(() => views.plan?.update({}));
}
window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));

// ---------------------------------------------------------------------------
// Loading a building
// ---------------------------------------------------------------------------

function useBuilding(data, { keepScenarios = false } = {}) {
  const model = E.buildModel(data);
  S.data = data;
  S.model = model;
  S.lines = model.edges.map((e) => edgePolyline(model, e));
  const fromFile = Array.isArray(data.scenarios) ? data.scenarios : [];
  const imported = keepScenarios ? S.scenarios.filter((s) => s.imported) : [];
  S.scenarios = [...fromFile.map((s) => ({ ...s })), ...imported];
  if (!S.scenarios.some((s) => s.alarm === "start" && !(s.hazards ?? []).length)) {
    S.scenarios.push({ name: "Evacuation drill (no hazard)", alarm: "start", note: "Alarm sounds at the start; everyone leaves.", hazards: [] });
  }
  S.cameraCounts = Object.fromEntries(model.cameras.map((c) => [c.id, c.count]));
  S.falseAlarms = [];
  fillScenarioSelects();
  fillFloorSelect();
  $("building-line").textContent = `${model.name}: ${model.floors.length} floor${model.floors.length === 1 ? "" : "s"}, ${model.nodes.length} places, ${model.people.filter((p) => p.kind === "patient").length} patients, ${model.people.filter((p) => p.kind === "staff").length} staff, ${model.sensors.length} sensors, ${model.cameras.length} cameras.`;
  $("synthetic-tag").hidden = !model.synthetic;
  const staffTotal = model.people.filter((p) => p.kind === "staff").length;
  $("cmp-staff").max = String(staffTotal);
  $("cmp-staff").value = String(staffTotal);
  $("cmp-staff-hint").textContent = `of ${staffTotal} in the file`;
  buildViews();
  newRun();
  renderDevices();
  renderBuilding();
  $("cmp-out").innerHTML = `<div class="card"><p class="hint">Choose a scenario and run the comparison.</p></div>`;
  $("drill-out").innerHTML = "";
}

function fillScenarioSelects() {
  const opts = S.scenarios.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
  for (const id of ["sc", "cmp-sc", "drill-sc"]) $(id).innerHTML = opts;
  const drillIndex = S.scenarios.findIndex((s) => s.alarm === "start" && !(s.hazards ?? []).length);
  $("drill-sc").value = String(Math.max(0, drillIndex));
  syncScenarioNote();
}

function syncScenarioNote() {
  const sc = S.scenarios[Number($("sc").value)] ?? S.scenarios[0];
  if (!sc) return;
  $("sc-note").textContent = sc.note ?? "";
  $("alarm").value = sc.alarm === "start" ? "start" : "sensors";
}

function fillFloorSelect() {
  const f = S.model.floors;
  $("floor").innerHTML = `<option value="all">All floors</option>` + f.map((n) => `<option value="${n}">${n === 0 ? "Ground floor" : `Up to floor ${n}`}</option>`).join("");
  S.floor = null;
}

// ---------------------------------------------------------------------------
// Views (3D and 2D)
// ---------------------------------------------------------------------------

const views = { three: null, plan: null, threeError: null };

async function buildViews() {
  views.three?.dispose();
  views.plan?.dispose();
  views.three = null;
  views.plan = createPlan2D($("view2d"), S.model);
  try {
    const mod = await import("./view3d.js");
    views.three = mod.createView3D($("view3d"), S.model);
    views.three.onFrame(frame);
    views.three.setLabels(S.labels);
    views.threeError = null;
  } catch (err) {
    views.threeError = err;
    $("view3d").innerHTML = `<div class="loading"><div class="banner error">The 3D view could not start in this browser (${esc(err.message)}). The 2D plan works.</div></div>`;
    setView("2d");
    startFallbackLoop();
  }
  pushToViews(true);
}

let fallbackRunning = false;
function startFallbackLoop() {
  if (fallbackRunning) return;
  fallbackRunning = true;
  const loop = () => {
    frame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function setView(v) {
  S.view = v;
  $("v3d").setAttribute("aria-pressed", String(v === "3d"));
  $("v2d").setAttribute("aria-pressed", String(v === "2d"));
  $("view3d").hidden = v !== "3d";
  $("view2d").hidden = v !== "2d";
  $("camera-reset").hidden = v !== "3d";
  $("view-note").textContent = v === "3d" ? "Drag to turn, scroll to zoom. Floors are drawn apart so each one can be seen." : "Plans drawn to scale. Highest floor at the top.";
  store("view", v);
  pushToViews(true);
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

const L = { sim: null, prevSnap: null, curSnap: null, prevPos: new Map(), curPos: new Map(), acc: 0, playing: false, lastTs: 0, lastUi: 0, seenAlerts: 0, dirty: true };

function liveOptions() {
  return {
    algorithm: $("alg").value,
    seed: Math.max(1, Math.round(Number($("seed").value) || 1)),
    alarm: $("alarm").value,
    confirm: $("confirm").value,
    balanceExits: $("balance").checked,
    visitors: $("visitors").checked,
    cameraCounts: S.cameraCounts,
    falseAlarms: S.falseAlarms,
  };
}

function newRun() {
  if (!S.model) return;
  const sc = S.scenarios[Number($("sc").value)] ?? S.scenarios[0];
  try {
    L.sim = E.createSimulation(S.model, sc, S.params, liveOptions());
  } catch (err) {
    toast(err.message);
    return;
  }
  L.curSnap = L.sim.snapshot();
  L.prevSnap = L.curSnap;
  L.curPos = placePeople(S.model, L.curSnap, S.lines);
  L.prevPos = L.curPos;
  L.acc = 0;
  L.playing = false;
  L.seenAlerts = 0;
  $("play").textContent = "Start";
  pushToViews(true);
  renderLiveUi(true);
}

function stepSim(seconds) {
  let n = 0;
  while (n < seconds && !L.sim.done) {
    L.sim.step(1);
    n++;
    if (L.sim.alerts.length > L.seenAlerts) {
      const fresh = L.sim.alerts.slice(L.seenAlerts);
      L.seenAlerts = L.sim.alerts.length;
      // Pause only while there is no alarm: then nobody can move without a decision.
      if (fresh.some((a) => a.status === "new") && $("confirm").value === "manual" && L.sim.alarmAt === null) {
        L.playing = false;
        $("play").textContent = "Continue";
        toast("New sensor alert: confirm or dismiss it to continue.");
        break;
      }
    }
  }
  if (n > 0) {
    L.prevSnap = L.curSnap;
    L.prevPos = L.curPos;
    L.curSnap = L.sim.snapshot();
    L.curPos = placePeople(S.model, L.curSnap, S.lines);
    L.dirty = true;
  }
  if (L.sim.done && L.playing) {
    L.playing = false;
    $("play").textContent = "Start";
    toast("Run finished.");
  }
  return n;
}

function frame() {
  if (!L.sim) return;
  const now = performance.now();
  const dt = L.lastTs ? Math.min(0.1, (now - L.lastTs) / 1000) : 0;
  L.lastTs = now;
  if (L.playing) {
    L.acc += dt * Number($("speed").value);
    const whole = Math.floor(L.acc);
    if (whole >= 1) {
      L.acc -= whole;
      stepSim(Math.min(whole, 600));
    }
  }
  pushToViews(false);
  if (now - L.lastUi > 250) {
    L.lastUi = now;
    renderLiveUi(false);
  }
}

function interpolated() {
  const alpha = L.playing ? Math.min(1, L.acc) : 1;
  if (alpha >= 1) return L.curPos;
  const out = new Map();
  for (const [id, p] of L.curPos) {
    const q = L.prevPos.get(id);
    out.set(id, q ? [q[0] + (p[0] - q[0]) * alpha, q[1] + (p[1] - q[1]) * alpha, q[2] + (p[2] - q[2]) * alpha] : p);
  }
  return out;
}

let planDrawnAt = 0;
function pushToViews(force) {
  if (!L.curSnap) return;
  const pos = interpolated();
  const fired = new Set(L.curSnap.alerts.map((a) => a.sensor));
  if (views.three && S.view === "3d") {
    views.three.setPeople(pos, L.curSnap.people, L.prevPos);
    views.three.setHazards(L.curSnap.hazards);
    views.three.setSensors(fired);
  }
  const now = performance.now();
  if (views.plan && S.view === "2d" && (force || now - planDrawnAt > 60)) {
    planDrawnAt = now;
    views.plan.update({ positions: pos, people: L.curSnap.people, hazards: L.curSnap.hazards, fired });
  }
}

function renderLiveUi(force) {
  if (!L.sim || (!L.dirty && !force)) return;
  L.dirty = false;
  const sim = L.sim;
  const t = sim.t;
  $("clock").textContent = mmss(t);
  const sum = E.summarize(sim);
  const waitingAlarm = sim.alarmAt === null;
  $("clock-sub").textContent = sim.done ? (sum.allOut ? "finished: everyone out" : "finished") : t === 0 && !L.playing ? "press Start" : waitingAlarm ? (L.playing ? "running, no alarm yet" : "paused, no alarm yet") : L.playing ? "running" : "paused";
  // Message over the view: a waiting alert (with its buttons), or why nobody moves yet.
  const bar = $("alert-bar");
  const pending = sim.alerts.find((a) => a.status === "new");
  if (pending && $("confirm").value === "manual") {
    bar.className = "alert-bar";
    bar.innerHTML = `<p><b>${esc(cap(pending.kind))} sensor ${esc(pending.sensor)}</b> at ${esc(S.model.nodes[pending.node].id)}. ${waitingAlarm ? "Nobody moves until you confirm an alert." : "The alarm is already on; confirming tells everyone's routes about this hazard."}</p><div class="row"><button class="btn small danger" data-confirm="${pending.id}">Confirm</button><button class="btn small" data-dismiss="${pending.id}">Dismiss</button></div>`;
    bar.hidden = false;
  } else if (waitingAlarm && t > 0 && !sim.done) {
    bar.className = "alert-bar info";
    bar.innerHTML = pending
      ? `<p>Sensor alert at ${esc(S.model.nodes[pending.node].id)}. The commander confirms it at ${mmss(pending.t + S.params.confirm_delay_s)}; then the alarm sounds and people start to move.</p>`
      : `<p>No alarm yet. People stay where they are until a sensor detects the hazard (about ${Math.round(S.params.sensor_delay_s)} s after it reaches the sensor) and the alert is confirmed.</p>`;
    bar.hidden = false;
  } else if (sim.alarmAt !== null && t - sim.alarmAt < 20 && !sim.done) {
    bar.className = "alert-bar info";
    bar.innerHTML = `<p>Alarm at ${mmss(sim.alarmAt)}. Each person first reacts or is prepared (walking patients 30–90 s, stretchers 3–15 min with two staff), then moves.</p>`;
    bar.hidden = false;
  } else bar.hidden = true;
  const chip = $("alarm-chip");
  if (sim.alarmAt === null) {
    chip.className = sim.alerts.some((a) => a.status === "new") ? "chip warn" : "chip idle";
    chip.textContent = sim.alerts.some((a) => a.status === "new") ? "Alert waiting" : "No alarm";
  } else {
    chip.className = "chip on";
    chip.textContent = `Alarm at ${mmss(sim.alarmAt)}`;
  }
  const states = {};
  for (const a of sim.agents) states[a.state] = (states[a.state] ?? 0) + 1;
  const inside = sum.total - sum.out - sum.reached;
  const stats = [
    { k: "Out of the building", v: `${sum.out} / ${sum.total}`, cls: sum.allOut ? "good" : "" },
    { k: "Still inside", v: inside, cls: "" },
    { k: "Waiting for staff", v: (states.needsHelp ?? 0) + (states.prep ?? 0), cls: (states.needsHelp ?? 0) ? "warn" : "" },
    { k: "Being escorted", v: sim.agents.filter((a) => a.helpers.length && !["out", "reached"].includes(a.state)).length, cls: "" },
    { k: "No safe route, sheltering", v: states.stuck_wait ?? 0, cls: (states.stuck_wait ?? 0) ? "warn" : "" },
    { k: "Reached by hazard", v: sum.reached, cls: sum.reached ? "bad" : "" },
    { k: "90% out at", v: mmss(sum.t90), cls: "" },
    { k: "Staff trips / lift trips", v: `${sum.staffTrips} / ${sum.liftTrips}`, cls: "" },
  ];
  $("stats").innerHTML = stats.map((s) => `<div class="stat ${s.cls}"><div class="v">${esc(s.v)}</div><div class="k">${esc(s.k)}</div></div>`).join("");

  // Alerts
  const alerts = [...sim.alerts].reverse();
  $("alert-count").textContent = `${alerts.length} total, ${alerts.filter((a) => a.status === "new").length} waiting`;
  $("alerts").innerHTML = alerts.length
    ? alerts
        .slice(0, 30)
        .map((a) => {
          const place = S.model.nodes[a.node].id;
          const status = a.status === "new" ? "" : `<span class="small muted">${a.status === "confirmed" ? "Confirmed" : "Dismissed"} at ${mmss(a.decidedAt)}</span>`;
          const actions = a.status === "new" ? `<div class="row"><button class="btn small danger" data-confirm="${a.id}">Confirm</button><button class="btn small" data-dismiss="${a.id}">Dismiss</button></div>` : "";
          return `<div class="alert ${a.status}"><div><b>${esc(cap(a.kind))} sensor ${esc(a.sensor)}</b> · ${esc(place)}${a.falseAlarm ? ` <span class="tag policy">test alarm</span>` : ""}</div><div class="t">Raised at ${mmss(a.t)}</div>${actions}${status}</div>`;
        })
        .join("")
    : `<p class="hint">No sensor has raised an alert yet.</p>`;

  // Chart and exits
  lineChart($("live-chart"), {
    series: [{ name: "Out", colour: "#1D5F96", points: sim.curve.concat(sim.curve[sim.curve.length - 1]?.[0] === t ? [] : [[t, sum.out]]) }],
    yMax: sum.total,
    xMin: 0,
    xMax: Math.max(300, t),
    yLabel: "people",
    alarm: sim.alarmAt,
  });
  const maxExit = Math.max(1, ...sum.exits.map((x) => x.people));
  $("exit-bars").innerHTML = sum.exits
    .map((x) => `<div class="bar"><span>${esc(x.exit)}</span><span class="num" style="text-align:right">${x.people}</span><div class="track"><div class="fill" style="width:${(100 * x.people) / maxExit}%"></div></div></div>`)
    .join("");
  const ev = sim.events.slice(-40).reverse();
  $("log").innerHTML = ev.length ? ev.map((e) => `<div><time>${mmss(e.t)}</time><span>${esc(e.message)}</span></div>`).join("") : `<p class="hint">Events appear here as the run goes on.</p>`;
  if (!$("page-devices").hidden) renderSensorStatus();
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function onAlertClick(e) {
  const c = e.target.closest("[data-confirm]");
  const d = e.target.closest("[data-dismiss]");
  if (c) {
    L.sim.confirm(Number(c.dataset.confirm));
    toast("Alert confirmed. The alarm sounds and routes avoid this hazard.");
  } else if (d) {
    L.sim.dismiss(Number(d.dataset.dismiss));
    toast("Alert dismissed.");
  } else return;
  L.curSnap = L.sim.snapshot();
  L.dirty = true;
  if (!L.sim.done && !L.playing) {
    // Carry on running after a decision, so people start to move.
    L.playing = true;
    L.lastTs = 0;
    $("play").textContent = "Pause";
  }
  renderLiveUi(true);
}
$("alerts").addEventListener("click", onAlertClick);
$("alert-bar").addEventListener("click", onAlertClick);

$("play").addEventListener("click", () => {
  if (!L.sim) return;
  if (L.sim.done) newRun();
  L.playing = !L.playing;
  L.lastTs = 0;
  $("play").textContent = L.playing ? "Pause" : "Continue";
  renderLiveUi(true);
});
$("step").addEventListener("click", () => {
  if (!L.sim) return;
  L.playing = false;
  $("play").textContent = "Continue";
  stepSim(10);
  pushToViews(true);
  renderLiveUi(true);
});
$("reset").addEventListener("click", newRun);
for (const id of ["alg", "alarm", "confirm", "balance", "visitors", "seed"]) $(id).addEventListener("change", newRun);
$("sc").addEventListener("change", () => {
  syncScenarioNote();
  newRun();
});
$("speed").addEventListener("input", () => ($("speed-v").textContent = $("speed").value));
$("v3d").addEventListener("click", () => setView(views.threeError ? "2d" : "3d"));
$("v2d").addEventListener("click", () => setView("2d"));
$("floor").addEventListener("change", () => {
  S.floor = $("floor").value === "all" ? null : Number($("floor").value);
  views.three?.setFloor(S.floor);
  views.plan?.setFloor(S.floor);
  pushToViews(true);
});
$("labels").addEventListener("change", () => {
  S.labels = $("labels").checked;
  views.three?.setLabels(S.labels);
});
$("camera-reset").addEventListener("click", () => views.three?.resetCamera());
$("live-form").addEventListener("submit", (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Charts (SVG, drawn to scale)
// ---------------------------------------------------------------------------

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function lineChart(el, { series, yMax, xMin = 0, xMax, yLabel = "", band = null, alarm = null, height = 220 }) {
  // Drawn at the container's own width so text stays at its set size.
  const W = Math.max(280, Math.min(1100, el.clientWidth || 560));
  const H = height;
  const m = { l: 40, r: 12, t: 12, b: 30 };
  const ym = Math.max(1, yMax);
  const xm = Math.max(xMin + 1, xMax);
  const X = (x) => m.l + ((x - xMin) / (xm - xMin)) * (W - m.l - m.r);
  const Y = (y) => H - m.b - (y / ym) * (H - m.t - m.b);
  const xs = niceStep((xm - xMin) / 60, 6) * 60;
  const ys = Math.max(1, Math.round(niceStep(ym, 4)));
  let g = "";
  for (let y = 0; y <= ym + 1e-9; y += ys) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}" stroke="#E2E8F0"/><text x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end" font-size="11" fill="#64748B">${y}</text>`;
  for (let x = Math.ceil(xMin / xs) * xs; x <= xm + 1e-9; x += xs) g += `<line x1="${X(x)}" x2="${X(x)}" y1="${H - m.b}" y2="${H - m.b + 4}" stroke="#94A3B8"/><text x="${X(x)}" y="${H - m.b + 16}" text-anchor="middle" font-size="11" fill="#64748B">${mmss(x)}</text>`;
  let b = "";
  if (band) {
    const top = band.grid.map((x, i) => `${X(x)},${Y(band.high[i])}`);
    const bottom = band.grid.map((x, i) => `${X(x)},${Y(band.low[i])}`).reverse();
    b = `<polygon points="${top.concat(bottom).join(" ")}" fill="#7DB8E8" fill-opacity="0.25" stroke="none"/>`;
  }
  let a = "";
  if (alarm !== null && alarm !== undefined && alarm >= xMin && alarm <= xm) a = `<line x1="${X(alarm)}" x2="${X(alarm)}" y1="${m.t}" y2="${H - m.b}" stroke="#DC2626" stroke-dasharray="4 3"/><text x="${X(alarm) + 4}" y="${m.t + 10}" font-size="11" fill="#991B1B">alarm</text>`;
  const lines = series
    .map((s) => {
      const pts = s.points.filter((p) => p[0] <= xm);
      if (!pts.length) return "";
      let d = `M${X(pts[0][0])},${Y(pts[0][1])}`;
      for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i][0])} V${Y(pts[i][1])}`;
      const last = pts[pts.length - 1];
      return `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ""}/><circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3" fill="${s.colour}"/>`;
    })
    .join("");
  const legend = series.length > 1 || band ? `<div class="legend" style="margin-top:6px">${series.map((s) => `<span><i class="dot" style="background:${s.colour}"></i>${esc(s.name)}</span>`).join("")}${band ? `<span><i class="sq" style="background:rgba(125,184,232,0.35);border-color:#7DB8E8"></i>${esc(band.name)}</span>` : ""}</div>` : "";
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))} over time">${g}<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="#94A3B8"/>${b}${a}${lines}<text x="${m.l}" y="${m.t - 2}" font-size="11" fill="#64748B">${esc(yLabel)}</text></svg>${legend}`;
}

function rangeChart(el, rows) {
  // rows: {label, mean, min, max, ok}
  const W = Math.max(320, Math.min(1100, el.clientWidth || 560));
  const rowH = 30;
  const m = { l: 170, r: 50, t: 8, b: 28 };
  const H = m.t + m.b + rows.length * rowH;
  const xm = Math.max(60, ...rows.map((r) => r.max ?? 0));
  const X = (x) => m.l + (x / xm) * (W - m.l - m.r);
  const step = niceStep(xm / 60, 5) * 60;
  let g = "";
  for (let x = 0; x <= xm + 1e-9; x += step) g += `<line x1="${X(x)}" x2="${X(x)}" y1="${m.t}" y2="${H - m.b}" stroke="#E2E8F0"/><text x="${X(x)}" y="${H - m.b + 16}" text-anchor="middle" font-size="11" fill="#64748B">${mmss(x)}</text>`;
  const marks = rows
    .map((r, i) => {
      const y = m.t + i * rowH + rowH / 2;
      const label = `<text x="${m.l - 8}" y="${y + 4}" text-anchor="end" font-size="12" fill="#334155">${esc(r.label)}</text>`;
      if (r.mean === null) return `${label}<text x="${m.l + 4}" y="${y + 4}" font-size="12" fill="#991B1B">nobody out</text>`;
      return `${label}<line x1="${X(r.min)}" x2="${X(r.max)}" y1="${y}" y2="${y}" stroke="#94A3B8" stroke-width="2"/><line x1="${X(r.min)}" x2="${X(r.min)}" y1="${y - 6}" y2="${y + 6}" stroke="#94A3B8"/><line x1="${X(r.max)}" x2="${X(r.max)}" y1="${y - 6}" y2="${y + 6}" stroke="#94A3B8"/><rect x="${X(r.mean) - 6}" y="${y - 6}" width="12" height="12" rx="3" fill="${r.ok ? "#1D5F96" : "#EA580C"}"/><text x="${X(r.max) + 6}" y="${y + 4}" font-size="11" fill="#64748B">${mmss(r.mean)}</text>`;
    })
    .join("");
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Time until the last person is out, per plan">${g}${marks}</svg><div class="legend" style="margin-top:6px"><span><i class="sq" style="background:#1D5F96;border-color:#1D5F96"></i>Mean, every run got everyone out</span><span><i class="sq" style="background:#EA580C;border-color:#EA580C"></i>Mean, some people not out</span><span><i class="sq" style="background:#fff"></i>Line: fastest to slowest run</span></div>`;
}

// ---------------------------------------------------------------------------
// Sensors and cameras page
// ---------------------------------------------------------------------------

function renderDevices() {
  if (!S.model) return;
  const m = S.model;
  $("cam-rows").innerHTML = m.cameras.length
    ? m.cameras.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(m.nodes[c.node].id)}</td><td class="n"><input type="number" min="0" max="2000" step="1" value="${S.cameraCounts[c.id] ?? 0}" data-cam="${esc(c.id)}" id="cam-${esc(c.id)}" aria-label="People counted by ${esc(c.id)}"></td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">This building has no cameras. Add them with a devices file on the Building data page.</td></tr>`;
  $("fa-sensor").innerHTML = m.sensors.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.kind)} · ${esc(m.nodes[s.node].id)}</option>`).join("");
  $("fa-list").innerHTML = S.falseAlarms.length ? S.falseAlarms.map((f) => `<li>${esc(f.sensor)} at ${mmss(f.t)}</li>`).join("") : `<li class="muted" style="list-style:none;margin-left:-18px">No test alarms scheduled.</li>`;
  $("sensor-count").textContent = `${m.sensors.length} sensors`;
  renderSensorStatus();
}

function renderSensorStatus() {
  const m = S.model;
  const byId = new Map((L.sim?.alerts ?? []).map((a) => [a.sensor, a]));
  $("sensor-rows").innerHTML = m.sensors.length
    ? m.sensors
        .map((s) => {
          const a = byId.get(s.id);
          const status = !a ? `<span class="tag policy">Quiet</span>` : a.status === "new" ? `<span class="tag assumed">Alert at ${mmss(a.t)}, waiting</span>` : a.status === "confirmed" ? `<span class="tag open">Confirmed at ${mmss(a.decidedAt)}</span>` : `<span class="tag policy">Dismissed</span>`;
          return `<tr><td>${esc(s.id)}</td><td>${esc(cap(s.kind))}</td><td>${esc(m.nodes[s.node].id)}</td><td>${m.nodes[s.node].floor}</td><td>${status}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">No sensors loaded.</td></tr>`;
}

$("cam-rows").addEventListener("change", (e) => {
  const input = e.target.closest("[data-cam]");
  if (!input) return;
  const v = Math.round(Number(input.value));
  if (!Number.isFinite(v) || v < 0 || v > 2000) {
    input.value = S.cameraCounts[input.dataset.cam];
    toast("A count must be a whole number from 0 to 2000.");
    return;
  }
  S.cameraCounts[input.dataset.cam] = v;
  newRun();
  toast(`${input.dataset.cam}: ${v} people. The live run was restarted.`);
});
$("cam-sim").addEventListener("click", () => {
  // A made-up reading: each count moves by up to 3 people, as a camera feed would.
  const rnd = E.makeRandom(Date.now() % 100000);
  for (const c of S.model.cameras) S.cameraCounts[c.id] = Math.max(0, (S.cameraCounts[c.id] ?? 0) + Math.round(rnd() * 6 - 3));
  renderDevices();
  newRun();
  $("cam-sim-note").textContent = "New simulated counts applied.";
});
$("cam-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const counts = IO.cameraCountsFromCsv(await readFile(file));
    const known = new Set(S.model.cameras.map((c) => c.id));
    const unknown = Object.keys(counts).filter((k) => !known.has(k));
    for (const [k, v] of Object.entries(counts)) if (known.has(k)) S.cameraCounts[k] = v;
    renderDevices();
    newRun();
    toast(unknown.length ? `Counts applied. Unknown cameras skipped: ${unknown.slice(0, 4).join(", ")}` : "Camera counts applied.");
  } catch (err) {
    toast(err.message);
  }
  e.target.value = "";
});
$("fa-add").addEventListener("click", () => {
  const t = Math.round(Number($("fa-time").value));
  if (!Number.isFinite(t) || t < 1 || t > 3600) return toast("Pick a second from 1 to 3600.");
  if (!$("fa-sensor").value) return toast("This building has no sensors.");
  S.falseAlarms.push({ t, sensor: $("fa-sensor").value });
  S.falseAlarms.sort((a, b) => a.t - b.t);
  renderDevices();
  newRun();
  toast("Test alarm added to the live run.");
});
$("fa-clear").addEventListener("click", () => {
  S.falseAlarms = [];
  renderDevices();
  newRun();
});

// ---------------------------------------------------------------------------
// Compare page
// ---------------------------------------------------------------------------

function withStaff(n) {
  const staff = (S.data.staff ?? []).slice(0, n);
  return E.buildModel({ ...S.data, staff });
}

$("cmp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sc = S.scenarios[Number($("cmp-sc").value)];
  const runs = Number($("cmp-runs").value);
  const staffN = Math.max(0, Math.round(Number($("cmp-staff").value)));
  const seeds = Array.from({ length: runs }, (_, i) => i + 1);
  const balanceToo = $("cmp-balance").checked;
  const plans = [];
  for (const alg of ["dijkstra", "astar", "bfs", "dfs"]) {
    plans.push({ alg, balance: false });
    // Balancing changes route costs, so it only affects the cost-based methods.
    if (balanceToo && (alg === "dijkstra" || alg === "astar")) plans.push({ alg, balance: true });
  }
  const model = withStaff(staffN);
  const opts = { visitors: $("cmp-visitors").checked, cameraCounts: S.cameraCounts };
  $("cmp-run").disabled = true;
  const bar = $("cmp-progress");
  bar.hidden = false;
  const results = [];
  let done = 0;
  try {
    for (const plan of plans) {
      const res = [];
      for (const seed of seeds) {
        res.push(E.simulate(model, sc, S.params, { ...opts, algorithm: plan.alg, balanceExits: plan.balance, seed }));
        done++;
        bar.firstElementChild.style.width = `${(100 * done) / (plans.length * seeds.length)}%`;
        await pause();
      }
      const times = res.map((r) => r.lastOut).filter((x) => x !== null);
      const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
      results.push({
        ...plan,
        label: `${ALG_WORD[plan.alg]}${plan.balance ? " + balanced exits" : ""}`,
        allOut: res.filter((r) => r.allOut).length,
        meanOut: mean(res.map((r) => r.out)),
        meanReached: mean(res.map((r) => r.reached)),
        meanShelter: mean(res.map((r) => r.stuck)),
        t90: mean(res.map((r) => r.t90).filter((x) => x !== null)),
        mean: mean(times),
        min: times.length ? Math.min(...times) : null,
        max: times.length ? Math.max(...times) : null,
        helpWait: mean(res.map((r) => r.meanHelpWait).filter((x) => x !== null)),
        exposure: mean(res.map((r) => r.smokeExposure)),
        total: res[0].total,
        exits: res[0].exits.map((x, i) => ({ exit: x.exit, people: mean(res.map((r) => r.exits[i].people)) })),
      });
    }
  } catch (err) {
    $("cmp-out").innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    return;
  } finally {
    $("cmp-run").disabled = false;
    bar.hidden = true;
  }
  renderComparison(results, sc, runs, staffN);
});

function renderComparison(results, sc, runs, staffN) {
  const best = [...results].sort((a, b) => b.meanOut - a.meanOut || (a.mean ?? 1e9) - (b.mean ?? 1e9))[0];
  const f1 = (x) => (x === null || x === undefined ? "–" : (Math.round(x * 10) / 10).toString());
  const rows = results
    .map((r) => `<tr${r === best ? ' style="background:#F0FAF4"' : ""}><td><b>${esc(r.label)}</b>${r === best ? ` <span class="tag sourced">best here</span>` : ""}</td><td class="n">${r.allOut} / ${runs}</td><td class="n">${f1(r.meanOut)} / ${r.total}</td><td class="n">${f1(r.meanReached)}</td><td class="n">${f1(r.meanShelter)}</td><td class="n">${mmss(r.t90)}</td><td class="n">${mmss(r.mean)} <span class="muted">(${mmss(r.min)}–${mmss(r.max)})</span></td><td class="n">${r.helpWait === null ? "–" : mmss(r.helpWait)}</td><td class="n">${f1(r.exposure)}</td><td>${r.exits.map((x) => `${esc(x.exit)} ${f1(x.people)}`).join("<br>")}</td></tr>`)
    .join("");
  $("cmp-out").innerHTML = `
    <div class="card stack">
      <div class="row" style="justify-content:space-between"><h2>${esc(sc.name)}</h2><span class="small muted">${runs} runs per plan · ${staffN} staff on duty</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Plan</th><th class="n">Everyone out</th><th class="n">People out (mean)</th><th class="n">Reached by hazard</th><th class="n">Sheltering</th><th class="n">90% out</th><th class="n">Last person out (fastest–slowest)</th><th class="n">Wait for staff</th><th class="n">Smoke exposure (person-s)</th><th>Exits (mean people)</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="hint">"Best here" means most people out, then the shortest time, for this scenario only. Sheltering means a person, often with their staff, had no safe step-free route left and waited in a protected place.</p>
    </div>
    <div class="card stack"><h2>Time until the last person is out</h2><div class="chart" id="cmp-chart"></div></div>`;
  rangeChart($("cmp-chart"), results.map((r) => ({ label: r.label, mean: r.mean, min: r.min, max: r.max, ok: r.allOut === runs })));
}

// ---------------------------------------------------------------------------
// Drill page
// ---------------------------------------------------------------------------

$("drill-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    S.drillRows = IO.drillFromCsv(await readFile(file));
    S.drillMadeUp = false;
    $("drill-banner").className = "banner info";
    $("drill-banner").innerHTML = `Using the drill record <b>${esc(file.name)}</b> (${S.drillRows.length} people). Pick the scenario that matches how the drill was run.`;
    toast("Drill record loaded.");
  } catch (err) {
    toast(err.message);
  }
});

$("drill-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!S.drillRows) {
    try {
      S.drillRows = IO.drillFromCsv(await (await fetch("examples/drill-observations.csv")).text());
    } catch (err) {
      $("drill-out").innerHTML = `<div class="banner error">Could not load the example drill record (${esc(err.message)}). Import a drill record instead.</div>`;
      return;
    }
  }
  const sc = S.scenarios[Number($("drill-sc").value)];
  const runs = Number($("drill-runs").value);
  const seeds = Array.from({ length: runs }, (_, i) => i + 1);
  $("drill-out").innerHTML = `<div class="card"><p class="hint">Running the model ${runs} times…</p></div>`;
  await pause();
  const opts = { algorithm: $("drill-alg").value, visitors: $("drill-visitors").checked, cameraCounts: S.cameraCounts };
  let many;
  try {
    const results = [];
    for (const seed of seeds) {
      results.push(E.simulate(S.model, sc, S.params, { ...opts, seed }));
      await pause();
    }
    const times = results.map((r) => r.lastOut).filter((x) => x !== null);
    many = { results, meanTime: times.length ? times.reduce((s, x) => s + x, 0) / times.length : null, minTime: times.length ? Math.min(...times) : null, maxTime: times.length ? Math.max(...times) : null };
  } catch (err) {
    $("drill-out").innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    return;
  }
  const c = E.compareWithDrill(S.drillRows, many, 10);
  const people = many.results[0].total;
  const countNote = people !== c.observedPeople ? `<div class="banner">The model has ${people} people but the drill record has ${c.observedPeople}. Load the same people (or untick visitors) for a fair check.</div>` : "";
  const slower = c.timeError !== null && c.timeError > 0;
  const advice = c.timeError === null ? "" : Math.abs(c.relError) <= 10 ? "The model's total time is within 10% of the drill for this scenario. Check the curve too: a good total can hide early or late errors." : slower ? "The model is slower than the drill. Check preparation times, staff numbers on the day, and whether lifts or extra exits were used in the drill." : "The model is faster than the drill. Check the reaction times, walking speeds of your patients, and the time staff needed to prepare beds.";
  $("drill-out").innerHTML = `
    ${countNote}
    <div class="grid3">
      <div class="card"><h3>Drill: last person out</h3><div class="stat" style="border:0;padding:6px 0"><div class="v">${mmss(c.observedTotal)}</div><div class="k">${c.observedPeople} people recorded${S.drillMadeUp ? " · made-up record" : ""}</div></div></div>
      <div class="card"><h3>Model: last person out</h3><div class="stat" style="border:0;padding:6px 0"><div class="v">${mmss(c.simulatedMean)}</div><div class="k">mean of ${runs} runs · ${mmss(c.simulatedMin)} to ${mmss(c.simulatedMax)}</div></div></div>
      <div class="card"><h3>Difference</h3><div class="stat" style="border:0;padding:6px 0"><div class="v">${c.timeError === null ? "–" : `${c.timeError > 0 ? "+" : ""}${Math.round(c.timeError)} s`}</div><div class="k">${c.relError === null ? "" : `${c.relError > 0 ? "+" : ""}${c.relError}% of the drill time`}</div></div></div>
    </div>
    <div class="card stack">
      <h2>People out over time: drill and model</h2>
      <div class="chart" id="drill-chart"></div>
      <p class="small">Curve gap: root mean square error <b class="num">${c.rmse}</b> people, largest gap <b class="num">${c.maxGap}</b> people. The drill curve lies inside the model's fastest-to-slowest band for <b class="num">${c.inside}%</b> of the time.</p>
      ${advice ? `<p class="hint">${esc(advice)}</p>` : ""}
    </div>
    <div class="card stack">
      <h2>Exits</h2>
      <div class="table-wrap"><table><thead><tr><th>Exit</th><th class="n">Drill</th><th class="n">Model (mean)</th></tr></thead><tbody>${c.exits.map((x) => `<tr><td>${esc(x.exit)}</td><td class="n">${x.observed}</td><td class="n">${x.simulated}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  const end = c.grid[c.grid.length - 1];
  lineChart($("drill-chart"), {
    series: [
      { name: "Drill record", colour: "#C2410C", points: c.grid.map((t, i) => [t, c.observed[i]]) },
      { name: "Model mean", colour: "#1D5F96", points: c.grid.map((t, i) => [t, c.mean[i]]) },
    ],
    band: { grid: c.grid, low: c.low, high: c.high, name: "Model, fastest to slowest run" },
    yMax: Math.max(c.observedPeople, people),
    xMax: end,
    yLabel: "people out",
    height: 260,
  });
});

// ---------------------------------------------------------------------------
// Building data page
// ---------------------------------------------------------------------------

function readFile(file) {
  if (file.size > IO.MAX_FILE_BYTES) return Promise.reject(new Error(`${file.name} is larger than 2 MB`));
  return file.text();
}

function dataMessage(kind, text) {
  $("data-msg").innerHTML = text ? `<div class="banner ${kind}">${esc(text)}</div>` : "";
}

function renderBuilding() {
  if (!S.model) return;
  const m = S.model;
  const count = (n, kind) => m.people.filter((p) => p.home === n && p.kind === kind).length;
  const devices = (n) => [...m.sensors.filter((s) => s.node === n).map((s) => s.id), ...m.cameras.filter((c) => c.node === n).map((c) => `${c.id} (camera)`)].join(", ");
  $("place-rows").innerHTML = m.nodes
    .map((n) => `<tr><td>${esc(n.id)}</td><td>${esc(n.type)}${n.evacLift ? " · evacuation lift" : ""}</td><td>${n.floor}</td><td class="n">${n.w} × ${n.l}</td><td class="n">${count(n.i, "patient") || ""}</td><td class="n">${count(n.i, "staff") || ""}</td><td class="small">${esc(devices(n.i))}</td></tr>`)
    .join("");
  $("data-summary").textContent = `${m.nodes.length} places · ${m.edges.filter((e) => !e.virtual).length} paths · ${m.people.length} people · ${S.scenarios.length} scenarios`;
  const out = { ...S.data };
  $("export").value = JSON.stringify(out, null, 1);
}

async function loadFromHealth11() {
  const plan = $("h11-plan").files?.[0];
  if (!plan) return dataMessage("error", "Choose a floor plan CSV first.");
  try {
    const floor = Math.round(Number($("h11-floor").value) || 0);
    const { places, paths } = IO.floorFromHealth11Csv(await readFile(plan), floor);
    const patients = $("h11-patients").files?.[0] ? IO.patientsFromCsv(await readFile($("h11-patients").files[0])) : [];
    const staff = $("h11-staff").files?.[0] ? IO.staffFromCsv(await readFile($("h11-staff").files[0])) : [];
    const devices = $("h11-devices").files?.[0] ? IO.devicesFromCsv(await readFile($("h11-devices").files[0])) : { sensors: [], cameras: [] };
    useBuilding({ name: plan.name.replace(/\.csv$/i, ""), places, paths, patients, staff, ...devices, scenarios: [] });
    dataMessage("info", `Loaded ${places.length} places, ${paths.length} paths, ${patients.length} patients and ${staff.length} staff.`);
  } catch (err) {
    dataMessage("error", err.message);
  }
}

async function loadRiverside() {
  try {
    const [plan, patients, staff] = await Promise.all(["riverside-ground-floor.csv", "riverside-patients.csv", "riverside-staff.csv"].map((f) => fetch(`examples/${f}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${f} could not be loaded`))))));
    const { places, paths } = IO.floorFromHealth11Csv(plan, 0);
    const data = {
      name: "Riverside Hospital (made-up)",
      synthetic: true,
      places,
      paths,
      patients: IO.patientsFromCsv(patients),
      staff: IO.staffFromCsv(staff),
      sensors: places.filter((p) => ["ward", "icu", "room", "corridor"].includes(p.type)).map((p, i) => ({ id: `SD-${String(i + 1).padStart(2, "0")}`, kind: "smoke", place: p.id })),
      cameras: [{ id: "CAM-RECEPTION", place: "Reception", count: 8 }],
      scenarios: [
        { name: "Fire in the Pharmacy", alarm: "sensors", note: "Fire spreads from the Pharmacy.", hazards: [{ type: "fire", origin: "Pharmacy", severity: 4, spreadRate: 0.05 }] },
        { name: "Evacuation drill (no hazard)", alarm: "start", note: "Alarm at the start.", hazards: [] },
      ],
    };
    useBuilding(data);
    dataMessage("info", "Loaded the made-up Riverside example from the HEALTH-11 CSV files, with smoke sensors in each room and one reception camera added for this prototype.");
  } catch (err) {
    dataMessage("error", err.message);
  }
}

async function loadDemo() {
  const res = await fetch("examples/demo-building.json");
  if (!res.ok) throw new Error(`The demo building could not be loaded (HTTP ${res.status})`);
  useBuilding(IO.buildingFromJson(await res.text()));
}

function addFireModel(hazards, source) {
  const sc = { name: "Imported fire model", alarm: "sensors", note: `Hazard times from ${source}. The prototype uses the times as given; it does not run the fire model.`, hazards, imported: true };
  E.hazardArrivals(S.model, sc, S.params); // check place names before adding
  S.scenarios = S.scenarios.filter((s) => !s.imported);
  S.scenarios.push(sc);
  fillScenarioSelects();
  $("sc").value = String(S.scenarios.length - 1);
  syncScenarioNote();
  newRun();
  renderBuilding();
}

$("h11-load").addEventListener("click", loadFromHealth11);
$("riverside").addEventListener("click", loadRiverside);
$("demo").addEventListener("click", () => loadDemo().then(() => dataMessage("info", "Demo building loaded.")).catch((err) => dataMessage("error", err.message)));
$("json-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    useBuilding(IO.buildingFromJson(await readFile(file)));
    dataMessage("info", `Loaded ${file.name}.`);
  } catch (err) {
    dataMessage("error", err.message);
  }
  e.target.value = "";
});
$("fire-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    addFireModel(IO.hazardsFromFireModelCsv(await readFile(file)), file.name);
    dataMessage("info", `Fire-model times from ${file.name} added as the scenario "Imported fire model".`);
  } catch (err) {
    dataMessage("error", err.message);
  }
  e.target.value = "";
});
$("fire-example").addEventListener("click", async () => {
  try {
    const text = await (await fetch("examples/fire-model-arrivals.csv")).text();
    addFireModel(IO.hazardsFromFireModelCsv(text), "the made-up example file");
    dataMessage("info", 'The made-up fire-model example was added as the scenario "Imported fire model". Open Live 3D view to run it.');
  } catch (err) {
    dataMessage("error", err.message);
  }
});
$("copy-export").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("export").value);
    toast("Building file copied.");
  } catch {
    $("export").select();
    toast("Press Ctrl+C to copy the selected text.");
  }
});

// ---------------------------------------------------------------------------
// Parameters page
// ---------------------------------------------------------------------------

function renderParameters() {
  const groups = [...new Set(E.PARAMS.map((p) => p.group))];
  const srcKeys = Object.keys(E.SOURCES);
  const tag = { sourced: "Sourced", derived: "Derived", assumed: "Assumed", policy: "Policy" };
  $("param-groups").innerHTML = groups
    .map((g) => {
      const rows = E.PARAMS.filter((p) => p.group === g)
        .map((p) => {
          const v = S.params[p.key];
          const changed = v !== p.value;
          const src = E.SOURCES[p.source];
          const num = srcKeys.indexOf(p.source) + 1;
          return `<tr><td>${esc(p.label)}${changed ? ` <span class="tag policy">changed from ${p.value}</span>` : ""}</td><td class="n"><input type="number" step="any" id="p-${p.key}" data-param="${p.key}" value="${v}" aria-label="${esc(p.label)}"></td><td>${esc(p.unit)}</td><td><span class="tag ${p.kind}">${tag[p.kind]}</span></td><td class="small">[${num}] ${esc(src.short)}</td></tr>`;
        })
        .join("");
      return `<div class="card stack"><h2>${esc(g)}</h2><div class="table-wrap"><table><thead><tr><th>Parameter</th><th class="n">Value</th><th>Unit</th><th>Status</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })
    .join("");
  $("sources").innerHTML = srcKeys.map((k) => `<li><b>${esc(E.SOURCES[k].short)}.</b> ${esc(E.SOURCES[k].full)}${E.SOURCES[k].url ? ` <a href="${esc(E.SOURCES[k].url)}" target="_blank" rel="noopener">Open source</a>` : ""}</li>`).join("");
}

$("param-groups").addEventListener("change", (e) => {
  const input = e.target.closest("[data-param]");
  if (!input) return;
  const key = input.dataset.param;
  const v = Number(input.value);
  const def = E.PARAMS.find((p) => p.key === key);
  const positive = !["lifts_for_walkers", "prep_ventilator_extra", "risk_penalty_m", "confirm_delay_s", "sensor_delay_s", "discovery_delay_s"].includes(key);
  if (!Number.isFinite(v) || v < 0 || (positive && v === 0) || (key === "min_speed_fraction" && v > 1) || (key === "sfpe_a" && v >= 1)) {
    input.value = S.params[key];
    toast(`"${def.label}" needs a ${positive ? "number above 0" : "number of 0 or more"}.`);
    return;
  }
  S.params[key] = v;
  store("params", S.params);
  renderParameters();
  newRun();
  toast("Saved. The live run was restarted with the new value.");
});
$("param-reset").addEventListener("click", () => {
  S.params = E.defaultParams();
  store("params", S.params);
  renderParameters();
  newRun();
  toast("All parameters reset.");
});

// ---------------------------------------------------------------------------
// Gaps page
// ---------------------------------------------------------------------------

const GAPS = [
  ["Hospital mobility is often missing from routing studies", "Addressed: mobility types with stair, ramp and lift rules.", "Staff go to each patient who cannot walk and escort them out (2 staff per bed, per Alonso-Gutierrez & Ronchi 2016; 1 per wheelchair, assumed). Beds and wheelchairs take more room in corridors and lifts. Staff help their own floor first, then return for others.", "Staffing rules are simple; real hospitals use detailed duty rosters."],
  ["Spreading hazards and re-routing are rarely in one tool", "Addressed (simplified): hazards spread over time; people re-route.", "Import of fire-model results (arrival time per place). Protected stairs and lifts. Light smoke counted as exposure; heavy smoke blocks. People who see a blocked place re-route at once; confirmed alerts re-route everyone.", "The prototype does not run a fire model (CFD); it uses times a fire model produced."],
  ["Algorithms are seldom compared on the same hospital", "Addressed: BFS, DFS, Dijkstra and A* on the same scenario.", "Each method also with exit balancing, many runs with different random people, and results shown as mean with fastest and slowest run. Staff numbers can be changed.", "–"],
  ["Results stay inside research software", "Addressed: web app with roles, import, reports, audit log.", "Runs in any browser, reads the HEALTH-11 CSV exports, and shows every parameter with its source.", "The prototype has no accounts or saved runs; those stay in the main app."],
  ["Live occupancy and real validation are missing", "Open: camera counts and sensor alerts were planned; no drill data.", "Camera counts become visitors. Smoke, heat and gas sensors raise alerts the commander confirms or dismisses. A device simulator adds test alarms. The Drill check page compares the model with a drill record.", "Real sensors and cameras are not connected. No real drill record yet, so the model is not validated."],
];
const LIMITS = [
  ["Not yet validated against real hospital drills", "The Drill check page compares a drill record with many model runs (time error, curve error, exits). The loaded record is made up.", "#drill"],
  ["Not modelled: alarm delay", "The alarm comes from sensor response plus commander confirmation, or from people who find the hazard. Each person then waits a reaction or preparation time drawn from published hospital data.", "#live"],
  ["Not modelled: crowd density in corridors", "SFPE speed-density relation: people slow down as a path fills (S = k − a·k·D), and only so many can enter a path per second.", "#parameters"],
  ["Not modelled: slower stairs", "Stairs use the SFPE stair constant (k = 1.08 m/s instead of 1.40 m/s).", "#parameters"],
  ["Not modelled: staff helping patients", "Staff react, walk to patients, prepare them, escort them and go back for others.", "#live"],
  ["Visitors are not counted until camera counts are added", "Camera counts add visitors with their own reaction time and speed.", "#devices"],
  ["Speeds are assumed defaults", "Speeds and delays now come from published sources; the few values without a source are marked Assumed and can be edited.", "#parameters"],
  ["Simplified hazard spread", "Fire-model results can be imported as arrival times per place.", "#building"],
  ["Balancing exits is future work", "Exit balancing: each route counts the people already sent to each exit and the exit's flow, so later people choose a less busy exit.", "#compare"],
];
const OPEN = [
  "Validation with a real drill record from the hospital; the example record is made up.",
  "Connection to real sensors and people-counting cameras (the device simulator stands in).",
  "Running a fire model; only its results are imported.",
  "Moving patients to a safe neighbouring fire compartment (progressive horizontal evacuation); the prototype shows them as sheltering instead.",
  "Individual walking behaviour such as overtaking and counter-flow; people move along paths as a crowd.",
  "Lift numbers (load, speed, door time) and the space beds take are assumed until the hospital measures them.",
];
function renderGaps() {
  $("gap-table").tBodies[0].innerHTML = GAPS.map(([g, h, p, o]) => `<tr><td><b>${esc(g)}</b></td><td class="small">${esc(h)}</td><td>${esc(p)}</td><td class="small">${o === "–" ? "–" : `<span class="tag open">Open</span> ${esc(o)}`}</td></tr>`).join("");
  $("limit-table").tBodies[0].innerHTML = LIMITS.map(([l, d, href]) => `<tr><td><b>${esc(l)}</b></td><td>${esc(d)}</td><td><a href="${href}">${esc(document.querySelector(`#nav a[href="${href}"]`)?.textContent ?? "Open")}</a></td></tr>`).join("");
  $("open-list").innerHTML = OPEN.map((o) => `<li>${esc(o)}</li>`).join("");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  const saved = recall("params", null);
  if (saved && typeof saved === "object") {
    for (const p of E.PARAMS) if (Number.isFinite(saved[p.key])) S.params[p.key] = saved[p.key];
  }
  renderGaps();
  try {
    await loadDemo();
  } catch (err) {
    $("boot").innerHTML = `<div class="banner error">${esc(err.message)}. Open the Building data page to load a file.</div>`;
    showPage(location.hash.slice(1));
    return;
  }
  $("boot").hidden = true;
  setView(recall("view", "3d") === "2d" ? "2d" : "3d");
  showPage(location.hash.slice(1));
  window.__h11 = { S, L, E };
}
start();
