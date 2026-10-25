// Where things are drawn (shared by the 2D and 3D views).
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

// ---------------------------------------------------------------------------
// Furniture: what stands in each room (same in 2D and 3D)
// item: {kind, x, y, w, l, rot (radians, 0 = long side along y)}
// ---------------------------------------------------------------------------

const has = (id, ...words) => words.some((w) => id.includes(w));

// Which side of the room is the outside wall (away from its door): "n" | "s" | "w" | "e".
function outerSide(model, node) {
  const doors = [];
  for (const ei of model.adj[node.i]) {
    const d = doorsOf(model, model.edges[ei]);
    if (d.length) doors.push(model.edges[ei].u === node.i ? d[0] : d[1]);
  }
  const r = rectOf(node);
  if (!doors.length) return "n";
  const d = doors[0];
  if (Math.abs(d[1] - r.y1) < 0.1) return "n";
  if (Math.abs(d[1] - r.y0) < 0.1) return "s";
  if (Math.abs(d[0] - r.x1) < 0.1) return "w";
  return "e";
}

export function furnitureFor(model, node) {
  const id = node.id;
  const r = rectOf(node);
  const items = [];
  if (["corridor", "exit", "assembly", "stair", "lift"].includes(node.type)) return items;
  const side = outerSide(model, node);
  const along = side === "n" || side === "s";
  // positions along the outer wall, head against it
  const rowAlongWall = (count, depth, width, gap, kind, inset = 0.25) => {
    const span = along ? r.x1 - r.x0 : r.y1 - r.y0;
    const n = Math.max(1, Math.min(count, Math.floor((span - 1) / (width + gap))));
    const start = (span - (n * width + (n - 1) * gap)) / 2 + width / 2;
    for (let k = 0; k < n; k++) {
      const s = start + k * (width + gap);
      let x;
      let y;
      if (side === "n") [x, y] = [r.x0 + s, r.y0 + inset + depth / 2];
      else if (side === "s") [x, y] = [r.x0 + s, r.y1 - inset - depth / 2];
      else if (side === "w") [x, y] = [r.x0 + inset + depth / 2, r.y0 + s];
      else [x, y] = [r.x1 - inset - depth / 2, r.y0 + s];
      items.push({ kind, x, y, w: width, l: depth, rot: along ? 0 : Math.PI / 2, head: side });
    }
  };
  if (has(id, "NICU") || id === "Incubator Store") {
    rowAlongWall(id.startsWith("NICU") ? 5 : 3, 0.7, 1.1, 0.9, "incubator", 0.6);
  } else if (id.startsWith("OT ")) {
    items.push({ kind: "otTable", x: node.x, y: node.y, w: 0.7, l: 2.0, rot: along ? 0 : Math.PI / 2 });
    items.push({ kind: "otLamp", x: node.x, y: node.y, w: 1.2, l: 1.2, rot: 0 });
    items.push({ kind: "monitor", x: node.x + 1.2, y: node.y - 0.9, w: 0.5, l: 0.5, rot: 0 });
  } else if (node.type === "icu" || node.type === "ward" || has(id, "Recovery", "Labour", "Pre-op", "Private Rooms", "Isolation")) {
    const icu = node.type === "icu";
    rowAlongWall(4, 2.05, 1.0, icu ? 1.7 : 1.6, "bed", 0.3);
    if (icu) {
      const beds = items.filter((x) => x.kind === "bed");
      for (const b of beds) {
        const off = 0.85;
        items.push({ kind: "monitor", x: b.x + (along ? off : 0), y: b.y + (along ? 0 : off), w: 0.45, l: 0.45, rot: 0 });
      }
    }
  } else if (has(id, "CT Scan", "MRI")) {
    items.push({ kind: "scanner", x: node.x, y: node.y, w: 2.4, l: 2.4, rot: along ? 0 : Math.PI / 2 });
    items.push({ kind: "bed", x: node.x + (along ? 0 : 1.8), y: node.y + (along ? 1.8 : 0), w: 0.7, l: 2.0, rot: along ? 0 : Math.PI / 2, empty: true });
  } else if (has(id, "X-Ray")) {
    items.push({ kind: "bed", x: node.x, y: node.y, w: 0.8, l: 2.0, rot: along ? 0 : Math.PI / 2, empty: true });
    items.push({ kind: "machine", x: node.x + 2, y: node.y, w: 1.0, l: 1.0, rot: 0 });
  } else if (has(id, "Nurses Station", "Staff Base", "ICU Nurses", "Billing", "Security", "Porters", "Sample Collection")) {
    items.push({ kind: "counter", x: node.x, y: node.y, w: Math.min(node.w - 2, 6), l: 0.8, rot: Math.PI / 2 });
    items.push({ kind: "chair", x: node.x - 1, y: node.y + 1, w: 0.5, l: 0.5, rot: 0 });
    items.push({ kind: "chair", x: node.x + 1, y: node.y + 1, w: 0.5, l: 0.5, rot: 0 });
  } else if (has(id, "Store", "Pharmacy", "Records", "Laboratory", "CSSD", "Linen", "Clean Utility", "Blood Bank", "Milk Room", "Sterile", "Equipment", "ICU Pharmacy")) {
    rowAlongWall(5, 0.6, 1.6, 0.4, "shelf", 0.15);
    if (has(id, "Laboratory", "Blood Bank", "Pharmacy")) items.push({ kind: "counter", x: node.x, y: node.y + (along ? 1 : 0), w: Math.min(node.w - 3, 5), l: 0.8, rot: Math.PI / 2 });
  } else if (has(id, "Kitchen", "Laundry", "Plant", "Workshop", "Gas Manifold", "Sluice")) {
    rowAlongWall(4, 0.9, 1.8, 0.5, "machine", 0.2);
  } else if (has(id, "Cafeteria")) {
    for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) items.push({ kind: "table", x: r.x0 + 2.5 + a * 3.5, y: r.y0 + 3 + b * 4, w: 1.2, l: 1.2, rot: 0 });
  } else if (has(id, "Waiting", "OPD", "Day Room", "Day Care", "Relatives", "Entrance Hall", "Refuge", "Physiotherapy", "Dental", "Triage", "Play Room", "Feeding", "Doctors", "Dialysis", "Casualty", "Treatment", "Anaesthesia", "Scrub")) {
    if (has(id, "Dialysis", "Casualty", "Treatment", "Triage")) rowAlongWall(4, 1.9, 0.9, 1.4, "bed", 0.3);
    else if (has(id, "OPD", "Dental", "Doctors", "Anaesthesia")) {
      items.push({ kind: "table", x: node.x, y: node.y - 1, w: 1.6, l: 0.8, rot: Math.PI / 2 });
      items.push({ kind: "chair", x: node.x - 1.4, y: node.y + 1.2, w: 0.5, l: 0.5, rot: 0 });
      items.push({ kind: "chair", x: node.x + 0.2, y: node.y + 1.2, w: 0.5, l: 0.5, rot: 0 });
      items.push({ kind: "chair", x: node.x + 1.4, y: node.y + 1.2, w: 0.5, l: 0.5, rot: 0 });
    } else {
      const rows = Math.max(1, Math.floor((r.y1 - r.y0 - 3) / 1.6));
      for (let q = 0; q < Math.min(rows, 4); q++) {
        for (let k = 0; k < Math.floor((r.x1 - r.x0 - 2) / 0.65) && k < 14; k++) {
          if (k % 5 === 4) continue;
          items.push({ kind: "chair", x: r.x0 + 1.2 + k * 0.65, y: r.y0 + 1.6 + q * 1.6, w: 0.5, l: 0.5, rot: 0 });
        }
      }
    }
  }
  return items;
}

