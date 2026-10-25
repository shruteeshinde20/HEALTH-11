// Small SVG charts drawn to scale, with hover read-outs. No libraries.

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

let tip = null;
function tooltip() {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}
function showTip(html, ev) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 12;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
function hideTip() {
  if (tip) tip.hidden = true;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// "Nice" tick values covering [lo, hi].
export function ticks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return { values: out, step };
}

function frame(container, { width, height, left = 48, right = 14, top = 12, bottom = 34 }) {
  container.innerHTML = "";
  const W = width ?? Math.max(280, container.clientWidth || 520);
  const H = height ?? 240;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", class: "chart" }, container);
  return { svg, W, H, x0: left, x1: W - right, y0: top, y1: H - bottom };
}

function axes(f, xs, ys, { xFmt = (v) => v, yFmt = (v) => v, xLabel = "", yLabel = "", sx, sy }) {
  const g = el("g", { class: "axes" }, f.svg);
  for (const v of ys.values) {
    const y = sy(v);
    el("line", { x1: f.x0, x2: f.x1, y1: y, y2: y, class: "grid" }, g);
    const t = el("text", { x: f.x0 - 6, y: y + 4, "text-anchor": "end", class: "tick" }, g);
    t.textContent = yFmt(v);
  }
  for (const v of xs.values) {
    const x = sx(v);
    el("line", { x1: x, x2: x, y1: f.y1, y2: f.y1 + 4, class: "axis" }, g);
    const t = el("text", { x, y: f.y1 + 16, "text-anchor": "middle", class: "tick" }, g);
    t.textContent = xFmt(v);
  }
  el("line", { x1: f.x0, x2: f.x1, y1: f.y1, y2: f.y1, class: "axis" }, g);
  if (xLabel) {
    const t = el("text", { x: (f.x0 + f.x1) / 2, y: f.H - 4, "text-anchor": "middle", class: "label" }, g);
    t.textContent = xLabel;
  }
  if (yLabel) {
    const t = el("text", { x: f.x0, y: f.y0 - 2, "text-anchor": "start", class: "label" }, g);
    t.textContent = yLabel;
  }
}

