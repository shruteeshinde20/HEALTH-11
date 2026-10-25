// Facility Manager: hospitals, buildings and floors.
import { esc, header, table, toast, confirmBox, floorName } from "../ui.js";

export function render(main, ctx) {
  const s = ctx.store;
  const draw = () => {
    const hs = s.state.hospitals.filter((h) => !h.deleted);
    const cur = s.hospital();
    const b = s.building();
    const m = ctx.model();
    const floorRows = m.floors.map((f) => {
      const ns = m.nodes.filter((n) => n.floor === f);
      const at = new Set(ns.map((n) => n.i));
      const pts = m.people.filter((p) => at.has(p.home));
      return {
        f,
        places: ns.length,
        area: Math.round(ns.reduce((a, n) => a + n.area, 0)),
        patients: pts.filter((p) => p.kind === "patient").length,
        help: pts.filter((p) => p.kind === "patient" && p.mobility !== "ambulatory").length,
        staff: pts.filter((p) => p.kind === "staff").length,
        sensors: m.sensors.filter((x) => at.has(x.node)).length,
        refuges: ns.filter((n) => n.refuge).length,
        exits: ns.filter((n) => n.type === "exit").length,
      };
    });
    main.innerHTML = `${header("Facility Manager", "Hospitals, their buildings and floors. Choose which building the other pages work on.")}
    <div class="grid2">
      <div class="card stack">
        <h2>Hospitals</h2>
        ${table(
          [
            { label: "Name", get: (h) => h.name },
            { label: "City", get: (h) => h.city },
            { label: "Buildings", n: true, get: (h) => h.buildings.filter((x) => !x.deleted).length },
            { label: "", html: true, get: (h) => `${h.id === cur.id ? '<span class="pill ok">In use</span>' : `<button class="btn sm" data-use="${h.id}">Use</button>`} <button class="btn sm danger" data-delh="${h.id}">Delete</button>` },
          ],
          hs,
        )}
        <form id="addH" class="row" novalidate>
          <input type="text" id="hName" placeholder="Hospital name" maxlength="120" aria-label="Hospital name" style="flex:2">
          <input type="text" id="hCity" placeholder="City" maxlength="120" aria-label="City" style="flex:1">
          <button class="btn primary" type="submit">Add hospital</button>
        </form>
        <p class="small muted">A new hospital starts with a copy of the demo building so you can explore; a real hospital imports its own plans in the Graph Builder.</p>
      </div>
      <div class="card stack">
        <h2>Buildings of ${esc(cur.name)}</h2>
        ${table(
          [
            { label: "Building", get: (x) => x.name },
            { label: "Floors", n: true, get: (x) => new Set(x.data.places.map((p) => p.floor ?? 0)).size },
            { label: "Places", n: true, get: (x) => x.data.places.length },
            { label: "", html: true, get: (x) => `${x.id === b.id ? '<span class="pill ok">In use</span>' : `<button class="btn sm" data-useb="${x.id}">Use</button>`} <button class="btn sm danger" data-delb="${x.id}">Delete</button>` },
          ],
          cur.buildings.filter((x) => !x.deleted),
        )}
        <form id="addB" class="row" novalidate>
          <input type="text" id="bName" placeholder="Building name" maxlength="120" aria-label="Building name" style="flex:1">
          <button class="btn primary" type="submit">Add building</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>Floors of ${esc(b.name)}</h2>
      ${table(
        [
          { label: "Floor", get: (r) => floorName(r.f) },
          { label: "Places", n: true, get: (r) => r.places },
          { label: "Area m²", n: true, get: (r) => r.area },
          { label: "Patients", n: true, get: (r) => r.patients },
          { label: "Need help", n: true, get: (r) => r.help },
          { label: "Staff", n: true, get: (r) => r.staff },
          { label: "Sensors", n: true, get: (r) => r.sensors },
          { label: "Refuges", n: true, get: (r) => r.refuges },
          { label: "Exits", n: true, get: (r) => r.exits },
          { label: "", html: true, get: (r) => `<a class="btn sm" href="#/graph" data-floor="${r.f}">Open map</a>` },
        ],
        floorRows,
      )}
    </div>`;
    main.querySelector("#addH").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = main.querySelector("#hName").value.trim();
      if (!name) return toast("Enter the hospital name.", "bad");
      const id = s.newId();
      s.state.hospitals.push({ id, name: name.slice(0, 120), city: main.querySelector("#hCity").value.trim().slice(0, 120), deleted: false, buildings: [{ id: s.newId(), name: "Main Block", deleted: false, data: structuredClone(s.state.hospitals[0].buildings[0].data) }] });
      s.audit("create", "hospital", name);
      toast(`Added ${name}`);
      draw();
    });
    main.querySelector("#addB").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = main.querySelector("#bName").value.trim();
      if (!name) return toast("Enter the building name.", "bad");
      cur.buildings.push({ id: s.newId(), name: name.slice(0, 120), deleted: false, data: structuredClone(b.data) });
      s.audit("create", "building", `${cur.name} / ${name}`);
      toast(`Added ${name} (a copy of ${b.name} to start from)`);
      draw();
    });
    main.onclick = async (ev) => {
      const t = ev.target.closest("button,a");
      if (!t) return;
      if (t.dataset.use) {
        s.state.current = { hospital: Number(t.dataset.use), building: s.state.hospitals.find((h) => h.id === Number(t.dataset.use)).buildings.find((x) => !x.deleted)?.id };
        s.audit("update", "selection", `hospital ${t.dataset.use}`);
        draw();
      } else if (t.dataset.useb) {
        s.state.current.building = Number(t.dataset.useb);
        s.audit("update", "selection", `building ${t.dataset.useb}`);
        draw();
      } else if (t.dataset.delh) {
        const h = s.state.hospitals.find((x) => x.id === Number(t.dataset.delh));
        if (s.state.hospitals.filter((x) => !x.deleted).length === 1) return toast("Keep at least one hospital.", "bad");
        if (!(await confirmBox(`Delete ${h.name}? It is hidden (soft delete) and stays in the audit log.`))) return;
        h.deleted = true;
        if (s.state.current.hospital === h.id) s.state.current = { hospital: s.state.hospitals.find((x) => !x.deleted).id, building: null };
        s.audit("delete", "hospital", h.name);
        draw();
      } else if (t.dataset.delb) {
        const bb = cur.buildings.find((x) => x.id === Number(t.dataset.delb));
        if (cur.buildings.filter((x) => !x.deleted).length === 1) return toast("Keep at least one building.", "bad");
        if (!(await confirmBox(`Delete ${bb.name}?`))) return;
        bb.deleted = true;
        s.audit("delete", "building", bb.name);
        draw();
      } else if (t.dataset.floor !== undefined) {
        ctx.pending.floor = Number(t.dataset.floor);
      }
    };
  };
  draw();
}
