// Admin: users and roles, and the audit log of every change and log-in.
import { esc, header, table, option, toast, confirmBox, download } from "../ui.js";
import { toCsv } from "../io.js";
import { ROLES } from "../store.js";

export function render(main, ctx) {
  const s = ctx.store;
  let tab = "users";
  let q = "";
  let action = "all";

  const draw = () => {
    const me = s.user();
    main.innerHTML = `${header("Admin", "Users, their roles, and the audit log. Every create, update and delete, every log-in and every export is recorded.")}
    <div class="tabs-in" role="tablist"><button role="tab" data-t="users" aria-selected="${tab === "users"}">Users (${s.state.users.length})</button><button role="tab" data-t="audit" aria-selected="${tab === "audit"}">Audit log (${s.state.audit.length})</button></div>
    <div id="adBody"></div>`;
    const body = main.querySelector("#adBody");
    if (tab === "users") {
      body.innerHTML = `<div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)">
        <div class="card">${table(
          [
            { label: "Name", get: (u) => u.name },
            { label: "Email", get: (u) => u.email },
            { label: "Role", html: true, get: (u) => `<select data-role="${u.id}" aria-label="Role of ${esc(u.name)}" ${u.id === me.id ? "disabled" : ""}>${ROLES.map((r) => option(r, r, r === u.role)).join("")}</select>` },
            { label: "Status", html: true, get: (u) => (u.active ? '<span class="pill ok">Active</span>' : '<span class="pill mute">Deactivated</span>') },
            { label: "", html: true, get: (u) => (u.id === me.id ? '<span class="small muted">You</span>' : `<button class="btn sm ${u.active ? "danger" : ""}" data-toggle="${u.id}">${u.active ? "Deactivate" : "Activate"}</button>`) },
          ],
          s.state.users,
        )}
        <div class="stack" style="margin-top:12px">
          <h3>What each role can do</h3>
          ${table(
            [
              { label: "Role", get: (r) => r.role },
              { label: "Pages", get: (r) => r.pages },
            ],
            [
              { role: "Administrator", pages: "All pages, including Admin" },
              { role: "Emergency Commander", pages: "All pages except Admin" },
              { role: "Staff User", pages: "Dashboard, Live Simulation, Patients & Staff, Reports & History, Settings (view only)" },
            ],
          )}
        </div></div>
        <form class="card stack" id="inv" novalidate>
          <h2>Invite a user</h2>
          <label class="f">Name<input type="text" id="iName" maxlength="80"></label>
          <label class="f">Email<input type="email" id="iEmail" maxlength="120"></label>
          <label class="f">Role<select id="iRole">${ROLES.map((r) => option(r, r, r === "Staff User")).join("")}</select></label>
          <button class="btn primary" type="submit">Add user</button>
          <p class="small muted">In the main app the person receives an email to set a password. In this demo the account is added straight away and can log in from the log-in page.</p>
        </form>
      </div>`;
      body.querySelector("#inv").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const name = body.querySelector("#iName").value.trim().slice(0, 80);
        const email = body.querySelector("#iEmail").value.trim().slice(0, 120);
        if (!name) return toast("Enter a name.", "bad");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter a valid email address.", "bad");
        if (s.state.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return toast("A user with this email exists already.", "bad");
        const role = body.querySelector("#iRole").value;
        s.state.users.push({ id: s.newId(), name, email, role, active: true });
        s.audit("create", "user", `${email} as ${role}`);
        toast(`Added ${name}`);
        draw();
      });
      for (const sel of body.querySelectorAll("[data-role]")) sel.onchange = () => {
        const u = s.state.users.find((x) => x.id === Number(sel.dataset.role));
        const admins = s.state.users.filter((x) => x.role === "Administrator" && x.active);
        if (u.role === "Administrator" && sel.value !== "Administrator" && admins.length <= 1) {
          toast("Keep at least one active Administrator.", "bad");
          sel.value = u.role;
          return;
        }
        s.audit("update", "user", `${u.email}: ${u.role} to ${sel.value}`);
        u.role = sel.value;
        s.save();
        toast(`${u.name} is now ${u.role}`);
        draw();
      };
      for (const b of body.querySelectorAll("[data-toggle]")) b.onclick = async () => {
        const u = s.state.users.find((x) => x.id === Number(b.dataset.toggle));
        if (u.active) {
          if (u.role === "Administrator" && s.state.users.filter((x) => x.role === "Administrator" && x.active).length <= 1) return toast("Keep at least one active Administrator.", "bad");
          if (!(await confirmBox(`Deactivate ${u.name}? They can no longer log in. Their history stays.`, "Deactivate"))) return;
        }
        u.active = !u.active;
        s.audit("update", "user", `${u.email} ${u.active ? "activated" : "deactivated"}`);
        draw();
      };
    } else {
      const actions = [...new Set(s.state.audit.map((a) => a.action))].sort();
      const rows = s.state.audit.filter((a) => (action === "all" || a.action === action) && (!q || `${a.user} ${a.entity} ${a.detail}`.toLowerCase().includes(q.toLowerCase())));
      body.innerHTML = `<div class="card stack">
        <div class="row"><select id="aAct" style="width:auto" aria-label="Action">${option("all", "All actions", action === "all")}${actions.map((x) => option(x, x, x === action)).join("")}</select>
        <input type="search" id="aQ" placeholder="Search user, item or detail" value="${esc(q)}" style="width:260px" aria-label="Search the audit log">
        <button class="btn" id="aCsv">Download CSV</button><span class="small muted">${rows.length} entries (the newest 500 are kept)</span></div>
        <div style="max-height:68vh;overflow-y:auto">${table(
          [
            { label: "Time", get: (a) => new Date(a.t).toLocaleString() },
            { label: "User", get: (a) => a.user },
            { label: "Action", html: true, get: (a) => `<span class="pill ${a.action === "delete" || a.action === "failed login" ? "bad" : a.action === "create" ? "ok" : a.action === "update" ? "warn" : "mute"}">${esc(a.action)}</span>` },
            { label: "Item", get: (a) => a.entity },
            { label: "Detail", get: (a) => a.detail },
          ],
          rows.slice(0, 300),
          { empty: "No entries match." },
        )}</div></div>`;
      body.querySelector("#aAct").onchange = (ev) => {
        action = ev.target.value;
        draw();
      };
      body.querySelector("#aQ").onchange = (ev) => {
        q = ev.target.value.trim().slice(0, 60);
        draw();
      };
      body.querySelector("#aCsv").onclick = () => {
        download("audit-log.csv", toCsv(rows, ["t", "user", "action", "entity", "detail"]), "text/csv");
        s.audit("export", "audit log", `${rows.length} entries`);
      };
    }
    for (const b of main.querySelectorAll("[data-t]")) b.onclick = () => {
      tab = b.dataset.t;
      draw();
    };
  };
  draw();
}
