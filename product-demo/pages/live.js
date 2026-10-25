// Live Simulation: the four-layer loop running in 2D and 3D, with sensors,
// smart exit signs, rescue teams, commander alerts and new hazards during the run.
import { esc, fmtTime, fmtS, f2, floorName, option, toast } from "../ui.js";
import { createPlan2D } from "../plan2d.js";
import { placePeople, edgePolyline } from "../layout.js";
import { lineChart, scatter } from "../charts.js";
import { METHOD_LABEL, ALGO_LABEL, optionsFor, methodName, runFeatures } from "./shared.js";

const UNIT = { smoke: "1/m", heat: "°C", co: "ppm" };
const STATE_LABEL = {
  waiting: "Not moving yet", needsHelp: "Waiting for staff", prep: "Being prepared", moving: "Moving", stuck: "No route yet",
  shelter: "Sheltering", incapacitated: "Overcome by smoke", out: "Out", refuge: "In a refuge", lift: "Using the lift",
  toPatient: "Going to a patient", escorting: "Escorting", free: "Free", carried: "Being carried",
};
const FAULT_LABEL = { ok: "", dead: "Dead", stuck: "Stuck", biased: "Reads too high", flaky: "Loses readings" };

let L = null; // the page state while it is open
let rafId = 0;

export function leave() {
  if (!L) return;
  cancelAnimationFrame(rafId);
  L.playing = false;
  if (L.view3d) L.view3d.dispose();
  if (L.plan) L.plan.dispose();
  L.view3d = null;
  L.plan = null;
  const tip = document.getElementById("placeTip");
  if (tip) tip.hidden = true;
}

