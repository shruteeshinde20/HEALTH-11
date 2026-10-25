// Small helpers for building the pages.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const fmtTime = (s) => (s === null || s === undefined || !Number.isFinite(s) ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
export const fmtS = (s) => (s === null || s === undefined || !Number.isFinite(s) ? "–" : `${Math.round(s)} s`);
export const fmtMin = (s) => (s === null || s === undefined || !Number.isFinite(s) ? "–" : `${(s / 60).toFixed(1)} min`);
export const f2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(d));
export const floorName = (f) => (f === 0 ? "Ground floor" : `Floor ${f}`);

export function header(title, subtitle, actions = "") {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p class="sub">${subtitle}</p>` : ""}</div>${actions ? `<div class="row">${actions}</div>` : ""}</div>`;
}

export function stat(value, label, sub = "") {
  return `<div class="stat"><span class="big">${esc(value)}</span><span class="lab">${esc(label)}</span>${sub ? `<span class="small muted">${sub}</span>` : ""}</div>`;
}

export function table(columns, rows, { empty = "Nothing here yet.", id = "" } = {}) {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="tbl"><table${id ? ` id="${id}"` : ""}><thead><tr>${columns.map((c) => `<th${c.n ? ' class="n"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr${r._attrs ? ` ${r._attrs}` : ""}>${columns.map((c) => `<td${c.n ? ' class="n num"' : ""}>${c.html ? c.get(r) : esc(c.get(r))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export function pill(text, tone = "mute") {
  return `<span class="pill ${tone}">${esc(text)}</span>`;
}

export function option(value, label, selected = false) {
  return `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
}

let toastTimer = null;
export function toast(message, tone = "ok") {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.className = `toast ${tone}`;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// A confirmation step inside the page (no browser dialogs).
export function confirmBox(message, okLabel = "Delete") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><p>${esc(message)}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-x="no">Cancel</button><button class="btn danger-solid" data-x="yes">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(wrap);
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (b) done(b.dataset.x === "yes");
      else if (ev.target === wrap) done(false);
    });
    wrap.querySelector('[data-x="no"]').focus();
  });
}

export function download(name, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export function readFile(input, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const f = input.files?.[0];
    if (!f) return reject(new Error("No file chosen"));
    if (f.size > maxBytes) return reject(new Error("The file is larger than 2 MB"));
    f.text().then((text) => resolve({ name: f.name, text }), reject);
  });
}
