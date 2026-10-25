// 2D floor plans drawn to scale on a canvas, with the routing layers.
import { rectOf, doorsOf, edgePolyline } from "./layout.js";

export const C = {
  bg: "#F5F7F6",
  room: "#FFFFFF",
  ward: "#F3F7FB",
  corridor: "#ECF1EE",
  vertical: "#F7F0DC",
  exit: "#D7ECDF",
  refuge: "#E6F2EC",
  closed: "#E9E4E4",
  outline: "#B9C4BE",
  wall: "#8E9B94",
  text: "#34433C",
  muted: "#63726B",
  ink: "#14231C",
  sign: "#0B7A4B",
  signDark: "#06402A",
  hazard: "#C2410C",
  fire: "rgba(194,65,12,0.62)",
  smoke: (a) => `rgba(71,85,105,${0.12 + 0.5 * a})`,
  people: { staff: "#14231C", visitor: "#7A8781", ambulatory: "#2A78D6", wheelchair: "#6250D6", stretcher: "#B45309", ventilator: "#B45309", rescue: "#C2410C" },
};

function fillFor(n, closed) {
  if (closed) return C.closed;
  if (n.refuge) return C.refuge;
  if (n.type === "corridor") return C.corridor;
  if (n.type === "stair" || n.type === "lift" || n.type === "ramp") return C.vertical;
  if (n.type === "exit" || n.type === "assembly") return C.exit;
  if (n.type === "ward" || n.type === "icu") return C.ward;
  return C.room;
}

export function personColour(s) {
  if (s.kind === "rescue") return C.people.rescue;
  if (s.kind === "staff") return C.people.staff;
  if (s.kind === "visitor") return C.people.visitor;
  return C.people[s.mobility] ?? C.people.ambulatory;
}

