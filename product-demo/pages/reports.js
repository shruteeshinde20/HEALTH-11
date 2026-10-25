// Reports & History: every saved run with a full report, the drill check
// (gap 2: compare, calibrate, test on a second drill) and a sensor recording replay (gap 5).
import { esc, header, stat, table, fmtS, fmtMin, f2, option, toast, download, readFile, pill, confirmBox } from "../ui.js";
import { lineChart, barChart, heatmap } from "../charts.js";
import { drillFromCsv, readingsFromCsv, toCsv } from "../io.js";
import { recommendations } from "./shared.js";

const SAFETY = "HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals.";
const GROUP = { walk: "Walking patients and visitors", staff: "Staff", assisted: "Wheelchair and bed patients" };
const DRILLS = {
  a: { file: "drill-a-full.csv", scenario: "Evacuation drill (no hazard)", label: "Example drill A (all exits open)" },
  b: { file: "drill-b-main-entrance-closed.csv", scenario: "Drill with the Main Entrance closed", label: "Example drill B (Main Entrance closed)" },
};

let drill = { rows: null, name: "", key: null };
let busy = false;

export function render(main, ctx) {
  const s = ctx.store;
  let tab = "history";
  let runId = ctx.pending.run ?? s.state.runs[0]?.id ?? null;
  if (ctx.pending.run !== undefined) tab = "history";
  delete ctx.pending.run;
  const planner = !ctx.readOnly();

  main.innerHTML = `${header("Reports & History", "Every finished run is saved here with a report you can print or download. The drill check compares the model with a drill record.")}
  <div class="tabs-in no-print" role="tablist"><button role="tab" data-t="history" aria-selected="true">Runs and reports</button>${planner ? '<button role="tab" data-t="drill" aria-selected="false">Drill check <span class="gap-chip">Gap 2</span></button><button role="tab" data-t="replay" aria-selected="false">Sensor recording <span class="gap-chip">Gap 5</span></button>' : ""}</div>
  <div id="rBody"></div>`;
  const body = main.querySelector("#rBody");

  // ---------------------------------------------------------- history and report
  function history() {
    const runs = s.state.runs;
    const run = runs.find((r) => r.id === runId) ?? runs[0];
    body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(260px,1fr) minmax(0,2.2fr)">
      <div class="card stack no-print">
        <div class="row" style="justify-content:space-between"><h2>Saved runs (${runs.length})</h2>${planner && runs.length ? '<button class="btn sm danger" id="rClear">Delete all</button>' : ""}</div>
        <div style="max-height:70vh;overflow-y:auto">${table(
          [
            { label: "When", get: (r) => new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
            { label: "Scenario", get: (r) => r.scenario },
            { label: "Method", get: (r) => r.methodLabel.replace(/:.*/, "") },
            { label: "Safe", n: true, get: (r) => `${r.summary.safe}/${r.summary.total}` },
          ],
          runs.map((r) => ({ ...r, _attrs: `class="click" data-run="${r.id}"${run && r.id === run.id ? ' style="background:var(--tagp)"' : ""}` })),
          { empty: "No runs yet. Finish a run on Live Simulation or use Algorithm Comparison." },
        )}</div>
      </div>
      <div id="rReport">${run ? "" : '<div class="card"><p class="empty">Choose a run.</p></div>'}</div>
    </div>`;
    if (run) report(body.querySelector("#rReport"), run);
    for (const tr of body.querySelectorAll("[data-run]")) tr.onclick = () => {
      runId = Number(tr.dataset.run);
      history();
    };
    const clr = body.querySelector("#rClear");
    if (clr) clr.onclick = async () => {
      if (!(await confirmBox(`Delete all ${runs.length} saved runs? The audit log keeps a record that they were deleted.`))) return;
      s.state.runs = [];
      s.audit("delete", "simulation runs", "all");
      runId = null;
      history();
    };
  }

  function report(box, run) {
    const x = run.summary;
    const m = ctx.model();
    const rec = recommendations(x, m);
    const h = s.hospital();
    box.innerHTML = `<div class="card stack" id="printArea">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div><h2>Evacuation report</h2><p class="small muted">${esc(h.name)}, ${esc(h.city)} · ${esc(s.building().name)} · ${new Date(run.at).toLocaleString()}</p></div>
        <div class="row no-print"><button class="btn" id="rPrint">Print or save as PDF</button><button class="btn" id="rCsv">Download CSV</button></div>
      </div>
      <dl class="kv" style="max-width:640px">${[
        ["Scenario", run.scenario],
        ["Routing method", run.methodLabel],
        ["Information", run.info === "perfect" ? "Perfect (upper bound)" : `Realistic${run.hazardInfo ? `, ${ctx.E.HAZARD_INFO[run.hazardInfo] ?? run.hazardInfo}` : ""}`],
        ["Run number (seed)", run.seed],
        ["Places blocked during the run", run.blocked?.length ? run.blocked.join(", ") : "None"],
        ["Alarm", x.alarmAt === null || x.alarmAt === undefined ? "No alarm (drill or not raised)" : `${fmtS(x.alarmAt)}${x.alarmReason ? `: ${x.alarmReason}` : ""}`],
      ].map(([k, v]) => `<dt>${esc(k)}</dt><dd style="text-align:left">${esc(v)}</dd>`).join("")}</dl>
      <div class="stats">
        ${stat(`${x.safe}/${x.total}`, "Reached safety", `${x.out} out, ${x.refuge} in refuges`)}
        ${stat(fmtS(x.t50), "T50: half safe")}
        ${stat(fmtS(x.t90), "T90: 90% safe")}
        ${stat(fmtMin(x.lastSafe), "Total evacuation time", "last person safe")}
        ${stat(x.harmed, "Reached by the hazard", "FED of 0.3 or more")}
        ${stat(x.incapacitated, "Overcome by smoke", "FED of 1 or more")}
        ${stat(f2(x.maxFed), "Highest smoke dose (FED)")}
        ${stat(x.meanHelpWait === null || x.meanHelpWait === undefined ? "–" : fmtS(x.meanHelpWait), "Mean wait for staff", x.maxHelpWait ? `longest ${fmtS(x.maxHelpWait)}` : "")}
      </div>
      <div class="grid2">
        <div><h3>People safe over time</h3><div id="rCurve"></div></div>
        <div><h3>People per exit</h3><div id="rExits"></div></div>
      </div>
      <div class="grid2">
        <div><h3>Patients by mobility <span class="gap-chip">Gap 1</span></h3>${table(
          [
            { label: "Mobility", get: (r) => r.k },
            { label: "Patients", n: true, get: (r) => r.total },
            { label: "Safe", n: true, get: (r) => r.safe },
            { label: "Mean time to safety", n: true, get: (r) => fmtS(r.meanSafe) },
            { label: "Harmed", n: true, get: (r) => r.harmed },
          ],
          Object.entries(x.byMobility ?? {}).map(([k, v]) => ({ k, ...v })),
        )}</div>
        <div><h3>Bottlenecks (most crowded paths)</h3>${table(
          [
            { label: "Path", get: (r) => r.path },
            { label: "Kind", get: (r) => r.kind },
            { label: "Most people per m²", n: true, get: (r) => r.maxDensity },
            { label: "Longest queue", n: true, get: (r) => r.maxQueue },
          ],
          (x.busiest ?? []).slice(0, 6),
          { empty: "No path was used." },
        )}</div>
      </div>
      <div><h3>Recommendations</h3>${rec.map((r) => `<p style="margin:6px 0">${pill(r.tone === "bad" ? "Safety" : r.tone === "warn" ? "Improve" : r.tone === "ok" ? "OK" : "Note", r.tone === "bad" ? "bad" : r.tone === "warn" ? "warn" : r.tone === "ok" ? "ok" : "pri")} ${esc(r.text)}</p>`).join("")}<p class="small muted">Each recommendation comes from a written rule on the numbers above, so it can be checked.</p></div>
      ${x.estimate ? `<div><h3>Live fire estimate <span class="gap-chip">Gap 5</span></h3><p class="small">At the end, the estimated origin was ${x.estimate.originError === null || x.estimate.originError === undefined ? "not found" : `${Math.round(x.estimate.originError)} m from the real one`}; estimated spread speed ${x.estimate.rate ? `${x.estimate.rate.toFixed(3)} m/s` : "–"} against a real ${x.trueRate ?? "–"} m/s; arrival-time error ${x.estimate.mae === null || x.estimate.mae === undefined ? "–" : `${Math.round(x.estimate.mae)} s`}.</p></div>` : ""}
      <div><h3>Sensors <span class="gap-chip">Gap 4</span></h3><p class="small">Faults set in this run: ${Object.entries(x.sensorFaults ?? {}).filter(([k]) => k !== "ok").map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. ${x.alerts?.length ?? 0} alerts; ${x.signChanges ?? 0} sign changes; ${x.messages ?? 0} phone messages.</p></div>
      <p class="small muted">${esc(SAFETY)} The building and people are made up for a student demo.</p>
    </div>`;
    const curve = (x.curve ?? []).map(([t, v]) => [t, v]);
    lineChart(box.querySelector("#rCurve"), { height: 220, series: [{ name: "People safe", color: "#2A78D6", points: curve }], xLabel: "Time (s)", yLabel: "People", xName: "t =", yFmt: (v) => `${Math.round(v)}`, empty: "This run has no curve saved." });
    const ex = (x.exits ?? []).filter((e) => e.people > 0);
    if (ex.length) barChart(box.querySelector("#rExits"), { height: 220, groups: ex.map((e) => e.exit), series: [{ name: "People", color: "#7DB8E8", values: ex.map((e) => ({ mean: e.people, sd: null, n: 1 })) }], fmt: (v) => `${Math.round(v)}`, yLabel: "people" });
    else box.querySelector("#rExits").innerHTML = '<p class="empty">Nobody left by an exit (everyone went to refuges or the run stopped early).</p>';
    box.querySelector("#rPrint").onclick = () => {
      s.audit("export", "report", `${run.scenario} (print)`);
      window.print();
    };
    box.querySelector("#rCsv").onclick = () => {
      const rows = [
        ["hospital", h.name], ["building", s.building().name], ["scenario", run.scenario], ["method", run.methodLabel], ["seed", run.seed], ["date", run.at],
        ["total", x.total], ["safe", x.safe], ["out", x.out], ["refuge", x.refuge], ["t50_s", x.t50 ?? ""], ["t90_s", x.t90 ?? ""], ["last_safe_s", x.lastSafe ?? ""],
        ["harmed", x.harmed], ["incapacitated", x.incapacitated], ["max_fed", x.maxFed], ["mean_fed", x.meanFed], ["shelter", x.shelter], ["rescued", x.rescued],
        ...(x.exits ?? []).map((e) => [`exit:${e.exit}`, e.people]),
      ].map(([k, v]) => ({ field: k, value: v }));
      download(`report-${run.id}.csv`, toCsv(rows, ["field", "value"]), "text/csv");
      s.audit("export", "report", `${run.scenario} (CSV)`);
    };
  }

  // ---------------------------------------------------------- drill check
  function drillTab() {
    const m = ctx.model();
    const list = s.data().scenarios;
    const drills = list.map((r, i) => [r, i]).filter(([r]) => !r.origin);
    body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(260px,1fr) minmax(0,2fr)">
      <div class="card stack">
        <h2>1. Load a drill record</h2>
        <div class="row"><button class="btn" data-drill="a">${esc(DRILLS.a.label)}</button><button class="btn" data-drill="b">${esc(DRILLS.b.label)}</button></div>
        <label class="btn" for="dFile" style="justify-self:start">Upload a drill CSV</label><input type="file" id="dFile" accept=".csv,text/csv" hidden>
        <p class="small muted">Columns: code, kind, mobility, exit, exit_time_s (seconds after the alarm). The example records are <b>made up</b> with this simulator using hidden settings (people 10% slower, delays 25% longer); they only show that the check works.</p>
        <p class="small" id="dName">${drill.rows ? `${esc(drill.name)}: ${drill.rows.length} people` : "No record loaded."}</p>
        <h2>2. Compare</h2>
        <label class="f">Scenario to compare with<select id="dSc">${drills.map(([r, i]) => option(i, r.name, drill.key ? r.name === DRILLS[drill.key].scenario : false)).join("")}</select></label>
        <label class="f">Runs<select id="dRuns">${[3, 5, 10].map((v) => option(v, String(v), v === 5)).join("")}</select></label>
        <div class="row"><button class="btn primary" id="dGo">Compare with the drill</button><button class="btn" id="dCal">Calibrate</button></div>
        <div class="progress"><i id="dProg"></i></div>
        <p class="small muted">Calibrate tries 20 pairs of walking-speed and delay scales (3 runs each) and keeps the pair that fits best. Then check it on the other drill, which was not used for fitting.</p>
      </div>
      <div class="stack"><div id="dOut"></div><div id="dCalOut"></div><div id="dHold"></div></div>
    </div>`;
    const prog = (d, t) => {
      const b = body.querySelector("#dProg");
      if (b) b.style.width = `${(100 * d) / t}%`;
    };
    const load = async (key) => {
      try {
        const res = await fetch(`examples/${DRILLS[key].file}`);
        if (!res.ok) throw new Error(`${DRILLS[key].file}: ${res.status}`);
        drill = { rows: drillFromCsv(await res.text()), name: DRILLS[key].label, key };
        const idx = list.findIndex((r) => r.name === DRILLS[key].scenario);
        if (idx >= 0) body.querySelector("#dSc").value = String(idx);
        body.querySelector("#dName").textContent = `${drill.name}: ${drill.rows.length} people`;
      } catch (err) {
        body.querySelector("#dName").textContent = `Could not load: ${err.message}`;
      }
    };
    for (const b of body.querySelectorAll("[data-drill]")) b.onclick = () => load(b.dataset.drill);
    body.querySelector("#dFile").onchange = async (ev) => {
      try {
        const { name, text } = await readFile(ev.target);
        drill = { rows: drillFromCsv(text), name, key: null };
        body.querySelector("#dName").textContent = `${name}: ${drill.rows.length} people`;
        s.audit("import", "drill record", name);
      } catch (err) {
        body.querySelector("#dName").textContent = err.message;
      }
    };
    const compare = async (target, title, params, scIdx) => {
      const runs = Number(body.querySelector("#dRuns").value);
      const seeds = Array.from({ length: runs }, (_, k) => 1 + k);
      const options = { rescue: false, sensorFaults: false, strategy: "full", params: params ?? { ...s.state.params } };
      const out = await ctx.job({ type: "runs", jobs: [{ key: "d", scenario: m.scenarios[scIdx], options }], seeds }, prog);
      const cmp = ctx.E.compareWithDrill(drill.rows, out.d.results);
      drawDrill(target, cmp, title ?? `${drill.name} against "${list[scIdx].name}" (${runs} runs)`);
      return cmp;
    };
    body.querySelector("#dGo").onclick = async () => {
      if (busy) return;
      if (!drill.rows) return toast("Load a drill record first.", "bad");
      busy = true;
      try {
        await compare(body.querySelector("#dOut"), null, null, Number(body.querySelector("#dSc").value));
        s.audit("create", "drill check", drill.name);
      } catch (err) {
        body.querySelector("#dOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
      } finally {
        busy = false;
      }
    };
    body.querySelector("#dCal").onclick = async () => {
      if (busy) return;
      if (!drill.rows) return toast("Load a drill record first.", "bad");
      busy = true;
      const calBtn = body.querySelector("#dCal");
      calBtn.disabled = true;
      const out = body.querySelector("#dCalOut");
      out.innerHTML = '<p class="small muted">Running 60 runs…</p>';
      try {
        const scIdx = Number(body.querySelector("#dSc").value);
        const grid = { speed: [0.8, 0.9, 1.0, 1.1, 1.2], delay: [0.75, 1.0, 1.25, 1.5] };
        const seeds = [1, 2, 3];
        const options = { rescue: false, sensorFaults: false, strategy: "full", params: { ...s.state.params } };
        const cal = await ctx.job({ type: "calibrate", scenario: m.scenarios[scIdx], rows: drill.rows, options, grid, seeds }, prog);
        s.audit("create", "calibration", `${drill.name}: speed x${cal.best.speed}, delay x${cal.best.delay}`);
        const other = drill.key === "b" ? "a" : drill.key === "a" ? "b" : null;
        out.innerHTML = `<div class="card stack"><h2>Calibration on ${esc(drill.name)}</h2>
          <div class="grid2"><div><div id="dMap"></div><p class="small muted">Each cell: fit by group (lower is better), 3 runs per cell. The outlined cell is the best.</p></div>
          <div class="stack"><div class="stat"><span class="lab">Best pair</span><span class="big">speed ×${cal.best.speed}, delay ×${cal.best.delay}</span><span class="small muted">fit ${cal.best.fit}% · curve error ${cal.best.rmse} people</span></div>
          <p class="small">Pairs within 15% of the best: ${cal.close.map((c) => `×${c.speed}/×${c.delay}`).join(", ")}.</p>
          <p class="note">Walking speed and delay can make up for each other, and runs differ from seed to seed, so one drill rarely pins both down. Check the result on a second drill before using it.</p>
          ${other ? `<button class="btn primary" id="dHoldBtn">Check on ${esc(DRILLS[other].label)} (not used for fitting)</button>` : '<p class="small muted">Load the second example drill to check the calibration on a drill not used for fitting.</p>'}
          <button class="btn" id="dApply">Use these values in Settings</button></div></div></div>`;
        heatmap(out.querySelector("#dMap"), { cells: cal.tried.map((c) => ({ x: c.speed, y: c.delay, v: c.fit })), best: { x: cal.best.speed, y: cal.best.delay }, fmt: (v) => v.toFixed(1), xLabel: "Walking speed scale", yLabel: "Delay scale", xName: "speed", yName: "delay", vName: "fit %" });
        out.querySelector("#dApply").onclick = async () => {
          if (!(await confirmBox(`Scale walking speeds by ${cal.best.speed} and delays by ${cal.best.delay} for every simulation? You can undo it in Settings.`, "Use values"))) return;
          s.state.params = ctx.E.scaledParams(s.state.params, cal.best.speed, cal.best.delay);
          s.audit("update", "parameters", `calibrated from ${drill.name}`);
          toast("Calibrated values are in use. See Settings / Profile.");
        };
        const hb = out.querySelector("#dHoldBtn");
        if (hb) hb.onclick = async () => {
          if (busy) return;
          busy = true;
          try {
            await load(other);
            const idx = list.findIndex((r) => r.name === DRILLS[other].scenario);
            const hold = body.querySelector("#dHold");
            hold.innerHTML = '<div id="dH1"></div><div id="dH2"></div>';
            const before = await compare(hold.querySelector("#dH1"), `${DRILLS[other].label} with the default values`, null, idx);
            const after = await compare(hold.querySelector("#dH2"), `${DRILLS[other].label} with the calibrated values (speed ×${cal.best.speed}, delay ×${cal.best.delay})`, ctx.E.scaledParams(s.state.params, cal.best.speed, cal.best.delay), idx);
            const p = document.createElement("p");
            p.className = after.fit < before.fit ? "note ok" : "note";
            p.textContent = after.fit < before.fit ? `On the drill it was not fitted to, the calibrated values fit better: ${before.fit}% to ${after.fit}% (curve error ${before.rmse} to ${after.rmse} people).` : `On the drill it was not fitted to, the calibrated values do not fit better (${before.fit}% to ${after.fit}%). Do not use them as they are.`;
            hold.prepend(p);
          } catch (err) {
            body.querySelector("#dHold").innerHTML = `<p class="note">${esc(err.message)}</p>`;
          } finally {
            busy = false;
          }
        };
      } catch (err) {
        out.innerHTML = `<p class="note">${esc(err.message)}</p>`;
      } finally {
        busy = false;
        calBtn.disabled = false;
      }
    };
  }

  function drawDrill(target, cmp, title) {
    const o = cmp.observedStats;
    const sm = cmp.simulatedStats;
    const id = `ch${Math.random().toString(36).slice(2, 8)}`;
    target.innerHTML = `<div class="card stack" style="margin-bottom:12px"><h3>${esc(title)}</h3>
      <div class="stats">
        ${[["T50", o.t50, sm.t50, cmp.errors.t50], ["T90", o.t90, sm.t90, cmp.errors.t90], ["Last out", o.last, sm.last, cmp.errors.last]].map(([k, a, b, e]) => `<div class="stat"><span class="lab">${k}: drill / model</span><span class="big" style="font-size:18px">${fmtS(a)} / ${fmtS(b)}</span><span class="small" style="color:${e !== null && Math.abs(e) > 10 ? "var(--bad-ink)" : "var(--tx2)"}">${e === null ? "" : `${e > 0 ? "+" : ""}${e}%`}</span></div>`).join("")}
        <div class="stat"><span class="lab">Curve error</span><span class="big" style="font-size:18px">${cmp.rmse} people</span><span class="small muted">${cmp.inside}% of the drill inside the range of runs</span></div>
        <div class="stat"><span class="lab">Fit by group</span><span class="big" style="font-size:18px">${cmp.fit}%</span><span class="small muted">lower is better</span></div>
      </div>
      <div class="grid2"><div id="${id}"></div><div>${table([{ label: "Group", get: (r) => GROUP[r.g] ?? r.g }, { label: "People", n: true, get: (r) => r.people }, { label: "Error", n: true, get: (r) => r.rmse }, { label: "% of group", n: true, get: (r) => `${r.percent}%` }], Object.entries(cmp.groups).map(([g, v]) => ({ g, ...v })), { empty: "The record has no kind or mobility columns." })}
      ${table([{ label: "Exit", get: (r) => r.exit }, { label: "Drill", n: true, get: (r) => r.observed }, { label: "Model (mean)", n: true, get: (r) => r.simulated }], cmp.exits)}</div></div></div>`;
    lineChart(target.querySelector(`#${id}`), {
      height: 230,
      series: [{ name: "Drill record", color: "#1E3A5F", points: cmp.grid.map((t, i) => [t, cmp.observed[i]]) }, { name: "Model, mean of runs", color: "#0B7A4B", points: cmp.grid.map((t, i) => [t, cmp.mean[i]]) }],
      band: { low: cmp.grid.map((t, i) => [t, cmp.low[i]]), high: cmp.grid.map((t, i) => [t, cmp.high[i]]), color: "#0B7A4B", name: "Range of runs" },
      xLabel: "Time after the alarm (s)", yLabel: "People out", xName: "t =", yFmt: (v) => `${Math.round(v)}`,
    });
  }

  // ---------------------------------------------------------- sensor recording
  function replayTab() {
    body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(260px,1fr) minmax(0,2fr)">
      <div class="card stack">
        <h2>Replay recorded sensor readings</h2>
        <p class="small">Upload a recording from the building's sensors (columns: sensor, t, value) and the live estimator finds where the fire started and how fast smoke spread, every 10 seconds, as it would during a real fire.</p>
        <button class="btn" id="rpEx">Use the example: kitchen fire recording</button>
        <label class="btn" for="rpFile" style="justify-self:start">Upload readings CSV</label><input type="file" id="rpFile" accept=".csv,text/csv" hidden>
        <label class="f">Design smoke speed used as the starting guess (m/s)<input type="number" id="rpRate" min="0.01" max="1" step="0.01" value="0.08"></label>
        <p class="small muted">The example is <b>made up</b> with this simulator (kitchen fire, sensor faults on). In the main app the same estimator reads the live sensor feed or a CSV upload.</p>
      </div>
      <div class="card" id="rpOut"><p class="empty">Choose a recording.</p></div>
    </div>`;
    const run = (text, label) => {
      const out = body.querySelector("#rpOut");
      try {
        const m = ctx.model();
        const rows = readingsFromCsv(text);
        const rate = Math.max(0.01, Math.min(1, Number(body.querySelector("#rpRate").value) || 0.08));
        const r = ctx.E.replayReadings(m, rows, s.state.params, { designRate: rate });
        const lastC = [...r.checks].reverse().find((c) => c.origin !== null);
        const first = r.checks.find((c) => c.origin !== null);
        out.innerHTML = `<div class="stats">${stat(label, "File", `${rows.length} readings, ${r.detections.length} detections${r.unknown.length ? `, ${r.unknown.length} unknown sensors ignored` : ""}`)}${stat(lastC ? m.nodes[lastC.origin].id : "–", "Estimated origin", first ? `first estimate at ${fmtS(first.t)}` : "")}${stat(lastC ? `${lastC.rate.toFixed(3)} m/s` : "–", "Estimated smoke speed")}</div><h3 style="margin-top:12px">Estimated speed over time</h3><div id="rpChart"></div>`;
        lineChart(out.querySelector("#rpChart"), { series: [{ name: "Estimated speed", color: "#0B7A4B", points: r.checks.filter((c) => c.rate !== null).map((c) => [c.t, c.rate]) }, { name: "Design speed (starting guess)", color: "#64748B", dash: "4 4", points: r.checks.filter((c) => c.rate !== null).map((c) => [c.t, rate]) }], xLabel: "Time in the recording (s)", yLabel: "m/s", xName: "t =", yFmt: (v) => v.toFixed(3), empty: "No sensor in the file passed its alarm level." });
        s.audit("import", "sensor recording", label);
      } catch (err) {
        out.innerHTML = `<p class="note">${esc(err.message)}</p>`;
      }
    };
    body.querySelector("#rpEx").onclick = async () => {
      try {
        const res = await fetch("examples/sensor-readings-kitchen.csv");
        if (!res.ok) throw new Error(`examples/sensor-readings-kitchen.csv: ${res.status}`);
        run(await res.text(), "Example kitchen fire");
      } catch (err) {
        body.querySelector("#rpOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
      }
    };
    body.querySelector("#rpFile").onchange = async (ev) => {
      try {
        const { name, text } = await readFile(ev.target);
        run(text, name);
      } catch (err) {
        body.querySelector("#rpOut").innerHTML = `<p class="note">${esc(err.message)}</p>`;
      }
    };
  }

  const open = () => {
    for (const b of main.querySelectorAll("[data-t]")) b.setAttribute("aria-selected", String(b.dataset.t === tab));
    if (tab === "history") history();
    else if (tab === "drill") drillTab();
    else replayTab();
  };
  for (const b of main.querySelectorAll("[data-t]")) b.onclick = () => {
    tab = b.dataset.t;
    open();
  };
  open();
}
