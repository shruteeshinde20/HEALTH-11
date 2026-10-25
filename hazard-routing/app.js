// Page logic: live run, signs, sensors, rescue, comparison, drill check, data, parameters.
import * as E from "./engine.js";
import * as IO from "./io.js";
import { placePeople, edgePolyline } from "./layout.js";
import { createPlan2D } from "./plan2d.js";
import { lineChart, barChart, scatter, heatmap, esc } from "./charts.js";

const $ = (id) => document.getElementById(id);
const METHOD_COLOUR = { nearest: "#6250D6", safe: "#EDA100", congestion: "#2A78D6", proposed: "#0B7A4B" };
const COND_LABEL = { live: "Realistic, live estimate", offline: "Realistic, fire model run before", perfect: "Perfect information" };
const UNIT = { smoke: "1/m", heat: "°C", co: "ppm" };
const STATE_LABEL = {
  waiting: "Not moving yet", needsHelp: "Waiting for staff", prep: "Being prepared", moving: "Moving", stuck: "No route yet",
  shelter: "Sheltering", incapacitated: "Overcome by smoke", out: "Out", refuge: "In a refuge", lift: "Using the lift",
  toPatient: "Going to a patient", escorting: "Escorting", free: "Free", carried: "Being carried",
};
const fmtTime = (s) => (s === null || s === undefined ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const fmtS = (s) => (s === null || s === undefined ? "–" : `${Math.round(s)} s`);
const f2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(d));

const S = {
  data: null,
  model: null,
  params: {},
  cameraCounts: null,
  sim: null,
  snap: null,
  playing: false,
  acc: 0,
  prevPos: new Map(),
  curPos: new Map(),
  lines: [],
  view: "2d",
  floor: null,
  layers: { hazard: true, predicted: true, routes: true, signs: true, sensors: true, density: false },
  plan: null,
  view3d: null,
  page: "live",
  lastPanel: 0,
  lastPlanVersion: -1,
  worker: null,
  jobs: new Map(),
  jobId: 0,
  drill: { rows: null, name: "", scenarioName: null },
  calibration: null,
  replay: null,
};

// ------------------------------------------------------------------ worker
function getWorker() {
  if (!S.worker) {
    S.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    S.worker.onmessage = (ev) => {
      const m = ev.data;
      const job = S.jobs.get(m.id);
      if (!job) return;
      if (m.type === "progress") job.progress?.(m.done, m.total);
      else if (m.type === "done" || m.type === "ready") {
        S.jobs.delete(m.id);
        job.resolve(m.out);
      } else if (m.type === "error") {
        S.jobs.delete(m.id);
        job.reject(new Error(m.message));
      }
    };
    S.worker.onerror = (ev) => {
      for (const job of S.jobs.values()) job.reject(new Error(ev.message || "The background worker stopped"));
      S.jobs.clear();
      S.worker = null;
    };
  }
  return S.worker;
}
function job(msg, progress) {
  const id = ++S.jobId;
  return new Promise((resolve, reject) => {
    S.jobs.set(id, { resolve, reject, progress });
    getWorker().postMessage({ ...msg, id });
  });
}
async function syncWorker() {
  await job({ type: "model", data: S.data, params: S.params });
}

// ------------------------------------------------------------------ setup
function option(value, label, selected = false) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}

function fillSelects() {
  const m = S.model;
  const sc = $("scenario");
  const keep = sc.value;
  sc.replaceChildren(...m.scenarios.map((s, i) => option(String(i), s.name)));
  if (keep && Number(keep) < m.scenarios.length) sc.value = keep;
  $("method").replaceChildren(...Object.entries(E.METHODS).map(([k, v]) => option(k, v.label, k === "proposed")));
  $("hazardInfo").replaceChildren(...Object.entries(E.HAZARD_INFO).map(([k, v]) => option(k, v, k === "live")));
  $("floor").replaceChildren(option("all", "All floors"), ...m.floors.map((f) => option(String(f), f === 0 ? "Ground floor" : `Floor ${f}`)));
  $("faSensor").replaceChildren(...m.sensors.map((s) => option(s.id, `${s.id} (${s.kind}) · ${m.nodes[s.node].id}`)));
  const fire = m.scenarios.map((s, i) => [s, i]).filter(([s]) => s.origin !== null);
  $("cmpScenario").replaceChildren(...fire.map(([s, i]) => option(String(i), s.name)));
  $("cmpMethods").innerHTML = Object.entries(E.METHODS).map(([k, v]) => `<label><input type="checkbox" data-method="${k}" checked><span class="method-dot" style="background:${METHOD_COLOUR[k]}"></span>${esc(v.short)}</label>`).join("");
  const drills = m.scenarios.map((s, i) => [s, i]).filter(([s]) => s.origin === null);
  $("drillScenario").replaceChildren(...drills.map(([s, i]) => option(String(i), s.name)));
  $("scOrigin").replaceChildren(...m.nodes.filter((n) => n.type !== "exit" && !n.protected).map((n) => option(n.id, `${n.id} (${n.floor === 0 ? "ground" : `floor ${n.floor}`})`)));
}

function buildAll() {
  S.model = E.buildModel(S.data, S.params);
  S.lines = S.model.edges.map((e) => edgePolyline(S.model, e));
  fillSelects();
  if (S.plan) S.plan.dispose();
  S.plan = createPlan2D($("view2d"), S.model, { onHover: hoverPlace });
  S.plan.setLayers(S.layers);
  if (S.view3d) {
    S.view3d.dispose();
    S.view3d = null;
  }
  if (S.view === "3d") ensure3D();
  renderData();
  renderParams();
  resetSim();
  syncWorker().catch((err) => showError(`Background runs are unavailable: ${err.message}`));
}

function simOptions() {
  return {
    method: $("method").value,
    info: $("info").value,
    hazardInfo: $("hazardInfo").value,
    strategy: $("strategy").value,
    confirm: $("confirm").value,
    seed: Math.max(1, Math.min(99999, Math.round(Number($("seed").value) || 1))),
    params: S.params,
    cameraCounts: S.cameraCounts ?? undefined,
  };
}

function resetSim() {
  const scenario = S.model.scenarios[Number($("scenario").value) || 0];
  $("scenarioNote").textContent = scenario.note;
  S.sim = E.createSimulation(S.model, scenario, simOptions());
  S.sim.step();
  S.playing = false;
  $("play").textContent = "Start";
  S.acc = 0;
  S.snap = S.sim.snapshot();
  S.curPos = placePeople(S.model, S.snap, S.lines);
  S.prevPos = S.curPos;
  S.lastPlanVersion = -1;
  $("loop").dataset.every = `repeats every ${S.sim.p.replan_s} s`;
  draw(1);
  renderPanel(true);
  renderPageNow();
}