// series: [{name, color, points: [[x, y]], dash?}], band?: {low, high (arrays of [x,y]), color}
export function lineChart(container, opts) {
  const f = frame(container, { height: opts.height ?? 240, top: 22 });
  const all = opts.series.flatMap((s) => s.points).concat(opts.band ? [...opts.band.low, ...opts.band.high] : []);
  if (!all.length) {
    container.innerHTML = `<p class="empty">${esc(opts.empty ?? "No data yet.")}</p>`;
    return;
  }
  const xMin = opts.xMin ?? Math.min(...all.map((p) => p[0]));
  const xMax = opts.xMax ?? Math.max(...all.map((p) => p[0]));
  const yMin = opts.yMin ?? Math.min(0, ...all.map((p) => p[1]));
  const yMax0 = opts.yMax ?? Math.max(...all.map((p) => p[1]));
  const xs = ticks(xMin, xMax, Math.max(3, Math.floor((f.x1 - f.x0) / 80)));
  const ys = ticks(yMin, yMax0, 4);
  const yMax = Math.max(yMax0, ys.values[ys.values.length - 1]);
  const sx = (v) => f.x0 + ((v - xMin) / (xMax - xMin || 1)) * (f.x1 - f.x0);
  const sy = (v) => f.y1 - ((v - yMin) / (yMax - yMin || 1)) * (f.y1 - f.y0);
  axes(f, { values: xs.values.filter((v) => v >= xMin && v <= xMax) }, { values: ys.values.filter((v) => v <= yMax) }, { ...opts, sx, sy });
  if (opts.band && opts.band.low.length) {
    const d = [...opts.band.high.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`), ...[...opts.band.low].reverse().map((p) => `L${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`), "Z"].join("");
    el("path", { d, fill: opts.band.color, "fill-opacity": 0.16, stroke: "none" }, f.svg);
  }
  for (const s of opts.series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
    el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width ?? 2, "stroke-dasharray": s.dash ?? "none", "stroke-linejoin": "round" }, f.svg);
    const last = s.points[s.points.length - 1];
    el("circle", { cx: sx(last[0]), cy: sy(last[1]), r: 3.5, fill: s.color, stroke: "var(--card)", "stroke-width": 2 }, f.svg);
  }
  // legend (always for 2+ series)
  if (opts.series.length > 1 || opts.band) {
    const lg = document.createElement("div");
    lg.className = "legend";
    lg.innerHTML = opts.series.map((s) => `<span><i style="background:${s.color}${s.dash ? ";opacity:.6" : ""}"></i>${esc(s.name)}</span>`).join("") + (opts.band ? `<span><i class="band" style="background:${opts.band.color}"></i>${esc(opts.band.name ?? "Range of runs")}</span>` : "");
    container.prepend(lg);
  }
  // crosshair + read-out
  const cross = el("line", { y1: f.y0, y2: f.y1, class: "cross", visibility: "hidden" }, f.svg);
  const hit = el("rect", { x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0, fill: "transparent" }, f.svg);
  const xFmt = opts.xFmt ?? ((v) => v);
  const yFmt = opts.yFmt ?? ((v) => v);
  hit.addEventListener("mousemove", (ev) => {
    const box = f.svg.getBoundingClientRect();
    const xv = xMin + ((ev.clientX - box.left) * (f.W / box.width) - f.x0) / (f.x1 - f.x0) * (xMax - xMin);
    const nearest = (pts) => pts.reduce((b, p) => (Math.abs(p[0] - xv) < Math.abs(b[0] - xv) ? p : b), pts[0]);
    const rows = opts.series.filter((s) => s.points.length).map((s) => {
      const p = nearest(s.points);
      return `<div><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(yFmt(p[1]))}</b></div>`;
    });
    if (opts.band) {
      const lo = nearest(opts.band.low);
      const hi = nearest(opts.band.high);
      rows.push(`<div class="muted">${esc(opts.band.name ?? "Range")} ${esc(yFmt(lo[1]))} to ${esc(yFmt(hi[1]))}</div>`);
    }
    const p0 = nearest(opts.series.find((s) => s.points.length).points);
    cross.setAttribute("x1", sx(p0[0]));
    cross.setAttribute("x2", sx(p0[0]));
    cross.setAttribute("visibility", "visible");
    showTip(`<div class="tip-h">${esc(opts.xName ?? "")} ${esc(xFmt(p0[0]))}</div>${rows.join("")}`, ev);
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
}

// Grouped bars with error whiskers. groups: [label], series: [{name, color, values: [{mean, sd}]}]
export function barChart(container, opts) {
  const vals = opts.series.flatMap((s) => s.values.map((v) => (v.mean ?? 0) + (v.sd ?? 0)));
  if (!vals.some((v) => v > 0)) {
    container.innerHTML = `<p class="empty">${esc(opts.zero ?? "Zero in every run for every method.")}</p>`;
    return;
  }
  const f = frame(container, { height: opts.height ?? 230, left: 52, top: 34, bottom: 40 });
  const ys = ticks(0, Math.max(1e-9, ...vals), 4);
  const yMax = ys.values[ys.values.length - 1] || 1;
  const sy = (v) => f.y1 - (v / yMax) * (f.y1 - f.y0);
  const fmt = opts.fmt ?? ((v) => v);
  const g = el("g", { class: "axes" }, f.svg);
  for (const v of ys.values) {
    el("line", { x1: f.x0, x2: f.x1, y1: sy(v), y2: sy(v), class: "grid" }, g);
    const t = el("text", { x: f.x0 - 6, y: sy(v) + 4, "text-anchor": "end", class: "tick" }, g);
    t.textContent = fmt(v);
  }
  el("line", { x1: f.x0, x2: f.x1, y1: f.y1, y2: f.y1, class: "axis" }, g);
  if (opts.yLabel) {
    const t = el("text", { x: f.x0 - 44, y: f.y0 - 18, class: "label" }, g);
    t.textContent = opts.yLabel;
  }
  const gw = (f.x1 - f.x0) / opts.groups.length;
  const n = opts.series.length;
  const bw = Math.min(26, (gw * 0.72) / n - 2);
  opts.groups.forEach((label, gi) => {
    const cxg = f.x0 + gw * (gi + 0.5);
    const t = el("text", { x: cxg, y: f.y1 + 16, "text-anchor": "middle", class: "tick" }, f.svg);
    t.textContent = label;
    opts.series.forEach((s, si) => {
      const v = s.values[gi];
      if (!v || v.mean === null || v.mean === undefined) return;
      const x = cxg + (si - (n - 1) / 2) * (bw + 2) - bw / 2;
      const y = sy(v.mean);
      const h = Math.max(0, f.y1 - y);
      const r = Math.min(4, bw / 2, h);
      const d = `M${x},${f.y1}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${f.y1}Z`;
      const bar = el("path", { d, fill: s.color }, f.svg);
      if (v.sd) {
        const top = sy(v.mean + v.sd);
        const bot = sy(Math.max(0, v.mean - v.sd));
        el("line", { x1: x + bw / 2, x2: x + bw / 2, y1: top, y2: bot, class: "whisker" }, f.svg);
        el("line", { x1: x + bw / 2 - 3, x2: x + bw / 2 + 3, y1: top, y2: top, class: "whisker" }, f.svg);
      }
      if (v.mean > 0 && bw >= 18) {
        const lab = el("text", { x: x + bw / 2, y: Math.min(y, v.sd ? sy(v.mean + v.sd) : y) - 4, "text-anchor": "middle", class: "value" }, f.svg);
        lab.textContent = fmt(v.mean);
      }
      const hitbox = el("rect", { x: x - 1, y: f.y0, width: bw + 2, height: f.y1 - f.y0, fill: "transparent" }, f.svg);
      const show = (ev) => showTip(`<div class="tip-h">${esc(label)}</div><div><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(fmt(v.mean))}</b>${v.sd !== null && v.sd !== undefined ? ` <span class="muted">sd ${esc(fmt(v.sd))}</span>` : ""}</div>`, ev);
      hitbox.addEventListener("mousemove", show);
      hitbox.addEventListener("mouseleave", hideTip);
      void bar;
    });
  });
  const lg = document.createElement("div");
  lg.className = "legend";
  lg.innerHTML = opts.series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
  container.prepend(lg);
}

// Scatter with an optional y = x line. points: [{x, y, label}]
export function scatter(container, opts) {
  const f = frame(container, { height: opts.height ?? 260, top: 22 });
  if (!opts.points.length) {
    container.innerHTML = `<p class="empty">${esc(opts.empty ?? "No data yet.")}</p>`;
    return;
  }
  const hi = Math.max(...opts.points.flatMap((p) => [p.x, p.y]));
  const lo = Math.min(0, ...opts.points.flatMap((p) => [p.x, p.y]));
  const xs = ticks(lo, hi, 4);
  const top = xs.values[xs.values.length - 1];
  const sx = (v) => f.x0 + ((v - lo) / (top - lo || 1)) * (f.x1 - f.x0);
  const sy = (v) => f.y1 - ((v - lo) / (top - lo || 1)) * (f.y1 - f.y0);
  axes(f, xs, xs, { ...opts, sx, sy });
  if (opts.diag) el("line", { x1: sx(lo), y1: sy(lo), x2: sx(top), y2: sy(top), class: "diag" }, f.svg);
  for (const p of opts.points) {
    const c = el("circle", { cx: sx(p.x), cy: sy(p.y), r: 4, fill: opts.color ?? "var(--sign)", "fill-opacity": 0.8, stroke: "var(--card)", "stroke-width": 1.5 }, f.svg);
    const hitc = el("circle", { cx: sx(p.x), cy: sy(p.y), r: 9, fill: "transparent" }, f.svg);
    hitc.addEventListener("mousemove", (ev) => showTip(`<div class="tip-h">${esc(p.label)}</div><div>${esc(opts.xName)} <b>${Math.round(p.x)} s</b></div><div>${esc(opts.yName)} <b>${Math.round(p.y)} s</b></div>`, ev));
    hitc.addEventListener("mouseleave", hideTip);
    void c;
  }
}

// Heat map of a value over a grid (lower is better). cells: [{x, y, v}]
export function heatmap(container, opts) {
  const xs = [...new Set(opts.cells.map((c) => c.x))].sort((a, b) => a - b);
  const ys = [...new Set(opts.cells.map((c) => c.y))].sort((a, b) => a - b);
  const vmin = Math.min(...opts.cells.map((c) => c.v));
  const vmax = Math.max(...opts.cells.map((c) => c.v));
  const f = frame(container, { height: 40 + ys.length * 34, left: 70, top: 22, bottom: 38 });
  const cw = (f.x1 - f.x0) / xs.length;
  const ch = (f.y1 - f.y0) / ys.length;
  for (const c of opts.cells) {
    const i = xs.indexOf(c.x);
    const j = ys.indexOf(c.y);
    const t = vmax > vmin ? (c.v - vmin) / (vmax - vmin) : 0;
    // one hue, light (worse) to dark (better)
    const light = 92 - (1 - t) * 58;
    const fill = `hsl(152 55% ${light}%)`;
    const x = f.x0 + i * cw;
    const y = f.y0 + (ys.length - 1 - j) * ch;
    el("rect", { x: x + 1, y: y + 1, width: cw - 2, height: ch - 2, rx: 3, fill }, f.svg);
    const txt = el("text", { x: x + cw / 2, y: y + ch / 2 + 4, "text-anchor": "middle", class: light < 60 ? "cell dark" : "cell" }, f.svg);
    txt.textContent = opts.fmt(c.v);
    if (opts.best && opts.best.x === c.x && opts.best.y === c.y) el("rect", { x: x + 2.5, y: y + 2.5, width: cw - 5, height: ch - 5, rx: 3, fill: "none", class: "best" }, f.svg);
    const hit = el("rect", { x, y, width: cw, height: ch, fill: "transparent" }, f.svg);
    hit.addEventListener("mousemove", (ev) => showTip(`<div class="tip-h">${esc(opts.xName)} ${c.x}, ${esc(opts.yName)} ${c.y}</div><div>${esc(opts.vName)} <b>${esc(opts.fmt(c.v))}</b></div>`, ev));
    hit.addEventListener("mouseleave", hideTip);
  }
  xs.forEach((x, i) => {
    const t = el("text", { x: f.x0 + (i + 0.5) * cw, y: f.y1 + 16, "text-anchor": "middle", class: "tick" }, f.svg);
    t.textContent = `×${x}`;
  });
  ys.forEach((y, j) => {
    const t = el("text", { x: f.x0 - 8, y: f.y0 + (ys.length - 1 - j + 0.5) * ch + 4, "text-anchor": "end", class: "tick" }, f.svg);
    t.textContent = `×${y}`;
  });
  const lx = el("text", { x: (f.x0 + f.x1) / 2, y: f.H - 4, "text-anchor": "middle", class: "label" }, f.svg);
  lx.textContent = opts.xLabel;
  const ly = el("text", { x: 4, y: f.y0 - 8, class: "label" }, f.svg);
  ly.textContent = opts.yLabel;
}