// Places where people wait in a room: bed slots first (for bed patients), then standing spots.
export function slotsFor(model, node, cache) {
  if (cache && cache.has(node.i)) return cache.get(node.i);
  const furn = furnitureFor(model, node);
  const beds = furn.filter((f) => (f.kind === "bed" || f.kind === "incubator" || f.kind === "otTable") && !f.empty);
  const r = rectOf(node);
  const inset = Math.min(0.7, node.w / 4, node.l / 4);
  const spots = [];
  for (let y = r.y0 + inset; y <= r.y1 - inset + 1e-9; y += 0.85) for (let x = r.x0 + inset; x <= r.x1 - inset + 1e-9; x += 0.85) {
    if (furn.some((f) => Math.abs(f.x - x) < (f.rot ? f.l : f.w) / 2 + 0.3 && Math.abs(f.y - y) < (f.rot ? f.w : f.l) / 2 + 0.3)) continue;
    spots.push([x, y]);
  }
  if (!spots.length) spots.push([node.x, node.y]);
  spots.sort((p, q) => Math.hypot(p[0] - node.x, p[1] - node.y) - Math.hypot(q[0] - node.x, q[1] - node.y));
  const out = { beds, spots };
  if (cache) cache.set(node.i, out);
  return out;
}

const BEDDED = new Set(["stretcher", "ventilator"]);

