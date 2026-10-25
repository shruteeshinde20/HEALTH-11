// HEALTH-11 product demo: page shell, log-in, roles and navigation.
import * as E from "./engine.js";
import { createStore } from "./store.js";
import { esc, toast } from "./ui.js";

const SAFETY = "HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals.";
const PLANNERS = ["Administrator", "Emergency Commander"];

// Same pages and role rules as the main app (frontend/src/lib/shared/pages.ts).
export const PAGES = [
  { path: "dashboard", label: "Dashboard", module: "./pages/dashboard.js" },
  { path: "facilities", label: "Facility Manager", roles: PLANNERS, module: "./pages/facilities.js" },
  { path: "graph", label: "Graph Builder", roles: PLANNERS, module: "./pages/graph.js" },
  { path: "scenarios", label: "Scenario Builder", roles: PLANNERS, module: "./pages/scenarios.js" },
  { path: "live", label: "Live Simulation", module: "./pages/live.js" },
  { path: "compare", label: "Algorithm Comparison", roles: PLANNERS, module: "./pages/compare.js" },
  { path: "people", label: "Patients & Staff", module: "./pages/people.js" },
  { path: "assistant", label: "AI Assistant", roles: PLANNERS, module: "./pages/assistant.js" },
  { path: "reports", label: "Reports & History", module: "./pages/reports.js" },
  { path: "admin", label: "Admin", roles: ["Administrator"], module: "./pages/admin.js" },
  { path: "settings", label: "Settings / Profile", module: "./pages/settings.js" },
];
const HIDDEN = [{ path: "onboarding", label: "Get started", roles: PLANNERS, module: "./pages/onboarding.js" }];
const PUBLIC = { "": "./pages/landing.js", login: "./pages/login.js", register: "./pages/login.js" };

const allowed = (page, role) => !page.roles || (role && page.roles.includes(role));

let store;
let current = null; // {path, mod}
const ctx = {
  E,
  get store() {
    return store;
  },
  model: () => store.model(),
  go(path) {
    location.hash = `#/${path}`;
  },
  can(path) {
    const p = [...PAGES, ...HIDDEN].find((x) => x.path === path);
    return p ? allowed(p, store.user()?.role) : false;
  },
  role: () => store.user()?.role ?? null,
  readOnly: () => store.user()?.role === "Staff User",
  // scenario chosen on one page and opened on another
  pending: {},
  // the live simulation stays alive between pages
  live: null,
  job,
};

// ---------------------------------------------------------------- background runs
let worker = null;
let jobId = 0;
const jobs = new Map();
let workerKey = "";
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      const m = ev.data;
      const j = jobs.get(m.id);
      if (!j) return;
      if (m.type === "progress") j.progress?.(m.done, m.total);
      else if (m.type === "done" || m.type === "ready") {
        jobs.delete(m.id);
        j.resolve(m.out);
      } else if (m.type === "error") {
        jobs.delete(m.id);
        j.reject(new Error(m.message));
      }
    };
    worker.onerror = (ev) => {
      for (const j of jobs.values()) j.reject(new Error(ev.message || "The background worker stopped"));
      jobs.clear();
      worker = null;
      workerKey = "";
    };
  }
  return worker;
}
function send(msg, progress) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, progress });
    getWorker().postMessage({ ...msg, id });
  });
}
async function job(msg, progress) {
  const b = store.building();
  const key = `${b.id}:${b.rev ?? 0}:${JSON.stringify(store.state.params)}`;
  if (key !== workerKey) {
    await send({ type: "model", data: b.data, params: store.state.params });
    workerKey = key;
  }
  return send(msg, progress);
}

// ---------------------------------------------------------------- shell
function shell(user, active) {
  const nav = PAGES.filter((p) => allowed(p, user.role))
    .map((p) => `<a href="#/${p.path}"${p.path === active ? ' aria-current="page"' : ""}>${esc(p.label)}</a>`)
    .join("");
  const h = store.hospital();
  return `<div class="app">
    <nav class="side" aria-label="Pages">
      <div class="brand"><div class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="11" y="2" width="7" height="16" rx="1" stroke="#1E3A5F" stroke-width="1.8"/><path d="M2 10h7m-2.6-3 3 3-3 3" stroke="#1E3A5F" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div><b>HEALTH-11</b><span>${esc(h ? h.name : "No hospital")}</span></div></div>
      <div class="nav">${nav}</div>
      <div class="who"><span>${esc(user.name)} &middot; ${esc(user.role)}</span><button class="btn sm" id="logout">Log out</button></div>
    </nav>
    <div style="min-width:0;display:grid;grid-template-rows:1fr auto">
      <main id="main"></main>
      <footer class="notice">${esc(SAFETY)}</footer>
    </div>
  </div>`;
}

async function route() {
  const path = location.hash.replace(/^#\/?/, "").split("?")[0];
  const user = store.user();
  const root = document.getElementById("root");
  if (current?.mod?.leave) current.mod.leave();
  if (path in PUBLIC && !(user && path === "")) {
    const mod = await import(PUBLIC[path]);
    root.innerHTML = "";
    current = { path, mod };
    mod.render(root, ctx, path);
    return;
  }
  if (!user) {
    ctx.go("login");
    return;
  }
  const page = [...PAGES, ...HIDDEN].find((p) => p.path === (path || "dashboard"));
  root.innerHTML = shell(user, page?.path);
  document.getElementById("logout").onclick = () => {
    if (ctx.live?.sim) ctx.live.pause?.();
    store.logout();
    ctx.go("login");
  };
  const main = document.getElementById("main");
  if (!page) {
    main.innerHTML = `<h1>Page not found</h1><p><a href="#/dashboard">Back to the Dashboard</a></p>`;
    return;
  }
  if (!allowed(page, user.role)) {
    main.innerHTML = `<div class="page-head"><div><h1>Not available</h1><p class="sub">This page is not part of your role.</p></div></div><div class="card">Your role (${esc(user.role)}) cannot use this page. An Administrator can change your role. <a href="#/dashboard">Back to the Dashboard</a></div>`;
    return;
  }
  try {
    const mod = await import(page.module);
    current = { path: page.path, mod };
    document.title = `${page.label} · HEALTH-11 Bharati Demo`;
    await mod.render(main, ctx);
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="note">This page could not open: ${esc(err.message)}</div>`;
  }
}

async function main() {
  let data;
  try {
    const res = await fetch("examples/bharati.json");
    if (!res.ok) throw new Error(`examples/bharati.json: ${res.status}`);
    data = await res.json();
  } catch (err) {
    document.getElementById("root").innerHTML = `<div class="auth"><div class="note">The demo data could not be loaded (${esc(err.message)}). Open the page through the local web server; see the README.</div></div>`;
    return;
  }
  store = createStore(data);
  try {
    store.model();
  } catch (err) {
    toast(`The saved building had a problem (${err.message}); the example was loaded again.`, "bad");
    store.reset();
  }
  window.addEventListener("hashchange", route);
  route();
}

main();