function showError(msg) {
  const e = $("loadError");
  e.textContent = msg;
  e.hidden = false;
}

// ------------------------------------------------------------------ live loop
function stepSim() {
  if (S.sim.done) return false;
  S.sim.step();
  S.snap = S.sim.snapshot();
  S.prevPos = S.curPos;
  S.curPos = placePeople(S.model, S.snap, S.lines);
  return true;
}

function interpolated(alpha) {
  if (alpha >= 1) return S.curPos;
  const out = new Map();
  for (const [id, p] of S.curPos) {
    const q = S.prevPos.get(id);
    if (!q || Math.abs(q[2] - p[2]) > 1.5) out.set(id, p);
    else out.set(id, [q[0] + (p[0] - q[0]) * alpha, q[1] + (p[1] - q[1]) * alpha, q[2] + (p[2] - q[2]) * alpha]);
  }
  return out;
}

function draw(alpha) {
  const positions = interpolated(alpha);
  if (S.view === "2d") S.plan.update({ positions, snapshot: S.snap, closed: closedSet() });
  else if (S.view3d) {
    S.view3d.setHazards(S.layers.hazard ? S.snap.hazard : []);
    S.view3d.setPredicted(S.layers.predicted ? S.snap.predicted : [], S.snap.hazard);
    S.view3d.setRoutes(S.snap.routes, S.snap.teams);
    S.view3d.setRoutesVisible(S.layers.routes);
    S.view3d.setSigns(S.snap.signs);
    S.view3d.setSensors(S.snap.sensors);
    S.view3d.setPeople(positions, S.snap.people, null);
  }
}
let closedCache = null;
function closedSet() {
  const sc = S.sim.scenario;
  if (!closedCache || closedCache.sc !== sc) closedCache = { sc, set: new Set(sc.closed.map((c) => S.model.index.get(c))) };
  return closedCache.set;
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (S.playing && S.sim && !S.sim.done) {
    const speed = Number($("speed").value);
    S.acc += dt * speed;
    let steps = 0;
    while (S.acc >= 1 && steps < 120) {
      S.acc -= 1;
      steps++;
      if (!stepSim()) break;
    }
    if (S.sim.done) {
      S.playing = false;
      $("play").textContent = "Finished";
      renderPanel(true);
      renderPageNow();
    }
    draw(speed <= 5 ? Math.min(1, S.acc) : 1);
    if (now - S.lastPanel > 250) {
      S.lastPanel = now;
      renderPanel();
      if (S.page !== "live") renderPageNow();
    }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ panel
function renderPanel(force = false) {
  const sim = S.sim;
  if (!sim) return;
  const r = sim.summary();
  $("clock").textContent = fmtTime(sim.t);
  $("topClock").textContent = `t = ${sim.t} s`;
  const alarm = $("topAlarm");
  if (sim.alarmAt !== null) {
    alarm.classList.add("alarm");
    alarm.innerHTML = `<span class="dot"></span>Alarm at ${sim.alarmAt} s`;
    $("alarmText").textContent = `Alarm at ${fmtTime(sim.alarmAt)}: ${sim.alarmReason}`;
  } else {
    alarm.classList.remove("alarm");
    alarm.innerHTML = '<span class="dot"></span>No alarm';
    $("alarmText").textContent = sim.scenario.origin === null ? "Drill" : "No alarm yet";
  }
  const pct = (n) => `${(100 * n) / r.total}%`;
  $("barOut").style.width = pct(r.out);
  $("barRef").style.width = pct(r.refuge);
  $("barHarm").style.width = pct(r.harmed);
  $("barText").textContent = `${r.out} out, ${r.refuge} in refuges, ${r.harmed} reached by the hazard, of ${r.total} people`;
  const rows = [
    ["Safe (out or refuge)", `${r.safe} / ${r.total}`],
    ["T50 / T90", `${fmtS(r.t50)} / ${fmtS(r.t90)}`],
    ["Reached by hazard (FED ≥ 0.3)", r.harmed],
    ["Overcome (FED ≥ 1)", r.incapacitated],
    ["Highest dose (FED)", f2(r.maxFed)],
    ["Sheltering, no route", r.shelter],
    ["Waiting for staff", r.leftWaiting],
    ["Rescued by teams", r.rescued],
    ["Route changes / alternatives used", `${r.routeChanges} / ${r.alternativeSwitches}`],
  ];
  $("kv").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  // loop pulse on every new plan
  if (sim.planVersion !== S.lastPlanVersion) {
    S.lastPlanVersion = sim.planVersion;
    const loop = $("loop");
    loop.classList.remove("run");
    void loop.offsetWidth;
    loop.classList.add("run");
  }
  renderAlerts(force);
  const ev = sim.events.slice(-40).reverse();
  $("events").innerHTML = ev.length ? ev.map((e) => `<div class="k-${e.kind}"><span class="num">${fmtTime(e.t)}</span><span>${esc(e.message)}</span></div>`).join("") : '<p class="small muted">Nothing yet. Press Start.</p>';
}

let alertKey = "";
function renderAlerts(force) {
  const sim = S.sim;
  const key = sim.alerts.map((a) => a.id + a.status).join(",");
  const pending = sim.alerts.filter((a) => a.status === "new");
  const banner = $("banner");
  if (pending.length && $("confirm").value === "manual") {
    banner.hidden = false;
    banner.innerHTML = `<span>${pending.length} sensor alert${pending.length > 1 ? "s" : ""} wait for your decision</span><span class="row"><button class="btn" data-all="confirm">Confirm all</button><button class="btn" data-all="dismiss">Dismiss all</button></span>`;
  } else banner.hidden = true;
  if (key === alertKey && !force) return;
  alertKey = key;
  const m = S.model;
  $("alerts").innerHTML = sim.alerts.length
    ? [...sim.alerts].reverse().slice(0, 30).map((a) => `<div class="alert ${a.status}"><div><b>${esc(a.kind)}</b> sensor ${esc(a.sensor)} at ${esc(m.nodes[a.node].id)} <span class="muted num">${fmtTime(a.t)}</span></div>${a.status === "new" ? `<div class="row"><button class="btn" data-confirm="${a.id}">Confirm</button><button class="btn danger" data-dismiss="${a.id}">Dismiss</button>${a.autoAt !== null ? `<span class="small muted">automatic at ${fmtTime(a.autoAt)}</span>` : ""}</div>` : `<div class="small muted">${a.status === "confirmed" ? "Confirmed" : "Dismissed"} at ${fmtTime(a.decidedAt)}</div>`}</div>`).join("")
    : '<p class="small muted">No sensor has detected anything.</p>';
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b || !S.sim) return;
  if (b.dataset.confirm) S.sim.confirm(Number(b.dataset.confirm));
  else if (b.dataset.dismiss) S.sim.dismiss(Number(b.dataset.dismiss));
  else if (b.dataset.all) for (const a of S.sim.alerts.filter((x) => x.status === "new")) (b.dataset.all === "confirm" ? S.sim.confirm : S.sim.dismiss)(a.id);
  else return;
  renderPanel(true);
});

