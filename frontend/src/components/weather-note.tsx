"use client";

// Current weather at the hospital, next to a scenario's hazards (smoke drifts
// with the wind). From Open-Meteo via backend/app/outside_data_api.py.
// Information only: the simulation does not use it, and the note says so.

import { useApi } from "@/lib/client/use-api.ts";
import type { WeatherNow } from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import { weatherSummary } from "@/lib/shared/outside-data.ts";

export function WeatherNote({ hospitalId }: { hospitalId: number | null | undefined }) {
  const weather = useApi<WeatherNow>(hospitalId ? `/hospitals/${hospitalId}/weather` : null);
  if (!hospitalId) return null;
  return (
    <section className="mt-3 rounded-lg border border-line p-3" aria-label="Weather at the hospital now">
      <h3 className="m-0 text-[14px] font-bold text-ink">Weather at the hospital now</h3>
      {weather.loading && <p className="sm my-1">Loading the weather…</p>}
      {weather.error !== null && <p className="sm my-1">{describeError(weather.error)}</p>}
      {weather.data && (
        <>
          <p className="my-1">{weatherSummary(weather.data)}</p>
          <p className="sm my-0">
            {weather.data.note}{" "}
            <a href={weather.data.attribution_url} target="_blank" rel="noopener noreferrer">
              {weather.data.attribution}
            </a>
          </p>
        </>
      )}
    </section>
  );
}
