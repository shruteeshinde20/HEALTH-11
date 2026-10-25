// Demo data store: one made-up organisation, kept in this browser only
// (localStorage). Every create, update and delete, and every log-in, is
// written to the audit log, like the main HEALTH-11 app.
import * as E from "./engine.js";

const KEY = "health11-bharati-demo-v1";
const MAX_RUNS = 80;

export const ROLES = ["Administrator", "Emergency Commander", "Staff User"];

function defaultUsers() {
  return [
    { id: 1, name: "Dr. Asha Kulkarni", email: "admin@bharati-demo.example", role: "Administrator", active: true },
    { id: 2, name: "Rahul Deshmukh", email: "commander@bharati-demo.example", role: "Emergency Commander", active: true },
    { id: 3, name: "Sister Meena Patil", email: "staff@bharati-demo.example", role: "Staff User", active: true },
  ];
}

export function createStore(buildingData) {
  const fresh = () => ({
    version: 1,
    org: { name: "Bharati Hospital (demo organisation)" },
    users: defaultUsers(),
    userId: null,
    hospitals: [
      {
        id: 1,
        name: "Bharati Hospital",
        city: "Pune (Dhankawadi)",
        note: "Made-up layout and people for a student demo",
        deleted: false,
        buildings: [{ id: 1, name: "Main Block", deleted: false, data: structuredClone(buildingData) }],
      },
    ],
    current: { hospital: 1, building: 1 },
    params: {},
    runs: [],
    audit: [],
    onboarded: true,
    nextId: 100,
  });
  let state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? JSON.parse(raw) : fresh();
    if (!state || state.version !== 1 || !Array.isArray(state.hospitals)) state = fresh();
  } catch {
    state = fresh();
  }
  const listeners = new Set();
  let modelCache = { key: "", model: null };

  const store = {
    get state() {
      return state;
    },
    save() {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        /* storage full or blocked: the demo still works for this visit */
      }
      for (const fn of listeners) fn();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset() {
      state = fresh();
      modelCache = { key: "", model: null };
      store.save();
    },
    newId() {
      state.nextId += 1;
      return state.nextId;
    },
    user() {
      return state.users.find((u) => u.id === state.userId) ?? null;
    },
    login(email) {
      const u = state.users.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase());
      if (!u) {
        store.audit("failed login", "user", String(email).slice(0, 80));
        return { ok: false, message: "No demo account has this email." };
      }
      if (!u.active) {
        store.audit("failed login", "user", `${u.email} (deactivated)`);
        return { ok: false, message: "This account is deactivated. An Administrator can turn it back on." };
      }
      state.userId = u.id;
      store.audit("login", "user", u.email);
      return { ok: true, user: u };
    },
    logout() {
      const u = store.user();
      if (u) store.audit("logout", "user", u.email);
      state.userId = null;
      store.save();
    },
    audit(action, entity, detail = "") {
      const u = store.user();
      state.audit.unshift({ t: new Date().toISOString(), user: u ? u.email : "-", action, entity, detail: String(detail).slice(0, 200) });
      if (state.audit.length > 500) state.audit.length = 500;
      store.save();
    },
    hospital() {
      return state.hospitals.find((h) => h.id === state.current.hospital && !h.deleted) ?? state.hospitals.find((h) => !h.deleted);
    },
    building() {
      const h = store.hospital();
      if (!h) return null;
      return h.buildings.find((b) => b.id === state.current.building && !b.deleted) ?? h.buildings.find((b) => !b.deleted) ?? null;
    },
    data() {
      return store.building()?.data ?? null;
    },
    // The engine model of the current building (rebuilt only when the data or parameters change).
    model() {
      const b = store.building();
      if (!b) return null;
      const key = `${state.current.hospital}:${b.id}:${b.rev ?? 0}:${JSON.stringify(state.params)}`;
      if (modelCache.key !== key) modelCache = { key, model: E.buildModel(b.data, state.params) };
      return modelCache.model;
    },
    // Change the building data: the change is checked by building the model first.
    updateData(mutator, action, detail) {
      const b = store.building();
      const copy = structuredClone(b.data);
      mutator(copy);
      E.buildModel(copy, state.params); // throws with a clear message if the building is not valid
      b.data = copy;
      b.rev = (b.rev ?? 0) + 1;
      store.audit(action, "building", detail);
      return true;
    },
    addRun(summary, meta) {
      const keep = { ...summary };
      keep.events = (summary.events ?? []).slice(-80);
      delete keep.estimates;
      keep.estimateCurve = (summary.estimates ?? []).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 60)) === 0).map((e) => [e.t, e.mae]);
      const run = { id: store.newId(), at: new Date().toISOString(), ...meta, summary: keep };
      state.runs.unshift(run);
      if (state.runs.length > MAX_RUNS) state.runs.length = MAX_RUNS;
      store.audit("create", "simulation run", `${meta.scenario} (${meta.methodLabel})`);
      return run;
    },
  };
  return store;
}