function hoverPlace(n, ev) {
  const tip = $("placeTip");
  if (!n || !S.sim) {
    tip.hidden = true;
    return;
  }
  const sim = S.sim;
  const h = S.snap.hazard.find((x) => x.n === n.i);
  const pic = sim.picture;
  const pred = pic && Number.isFinite(pic.arrival[n.i]) ? pic.arrival[n.i] - sim.t : null;
  const here = S.snap.people.filter((p) => p.node === n.i && p.edge === undefined).length;
  const lines = [
    `<b>${esc(n.id)}</b> <span style="opacity:.75">${esc(n.type)}${n.refuge ? ", refuge" : ""}${n.protected ? ", protected" : ""}</span>`,
    `Area ${Math.round(n.area)} m², room for ${n.capacity}`,
    h ? (h.fire ? "Burning" : `Smoke now: ${Math.round(h.smoke * 100)}% of the thickest`) : "No smoke now",
    pred === null ? "Planner expects no smoke" : pred <= 0 ? "Planner: smoke already here" : `Planner: smoke in about ${Math.round(pred)} s`,
    `Planner risk ${f2(sim.plannerRisk(n.i))} (filter at ${sim.p.theta})`,
    `${here} people here`,
  ];
  tip.innerHTML = lines.join("<br>");
  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - 270, ev.clientX + 14)}px`;
  tip.style.top = `${Math.min(window.innerHeight - 140, ev.clientY + 14)}px`;
}

// ------------------------------------------------------------------ 3D
async function ensure3D() {
  if (S.view3d) return true;
  try {
    const { createView3D } = await import("./view3d.js");
    $("view3d").replaceChildren();
    S.view3d = createView3D($("view3d"), S.model);
    S.view3d.setFloor(S.floor);
    return true;
  } catch (err) {
    showError(`The 3D view could not start (${err.message}). The 2D plan still works.`);
    return false;
  }
}

// ------------------------------------------------------------------ pages
function renderPageNow() {
  if (S.page === "signs") renderSigns();
  else if (S.page === "sensors") renderSensors();
  else if (S.page === "rescue") renderRescue();
}

function arrowSvg(n, next) {
  const m = S.model;
  const a = m.nodes[n];
  const b = m.nodes[next];
  if (a.floor !== b.floor) {
    return `<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M6 27h7v-6h7v-6h8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/><path d="M17 6v11m-4-4 4 4 4-4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return `<svg viewBox="0 0 34 34" aria-hidden="true"><g transform="rotate(${ang.toFixed(0)} 17 17)"><path d="M6 17h20m-7-7 7 7-7 7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

function renderSigns() {
  const sim = S.sim;
  const m = S.model;
  const signs = S.snap.signs;
  const ok = signs.filter((s) => s.next >= 0).length;
  const nogo = signs.filter((s) => s.next < 0 && !s.failed).length;
  const failed = signs.filter((s) => s.failed).length;
  const g = {};
  for (const a of sim.agents) if (a.kind !== "rescue") g[a.guidance] = (g[a.guidance] ?? 0) + 1;
  $("signStats").innerHTML = [
    ["Signs showing a way", ok],
    ["Showing no safe way", nogo],
    ["Not working", failed],
    ["Sign changes so far", sim.signChanges],
    ["Phone messages sent", sim.messages],
    ["Guided by radio or phone", (g.radio ?? 0) + (g.phone ?? 0)],
    ["Signs only / not following guidance", `${g.signs ?? 0} / ${g.none ?? 0}`],
  ].map(([k, v]) => `<div class="stat"><span class="lab">${esc(k)}</span><span class="big">${esc(v)}</span></div>`).join("");
  const byFloor = new Map();
  for (const s of signs) {
    const f = m.nodes[s.n].floor;
    if (!byFloor.has(f)) byFloor.set(f, []);
    byFloor.get(f).push(s);
  }
  $("signFloors").innerHTML = [...byFloor.entries()].sort((a, b) => b[0] - a[0]).map(([f, list]) => `<div class="card"><h3>${f === 0 ? "Ground floor" : `Floor ${f}`}</h3><div class="signs">${list.map((s) => {
    const where = esc(m.nodes[s.n].id.replace(/^(G|\d) /, ""));
    const recent = sim.t - s.changedAt < 15 && s.changedAt > 1;
    if (s.failed) return `<div class="sign failed"><svg viewBox="0 0 34 34" aria-hidden="true"><path d="M8 17h18" stroke="#34433C" stroke-width="3" stroke-linecap="round"/></svg><div><div class="where">${where}</div><div class="to">Not working</div></div></div>`;
    if (s.next < 0) return `<div class="sign nogo ${recent ? "changed" : ""}"><svg viewBox="0 0 34 34" aria-hidden="true"><path d="M10 10l14 14M24 10 10 24" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg><div><div class="where">${where}</div><div class="to">No safe way</div></div></div>`;
    const nx = m.nodes[s.next];
    return `<div class="sign ${recent ? "changed" : ""}">${arrowSvg(s.n, s.next)}<div><div class="where">${where}</div><div class="to">${esc(nx.type === "exit" ? `Exit: ${nx.id}` : nx.id.replace(/^(G|\d) /, ""))}</div></div></div>`;
  }).join("")}</div></div>`).join("");
}

