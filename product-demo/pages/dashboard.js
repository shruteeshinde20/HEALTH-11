// Dashboard: the building at a glance, recent simulations, AI features, alerts.
import { esc, header, stat, table, fmtS, fmtMin, pill, f2 } from "../ui.js";
import { predictor, anomalies, runFeatures, recommendations } from "./shared.js";

export function render(main, ctx) {
  const s = ctx.store;
  const m = ctx.model();
  const runs = s.state.runs;
  const last = runs[0];
  const patients = m.people.filter((p) => p.kind === "patient");
  const visitors = m.cameras.reduce((a, c) => a + c.count, 0);
  const needHelp = patients.filter((p) => p.mobility !== "ambulatory").length;
  const pred = predictor(runs);
  const anom = anomalies(runs);
  const h = s.hospital();
  const planner = ctx.can("live");
  main.innerHTML = `${header("Dashboard", `${esc(h.name)}, ${esc(h.city)} · ${esc(s.building().name)}`, ctx.can("scenarios") ? `<a class="btn primary" href="#/live">Run new simulation</a>` : planner ? `<a class="btn primary" href="#/live">Open Live Simulation</a>` : "")}
  <div class="stats">
    ${stat(s.state.hospitals.filter((x) => !x.deleted).length, "Hospitals")}
    ${stat(m.floors.length, "Floors", `${m.nodes.length} places`)}
    ${stat(s.data().scenarios.length, "Scenarios")}
    ${stat(patients.length + m.people.filter((p) => p.kind === "staff").length + visitors, "People in the building", `${patients.length} patients, ${needHelp} need help`)}
    ${stat(last ? fmtMin(last.summary.lastSafe) : "–", "Last evacuation time", last ? esc(last.scenario) : "No run yet")}
    ${stat(last ? (last.summary.busiest ?? []).filter((x) => x.maxDensity >= 1.5).length : "–", "Bottlenecks in the last run")}
  </div>
  <div class="grid2">
    <div class="card">
      <h2>Recent simulations</h2>
      ${table(
        [
          { label: "When", get: (r) => new Date(r.at).toLocaleString() },
          { label: "Scenario", get: (r) => r.scenario },
          { label: "Method", get: (r) => r.methodLabel },
          { label: "Safe", n: true, get: (r) => `${r.summary.safe}/${r.summary.total}` },
          { label: "T90", n: true, get: (r) => fmtS(r.summary.t90) },
          { label: "Harmed", n: true, get: (r) => r.summary.harmed },
        ],
        runs.slice(0, 8).map((r) => ({ ...r, _attrs: `class="click" data-run="${r.id}"` })),
        { empty: "No simulations yet. Open Live Simulation and run a scenario." },
      )}
    </div>
    <div class="stack">
      <div class="card">
        <h2>Evacuation-time predictor <span class="pill pri">machine learning</span></h2>
        ${pred.ready
          ? `<p>Predicted time until 90% are safe for the ICU-fire scenario with the hazard-aware method: <b>${fmtS(pred.predict(runFeatures(m, s.data().scenarios[0], "proposed")))}</b></p>
             <p class="small muted">A straight-line model trained on ${pred.have - pred.test} of your stored runs and tested on ${pred.test} held-out runs: mean error ${fmtS(pred.mae)}, R² ${f2(pred.r2)}. It imitates this simulator (a surrogate); it is not a measurement of real evacuations.</p>`
          : `<p class="note">More data needed: ${pred.have} of ${pred.need} completed runs. ${esc(pred.note ?? "")} Run more scenarios (Live Simulation or Algorithm Comparison saves them).</p>`}
        <details class="small" style="margin-top:8px"><summary>About this prediction</summary><p style="margin-top:6px">Inputs: number of people, smoke spread speed, share of bed patients and whether the hazard-aware method is used. The model is a least-squares line. One run in four is kept back for testing, and the error shown is from those runs only. With few or very similar runs the numbers are unreliable.</p></details>
      </div>
      <div class="card">
        <h2>Alerts</h2>
        ${anom.ready
          ? anom.flagged.length
            ? anom.flagged.slice(0, 5).map((a) => `<p>${pill("Unusual run", "pri")} ${esc(a.run.scenario)} at ${new Date(a.run.at).toLocaleString()}</p>`).join("")
            : `<p class="small">No unusual runs among ${anom.have}.</p>`
          : `<p class="note">More data needed for unusual-run alerts: ${anom.have} of ${anom.need} runs.</p>`}
        ${last ? recommendations(last.summary, m).slice(0, 2).map((r) => `<p class="small" style="margin-top:6px">${pill(r.tone === "bad" ? "Safety" : r.tone === "warn" ? "Bottleneck" : "Note", r.tone === "bad" ? "bad" : r.tone === "warn" ? "warn" : "pri")} ${esc(r.text)}</p>`).join("") : ""}
      </div>
    </div>
  </div>
  <div class="card">
    <h2>Research gaps in this product</h2>
    <div class="grid3">
      ${[
        ["Gap 1", "Patients who cannot walk", "people", "Staff escort wheelchair and bed patients; refuges; no stairs for beds."],
        ["Gap 2", "Drill check", "reports", "Compare with a drill record; calibrate; test on a second drill."],
        ["Gap 3", "Smoke and crowding together", "compare", "One route cost: travel time in the crowd plus smoke dose on arrival."],
        ["Gap 4", "Imperfect information", "scenarios", "Sensor faults, phones, compliance and failing signs per scenario."],
        ["Gap 5", "Live fire data", "live", "Live estimate of origin and spread speed from sensor readings."],
      ].map(([g, t, p, d]) => `<div><span class="gap-chip">${g}</span> <b>${esc(t)}</b><p class="small">${esc(d)} ${ctx.can(p) ? `<a href="#/${p}">Open</a>` : ""}</p></div>`).join("")}
    </div>
  </div>`;
  for (const tr of main.querySelectorAll("[data-run]")) tr.addEventListener("click", () => {
    ctx.pending.run = Number(tr.dataset.run);
    ctx.go("reports");
  });
}
