// Floor-graph rules used by the Graph Builder and Scenario Builder.
// (Colours of the floor plan are in components/floor-plan.tsx.)

export type PlaceType = "room" | "ward" | "icu" | "corridor" | "stair" | "ramp" | "lift" | "exit" | "assembly";

/** Stairs, ramps and lifts are the only places that may link two floors. */
export const VERTICAL_TYPES: ReadonlySet<string> = new Set(["stair", "ramp", "lift"]);

export function isVertical(type: string): boolean {
  return VERTICAL_TYPES.has(type);
}

/** Where a newly added place appears: to the right of the existing ones
 *  (the user then drags it into position). */
export function newPlacePosition(existing: { x: number; y: number }[], gap = 80): { x: number; y: number } {
  if (existing.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...existing.map((p) => p.x));
  const minY = Math.min(...existing.map((p) => p.y));
  return { x: maxX + gap, y: minY };
}

/** Positions are stored to 0.1 units. */
export function roundPosition(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "fire" -> "Fire at C1": the hazard name the scenario forms suggest. */
export function hazardName(type: string, placeName: string): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} at ${placeName}`;
}

/** Parse a number field: "" -> null, otherwise a finite number within the range or NaN. */
export function parseNumber(value: string, min: number, max: number, integer = false): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    return Number.NaN;
  }
  return number;
}

/**
 * Capacity suggested from a path's width (people per minute), from the SFPE
 * hydraulic model (NIST TN 1722): about 1.32 people per second per metre of
 * usable width on level floors, with 0.15 m lost at each side. The same rule
 * the simulator's crowd model uses; the user can still type another value.
 */
export function suggestedMaxFlow(widthMetres: number | null, boundaryLayerMetres = 0.15): number | null {
  if (widthMetres === null || !Number.isFinite(widthMetres) || widthMetres <= 0) return null;
  const usable = Math.max(widthMetres - 2 * boundaryLayerMetres, 0.3);
  return Math.max(1, Math.floor((1.4 / (4 * 0.266)) * usable * 60));
}