function renderSensors() {
  const sim = S.sim;
  const m = S.model;
  const pic = sim.picture;
  const truth = sim.truth;
  const last = sim.estimates[sim.estimates.length - 1];
  const items = [];
  if (truth.none) items.push(["Hazard", "None in this scenario", "A drill: there is nothing to estimate."]);
  else {
    items.push(["Estimated fire origin", pic ? m.nodes[pic.origin].id : "Waiting for a detection", `Real origin: ${m.nodes[truth.origin].id}${last && last.originError !== null ? ` · ${Math.round(last.originError)} m apart (spread distance)` : ""}`]);
    items.push(["Estimated smoke spread speed", pic && pic.rate ? `${pic.rate.toFixed(3)} m/s` : "–", `Real speed in this run: ${truth.smokeRate.toFixed(3)} m/s (design value ${sim.scenario.smokeRate} m/s)`]);
    items.push(["Arrival-time error now", last && last.mae !== null ? `${Math.round(last.mae)} s` : "–", `Hazard picture used: ${E.HAZARD_INFO[sim.hazardInfo]}`]);
  }
  const st = {};
  for (const s of sim.net.sensors) st[s.status] = (st[s.status] ?? 0) + 1;
  items.push(["Sensor health check", `${st.ok ?? 0} OK`, `${st["no data"] ?? 0} no data · ${st.stuck ?? 0} stuck · ${st.burnt ?? 0} burnt out · ${sim.reports.length} phone reports`]);
  if (pic && pic.outliers && pic.outliers.length) items.push(["Readings left out of the fit", pic.outliers.length, pic.outliers.map((n) => m.nodes[n].id).join(", ")]);
  $("estStats").innerHTML = items.map(([k, v, sub]) => `<div class="card stat"><span class="lab">${esc(k)}</span><span class="big" style="font-size:20px">${esc(v)}</span><span class="small muted">${esc(sub)}</span></div>`).join("");

  const mae = sim.estimates.filter((e) => e.mae !== null).map((e) => [e.t, e.mae]);
  lineChart($("chartMae"), { series: [{ name: "Error", color: "#0B7A4B", points: mae }], xLabel: "Time (s)", yLabel: "Error (s)", xName: "t =", xFmt: (v) => `${v}`, yFmt: (v) => `${Math.round(v)} s`, empty: truth.none ? "No hazard in this scenario." : "Appears after the first detection." });
  const pts = [];
  if (pic && !truth.none) {
    for (const n of m.nodes) {
      if (n.protected || n.type === "exit") continue;
      const a = truth.smokeArr[n.i];
      const b = pic.arrival[n.i];
      if (Number.isFinite(a) && Number.isFinite(b) && a <= 1500 && b <= 1500) pts.push({ x: a, y: Math.max(0, b), label: n.id });
    }
  }
  scatter($("chartScatter"), { points: pts, xLabel: "Real arrival (s)", yLabel: "Predicted (s)", xName: "Real", yName: "Predicted", diag: true, empty: truth.none ? "No hazard in this scenario." : "Appears after the first detection." });

  const filter = $("sensorFilter").value;
  const rows = sim.net.sensors.filter((s) => filter === "all" || (filter === "detected" && s.detectedAt !== null) || (filter === "problem" && s.status !== "ok") || (filter === "fault" && s.fault !== "ok"));
  const faultLabel = { ok: "", dead: "Dead", stuck: "Stuck", biased: "Reads too high", flaky: "Loses readings" };
  $("sensorTable").innerHTML = `<thead><tr><th>Sensor</th><th>Kind</th><th>Place</th><th>Health check</th><th class="n">Latest reading</th><th class="n">Detected at</th><th>Fault set in this run</th></tr></thead><tbody>${rows.slice(0, 200).map((s) => `<tr><td class="mono">${esc(s.id)}</td><td>${esc(s.kind)}</td><td>${esc(m.nodes[s.node].id)}</td><td><span class="pill ${s.status === "ok" ? "ok" : s.status === "burnt" ? "bad" : "warn"}">${esc(s.status)}</span></td><td class="n">${s.latest === null ? "–" : `${s.latest.toFixed(s.kind === "smoke" ? 3 : 1)} ${UNIT[s.kind]}`}</td><td class="n">${s.detectedAt === null ? "–" : fmtTime(s.detectedAt)}${sim.dismissedSensors.has(s.id) ? " (dismissed)" : ""}</td><td>${s.burnt ? "Burnt out" : esc(faultLabel[s.fault])}</td></tr>`).join("")}</tbody>`;
}

function renderRescue() {
  const sim = S.sim;
  const m = S.model;
  const teams = S.snap.teams;
  const arrive = sim.alarmAt === null ? null : sim.alarmAt + sim.p.rescue_arrival_s;
  if (!teams.length) {
    $("teams").innerHTML = `<p class="muted">${sim.truth.none ? "No fire in this scenario, so no fire brigade." : sim.alarmAt === null ? "The fire brigade is called when the alarm sounds." : `Expected at ${fmtTime(arrive)} (${sim.p.rescue_arrival_s} s after the alarm).`}</p>`;
  } else {
    $("teams").innerHTML = teams.map((t) => {
      const a = sim.agents[t.id];
      const target = t.target >= 0 ? sim.agents[t.target] : null;
      const label = t.state === "teamIdle" ? "Waiting for a task" : t.state === "teamGoing" ? `Going to ${target?.code} at ${m.nodes[target?.node]?.id}` : `Bringing ${target?.code} out`;
      return `<div class="team"><div class="row" style="justify-content:space-between"><b>${esc(t.code)}</b><span class="pill ${t.state === "teamIdle" ? "mute" : "bad"}">${esc(t.state === "teamIdle" ? "Idle" : t.state === "teamGoing" ? "Going in" : "Carrying out")}</span></div><div>${esc(label)}</div><div class="small muted">At ${esc(m.nodes[a.node].id)}${t.state === "teamGoing" && t.eta ? ` · about ${Math.max(0, Math.round(t.eta - sim.t))} s to go` : ""}</div>${t.route.length > 1 ? `<div class="route">Route: ${t.route.map((n) => esc(m.nodes[n].id)).join(" → ")}</div>` : ""}</div>`;
    }).join("");
  }
  const need = sim.agents.filter((x) => x.kind !== "rescue" && ["shelter", "incapacitated", "stuck", "needsHelp", "carried"].includes(x.state));
  $("needRescue").innerHTML = need.length
    ? `<thead><tr><th>Person</th><th>Place</th><th>State</th><th class="n">Dose (FED)</th><th>Team</th></tr></thead><tbody>${need.map((x) => `<tr><td class="mono">${esc(x.code)}</td><td>${esc(m.nodes[x.node].id)}</td><td>${esc(STATE_LABEL[x.state] ?? x.state)}${x.mobility !== "ambulatory" ? ` · ${esc(x.mobility)}` : ""}</td><td class="n">${f2(x.fed)}</td><td>${x.rescuedBy >= 0 ? esc(sim.agents[x.rescuedBy].code) : "–"}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="muted">Nobody needs rescue right now.</td></tr></tbody>';
}

