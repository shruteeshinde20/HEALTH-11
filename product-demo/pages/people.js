// Patients & Staff: who is where, how each patient moves, priority for help,
// and visitors counted by cameras. Patients are kept by code only (no names).
import { esc, header, option, toast, confirmBox, floorName, download, readFile, pill } from "../ui.js";
import { parseCsv, toCsv } from "../io.js";
import { priority, PRIORITY_WEIGHTS } from "./shared.js";

const MOB_LABEL = { ambulatory: "Walks", wheelchair: "Wheelchair", stretcher: "Bed or stretcher", ventilator: "Ventilator (bed)" };
const ROLES = ["nurse", "doctor", "porter", "staff"];

export function render(main, ctx) {
  const s = ctx.store;
  let tab = "patients";
  let filter = { floor: "all", kind: "all", q: "" };
  let scIdx = 0;
  let editing = null; // code being edited

  const draw = () => {
    const m = ctx.model();
    const d = s.data();
    const ro = ctx.readOnly();
    const fireScen = d.scenarios.map((r, i) => [r, i]).filter(([r]) => r.origin);
    if (!fireScen.some(([, i]) => i === scIdx)) scIdx = fireScen[0]?.[1] ?? 0;
    const sc = m.scenarios[scIdx];
    const placeOptions = (cur) => m.floors.map((f) => `<optgroup label="${floorName(f)}">${m.nodes.filter((n) => n.floor === f && !["exit", "stair", "lift"].includes(n.type)).map((n) => option(n.id, n.id, n.id === cur)).join("")}</optgroup>`).join("");
    const floorOf = (place) => m.nodes[m.index.get(place)]?.floor;
    const pats = m.people.filter((p) => p.kind === "patient");
    const counts = { patients: pats.length, staff: m.people.length - pats.length, visitors: m.cameras.reduce((a, c) => a + c.count, 0) };

    main.innerHTML = `${header("Patients & Staff", "Patients are stored by code only, never by name. Mobility decides how they are moved: wheelchair patients need one staff member, bed and ventilator patients two, and beds never use stairs.", `<button class="btn" id="pExp">Export CSV</button><label class="btn ${ro ? "disabled" : ""}" for="pImp" ${ro ? 'aria-disabled="true" style="opacity:.5;pointer-events:none"' : ""}>Import CSV</label><input type="file" id="pImp" accept=".csv,text/csv" hidden>`)}
    <div class="tabs-in" role="tablist">${[["patients", `Patients (${counts.patients})`], ["staff", `Staff (${counts.staff})`], ["visitors", `Visitors (${counts.visitors})`]].map(([k, v]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${v}</button>`).join("")}</div>
    <div id="pBody"></div>`;
    const body = main.querySelector("#pBody");

    const filters = (kinds) => `<div class="row" style="margin-bottom:10px">
      <select id="fFloor" aria-label="Floor" style="width:auto">${option("all", "All floors", filter.floor === "all")}${m.floors.map((f) => option(f, floorName(f), String(f) === filter.floor)).join("")}</select>
      ${kinds ? `<select id="fKind" aria-label="Kind" style="width:auto">${option("all", "All", filter.kind === "all")}${kinds.map(([k, v]) => option(k, v, k === filter.kind)).join("")}</select>` : ""}
      <input type="search" id="fQ" placeholder="Search code or place" value="${esc(filter.q)}" style="width:220px" aria-label="Search">
    </div>`;
    const match = (code, place, kind) => (filter.floor === "all" || String(floorOf(place)) === filter.floor) && (filter.kind === "all" || kind === filter.kind) && (!filter.q || `${code} ${place}`.toLowerCase().includes(filter.q.toLowerCase()));

    if (tab === "patients") {
      const rows = d.patients.filter((p) => match(p.code, p.place, p.mobility)).map((p) => {
        const mp = pats.find((x) => x.code === p.code);
        return { ...p, pr: mp ? priority(m, mp, sc) : { score: 0, parts: {} } };
      }).sort((a, b) => b.pr.score - a.pr.score);
      body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)">
        <div class="card">
          ${filters(Object.entries(MOB_LABEL))}
          <div class="row small" style="margin-bottom:8px">Priority for the scenario <select id="fSc" style="width:auto">${fireScen.map(([r, i]) => option(i, r.name, i === scIdx)).join("")}</select></div>
          <div class="tbl" style="max-height:62vh;overflow-y:auto"><table><thead><tr><th>Code</th><th>Place</th><th>Floor</th><th>Mobility</th><th class="n">Criticality</th><th class="n">Priority</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.place)}</td><td>${esc(floorName(floorOf(p.place)))}</td><td>${esc(MOB_LABEL[p.mobility] ?? p.mobility)}</td><td class="n">${p.criticality ?? 1}</td><td class="n" title="mobility ${(p.pr.parts.mobility ?? 0).toFixed(2)}, criticality ${(p.pr.parts.criticality ?? 0).toFixed(2)}, near the fire ${(p.pr.parts.hazard ?? 0).toFixed(2)}">${pill(String(p.pr.score), p.pr.score >= 70 ? "bad" : p.pr.score >= 45 ? "warn" : "mute")}</td><td>${ro ? "" : `<button class="btn sm" data-edit="${esc(p.code)}">Edit</button>`}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No patient matches.</td></tr>'}</tbody></table></div>
        </div>
        <div class="stack">
          <div class="card stack" id="pForm"></div>
          <div class="card stack"><h2>About the priority score</h2>
            <p class="small">Score 0 to 100 = ${PRIORITY_WEIGHTS.mobility * 100}% mobility (bed and ventilator highest) + ${PRIORITY_WEIGHTS.criticality * 100}% criticality (1 to 5) + ${PRIORITY_WEIGHTS.hazard * 100}% closeness to the fire along the paths smoke travels (0 beyond 120 m).</p>
            <p class="small muted">It is a fixed rule, written down so anyone can check it, not a trained model. Staff decide; the score helps them see who to move first. Hover a score to see its parts.</p></div>
        </div>
      </div>`;
      const p = editing ? d.patients.find((x) => x.code === editing) : null;
      const f = body.querySelector("#pForm");
      f.innerHTML = `<h2>${p ? `Edit ${esc(p.code)}` : "Add a patient"}</h2>
        <form id="pf" class="stack" novalidate>
          <label class="f">Code<input type="text" id="fCode" maxlength="40" value="${esc(p?.code ?? nextCode(d.patients, "BH-P"))}" ${p ? "readonly" : ""}></label>
          <label class="f">Place<select id="fPlace">${placeOptions(p?.place ?? "Male Medical Bay 1")}</select></label>
          <div class="row"><label class="f" style="flex:1">Mobility<select id="fMob">${Object.entries(MOB_LABEL).map(([k, v]) => option(k, v, k === (p?.mobility ?? "ambulatory"))).join("")}</select></label>
          <label class="f" style="flex:1">Criticality (1-5)<input type="number" id="fCrit" min="1" max="5" value="${p?.criticality ?? 2}"></label></div>
          <div class="row"><button class="btn primary" type="submit" ${ro ? "disabled" : ""}>${p ? "Save" : "Add patient"}</button>${p ? `<button class="btn" type="button" id="fCancel">Cancel</button><button class="btn danger" type="button" id="fDel">Delete</button>` : ""}</div>
        </form>`;
      f.querySelector("#pf").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const rec = { code: f.querySelector("#fCode").value.trim().slice(0, 40), mobility: f.querySelector("#fMob").value, criticality: Math.round(Number(f.querySelector("#fCrit").value)), place: f.querySelector("#fPlace").value };
        if (!rec.code) return toast("Enter a code.", "bad");
        if (!(rec.criticality >= 1 && rec.criticality <= 5)) return toast("Criticality is a whole number from 1 to 5.", "bad");
        try {
          s.updateData((dd) => {
            if (p) Object.assign(dd.patients.find((x) => x.code === p.code), rec);
            else {
              if (dd.patients.some((x) => x.code === rec.code)) throw new Error(`Code ${rec.code} is used already`);
              dd.patients.push(rec);
            }
          }, p ? "update" : "create", `patient ${rec.code}`);
          toast(p ? `Saved ${rec.code}` : `Added ${rec.code}`);
          editing = null;
          draw();
        } catch (err) {
          toast(`Not saved: ${err.message}`, "bad");
        }
      });
      if (p) {
        f.querySelector("#fCancel").onclick = () => {
          editing = null;
          draw();
        };
        f.querySelector("#fDel").onclick = async () => {
          if (!(await confirmBox(`Delete patient ${p.code}?`))) return;
          s.updateData((dd) => (dd.patients = dd.patients.filter((x) => x.code !== p.code)), "delete", `patient ${p.code}`);
          editing = null;
          draw();
        };
      }
      body.querySelector("#fSc").onchange = (ev) => {
        scIdx = Number(ev.target.value);
        draw();
      };
    } else if (tab === "staff") {
      const rows = d.staff.filter((x) => match(x.code, x.place, x.role));
      const perFloor = m.floors.map((fl) => {
        const st = m.people.filter((x) => x.kind === "staff" && m.nodes[x.home].floor === fl).length;
        const beds = pats.filter((x) => m.nodes[x.home].floor === fl).reduce((a, x) => a + ctx.E.escortsNeeded(x.mobility, ctx.E.defaultParams()), 0);
        return { fl, st, beds };
      });
      body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)">
        <div class="card">
          ${filters(ROLES.map((r) => [r, r[0].toUpperCase() + r.slice(1)]))}
          <div class="tbl" style="max-height:62vh;overflow-y:auto"><table><thead><tr><th>Code</th><th>Role</th><th>Place</th><th>Floor</th><th></th></tr></thead><tbody>${rows.map((x) => `<tr><td class="mono">${esc(x.code)}</td><td>${esc(x.role)}</td><td>${esc(x.place)}</td><td>${esc(floorName(floorOf(x.place)))}</td><td>${ro ? "" : `<button class="btn sm" data-edit="${esc(x.code)}">Edit</button>`}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No staff member matches.</td></tr>'}</tbody></table></div>
        </div>
        <div class="stack">
          <div class="card stack" id="pForm"></div>
          <div class="card"><h2>Staff and escort needs by floor</h2><div class="tbl"><table><thead><tr><th>Floor</th><th class="n">Staff on duty</th><th class="n">Staff needed to move all patients at once</th></tr></thead><tbody>${perFloor.map((x) => `<tr><td>${floorName(x.fl)}</td><td class="n">${x.st}</td><td class="n"${x.beds > x.st ? ' style="color:var(--bad-ink);font-weight:600"' : ""}>${x.beds}</td></tr>`).join("")}</tbody></table></div><p class="small muted" style="margin-top:6px">Where fewer staff are on duty than needed, patients are moved in turns, so the last ones wait longer. Red marks those floors.</p></div>
        </div>
      </div>`;
      const st = editing ? d.staff.find((x) => x.code === editing) : null;
      const f = body.querySelector("#pForm");
      f.innerHTML = `<h2>${st ? `Edit ${esc(st.code)}` : "Add a staff member"}</h2>
        <form id="sf" class="stack" novalidate>
          <label class="f">Code<input type="text" id="fCode" maxlength="40" value="${esc(st?.code ?? nextCode(d.staff, "BH-S"))}" ${st ? "readonly" : ""}></label>
          <div class="row"><label class="f" style="flex:1">Role<select id="fRole">${ROLES.map((r) => option(r, r, r === (st?.role ?? "nurse"))).join("")}</select></label>
          <label class="f" style="flex:2">Place<select id="fPlace">${placeOptions(st?.place ?? "Male Medical Bay 1")}</select></label></div>
          <div class="row"><button class="btn primary" type="submit" ${ro ? "disabled" : ""}>${st ? "Save" : "Add staff member"}</button>${st ? `<button class="btn" type="button" id="fCancel">Cancel</button><button class="btn danger" type="button" id="fDel">Delete</button>` : ""}</div>
        </form>`;
      f.querySelector("#sf").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const rec = { code: f.querySelector("#fCode").value.trim().slice(0, 40), role: f.querySelector("#fRole").value, place: f.querySelector("#fPlace").value };
        if (!rec.code) return toast("Enter a code.", "bad");
        try {
          s.updateData((dd) => {
            if (st) Object.assign(dd.staff.find((x) => x.code === st.code), rec);
            else {
              if (dd.staff.some((x) => x.code === rec.code)) throw new Error(`Code ${rec.code} is used already`);
              dd.staff.push(rec);
            }
          }, st ? "update" : "create", `staff ${rec.code}`);
          editing = null;
          toast(`Saved ${rec.code}`);
          draw();
        } catch (err) {
          toast(`Not saved: ${err.message}`, "bad");
        }
      });
      if (st) {
        f.querySelector("#fCancel").onclick = () => {
          editing = null;
          draw();
        };
        f.querySelector("#fDel").onclick = async () => {
          if (!(await confirmBox(`Delete staff member ${st.code}?`))) return;
          s.updateData((dd) => (dd.staff = dd.staff.filter((x) => x.code !== st.code)), "delete", `staff ${st.code}`);
          editing = null;
          draw();
        };
      }
    } else {
      body.innerHTML = `<div class="grid2">
        <div class="card"><h2>People-counting cameras</h2>
          <p class="small muted">Visitors are not listed one by one. Cameras at public areas count them; the simulation places that many visitors there. Change a count to test a busy visiting hour.</p>
          <div class="tbl"><table><thead><tr><th>Camera</th><th>Place</th><th>Floor</th><th class="n">Count</th></tr></thead><tbody>${d.cameras.filter((c) => match(c.id, c.place, "all")).map((c, i) => `<tr><td class="mono">${esc(c.id)}</td><td>${esc(c.place)}</td><td>${esc(floorName(floorOf(c.place)))}</td><td class="n"><input type="number" min="0" max="2000" value="${c.count}" data-cam="${i}" style="width:90px" ${ro ? "disabled" : ""} aria-label="Count at ${esc(c.id)}"></td></tr>`).join("")}</tbody></table></div>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="camSave" ${ro ? "disabled" : ""}>Save counts</button><span class="small muted">Total now: ${counts.visitors}</span></div>
        </div>
      </div>`;
      body.querySelector("#camSave").onclick = () => {
        try {
          s.updateData((dd) => {
            for (const inp of body.querySelectorAll("[data-cam]")) {
              const v = Number(inp.value);
              if (!Number.isInteger(v) || v < 0 || v > 2000) throw new Error(`Count at ${dd.cameras[Number(inp.dataset.cam)].id} must be a whole number from 0 to 2000`);
              dd.cameras[Number(inp.dataset.cam)].count = v;
            }
          }, "update", "visitor counts");
          toast("Counts saved");
          draw();
        } catch (err) {
          toast(err.message, "bad");
        }
      };
    }

    // filters and edit buttons
    const ff = body.querySelector("#fFloor");
    if (ff) ff.onchange = () => {
      filter.floor = ff.value;
      draw();
    };
    const fk = body.querySelector("#fKind");
    if (fk) fk.onchange = () => {
      filter.kind = fk.value;
      draw();
    };
    const fq = body.querySelector("#fQ");
    if (fq) fq.onchange = () => {
      filter.q = fq.value.trim().slice(0, 60);
      draw();
    };
    for (const b of body.querySelectorAll("[data-edit]")) b.onclick = () => {
      editing = b.dataset.edit;
      draw();
    };
    for (const b of main.querySelectorAll("[data-tab]")) b.onclick = () => {
      tab = b.dataset.tab;
      filter = { floor: "all", kind: "all", q: "" };
      editing = null;
      draw();
    };
    main.querySelector("#pExp").onclick = () => {
      if (tab === "patients") download("patients.csv", toCsv(d.patients, ["code", "mobility", "criticality", "place"]), "text/csv");
      else if (tab === "staff") download("staff.csv", toCsv(d.staff, ["code", "role", "place"]), "text/csv");
      else download("cameras.csv", toCsv(d.cameras.map((c) => ({ camera: c.id, place: c.place, count: c.count })), ["camera", "place", "count"]), "text/csv");
      s.audit("export", tab, "CSV");
    };
    main.querySelector("#pImp").onchange = async (ev) => {
      try {
        const { name, text } = await readFile(ev.target);
        const rows = parseCsv(text);
        if (tab === "visitors") throw new Error("Import counts on the Visitors tab is not offered; change the numbers in the table");
        const cols = tab === "patients" ? ["code", "mobility", "place"] : ["code", "role", "place"];
        for (const c of cols) if (!rows.length || !(c in rows[0])) throw new Error(`column "${c}" is missing`);
        const recs = rows.map((r) => (tab === "patients" ? { code: r.code.slice(0, 40), mobility: r.mobility, criticality: Number(r.criticality || 1), place: r.place } : { code: r.code.slice(0, 40), role: (r.role || "staff").slice(0, 40), place: r.place }));
        if (!(await confirmBox(`Replace all ${tab} with the ${recs.length} rows in ${name}?`, "Replace"))) return;
        s.updateData((dd) => (dd[tab] = recs), "import", `${recs.length} ${tab} from ${name}`);
        toast(`Imported ${recs.length} ${tab}`);
        draw();
      } catch (err) {
        toast(`Not imported: ${err.message}`, "bad");
      }
    };
  };
  draw();
}

function nextCode(list, prefix) {
  let n = list.length + 1;
  const used = new Set(list.map((x) => x.code));
  while (used.has(`${prefix}${String(n).padStart(3, "0")}`)) n++;
  return `${prefix}${String(n).padStart(3, "0")}`;
}
