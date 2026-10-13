"use client";

// Forms for hospitals, buildings and floors, floor file import/export, and
// delete confirmation. Used by the Facility Manager and the onboarding wizard.
// Limits mirror backend/app/facility_api.py; the backend validates again.

import { useState, type FormEvent, type ReactNode } from "react";

import { apiRequest, apiUpload } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useAction } from "@/lib/client/use-action.ts";
import type { Building, Floor, FloorImportResult, Hospital } from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import {
  FLOOR_CSV_COLUMNS, FLOOR_IMPORT_ACCEPT, MAX_FLOOR_FILE_BYTES, floorImportType,
} from "@/lib/shared/files.ts";

function FormError({ error }: { error: unknown }) {
  if (error === null || Object.keys(fieldErrors(error)).length) return null;
  return <p role="alert" className="field-error">{describeError(error)}</p>;
}

function Field({ id, label, error, hint, children }: {
  id: string; label: string; error?: string; hint?: string; children: ReactNode;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="sm mt-1 mb-0">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </>
  );
}

function Buttons({ busy, disabled = false, label, onCancel }: {
  busy: boolean; disabled?: boolean; label: string; onCancel?: () => void;
}) {
  return (
    <p className="flex flex-wrap gap-2">
      <button type="submit" className="btn" disabled={busy || disabled}>{busy ? "Saving…" : label}</button>
      {onCancel && <button type="button" className="btn l" onClick={onCancel}>Cancel</button>}
    </p>
  );
}

/** "" -> null, so optional text can be cleared. */
const optional = (value: string) => (value.trim() ? value.trim() : null);

// --- Time zones -------------------------------------------------------------------------

function timeZones(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return Array.from(new Set(["UTC", ...zones]));
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// --- Hospital ----------------------------------------------------------------------------

export function HospitalForm({ hospital, onSaved, onCancel, submitLabel }: {
  hospital?: Hospital;
  onSaved: (saved: Hospital) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState(hospital?.name ?? "");
  const [address, setAddress] = useState(hospital?.address ?? "");
  const [timezone, setTimezone] = useState(hospital?.timezone ?? browserTimeZone());
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = { name: name.trim(), address: optional(address), timezone };
    const saved = await run(() => hospital
      ? apiRequest<Hospital>(`/hospitals/${hospital.id}`, { method: "PATCH", body })
      : apiRequest<Hospital>("/hospitals", { method: "POST", body }));
    if (saved) onSaved(saved);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="hospital-name" label="Hospital name" error={fields.name}>
        <input id="hospital-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)}
               aria-invalid={Boolean(fields.name)} />
      </Field>
      <Field id="hospital-address" label="Address (optional)" error={fields.address}>
        <input id="hospital-address" maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)}
               autoComplete="street-address" aria-invalid={Boolean(fields.address)} />
      </Field>
      <Field id="hospital-timezone" label="Time zone" error={fields.timezone}
             hint="Used for times shown for this hospital.">
        <select id="hospital-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}
                aria-describedby="hospital-timezone-hint" aria-invalid={Boolean(fields.timezone)}>
          {timeZones().map((zone) => <option key={zone} value={zone}>{zone}</option>)}
        </select>
      </Field>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!name.trim()} label={submitLabel ?? (hospital ? "Save" : "Add hospital")} onCancel={onCancel} />
    </form>
  );
}

// --- Building ----------------------------------------------------------------------------

export function BuildingForm({ hospitalId, building, onSaved, onCancel, submitLabel }: {
  hospitalId: number;
  building?: Building;
  onSaved: (saved: Building) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState(building?.name ?? "");
  const [description, setDescription] = useState(building?.description ?? "");
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await run(() => building
      ? apiRequest<Building>(`/buildings/${building.id}`, {
          method: "PATCH", body: { name: name.trim(), description: optional(description) } })
      : apiRequest<Building>("/buildings", {
          method: "POST", body: { hospital_id: hospitalId, name: name.trim(), description: optional(description) } }));
    if (saved) onSaved(saved);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="building-name" label="Building name" error={fields.name}>
        <input id="building-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)}
               aria-invalid={Boolean(fields.name)} />
      </Field>
      <Field id="building-description" label="Description (optional)" error={fields.description}>
        <input id="building-description" maxLength={500} value={description}
               onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!name.trim()} label={submitLabel ?? (building ? "Save" : "Add building")} onCancel={onCancel} />
    </form>
  );
}

// --- Floor -------------------------------------------------------------------------------

