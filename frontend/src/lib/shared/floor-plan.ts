// Floor-plan drawing: geometry only (pure functions, unit-tested).
//
// A floor is drawn from its places (nodes) and paths (edges) as they are
// stored; nothing here is sample data. Places with a size (width_m, length_m)
// are drawn at that size; places without one get a size from their type,
// made smaller where needed so they do not cover their neighbours.
//
// Units: positions (x, y) are in the floor's own drawing units. How many
// units make a metre is worked out from the paths: the typical ratio of a
// path's drawn length to its distance in metres. A plan entered in metres
// therefore has 1 unit per metre and is drawn exactly to scale.

export type PlanPlace = {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  is_blocked: boolean;
  is_evacuation_lift?: boolean;
  width_m?: number | null;
  length_m?: number | null;
  capacity?: number;
};

export type PlanPath = {
  id: number;
  from_node_id: number;
  to_node_id: number;
  is_blocked: boolean;
  distance?: number | null;
  width?: number | null;
};

export type Point = { x: number; y: number };
/** A rectangle by its centre and size, in drawing units. */
export type Box = { cx: number; cy: number; w: number; h: number };

/** Size by type (width, length in metres) for places that have none. */
export const DEFAULT_SIZE_M: Record<string, [number, number]> = {
  ward: [16, 10], icu: [12, 10], room: [8, 6], corridor: [10, 3], stair: [4, 4],
  ramp: [4, 4], lift: [3, 3], exit: [2, 3], assembly: [10, 10],
};
const FALLBACK_SIZE_M: [number, number] = [6, 6];
/** A path's width in metres when it has none (a door or a passage). */
export const DEFAULT_PATH_WIDTH_M = 1.8;

/** Places drawn outside the building outline. */
export const OUTDOOR_TYPES = new Set(["assembly"]);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Drawing units per metre: the median of (drawn length / distance) over the
 * paths between these places. null when no path can tell (no distances, or
 * places drawn on top of each other).
 */
export function unitsPerMetre(places: PlanPlace[], paths: PlanPath[]): number | null {
  const at = new Map(places.map((p) => [p.id, p]));
  const ratios: number[] = [];
  for (const path of paths) {
    const a = at.get(path.from_node_id);
    const b = at.get(path.to_node_id);
    const metres = path.distance ?? 0;
    if (!a || !b || !(metres > 0)) continue;
    const drawn = Math.hypot(a.x - b.x, a.y - b.y);
    if (drawn > 0) ratios.push(drawn / metres);
  }
  return median(ratios);
}

/** Distance from each place to its nearest other place (Infinity if alone). */
/**
 * Drawing units per metre for a floor: measured from its paths when they
 * can tell, else a guess that the floor is about 60 m across.
 */
export function drawingScale(places: PlanPlace[], paths: PlanPath[]): { scale: number; measured: boolean } {
  const measured = unitsPerMetre(places, paths);
  if (measured !== null) return { scale: measured, measured: true };
  const xs = places.map((p) => p.x);
  const ys = places.map((p) => p.y);
  const extent = places.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
  return { scale: extent > 0 ? extent / 60 : 1, measured: false };
}

function nearestDistances(places: PlanPlace[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const a of places) {
    let best = Infinity;
    for (const b of places) {
      if (a.id === b.id) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 0 && d < best) best = d;
    }
    out.set(a.id, best);
  }
  return out;
}

export function hasSize(place: PlanPlace): boolean {
  return typeof place.width_m === "number" && typeof place.length_m === "number"
    && place.width_m > 0 && place.length_m > 0;
}

/**
 * The rectangle of every place. `scale` = drawing units per metre (from
 * unitsPerMetre, or a guess when unknown). Places without a size are kept
 * within 80% of the distance to their nearest neighbour.
 */
export function placeBoxes(places: PlanPlace[], scale: number): Map<number, Box> {
  const nearest = nearestDistances(places);
  const boxes = new Map<number, Box>();
  for (const place of places) {
    if (hasSize(place)) {
      boxes.set(place.id, { cx: place.x, cy: place.y, w: place.width_m! * scale, h: place.length_m! * scale });
      continue;
    }
    const [wm, lm] = DEFAULT_SIZE_M[place.type] ?? FALLBACK_SIZE_M;
    let w = wm * scale;
    let h = lm * scale;
    const room = nearest.get(place.id) ?? Infinity;
    const limit = Number.isFinite(room) ? room * 0.8 : Infinity;
    const shrink = Math.min(1, limit / Math.max(w, h));
    w *= shrink;
    h *= shrink;
    boxes.set(place.id, { cx: place.x, cy: place.y, w, h });
  }
  return boxes;
}

