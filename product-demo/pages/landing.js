// Landing page (public).
import { esc } from "../ui.js";
import { createPlan2D } from "../plan2d.js";
import { placePeople, edgePolyline } from "../layout.js";

export function render(root, ctx) {
  const h = ctx.store.hospital();
  root.innerHTML = `<div class="landing">
    <section class="hero">
      <div>
        <div class="tag">Smarter Paths. Safer People. Healthier Tomorrows.</div>
        <h1>HEALTH-11: hospital evacuation planning that adapts to fire and smoke</h1>
        <p>HEALTH-11 turns a hospital's floors into a map of rooms and corridors, then plans the safest way out for every patient, staff member and visitor. It follows the fire as it spreads, helps the patients who cannot walk first, and keeps working when sensors fail or people do not follow instructions.</p>
        <p class="small muted" style="margin-top:12px">This is the end-product demo for ${esc(h?.name ?? "the hospital")}, ${esc(h?.city ?? "")}. The building, departments and people are made up for a student project.</p>
        <div class="row" style="margin-top:18px"><a class="btn primary" href="#/login">Log in to the demo</a><a class="btn" href="#/register">Create an account</a></div>
      </div>
      <div class="hero-art" aria-label="Floor 3 during a simulated fire"><div id="heroPlan"></div></div>
    </section>
    <section class="grid3">
      ${[
        ["Plan the building", "Facility Manager and Graph Builder: floors, rooms, corridors, stairs, lifts, refuges and exits, each with size and capacity."],
        ["Simulate a fire", "Scenario Builder and Live Simulation in 2D and 3D: smoke spreads, sensors detect it, people move, staff escort beds and wheelchairs."],
        ["Compare and report", "Algorithm Comparison (BFS, DFS, Dijkstra, A* and the hazard-aware method), Reports with recommendations and the drill check."],
      ].map(([t, d]) => `<div class="card"><h2>${esc(t)}</h2><p>${esc(d)}</p></div>`).join("")}
    </section>
    <section class="card">
      <h2>Five research gaps this product closes</h2>
      <div class="tbl"><table><tbody>
        <tr><td><span class="gap-chip">Gap 1</span></td><td>Patients who cannot walk: staff escort wheelchair and bed patients, two per bed; beds never use stairs; refuges in the other fire compartment.</td></tr>
        <tr><td><span class="gap-chip">Gap 2</span></td><td>Drill check: compare the model with a real drill record, tune it, and test it on a second drill.</td></tr>
        <tr><td><span class="gap-chip">Gap 3</span></td><td>Smoke and crowding together: one route cost for travel time in a crowd plus the smoke dose expected on arrival.</td></tr>
        <tr><td><span class="gap-chip">Gap 4</span></td><td>Imperfect information: broken sensors, people without phones or who do not follow guidance, failing signs, a commander who confirms alerts.</td></tr>
        <tr><td><span class="gap-chip">Gap 5</span></td><td>Live fire data: estimate where the fire started and how fast smoke spreads from live readings, and predict every room.</td></tr>
      </tbody></table></div>
    </section>
    <p class="small muted">HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals.</p>
  </div>`;
  // A small live picture: floor 3 a few minutes into the ICU fire scenario.
  try {
    const model = ctx.model();
    const sc = model.scenarios[0];
    const sim = ctx.E.createSimulation(model, sc, { seed: 3 });
    for (let k = 0; k < 330; k++) sim.step();
    const snap = sim.snapshot();
    const lines = model.edges.map((e) => edgePolyline(model, e));
    const plan = createPlan2D(document.getElementById("heroPlan"), model);
    plan.setLayers({ sensors: false, labels: true });
    plan.setFloor(3);
    plan.update({ positions: placePeople(model, snap, lines), snapshot: snap });
  } catch {
    /* the picture is decoration; the page works without it */
  }
}