// Positions for everyone in a snapshot: id -> [x, y, floor, pose] (pose: "stand" | "bed" | "chair").
export function placePeople(model, snapshot, lines, cache = new Map()) {
  const out = new Map();
  const atNode = new Map();
  for (const s of snapshot.people) {
    if (s.state === "out") continue;
    if (s.lift) {
      const a = model.nodes[s.lift.from];
      const b = model.nodes[s.lift.to];
      out.set(s.id, [a.x, a.y, a.floor + (b.floor - a.floor) * s.lift.frac, "lift"]);
    } else if (s.edge !== undefined) {
      const line = lines[s.edge];
      const p = pointAlong(line, s.frac);
      const side = ((s.id % 3) - 1) * 0.35;
      const q = pointAlong(line, Math.min(1, s.frac + 0.01));
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      out.set(s.id, [p[0] - (dy / len) * side, p[1] + (dx / len) * side, p[2], "walk"]);
    } else {
      if (!atNode.has(s.node)) atNode.set(s.node, []);
      atNode.get(s.node).push(s);
    }
  }
  for (const [n, list] of atNode) {
    const node = model.nodes[n];
    const { beds, spots } = slotsFor(model, node, cache);
    let b = 0;
    let k = 0;
    // bed patients who have not left lie in the room's beds
    for (const s of list) {
      if (s.kind === "patient" && BEDDED.has(s.mobility) && !s.helpers && b < beds.length && s.state !== "refuge") {
        const bed = beds[b++];
        out.set(s.id, [bed.x, bed.y, node.floor, "bed", bed.rot]);
      }
    }
    for (const s of list) {
      if (out.has(s.id)) continue;
      const base = spots[k % spots.length];
      const layer = Math.floor(k / spots.length);
      k++;
      out.set(s.id, [base[0] + layer * 0.22, base[1] + layer * 0.22, node.floor, "stand"]);
    }
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

// Is a wall side of node n on the outside of the building (nothing on the other side)?
export function isOuterSide(model, n, axis, fixed, mid) {
  const probe = axis === "x" ? [mid, fixed + (fixed <= n.y ? -0.3 : 0.3)] : [fixed + (fixed <= n.x ? -0.3 : 0.3), mid];
  for (const m of model.nodes) {
    if (m.floor !== n.floor || m.i === n.i) continue;
    const r = rectOf(m);
    if (probe[0] >= r.x0 && probe[0] <= r.x1 && probe[1] >= r.y0 && probe[1] <= r.y1) return false;
  }
  return true;
}
