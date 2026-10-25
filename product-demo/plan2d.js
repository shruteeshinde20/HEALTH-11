// 2D floor plans drawn to scale like an architect's plan: walls, door swings,
// windows, furniture, people, smoke and the routing layers.
import { rectOf, doorsOf, edgePolyline, furnitureFor, isOuterSide } from "./layout.js";

export const C = {
  paper: "#FFFFFF",
  bg: "#F8FAFC",
  room: "#FFFFFF",
  ward: "#F5F9FC",
  corridor: "#EEF2F5",
  core: "#F4EFE2",
  exit: "#D9F0E1",
  refuge: "#E4F3EA",
  closed: "#EFE7E7",
  wall: "#3B4652",
  window: "#7DB8E8",
  furniture: "#B8C2CC",
  furnFill: "#F1F4F7",
  text: "#334155",
  muted: "#64748B",
  ink: "#1E3A5F",
  sign: "#0B7A4B",
  hazard: "#C2410C",
  fire: "rgba(234,88,12,0.55)",
  smoke: (a) => `rgba(71,85,105,${0.1 + 0.5 * a})`,
  people: { staff: "#2E8B9A", doctor: "#1E3A5F", visitor: "#8E6C9A", ambulatory: "#2A78D6", wheelchair: "#6250D6", stretcher: "#B45309", ventilator: "#B45309", rescue: "#C2410C" },
};

function fillFor(n, closed) {
  if (closed) return C.closed;
  if (n.refuge) return C.refuge;
  if (n.type === "corridor") return C.corridor;
  if (n.type === "stair" || n.type === "lift" || n.type === "ramp") return C.core;
  if (n.type === "exit" || n.type === "assembly") return C.exit;
  if (n.type === "ward" || n.type === "icu") return C.ward;
  return C.room;
}

export function personColour(s) {
  if (s.kind === "rescue") return C.people.rescue;
  if (s.kind === "staff") return s.role === "doctor" ? C.people.doctor : C.people.staff;
  if (s.kind === "visitor") return C.people.visitor;
  return C.people[s.mobility] ?? C.people.ambulatory;
}