/** Where the line from the box's centre towards `toward` crosses its edge. */
export function wallPoint(box: Box, toward: Point): Point {
  const dx = toward.x - box.cx;
  const dy = toward.y - box.cy;
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };
  const tx = dx === 0 ? Infinity : (box.w / 2) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : (box.h / 2) / Math.abs(dy);
  const t = Math.min(tx, ty, 1);
  return { x: box.cx + dx * t, y: box.cy + dy * t };
}

/** Which side of the box a wall point is on (for drawing a door in that wall). */
export function wallSide(box: Box, point: Point): "top" | "bottom" | "left" | "right" | "inside" {
  const eps = Math.max(box.w, box.h) * 1e-6 + 1e-9;
  if (Math.abs(point.y - (box.cy - box.h / 2)) <= eps) return "top";
  if (Math.abs(point.y - (box.cy + box.h / 2)) <= eps) return "bottom";
  if (Math.abs(point.x - (box.cx - box.w / 2)) <= eps) return "left";
  if (Math.abs(point.x - (box.cx + box.w / 2)) <= eps) return "right";
  return "inside";
}

export type Passage = {
  id: number;
  from: Point;          // start of the passage (on A's wall)
  to: Point;            // end of the passage (on B's wall); equal to `from` when A and B touch
  doorA: Point;
  doorB: Point;
  width: number;
  /** The way people walk: A's centre, A's door, B's door, B's centre. */
  route: Point[];
};

/** Where two ranges overlap, or null. */
function overlap(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi > lo ? [lo, hi] : null;
}

/** The two doors of a path: straight across when the rooms face each other, else on the line between centres. */
export function doorsBetween(a: Box, b: Box): [Point, Point] {
  const xs = overlap(a.cx - a.w / 2, a.cx + a.w / 2, b.cx - b.w / 2, b.cx + b.w / 2);
  const ys = overlap(a.cy - a.h / 2, a.cy + a.h / 2, b.cy - b.h / 2, b.cy + b.h / 2);
  if (xs && !ys) {
    // One above the other: a vertical passage where they overlap, nearest the smaller room's centre.
    const small = a.w <= b.w ? a : b;
    const x = Math.min(Math.max(small.cx, xs[0]), xs[1]);
    const down = b.cy > a.cy ? 1 : -1;
    return [{ x, y: a.cy + down * a.h / 2 }, { x, y: b.cy - down * b.h / 2 }];
  }
  if (ys && !xs) {
    const small = a.h <= b.h ? a : b;
    const y = Math.min(Math.max(small.cy, ys[0]), ys[1]);
    const right = b.cx > a.cx ? 1 : -1;
    return [{ x: a.cx + right * a.w / 2, y }, { x: b.cx - right * b.w / 2, y }];
  }
  return [wallPoint(a, { x: b.cx, y: b.cy }), wallPoint(b, { x: a.cx, y: a.cy })];
}

/**
 * For each path on the floor: the doors where it leaves each place, and the
 * passage between them (from === to when the two places touch or overlap).
 */
export function passages(paths: PlanPath[], boxes: Map<number, Box>, scale: number): Passage[] {
  const out: Passage[] = [];
  for (const path of paths) {
    const a = boxes.get(path.from_node_id);
    const b = boxes.get(path.to_node_id);
    if (!a || !b) continue;
    const [doorA, doorB] = doorsBetween(a, b);
    // When the boxes touch or overlap, the doors meet: no passage in between.
    const gapAhead = (doorB.x - doorA.x) * (b.cx - a.cx) + (doorB.y - doorA.y) * (b.cy - a.cy) > 0;
    const widthM = path.width && path.width > 0 ? Math.min(path.width, 4) : DEFAULT_PATH_WIDTH_M;
    out.push({
      id: path.id, doorA, doorB, width: widthM * scale,
      from: doorA, to: gapAhead ? doorB : doorA,
      route: [{ x: a.cx, y: a.cy }, doorA, doorB, { x: b.cx, y: b.cy }],
    });
  }
  return out;
}

/** The point a share (0 to 1) of the way along a polyline. */
export function alongRoute(route: Point[], share: number): Point {
  const lengths = route.slice(1).map((p, i) => Math.hypot(p.x - route[i]!.x, p.y - route[i]!.y));
  const total = lengths.reduce((sum, l) => sum + l, 0);
  if (total === 0) return route[0]!;
  let left = Math.min(Math.max(share, 0), 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]!;
    if (left <= l || i === lengths.length - 1) {
      const t = l === 0 ? 0 : Math.min(left / l, 1);
      const a = route[i]!;
      const b = route[i + 1]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= l;
  }
  return route[route.length - 1]!;
}

