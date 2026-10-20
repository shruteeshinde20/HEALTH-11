import { test } from "node:test";
import assert from "node:assert/strict";
import type { WeatherNow } from "../../src/lib/shared/api-types.ts";
import { weatherSummary } from "../../src/lib/shared/outside-data.ts";

const base: WeatherNow = {
  source: "Open-Meteo", attribution: "Weather data by Open-Meteo.com (CC BY 4.0)", attribution_url: "https://open-meteo.com/",
  note: "Information only: the simulation does not use the weather.", fetched_at: "2026-10-21T08:46:00+00:00",
  valid_at: "2026-10-21T14:15", utc_offset_seconds: 19800, interval_seconds: 900,
  temperature_c: 28.4, humidity_percent: 61, wind_speed_kmh: 12.6, wind_gusts_kmh: 22.3,
  wind_direction_deg: 315, wind_from: "NW", smoke_drifts_toward: "SE",
};

test("the weather in one readable line", () => {
  assert.equal(weatherSummary(base),
    "Wind from NW at 13 km/h (gusts 22 km/h); smoke drifts toward SE. 28 °C, humidity 61 %. "
    + "Measured 14:15 local time (15-minute average).");
});

test("missing values are left out, never invented", () => {
  assert.equal(weatherSummary({ ...base, wind_gusts_kmh: null, humidity_percent: null, interval_seconds: null }),
    "Wind from NW at 13 km/h; smoke drifts toward SE. 28 °C. Measured 14:15 local time.");
  assert.equal(weatherSummary({ ...base, wind_speed_kmh: null, temperature_c: null, humidity_percent: null, valid_at: "" }),
    "No current weather values were given.");
});
