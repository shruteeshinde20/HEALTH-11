// Floor-graph rules used by the Graph Builder and Scenario Builder.
// Colours follow docs/design/preview.html.

export type PlaceType = "room" | "ward" | "icu" | "corridor" | "stair" | "ramp" | "lift" | "exit" | "assembly";

/** Stairs, ramps and lifts are the only places that may link two floors. */
export const VERTICAL_TYPES: ReadonlySet<string> = new Set(["stair", "ramp", "lift"]);

export function isVertical(type: string): boolean {
  return VERTICAL_TYPES.has(type);
}

/** Fill colour of a place (preview: blocked red, exits green, stairs/ramps yellow, wards/ICU blue). */
export function placeColour(type: string, blocked: boolean): string {
  if (blocked) return "#F9C5C5";
  if (type === "exit" || type === "assembly") return "#BFE8D0";
  if (type === "stair" || type === "ramp" || type === "lift") return "#FCE9B2";
  if (type === "icu" || type === "ward") return "#D6E9F8";
  return "#FFFFFF";
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
