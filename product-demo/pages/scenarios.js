// Scenario Builder: where the fire starts, how fast smoke spreads, closed places,
// and the imperfect-information settings (gap 4) of each scenario.
import { esc, header, toast, confirmBox, option, floorName, table, fmtS } from "../ui.js";

// Settings for imperfect information, stored per scenario (raw.params).
const INFO = [
  ["phone_patient", "Walking patients who get phone messages", "share"],
  ["phone_visitor", "Visitors who get phone messages", "share"],
  ["compliance", "People who follow messages and signs", "share"],
  ["msg_loss", "Phone messages that do not arrive", "share"],
  ["sign_fail", "Dynamic exit signs that do not work", "share"],
  ["p_dead", "Sensors that send nothing", "share"],
  ["p_stuck", "Sensors stuck at one value", "share"],
  ["p_drift", "Sensors that read too high", "share"],
  ["p_flaky", "Sensors that lose readings", "share"],
  ["confirm_delay_s", "Commander confirmation time", "s"],
];

export function render(main, ctx) {
  const s = ctx.store;
  let sel = 0;
  const draw = () => {
    const m = ctx.model();
    const list = s.data().scenarios;
    if (sel >= list.length) sel = Math.max(0, list.length - 1);
    const raw = list[sel] ?? { name: "", origin: null, start: 0, smokeRate: 0.08, fireRate: 0.01, alarm: "sensors", closed: [], params: {} };
    const defaults = Object.fromEntries(ctx.E.PARAMS.map((p) => [p.key, p.value]));
    const origins = m.nodes.filter((n) => n.type !== "exit" && !n.protected);
    const closable = m.nodes.filter((n) => n.type === "exit" || n.type === "stair" || n.type === "lift" || n.type === "corridor");
    const ro = ctx.readOnly();
    main.innerHTML = `${header("Scenario Builder", "A scenario says where a fire starts, how fast its smoke spreads, which exits or stairs are closed, and how good the information is. A drill has no fire.")}
    <div class="grid2" style="grid-template-columns:minmax(260px,1fr) minmax(0,2fr)">
      <div class="card stack">
        <h2>Scenarios</h2>
        ${table(
          [
            { label: "Name", get: (r) => r.name },
            { label: "Fire in", get: (r) => (r.origin ? r.origin : "No fire (drill)") },
          ],
          list.map((r, i) => ({ ...r, _attrs: `class="click${i === sel ? " sel" : ""}" data-sel="${i}"${i === sel ? ' aria-current="true" style="background:var(--tagp)"' : ""}` })),
        )}
        <button class="btn" id="scNew" ${ro ? "disabled" : ""}>New scenario</button>
      </div>
      <form class="card stack" id="scForm" novalidate>
        <h2>${list.length ? esc(raw.name) : "New scenario"}</h2>
        <label class="f">Name<input type="text" id="sName" maxlength="120" value="${esc(raw.name)}"></label>
        <div class="row">
          <label class="f" style="flex:2;min-width:220px">Where the fire starts<select id="sOrigin">${option("", "No fire (evacuation drill)", raw.origin === null)}${m.floors.map((f) => `<optgroup label="${floorName(f)}">${origins.filter((n) => n.floor === f).map((n) => option(n.id, n.id, n.id === raw.origin)).join("")}</optgroup>`).join("")}</select></label>
          <label class="f" style="flex:1;min-width:140px">Starts at (s)<input type="number" id="sStart" min="0" max="3000" value="${raw.start ?? 0}"></label>
        </div>
        <div class="row">
          <label class="f" style="flex:1;min-width:160px">Smoke spread speed (m/s)<input type="number" id="sSmoke" min="0.01" max="1" step="0.01" value="${raw.smokeRate ?? 0.08}"></label>
          <label class="f" style="flex:1;min-width:160px">Fire spread speed (m/s)<input type="number" id="sFire" min="0" max="0.5" step="0.001" value="${raw.fireRate ?? 0.01}"></label>
          <label class="f" style="flex:1;min-width:160px">The alarm is raised by<select id="sAlarm">${option("sensors", "Sensors", raw.alarm !== "manual")}${option("manual", "People who find it", raw.alarm === "manual")}</select></label>
        </div>
        <fieldset class="stack" style="border:1px solid var(--line);border-radius:8px;padding:10px">
          <legend class="small">Closed from the start (exits, stairs, lifts, corridors)</legend>
          <div style="max-height:150px;overflow-y:auto" class="checks">${m.floors.map((f) => `<b class="small">${floorName(f)}</b>${closable.filter((n) => n.floor === f).map((n) => `<label><input type="checkbox" data-closed="${esc(n.id)}" ${(raw.closed ?? []).includes(n.id) ? "checked" : ""}>${esc(n.id)}</label>`).join("")}`).join("")}</div>
        </fieldset>
        <details ${Object.keys(raw.params ?? {}).length ? "open" : ""}><summary><b>Information settings</b> <span class="gap-chip">Gap 4</span></summary>
          <p class="small muted" style="margin:6px 0">How imperfect the information is in this scenario. Empty means the default value (shown in grey). Shares are from 0 to 1.</p>
          <div class="grid2" style="gap:8px">${INFO.map(([k, label, unit]) => `<label class="f small">${esc(label)}<input type="number" data-p="${k}" min="0" ${unit === "share" ? 'max="1" step="0.01"' : 'max="600" step="1"'} placeholder="${defaults[k]}" value="${raw.params?.[k] ?? ""}"></label>`).join("")}</div>
        </details>
        <label class="f">Note<textarea id="sNote" rows="2" maxlength="400">${esc(raw.note ?? "")}</textarea></label>
        <p class="small" id="sErr" role="alert" style="color:var(--bad-ink)"></p>
        <div class="row">
          <button class="btn primary" type="submit" ${ro ? "disabled" : ""}>Save</button>
          <button class="btn" type="button" id="sRun" ${ro ? "disabled" : ""}>Save and run live</button>
          <button class="btn danger" type="button" id="sDel" ${ro || !list.length ? "disabled" : ""}>Delete</button>
          <span class="small muted" id="sInfo"></span>
        </div>
      </form>
    </div>`;
    if (list.length && raw.origin) {
      const o = m.index.get(raw.origin);
      const reach = m.nodes.filter((n) => Number.isFinite(m.spread.D[o][n.i]) && m.spread.D[o][n.i] / raw.smokeRate <= 300).length;
      main.querySelector("#sInfo").textContent = `At the design speed, smoke reaches about ${reach} places within 5 minutes (${fmtS(300)}).`;
    }
    const read = () => {
      const name = main.querySelector("#sName").value.trim().slice(0, 120);
      const params = {};
      for (const inp of main.querySelectorAll("[data-p]")) {
        if (inp.value === "") continue;
        const v = Number(inp.value);
        if (!Number.isFinite(v) || v < 0) throw new Error(`"${INFO.find((x) => x[0] === inp.dataset.p)[1]}" must be a number of 0 or more`);
        if (INFO.find((x) => x[0] === inp.dataset.p)[2] === "share" && v > 1) throw new Error(`"${INFO.find((x) => x[0] === inp.dataset.p)[1]}" is a share from 0 to 1`);
        params[inp.dataset.p] = v;
      }
      const origin = main.querySelector("#sOrigin").value || null;
      return {
        name,
        origin,
        start: Number(main.querySelector("#sStart").value) || 0,
        smokeRate: Number(main.querySelector("#sSmoke").value),
        fireRate: Number(main.querySelector("#sFire").value),
        alarm: main.querySelector("#sAlarm").value,
        closed: [...main.querySelectorAll("[data-closed]")].filter((c) => c.checked).map((c) => c.dataset.closed),
        note: main.querySelector("#sNote").value.trim().slice(0, 400) || (origin ? `Fire in ${origin}.` : "Evacuation drill without a hazard."),
        params,
      };
    };
    const save = () => {
      const err = main.querySelector("#sErr");
      err.textContent = "";
      try {
        const next = read();
        if (!next.name) throw new Error("Enter a name");
        const isNew = !list.length || main.querySelector("#scForm").dataset.isNew === "1";
        if (list.some((x, i) => x.name === next.name && (isNew || i !== sel))) throw new Error(`A scenario called "${next.name}" exists already`);
        s.updateData((d) => {
          if (isNew) d.scenarios.push(next);
          else d.scenarios[sel] = next;
        }, isNew ? "create" : "update", `scenario ${next.name}`);
        if (isNew) sel = s.data().scenarios.length - 1;
        toast(`Saved "${next.name}"`);
        return true;
      } catch (e) {
        err.textContent = `Not saved: ${e.message}`;
        return false;
      }
    };
    main.querySelector("#scForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (save()) draw();
    });
    main.querySelector("#sRun").onclick = () => {
      if (!save()) return;
      ctx.pending.scenario = sel;
      ctx.go("live");
    };
    main.querySelector("#sDel").onclick = async () => {
      if (!(await confirmBox(`Delete the scenario "${raw.name}"? Runs already saved in Reports stay.`))) return;
      try {
        s.updateData((d) => d.scenarios.splice(sel, 1), "delete", `scenario ${raw.name}`);
        sel = 0;
        draw();
      } catch (e) {
        toast(e.message, "bad");
      }
    };
    main.querySelector("#scNew").onclick = () => {
      const f = main.querySelector("#scForm");
      f.dataset.isNew = "1";
      f.querySelector("h2").textContent = "New scenario";
      main.querySelector("#sName").value = "";
      main.querySelector("#sNote").value = "";
      for (const c of main.querySelectorAll("[data-closed]")) c.checked = false;
      for (const c of main.querySelectorAll("[data-p]")) c.value = "";
      main.querySelector("#sDel").disabled = true;
      main.querySelector("#sName").focus();
    };
    for (const tr of main.querySelectorAll("[data-sel]")) tr.onclick = () => {
      sel = Number(tr.dataset.sel);
      draw();
    };
  };
  draw();
}
