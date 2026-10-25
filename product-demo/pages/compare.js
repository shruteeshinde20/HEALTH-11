// Algorithm Comparison: A) the four classic algorithms of the main app against the
// hazard-aware method; B) the research methods under different kinds of information.
import { esc, header, option, toast, floorName, download } from "../ui.js";
import { barChart } from "../charts.js";
import { createPlan2D } from "../plan2d.js";
import { toCsv } from "../io.js";
import { ALGO_LABEL, METHOD_COLOUR, optionsFor, methodName, runFeatures } from "./shared.js";

const COND_LABEL = { live: "Realistic, live estimate", offline: "Realistic, fire model run before", perfect: "Perfect information" };
const SHORT = { nearest: "Nearest exit", safe: "Shortest safe", congestion: "Congestion", proposed: "Hazard-aware" };
const DEC = { t50: 0, t90: 0, lastSafe: 0, meanFed: 3, maxFed: 2, harmed: 1, incapacitated: 1, safe: 1 };

let busy = false;

export function render(main, ctx) {
  const s = ctx.store;
  const m = ctx.model();
  const list = s.data().scenarios;
  let tab = ctx.pending.compareTab ?? "classic";
  delete ctx.pending.compareTab;
  let plan = null;

  main.innerHTML = `${header("Algorithm Comparison", "Run the same scenario with different routing methods and compare evacuation time and smoke dose. Each method uses the same people and the same fire (same run numbers).")}
  <div class="tabs-in" role="tablist"><button role="tab" data-t="classic" aria-selected="${tab === "classic"}">Classic algorithms</button><button role="tab" data-t="research" aria-selected="${tab === "research"}">Research methods and information <span class="gap-chip">Gaps 3, 4, 5</span></button></div>
  <div id="cmpBody"></div>`;

  const body = main.querySelector("#cmpBody");
  const scenarioSelect = (id, fireOnly) => `<select id="${id}">${list.map((r, i) => (fireOnly && !r.origin ? "" : option(i, r.name, i === 0))).join("")}</select>`;

  function progress(d, t) {
    const bar = body.querySelector("#cProg");
    if (bar) bar.style.width = `${(100 * d) / t}%`;
    const txt = body.querySelector("#cProgT");
    if (txt) txt.textContent = `${d} of ${t} runs`;
  }

  function save(out, jobs, scRaw) {
    for (const j of jobs) {
      for (const [k, r] of out[j.key].results.entries()) {
        s.state.runs.unshift({ id: s.newId(), at: new Date().toISOString(), scenario: scRaw.name, method: j.options.method, algorithm: j.options.method === "nearest" ? j.options.algorithm : null, methodLabel: methodName(j.options.method, j.options.algorithm), seed: 100 + k, info: j.options.info, source: "comparison", features: runFeatures(m, scRaw, j.options.method), summary: { ...r, events: [] } });
      }
    }
    if (s.state.runs.length > 80) s.state.runs.length = 80;
    s.audit("create", "comparison", `${scRaw.name}: ${jobs.length} methods`);
  }

  function statTable(out, rows, runs) {
    const metrics = ctx.E.METRICS;
    const best = (k, lower) => {
      const vals = rows.map((r) => out[r.key].stats[k].mean).filter((v) => v !== null);
      if (!vals.length || vals.every((v) => Math.abs(v - vals[0]) < 1e-9)) return null;
      return lower ? Math.min(...vals) : Math.max(...vals);
    };
    const bests = Object.fromEntries(metrics.map((mm) => [mm.key, best(mm.key, mm.lowerBetter)]));
    return `<div class="tbl"><table><thead><tr><th>Method</th>${metrics.map((mm) => `<th class="n">${esc(mm.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr><td><span class="sw" style="background:${r.colour};margin-right:6px"></span>${esc(r.label)}</td>${metrics.map((mm) => {
      const st = out[r.key].stats[mm.key];
      if (st.mean === null) return '<td class="n">–</td>';
      const isBest = bests[mm.key] !== null && Math.abs(st.mean - bests[mm.key]) < 1e-9;
      return `<td class="n num"${isBest ? ' style="font-weight:700;color:var(--ok-ink)"' : ""}>${st.mean.toFixed(DEC[mm.key])}${st.sd !== null ? ` <span class="muted">± ${st.sd.toFixed(DEC[mm.key])}</span>` : ""}${st.n < runs ? ` <span class="muted">(${st.n}/${runs})</span>` : ""}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="small muted" style="margin-top:6px">Best value in each column in bold green (none when all are equal). ± is the spread over ${runs} runs. A count in brackets means that share of people was not reached in some runs.</p>`;
  }

  function csvOf(out, rows, runs, extra = {}) {
    const csvRows = rows.map((r) => {
      const st = out[r.key].stats;
      const row = { ...extra, method: r.label, runs };
      for (const mm of ctx.E.METRICS) {
        row[`${mm.key}_mean`] = st[mm.key].mean === null ? "" : st[mm.key].mean.toFixed(4);
        row[`${mm.key}_sd`] = st[mm.key].sd === null ? "" : st[mm.key].sd.toFixed(4);
      }
      return row;
    });
    return toCsv(csvRows, Object.keys(csvRows[0]));
  }

  // ---------------------------------------------------------- A: classic
  function classic() {
    const rooms = m.nodes.filter((n) => !["corridor", "exit", "stair", "lift"].includes(n.type));
    body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(260px,1fr) minmax(0,2fr)">
      <div class="card stack">
        <h2>Run a comparison</h2>
        <label class="f">Scenario${scenarioSelect("cSc", false)}</label>
        <div class="checks">${Object.entries(ALGO_LABEL).map(([k, v]) => `<label><input type="checkbox" data-alg="${k}" checked><span class="sw" style="background:${METHOD_COLOUR[k]}"></span>${v} (static plan)</label>`).join("")}<label><input type="checkbox" data-alg="proposed" checked><span class="sw" style="background:#0B7A4B;border:2px solid #1E3A5F"></span>Hazard-aware (proposed)</label></div>
        <label class="f">Runs per method<select id="cRuns">${[1, 3, 5].map((v) => option(v, String(v), v === 3)).join("")}</select></label>
        <button class="btn primary" id="cGo" ${ctx.readOnly() ? "disabled" : ""}>Compare</button>
        <div class="progress"><i id="cProg"></i></div><span class="small muted" id="cProgT"></span>
        <p class="small muted">BFS finds the fewest steps, DFS takes the first way it finds going deep (not the shortest), Dijkstra the shortest distance, and A* the shortest distance guided by the straight-line distance to the nearest exit. In the static plan these do not know about smoke until people see it.</p>
      </div>
      <div class="card stack">
        <h2>One route, four algorithms</h2>
        <div class="row"><label class="f" style="flex:2">From<select id="cFrom">${m.floors.map((f) => `<optgroup label="${floorName(f)}">${rooms.filter((n) => n.floor === f).map((n) => option(n.i, n.id, n.id === "MICU Bay 1")).join("")}</optgroup>`).join("")}</select></label>
        <label class="f" style="flex:1">Who<select id="cCls">${option("walk", "Walking person")}${option("chair", "Wheelchair")}${option("bed", "Bed or stretcher")}</select></label></div>
        <div id="cRouteT"></div>
        <div class="view" style="height:360px;min-height:300px"><div class="layer" id="cPlan"></div></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>All rooms (static routes to the nearest exit)</h2><div id="cAll"></div></div>
    <div id="cOut" style="margin-top:16px"></div>`;
    plan = createPlan2D(body.querySelector("#cPlan"), m);
    plan.setLayers({ sensors: false, signs: false, routes: false, predicted: false, hazard: false });
    const exits = new Set(m.exits);
    let showAlg = "dijkstra";
    const routes = () => {
      const from = Number(body.querySelector("#cFrom").value);
      const cls = body.querySelector("#cCls").value;
      const res = Object.keys(ALGO_LABEL).map((a) => [a, ctx.E.classicRoute(m, from, exits, cls, a, new Set(), new Set(), 4)]);
      body.querySelector("#cRouteT").innerHTML = `<div class="tbl"><table><thead><tr><th>Algorithm</th><th class="n">Length (m)</th><th class="n">Steps</th><th class="n">Places explored</th><th>Exit</th><th></th></tr></thead><tbody>${res.map(([a, r]) => `<tr${a === showAlg ? ' style="background:var(--tagp)"' : ""}><td>${ALGO_LABEL[a]}</td>${r ? `<td class="n">${r.length.toFixed(1)}</td><td class="n">${r.nodes.length - 1}</td><td class="n">${r.explored}</td><td>${esc(m.nodes[r.nodes[r.nodes.length - 1]].id)}</td>` : '<td colspan="4" class="muted">No route</td>'}<td><button class="btn sm" data-show="${a}">Show</button></td></tr>`).join("")}</tbody></table></div>`;
      const r = res.find(([a]) => a === showAlg)[1];
      plan.setFloor(m.nodes[from].floor);
      plan.update({ highlightRoute: r ? r.nodes : null, selected: from, snapshot: { people: [], hazard: [], predicted: [], signs: [], routes: [], teams: [], sensors: [], density: [], t: 0 } });
    };
    body.querySelector("#cFrom").onchange = routes;
    body.querySelector("#cCls").onchange = routes;
    body.querySelector("#cRouteT").onclick = (ev) => {
      const b = ev.target.closest("[data-show]");
      if (!b) return;
      showAlg = b.dataset.show;
      routes();
    };
    routes();
    // all rooms
    const agg = Object.keys(ALGO_LABEL).map((a) => {
      let len = 0;
      let exp = 0;
      let steps = 0;
      let n = 0;
      let longer = 0;
      for (const r of rooms) {
        const x = ctx.E.classicRoute(m, r.i, exits, "walk", a, new Set(), new Set(), 4);
        const best = ctx.E.classicRoute(m, r.i, exits, "walk", "dijkstra", new Set(), new Set(), 4);
        if (!x) continue;
        n++;
        len += x.length;
        exp += x.explored;
        steps += x.nodes.length - 1;
        if (best && x.length > best.length * 1.05 + 0.5) longer++;
      }
      return { a, len: len / Math.max(1, n), exp: exp / Math.max(1, n), steps: steps / Math.max(1, n), longer, n };
    });
    body.querySelector("#cAll").innerHTML = `<div class="tbl"><table><thead><tr><th>Algorithm</th><th class="n">Rooms</th><th class="n">Mean route length (m)</th><th class="n">Mean steps</th><th class="n">Mean places explored</th><th class="n">Rooms with a route over 5% longer than the shortest</th></tr></thead><tbody>${agg.map((x) => `<tr><td>${ALGO_LABEL[x.a]}</td><td class="n">${x.n}</td><td class="n">${x.len.toFixed(1)}</td><td class="n">${x.steps.toFixed(1)}</td><td class="n">${x.exp.toFixed(0)}</td><td class="n">${x.longer}</td></tr>`).join("")}</tbody></table></div><p class="small muted" style="margin-top:6px">Computed now, in this browser, for walking people from each of ${rooms.length} rooms. A* explores fewer places than Dijkstra for the same shortest route; BFS minimises steps, not metres; DFS is fast to write but can send people the long way.</p>`;

    body.querySelector("#cGo").onclick = async () => {
      if (busy) return;
      const algs = [...body.querySelectorAll("[data-alg]")].filter((c) => c.checked).map((c) => c.dataset.alg);
      if (!algs.length) return toast("Choose at least one method.", "bad");
      const idx = Number(body.querySelector("#cSc").value);
      const scRaw = list[idx];
      const runs = Number(body.querySelector("#cRuns").value);
      const seeds = Array.from({ length: runs }, (_, k) => 100 + k);
      const jobs = algs.map((a) => ({ key: a, scenario: m.scenarios[idx], options: optionsFor(s, scRaw, a === "proposed" ? { method: "proposed", info: "realistic" } : { method: "nearest", algorithm: a, info: "realistic" }) }));
      busy = true;
      body.querySelector("#cGo").disabled = true;
      body.querySelector("#cOut").innerHTML = "";
      try {
        const out = await ctx.job({ type: "runs", jobs, seeds }, progress);
        save(out, jobs, scRaw);
        const rows = algs.map((a) => ({ key: a, label: a === "proposed" ? "Hazard-aware (proposed)" : `${ALGO_LABEL[a]} (static)`, colour: a === "proposed" ? "#0B7A4B" : METHOD_COLOUR[a] }));
        if (algs.includes("proposed")) rows[rows.length - 1].colour = "#1E3A5F";
        const csv = csvOf(out, rows, runs, { scenario: scRaw.name });
        body.querySelector("#cOut").innerHTML = `<div class="card stack"><h2>${esc(scRaw.name)} · ${runs} run${runs > 1 ? "s" : ""} each</h2>${statTable(out, rows, runs)}
          <div class="grid3">${["t90", "harmed", "meanFed"].map((k) => `<div><h3>${esc(ctx.E.METRICS.find((x) => x.key === k).label)}</h3><div id="cc-${k}"></div></div>`).join("")}</div>
          <div class="row"><button class="btn" id="cCsv">Download CSV</button><span class="small muted">Saved ${jobs.length * runs} runs in Reports & History.</span></div></div>`;
        for (const k of ["t90", "harmed", "meanFed"]) {
          barChart(body.querySelector(`#cc-${k}`), { groups: ["This scenario"], series: rows.map((r) => ({ name: r.label, color: r.colour, values: [out[r.key].stats[k]] })), fmt: (v) => (k === "meanFed" ? v.toFixed(3) : k === "harmed" ? v.toFixed(1) : `${Math.round(v)}`), yLabel: k === "t90" ? "seconds" : k === "harmed" ? "people" : "FED" });
        }
        body.querySelector("#cCsv").onclick = () => download("comparison-classic.csv", csv, "text/csv");
      } catch (err) {
        body.querySelector("#cOut").innerHTML = `<p class="note">The comparison stopped: ${esc(err.message)}</p>`;
      } finally {
        busy = false;
        const b = body.querySelector("#cGo");
        if (b) b.disabled = false;
      }
    };
  }

  // ---------------------------------------------------------- B: research
  function research() {
    body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(260px,1fr) minmax(0,2fr)">
      <div class="card stack">
        <h2>Run a comparison</h2>
        <label class="f">Fire scenario${scenarioSelect("rSc", true)}</label>
        <h3>Methods</h3>
        <div class="checks">${Object.entries(SHORT).map(([k, v]) => `<label><input type="checkbox" data-method="${k}" checked><span class="sw" style="background:${METHOD_COLOUR[k]}"></span>${v}</label>`).join("")}</div>
        <h3>Information</h3>
        <div class="checks">${Object.entries(COND_LABEL).map(([k, v]) => `<label><input type="checkbox" data-cond="${k}" ${k !== "offline" ? "checked" : ""}>${v}</label>`).join("")}</div>
        <label class="f">Runs per cell<select id="rRuns">${[2, 3, 5, 8].map((v) => option(v, String(v), v === 3)).join("")}</select></label>
        <button class="btn primary" id="rGo" ${ctx.readOnly() ? "disabled" : ""}>Compare</button>
        <div class="progress"><i id="cProg"></i></div><span class="small muted" id="cProgT"></span>
      </div>
      <div class="card stack">
        <h2>What is compared</h2>
        <p><b>Nearest exit</b>: a static plan (Dijkstra) made before the fire. <b>Shortest safe</b>: avoids places that are dangerous now. <b>Congestion</b>: also spreads people over exits by crowding. <b>Hazard-aware</b> (proposed): one route cost for travel time in the crowd plus the smoke dose expected when each person arrives, re-planned every 10 s.</p>
        <p><b>Realistic, live estimate</b>: faulty sensors, people without phones or who do not follow guidance, and a fire picture estimated from live readings. <b>Fire model run before</b>: a fixed fire forecast that is not updated. <b>Perfect information</b>: the upper bound nobody has in reality.</p>
        <p class="small muted">The research claim is honest only when the proposed method also does well under realistic information, not only with perfect information.</p>
      </div>
    </div>
    <div id="rOut" style="margin-top:16px"></div>`;
    body.querySelector("#rGo").onclick = async () => {
      if (busy) return;
      const methods = [...body.querySelectorAll("[data-method]")].filter((c) => c.checked).map((c) => c.dataset.method);
      const conds = [...body.querySelectorAll("[data-cond]")].filter((c) => c.checked).map((c) => c.dataset.cond);
      if (!methods.length || !conds.length) return toast("Choose at least one method and one kind of information.", "bad");
      const idx = Number(body.querySelector("#rSc").value);
      const scRaw = list[idx];
      const runs = Number(body.querySelector("#rRuns").value);
      const seeds = Array.from({ length: runs }, (_, k) => 100 + k);
      const jobs = [];
      for (const c of conds) for (const mth of methods) jobs.push({ key: `${c}|${mth}`, scenario: m.scenarios[idx], options: optionsFor(s, scRaw, { method: mth, info: c === "perfect" ? "perfect" : "realistic", hazardInfo: c === "perfect" ? "perfect" : c }) });
      busy = true;
      body.querySelector("#rGo").disabled = true;
      body.querySelector("#rOut").innerHTML = "";
      try {
        const out = await ctx.job({ type: "runs", jobs, seeds }, progress);
        save(out, jobs, scRaw);
        const csvParts = [];
        const tables = conds.map((c) => {
          const rows = methods.map((mth) => ({ key: `${c}|${mth}`, label: SHORT[mth], colour: METHOD_COLOUR[mth] }));
          csvParts.push(csvOf(out, rows, runs, { scenario: scRaw.name, information: COND_LABEL[c] }));
          return `<h3>${esc(COND_LABEL[c])}</h3>${statTable(out, rows, runs)}`;
        }).join("");
        const csv = [csvParts[0], ...csvParts.slice(1).map((x) => x.split("\n").slice(1).join("\n"))].join("\n");
        body.querySelector("#rOut").innerHTML = `<div class="card stack"><h2>${esc(scRaw.name)} · ${runs} runs per cell</h2>${tables}
          <div class="grid3">${["t90", "harmed", "meanFed"].map((k) => `<div><h3>${esc(ctx.E.METRICS.find((x) => x.key === k).label)}</h3><div id="rc-${k}"></div></div>`).join("")}</div>
          <div class="row"><button class="btn" id="rCsv">Download CSV</button><span class="small muted">Saved ${jobs.length * runs} runs in Reports & History.</span></div></div>`;
        for (const k of ["t90", "harmed", "meanFed"]) {
          barChart(body.querySelector(`#rc-${k}`), { groups: conds.map((c) => COND_LABEL[c].replace("Realistic, ", "")), series: methods.map((mth) => ({ name: SHORT[mth], color: METHOD_COLOUR[mth], values: conds.map((c) => out[`${c}|${mth}`].stats[k]) })), fmt: (v) => (k === "meanFed" ? v.toFixed(3) : k === "harmed" ? v.toFixed(1) : `${Math.round(v)}`), yLabel: k === "t90" ? "seconds" : k === "harmed" ? "people" : "FED" });
        }
        body.querySelector("#rCsv").onclick = () => download("comparison-research.csv", csv, "text/csv");
      } catch (err) {
        body.querySelector("#rOut").innerHTML = `<p class="note">The comparison stopped: ${esc(err.message)}</p>`;
      } finally {
        busy = false;
        const b = body.querySelector("#rGo");
        if (b) b.disabled = false;
      }
    };
  }

  const open = () => {
    if (plan) {
      plan.dispose();
      plan = null;
    }
    for (const b of main.querySelectorAll("[data-t]")) b.setAttribute("aria-selected", String(b.dataset.t === tab));
    if (tab === "classic") classic();
    else research();
  };
  for (const b of main.querySelectorAll("[data-t]")) b.onclick = () => {
    tab = b.dataset.t;
    open();
  };
  open();
}