// ------------------------------------------------------------------ compare
let cmpBusy = false;
async function runCompare() {
  if (cmpBusy) return;
  const idx = Number($("cmpScenario").value);
  const scenario = S.model.scenarios[idx];
  const methods = [...document.querySelectorAll("[data-method]")].filter((c) => c.checked).map((c) => c.dataset.method);
  const conds = [...document.querySelectorAll("[data-cond]")].filter((c) => c.checked).map((c) => c.dataset.cond);
  if (!methods.length || !conds.length) {
    $("cmpOut").innerHTML = '<p class="note">Choose at least one method and one kind of information.</p>';
    return;
  }
  const runs = Number($("cmpRuns").value);
  const seeds = Array.from({ length: runs }, (_, k) => 100 + k);
  const jobs = [];
  for (const c of conds) for (const mth of methods) jobs.push({ key: `${c}|${mth}`, scenario, options: { method: mth, info: c === "perfect" ? "perfect" : "realistic", hazardInfo: c === "perfect" ? "perfect" : c, strategy: $("strategy").value, params: S.params, cameraCounts: S.cameraCounts ?? undefined } });
  cmpBusy = true;
  $("cmpRun").disabled = true;
  $("cmpOut").innerHTML = "";
  try {
    const out = await job({ type: "runs", jobs, seeds }, (d, t) => {
      $("cmpProg").style.width = `${(100 * d) / t}%`;
      $("cmpProgText").textContent = `${d} of ${t} runs`;
    });
    renderCompare(scenario, conds, methods, out, runs);
  } catch (err) {
    $("cmpOut").innerHTML = `<p class="note">The comparison stopped: ${esc(err.message)}</p>`;
  } finally {
    cmpBusy = false;
    $("cmpRun").disabled = false;
  }
}

function renderCompare(scenario, conds, methods, out, runs) {
  const metricRows = E.METRICS;
  const cell = (st, k, d) => {
    const s = st[k];
    if (s.mean === null) return "–";
    return `${s.mean.toFixed(d)}${s.sd !== null ? ` <span class="muted">± ${s.sd.toFixed(d)}</span>` : ""}${s.n < runs ? ` <span class="muted">(${s.n}/${runs})</span>` : ""}`;
  };
  const dec = { t50: 0, t90: 0, lastSafe: 0, meanFed: 3, maxFed: 2, harmed: 1, incapacitated: 1, safe: 1 };
  // best per metric within each condition
  const bestOf = (c, k, lower) => {
    let best = null;
    for (const mth of methods) {
      const v = out[`${c}|${mth}`].stats[k].mean;
      if (v === null) continue;
      if (best === null || (lower ? v < best : v > best)) best = v;
    }
    return best;
  };
  const table = `<div class="card"><h3>${esc(scenario.name)} · ${runs} runs each</h3><div class="tbl"><table><thead><tr><th>Information</th><th>Method</th>${metricRows.map((mm) => `<th class="n">${esc(mm.label)}</th>`).join("")}</tr></thead><tbody>${conds.map((c) => methods.map((mth) => {
    const st = out[`${c}|${mth}`].stats;
    return `<tr><td>${esc(COND_LABEL[c])}</td><td><span class="method-dot" style="background:${METHOD_COLOUR[mth]}"></span>${esc(E.METHODS[mth].short)}</td>${metricRows.map((mm) => {
      const b = bestOf(c, mm.key, mm.lowerBetter);
      const vals = methods.map((x) => out[`${c}|${x}`].stats[mm.key].mean).filter((v) => v !== null);
      const allSame = vals.every((v) => Math.abs(v - vals[0]) < 1e-9);
      const isBest = !allSame && b !== null && st[mm.key].mean !== null && Math.abs(st[mm.key].mean - b) < 1e-9;
      return `<td class="n num"${isBest ? ' style="font-weight:600;color:var(--sign-dark)"' : ""}>${cell(st, mm.key, dec[mm.key])}</td>`;
    }).join("")}</tr>`;
  }).join("")).join("")}</tbody></table></div><p class="small muted" style="margin-top:8px">Best value in each information group in bold green (no highlight when all methods are equal). T50 and T90 count people reaching safety (outside or in a refuge); a dash in brackets means that share was not reached in some runs.</p></div>`;
  const charts = ["t90", "harmed", "meanFed"].map((k) => `<div class="card"><h3>${esc(metricRows.find((mm) => mm.key === k).label)}</h3><div id="cmpChart-${k}"></div></div>`).join("");
  const csvRows = [];
  for (const c of conds) for (const mth of methods) {
    const st = out[`${c}|${mth}`].stats;
    const row = { information: COND_LABEL[c], method: E.METHODS[mth].short, runs };
    for (const mm of metricRows) {
      row[`${mm.key}_mean`] = st[mm.key].mean === null ? "" : st[mm.key].mean.toFixed(4);
      row[`${mm.key}_sd`] = st[mm.key].sd === null ? "" : st[mm.key].sd.toFixed(4);
    }
    csvRows.push(row);
  }
  const csv = IO.toCsv(csvRows, Object.keys(csvRows[0]));
  $("cmpOut").innerHTML = `${table}<div class="grid3" style="margin-top:16px">${charts}</div><div class="card" style="margin-top:16px"><h3>Results as CSV</h3><div class="row" style="margin-bottom:8px"><button class="btn" id="copyCsv">Copy</button><span class="small muted" id="copyCsvMsg"></span></div><textarea rows="6" readonly id="csvText" aria-label="Results as CSV">${esc(csv)}</textarea></div>`;
  for (const k of ["t90", "harmed", "meanFed"]) {
    barChart($(`cmpChart-${k}`), {
      groups: conds.map((c) => COND_LABEL[c].replace("Realistic, ", "")),
      series: methods.map((mth) => ({ name: E.METHODS[mth].short, color: METHOD_COLOUR[mth], values: conds.map((c) => out[`${c}|${mth}`].stats[k]) })),
      fmt: (v) => (k === "meanFed" ? v.toFixed(3) : k === "harmed" ? v.toFixed(1) : `${Math.round(v)}`),
      yLabel: k === "t90" ? "seconds" : k === "harmed" ? "people" : "FED",
    });
  }
  $("copyCsv").onclick = () => copyText($("csvText"), $("copyCsvMsg"));
}

function copyText(area, msg) {
  const text = area.value;
  const done = () => (msg.textContent = "Copied");
  try {
    navigator.clipboard.writeText(text).then(done, () => {
      area.select();
      msg.textContent = "Selected: press Ctrl+C to copy";
    });
  } catch {
    area.select();
    msg.textContent = "Selected: press Ctrl+C to copy";
  }
}

// ------------------------------------------------------------------ drill
async function loadExampleDrill(file, scenarioName, label) {
  try {
    const text = await (await fetch(`examples/${file}`)).text();
    S.drill = { rows: IO.drillFromCsv(text), name: label, scenarioName };
    const idx = S.model.scenarios.findIndex((s) => s.name === scenarioName);
    if (idx >= 0) $("drillScenario").value = String(idx);
    $("drillName").textContent = `${label}: ${S.drill.rows.length} people`;
  } catch (err) {
    $("drillName").textContent = `Could not load: ${err.message}`;
  }
}

