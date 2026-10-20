// Helpers for outside data shown with a hospital (OpenStreetMap results).
// Pure, unit-tested.

import type { Hospital, OsmPlace } from "./api-types.ts";

/** "850 m" below 1 km, otherwise "1.5 km". */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return "–";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1).replace(/\.0$/, "")} km`;
}

/** What "Use this" changes on the hospital: its position, its address when
 *  OpenStreetMap has one (otherwise the current address stays), and its name
 *  only when asked and when OpenStreetMap has one. */
export function osmChanges(hospital: Pick<Hospital, "address">, place: OsmPlace, useName: boolean) {
  return {
    address: place.address ?? hospital.address,
    latitude: place.latitude,
    longitude: place.longitude,
    ...(useName && place.name ? { name: place.name } : {}),
  };
}