export function createPlan2D(container, model, { onHover } = {}) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Floor plans drawn to scale with smoke, routes and people");
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let floorFilter = null;
  let layers = { hazard: true, predicted: true, routes: true, density: false, signs: true, sensors: true };
  let state = { positions: new Map(), snapshot: null, closed: new Set() };
  let geo = null;
  const lines = model.edges.map((e) => edgePolyline(model, e));

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
    const totalH = order.reduce((s, b) => s + (b.y1 - b.y0), 0);
    const maxW = Math.max(...order.map((b) => b.x1 - b.x0));
    const scale = Math.min((W - 16) / maxW, (H - 24 - 10 * order.length) / totalH);
    let y = 8;
    for (const b of order) {
      b.ox = (W - (b.x1 - b.x0) * scale) / 2;
      b.oy = y;
      y += (b.y1 - b.y0) * scale + 10;
    }
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
    const font = (w, s) => `${w} ${s}px "IBM Plex Sans", system-ui, sans-serif`;

    for (const [f, b] of boxes) {
      ctx.fillStyle = C.ink;
      ctx.font = font(600, 12);
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
      const hz = smokeAt.get(n.i);
      if (hz) {
        ctx.fillStyle = hz.fire ? C.fire : C.smoke(Math.min(1, hz.smoke));
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (n.type === "stair") {
        ctx.strokeStyle = "#C9AE63";
        for (let k = 1; k < 6; k++) {
          const yy = y + (h * k) / 6;
          ctx.beginPath();
          ctx.moveTo(x + 2, yy);
          ctx.lineTo(x + w - 2, yy);
          ctx.stroke();
        }
      }
      if (n.type === "lift") {
        ctx.strokeStyle = "#C9AE63";
        ctx.beginPath();
        ctx.moveTo(x + 2, y + 2);
        ctx.lineTo(x + w - 2, y + h - 2);
        ctx.moveTo(x + w - 2, y + 2);
        ctx.lineTo(x + 2, y + h - 2);
        ctx.stroke();
      }
      if (predicted.has(n.i) && !hz) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = C.hazard;
        ctx.lineWidth = 1.6;
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
        ctx.restore();
      }
    }
    // Doors (gaps in the walls)
    ctx.strokeStyle = C.bg;
    ctx.lineWidth = 2.5;
    for (const e of model.edges) {
      if (e.virtual || e.kind !== "flat" || !boxes.has(model.nodes[e.u].floor)) continue;
      const ds = doorsOf(model, e);
      if (ds.length !== 2) continue;
      const along = Math.abs(ds[0][0] - ds[1][0]) < 1e-6 ? "x" : "y";
      for (const d of ds) {
        const [x, y] = P(d[0], d[1], d[2]);
        const half = (Math.min(e.width, 1.6) / 2) * scale;
        ctx.beginPath();
        if (along === "x") {
          ctx.moveTo(x - half, y);
          ctx.lineTo(x + half, y);
        } else {
          ctx.moveTo(x, y - half);
          ctx.lineTo(x, y + half);
        }
        ctx.stroke();
      }
      if (e.fireDoor) {
        const [x, y] = P(ds[0][0], ds[0][1], ds[0][2]);
        ctx.fillStyle = C.hazard;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    // Crowd density on paths
    if (snap && layers.density) {
      model.edges.forEach((e, i) => {
        const d = snap.density[i];
        if (!(d > 0.05) || !boxes.has(model.nodes[e.u].floor) || e.kind !== "flat") return;
        const pts = lines[i];
        ctx.strokeStyle = d > 2 ? "rgba(194,65,12,0.8)" : d > 1 ? "rgba(161,98,7,0.7)" : "rgba(11,122,75,0.45)";
        ctx.lineWidth = Math.min(8, 2 + d * 2.2);
        ctx.lineCap = "round";
        ctx.beginPath();
        pts.forEach((pt, k) => {
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
      let open = false;
      for (let k = 0; k + 1 < nodes.length; k++) {
        const a = model.nodes[nodes[k]];
        const b = model.nodes[nodes[k + 1]];
        if (a.floor !== b.floor || !boxes.has(a.floor)) {
          open = false;
          continue;
        }
        const ei = model.adj[nodes[k]].find((x) => (model.edges[x].u === nodes[k] && model.edges[x].v === nodes[k + 1]) || (model.edges[x].v === nodes[k] && model.edges[x].u === nodes[k + 1]));
        const pts = ei === undefined ? [[a.x, a.y, a.floor], [b.x, b.y, b.floor]] : model.edges[ei].u === nodes[k] ? lines[ei] : [...lines[ei]].reverse();
        if (!open) ctx.beginPath();
        pts.forEach((pt, j) => {
          const [x, y] = P(pt[0], pt[1], pt[2]);
          if (j === 0 && !open) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        open = true;
        ctx.stroke();
        ctx.beginPath();
        const last = pts[pts.length - 1];
        const [lx, ly] = P(last[0], last[1], last[2]);
        ctx.moveTo(lx, ly);
      }
      ctx.restore();
    };
    if (snap && layers.routes) {
      for (const r of snap.routes) for (const alt of r.alts) drawRoute(alt, "rgba(11,122,75,0.35)", [3, 4], 1.4);
      for (const r of snap.routes) drawRoute(r.nodes, r.kind === "fallback" ? "rgba(161,98,7,0.85)" : r.kind === "shelter" ? "rgba(194,65,12,0.8)" : "rgba(11,122,75,0.7)", [], 2);
      for (const t of snap.teams) if (t.route.length > 1) drawRoute(t.route, C.hazard, [6, 4], 2.4);
    }
    // Labels
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const n of model.nodes) {
      if (!boxes.has(n.floor) || n.type === "corridor") continue;
      const fs = Math.max(8.5, Math.min(11.5, scale * 1.15));
      ctx.font = font(n.type === "exit" ? 700 : 500, fs);
      const label = n.type === "exit" ? "EXIT" : n.id.replace(/ (G|\d)$/, "");
      if (ctx.measureText(label).width > n.w * scale - 4 && n.type !== "exit") continue;
      const [x, y] = P(n.x, n.y - n.l / 2, n.floor);
      ctx.fillStyle = n.type === "exit" ? C.sign : C.muted;
      ctx.fillText(label, x, n.type === "exit" ? y - fs * 0.7 : y + fs * 0.95);
    }
    // Exit signs
    if (snap && layers.signs) {
      for (const s of snap.signs) {
        const n = model.nodes[s.n];
        if (!boxes.has(n.floor)) continue;
        const [x, y] = P(n.x, n.y, n.floor);
        const sz = Math.max(7, Math.min(11, scale * 1.1));
        const recent = snap.t - s.changedAt < 12;
        ctx.fillStyle = s.failed ? "#9AA5A0" : s.next < 0 ? C.hazard : recent ? C.signDark : C.sign;
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
          ctx.moveTo(x + c * L, y + sn * L);
          ctx.lineTo(x + c * L - (c * 0.6 - sn * 0.5) * L, y + sn * L - (sn * 0.6 + c * 0.5) * L);
          ctx.moveTo(x + c * L, y + sn * L);
          ctx.lineTo(x + c * L - (c * 0.6 + sn * 0.5) * L, y + sn * L - (sn * 0.6 - c * 0.5) * L);
        }
        ctx.stroke();
        if (recent) {
          ctx.strokeStyle = "rgba(11,122,75,0.5)";
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
        const [x, y] = P(n.x - n.w / 2 + 0.7 + k * 0.8, n.y + n.l / 2 - 0.7, n.floor);
        const bad = s.status !== "ok";
        ctx.beginPath();
        ctx.arc(x, y, 2.3, 0, Math.PI * 2);
        if (bad) {
          ctx.strokeStyle = C.muted;
          ctx.lineWidth = 1;
          ctx.fillStyle = "#FFFFFF";
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = s.detected ? C.hazard : "#9AA5A0";
          ctx.fill();
        }
      }
    }
    // People
    const r = Math.max(1.8, Math.min(4, scale * 0.3));
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
          ctx.fillRect(x - r * 1.05, y - r * 1.8, r * 2.1, r * 3.6);
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
          ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
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
    // Scale bar
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
  }

  // Which place is under the pointer?
  canvas.addEventListener("mousemove", (ev) => {
    if (!geo || !onHover) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let hit = null;
    for (const [f, b] of geo.boxes) {
      const x = (mx - b.ox) / geo.scale + b.x0;
      const y = (my - b.oy) / geo.scale + b.y0;
      for (const n of model.nodes) {
        if (n.floor !== f) continue;
        const r = rectOf(n);
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && (!hit || n.w * n.l < hit.w * hit.l)) hit = n;
      }
    }
    onHover(hit, ev);
  });
  canvas.addEventListener("mouseleave", () => onHover && onHover(null));

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
    dispose() {
      ro.disconnect();
      canvas.remove();
    },
    canvas,
  };
}
