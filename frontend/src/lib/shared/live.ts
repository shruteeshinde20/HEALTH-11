// Live Simulation rules: reading stream messages (backend/app/simulation_ws.py)
// and drawing a floor of the run's building. Pure functions, unit-tested.

/** Simulated seconds per real second the page offers (backend allows 0 < speed <= 10,000). */
export const STREAM_SPEEDS = [1, 5, 10, 30, 60] as const;

export type Mobility = "ambulatory" | "wheelchair" | "stretcher" | "ventilator";
export type PersonStatus = "active" | "evacuated" | "needs_assistance" | "reached_by_hazard";

export type Position = { id: string; x: number; y: number; floor_id: number; mobility: string; status: string };

export type LiveFrame = {
  t: number;
  total: number;
  evacuated: number;
  active: number;
  needs_assistance: number;
  reached_by_hazard: number;
  blocked_nodes: number[];
  congested_edges: number[];
  exit_load: Record<string, number>;
  done: boolean;
  positions: Position[];
};

export type MapNode = { id: number; name: string; type: string; x: number; y: number; floor_id: number; is_blocked: boolean };
export type MapEdge = { id: number; from_node_id: number; to_node_id: number; is_blocked: boolean };
export type RunMap = { building_id: number | null; nodes: MapNode[]; edges: MapEdge[] };

export type StreamMessage =
  | { kind: "frame"; frame: LiveFrame }
  | { kind: "status"; paused: boolean; t: number }
  | { kind: "error"; message: string }
  | { kind: "unknown" };

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Read one message from the stream; anything unexpected is "unknown", never trusted. */
export function parseStreamMessage(raw: string): StreamMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof data !== "object" || data === null) return { kind: "unknown" };
  const body = data as Record<string, unknown>;
  if (typeof body.error === "object" && body.error !== null) {
    const message = (body.error as Record<string, unknown>).message;
    return { kind: "error", message: typeof message === "string" ? message : "The live stream reported an error." };
  }
  if ((body.status === "paused" || body.status === "running") && isNumber(body.t)) {
    return { kind: "status", paused: body.status === "paused", t: body.t };
  }
  const counts = ["t", "total", "evacuated", "active", "needs_assistance", "reached_by_hazard"] as const;
  if (counts.every((key) => isNumber(body[key])) && typeof body.done === "boolean") {
    const positions = Array.isArray(body.positions)
      ? (body.positions as unknown[]).filter((p): p is Position => {
          if (typeof p !== "object" || p === null) return false;
          const q = p as Record<string, unknown>;
          return isNumber(q.x) && isNumber(q.y) && isNumber(q.floor_id) && q.id !== undefined;
        }).map((p) => ({ ...p, id: String(p.id) }))
      : [];
    const numbers = (value: unknown) => (Array.isArray(value) ? value.filter(isNumber) : []);
    const load: Record<string, number> = {};
    if (typeof body.exit_load === "object" && body.exit_load !== null) {
      for (const [key, value] of Object.entries(body.exit_load as Record<string, unknown>)) {
        if (isNumber(value)) load[key] = value;
      }
    }
    return {
      kind: "frame",
      frame: {
        t: body.t as number, total: body.total as number, evacuated: body.evacuated as number,
        active: body.active as number, needs_assistance: body.needs_assistance as number,
        reached_by_hazard: body.reached_by_hazard as number, done: body.done,
        blocked_nodes: numbers(body.blocked_nodes), congested_edges: numbers(body.congested_edges),
        exit_load: load, positions,
      },
    };
  }
  return { kind: "unknown" };
}

/** Why the stream closed, in words (codes from backend/app/simulation_ws.py). */
export function closeReason(code: number, finished: boolean): string | null {
  if (code === 1000 || finished) return null;
  if (code === 4401) return "The live stream could not confirm your sign-in. Press Start to try again.";
  if (code === 4404) return "This simulation run no longer exists.";
  return "The connection to the live stream was lost. Press Start to watch again.";
}

/** Floors of the run's building that have places, in a stable order. */
export function mapFloors(map: RunMap): number[] {
  return [...new Set(map.nodes.map((n) => n.floor_id))].sort((a, b) => a - b);
}

/** SVG viewBox around a floor's places, with a margin; units are the floor plan's own. */
export function floorView(nodes: { x: number; y: number }[]): { x: number; y: number; width: number; height: number; unit: number } {
  if (nodes.length === 0) return { x: -50, y: -50, width: 100, height: 100, unit: 2 };
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const unit = extent / 50;                // base size for circles, lines and text
  const margin = unit * 4;
  return { x: minX - margin, y: minY - margin, width: maxX - minX + 2 * margin, height: maxY - minY + 2 * margin, unit };
}

/** A small fixed offset per person, so people waiting at the same place stay visible. */
export function spread(id: string, unit: number): { dx: number; dy: number } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  const radius = unit * (0.6 + (((hash >>> 9) % 100) / 100) * 0.9);
  return { dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius };
}

export const MOBILITY_COLOURS: Record<string, string> = {
  ambulatory: "#2563EB",   // blue
  wheelchair: "#7C3AED",   // purple
  stretcher: "#C2410C",    // orange
  ventilator: "#BE185D",   // pink
};

export const MOBILITY_LABELS: Record<string, string> = {
  ambulatory: "Walking", wheelchair: "Wheelchair", stretcher: "Stretcher", ventilator: "Ventilator",
};

/** "1:05" for 65 seconds of simulated time. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** People per exit by exit name, largest first. */
export function exitLoadRows(load: Record<string, number>, names: Map<number, string>): { name: string; people: number }[] {
  return Object.entries(load)
    .map(([id, people]) => ({ name: names.get(Number(id)) ?? `Exit ${id}`, people }))
    .sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
}