export function FloorForm({ buildingId, floor, onSaved, onCancel, submitLabel }: {
  buildingId: number;
  floor?: Floor;
  onSaved: (saved: Floor) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState(floor?.name ?? "");
  const [number, setNumber] = useState(floor ? String(floor.floor_number) : "");
  const [elevation, setElevation] = useState(floor?.elevation_metres === null || floor === undefined
    ? "" : String(floor.elevation_metres));
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  const floorNumber = Number(number);
  const numberValid = number.trim() !== "" && Number.isInteger(floorNumber) && floorNumber >= -20 && floorNumber <= 300;
  const elevationValue = elevation.trim() === "" ? null : Number(elevation);
  const elevationValid = elevationValue === null || Number.isFinite(elevationValue);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!numberValid || !elevationValid) return;
    const body = { name: name.trim(), floor_number: floorNumber, elevation_metres: elevationValue };
    const saved = await run(() => floor
      ? apiRequest<Floor>(`/floors/${floor.id}`, { method: "PATCH", body })
      : apiRequest<Floor>("/floors", { method: "POST", body: { building_id: buildingId, ...body } }));
    if (saved) onSaved(saved);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="floor-name" label="Floor name" error={fields.name}>
        <input id="floor-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)}
               aria-invalid={Boolean(fields.name)} />
      </Field>
      <Field id="floor-number" label="Floor number" hint="0 for the ground floor, negative below ground (−20 to 300)."
             error={fields.floor_number ?? (number && !numberValid ? "Enter a whole number from −20 to 300." : undefined)}>
        <input id="floor-number" type="number" step={1} min={-20} max={300} required value={number}
               onChange={(e) => setNumber(e.target.value)} aria-describedby="floor-number-hint"
               aria-invalid={Boolean(fields.floor_number) || (Boolean(number) && !numberValid)} />
      </Field>
      <Field id="floor-elevation" label="Height above ground in metres (optional)"
             error={fields.elevation_metres ?? (!elevationValid ? "Enter a number." : undefined)}>
        <input id="floor-elevation" type="number" step="any" value={elevation}
               onChange={(e) => setElevation(e.target.value)} aria-invalid={!elevationValid} />
      </Field>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!name.trim() || !numberValid || !elevationValid}
               label={submitLabel ?? (floor ? "Save" : "Add floor")} onCancel={onCancel} />
    </form>
  );
}

// --- Floor files -------------------------------------------------------------------------

export function FloorImport({ floorId, onImported }: {
  floorId: number;
  onImported: (result: FloorImportResult) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<FloorImportResult | null>(null);
  const { busy, error, run } = useAction();

  const type = file ? floorImportType(file.name) : null;
  const problem = !file ? null
    : !type ? "Choose a .csv, .json or .geojson file."
      : file.size > MAX_FLOOR_FILE_BYTES ? "The file is larger than 5 MB."
        : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !type || problem) return;
    const imported = await run(() => apiUpload<FloorImportResult>(`/floors/${floorId}/import`, file, type));
    if (imported) {
      setResult(imported);
      onImported(imported);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="sm">
        Adds places (nodes) and paths (edges) to this floor; nothing already on the floor is changed. The whole
        file is checked first: if anything is wrong, nothing is saved. Formats: CSV, JSON or GeoJSON, as written by
        Export (up to 5,000 places, 20,000 paths, 5 MB).
      </p>
      <details className="sm">
        <summary>CSV columns</summary>
        <p className="break-words font-mono text-xs">{FLOOR_CSV_COLUMNS.join(",")}</p>
        <p>
          One row per place (record_type <code>node</code>) or path (record_type <code>edge</code>). Distances are in
          metres, max_flow in people per minute.
        </p>
      </details>
      <label htmlFor={`floor-file-${floorId}`}>Floor file</label>
      <input id={`floor-file-${floorId}`} type="file" accept={FLOOR_IMPORT_ACCEPT}
             onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
             aria-invalid={Boolean(problem)} />
      {problem && <p className="field-error">{problem}</p>}
      {error !== null && <p role="alert" className="field-error">{describeError(error)}</p>}
      {result && (
        <p role="status">
          Imported {result.nodes_imported} places and {result.edges_imported} paths.
        </p>
      )}
      <p>
        <button type="submit" className="btn" disabled={busy || !file || Boolean(problem)}>
          {busy ? "Importing…" : "Import"}
        </button>
      </p>
    </form>
  );
}

export function FloorExportLinks({ floorId }: { floorId: number }) {
  // Plain links: the browser downloads the file; the session cookie goes with it.
  return (
    <span className="whitespace-nowrap">
      Export:{" "}
      <a href={`/api/backend/floors/${floorId}/export?format=json`} download>JSON</a> ·{" "}
      <a href={`/api/backend/floors/${floorId}/export?format=geojson`} download>GeoJSON</a> ·{" "}
      <a href={`/api/backend/floors/${floorId}/export?format=csv`} download>CSV</a>
    </span>
  );
}

// --- Delete ------------------------------------------------------------------------------

export function DeleteConfirm({ what, path, onDeleted, onCancel }: {
  what: string;            // e.g. "the hospital “General”"
  path: string;            // e.g. "/hospitals/3"
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const { busy, error, run } = useAction();

  async function confirm() {
    const done = await run(async () => {
      await apiRequest<void>(path, { method: "DELETE" });
      return true;
    });
    if (done) onDeleted();
  }

  return (
    <div>
      <p>
        Delete {what}? It is hidden everywhere but kept in the history (audit log). Items that still contain
        something (for example a building with floors) cannot be deleted.
      </p>
      {error !== null && <p role="alert" className="field-error">{describeError(error)}</p>}
      <p className="flex flex-wrap gap-2">
        <button type="button" className="btn bg-bad" onClick={() => void confirm()} disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </button>
        <button type="button" className="btn l" onClick={onCancel}>Cancel</button>
      </p>
    </div>
  );
}
