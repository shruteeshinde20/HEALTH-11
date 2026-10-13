"use client";

// Patients and staff as CSV files (backend/app/people_io.py). Export downloads
// the current list. Import is two steps: "Check file" asks the backend what the
// file would change (nothing is saved), then "Apply changes" saves it. The file
// is the full list, so people missing from it are removed; the check says how
// many before anything happens.

import { useState, type FormEvent } from "react";

import { apiUpload } from "@/lib/client/api.ts";
import { useAction } from "@/lib/client/use-action.ts";
import type { PeopleImportResult } from "@/lib/shared/api-types.ts";
import { ApiError, describeError } from "@/lib/shared/errors.ts";
import {
  MAX_PEOPLE_FILE_BYTES, PEOPLE_CSV_COLUMNS, importChangesSomething, importSummary, type PeopleKind,
} from "@/lib/shared/people.ts";

/** Plain link: the browser downloads the file; the session cookie goes with it. */
export function PeopleExportLink({ kind }: { kind: PeopleKind }) {
  return <a className="btn l" href={`/api/backend/${kind}/export`} download>Export CSV</a>;
}

function Problems({ error }: { error: unknown }) {
  if (error === null) return null;
  const details = error instanceof ApiError ? error.details : [];
  return (
    <div role="alert" className="field-error">
      <p className="m-0">{describeError(error)}</p>
      {details.length > 0 && (
        <ul className="my-1 pl-5">
          {details.map((d, i) => <li key={i}>{d.field}: {d.message}</li>)}
        </ul>
      )}
    </div>
  );
}

export function PeopleImport({ kind, onApplied, onClose }: {
  kind: PeopleKind; onApplied: () => void; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<PeopleImportResult | null>(null);
  const [saved, setSaved] = useState<PeopleImportResult | null>(null);
  const check = useAction();
  const apply = useAction();
  const who = kind === "patients" ? "patients" : "staff members";

  const problem = !file ? null
    : !file.name.toLowerCase().endsWith(".csv") ? "Choose a .csv file."
      : file.size > MAX_PEOPLE_FILE_BYTES ? "The file is larger than 1 MB."
        : null;

  function choose(next: File | null) {
    setFile(next);
    setChecked(null);
    setSaved(null);
    check.clear();
    apply.clear();
  }

  async function submitCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || problem) return;
    setSaved(null);
    const result = await check.run(() => apiUpload<PeopleImportResult>(`/${kind}/import?apply=false`, file, "text/csv"));
    setChecked(result ?? null);
  }

  async function applyChanges() {
    if (!file || !checked) return;
    const result = await apply.run(() => apiUpload<PeopleImportResult>(`/${kind}/import?apply=true`, file, "text/csv"));
    if (result) {
      setSaved(result);
      setChecked(null);
      onApplied();
    }
  }

  return (
    <form onSubmit={submitCheck} noValidate>
      <p className="sm mt-0">
        The file becomes the list of {who}: rows are matched by code, new codes are added, changed rows are
        updated, and {who} who are not in the file are removed. Start from <strong>Export CSV</strong> to get the
        right columns. You see what will change before anything is saved.
      </p>
      <details className="sm">
        <summary>CSV columns</summary>
        <p className="break-words font-mono text-xs">{PEOPLE_CSV_COLUMNS[kind].join(",")}</p>
        <p>
          {kind === "patients"
            ? <>mobility: ambulatory, wheelchair, stretcher or ventilator. criticality: 1 (stable) to 5 (critical), empty = 3. </>
            : null}
          test_data: true or false. hospital, building, floor_number and place: as in the Facility Manager and
          Graph Builder; leave all four empty for &ldquo;not placed&rdquo;.
        </p>
      </details>
      <label htmlFor={`${kind}-csv-file`}>CSV file</label>
      <input id={`${kind}-csv-file`} type="file" accept=".csv"
             onChange={(e) => choose(e.target.files?.[0] ?? null)} aria-invalid={Boolean(problem)} />
      {problem && <p className="field-error">{problem}</p>}
      <Problems error={check.error} />
      <Problems error={apply.error} />

      {checked && (
        <div role="status">
          <p className="mb-1">{importSummary(checked)}</p>
          {checked.removed > 0 && (
            <p className="field-error mt-0">
              <strong>{checked.removed} {checked.removed === 1 ? "person" : "people"} on the website {checked.removed === 1 ? "is" : "are"} not
              in the file and will be removed.</strong>
            </p>
          )}
          {!importChangesSomething(checked) && <p className="mt-0">The website already matches this file.</p>}
        </div>
      )}
      {saved && <p role="status">{importSummary(saved)}</p>}

      <p className="flex flex-wrap gap-2">
        <button type="submit" className={checked ? "btn l" : "btn"} disabled={check.busy || !file || Boolean(problem)}>
          {check.busy ? "Checking…" : "Check file"}
        </button>
        {checked && importChangesSomething(checked) && (
          <button type="button" className="btn" disabled={apply.busy} onClick={() => void applyChanges()}>
            {apply.busy ? "Saving…" : "Apply changes"}
          </button>
        )}
        <button type="button" className="btn l" onClick={onClose}>{saved ? "Close" : "Cancel"}</button>
      </p>
    </form>
  );
}