export function createPlan2D(container, model, { onHover, onClick } = {}) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Floor plan drawn to scale with smoke, routes and people");
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let floorFilter = model.floors[0];
  let layers = { hazard: true, predicted: true, routes: true, density: false, signs: true, sensors: true, labels: true, furniture: true };
  let state = { positions: new Map(), snapshot: null, closed: new Set(), selected: null, selectedEdge: null, pending: null };
  let geo = null;
  const lines = model.edges.map((e) => edgePolyline(model, e));
  let furnCache = new Map();
  const furniture = (n) => {
    if (!furnCache.has(n.i)) furnCache.set(n.i, furnitureFor(model, n));
    return furnCache.get(n.i);
  };
  // Precompute walls per floor (door gaps, windows on outer sides)
  let wallCache = null;
  function walls() {
    if (wallCache) return wallCache;
    const doors = model.nodes.map(() => []);
    for (const e of model.edges) {
      if (e.virtual || e.kind !== "flat") continue;
      const d = doorsOf(model, e);
      if (d.length === 2) {
        doors[e.u].push([d[0], e.width, e]);
        doors[e.v].push([d[1], e.width, e]);
      }
    }
    const out = [];
    const swings = [];
    const seen = new Set();
    for (const n of model.nodes) {
      if (n.type === "exit") continue;
      const r = rectOf(n);
      for (const s of [
        { axis: "x", fixed: r.y0, lo: r.x0, hi: r.x1 },
        { axis: "x", fixed: r.y1, lo: r.x0, hi: r.x1 },
        { axis: "y", fixed: r.x0, lo: r.y0, hi: r.y1 },
        { axis: "y", fixed: r.x1, lo: r.y0, hi: r.y1 },
      ]) {
        const gaps = doors[n.i].filter(([d]) => Math.abs((s.axis === "x" ? d[1] : d[0]) - s.fixed) < 0.05).map(([d, w, e]) => [s.axis === "x" ? d[0] : d[1], Math.min(Math.max(w, 1.0), 2.4), e]).sort((p, q) => p[0] - q[0]);
        let start = s.lo;
        for (const [g, w, e] of gaps) {
          if (g - w / 2 > start) out.push({ f: n.floor, ...s, p0: start, p1: g - w / 2, outer: false });
          start = Math.max(start, g + w / 2);
          const key = `${e.i}`;
          if (!seen.has(key) && n.type !== "corridor") {
            seen.add(key);
            swings.push({ f: n.floor, axis: s.axis, fixed: s.fixed, at: g, w, into: s.axis === "x" ? (s.fixed === r.y0 ? 1 : -1) : (s.fixed === r.x0 ? 1 : -1), fire: e.fireDoor });
          } else if (e.fireDoor && !seen.has(`f${key}`)) {
            seen.add(`f${key}`);
            swings.push({ f: n.floor, axis: s.axis, fixed: s.fixed, at: g, w, into: 1, fire: true });
          }
        }
        if (s.hi > start) out.push({ f: n.floor, ...s, p0: start, p1: s.hi, outer: false });
      }
    }
    for (const w of out) {
      const n = model.nodes.find((m) => m.floor === w.f && (w.axis === "x" ? Math.abs(rectOf(m).y0 - w.fixed) < 0.01 || Math.abs(rectOf(m).y1 - w.fixed) < 0.01 : Math.abs(rectOf(m).x0 - w.fixed) < 0.01 || Math.abs(rectOf(m).x1 - w.fixed) < 0.01) && m.type !== "corridor" && m.type !== "exit");
      w.outer = !!n && isOuterSide(model, n, w.axis, w.fixed, (w.p0 + w.p1) / 2) && n.type !== "stair" && n.type !== "lift";
    }
    wallCache = { walls: out, swings };
    return wallCache;
  }

  const floorsShown = () => (floorFilter === null ? model.floors : [floorFilter]);

  function layout() {
    const fl = floorsShown();
    const boxes = fl.map((f) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const n of model.nodes) {
        if (n.floor !== f) continue;
        const r = rectOf(n);
        x0 = Math.min(x0, r.x0);
        x1 = Math.max(x1, r.x1);
        y0 = Math.min(y0, r.y0);
        y1 = Math.max(y1, r.y1);
      }
      return { f, x0: x0 - 1.5, x1: x1 + 1.5, y0: y0 - 4.5, y1: y1 + 1.5 };
    });
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;
    const order = [...boxes].sort((a, b) => b.f - a.f);
    const cols = order.length > 1 ? (W > 900 ? 2 : 1) : 1;
    const rows = Math.ceil(order.length / cols);
    const bw = Math.max(...order.map((b) => b.x1 - b.x0));
    const bh = Math.max(...order.map((b) => b.y1 - b.y0));
    const scale = Math.min((W - 16 - 12 * (cols - 1)) / (bw * cols), (H - 22 - 10 * (rows - 1)) / (bh * rows));
    order.forEach((b, k) => {
      const c = k % cols;
      const r = Math.floor(k / cols);
      const cellW = (W - 16) / cols;
      b.ox = 8 + c * cellW + (cellW - (b.x1 - b.x0) * scale) / 2;
      b.oy = 6 + r * (bh * scale + 10);
    });
    return { boxes: new Map(order.map((b) => [b.f, b])), scale, W, H };
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    geo = layout();
    const { boxes, scale, W, H } = geo;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const P = (x, y, f) => {
      const b = boxes.get(f);
      return [b.ox + (x - b.x0) * scale, b.oy + (y - b.y0) * scale];
    };
    const snap = state.snapshot;
    const smokeAt = new Map();
    if (snap && layers.hazard) for (const h of snap.hazard) smokeAt.set(h.n, h);
    const predicted = new Map();
    if (snap && layers.predicted) for (const q of snap.predicted) predicted.set(q.n, q.inS);
    const font = (w, s) => `${w} ${s}px Inter, system-ui, sans-serif`;

    for (const [f, b] of boxes) {
      ctx.fillStyle = C.ink;
      ctx.font = font(700, 12);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(f === 0 ? "Ground floor" : `Floor ${f}`, b.ox + 2, b.oy + 12);
    }
    // Places
    for (const n of model.nodes) {
      if (!boxes.has(n.floor)) continue;
      const r = rectOf(n);
      const [x, y] = P(r.x0, r.y0, n.floor);
      const w = n.w * scale;
      const h = n.l * scale;
      ctx.fillStyle = fillFor(n, state.closed.has(n.i));
      ctx.fillRect(x, y, w, h);
      if (n.type === "stair") {
        ctx.strokeStyle = "#B9A77A";
        ctx.lineWidth = 1;
        const steps = 10;
        for (let k = 1; k < steps; k++) {
          const yy = y + (h * k) / steps;
          ctx.beginPath();
          ctx.moveTo(x + 2, yy);
          ctx.lineTo(x + w * 0.5, yy);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(x + w * 0.5, y + 2);
        ctx.lineTo(x + w * 0.5, y + h - 2);
        ctx.stroke();
      }
      if (n.type === "lift") {
        ctx.strokeStyle = "#B9A77A";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 3);
        ctx.lineTo(x + w - 3, y + h - 3);
        ctx.moveTo(x + w - 3, y + 3);
        ctx.lineTo(x + 3, y + h - 3);
        ctx.stroke();
      }
      // furniture
      if (layers.furniture && scale > 3.2) {
        for (const it of furniture(n)) {
          const [fx, fy] = P(it.x, it.y, n.floor);
          const ww = (it.rot ? it.l : it.w) * scale;
          const hh = (it.rot ? it.w : it.l) * scale;
          ctx.fillStyle = C.furnFill;
          ctx.strokeStyle = C.furniture;
          ctx.lineWidth = 1;
          if (it.kind === "chair" || it.kind === "monitor" || it.kind === "otLamp") {
            ctx.beginPath();
            ctx.arc(fx, fy, Math.max(1.2, (it.w / 2) * scale * 0.8), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else if (it.kind === "scanner") {
            ctx.beginPath();
            ctx.arc(fx, fy, (it.w / 2) * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(fx, fy, (it.w / 4) * scale, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillRect(fx - ww / 2, fy - hh / 2, ww, hh);
            ctx.strokeRect(fx - ww / 2, fy - hh / 2, ww, hh);
            if (it.kind === "bed") {
              // pillow at the head end
              const ph = 0.35 * scale;
              ctx.fillStyle = "#FFFFFF";
              if (it.head === "n") ctx.fillRect(fx - ww / 2 + 2, fy - hh / 2 + 2, ww - 4, ph);
              else if (it.head === "s") ctx.fillRect(fx - ww / 2 + 2, fy + hh / 2 - ph - 2, ww - 4, ph);
              else if (it.head === "w") ctx.fillRect(fx - ww / 2 + 2, fy - hh / 2 + 2, ph, hh - 4);
              else ctx.fillRect(fx + ww / 2 - ph - 2, fy - hh / 2 + 2, ph, hh - 4);
            }
          }
        }
      }
      const hz = smokeAt.get(n.i);
      if (hz) {
        ctx.fillStyle = hz.fire ? C.fire : C.smoke(Math.min(1, hz.smoke));
        ctx.fillRect(x, y, w, h);
        if (hz.fire) {
          ctx.font = font(700, Math.max(10, Math.min(18, scale * 2)));
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#7C2D12";
          ctx.fillText("FIRE", x + w / 2, y + h / 2);
        }
      }
      if (predicted.has(n.i) && !hz) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = C.hazard;
        ctx.lineWidth = 1.6;
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
        ctx.restore();
      }
      if (state.selected === n.i) {
        ctx.strokeStyle = "#2563EB";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
      if (state.pending === n.i) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "#2563EB";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.restore();
      }
    }
    // Walls, windows and doors
    const wc = walls();
    for (const wl of wc.walls) {
      if (!boxes.has(wl.f)) continue;
      const [ax, ay] = wl.axis === "x" ? P(wl.p0, wl.fixed, wl.f) : P(wl.fixed, wl.p0, wl.f);
      const [bx, by] = wl.axis === "x" ? P(wl.p1, wl.fixed, wl.f) : P(wl.fixed, wl.p1, wl.f);
      ctx.strokeStyle = C.wall;
      ctx.lineWidth = wl.outer ? Math.max(2.5, scale * 0.3) : Math.max(1.5, scale * 0.15);
      ctx.lineCap = "square";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (wl.outer && Math.hypot(bx - ax, by - ay) > 20) {
        // window: a light double line in the middle part of the wall
        const t0 = 0.18;
        const t1 = 0.82;
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(1.5, scale * 0.18);
        ctx.beginPath();
        ctx.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
        ctx.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
        ctx.stroke();
        ctx.strokeStyle = C.window;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
        ctx.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
        ctx.stroke();
      }
    }
    if (scale > 3.2) {
      for (const s of wc.swings) {
        if (!boxes.has(s.f)) continue;
        const half = s.w / 2;
        const [hx, hy] = s.axis === "x" ? P(s.at - half, s.fixed, s.f) : P(s.fixed, s.at - half, s.f);
        const r = s.w * scale * (s.fire ? 0.5 : 1);
        ctx.strokeStyle = s.fire ? C.hazard : "#94A3B8";
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (s.axis === "x") {
          const dir = s.into;
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx, hy + dir * r);
          ctx.arc(hx, hy, r, dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0, dir > 0);
        } else {
          const dir = s.into;
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx + dir * r, hy);
          ctx.arc(hx, hy, r, dir > 0 ? 0 : Math.PI, Math.PI / 2, dir < 0);
        }
        ctx.stroke();
      }
    }
    // Crowding on paths
    if (snap && layers.density) {
      model.edges.forEach((e, i) => {
        const d = snap.density[i];
        if (!(d > 0.05) || !boxes.has(model.nodes[e.u].floor) || e.kind !== "flat") return;
        ctx.strokeStyle = d > 2 ? "rgba(194,65,12,0.8)" : d > 1 ? "rgba(161,98,7,0.7)" : "rgba(11,122,75,0.45)";
        ctx.lineWidth = Math.min(8, 2 + d * 2.2);
        ctx.lineCap = "round";
        ctx.beginPath();
        lines[i].forEach((pt, k) => {
          const [x, y] = P(pt[0], pt[1], pt[2]);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    }
    // Routes
    const drawRoute = (nodes, colour, dash, width) => {
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let k = 0; k + 1 < nodes.length; k++) {
        const a = model.nodes[nodes[k]];
        const b = model.nodes[nodes[k + 1]];
        if (a.floor !== b.floor || !boxes.has(a.floor)) continue;
        const ei = model.adj[nodes[k]].find((x) => (model.edges[x].u === nodes[k] && model.edges[x].v === nodes[k + 1]) || (model.edges[x].v === nodes[k] && model.edges[x].u === nodes[k + 1]));
        const pts = ei === undefined ? [[a.x, a.y, a.floor], [b.x, b.y, b.floor]] : model.edges[ei].u === nodes[k] ? lines[ei] : [...lines[ei]].reverse();
        ctx.beginPath();
        pts.forEach((pt, j) => {
          const [x, y] = P(pt[0], pt[1], pt[2]);
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.restore();
    };
    if (snap && layers.routes) {
      for (const r of snap.routes) for (const alt of r.alts) drawRoute(alt, "rgba(11,122,75,0.35)", [3, 4], 1.4);
      for (const r of snap.routes) drawRoute(r.nodes, r.kind === "fallback" ? "rgba(161,98,7,0.85)" : r.kind === "shelter" ? "rgba(194,65,12,0.8)" : "rgba(11,122,75,0.7)", [], 2);
      for (const t of snap.teams) if (t.route.length > 1) drawRoute(t.route, C.hazard, [6, 4], 2.4);
    }
    if (state.highlightRoute) drawRoute(state.highlightRoute, "#2563EB", [], 3);
    if (state.selectedEdge !== null && state.selectedEdge !== undefined) {
      const e = model.edges[state.selectedEdge];
      if (e && boxes.has(model.nodes[e.u].floor) && e.kind === "flat") drawRoute([e.u, e.v], "#2563EB", [], 4);
    }
    // Labels
    if (layers.labels) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const n of model.nodes) {
        if (!boxes.has(n.floor) || n.type === "corridor") continue;
        const fs = Math.max(8.5, Math.min(12, scale * 1.05));
        ctx.font = font(n.type === "exit" ? 700 : 600, fs);
        const label = n.type === "exit" ? "EXIT" : n.id.replace(/ (G|\d)$/, "");
        if (ctx.measureText(label).width > n.w * scale - 4 && n.type !== "exit") continue;
        const [x, y] = P(n.x, n.y + n.l / 2, n.floor);
        ctx.fillStyle = n.type === "exit" ? C.sign : C.muted;
        ctx.fillText(label, x, n.type === "exit" ? y + fs * 0.9 : y - fs * 0.85);
      }
    }
    // Signs
    if (snap && layers.signs) {
      for (const s of snap.signs) {
        const n = model.nodes[s.n];
        if (!boxes.has(n.floor)) continue;
        const [x, y] = P(n.x, n.y, n.floor);
        const sz = Math.max(7, Math.min(12, scale * 1.1));
        const recent = snap.t - s.changedAt < 12 && s.changedAt > 1;
        ctx.fillStyle = s.failed ? "#9AA5A0" : s.next < 0 ? C.hazard : C.sign;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        if (s.failed) {
          ctx.moveTo(x - sz * 0.25, y);
          ctx.lineTo(x + sz * 0.25, y);
        } else if (s.next < 0) {
          ctx.moveTo(x - sz * 0.25, y - sz * 0.25);
          ctx.lineTo(x + sz * 0.25, y + sz * 0.25);
          ctx.moveTo(x + sz * 0.25, y - sz * 0.25);
          ctx.lineTo(x - sz * 0.25, y + sz * 0.25);
        } else {
          const m = model.nodes[s.next];
          let a = Math.atan2(m.y - n.y, m.x - n.x);
          if (m.floor !== n.floor) a = Math.PI / 2;
          const c = Math.cos(a);
          const sn = Math.sin(a);
          const L = sz * 0.32;
          ctx.moveTo(x - c * L, y - sn * L);
          ctx.lineTo(x + c * L, y + sn * L);
          ctx.lineTo(x + c * L - (c * 0.6 - sn * 0.5) * L, y + sn * L - (sn * 0.6 + c * 0.5) * L);
          ctx.moveTo(x + c * L, y + sn * L);
          ctx.lineTo(x + c * L - (c * 0.6 + sn * 0.5) * L, y + sn * L - (sn * 0.6 - c * 0.5) * L);
        }
        ctx.stroke();
        if (recent) {
          ctx.strokeStyle = "rgba(11,122,75,0.6)";
          ctx.lineWidth = 1.2;
          ctx.strokeRect(x - sz / 2 - 2.5, y - sz / 2 - 2.5, sz + 5, sz + 5);
        }
      }
    }
    // Sensors
    if (snap && layers.sensors) {
      const count = new Map();
      for (const s of snap.sensors) {
        const n = model.nodes[s.node];
        if (!boxes.has(n.floor)) continue;
        const k = count.get(s.node) ?? 0;
        count.set(s.node, k + 1);
        const [x, y] = P(n.x + n.w / 2 - 0.7 - k * 0.8, n.y - n.l / 2 + 0.7, n.floor);
        ctx.beginPath();
        ctx.arc(x, y, 2.3, 0, Math.PI * 2);
        if (s.status !== "ok") {
          ctx.strokeStyle = C.muted;
          ctx.lineWidth = 1;
          ctx.fillStyle = "#FFFFFF";
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = s.detected ? C.hazard : "#94A3B8";
          ctx.fill();
        }
      }
    }
    // People
    const r = Math.max(1.8, Math.min(4.2, scale * 0.28));
    if (snap) {
      for (const s of snap.people) {
        const p = state.positions.get(s.id);
        if (!p) continue;
        const f = Math.round(p[2]);
        if (!boxes.has(f)) continue;
        const [x, y] = P(p[0], p[1], f);
        ctx.fillStyle = personColour(s);
        if (s.kind === "rescue") {
          ctx.fillRect(x - r * 1.4, y - r * 1.4, r * 2.8, r * 2.8);
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 1;
          ctx.strokeRect(x - r * 1.4, y - r * 1.4, r * 2.8, r * 2.8);
        } else if (s.kind === "patient" && (s.mobility === "stretcher" || s.mobility === "ventilator")) {
          const vertical = p[3] === "bed" ? !(p[4] ?? 0) : true;
          if (vertical) ctx.fillRect(x - r * 1.05, y - r * 1.8, r * 2.1, r * 3.6);
          else ctx.fillRect(x - r * 1.8, y - r * 1.05, r * 3.6, r * 2.1);
        } else if (s.kind === "patient" && s.mobility === "wheelchair") {
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        if (s.helpers && s.kind !== "rescue") {
          ctx.strokeStyle = C.people.staff;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (s.state === "incapacitated" || s.state === "shelter" || s.fed >= 0.3) {
          ctx.strokeStyle = s.state === "incapacitated" ? "#B91C1C" : C.hazard;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    // Scale bar and north arrow
    const first = [...boxes.values()][boxes.size - 1];
    const sx = first.ox + 4;
    const sy = H - 8;
    ctx.strokeStyle = C.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 10 * scale, sy);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = font(500, 11);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("10 m", sx + 10 * scale + 6, sy);
    ctx.fillText("N ↑", sx + 10 * scale + 46, sy);
  }

  function hit(ev) {
    if (!geo) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let best = null;
    for (const [f, b] of geo.boxes) {
      const x = (mx - b.ox) / geo.scale + b.x0;
      const y = (my - b.oy) / geo.scale + b.y0;
      for (const n of model.nodes) {
        if (n.floor !== f) continue;
        const r = rectOf(n);
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && (!best || n.w * n.l < best.node.w * best.node.l)) best = { node: n, x, y, f };
      }
    }
    return best;
  }
  canvas.addEventListener("mousemove", (ev) => {
    if (!onHover) return;
    const h = hit(ev);
    onHover(h ? h.node : null, ev, h);
  });
  canvas.addEventListener("mouseleave", () => onHover && onHover(null));
  canvas.addEventListener("click", (ev) => {
    if (!onClick) return;
    const h = hit(ev);
    onClick(h ? h.node : null, ev, h);
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  return {
    setFloor(f) {
      floorFilter = f;
      draw();
    },
    setLayers(l) {
      layers = { ...layers, ...l };
      draw();
    },
    update(next) {
      state = { ...state, ...next };
      draw();
    },
    // call after the building changed (Graph Builder)
    rebuilt() {
      wallCache = null;
      furnCache = new Map();
      draw();
    },
    hit,
    get scale() {
      return geo?.scale ?? 1;
    },
    dispose() {
      ro.disconnect();
      canvas.remove();
    },
    canvas,
  };
}
