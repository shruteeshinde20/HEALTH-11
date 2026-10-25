// Onboarding wizard: 1) hospital, 2) building and floors, 3) floor graph, 4) first simulation.
import { esc, header, toast, fmtS } from "../ui.js";
import { runFeatures, METHOD_LABEL } from "./shared.js";

export async function render(main, ctx) {
  const s = ctx.store;
  let step = 1;
  const draw = () => {
    const h = s.hospital();
    const b = s.building();
    const m = ctx.model();
    const steps = ["Create hospital", "Building and floors", "Floor graph", "First simulation"];
    main.innerHTML = `${header("Get started", "Four steps to set up a hospital. The demo hospital is already filled in; check each step and continue.")}
    <div class="wizard-steps">${steps.map((t, i) => `<span class="${i + 1 === step ? "on" : i + 1 < step ? "done" : ""}">${i + 1}. ${esc(t)}</span>`).join("")}</div>
    <div class="card stack" id="wbody"></div>
    <div class="row"><button class="btn" id="back" ${step === 1 ? "disabled" : ""}>Back</button><button class="btn primary" id="next">${step === 4 ? "Finish" : "Continue"}</button></div>`;
    const body = main.querySelector("#wbody");
    if (step === 1) {
      body.innerHTML = `<h2>Hospital</h2>
        <label class="f">Hospital name<input type="text" id="hn" maxlength="120" value="${esc(h.name)}"></label>
        <label class="f">City or campus<input type="text" id="hc" maxlength="120" value="${esc(h.city)}"></label>
        <p class="small muted">The demo hospital uses a made-up layout; a real hospital enters or imports its own plans.</p>`;
    } else if (step === 2) {
      body.innerHTML = `<h2>Building and floors</h2>
        <label class="f">Building name<input type="text" id="bn" maxlength="120" value="${esc(b.name)}"></label>
        <p>${m.floors.length} floors (ground to floor ${m.floors[m.floors.length - 1]}), ${m.nodes.length} places, ${m.edges.filter((e) => !e.virtual).length} paths, ${m.exits.length} exits.</p>
        <p class="small muted">Floors come from the places in the floor graph. Add or change them in the Graph Builder.</p>`;
    } else if (step === 3) {
      const beds = m.people.filter((p) => p.mobility !== "ambulatory" && p.kind === "patient").length;
      body.innerHTML = `<h2>Floor graph</h2>
        <p>The building is ready: rooms, corridors, three protected stairs, two evacuation lifts, refuges in each fire compartment, ${m.sensors.length} sensors and ${m.cameras.length} people-counting cameras.</p>
        <p>${m.people.filter((p) => p.kind === "patient").length} patients (${beds} need a wheelchair or a bed) and ${m.people.filter((p) => p.kind === "staff").length} staff are placed.</p>
        <div class="row"><a class="btn" href="#/graph">Open the Graph Builder</a><a class="btn" href="#/people">Open Patients &amp; Staff</a></div>`;
    } else {
      body.innerHTML = `<h2>First simulation</h2>
        <p>Run a quick evacuation drill (no fire) with the hazard-aware method to check that everyone can get out.</p>
        <div class="row"><button class="btn primary" id="runFirst">Run the drill now</button><span class="small muted" id="firstOut"></span></div>`;
      body.querySelector("#runFirst").onclick = async () => {
        const out = body.querySelector("#firstOut");
        out.textContent = "Running…";
        await new Promise((r) => setTimeout(r, 30));
        const raw = s.data().scenarios.find((x) => x.origin === null) ?? s.data().scenarios[0];
        const sc = m.scenarios[s.data().scenarios.indexOf(raw)];
        const r = ctx.E.simulate(m, sc, { seed: 1, method: "proposed", sensorFaults: false });
        s.addRun(r, { scenario: raw.name, method: "proposed", methodLabel: METHOD_LABEL.proposed, seed: 1, features: runFeatures(m, raw, "proposed") });
        out.textContent = `${r.safe} of ${r.total} people reached safety; last at ${fmtS(r.lastSafe)}. Saved in Reports & History.`;
      };
    }
    main.querySelector("#back").onclick = () => {
      step = Math.max(1, step - 1);
      draw();
    };
    main.querySelector("#next").onclick = () => {
      if (step === 1) {
        const name = main.querySelector("#hn").value.trim();
        if (!name) return toast("Enter the hospital name.", "bad");
        if (name !== h.name || main.querySelector("#hc").value.trim() !== h.city) {
          h.name = name.slice(0, 120);
          h.city = main.querySelector("#hc").value.trim().slice(0, 120);
          s.audit("update", "hospital", h.name);
        }
      }
      if (step === 2) {
        const bn = main.querySelector("#bn").value.trim();
        if (bn && bn !== b.name) {
          b.name = bn.slice(0, 120);
          s.audit("update", "building", b.name);
        }
      }
      if (step === 4) {
        s.state.onboarded = true;
        s.save();
        toast("Setup finished.");
        ctx.go("dashboard");
        return;
      }
      step++;
      draw();
    };
  };
  draw();
}
