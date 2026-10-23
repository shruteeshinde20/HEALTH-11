// HEALTH-11 prototype: where things are drawn (shared by the 2D and 3D views).
// Plan coordinates are metres: x to the east, y to the south, floor number up.

export function rectOf(n) {
  return { x0: n.x - n.w / 2, x1: n.x + n.w / 2, y0: n.y - n.l / 2, y1: n.y + n.l / 2 };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6 || p[2] !== q[2]) out.push(p);
  }
  return out;
}

// The drawn line for a path, from edge.u to edge.v, passing through a door in
// the shared wall when the two places sit side by side.
export function edgePolyline(model, edge) {
  const a = model.nodes[edge.u];
  const b = model.nodes[edge.v];
  if (edge.kind !== "flat") return [[a.x, a.y, a.floor], [b.x, b.y, b.floor]];
  const A = rectOf(a);
  const B = rectOf(b);
  const f = a.floor;
  const ox0 = Math.max(A.x0, B.x0);
  const ox1 = Math.min(A.x1, B.x1);
  const oy0 = Math.max(A.y0, B.y0);
  const oy1 = Math.min(A.y1, B.y1);
  if (ox1 - ox0 >= 0.8 && Math.abs(a.y - b.y) > 1e-6 && (A.y1 <= B.y0 + 0.5 || B.y1 <= A.y0 + 0.5)) {
    const x = clamp((a.x + b.x) / 2, ox0 + 0.4, ox1 - 0.4);
    const down = a.y < b.y;
    const ya = down ? A.y1 : A.y0;
    const yb = down ? B.y0 : B.y1;
    return dedupe([[a.x, a.y, f], [x, a.y, f], [x, ya, f], [x, yb, f], [x, b.y, f], [b.x, b.y, f]]);
  }
  if (oy1 - oy0 >= 0.8 && Math.abs(a.x - b.x) > 1e-6 && (A.x1 <= B.x0 + 0.5 || B.x1 <= A.x0 + 0.5)) {
    const y = clamp((a.y + b.y) / 2, oy0 + 0.4, oy1 - 0.4);
    const right = a.x < b.x;
    const xa = right ? A.x1 : A.x0;
    const xb = right ? B.x0 : B.x1;
    return dedupe([[a.x, a.y, f], [a.x, y, f], [xa, y, f], [xb, y, f], [b.x, y, f], [b.x, b.y, f]]);
  }
  // Not side by side: an L through the corner that lies inside one of the places.
  const corner1 = [b.x, a.y];
  const inside = (r, p) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
  if (inside(A, corner1) || inside(B, corner1)) return dedupe([[a.x, a.y, f], [b.x, a.y, f], [b.x, b.y, f]]);
  return dedupe([[a.x, a.y, f], [a.x, b.y, f], [b.x, b.y, f]]);
}

// Door points: where a path crosses a wall (for drawing door gaps).
export function doorsOf(model, edge) {
  const line = edgePolyline(model, edge);
  return line.length === 6 ? [line[2], line[3]] : [];
}

export function polyLength(line) {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1], (line[i][2] - line[i - 1][2]) * 4);
  return s;
}

// Point at fraction 0..1 along a drawn line; returns [x, y, floor(float)].
export function pointAlong(line, frac) {
  const f = clamp(frac, 0, 1);
  const total = polyLength(line);
  if (total === 0) return line[0];
  let want = f * total;
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1];
    const q = line[i];
    const seg = Math.hypot(q[0] - p[0], q[1] - p[1], (q[2] - p[2]) * 4);
    if (want <= seg || i === line.length - 1) {
      const t = seg === 0 ? 0 : want / seg;
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    }
    want -= seg;
  }
  return line[line.length - 1];
}

// Spot k of n people standing in a place: a grid inside the room, 0.9 m apart.
export function spotInPlace(node, k, n) {
  const r = rectOf(node);
  const inset = Math.min(0.6, node.w / 4, node.l / 4);
  const w = Math.max(0.1, r.x1 - r.x0 - 2 * inset);
  const h = Math.max(0.1, r.y1 - r.y0 - 2 * inset);
  const cols = Math.max(1, Math.floor(w / 0.9) + 1);
  const rows = Math.max(1, Math.floor(h / 0.9) + 1);
  const cap = cols * rows;
  const i = k % cap;
  const layer = Math.floor(k / cap);
  const cx = cols === 1 ? node.x : r.x0 + inset + (i % cols) * (w / Math.max(1, cols - 1));
  const cy = rows === 1 ? node.y : r.y0 + inset + Math.floor(i / cols) * (h / Math.max(1, rows - 1));
  // Start from the middle so small groups gather near the centre.
  void n;
  return [cx + layer * 0.3, cy + layer * 0.3];
}

// Order spots so the first ones are nearest the centre of the room.
export function centredSpots(node, n) {
  const all = [];
  const r = rectOf(node);
  const inset = Math.min(0.6, node.w / 4, node.l / 4);
  for (let y = r.y0 + inset; y <= r.y1 - inset + 1e-9; y += 0.9) for (let x = r.x0 + inset; x <= r.x1 - inset + 1e-9; x += 0.9) all.push([x, y]);
  if (!all.length) all.push([node.x, node.y]);
  all.sort((p, q) => Math.hypot(p[0] - node.x, p[1] - node.y) - Math.hypot(q[0] - node.x, q[1] - node.y));
  const out = [];
  for (let k = 0; k < n; k++) {
    const base = all[k % all.length];
    const layer = Math.floor(k / all.length);
    out.push([base[0] + layer * 0.25, base[1] + layer * 0.25]);
  }
  return out;
}

// Positions for everyone in a snapshot: id -> [x, y, floor].
export function placePeople(model, snapshot, lines) {
  const out = new Map();
  const atNode = new Map();
  for (const s of snapshot.people) {
    if (s.state === "out") continue;
    if (s.lift) {
      const a = model.nodes[s.lift.from];
      const b = model.nodes[s.lift.to];
      out.set(s.id, [a.x, a.y, a.floor + (b.floor - a.floor) * s.lift.frac]);
    } else if (s.edge !== undefined) {
      const line = lines[s.edge];
      const p = pointAlong(line, s.frac);
      const side = ((s.id % 3) - 1) * 0.35;
      // small sideways offset so people walking together do not overlap
      const q = pointAlong(line, Math.min(1, s.frac + 0.01));
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      out.set(s.id, [p[0] - (dy / len) * side, p[1] + (dx / len) * side, p[2]]);
    } else {
      if (!atNode.has(s.node)) atNode.set(s.node, []);
      atNode.get(s.node).push(s.id);
    }
  }
  for (const [n, ids] of atNode) {
    const node = model.nodes[n];
    const spots = centredSpots(node, ids.length);
    ids.forEach((id, k) => out.set(id, [spots[k][0], spots[k][1], node.floor]));
  }
  return out;
}

export function bounds(model) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const n of model.nodes) {
    const r = rectOf(n);
    x0 = Math.min(x0, r.x0);
    x1 = Math.max(x1, r.x1);
    y0 = Math.min(y0, r.y0);
    y1 = Math.max(y1, r.y1);
  }
  return { x0, x1, y0, y1 };
}
