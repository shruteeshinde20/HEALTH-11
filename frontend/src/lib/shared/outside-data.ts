// Helpers for outside data shown with a hospital (current weather).
// Pure, unit-tested.

import type { WeatherNow } from "./api-types.ts";

function round(value: number): string {
  return String(Math.round(value));
}

/** "Wind from NW at 13 km/h (gusts 22 km/h); smoke drifts toward SE. 28 °C, humidity 61 %.
 *  Measured 14:15 local time (15-minute average)." Missing values are left out. */
export function weatherSummary(w: WeatherNow): string {
  const parts: string[] = [];
  if (w.wind_speed_kmh !== null) {
    let wind = w.wind_from ? `Wind from ${w.wind_from} at ${round(w.wind_speed_kmh)} km/h`
                           : `Wind ${round(w.wind_speed_kmh)} km/h`;
    if (w.wind_gusts_kmh !== null) wind += ` (gusts ${round(w.wind_gusts_kmh)} km/h)`;
    if (w.smoke_drifts_toward) wind += `; smoke drifts toward ${w.smoke_drifts_toward}`;
    parts.push(`${wind}.`);
  }
  const air = [
    w.temperature_c !== null ? `${round(w.temperature_c)} °C` : null,
    w.humidity_percent !== null ? `humidity ${round(w.humidity_percent)} %` : null,
  ].filter(Boolean);
  if (air.length) parts.push(`${air.join(", ")}.`);
  const time = /T(\d{2}:\d{2})/.exec(w.valid_at)?.[1];
  if (time) {
    const minutes = w.interval_seconds ? Math.round(w.interval_seconds / 60) : null;
    parts.push(`Measured ${time} local time${minutes ? ` (${minutes}-minute average)` : ""}.`);
  }
  return parts.length ? parts.join(" ") : "No current weather values were given.";
}
