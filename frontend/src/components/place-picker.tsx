"use client";

// Choose where someone is: building, then floor, then place (or not placed).

import { useState } from "react";

import type { Facility } from "@/lib/client/use-facility.ts";

export function PlacePicker({ id, facility, value, onChange, allowNone = true, error }: {
  id: string;
  facility: Facility;
  value: number | null;
  onChange: (nodeId: number | null) => void;
  allowNone?: boolean;
  error?: string;
}) {
  const current = value !== null ? facility.places.get(value) : undefined;
  const [buildingId, setBuildingId] = useState<number | null>(current?.building_id ?? facility.buildings[0]?.id ?? null);
  const [floorId, setFloorId] = useState<number | null>(
    current?.floor_id ?? (buildingId !== null ? facility.floorsOf(buildingId)[0]?.id ?? null : null));
  const floors = buildingId !== null ? facility.floorsOf(buildingId) : [];
  const places = floorId !== null ? facility.placesOf(floorId) : [];

  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mt-3 p-0 font-semibold text-tx">Where is this person?</legend>
      {facility.buildings.length === 0 ? (
        <p className="sm m-0">No buildings yet, so the person is saved as not placed.</p>
      ) : (
        <>
          <label htmlFor={`${id}-building`}>Building</label>
          <select id={`${id}-building`} value={buildingId ?? ""} onChange={(e) => {
            const next = Number(e.target.value);
            setBuildingId(next);
            setFloorId(facility.floorsOf(next)[0]?.id ?? null);
            onChange(null);
          }}>
            {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
          </select>
          {floors.length > 0 && (
            <>
              <label htmlFor={`${id}-floor`}>Floor</label>
              <select id={`${id}-floor`} value={floorId ?? ""} onChange={(e) => { setFloorId(Number(e.target.value)); onChange(null); }}>
                {floors.map((f) => <option key={f.id} value={f.id}>{f.floor_number} · {f.name}</option>)}
              </select>
            </>
          )}
          <label htmlFor={`${id}-place`}>Place</label>
          <select id={`${id}-place`} value={value ?? ""} aria-invalid={Boolean(error)}
                  onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="" disabled={!allowNone}>{allowNone ? "Not placed" : "Choose a place"}</option>
            {places.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
          </select>
          {floorId !== null && places.length === 0 && <p className="sm mt-1 mb-0">This floor has no places yet.</p>}
          {error && <p className="field-error">{error}</p>}
        </>
      )}
    </fieldset>
  );
}
