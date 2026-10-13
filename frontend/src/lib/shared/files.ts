// Floor files: the backend picks the parser from the Content-Type. Browsers
// label files inconsistently (Windows often reports .csv as an Excel type and
// .geojson as unknown), so the type is chosen from the file extension.

export const FLOOR_IMPORT_TYPES: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  geojson: "application/geo+json",
};

export const FLOOR_IMPORT_ACCEPT = ".csv,.json,.geojson";

/** Largest floor file the backend accepts (backend/app/floor_io.py). */
export const MAX_FLOOR_FILE_BYTES = 5 * 1024 * 1024;

export function floorImportType(fileName: string): string | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return FLOOR_IMPORT_TYPES[extension] ?? null;
}

/** Columns of the CSV format, as written by the floor export. */
export const FLOOR_CSV_COLUMNS = [
  "record_type", "name", "type", "x", "y", "capacity", "is_blocked", "is_evacuation_lift",
  "from_node", "to_node", "distance", "width", "max_flow", "wheelchair_accessible", "stretcher_accessible",
];

export const NODE_TYPES = ["room", "ward", "icu", "corridor", "stair", "ramp", "lift", "exit", "assembly"];