export function render(main, ctx) {
  const s = ctx.store;
  const model = ctx.model();
  // Keep the run when the person visits another page and comes back.
  const keep = ctx.live && ctx.live.model === model ? ctx.live : null;
  L = keep ?? {
    model,
    lines: model.edges.map((e) => edgePolyline(model, e)),
    cache: new Map(),
    sc: 0,
    opts: { method: "proposed", algorithm: "dijkstra", info: "realistic", hazardInfo: "live", strategy: "horizontal", confirm: "auto", seed: 1 },
    speed: 5,
    view: "2d",
    floor: 3,
    layers: { hazard: true, predicted: true, routes: true, signs: true, sensors: false, density: false, labels: true, furniture: true },
    exploded: true,
    labels3d: true,
    outer: true,
    tab: "situation",
    sim: null,
  };
  L.pause = () => (L.playing = false);
  ctx.live = L;
  if (ctx.pending.scenario !== undefined) {
    L.sc = Math.max(0, Math.min(model.scenarios.length - 1, ctx.pending.scenario));
    L.floor = model.scenarios[L.sc].origin ? model.nodes[model.index.get(model.scenarios[L.sc].origin)].floor : 0;
    delete ctx.pending.scenario;
    L.sim = null;
  }
  L.blockMode = false;

  const raw = () => s.data().scenarios[L.sc];
  const sensorOptions = model.sensors.map((x) => option(x.id, `${x.id} (${x.kind}) · ${model.nodes[x.node].id}`)).join("");

  main.innerHTML = `<div class="page-head"><div><h1>Live Simulation</h1><p class="sub">The fire, the sensors and every person, second by second. The plan is made again every 10 seconds: <b>Sensing</b> (readings), <b>Situation</b> (where the smoke is and will be), <b>Decision</b> (routes), <b>Guidance</b> (signs and messages).</p></div></div>
  <div class="live">
    <div class="card controls" id="lvCtl">
      <label class="f">Scenario<select id="lvSc">${model.scenarios.map((x, i) => option(i, x.name, i === L.sc)).join("")}</select></label>
      <p class="small muted" id="lvNote"></p>
      <label class="f">Routing method<select id="lvMethod">${Object.entries(METHOD_LABEL).map(([k, v]) => option(k, v, k === L.opts.method)).join("")}</select></label>
      <label class="f" id="lvAlgoBox">Algorithm of the static plan<select id="lvAlgo">${Object.entries(ALGO_LABEL).map(([k, v]) => option(k, v, k === L.opts.algorithm)).join("")}</select></label>
      <details class="small"><summary>Information and behaviour</summary>
        <div class="stack" style="margin-top:8px">
          <label class="f">Information<select id="lvInfo">${option("realistic", "Realistic (faults, phones, compliance)", L.opts.info === "realistic")}${option("perfect", "Perfect (upper bound)", L.opts.info === "perfect")}</select></label>
          <label class="f">Hazard picture<select id="lvHaz">${Object.entries(ctx.E.HAZARD_INFO).map(([k, v]) => option(k, v, k === L.opts.hazardInfo)).join("")}</select></label>
          <label class="f">Strategy<select id="lvStrat">${option("horizontal", "Move beds sideways to a refuge first", L.opts.strategy === "horizontal")}${option("full", "Take everyone out of the building", L.opts.strategy === "full")}</select></label>
          <label class="f">Sensor alerts<select id="lvConf">${option("auto", "Confirmed automatically after 20 s", L.opts.confirm === "auto")}${option("manual", "The commander confirms each alert", L.opts.confirm === "manual")}</select></label>
          <label class="f">Run number (seed)<input type="number" id="lvSeed" min="1" max="99999" value="${L.opts.seed}"></label>
        </div>
      </details>
      <label class="f">Speed<select id="lvSpeed">${[1, 2, 5, 10, 30, 60].map((v) => option(v, `${v}×`, v === L.speed)).join("")}</select></label>
      <div class="row"><button class="btn primary" id="lvPlay">Start</button><button class="btn" id="lvStep">+10 s</button><button class="btn" id="lvReset">Restart</button></div>
      <details class="small"><summary>Test: a false alarm</summary>
        <div class="stack" style="margin-top:8px"><select id="lvFaS" aria-label="Sensor for the false alarm">${sensorOptions}</select><button class="btn" id="lvFa">Make it fire now</button><span class="muted">One reading jumps above the alarm level. A single sensor is checked before the whole picture changes.</span></div>
      </details>
      <button class="btn" id="lvBlock" aria-pressed="false">Block a place now</button>
      <p class="small muted" id="lvBlockHint">A new hazard during the run: click a place on the 2D plan and routes are planned again around it.</p>
    </div>
    <div class="card stage">
      <div class="stage-bar">
        <div class="seg" role="group" aria-label="View"><button id="lv2" aria-pressed="${L.view === "2d"}">2D plan</button><button id="lv3" aria-pressed="${L.view === "3d"}">3D building</button></div>
        <select id="lvFloor" aria-label="Floor" style="width:auto">${option("all", "All floors", L.floor === null)}${model.floors.map((f) => option(f, floorName(f), f === L.floor)).join("")}</select>
        <div class="toggles">${[["hazard", "Smoke"], ["predicted", "Forecast"], ["routes", "Routes"], ["signs", "Signs"], ["sensors", "Sensors"], ["density", "Crowding"]].map(([k, v]) => `<label><input type="checkbox" data-layer="${k}" ${L.layers[k] ? "checked" : ""}>${v}</label>`).join("")}</div>
      </div>
      <div class="view">
        <div class="layer" id="lvV2" ${L.view === "2d" ? "" : "hidden"}></div>
        <div class="layer" id="lvV3" ${L.view === "3d" ? "" : "hidden"}></div>
        <div class="banner" id="lvBanner" hidden></div>
        <div class="view-tools" id="lvTools3" ${L.view === "3d" ? "" : "hidden"}>
          <button class="btn sm" id="lvTour">Camera tour</button>
          <button class="btn sm" id="lvFire">Go to the fire</button>
          <button class="btn sm" id="lvExpl" aria-pressed="${L.exploded}">Floors apart</button>
          <button class="btn sm" id="lvLab" aria-pressed="${L.labels3d}">Labels</button>
          <button class="btn sm" id="lvOut" aria-pressed="${L.outer}">Outside</button>
          <button class="btn sm" id="lvCam">Reset view</button>
        </div>
      </div>
      <div class="legend-bar">
        <span><i class="sw" style="background:#2E8B9A"></i>Staff</span><span><i class="sw" style="background:#9CC9E8"></i>Walking patient</span><span><i class="sw" style="background:#EDA100"></i>Wheelchair</span><span><i class="sw bed" style="background:#6250D6"></i>Bed or ventilator</span><span><i class="sw" style="background:#8E9AAF"></i>Visitor</span><span><i class="sw" style="background:#D4A017"></i>Fire brigade</span><span><i class="sw sq" style="background:rgba(120,120,120,.5)"></i>Smoke</span><span><i class="sw dash"></i>Smoke forecast</span><span><i class="sw line" style="background:#0B7A4B"></i>Route</span>
      </div>
    </div>
    <div class="card" id="lvPanel">
      <div class="tabs-in" role="tablist">${[["situation", "Situation"], ["sensors", "Sensors"], ["signs", "Signs"], ["rescue", "Rescue"]].map(([k, v]) => `<button role="tab" data-tab="${k}" aria-selected="${L.tab === k}">${v}</button>`).join("")}</div>
      <div id="lvBody"></div>
    </div>
  </div>`;

  const $ = (id) => main.querySelector(`#${id}`);
  const ctl = () => {
    $("lvAlgoBox").hidden = $("lvMethod").value !== "nearest";
    $("lvHaz").disabled = $("lvInfo").value === "perfect";
  };
  ctl();

  // ---------------------------------------------------------- simulation
  const closed = () => {
    const set = new Set(L.sim.scenario.closed.map((c) => model.index.get(c)));
    for (const n of L.blocked) set.add(n);
    for (const n of model.nodes) if (n.blocked) set.add(n.i);
    return set;
  };
  function reset() {
    const scRaw = raw();
    L.opts = {
      method: $("lvMethod").value,
      algorithm: $("lvAlgo").value,
      info: $("lvInfo").value,
      hazardInfo: $("lvHaz").value,
      strategy: $("lvStrat").value,
      confirm: $("lvConf").value,
      seed: Math.max(1, Math.min(99999, Math.round(Number($("lvSeed").value) || 1))),
    };
    $("lvSeed").value = L.opts.seed;
    try {
      L.sim = ctx.E.createSimulation(model, model.scenarios[L.sc], optionsFor(s, scRaw, { ...L.opts }));
    } catch (err) {
      toast(`The simulation could not start: ${err.message}`, "bad");
      return;
    }
    L.sim.step();
    L.snap = L.sim.snapshot();
    L.cur = placePeople(model, L.snap, L.lines, L.cache);
    L.prev = L.cur;
    L.blocked = new Set();
    L.saved = false;
    L.playing = false;
    L.acc = 0;
    L.lastPlan = -1;
    L.alertKey = "";
    $("lvPlay").textContent = "Start";
    $("lvPlay").disabled = false;
    draw(1);
    panel(true);
  }
  function step() {
    if (L.sim.done) return false;
    L.sim.step();
    L.snap = L.sim.snapshot();
    L.prev = L.cur;
    L.cur = placePeople(model, L.snap, L.lines, L.cache);
    return true;
  }
  function interp(alpha) {
    if (alpha >= 1) return L.cur;
    const out = new Map();
    for (const [id, p] of L.cur) {
      const q = L.prev.get(id);
      if (!q || Math.abs(q[2] - p[2]) > 1.5) out.set(id, p);
      else out.set(id, [q[0] + (p[0] - q[0]) * alpha, q[1] + (p[1] - q[1]) * alpha, q[2] + (p[2] - q[2]) * alpha, p[3], p[4]]);
    }
    return out;
  }
  function draw(alpha) {
    if (!L.sim) return;
    const positions = interp(alpha);
    if (L.view === "2d" && L.plan) L.plan.update({ positions, snapshot: L.snap, closed: closed() });
    if (L.view === "3d" && L.view3d) L.view3d.update({ positions, snapshot: L.snap, layers: L.layers });
  }
  function finish() {
    L.playing = false;
    $("lvPlay").textContent = "Finished";
    $("lvPlay").disabled = true;
    if (L.saved) return;
    L.saved = true;
    const r = L.sim.summary();
    const scRaw = raw();
    const run = s.addRun(r, {
      scenario: scRaw.name,
      method: L.opts.method,
      algorithm: L.opts.method === "nearest" ? L.opts.algorithm : null,
      methodLabel: methodName(L.opts.method, L.opts.algorithm),
      seed: L.opts.seed,
      info: L.opts.info,
      hazardInfo: L.opts.info === "perfect" ? "perfect" : L.opts.hazardInfo,
      strategy: L.opts.strategy,
      blocked: [...L.blocked].map((n) => model.nodes[n].id),
      features: runFeatures(model, scRaw, L.opts.method),
    });
    toast(`Finished: ${r.safe} of ${r.total} safe. Saved in Reports & History.`);
    L.lastRun = run.id;
    panel(true);
  }

  let last = performance.now();
  let lastPanel = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (L.playing && L.sim && !L.sim.done) {
      L.acc += dt * L.speed;
      let n = 0;
      while (L.acc >= 1 && n < 120) {
        L.acc -= 1;
        n++;
        if (!step()) break;
      }
      if (L.sim.done) finish();
      draw(L.speed <= 5 ? Math.min(1, L.acc) : 1);
      if (now - lastPanel > (L.tab === "sensors" ? 1000 : 250)) {
        lastPanel = now;
        panel();
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------- views
  function make2D() {
    if (L.plan) return;
    L.plan = createPlan2D($("lvV2"), model, {
      onHover: hover,
      onClick: (n) => {
        if (!n || !L.blockMode || !L.sim) return;
        if (n.type === "exit" && model.exits.length <= 1) return toast("The only exit cannot be blocked.", "bad");
        if (L.sim.blockPlace(n.i, "blocked (reported by the commander)")) {
          L.blocked.add(n.i);
          ctx.store.audit("update", "live simulation", `blocked ${n.id} during the run`);
          toast(`${n.id} is blocked. Routes are planned again now.`);
          setBlock(false);
          draw(1);
          panel(true);
        }
      },
    });
    L.plan.setLayers(L.layers);
    L.plan.setFloor(L.floor);
  }
  async function make3D() {
    if (L.view3d) return true;
    try {
      const { createView3D } = await import("../view3d.js");
      if (!$("lvV3")) return false;
      $("lvV3").replaceChildren();
      L.view3d = createView3D($("lvV3"), model, { siteName: s.hospital().name });
      if (!L.exploded) L.view3d.setExploded(false);
      L.view3d.setLabels(L.labels3d);
      L.view3d.setOuter(L.outer);
      L.view3d.setFloor(L.floor);
      return true;
    } catch (err) {
      toast(`The 3D view could not start (${err.message}). The 2D plan still works.`, "bad");
      return false;
    }
  }
  async function setView(v) {
    L.view = v;
    $("lv2").setAttribute("aria-pressed", String(v === "2d"));
    $("lv3").setAttribute("aria-pressed", String(v === "3d"));
    $("lvV2").hidden = v !== "2d";
    $("lvV3").hidden = v !== "3d";
    $("lvTools3").hidden = v !== "3d";
    if (v === "3d") {
      setBlock(false);
      if (!(await make3D())) return setView("2d");
    } else make2D();
    draw(1);
  }
  function setBlock(on) {
    L.blockMode = on;
    $("lvBlock").setAttribute("aria-pressed", String(on));
    $("lvBlock").textContent = on ? "Click a place on the plan… (cancel)" : "Block a place now";
    if (on && L.view !== "2d") setView("2d");
  }
  function hover(n, ev) {
    const tip = document.getElementById("placeTip");
    if (!n || !L.sim) {
      tip.hidden = true;
      return;
    }
    const sim = L.sim;
    const h = L.snap.hazard.find((x) => x.n === n.i);
    const pic = sim.picture;
    const pred = pic && Number.isFinite(pic.arrival[n.i]) ? pic.arrival[n.i] - sim.t : null;
    const here = L.snap.people.filter((p) => p.node === n.i && p.edge === undefined).length;
    tip.innerHTML = [
      `<b>${esc(n.id)}</b> <span style="opacity:.75">${esc(n.type)}${n.refuge ? ", refuge" : ""}${n.protected ? ", protected" : ""}</span>`,
      `Area ${Math.round(n.area)} m², crowd limit ${n.capacity} people`,
      h ? (h.fire ? "Burning" : `Smoke now: ${Math.round(h.smoke * 100)}% of the thickest`) : "No smoke now",
      pred === null ? "Planner expects no smoke" : pred <= 0 ? "Planner: smoke already here" : `Planner: smoke in about ${Math.round(pred)} s`,
      `Planner risk ${f2(sim.plannerRisk(n.i))} (filter at ${sim.p.theta})`,
      `${here} people here`,
      L.blockMode ? "<b>Click to block this place</b>" : "",
    ].filter(Boolean).join("<br>");
    tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - 280, ev.clientX + 14)}px`;
    tip.style.top = `${Math.min(window.innerHeight - 150, ev.clientY + 14)}px`;
  }

  // ---------------------------------------------------------- panel
  function panel(force = false) {
    const sim = L.sim;
    if (!sim) return;
    const body = $("lvBody");
    if (!body) return;
    $("lvNote").textContent = sim.scenario.note ?? "";
    banner();
    if (L.tab === "situation") situation(body, force);
    else if (L.tab === "sensors") sensors(body);
    else if (L.tab === "signs") signs(body);
    else rescue(body);
  }
  function banner() {
    const b = $("lvBanner");
    const pending = L.sim.alerts.filter((a) => a.status === "new");
    if (pending.length && L.opts.confirm === "manual" && !ctx.readOnly()) {
      b.hidden = false;
      b.innerHTML = `<span>${pending.length} sensor alert${pending.length > 1 ? "s" : ""} wait for your decision</span><span class="row"><button class="btn sm" data-all="confirm">Confirm all</button><button class="btn sm" data-all="dismiss">Dismiss all</button></span>`;
    } else b.hidden = true;
  }
  function situation(body, force) {
    const sim = L.sim;
    const r = sim.summary();
    if (!body.querySelector("#lvKv")) {
      body.innerHTML = `<div class="stack">
        <div class="loop" id="lvLoop" data-every="repeats every ${sim.p.replan_s} s"><span>Sensing</span><span>Situation</span><span>Decision</span><span>Guidance</span></div>
        <div class="clock"><span class="t" id="lvClock"></span><span class="small" id="lvAlarm"></span></div>
        <div><div class="bar"><i id="lvBo" style="background:#0B7A4B"></i><i id="lvBr" style="background:#7DB8E8"></i><i id="lvBh" style="background:#E34948"></i></div><p class="small muted" id="lvBt" style="margin-top:4px"></p></div>
        <dl class="kv" id="lvKv"></dl>
        <div id="lvSaved"></div>
        <h3>Sensor alerts</h3><div class="alerts" id="lvAlerts"></div>
        <h3>What happened</h3><div class="events" id="lvEvents"></div>
      </div>`;
      force = true;
    }
    $("lvClock").textContent = fmtTime(sim.t);
    $("lvAlarm").innerHTML = sim.alarmAt !== null ? `<span class="pill bad">Alarm at ${fmtTime(sim.alarmAt)}</span>` : sim.scenario.origin === null ? '<span class="pill pri">Drill</span>' : '<span class="pill mute">No alarm yet</span>';
    const pct = (n) => `${(100 * n) / Math.max(1, r.total)}%`;
    $("lvBo").style.width = pct(r.out);
    $("lvBr").style.width = pct(r.refuge);
    $("lvBh").style.width = pct(r.harmed);
    $("lvBt").textContent = `${r.out} out, ${r.refuge} in refuges, ${r.harmed} reached by the hazard, of ${r.total} people`;
    $("lvKv").innerHTML = [
      ["Method", methodName(L.opts.method, L.opts.algorithm).replace(/:.*/, "")],
      ["Safe (out or refuge)", `${r.safe} / ${r.total}`],
      ["T50 / T90", `${fmtS(r.t50)} / ${fmtS(r.t90)}`],
      ["Reached by hazard (FED ≥ 0.3)", r.harmed],
      ["Overcome (FED ≥ 1)", r.incapacitated],
      ["Highest dose (FED)", f2(r.maxFed)],
      ["Sheltering, no route", r.shelter],
      ["Waiting for staff", r.leftWaiting],
      ["Rescued by fire brigade", r.rescued],
      ["Route changes / alternatives", `${r.routeChanges} / ${r.alternativeSwitches}`],
      ["Places blocked during the run", L.blocked.size],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    $("lvSaved").innerHTML = L.saved ? `<p class="note ok">Saved in Reports & History. <a href="#/reports" id="lvOpenRep">Open the report</a></p>` : "";
    const op = $("lvOpenRep");
    if (op) op.onclick = () => (ctx.pending.run = L.lastRun);
    if (sim.planVersion !== L.lastPlan) {
      L.lastPlan = sim.planVersion;
      const loop = $("lvLoop");
      loop.classList.remove("run");
      void loop.offsetWidth;
      loop.classList.add("run");
    }
    const key = sim.alerts.map((a) => a.id + a.status).join(",");
    if (key !== L.alertKey || force) {
      L.alertKey = key;
      const ro = ctx.readOnly();
      $("lvAlerts").innerHTML = sim.alerts.length
        ? [...sim.alerts].reverse().slice(0, 30).map((a) => `<div class="alert ${a.status}"><div><b>${esc(a.kind)}</b> sensor ${esc(a.sensor)} at ${esc(model.nodes[a.node].id)} <span class="muted num">${fmtTime(a.t)}</span></div>${a.status === "new" ? `<div class="row">${ro ? "" : `<button class="btn sm" data-confirm="${a.id}">Confirm</button><button class="btn sm danger" data-dismiss="${a.id}">Dismiss</button>`}${a.autoAt !== null ? `<span class="small muted">automatic at ${fmtTime(a.autoAt)}</span>` : ""}</div>` : `<div class="small muted">${a.status === "confirmed" ? "Confirmed" : "Dismissed"} at ${fmtTime(a.decidedAt)}</div>`}</div>`).join("")
        : '<p class="small muted">No sensor has detected anything.</p>';
    }
    const ev = sim.events.slice(-40).reverse();
    $("lvEvents").innerHTML = ev.length ? ev.map((e) => `<div class="k-${e.kind}"><span class="num">${fmtTime(e.t)}</span><span>${esc(e.message)}</span></div>`).join("") : '<p class="small muted">Nothing yet. Press Start.</p>';
  }
  function sensors(body) {
    const sim = L.sim;
    const pic = sim.picture;
    const truth = sim.truth;
    const lastE = sim.estimates[sim.estimates.length - 1];
    const items = [];
    if (truth.none) items.push(["Hazard", "None in this scenario", "A drill: there is nothing to estimate."]);
    else {
      items.push(["Estimated fire origin", pic ? model.nodes[pic.origin].id : "Waiting for a detection", `Real origin: ${model.nodes[truth.origin].id}${lastE && lastE.originError !== null && lastE.originError !== undefined ? ` · ${Math.round(lastE.originError)} m apart` : ""}`]);
      items.push(["Estimated smoke spread speed", pic && pic.rate ? `${pic.rate.toFixed(3)} m/s` : "–", `Real speed in this run: ${truth.smokeRate.toFixed(3)} m/s (design ${sim.scenario.smokeRate} m/s)`]);
      items.push(["Arrival-time error now", lastE && lastE.mae !== null ? `${Math.round(lastE.mae)} s` : "–", `Hazard picture: ${ctx.E.HAZARD_INFO[sim.hazardInfo]}`]);
    }
    const st = {};
    for (const x of sim.net.sensors) st[x.status] = (st[x.status] ?? 0) + 1;
    items.push(["Sensor health check", `${st.ok ?? 0} OK`, `${st["no data"] ?? 0} no data · ${st.stuck ?? 0} stuck · ${st.burnt ?? 0} burnt out · ${sim.reports.length} phone reports`]);
    const keepFilter = body.querySelector("#lvSF")?.value ?? "detected";
    body.innerHTML = `<div class="stack">
      ${items.map(([k, v, sub]) => `<div class="stat"><span class="lab">${esc(k)}</span><span class="big" style="font-size:18px">${esc(v)}</span><span class="small muted">${esc(sub)}</span></div>`).join("")}
      <h3>Arrival-time error over time</h3><div id="lvMae"></div>
      <h3>Predicted against real smoke arrival</h3><div id="lvSc2"></div>
      <label class="f">Show sensors<select id="lvSF">${option("detected", "That detected the hazard", keepFilter === "detected")}${option("problem", "With a health-check problem", keepFilter === "problem")}${option("fault", "With a fault set in this run", keepFilter === "fault")}${option("all", "All", keepFilter === "all")}</select></label>
      <div class="tbl"><table id="lvST"></table></div>
    </div>`;
    const mae = sim.estimates.filter((e) => e.mae !== null).map((e) => [e.t, e.mae]);
    lineChart(body.querySelector("#lvMae"), { height: 170, series: [{ name: "Error", color: "#0B7A4B", points: mae }], xLabel: "Time (s)", yLabel: "Error (s)", xName: "t =", xFmt: (v) => `${v}`, yFmt: (v) => `${Math.round(v)} s`, empty: truth.none ? "No hazard in this scenario." : "Appears after the first detection." });
    const pts = [];
    if (pic && !truth.none) {
      for (const n of model.nodes) {
        if (n.protected || n.type === "exit") continue;
        const a = truth.smokeArr[n.i];
        const b = pic.arrival[n.i];
        if (Number.isFinite(a) && Number.isFinite(b) && a <= 1500 && b <= 1500) pts.push({ x: a, y: Math.max(0, b), label: n.id });
      }
    }
    scatter(body.querySelector("#lvSc2"), { height: 200, points: pts, xLabel: "Real (s)", yLabel: "Predicted (s)", xName: "Real", yName: "Predicted", diag: true, empty: truth.none ? "No hazard in this scenario." : "Appears after the first detection." });
    const filter = body.querySelector("#lvSF").value;
    const rows = sim.net.sensors.filter((x) => filter === "all" || (filter === "detected" && x.detectedAt !== null) || (filter === "problem" && x.status !== "ok") || (filter === "fault" && x.fault !== "ok"));
    body.querySelector("#lvST").innerHTML = `<thead><tr><th>Sensor</th><th>Place</th><th>Check</th><th class="n">Latest</th><th class="n">Detected</th><th>Fault</th></tr></thead><tbody>${rows.slice(0, 120).map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${esc(model.nodes[x.node].id)}</td><td><span class="pill ${x.status === "ok" ? "ok" : x.status === "burnt" ? "bad" : "warn"}">${esc(x.status)}</span></td><td class="n">${x.latest === null ? "–" : `${x.latest.toFixed(x.kind === "smoke" ? 3 : 1)} ${UNIT[x.kind]}`}</td><td class="n">${x.detectedAt === null ? "–" : fmtTime(x.detectedAt)}${sim.dismissedSensors.has(x.id) ? " (dismissed)" : ""}</td><td>${x.burnt ? "Burnt out" : esc(FAULT_LABEL[x.fault] ?? x.fault)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">None.</td></tr>'}</tbody>`;
    body.querySelector("#lvSF").onchange = () => sensors(body);
  }
  function arrow(n, next) {
    const a = model.nodes[n];
    const b = model.nodes[next];
    if (a.floor !== b.floor) return `<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M6 27h7v-6h7v-6h8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/><path d="M17 6v11m-4-4 4 4 4-4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    return `<svg viewBox="0 0 34 34" aria-hidden="true"><g transform="rotate(${ang.toFixed(0)} 17 17)"><path d="M6 17h20m-7-7 7 7-7 7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  }
  function signs(body) {
    const sim = L.sim;
    const list = L.snap.signs.filter((x) => L.floor === null || model.nodes[x.n].floor === L.floor);
    const g = {};
    for (const a of sim.agents) if (a.kind !== "rescue") g[a.guidance] = (g[a.guidance] ?? 0) + 1;
    const all = L.snap.signs;
    body.innerHTML = `<div class="stack">
      <dl class="kv">${[
        ["Signs showing a way", all.filter((x) => x.next >= 0).length],
        ["Showing no safe way", all.filter((x) => x.next < 0 && !x.failed).length],
        ["Not working", all.filter((x) => x.failed).length],
        ["Sign changes so far", sim.signChanges],
        ["Phone messages sent", sim.messages],
        ["Guided by radio or phone", (g.radio ?? 0) + (g.phone ?? 0)],
        ["Signs only / not following", `${g.signs ?? 0} / ${g.none ?? 0}`],
      ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <p class="small muted">${L.floor === null ? "All floors" : floorName(L.floor)}: what each smart exit sign shows now. Change the floor above the plan.</p>
      <div class="signs" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">${list.map((x) => {
        const where = esc(model.nodes[x.n].id.replace(/^(G|\d) /, ""));
        const recent = sim.t - x.changedAt < 15 && x.changedAt > 1;
        if (x.failed) return `<div class="sign failed"><svg viewBox="0 0 34 34" aria-hidden="true"><path d="M8 17h18" stroke="#34433C" stroke-width="3" stroke-linecap="round"/></svg><div><div class="where">${where}</div><div class="to">Not working</div></div></div>`;
        if (x.next < 0) return `<div class="sign nogo ${recent ? "changed" : ""}"><svg viewBox="0 0 34 34" aria-hidden="true"><path d="M10 10l14 14M24 10 10 24" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg><div><div class="where">${where}</div><div class="to">No safe way</div></div></div>`;
        const nx = model.nodes[x.next];
        return `<div class="sign ${recent ? "changed" : ""}">${arrow(x.n, x.next)}<div><div class="where">${where}</div><div class="to">${esc(nx.type === "exit" ? `Exit: ${nx.id}` : nx.id.replace(/^(G|\d) /, ""))}</div></div></div>`;
      }).join("") || '<p class="small muted">No signs on this floor.</p>'}</div>
    </div>`;
  }
  function rescue(body) {
    const sim = L.sim;
    const teams = L.snap.teams;
    const arrive = sim.alarmAt === null ? null : sim.alarmAt + sim.p.rescue_arrival_s;
    const need = sim.agents.filter((x) => x.kind !== "rescue" && ["shelter", "incapacitated", "stuck", "needsHelp", "carried"].includes(x.state));
    body.innerHTML = `<div class="stack">
      <h3>Fire brigade teams</h3>
      ${teams.length ? teams.map((t) => {
        const a = sim.agents[t.id];
        const target = t.target >= 0 ? sim.agents[t.target] : null;
        const label = t.state === "teamIdle" ? "Waiting for a task" : t.state === "teamGoing" ? `Going to ${target?.code} at ${model.nodes[target?.node]?.id}` : `Bringing ${target?.code} out`;
        return `<div class="alert ${t.state === "teamIdle" ? "dismissed" : ""}"><div class="row" style="justify-content:space-between"><b>${esc(t.code)}</b><span class="pill ${t.state === "teamIdle" ? "mute" : "bad"}">${esc(t.state === "teamIdle" ? "Idle" : t.state === "teamGoing" ? "Going in" : "Carrying out")}</span></div><div>${esc(label)}</div><div class="small muted">At ${esc(model.nodes[a.node].id)}${t.state === "teamGoing" && t.eta ? ` · about ${Math.max(0, Math.round(t.eta - sim.t))} s to go` : ""}</div></div>`;
      }).join("") : `<p class="small muted">${sim.truth.none ? "No fire in this scenario, so no fire brigade." : sim.alarmAt === null ? "The fire brigade is called when the alarm sounds." : `Expected at ${fmtTime(arrive)} (${sim.p.rescue_arrival_s} s after the alarm).`}</p>`}
      <h3>People who need rescue (${need.length})</h3>
      <div class="tbl"><table><thead><tr><th>Person</th><th>Place</th><th>State</th><th class="n">FED</th></tr></thead><tbody>${need.slice(0, 80).map((x) => `<tr><td class="mono">${esc(x.code)}</td><td>${esc(model.nodes[x.node].id)}</td><td>${esc(STATE_LABEL[x.state] ?? x.state)}${x.mobility !== "ambulatory" ? ` · ${esc(x.mobility)}` : ""}</td><td class="n">${f2(x.fed)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Nobody needs rescue right now.</td></tr>'}</tbody></table></div>
    </div>`;
  }

  // ---------------------------------------------------------- wiring
  main.querySelector("#lvPanel").onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.tab) {
      L.tab = b.dataset.tab;
      for (const x of main.querySelectorAll("[data-tab]")) x.setAttribute("aria-selected", String(x === b));
      $("lvBody").innerHTML = "";
      panel(true);
      return;
    }
    if (ctx.readOnly() || !L.sim) return;
    if (b.dataset.confirm) L.sim.confirm(Number(b.dataset.confirm));
    else if (b.dataset.dismiss) L.sim.dismiss(Number(b.dataset.dismiss));
    else return;
    panel(true);
  };
  $("lvBanner").onclick = (ev) => {
    const b = ev.target.closest("[data-all]");
    if (!b || !L.sim) return;
    for (const a of L.sim.alerts.filter((x) => x.status === "new")) (b.dataset.all === "confirm" ? L.sim.confirm : L.sim.dismiss)(a.id);
    panel(true);
  };
  $("lvPlay").onclick = () => {
    if (!L.sim || L.sim.done) return;
    L.playing = !L.playing;
    $("lvPlay").textContent = L.playing ? "Pause" : "Continue";
    last = performance.now();
  };
  $("lvStep").onclick = () => {
    if (!L.sim) return;
    for (let k = 0; k < 10; k++) step();
    if (L.sim.done) finish();
    draw(1);
    panel(true);
  };
  $("lvReset").onclick = reset;
  $("lvSc").onchange = () => {
    L.sc = Number($("lvSc").value);
    const o = model.scenarios[L.sc].origin;
    if (o) {
      L.floor = model.nodes[model.index.get(o)].floor;
      $("lvFloor").value = String(L.floor);
      L.plan?.setFloor(L.floor);
      L.view3d?.setFloor(L.floor);
    }
    reset();
  };
  for (const id of ["lvMethod", "lvAlgo", "lvInfo", "lvHaz", "lvStrat", "lvConf", "lvSeed"]) $(id).addEventListener("change", () => {
    ctl();
    reset();
  });
  $("lvSpeed").onchange = () => (L.speed = Number($("lvSpeed").value));
  $("lvFa").onclick = () => {
    if (!L.sim) return;
    L.sim.injectFalseAlarm($("lvFaS").value);
    toast(`Sensor ${$("lvFaS").value} will report a false reading in the next few seconds. Watch the alerts.`);
  };
  $("lvBlock").onclick = () => setBlock(!L.blockMode);
  $("lv2").onclick = () => setView("2d");
  $("lv3").onclick = () => setView("3d");
  $("lvFloor").onchange = () => {
    L.floor = $("lvFloor").value === "all" ? null : Number($("lvFloor").value);
    L.plan?.setFloor(L.floor);
    L.view3d?.setFloor(L.floor);
    draw(1);
    if (L.tab === "signs") panel(true);
  };
  for (const c of main.querySelectorAll("[data-layer]")) c.onchange = () => {
    L.layers[c.dataset.layer] = c.checked;
    L.plan?.setLayers(L.layers);
    draw(1);
  };
  $("lvTour").onclick = () => {
    if (!L.view3d) return;
    if (L.view3d.touring()) {
      L.view3d.stopTour();
      $("lvTour").textContent = "Camera tour";
    } else {
      L.view3d.startTour(L.floor);
      $("lvTour").textContent = "Stop tour";
    }
  };
  $("lvFire").onclick = () => {
    if (!L.view3d || !L.sim) return;
    const fire = L.snap.hazard.find((h) => h.fire);
    const o = fire ? fire.n : L.sim.scenario.origin ? model.index.get(L.sim.scenario.origin) : null;
    if (o === null || o === undefined) return toast("There is no fire in this scenario.", "bad");
    L.floor = model.nodes[o].floor;
    $("lvFloor").value = String(L.floor);
    L.view3d.setFloor(L.floor);
    L.plan?.setFloor(L.floor);
    L.view3d.focusPlace(o);
    draw(1);
  };
  $("lvExpl").onclick = () => {
    L.exploded = !L.exploded;
    $("lvExpl").setAttribute("aria-pressed", String(L.exploded));
    L.view3d?.setExploded(L.exploded);
    draw(1);
  };
  $("lvLab").onclick = () => {
    L.labels3d = !L.labels3d;
    $("lvLab").setAttribute("aria-pressed", String(L.labels3d));
    L.view3d?.setLabels(L.labels3d);
  };
  $("lvOut").onclick = () => {
    L.outer = !L.outer;
    $("lvOut").setAttribute("aria-pressed", String(L.outer));
    L.view3d?.setOuter(L.outer);
  };
  $("lvCam").onclick = () => L.view3d?.resetCamera();

  // ---------------------------------------------------------- start
  setView(L.view);
  if (!L.sim) reset();
  else {
    $("lvPlay").textContent = L.sim.done ? "Finished" : L.playing ? "Pause" : "Continue";
    $("lvPlay").disabled = L.sim.done;
    L.alertKey = "";
    draw(1);
    panel(true);
  }
  last = performance.now();
  rafId = requestAnimationFrame(frame);
}
