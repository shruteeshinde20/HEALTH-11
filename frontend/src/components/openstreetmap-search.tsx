"use client";

// "Find on OpenStreetMap": hospitals near this hospital's map position
// (backend/app/outside_data_api.py). Choosing one saves its address and
// position to this hospital (and its name, if asked) with the normal update.
// OpenStreetMap data is credited as its licence requires.

import { useState } from "react";

import { DataTable } from "@/components/ui.tsx";
import { FormError } from "@/components/facility-forms.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { useAction } from "@/lib/client/use-action.ts";
import type { Hospital, OsmSearchResult } from "@/lib/shared/api-types.ts";
import { formatDateTime } from "@/lib/shared/format.ts";
import { formatDistance, osmChanges } from "@/lib/shared/outside-data.ts";

const RADII = [500, 1000, 1500, 3000, 5000];

export function OpenStreetMapSearch({ hospital, onSaved, onCancel }: {
  hospital: Hospital;
  onSaved: (saved: Hospital) => void;
  onCancel: () => void;
}) {
  const [radius, setRadius] = useState(1500);
  const [useName, setUseName] = useState(false);
  const [result, setResult] = useState<OsmSearchResult | null>(null);
  const search = useAction();
  const save = useAction();

  async function find() {
    const found = await search.run(() => apiRequest<OsmSearchResult>(
      `/hospitals/${hospital.id}/openstreetmap`, { query: { radius_m: radius } }));
    if (found) setResult(found);
  }

  async function use(index: number) {
    const place = result?.places[index];
    if (!place) return;
    const saved = await save.run(() => apiRequest<Hospital>(`/hospitals/${hospital.id}`, {
      method: "PATCH", body: osmChanges(hospital, place, useName),
    }));
    if (saved) onSaved(saved);
  }

  return (
    <div>
      <p className="sm mt-0">
        Hospitals that OpenStreetMap lists near this hospital&apos;s map position. Choosing one saves its address
        and position here. Check it is the right place: OpenStreetMap is written by volunteers.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="osm-radius">Search within</label>
          <select id="osm-radius" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {RADII.map((r) => <option key={r} value={r}>{formatDistance(r)}</option>)}
          </select>
        </div>
        <p className="my-0">
          <button type="button" className="btn" disabled={search.busy} onClick={find}>
            {search.busy ? "Searching…" : "Search OpenStreetMap"}
          </button>
        </p>
      </div>
      <FormError error={search.error} />

      {result && (
        <>
          {result.places.length === 0 ? (
            <p role="status">No hospital found within {formatDistance(result.radius_m)}. Try a larger distance.</p>
          ) : (
            <>
              <p className="my-2">
                <label className="inline-flex items-center gap-2 font-semibold">
                  <input type="checkbox" checked={useName} onChange={(e) => setUseName(e.target.checked)} />
                  Also use the OpenStreetMap name
                </label>
              </p>
              <DataTable
                caption="Hospitals found on OpenStreetMap"
                columns={["Name", "Address", "Distance", ""]}
                rows={result.places.map((place, index) => ({
                  key: `${place.osm_type}-${place.osm_id}`,
                  cells: [
                    <a key="name" href={place.url} target="_blank" rel="noopener noreferrer">
                      {place.name ?? "(no name)"}
                    </a>,
                    place.address ?? "–",
                    formatDistance(place.distance_m),
                    <button key="use" type="button" className="btn l" disabled={save.busy}
                            onClick={() => use(index)}>Use this</button>,
                  ],
                }))}
              />
            </>
          )}
          <FormError error={save.error} />
          <p className="sm">
            Data <a href={result.attribution_url} target="_blank" rel="noopener noreferrer">{result.attribution}</a>,
            searched {formatDateTime(result.searched_at)}.
          </p>
        </>
      )}
      <p><button type="button" className="btn l" onClick={onCancel}>Close</button></p>
    </div>
  );
}