let drillBusy = false;
async function runDrill(paramsOverride = null, target = "drillOut", title = null) {
  if (!S.drill.rows) {
    $(target).innerHTML = '<p class="note">Load a drill record first.</p>';
    return null;
  }
  const scenario = S.model.scenarios[Number($("drillScenario").value)];
  const runs = Number($("drillRuns").value);
  const seeds = Array.from({ length: runs }, (_, k) => 1 + k);
  const options = { rescue: false, sensorFaults: false, strategy: "full", params: paramsOverride ?? S.params };
  const out = await job({ type: "runs", jobs: [{ key: "d", scenario, options }], seeds }, (d, t) => ($("drillProg").style.width = `${(100 * d) / t}%`));
  const cmp = E.compareWithDrill(S.drill.rows, out.d.results);
  renderDrill(cmp, target, title ?? `${S.drill.name} against "${scenario.name}" (${runs} runs)`);
  return cmp;
}

function renderDrill(cmp, target, title) {
  const o = cmp.observedStats;
  const s = cmp.simulatedStats;
  const groupName = { walk: "Walking patients and visitors", staff: "Staff", assisted: "Wheelchair and bed patients" };
  const id = `chart-${target}`;
  $(target).innerHTML = `<div class="card" style="margin-top:16px"><h3>${esc(title)}</h3>
    <div class="stats" style="margin-bottom:12px">
      ${[["T50", o.t50, s.t50, cmp.errors.t50], ["T90", o.t90, s.t90, cmp.errors.t90], ["Last out", o.last, s.last, cmp.errors.last]].map(([k, a, b, e]) => `<div class="stat"><span class="lab">${k}: drill / model</span><span class="big">${fmtS(a)} / ${fmtS(b)}</span><span class="small ${Math.abs(e) <= 10 ? "muted" : ""}" style="color:${Math.abs(e) > 10 ? "var(--hazard)" : ""}">${e === null ? "" : `${e > 0 ? "+" : ""}${e}%`}</span></div>`).join("")}
      <div class="stat"><span class="lab">Curve error (RMSE)</span><span class="big">${cmp.rmse} people</span><span class="small muted">${cmp.inside}% of the drill curve inside the range of runs</span></div>
      <div class="stat"><span class="lab">Fit by group (lower is better)</span><span class="big">${cmp.fit}%</span><span class="small muted">mean RMSE as % of each group</span></div>
    </div>
    <div class="grid2"><div><div id="${id}"></div></div><div class="tbl"><table><thead><tr><th>Group</th><th class="n">People</th><th class="n">RMSE</th><th class="n">% of group</th></tr></thead><tbody>${Object.entries(cmp.groups).map(([g, v]) => `<tr><td>${esc(groupName[g])}</td><td class="n">${v.people}</td><td class="n">${v.rmse}</td><td class="n">${v.percent}%</td></tr>`).join("") || '<tr><td colspan="4" class="muted">The record has no kind or mobility columns, so groups cannot be compared.</td></tr>'}</tbody></table>
    <table style="margin-top:12px"><thead><tr><th>Exit</th><th class="n">Drill</th><th class="n">Model (mean)</th></tr></thead><tbody>${cmp.exits.map((x) => `<tr><td>${esc(x.exit)}</td><td class="n">${x.observed}</td><td class="n">${x.simulated}</td></tr>`).join("")}</tbody></table></div></div></div>`;
  lineChart($(id), {
    series: [{ name: "Drill record", color: "#14231C", points: cmp.grid.map((t, i) => [t, cmp.observed[i]]) }, { name: "Model, mean of runs", color: "#0B7A4B", points: cmp.grid.map((t, i) => [t, cmp.mean[i]]) }],
    band: { low: cmp.grid.map((t, i) => [t, cmp.low[i]]), high: cmp.grid.map((t, i) => [t, cmp.high[i]]), color: "#0B7A4B", name: "Range of runs" },
    xLabel: "Time after the alarm (s)", yLabel: "People out", xName: "t =", yFmt: (v) => `${Math.round(v)}`,
  });
}

async function runCalibration() {
  if (!S.drill.rows) {
    $("calOut").innerHTML = '<p class="note">Load a drill record first.</p>';
    return;
  }
  const scenario = S.model.scenarios[Number($("drillScenario").value)];
  const grid = { speed: [0.8, 0.9, 1.0, 1.1, 1.2], delay: [0.75, 1.0, 1.25, 1.5] };
  const seeds = [1, 2, 3];
  $("calOut").innerHTML = `<p class="small muted" style="margin-top:12px">Running ${grid.speed.length * grid.delay.length * seeds.length} runs…</p>`;
  const options = { rescue: false, sensorFaults: false, strategy: "full", params: S.params };
  const cal = await job({ type: "calibrate", scenario, rows: S.drill.rows, options, grid, seeds }, (d, t) => ($("drillProg").style.width = `${(100 * d) / t}%`));
  S.calibration = { ...cal, fittedOn: S.drill.name, scenarioName: scenario.name };
  const other = S.drill.scenarioName === "Drill with the Main Entrance closed" ? ["drill-a-full.csv", "Evacuation drill (no hazard)", "Example drill A"] : ["drill-b-main-entrance-closed.csv", "Drill with the Main Entrance closed", "Example drill B"];
  $("calOut").innerHTML = `<div class="card" style="margin-top:16px"><h3>Calibration on ${esc(S.drill.name)}</h3>
    <div class="grid2"><div><div id="calMap"></div><p class="small muted">Each cell: fit by group (lower is better) for walking speeds and delays scaled by the numbers shown, ${seeds.length} runs per cell. The outlined cell is the best.</p></div>
    <div class="checks"><div class="stat"><span class="lab">Best pair</span><span class="big">speed ×${cal.best.speed}, delay ×${cal.best.delay}</span><span class="small muted">fit ${cal.best.fit}% · curve RMSE ${cal.best.rmse} people</span></div>
    <p class="small">Pairs within 15% of the best: ${cal.close.map((c) => `×${c.speed}/×${c.delay}`).join(", ")}.</p>
    <p class="note">Walking speed and delay can make up for each other, and runs differ a lot from seed to seed, so one drill rarely pins both down. Check the result on a second drill before using it.</p>
    <button class="btn primary" id="holdout">Check on ${esc(other[2])} (not used for fitting)</button></div></div></div><div id="holdOut"></div>`;
  heatmap($("calMap"), { cells: cal.tried.map((c) => ({ x: c.speed, y: c.delay, v: c.fit })), best: { x: cal.best.speed, y: cal.best.delay }, fmt: (v) => v.toFixed(1), xLabel: "Walking speed scale", yLabel: "Delay scale", xName: "speed", yName: "delay", vName: "fit %" });
  $("holdout").onclick = async () => {
    await loadExampleDrill(other[0], other[1], other[2]);
    $("holdOut").innerHTML = "";
    const before = await runDrill(null, "holdOut", `${other[2]} with the default values`);
    const tuned = E.scaledParams(S.params, cal.best.speed, cal.best.delay);
    const div = document.createElement("div");
    div.id = "holdOut2";
    $("holdOut").appendChild(div);
    const after = await runDrill(tuned, "holdOut2", `${other[2]} with the calibrated values (speed ×${cal.best.speed}, delay ×${cal.best.delay})`);
    const verdict = document.createElement("p");
    verdict.className = after.fit < before.fit ? "note info" : "note";
    verdict.style.marginTop = "12px";
    verdict.textContent = after.fit < before.fit ? `On the drill it was not fitted to, the calibrated values fit better: ${before.fit}% to ${after.fit}% (curve RMSE ${before.rmse} to ${after.rmse} people).` : `On the drill it was not fitted to, the calibrated values do not fit better (${before.fit}% to ${after.fit}%). Do not use them as they are.`;
    $("holdOut").prepend(verdict);
  };
}

