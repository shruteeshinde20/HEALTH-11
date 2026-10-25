// Graph Builder: edit places (nodes) and paths (edges) on the floor plan.
import { esc, header, toast, confirmBox, option, floorName, download, readFile, table } from "../ui.js";
import { createPlan2D } from "../plan2d.js";
import { rectOf } from "../layout.js";

const TYPES = ["room", "ward", "icu", "corridor", "stair", "lift", "exit"];

export function render(main, ctx) {
  const s = ctx.store;
  let floor = ctx.pending.floor ?? 0;
  delete ctx.pending.floor;
  let selected = null; // place id (string)
  let mode = "select";
  let pendingA = null;
  let plan = null;

  const draw = () => {
    const m = ctx.model();
    const readOnly = ctx.readOnly();
    main.innerHTML = `${header("Graph Builder", "Places (rooms, corridors, stairs, lifts, exits) and the paths between them, drawn to scale. Click a place to edit it.", `<button class="btn" id="exportJ">Export JSON</button><label class="btn" for="importJ">Import JSON</label><input type="file" id="importJ" accept=".json,application/json" hidden>`)}
    <div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr)">
      <div class="card stage" style="padding:0">
        <div class="stage-bar">
          <select id="gFloor" aria-label="Floor" style="width:auto">${m.floors.map((f) => option(f, floorName(f), f === floor)).join("")}</select>
          <div class="seg" role="group" aria-label="Tool">
            <button data-mode="select" aria-pressed="${mode === "select"}">Select</button>
            <button data-mode="path" aria-pressed="${mode === "path"}">Add path</button>
          </div>
          <span class="small muted" id="modeHint">${mode === "path" ? (pendingA ? `Now click the second place to join to ${esc(pendingA)}.` : "Click the first place of the new path.") : "Click a place to see and change it."}</span>
        </div>
        <div class="view" style="height:min(70vh,640px)"><div class="layer" id="gPlan"></div></div>
      </div>
      <div class="stack">
        <div class="card stack" id="gSide"></div>
        <div class="card stack">
          <h2>Add a place on ${floorName(floor)}</h2>
          <form id="addP" class="stack" novalidate>
            <label class="f">Name<input type="text" id="apName" maxlength="80"></label>
            <div class="row"><label class="f" style="flex:1">Type<select id="apType">${TYPES.map((t) => option(t, t)).join("")}</select></label>
            <label class="f" style="flex:1">Width m<input type="number" id="apW" value="6" min="1" max="200" step="0.1"></label>
            <label class="f" style="flex:1">Length m<input type="number" id="apL" value="6" min="1" max="200" step="0.1"></label></div>
            <div class="row"><label class="f" style="flex:1">x (m, east)<input type="number" id="apX" value="50" step="0.1"></label><label class="f" style="flex:1">y (m, south)<input type="number" id="apY" value="50" step="0.1"></label></div>
            <button class="btn primary" type="submit" ${readOnly ? "disabled" : ""}>Add place</button>
          </form>
        </div>
        <div class="card stack" id="gCheck"></div>
      </div>
    </div>`;
    plan = createPlan2D(main.querySelector("#gPlan"), m, {
      onClick: (n) => {
        if (!n) return;
        if (mode === "path") {
          if (!pendingA) {
            pendingA = n.id;
            draw();
            return;
          }
          if (pendingA === n.id) return;
          addPath(pendingA, n.id);
          pendingA = null;
          return;
        }
        selected = n.id;
        side();
        plan.update({ selected: n.i, pending: null });
      },
    });
    plan.setLayers({ sensors: false, signs: false, routes: false, predicted: false, hazard: false });
    plan.setFloor(floor);
    plan.update({ selected: selected !== null ? m.index.get(selected) ?? null : null, pending: pendingA !== null ? m.index.get(pendingA) : null, snapshot: { people: [], hazard: [], predicted: [], signs: [], routes: [], teams: [], sensors: [], density: [], t: 0 } });
    main.querySelector("#gFloor").onchange = (ev) => {
      floor = Number(ev.target.value);
      selected = null;
      draw();
    };
    for (const b of main.querySelectorAll("[data-mode]")) b.onclick = () => {
      mode = b.dataset.mode;
      pendingA = null;
      draw();
    };
    main.querySelector("#addP").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = main.querySelector("#apName").value.trim();
      if (!name) return toast("Enter a name for the place.", "bad");
      try {
        s.updateData((d) => {
          if (d.places.some((p) => p.id === name)) throw new Error(`A place called "${name}" exists already`);
          d.places.push({ id: name, type: main.querySelector("#apType").value, x: Number(main.querySelector("#apX").value), y: Number(main.querySelector("#apY").value), w: Number(main.querySelector("#apW").value), l: Number(main.querySelector("#apL").value), floor, compartment: "main" });
        }, "create", `place ${name}`);
        selected = name;
        toast(`Added ${name}. Join it with "Add path".`);
        draw();
      } catch (err) {
        toast(err.message, "bad");
      }
    });
    main.querySelector("#exportJ").onclick = () => {
      download(`${s.building().name.replace(/[^A-Za-z0-9]+/g, "-")}.json`, JSON.stringify(s.data(), null, 1), "application/json");
      s.audit("export", "building", "JSON");
    };
    main.querySelector("#importJ").onchange = async (ev) => {
      try {
        const { name, text } = await readFile(ev.target);
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("The file is not valid JSON");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The JSON file must hold one building object");
        if (!(await confirmBox(`Replace the floor plan of ${s.building().name} with ${name}? Patients, staff and scenarios in the file replace the current ones.`, "Replace"))) return;
        s.updateData((d) => {
          for (const k of Object.keys(d)) delete d[k];
          Object.assign(d, data, { scenarios: data.scenarios ?? [] });
        }, "import", `building from ${name}`);
        selected = null;
        floor = 0;
        toast(`Imported ${name}`);
        draw();
      } catch (err) {
        toast(`Not imported: ${err.message}`, "bad");
      }
    };
    side();
    check();
  };

  function addPath(a, b) {
    const m = ctx.model();
    const A = m.nodes[m.index.get(a)];
    const B = m.nodes[m.index.get(b)];
    const length = Math.round((Math.abs(A.x - B.x) + Math.abs(A.y - B.y) + Math.abs(A.floor - B.floor) * 4) * 10) / 10 || 1;
    try {
      s.updateData((d) => {
        if (d.paths.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))) throw new Error(`${a} and ${b} are joined already`);
        d.paths.push({ a, b, length, width: 1.2 });
      }, "create", `path ${a} - ${b}`);
      toast(`Joined ${a} and ${b} (${length} m). Edit the width and access in the panel.`);
      selected = a;
      draw();
    } catch (err) {
      toast(err.message, "bad");
      draw();
    }
  }

  function side() {
    const box = main.querySelector("#gSide");
    const m = ctx.model();
    const d = s.data();
    const readOnly = ctx.readOnly();
    if (selected === null || !m.index.has(selected)) {
      box.innerHTML = `<h2>Place</h2><p class="small muted">Click a place on the plan. Colours: corridors grey, wards blue-white, refuges green, stairs and lifts beige, exits green.</p>`;
      return;
    }
    const raw = d.places.find((p) => p.id === selected);
    const n = m.nodes[m.index.get(selected)];
    const paths = d.paths.map((p, i) => ({ ...p, i })).filter((p) => p.a === selected || p.b === selected);
    const people = m.people.filter((p) => p.home === n.i);
    box.innerHTML = `<h2>${esc(selected)}</h2>
      <p class="small muted">${esc(floorName(n.floor))} · ${Math.round(n.area)} m² · crowd limit ${n.capacity} people · ${people.length} placed here</p>
      <form id="pf" class="stack" novalidate>
        <div class="row"><label class="f" style="flex:1">Type<select id="pType">${TYPES.map((t) => option(t, t, t === raw.type)).join("")}</select></label>
        <label class="f" style="flex:1">Compartment<input type="text" id="pComp" maxlength="40" value="${esc(raw.compartment ?? "")}"></label></div>
        <div class="row"><label class="f" style="flex:1">Width m<input type="number" id="pW" value="${raw.w}" step="0.1" min="0.5"></label><label class="f" style="flex:1">Length m<input type="number" id="pL" value="${raw.l}" step="0.1" min="0.5"></label></div>
        <div class="row"><label class="f" style="flex:1">x<input type="number" id="pX" value="${raw.x}" step="0.1"></label><label class="f" style="flex:1">y<input type="number" id="pY" value="${raw.y}" step="0.1"></label></div>
        <div class="checks">
          <label><input type="checkbox" id="pRef" ${raw.refuge ? "checked" : ""}> Refuge (protected safe room)</label>
          <label><input type="checkbox" id="pSign" ${raw.sign ? "checked" : ""}> Has a dynamic exit sign</label>
          <label><input type="checkbox" id="pLift" ${raw.evacLift ? "checked" : ""} ${raw.type !== "lift" ? "disabled" : ""}> Evacuation lift (usable in a fire)</label>
          <label><input type="checkbox" id="pBlock" ${raw.blocked ? "checked" : ""}> Blocked (out of use)</label>
        </div>
        <div class="row"><button class="btn primary" type="submit" ${readOnly ? "disabled" : ""}>Save</button><button class="btn danger" type="button" id="pDel" ${readOnly ? "disabled" : ""}>Delete place</button></div>
      </form>
      <h3 style="margin-top:6px">Paths from here</h3>
      ${paths.length ? paths.map((p) => `<div class="stack" style="border:1px solid var(--line);border-radius:8px;padding:8px;gap:6px" data-path="${p.i}">
        <b class="small">${esc(p.a === selected ? p.b : p.a)}</b>
        <div class="row"><label class="f" style="flex:1">Length m<input type="number" data-k="length" value="${p.length}" step="0.1" min="0.1"></label><label class="f" style="flex:1">Width m<input type="number" data-k="width" value="${p.width ?? 1.2}" step="0.1" min="0.3"></label></div>
        <div class="checks"><label><input type="checkbox" data-k="wheelchair" ${p.wheelchair === false ? "" : "checked"}> Wheelchair access</label><label><input type="checkbox" data-k="stretcher" ${p.stretcher === false ? "" : "checked"}> Bed and stretcher access</label><label><input type="checkbox" data-k="fireDoor" ${p.fireDoor ? "checked" : ""}> Fire door</label><label><input type="checkbox" data-k="blocked" ${p.blocked ? "checked" : ""}> Blocked</label></div>
        <div class="row"><button class="btn sm" data-save="${p.i}" ${readOnly ? "disabled" : ""}>Save path</button><button class="btn sm danger" data-del="${p.i}" ${readOnly ? "disabled" : ""}>Delete path</button></div>
      </div>`).join("") : '<p class="small muted">No paths. Use "Add path" to join this place.</p>'}`;
    box.querySelector("#pf").addEventListener("submit", (ev) => {
      ev.preventDefault();
      try {
        s.updateData((dd) => {
          const p = dd.places.find((x) => x.id === selected);
          p.type = box.querySelector("#pType").value;
          p.compartment = box.querySelector("#pComp").value.trim().slice(0, 40) || "main";
          for (const [k, id] of [["w", "#pW"], ["l", "#pL"], ["x", "#pX"], ["y", "#pY"]]) p[k] = Number(box.querySelector(id).value);
          p.refuge = box.querySelector("#pRef").checked;
          p.sign = box.querySelector("#pSign").checked;
          p.evacLift = p.type === "lift" && box.querySelector("#pLift").checked;
          p.blocked = box.querySelector("#pBlock").checked;
        }, "update", `place ${selected}`);
        toast(`Saved ${selected}`);
        draw();
      } catch (err) {
        toast(`Not saved: ${err.message}`, "bad");
      }
    });
    box.querySelector("#pDel").onclick = async () => {
      if (people.length) return toast(`Move the ${people.length} people placed in ${selected} first (Patients & Staff).`, "bad");
      if (!(await confirmBox(`Delete ${selected} and its ${paths.length} paths? Sensors and cameras in it are removed too.`))) return;
      try {
        s.updateData((dd) => {
          dd.places = dd.places.filter((x) => x.id !== selected);
          dd.paths = dd.paths.filter((x) => x.a !== selected && x.b !== selected);
          dd.sensors = (dd.sensors ?? []).filter((x) => x.place !== selected);
          dd.cameras = (dd.cameras ?? []).filter((x) => x.place !== selected);
          dd.scenarios = (dd.scenarios ?? []).filter((x) => x.origin !== selected).map((x) => ({ ...x, closed: (x.closed ?? []).filter((c) => c !== selected) }));
        }, "delete", `place ${selected}`);
        toast(`Deleted ${selected}`);
        selected = null;
        draw();
      } catch (err) {
        toast(`Not deleted: ${err.message}`, "bad");
      }
    };
    for (const btn of box.querySelectorAll("[data-save]")) btn.onclick = () => {
      const i = Number(btn.dataset.save);
      const card = box.querySelector(`[data-path="${i}"]`);
      try {
        s.updateData((dd) => {
          const p = dd.paths[i];
          p.length = Number(card.querySelector('[data-k="length"]').value);
          p.width = Number(card.querySelector('[data-k="width"]').value);
          for (const k of ["wheelchair", "stretcher", "fireDoor", "blocked"]) p[k] = card.querySelector(`[data-k="${k}"]`).checked;
        }, "update", `path ${s.data().paths[i].a} - ${s.data().paths[i].b}`);
        toast("Path saved");
        draw();
      } catch (err) {
        toast(`Not saved: ${err.message}`, "bad");
      }
    };
    for (const btn of box.querySelectorAll("[data-del]")) btn.onclick = async () => {
      const i = Number(btn.dataset.del);
      const p = s.data().paths[i];
      if (!(await confirmBox(`Delete the path ${p.a} - ${p.b}?`))) return;
      try {
        s.updateData((dd) => dd.paths.splice(i, 1), "delete", `path ${p.a} - ${p.b}`);
        draw();
      } catch (err) {
        toast(err.message, "bad");
      }
    };
  }

  // Which places have no way out (for walkers and for beds)?
  function check() {
    const box = main.querySelector("#gCheck");
    const m = ctx.model();
    const exits = new Set(m.exits);
    const noWalk = [];
    const noBed = [];
    for (const n of m.nodes) {
      if (n.type === "exit") continue;
      if (!ctx.E.shortestPath(m, n.i, exits, "walk")) noWalk.push(n.id);
      if (n.type !== "stair" && !ctx.E.shortestPath(m, n.i, exits, "bed")) noBed.push(n.id);
    }
    const overlaps = [];
    for (let a = 0; a < m.nodes.length; a++) for (let b = a + 1; b < m.nodes.length; b++) {
      const A = m.nodes[a];
      const B = m.nodes[b];
      if (A.floor !== B.floor) continue;
      const ra = rectOf(A);
      const rb = rectOf(B);
      if (Math.min(ra.x1, rb.x1) - Math.max(ra.x0, rb.x0) > 0.3 && Math.min(ra.y1, rb.y1) - Math.max(ra.y0, rb.y0) > 0.3) overlaps.push(`${A.id} / ${B.id}`);
    }
    box.innerHTML = `<h2>Check</h2>
      ${noWalk.length ? `<p class="note">No way out for walking people from: ${esc(noWalk.slice(0, 12).join(", "))}${noWalk.length > 12 ? "…" : ""}</p>` : '<p class="small">Every place has a way out for walking people.</p>'}
      ${noBed.length ? `<p class="note">No step-free way out for beds from: ${esc(noBed.slice(0, 12).join(", "))}${noBed.length > 12 ? "…" : ""}</p>` : '<p class="small">Every place has a step-free way out for beds and wheelchairs.</p>'}
      ${overlaps.length ? `<p class="note">Places that overlap: ${esc(overlaps.slice(0, 6).join("; "))}</p>` : ""}
      ${table([{ label: "Floor", get: (f) => floorName(f) }, { label: "Places", n: true, get: (f) => m.nodes.filter((n) => n.floor === f).length }, { label: "Exits", n: true, get: (f) => m.nodes.filter((n) => n.floor === f && n.type === "exit").length }], m.floors)}`;
  }

  draw();
}
