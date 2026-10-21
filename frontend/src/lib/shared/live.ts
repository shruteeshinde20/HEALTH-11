// Live Simulation rules: reading stream messages (backend/app/simulation_ws.py)
// and drawing a floor of the run's building. Pure functions, unit-tested.

/** Simulated seconds per real second the page offers (backend allows 0 < speed <= 10,000). */
export const STREAM_SPEEDS = [1, 5, 10, 30, 60] as const;

export type Mobility = "ambulatory" | "wheelchair" | "stretcher" | "ventilator";
export type PersonStatus = "active" | "evacuated" | "needs_assistance" | "reached_by_hazard";

export type Position = { id: string; x: number; y: number; floor_id: number; mobility: string; status: string };

/** A place a hazard has reached (types) or is about to reach (risk above 0). */
export type HazardSpot = { node_id: number; types: string[]; reached: boolean; risk: number };

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
  hazards: HazardSpot[];
};

export type MapNode = {
  id: number; name: string; type: string; x: number; y: number; floor_id: number; is_blocked: boolean;
  is_evacuation_lift?: boolean; width_m?: number | null; length_m?: number | null;
};
export type MapEdge = {
  id: number; from_node_id: number; to_node_id: number; is_blocked: boolean;
  distance?: number | null; width?: number | null;
};
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
    const hazards: HazardSpot[] = Array.isArray(body.hazards)
      ? (body.hazards as unknown[]).flatMap((h) => {
          if (typeof h !== "object" || h === null) return [];
          const q = h as Record<string, unknown>;
          if (!isNumber(q.node_id) || !isNumber(q.risk)) return [];
          const types = Array.isArray(q.types) ? q.types.filter((t): t is string => typeof t === "string") : [];
          return [{ node_id: q.node_id, types, reached: q.reached === true, risk: Math.min(Math.max(q.risk, 0), 1) }];
        })
      : [];
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
        exit_load: load, positions, hazards,
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