/** Spots for `count` people inside a box, in tidy rows (like beds in a ward), `gap` apart at most. */
export function arrange(count: number, box: Box, gap: number): Point[] {
  if (count <= 0) return [];
  const w = Math.max(box.w - gap, gap * 0.5);
  const h = Math.max(box.h - gap, gap * 0.5);
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * w) / h))));
  const rows = Math.ceil(count / cols);
  const dx = Math.min(w / cols, gap * 2.2);
  const dy = Math.min(h / rows, gap * 2.2);
  const spots: Point[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const col = i % cols;
    spots.push({
      x: box.cx + (col - (inRow - 1) / 2) * dx,
      y: box.cy + (row - (rows - 1) / 2) * dy,
    });
  }
  return spots;
}

/**
 * Where to draw each person. People at a place stand in rows inside its room
 * (in the order of their id, so the same each frame). People between two
 * places (the stream gives a point on the straight line between their
 * centres) are moved to the same share of the way along the drawn route,
 * through the doors. Anyone else is drawn where the stream says.
 */
export function personSpots(
  people: { id: string; x: number; y: number }[],
  placeAt: Map<string, Box>,
  ways: Passage[],
  gap: number,
): Map<string, Point> {
  const spots = new Map<string, Point>();
  const groups = new Map<string, string[]>();
  for (const person of people) {
    const key = pointKey(person);
    if (placeAt.has(key)) {
      const list = groups.get(key) ?? [];
      list.push(person.id);
      groups.set(key, list);
      continue;
    }
    spots.set(person.id, onTheWay(person, ways, gap) ?? { x: person.x, y: person.y });
  }
  for (const [key, ids] of groups) {
    ids.sort(compareIds);
    const places = arrange(ids.length, placeAt.get(key)!, gap);
    ids.forEach((id, i) => spots.set(id, places[i]!));
  }
  return spots;
}

/** "patient-2" before "patient-10". */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function onTheWay(person: Point, ways: Passage[], gap: number): Point | null {
  let best: { way: Passage; share: number; off: number } | null = null;
  for (const way of ways) {
    const a = way.route[0]!;
    const b = way.route[way.route.length - 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (length2 === 0) continue;
    const share = ((person.x - a.x) * dx + (person.y - a.y) * dy) / length2;
    if (share < -1e-6 || share > 1 + 1e-6) continue;
    const off = Math.hypot(person.x - (a.x + dx * share), person.y - (a.y + dy * share));
    if (off <= gap * 0.05 + 1e-3 && (!best || off < best.off)) best = { way, share, off };
  }
  return best ? alongRoute(best.way.route, best.share) : null;
}

/** Bounding box of some boxes, grown by `margin` on every side. */
export function bounds(boxes: Iterable<Box>, margin = 0): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.cx - b.w / 2);
    minY = Math.min(minY, b.cy - b.h / 2);
    maxX = Math.max(maxX, b.cx + b.w / 2);
    maxY = Math.max(maxY, b.cy + b.h / 2);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX - margin, y: minY - margin, width: maxX - minX + 2 * margin, height: maxY - minY + 2 * margin };
}

/** A round length for the scale bar, about a fifth of the drawing's width. */
export function scaleBarMetres(viewWidth: number, scale: number): number {
  const target = viewWidth / scale / 5;
  for (const metres of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
    if (metres >= target * 0.6) return metres;
  }
  return 1000;
}

