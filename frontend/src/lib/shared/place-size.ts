// A place's size in metres (width left to right, length top to bottom), used
// to draw the floor plan. Optional: both boxes empty means "no size".
// Limits mirror backend/app/api_common.py (PlaceSize: above 0, at most 1,000 m).

export const MAX_PLACE_SIZE_M = 1000;

export type SizeInput =
  | { ok: true; width_m: number | null; length_m: number | null }
  | { ok: false; field: "width" | "length"; message: string };

function parse(text: string, label: string): number | string {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PLACE_SIZE_M) {
    return `${label} must be a number above 0 and at most ${MAX_PLACE_SIZE_M.toLocaleString("en-US")} metres`;
  }
  return value;
}

export function readSize(widthText: string, lengthText: string): SizeInput {
  const width = widthText.trim();
  const length = lengthText.trim();
  if (!width && !length) return { ok: true, width_m: null, length_m: null };
  if (!width) return { ok: false, field: "width", message: "Give the width too, or leave both empty" };
  if (!length) return { ok: false, field: "length", message: "Give the length too, or leave both empty" };
  const w = parse(width, "Width");
  if (typeof w === "string") return { ok: false, field: "width", message: w };
  const l = parse(length, "Length");
  if (typeof l === "string") return { ok: false, field: "length", message: l };
  return { ok: true, width_m: w, length_m: l };
}

/** "20 × 12 m", or null when the place has no size. */
export function formatSize(place: { width_m: number | null; length_m: number | null }): string | null {
  if (place.width_m === null || place.length_m === null) return null;
  const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${n(place.width_m)} × ${n(place.length_m)} m`;
}
