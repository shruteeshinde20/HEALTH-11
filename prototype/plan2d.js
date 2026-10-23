// HEALTH-11 prototype: 2D floor plans drawn to scale on a canvas.
import { rectOf, doorsOf } from "./layout.js";

const C = {
  bg: "#F8FAFC",
  room: "#D6E9F8",
  corridor: "#EEF2F6",
  vertical: "#FCE9B2",
  exit: "#BFE8D0",
  blocked: "#F9C5C5",
  outline: "#94A3B8",
  path: "#CBD5E1",
  text: "#334155",
  ink: "#1E3A5F",
  fire: "rgba(220,38,38,0.55)",
  smoke: "rgba(100,116,139,0.35)",
  thickSmoke: "rgba(71,85,105,0.55)",
  hazmat: "rgba(234,88,12,0.38)",
  people: { staff: "#1E3A5F", visitor: "#64748B", ambulatory: "#2563EB", wheelchair: "#7C3AED", stretcher: "#C2410C", ventilator: "#BE185D" },
};

function fillFor(type) {
  if (type === "corridor") return C.corridor;
  if (type === "stair" || type === "ramp" || type === "lift") return C.vertical;
  if (type === "exit" || type === "assembly") return C.exit;
  return C.room;
}

export function createPlan2D(container, model) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Floor plans drawn to scale");
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let floorFilter = null;
  let state = { positions: new Map(), people: [], hazards: [], fired: new Set() };

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
      return { f, x0: x0 - 2, x1: x1 + 2, y0: y0 - 5, y1: y1 + 2 };
    });
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;
    const wide = W > H * 1.2 && fl.length > 1 && W > 900;
    // Stack floors top to bottom (highest first) or side by side on wide screens
    const order = [...boxes].sort((a, b) => b.f - a.f);
    let scale;
    if (wide) {
      const totalW = order.reduce((s, b) => s + (b.x1 - b.x0), 0);
      const maxH = Math.max(...order.map((b) => b.y1 - b.y0));
      scale = Math.min((W - 16 * (order.length + 1)) / totalW, (H - 62) / maxH);
      let x = 16;
      for (const b of order) {
        b.ox = x;
        b.oy = 52;
        x += (b.x1 - b.x0) * scale + 16;
      }
    } else {
      const totalH = order.reduce((s, b) => s + (b.y1 - b.y0), 0);
      const maxW = Math.max(...order.map((b) => b.x1 - b.x0));
      scale = Math.min((W - 20) / maxW, (H - 52 - 12 * order.length) / totalH);
      let y = 52;
      for (const b of order) {
        b.ox = (W - (b.x1 - b.x0) * scale) / 2;
        b.oy = y;
        y += (b.y1 - b.y0) * scale + 12;
      }
    }
    return { boxes: new Map(order.map((b) => [b.f, b])), scale, W, H };
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { boxes, scale, W, H } = layout();
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

    for (const [f, b] of boxes) {
      ctx.fillStyle = C.ink;
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      ctx.fillText(f === 0 ? "Ground floor" : `Floor ${f}`, b.ox + 2, b.oy + 12);
    }

    const hazardAt = new Map();
    for (const h of state.hazards) for (const n of h.places) {
      const list = hazardAt.get(n) ?? [];
      list.push(h);
      hazardAt.set(n, list);
    }

    // Places
    for (const n of model.nodes) {
      if (!boxes.has(n.floor)) continue;
      const r = rectOf(n);
      const [x, y] = P(r.x0, r.y0, n.floor);
      const w = n.w * scale;
      const h = n.l * scale;
      ctx.fillStyle = n.blocked ? C.blocked : fillFor(n.type);
      ctx.fillRect(x, y, w, h);
      for (const hz of hazardAt.get(n.i) ?? []) {
        ctx.fillStyle = hz.type === "fire" ? C.fire : hz.type === "smoke" ? (hz.severity >= 4 ? C.thickSmoke : C.smoke) : C.hazmat;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (n.type === "stair") {
        ctx.strokeStyle = "#D9B54A";
        ctx.lineWidth = 1;
        for (let k = 1; k < 6; k++) {
          const yy = y + (h * k) / 6;
          ctx.beginPath();
          ctx.moveTo(x + 2, yy);
          ctx.lineTo(x + w - 2, yy);
          ctx.stroke();
        }
      }
      if (n.type === "lift") {
        ctx.strokeStyle = "#D9B54A";
        ctx.beginPath();
        ctx.moveTo(x + 2, y + 2);
        ctx.lineTo(x + w - 2, y + h - 2);
        ctx.moveTo(x + w - 2, y + 2);
        ctx.lineTo(x + 2, y + h - 2);
        ctx.stroke();
      }
    }
    // Doors
    ctx.fillStyle = C.bg;
    for (const e of model.edges) {
      if (e.virtual || e.kind !== "flat" || !boxes.has(model.nodes[e.u].floor)) continue;
      const ds = doorsOf(model, e);
      if (ds.length !== 2) continue;
      // A door is a gap in the wall, 1.2 m wide, across the line of travel.
      const along = Math.abs(ds[0][0] - ds[1][0]) < 1e-6 ? "x" : "y";
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 3;
      for (const d of ds) {
        const [x, y] = P(d[0], d[1], d[2]);
        const half = 0.6 * scale;
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
    }
    // Labels
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const n of model.nodes) {
      if (!boxes.has(n.floor) || n.type === "corridor") continue;
      const fs = Math.max(9, Math.min(12, scale * 1.3));
      ctx.font = `${n.type === "exit" ? 700 : 500} ${fs}px Inter, system-ui, sans-serif`;
      const label = n.type === "exit" ? "EXIT" : n.id.replace(/ (G|\d)$/, "");
      const width = ctx.measureText(label).width;
      if (width > n.w * scale + 30 && n.type !== "exit") continue;
      const [x, y] = P(n.x, n.y - n.l / 2, n.floor);
      ctx.fillStyle = n.type === "exit" ? "#166534" : C.text;
      ctx.fillText(label, x, n.type === "exit" ? y - fs * 0.8 : y + fs * 0.9);
    }
    // Sensors and cameras
    model.sensors.forEach((s, k) => {
      const n = model.nodes[s.node];
      if (!boxes.has(n.floor)) return;
      const [x, y] = P(n.x - n.w / 2 + 0.8 + (k % 3) * 0.9, n.y + n.l / 2 - 0.8, n.floor);
      ctx.fillStyle = state.fired.has(s.id) ? "#DC2626" : "#94A3B8";
      ctx.strokeStyle = state.fired.has(s.id) ? "#991B1B" : "#64748B";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    for (const c of model.cameras) {
      const n = model.nodes[c.node];
      if (!boxes.has(n.floor)) continue;
      const [x, y] = P(n.x + n.w / 2 - 0.6, n.y - n.l / 2 + 0.5, n.floor);
      ctx.fillStyle = C.ink;
      ctx.fillRect(x - 3, y - 2.5, 6, 5);
    }
    // People
    const r = Math.max(2, Math.min(4.5, scale * 0.32));
    for (const s of state.people) {
      const p = state.positions.get(s.id);
      if (!p) continue;
      const f = Math.round(p[2]);
      if (!boxes.has(f)) continue;
      const [x, y] = P(p[0], p[1], f);
      const col = s.kind === "staff" ? C.people.staff : s.kind === "visitor" ? C.people.visitor : C.people[s.mobility];
      ctx.fillStyle = col;
      if (s.kind === "patient" && (s.mobility === "stretcher" || s.mobility === "ventilator")) {
        ctx.fillRect(x - r * 1.1, y - r * 1.9, r * 2.2, r * 3.8);
      } else if (s.kind === "patient" && s.mobility === "wheelchair") {
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (s.helpers) {
        ctx.strokeStyle = C.people.staff;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r * 2.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (s.state === "reached" || s.state === "stuck_wait" || s.state === "needsHelp") {
        ctx.strokeStyle = s.state === "reached" ? "#DC2626" : s.state === "needsHelp" ? "#EA580C" : "#7C3AED";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Scale bar (10 m)
    const first = [...boxes.values()][0];
    const sx = first.ox + 4;
    const sy = H - 10;
    ctx.strokeStyle = C.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 10 * scale, sy);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = "500 11px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("10 m", sx + 10 * scale + 6, sy);
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  return {
    setFloor(f) {
      floorFilter = f;
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