export function pointKey(point: Point): string {
  return `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;
}

export type HazardKind = "fire" | "smoke" | "hazmat" | "structural";
const HAZARD_ORDER: HazardKind[] = ["fire", "hazmat", "structural", "smoke"];

/** The hazard to show at a place reached by several: fire first, smoke last. */
export function shownHazard(types: string[]): HazardKind | null {
  return HAZARD_ORDER.find((kind) => types.includes(kind)) ?? null;
}

export type Label = {
  x: number;
  y: number;              // baseline
  size: number;
  anchor: "start" | "middle" | "end";
  inside: boolean;        // drawn inside the place (at its top)
  band: number;           // height kept free for it at the top of the place
};

const LETTER = 0.58;      // rough width of a letter, in em

/** Rough width of a label, for fitting it. */
export function labelWidth(text: string, size: number): number {
  return text.length * LETTER * size;
}

/**
 * Where each place's name goes. Rooms and corridors: at the top inside, when
 * it fits (people then stand below it); otherwise just below the place.
 * Exits: outside the building, on the side the exit faces.
 */
export function placeLabels(
  places: PlanPlace[], boxes: Map<number, Box>,
  footprint: { x: number; y: number; width: number; height: number } | null,
  scale: number, minFont: number,
): Map<number, Label> {
  const labels = new Map<number, Label>();
  for (const place of places) {
    const box = boxes.get(place.id);
    if (!box) continue;
    if (place.type === "exit") {
      const size = Math.max(minFont, scale * 0.9);
      const pad = scale * 0.8;
      if (!footprint) {
        labels.set(place.id, { x: box.cx, y: box.cy + box.h / 2 + size * 1.1, size, anchor: "middle", inside: false, band: 0 });
        continue;
      }
      const sides = [
        { side: "left", d: Math.abs(box.cx - footprint.x) },
        { side: "right", d: Math.abs(footprint.x + footprint.width - box.cx) },
        { side: "top", d: Math.abs(box.cy - footprint.y) },
        { side: "bottom", d: Math.abs(footprint.y + footprint.height - box.cy) },
      ].sort((a, b) => a.d - b.d);
      const side = sides[0]!.side;
      const label: Label =
        side === "left" ? { x: footprint.x - pad, y: box.cy - box.h / 2 - pad * 0.3, size, anchor: "end", inside: false, band: 0 }
        : side === "right" ? { x: footprint.x + footprint.width + pad, y: box.cy - box.h / 2 - pad * 0.3, size, anchor: "start", inside: false, band: 0 }
        : side === "top" ? { x: box.cx, y: footprint.y - pad, size, anchor: "middle", inside: false, band: 0 }
        : { x: box.cx, y: footprint.y + footprint.height + pad + size, size, anchor: "middle", inside: false, band: 0 };
      labels.set(place.id, label);
      continue;
    }
    const size = labelSize(place.name, box, scale * 1.5, minFont);
    const fits = labelWidth(place.name, size) <= box.w * 0.95 && size * 1.5 <= box.h * 0.6;
    labels.set(place.id, fits
      ? { x: box.cx, y: box.cy - box.h / 2 + size * 1.15, size, anchor: "middle", inside: true, band: size * 1.5 }
      : { x: box.cx, y: box.cy + box.h / 2 + size * 1.05, size, anchor: "middle", inside: false, band: 0 });
  }
  return labels;
}

/** The part of a place where people stand: below its name. */
export function standingArea(box: Box, label: Label | undefined): Box {
  if (!label || !label.inside || label.band <= 0) return box;
  return { cx: box.cx, cy: box.cy + label.band / 2, w: box.w, h: Math.max(box.h - label.band, box.h * 0.3) };
}

/** The area a label covers (for fitting the drawing around exit names). */
export function labelBox(text: string, label: Label): { x: number; y: number; w: number; h: number } {
  const w = labelWidth(text, label.size);
  const x = label.anchor === "start" ? label.x : label.anchor === "end" ? label.x - w : label.x - w / 2;
  return { x, y: label.y - label.size, w, h: label.size * 1.3 };
}

/** Font size that fits a label in a box (by a rough width of 0.58 em per letter). */
export function labelSize(text: string, box: Box, max: number, min: number): number {
  const byWidth = (box.w * 0.9) / Math.max(text.length * LETTER, 1);
  const byHeight = box.h * 0.32;
  return Math.max(min, Math.min(max, byWidth, byHeight));
}

// --- Graph Builder canvas (React Flow works in screen pixels) -------------------------------

/** Pixels per metre on the Graph Builder canvas at zoom 1. */
export const PX_PER_METRE = 12;

/** A place's rectangle on the canvas: top-left corner and size in pixels. */
export function canvasRect(box: Box, pxPerUnit: number): { x: number; y: number; width: number; height: number } {
  return {
    x: (box.cx - box.w / 2) * pxPerUnit,
    y: (box.cy - box.h / 2) * pxPerUnit,
    width: box.w * pxPerUnit,
    height: box.h * pxPerUnit,
  };
}

/** Back from the canvas: a place's centre (x, y) in drawing units, from where it was dropped. */
export function centreFromCanvas(topLeft: Point, size: { width: number; height: number }, pxPerUnit: number): Point {
  return { x: (topLeft.x + size.width / 2) / pxPerUnit, y: (topLeft.y + size.height / 2) / pxPerUnit };
}
