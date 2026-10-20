// A hospital's map position as typed in the hospital form: decimal degrees
// (WGS 84), both or neither. Limits mirror backend/app/facility_api.py, which
// checks again. Pure, unit-tested.

export const LATITUDE_RANGE = { min: -90, max: 90 } as const;
export const LONGITUDE_RANGE = { min: -180, max: 180 } as const;

export type LocationInput =
  | { ok: true; latitude: number | null; longitude: number | null }
  | { ok: false; field: "latitude" | "longitude"; message: string };

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function parse(text: string, label: string, range: { min: number; max: number }): number | string {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return `${label} must be a number in decimal degrees, for example with a point, not a comma`;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    return `${label} must be between ${range.min} and ${range.max}`;
  }
  return value;
}

/**
 * Reads the two boxes. Map apps copy a position as "latitude, longitude", so
 * a pair pasted into the latitude box (longitude box empty) is split.
 * Both empty means "no position".
 */
export function readLocation(latitudeText: string, longitudeText: string): LocationInput {
  let lat = latitudeText.trim();
  let lon = longitudeText.trim();
  if (!lon && lat.includes(",")) {
    const [first, second, ...rest] = lat.split(",");
    if (first !== undefined && second !== undefined && rest.length === 0) {
      [lat, lon] = [first.trim(), second.trim()];
    }
  }
  if (!lat && !lon) return { ok: true, latitude: null, longitude: null };
  if (!lat) return { ok: false, field: "latitude", message: "Give the latitude too, or leave both empty" };
  if (!lon) return { ok: false, field: "longitude", message: "Give the longitude too, or leave both empty" };
  const latitude = parse(lat, "Latitude", LATITUDE_RANGE);
  if (typeof latitude === "string") return { ok: false, field: "latitude", message: latitude };
  const longitude = parse(lon, "Longitude", LONGITUDE_RANGE);
  if (typeof longitude === "string") return { ok: false, field: "longitude", message: longitude };
  return { ok: true, latitude, longitude };
}

/** "18.52040° N, 73.85670° E", or "" without a position. */
export function formatLocation(latitude: number | null | undefined, longitude: number | null | undefined): string {
  if (latitude == null || longitude == null) return "";
  const ns = latitude >= 0 ? "N" : "S";
  const ew = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(5)}° ${ns}, ${Math.abs(longitude).toFixed(5)}° ${ew}`;
}
