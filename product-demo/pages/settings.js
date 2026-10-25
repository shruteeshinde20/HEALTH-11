// Settings / Profile: your profile, password rules, the model's parameters with
// their sources, and resetting the demo data.
import { esc, header, toast, confirmBox } from "../ui.js";

const KIND = { sourced: ["Sourced", "ok"], derived: ["Derived", "pri"], assumed: ["Assumed", "warn"], policy: ["Planner setting", "mute"] };

export function render(main, ctx) {
  const s = ctx.store;
  const draw = () => {
    const u = s.user();
    const ro = ctx.readOnly();
    const changed = Object.keys(s.state.params).length;
    const groups = new Map();
    for (const p of ctx.E.PARAMS) {
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group).push(p);
    }
    main.innerHTML = `${header("Settings / Profile", "Your account, and the numbers the simulation uses. Every number shows where it comes from.")}
    <div class="grid2">
      <form class="card stack" id="prof" novalidate>
        <h2>Profile</h2>
        <label class="f">Name<input type="text" id="sName" maxlength="80" value="${esc(u.name)}"></label>
        <label class="f">Email<input type="email" value="${esc(u.email)}" readonly></label>
        <label class="f">Role<input type="text" value="${esc(u.role)}" readonly></label>
        <button class="btn primary" type="submit">Save profile</button>
      </form>
      <form class="card stack" id="pw" novalidate>
        <h2>Change password</h2>
        <label class="f">New password<input type="password" id="p1" autocomplete="new-password"><span class="small muted">At least 10 characters, with a letter and a number.</span></label>
        <label class="f">Repeat it<input type="password" id="p2" autocomplete="new-password"></label>
        <p class="small" id="pErr" role="alert" style="color:var(--bad-ink)"></p>
        <button class="btn" type="submit">Change password</button>
        <p class="small muted">Demo: the rules are checked but no password is stored. The main app stores only a secure hash.</p>
      </form>
    </div>
    <div class="card stack" style="margin-top:16px">
      <div class="row" style="justify-content:space-between"><h2>Simulation parameters</h2><div class="row"><span class="small muted">${changed ? `${changed} changed from the defaults` : "All at their default values"}</span><button class="btn" id="pReset" ${ro || !changed ? "disabled" : ""}>Back to defaults</button><button class="btn primary" id="pSave" ${ro ? "disabled" : ""}>Save parameters</button></div></div>
      <p class="small muted">Sourced: from a standard or study. Derived: worked out from sourced values. Assumed: a reasoned guess to be checked with drills. Planner setting: a choice of the method. ${ro ? "Your role can view these but not change them." : ""}</p>
      <div class="grid2">${[...groups.entries()].map(([g, list]) => `<div><h3>${esc(g)}</h3><div class="tbl"><table><tbody>${list.map((p) => `<tr><td>${esc(p.label)}<div class="small muted">${esc(ctx.E.SOURCES[p.source]?.short ?? p.source)}</div></td><td style="width:96px"><input type="number" step="any" data-key="${p.key}" value="${s.state.params[p.key] ?? p.value}" aria-label="${esc(p.label)}" ${ro ? "disabled" : ""}${s.state.params[p.key] !== undefined ? ' style="border-color:var(--pri-ink)"' : ""}></td><td class="small muted" style="white-space:nowrap">${esc(p.unit)}</td><td><span class="pill ${KIND[p.kind]?.[1] ?? "mute"}">${KIND[p.kind]?.[0] ?? p.kind}</span></td></tr>`).join("")}</tbody></table></div></div>`).join("")}</div>
      <details><summary><b>Sources</b></summary><div class="stack small" style="margin-top:8px">${Object.values(ctx.E.SOURCES).map((x) => `<div><b>${esc(x.short)}</b>: ${esc(x.full)} ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">Open</a>` : ""}</div>`).join("")}</div></details>
    </div>
    ${ctx.role() === "Administrator" ? `<div class="card stack" style="margin-top:16px"><h2>Demo data</h2><p class="small">Everything in this demo is kept in this browser only. Reset puts back the original Bharati demo building, people, scenarios and users, and clears runs and the audit log.</p><div><button class="btn danger-solid" id="dReset">Reset all demo data</button></div></div>` : ""}`;
    main.querySelector("#prof").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = main.querySelector("#sName").value.trim().slice(0, 80);
      if (!name) return toast("Enter your name.", "bad");
      u.name = name;
      s.audit("update", "profile", u.email);
      toast("Profile saved");
      ctx.go("settings");
      draw();
    });
    main.querySelector("#pw").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const a = main.querySelector("#p1").value;
      const b = main.querySelector("#p2").value;
      const err = main.querySelector("#pErr");
      if (a.length < 10 || !/[a-zA-Z]/.test(a) || !/\d/.test(a)) return (err.textContent = "The password needs at least 10 characters, with a letter and a number.");
      if (a !== b) return (err.textContent = "The two passwords are not the same.");
      err.textContent = "";
      main.querySelector("#p1").value = "";
      main.querySelector("#p2").value = "";
      s.audit("update", "password", u.email);
      toast("Password rules passed (demo: nothing is stored).");
    });
    main.querySelector("#pSave").onclick = () => {
      const next = {};
      const bad = [];
      for (const inp of main.querySelectorAll("[data-key]")) {
        const p = ctx.E.PARAMS.find((x) => x.key === inp.dataset.key);
        const v = Number(inp.value);
        if (inp.value === "" || !Number.isFinite(v) || v < 0) bad.push(p.label);
        else if (Math.abs(v - p.value) > 1e-12) next[p.key] = v;
      }
      if (bad.length) return toast(`These must be numbers of 0 or more: ${bad.slice(0, 3).join("; ")}`, "bad");
      try {
        ctx.E.buildModel(s.data(), next);
      } catch (e) {
        return toast(`Not saved: ${e.message}`, "bad");
      }
      s.state.params = next;
      s.audit("update", "parameters", `${Object.keys(next).length} changed`);
      toast("Parameters saved. New runs use them.");
      draw();
    };
    main.querySelector("#pReset").onclick = () => {
      s.state.params = {};
      s.audit("update", "parameters", "back to defaults");
      draw();
    };
    const dr = main.querySelector("#dReset");
    if (dr) dr.onclick = async () => {
      if (!(await confirmBox("Reset all demo data in this browser? Your runs, changes and audit log are removed.", "Reset"))) return;
      const email = u.email;
      s.reset();
      ctx.live = null;
      const r = s.login(email);
      if (!r.ok) s.login("admin@bharati-demo.example");
      toast("Demo data reset");
      ctx.go("dashboard");
    };
  };
  draw();
}