// ------------------------------------------------------------------ replay
async function runReplay(text, label) {
  try {
    const rows = IO.readingsFromCsv(text);
    const rate = Math.max(0.01, Math.min(1, Number($("replayRate").value) || 0.08));
    const r = E.replayReadings(S.model, rows, S.params, { designRate: rate });
    const m = S.model;
    const last = [...r.checks].reverse().find((c) => c.origin !== null);
    const out = $("replayOut");
    out.innerHTML = `<div class="stats" style="margin-bottom:10px"><div class="stat"><span class="lab">File</span><span class="big" style="font-size:16px">${esc(label)}</span><span class="small muted">${rows.length} readings, ${r.detections.length} detections${r.unknown.length ? `, ${r.unknown.length} unknown sensor names ignored` : ""}</span></div><div class="stat"><span class="lab">Estimated origin (last)</span><span class="big" style="font-size:20px">${last ? esc(m.nodes[last.origin].id) : "–"}</span></div><div class="stat"><span class="lab">Estimated spread speed (last)</span><span class="big" style="font-size:20px">${last ? `${last.rate.toFixed(3)} m/s` : "–"}</span></div></div><div id="replayChart"></div>`;
    lineChart($("replayChart"), { series: [{ name: "Estimated speed", color: "#0B7A4B", points: r.checks.filter((c) => c.rate !== null).map((c) => [c.t, c.rate]) }, { name: "Design speed (prior)", color: "#63726B", dash: "4 4", points: r.checks.filter((c) => c.rate !== null).map((c) => [c.t, rate]) }], xLabel: "Time in the recording (s)", yLabel: "m/s", xName: "t =", yFmt: (v) => v.toFixed(3), empty: "No sensor in the file passed its alarm level." });
  } catch (err) {
    $("replayOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ data
function renderData() {
  const m = S.model;
  const mob = {};
  for (const p of m.people) mob[p.kind === "staff" ? "staff" : p.mobility] = (mob[p.kind === "staff" ? "staff" : p.mobility] ?? 0) + 1;
  const visitors = m.cameras.reduce((s, c) => s + (S.cameraCounts?.[c.id] ?? c.count), 0);
  const kinds = {};
  for (const s of m.sensors) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  $("dataStats").innerHTML = [
    ["Building", m.name],
    ["Floors / places / paths", `${m.floors.length} / ${m.nodes.length} / ${m.edges.filter((e) => !e.virtual).length}`],
    ["Exits / refuges / signs", `${m.exits.length} / ${m.refuges.length} / ${m.nodes.filter((n) => n.sign).length}`],
    ["Patients", `${(mob.ambulatory ?? 0)} walking, ${mob.wheelchair ?? 0} wheelchair, ${(mob.stretcher ?? 0) + (mob.ventilator ?? 0)} bed`],
    ["Staff / visitors (cameras)", `${mob.staff ?? 0} / ${visitors}`],
    ["Sensors", Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ")],
  ].map(([k, v]) => `<div class="stat"><span class="lab">${esc(k)}</span><span class="big" style="font-size:16px">${esc(v)}</span></div>`).join("");
  $("bldText").value = JSON.stringify(S.data, null, 1);
}

// ------------------------------------------------------------------ parameters
function renderParams() {
  const groups = new Map();
  for (const p of E.PARAMS) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  const kindLabel = { sourced: "Sourced", derived: "Derived", assumed: "Assumed", policy: "Planner setting" };
  $("paramGroups").innerHTML = [...groups.entries()].map(([g, list]) => `<div class="card"><h3>${esc(g)}</h3><div class="tbl"><table><tbody>${list.map((p) => `<tr><td>${esc(p.label)}<div class="small muted">${esc(E.SOURCES[p.source].short)}</div></td><td style="width:110px"><input type="number" step="any" id="p-${p.key}" data-key="${p.key}" value="${S.params[p.key] ?? p.value}" aria-label="${esc(p.label)}"></td><td class="small muted" style="white-space:nowrap">${esc(p.unit)}</td><td><span class="pill k-${p.kind}">${kindLabel[p.kind]}</span></td></tr>`).join("")}</tbody></table></div></div>`).join("");
  $("sourceList").innerHTML = Object.entries(E.SOURCES).map(([k, s]) => `<div><b>${esc(s.short)}</b>: ${esc(s.full)} ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Open</a>` : ""}</div>`).join("");
}

// ------------------------------------------------------------------ events
function wire() {
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => openPage(b.dataset.page));
  }
  $("play").addEventListener("click", () => {
    if (S.sim.done) return;
    S.playing = !S.playing;
    $("play").textContent = S.playing ? "Pause" : "Continue";
    lastFrame = performance.now();
  });
  $("stepBtn").addEventListener("click", () => {
    for (let k = 0; k < 10; k++) stepSim();
    draw(1);
    renderPanel(true);
    renderPageNow();
  });
  $("reset").addEventListener("click", resetSim);
  for (const id of ["scenario", "method", "info", "hazardInfo", "strategy", "confirm", "seed"]) $(id).addEventListener("change", resetSim);
  $("info").addEventListener("change", () => ($("hazardInfo").disabled = $("info").value === "perfect"));
  $("faBtn").addEventListener("click", () => {
    S.sim.injectFalseAlarm($("faSensor").value);
    $("faBtn").textContent = "Done: watch the alerts";
    setTimeout(() => ($("faBtn").textContent = "Make it fire now"), 2500);
  });
  $("v2d").addEventListener("click", () => setView("2d"));
  $("v3d").addEventListener("click", () => setView("3d"));
  $("floor").addEventListener("change", () => {
    S.floor = $("floor").value === "all" ? null : Number($("floor").value);
    S.plan.setFloor(S.floor);
    if (S.view3d) S.view3d.setFloor(S.floor);
    draw(1);
  });
  for (const c of document.querySelectorAll("[data-layer]")) {
    c.addEventListener("change", () => {
      S.layers[c.dataset.layer] = c.checked;
      S.plan.setLayers(S.layers);
      draw(1);
    });
  }
  $("sensorFilter").addEventListener("change", renderSensors);
  $("cmpRun").addEventListener("click", runCompare);
  $("drillA").addEventListener("click", () => loadExampleDrill("drill-a-full.csv", "Evacuation drill (no hazard)", "Example drill A"));
  $("drillB").addEventListener("click", () => loadExampleDrill("drill-b-main-entrance-closed.csv", "Drill with the Main Entrance closed", "Example drill B"));
  $("drillFile").addEventListener("change", async () => {
    const f = $("drillFile").files[0];
    if (!f) return;
    try {
      if (f.size > IO.MAX_FILE_BYTES) throw new Error("The file is larger than 2 MB");
      S.drill = { rows: IO.drillFromCsv(await f.text()), name: f.name, scenarioName: null };
      $("drillName").textContent = `${f.name}: ${S.drill.rows.length} people`;
    } catch (err) {
      $("drillName").textContent = err.message;
    }
  });
  $("drillRun").addEventListener("click", async () => {
    if (drillBusy) return;
    drillBusy = true;
    try {
      await runDrill();
    } catch (err) {
      $("drillOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
    } finally {
      drillBusy = false;
    }
  });
  $("calRun").addEventListener("click", async () => {
    if (drillBusy) return;
    drillBusy = true;
    $("calRun").disabled = true;
    try {
      await runCalibration();
    } catch (err) {
      $("calOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
    } finally {
      drillBusy = false;
      $("calRun").disabled = false;
    }
  });
  $("replayExample").addEventListener("click", async () => {
    try {
      const text = await (await fetch("examples/sensor-readings-kitchen.csv")).text();
      runReplay(text, "Example: kitchen fire recording");
    } catch (err) {
      $("replayOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
    }
  });
  $("replayFile").addEventListener("change", async () => {
    const f = $("replayFile").files[0];
    if (f) runReplay(await f.text(), f.name);
  });
  $("bldFile").addEventListener("change", async () => {
    const f = $("bldFile").files[0];
    if (!f) return;
    try {
      const data = IO.buildingFromJson(await f.text());
      E.buildModel(data, S.params);
      S.data = data;
      S.cameraCounts = null;
      buildAll();
      $("dataMsg").textContent = `Loaded ${f.name}.`;
    } catch (err) {
      $("dataMsg").textContent = `Not loaded: ${err.message}`;
    }
  });
  $("bldExample").addEventListener("click", async () => {
    await loadExample();
    $("dataMsg").textContent = "Back to the example hospital.";
  });
  $("camFile").addEventListener("change", async () => {
    const f = $("camFile").files[0];
    if (!f) return;
    try {
      const counts = IO.cameraCountsFromCsv(await f.text());
      const known = new Set(S.model.cameras.map((c) => c.id));
      const unknown = Object.keys(counts).filter((k) => !known.has(k));
      S.cameraCounts = counts;
      $("camText").textContent = `${f.name}: ${Object.keys(counts).length - unknown.length} cameras${unknown.length ? `, unknown ignored: ${unknown.join(", ")}` : ""}`;
      renderData();
      resetSim();
    } catch (err) {
      $("camText").textContent = err.message;
    }
  });
  $("scAdd").addEventListener("click", () => {
    const raw = { name: $("scName").value, origin: $("scOrigin").value, smokeRate: Number($("scSmoke").value), fireRate: Number($("scFire").value), alarm: $("scAlarm").value, note: "Added on this page." };
    try {
      E.normaliseScenario(raw, S.model.index);
      if (S.data.scenarios.some((s) => s.name === raw.name)) throw new Error(`A scenario called "${raw.name}" exists already`);
      S.data = { ...S.data, scenarios: [...S.data.scenarios, raw] };
      buildAll();
      $("scenario").value = String(S.model.scenarios.length - 1);
      resetSim();
      $("dataMsg").textContent = `Added "${raw.name}". It is selected on the Live run page.`;
    } catch (err) {
      $("dataMsg").textContent = `Not added: ${err.message}`;
    }
  });
  $("copyBld").addEventListener("click", () => copyText($("bldText"), $("copyMsg")));
  $("pApply").addEventListener("click", () => {
    const next = {};
    const bad = [];
    for (const input of document.querySelectorAll("[data-key]")) {
      const p = E.PARAMS.find((x) => x.key === input.dataset.key);
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0) bad.push(p.label);
      else if (v !== p.value) next[p.key] = v;
    }
    if (bad.length) {
      showError(`These values must be numbers of 0 or more: ${bad.join("; ")}`);
      return;
    }
    $("loadError").hidden = true;
    S.params = next;
    buildAll();
    openPage("live");
  });
  $("pReset").addEventListener("click", () => {
    S.params = {};
    buildAll();
  });
  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if (h && document.querySelector(`.page[data-page="${h}"]`)) openPage(h, false);
  });
}

async function setView(v) {
  S.view = v;
  $("v2d").setAttribute("aria-pressed", String(v === "2d"));
  $("v3d").setAttribute("aria-pressed", String(v === "3d"));
  $("view2d").hidden = v !== "2d";
  $("view3d").hidden = v !== "3d";
  if (v === "3d" && !(await ensure3D())) {
    setView("2d");
    return;
  }
  draw(1);
}

function openPage(page, setHash = true) {
  S.page = page;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.page === page));
  for (const p of document.querySelectorAll(".page")) p.hidden = p.dataset.page !== page;
  if (setHash) {
    try {
      history.replaceState(null, "", `#${page}`);
    } catch {
      /* not allowed in some frames */
    }
  }
  renderPageNow();
  if (page === "live") draw(1);
}

async function loadExample() {
  const res = await fetch("examples/hospital.json");
  if (!res.ok) throw new Error(`examples/hospital.json: ${res.status}`);
  S.data = IO.buildingFromJson(await res.text());
  S.cameraCounts = null;
  buildAll();
}

async function main() {
  wire();
  try {
    await loadExample();
  } catch (err) {
    showError(`The example hospital could not be loaded (${err.message}). Open the page through a web server; see the README.`);
    return;
  }
  const h = location.hash.slice(1);
  if (h && document.querySelector(`.page[data-page="${h}"]`)) openPage(h, false);
  requestAnimationFrame(frame);
}

main();
