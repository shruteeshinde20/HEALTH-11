// Patients & Staff rules (backend/app/people_api.py). Limits mirror the
// backend, which validates again.

import type { PeopleImportResult } from "./api-types.ts";
import type { Mobility } from "./live.ts";

export const MOBILITIES: readonly Mobility[] = ["ambulatory", "wheelchair", "stretcher", "ventilator"];

export const MOBILITY_HELP: Record<Mobility, string> = {
  ambulatory: "Walking (can use stairs)",
  wheelchair: "Wheelchair (no stairs; needs wheelchair-accessible paths)",
  stretcher: "Stretcher (no stairs; needs stretcher-accessible paths)",
  ventilator: "Ventilator (moved on a bed; same paths as a stretcher)",
};

export const CRITICALITY_LABELS: Record<number, string> = {
  1: "stable", 2: "low", 3: "moderate", 4: "high", 5: "critical",
};

/** Adding several at once: up to this many per request batch. */
export const MAX_BATCH = 50;
export const MAX_CODE = 100;

/**
 * Codes for adding `count` people at once: "N" -> N-1 … N-count, or just "N"
 * for one. Null when the count is not 1-50 or a code would be too long.
 */
export function batchCodes(code: string, count: number): string[] | null {
  const base = code.trim();
  if (!base || !Number.isInteger(count) || count < 1 || count > MAX_BATCH) return null;
  const codes = count === 1 ? [base] : Array.from({ length: count }, (_, i) => `${base}-${i + 1}`);
  return codes.every((c) => c.length <= MAX_CODE) ? codes : null;
}

/** "WardA · Ground · Test Hospital / Main Block", or "Not placed". */
export function placeLabel(
  nodeId: number | null,
  places: Map<number, { name: string; floor_id: number; building_id: number }>,
  floorName: (id: number) => string,
  buildingLabel: (id: number) => string,
): string {
  if (nodeId === null) return "Not placed";
  const place = places.get(nodeId);
  if (!place) return "A place that no longer exists";
  return `${place.name} · ${floorName(place.floor_id)} · ${buildingLabel(place.building_id)}`;
}

/** "12 placed, 3 not placed" style counts for the lists. */
export function placementCounts(items: { node_id: number | null }[]): { placed: number; unplaced: number } {
  const placed = items.filter((item) => item.node_id !== null).length;
  return { placed, unplaced: items.length - placed };
}

// --- CSV files (backend/app/people_io.py) ------------------------------------------------

export type PeopleKind = "patients" | "staff";

const LOCATION_COLUMNS = ["hospital", "building", "floor_number", "place"];

/** Columns of the patients and staff CSV files, as written by Export. */
export const PEOPLE_CSV_COLUMNS: Record<PeopleKind, readonly string[]> = {
  patients: ["patient_code", "mobility", "criticality", "test_data", ...LOCATION_COLUMNS],
  staff: ["staff_code", "full_name", "role", "test_data", ...LOCATION_COLUMNS],
};

/** Largest people file the backend accepts. */
export const MAX_PEOPLE_FILE_BYTES = 1024 * 1024;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 to add, 1 to change, 1 to remove, 30 unchanged" (checked) or "Added 2, …" (saved). */
export function importSummary(result: PeopleImportResult): string {
  if (result.applied) {
    return `Saved: ${result.added} added, ${result.updated} changed, ${result.removed} removed, `
      + `${result.unchanged} unchanged.`;
  }
  return `The file lists ${plural(result.rows, "person", "people")}: ${result.added} to add, `
    + `${result.updated} to change, ${result.removed} to remove, ${result.unchanged} unchanged.`;
}

export const importChangesSomething = (result: PeopleImportResult) =>
  result.added + result.updated + result.removed > 0;
