"use client";

// Scenario Builder (docs/design/preview.html "scen"): three steps per hazard
// (hazard type, where it starts, severity and spread), with "Save scenario"
// and "Save and run". A scenario may hold several hazards (up to 50) or none
// (a calm evacuation drill). Everything comes from the API.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type FormEvent } from "react";

import { Dialog } from "@/components/dialog.tsx";
import { DeleteConfirm, Field, FormError, optional } from "@/components/facility-forms.tsx";
import { RunResult } from "@/components/run-result.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll } from "@/lib/client/use-api.ts";
import type {
  Building, Floor, GraphNode, HazardType, Hospital, RunDetail, Scenario,
} from "@/lib/shared/api-types.ts";
import { ALGORITHM_LABELS, formatDateTime } from "@/lib/shared/format.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";
import {
  HAZARD_TYPES, MAX_HAZARDS, MAX_SPREAD, SEVERITY_LABELS, defaultRunBuilding, draftFromHazard, draftProblems,
  draftsValid, hazardBodies, hazardSummary, newDraft, updateDraft, type HazardDraft, type PlaceRef,
} from "@/lib/shared/scenario.ts";

const graphBuilder = APP_PAGES.find((page) => page.href === "/graph");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the forms need to know about the organization's buildings, floors and places. */
type Facility = {
  buildings: Building[];                  // sorted by label
  floorsOf: (buildingId: number) => Floor[];
  placesOf: (floorId: number) => PlaceRef[];
  places: Map<number, PlaceRef>;
  buildingLabel: (buildingId: number) => string;
};

function useFacility(): { facility: Facility | null; error: unknown; reload: () => void } {
  const hospitals = useAll<Hospital>("/hospitals");
  const buildings = useAll<Building>("/buildings");
  const floors = useAll<Floor>("/floors");
  const nodes = useAll<GraphNode>("/nodes");

  const hospitalList = hospitals.data;
  const buildingList = buildings.data;
  const floorList = floors.data;
  const nodeList = nodes.data;

  const facility = useMemo<Facility | null>(() => {
    if (!hospitalList || !buildingList || !floorList || !nodeList) return null;
    const hospitalName = new Map(hospitalList.map((h) => [h.id, h.name]));
    const buildingById = new Map(buildingList.map((b) => [b.id, b]));
    const floorById = new Map(floorList.map((f) => [f.id, f]));
    const buildingLabel = (id: number) => {
      const building = buildingById.get(id);
      return building ? `${hospitalName.get(building.hospital_id) ?? "?"} / ${building.name}` : `Building ${id}`;
    };
    const places = new Map<number, PlaceRef>();
    for (const node of nodeList) {
      const floor = floorById.get(node.floor_id);
      if (!floor) continue;
      places.set(node.id, { id: node.id, name: node.name, type: node.type, floor_id: floor.id, building_id: floor.building_id });
    }
    const allFloors = floorList;
    return {
      buildings: [...buildingList].sort((a, b) => buildingLabel(a.id).localeCompare(buildingLabel(b.id))),
      floorsOf: (buildingId) =>
        allFloors.filter((f) => f.building_id === buildingId).sort((a, b) => a.floor_number - b.floor_number),
      placesOf: (floorId) =>
        [...places.values()].filter((p) => p.floor_id === floorId).sort((a, b) => a.name.localeCompare(b.name)),
      places,
      buildingLabel,
    };
  }, [hospitalList, buildingList, floorList, nodeList]);

  return {
    facility,
    error: hospitals.error ?? buildings.error ?? floors.error ?? nodes.error,
    reload: () => {
      hospitals.reload();
      buildings.reload();
      floors.reload();
      nodes.reload();
    },
  };
}

// --- Page ---------------------------------------------------------------------------------

function ScenarioBuilder() {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const router = useRouter();
  const params = useSearchParams();
  const edit = params.get("edit");                 // "new", a scenario id, or null for the list
  const scenarios = useAll<Scenario>("/scenarios");
  const { facility, error: facilityError, reload: reloadFacility } = useFacility();
  const [deleting, setDeleting] = useState<Scenario | null>(null);
  const [running, setRunning] = useState<Scenario | null>(null);

  const show = (value: string | null) =>
    router.replace(value ? `/scenarios?edit=${value}` : "/scenarios", { scroll: false });
  const loadError = scenarios.error ?? facilityError;
  const reloadAll = () => {
    scenarios.reload();
    reloadFacility();
  };

  if (loadError !== null) {
    return (
      <>
        <PageHeader title="Scenario Builder" subtitle="Three steps: hazard, place, severity." />
        <Card><ErrorState error={loadError} onRetry={reloadAll} /></Card>
      </>
    );
  }
  if (!scenarios.data || !facility) {
    return (
      <>
        <PageHeader title="Scenario Builder" subtitle="Three steps: hazard, place, severity." />
        <Card><LoadingState /></Card>
      </>
    );
  }

  const editing = edit === "new" ? null : scenarios.data.find((s) => String(s.id) === edit);
  if (edit !== null && canEdit && (edit === "new" || editing)) {
    return (
      <>
        <PageHeader title="Scenario Builder" subtitle="Three steps: hazard, place, severity." />
        <ScenarioEditor key={edit} scenario={editing ?? undefined} facility={facility}
                        onClose={() => { scenarios.reload(); show(null); }}
                        onSaved={() => scenarios.reload()} />
      </>
    );
  }

  const sorted = [...scenarios.data].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader title="Scenario Builder" subtitle="Three steps: hazard, place, severity." />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0">Scenarios</h2>
          {canEdit && <button type="button" className="btn" onClick={() => show("new")}>New scenario</button>}
        </div>
        {edit !== null && !canEdit && <p className="sm">Only Administrators and Emergency Commanders can change scenarios.</p>}
        {edit !== null && canEdit && <p role="alert" className="field-error">That scenario no longer exists.</p>}
        {sorted.length === 0 ? (
          <EmptyState>
            No scenarios yet.{" "}
            {canEdit ? "Create one with “New scenario”." : "Ask an Administrator or Emergency Commander to create one."}
          </EmptyState>
        ) : (
          <DataTable
            caption="Scenarios"
            columns={["Name", "Hazards", "Status", "Last changed", ""]}
            rows={sorted.map((scenario) => ({
              key: scenario.id,
              cells: [
                <span key="name">
                  {scenario.name}
                  {scenario.description && <span className="sm block">{scenario.description}</span>}
                </span>,
                hazardSummary(scenario.hazards),
                scenario.is_active ? <Tag key="s" tone="ok">Active</Tag> : <Tag key="s" tone="w">Inactive</Tag>,
                formatDateTime(scenario.updated_at),
                canEdit ? (
                  <span key="actions" className="flex flex-wrap gap-2">
                    <button type="button" className="btn" onClick={() => setRunning(scenario)}>Run</button>
                    <button type="button" className="btn l" onClick={() => show(String(scenario.id))}>Edit</button>
                    <button type="button" className="btn l" onClick={() => setDeleting(scenario)}>Delete</button>
                  </span>
                ) : "",
              ],
            }))}
          />
        )}
      </Card>

      <Dialog open={running !== null} title={running ? `Run “${running.name}”` : "Run"} onClose={() => setRunning(null)}>
        {running && <RunScenario scenario={running} facility={facility} />}
      </Dialog>
      <Dialog open={deleting !== null} title="Delete scenario" onClose={() => setDeleting(null)}>
        {deleting && (
          <DeleteConfirm what={`the scenario “${deleting.name}”`} path={`/scenarios/${deleting.id}`}
                         onDeleted={() => { setDeleting(null); scenarios.reload(); }}
                         onCancel={() => setDeleting(null)} />
        )}
      </Dialog>
    </>
  );
}

// --- Running ------------------------------------------------------------------------------

async function simulate(scenarioId: number, algorithm: string, buildingId: number): Promise<RunDetail> {
  const { run_id } = await apiRequest<{ run_id: number }>("/simulate", {
    method: "POST", body: { scenario_id: scenarioId, algorithm, building_id: buildingId },
  });
  return apiRequest<RunDetail>(`/simulation_runs/${run_id}`);
}

/** Route finding and building for a run. Hazards in other buildings do not affect it. */
function RunOptions({ facility, algorithm, setAlgorithm, buildingId, setBuildingId, hazardBuildings }: {
  facility: Facility;
  algorithm: string;
  setAlgorithm: (value: string) => void;
  buildingId: number | null;
  setBuildingId: (value: number) => void;
  hazardBuildings: number[];
}) {
  const elsewhere = buildingId !== null && hazardBuildings.some((id) => id !== buildingId);
  return (
    <>
      <label htmlFor="run-algorithm">Route finding</label>
      <select id="run-algorithm" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
        {Object.entries(ALGORITHM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor="run-building">Building to evacuate</label>
      <select id="run-building" value={buildingId ?? ""} onChange={(e) => setBuildingId(Number(e.target.value))}>
        <option value="" disabled>Choose a building</option>
        {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
      </select>
      {elsewhere && <p className="sm mt-1 mb-0">Hazards in other buildings do not affect this run.</p>}
    </>
  );
}

function RunScenario({ scenario, facility }: { scenario: Scenario; facility: Facility }) {
  const hazardBuildings = scenario.hazards
    .map((h) => facility.places.get(h.origin_node_id)?.building_id)
    .filter((id): id is number => id !== undefined);
  const [algorithm, setAlgorithm] = useState("astar");
  const [buildingId, setBuildingId] = useState<number | null>(
    hazardBuildings[0] ?? (facility.buildings.length === 1 ? facility.buildings[0]!.id : null));
  const [result, setResult] = useState<RunDetail | null>(null);
  const { busy, error, run } = useAction();

  if (result) return <RunResult result={result} showAlgorithm />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (buildingId === null) return;
    const detail = await run(() => simulate(scenario.id, algorithm, buildingId));
    if (detail) setResult(detail);
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="mt-0">{hazardSummary(scenario.hazards)}</p>
      <RunOptions facility={facility} algorithm={algorithm} setAlgorithm={setAlgorithm}
                  buildingId={buildingId} setBuildingId={setBuildingId} hazardBuildings={hazardBuildings} />
      <FormError error={error} />
      {error !== null && Object.keys(fieldErrors(error)).length > 0 && (
        <p role="alert" className="field-error">{Object.values(fieldErrors(error))[0]}</p>
      )}
      <p>
        <button type="submit" className="btn" disabled={busy || buildingId === null}>{busy ? "Running…" : "Run simulation"}</button>
      </p>
    </form>
  );
}

// --- Editing ------------------------------------------------------------------------------

function ScenarioEditor({ scenario, facility, onClose, onSaved }: {
  scenario?: Scenario;
  facility: Facility;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [savedId, setSavedId] = useState<number | null>(scenario?.id ?? null);
  const [name, setName] = useState(scenario?.name ?? "");
  const [description, setDescription] = useState(scenario?.description ?? "");
  const [active, setActive] = useState(scenario?.is_active ?? true);
  const [drafts, setDrafts] = useState<HazardDraft[]>(() => scenario
    ? scenario.hazards.map((h) => draftFromHazard(h, facility.places))
    : [newDraft(firstFloor(facility))]);
  const [algorithm, setAlgorithm] = useState("astar");
  const [buildingChoice, setBuildingChoice] = useState<number | null>(null);
  const [result, setResult] = useState<RunDetail | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  const hazardBuildings = drafts.map((d) => d.buildingId).filter((id): id is number => id !== null);
  const runBuilding = buildingChoice ?? defaultRunBuilding(drafts)
    ?? (facility.buildings.length === 1 ? facility.buildings[0]!.id : null);
  const nameProblem = name.trim() === "" ? "Enter a name." : name.trim().length > 200 ? "Use at most 200 characters." : undefined;
  const descriptionProblem = description.length > 5000 ? "Use at most 5,000 characters." : undefined;
  const complete = !nameProblem && !descriptionProblem && draftsValid(drafts, facility.places);

  const change = (key: string, update: Partial<HazardDraft>) => {
    setSavedNote(false);
    setDrafts((current) => current.map((d) => (d.key === key ? updateDraft(d, update, facility.places) : d)));
  };

  async function save(andRun: boolean) {
    if (!complete || (andRun && runBuilding === null)) return;
    setSavedNote(false);
    const body = { name: name.trim(), description: optional(description), is_active: active, hazards: hazardBodies(drafts) };
    const outcome = await run(async () => {
      const saved = savedId === null
        ? await apiRequest<Scenario>("/scenarios", { method: "POST", body })
        // PATCH replaces the whole hazard list with this one.
        : await apiRequest<Scenario>(`/scenarios/${savedId}`, { method: "PATCH", body });
      setSavedId(saved.id);
      onSaved();
      return { detail: andRun && runBuilding !== null ? await simulate(saved.id, algorithm, runBuilding) : null };
    });
    if (!outcome) return;
    if (outcome.detail) setResult(outcome.detail);
    else setSavedNote(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(false);
  }

  if (result) {
    return (
      <Card>
        <h2 className="mt-0">Result for “{name.trim()}”</h2>
        <RunResult result={result} showAlgorithm>
          <button type="button" className="btn l" onClick={() => setResult(null)}>Back to the scenario</button>
          <button type="button" className="btn l" onClick={onClose}>All scenarios</button>
        </RunResult>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <Card className="max-w-[720px]">
        <h2 className="mt-0">{savedId === null ? "New scenario" : "Edit scenario"}</h2>
        <Field id="scenario-name" label="Scenario name" error={fields.name ?? (name !== "" ? nameProblem : undefined)}>
          <input id="scenario-name" required maxLength={200} value={name}
                 onChange={(e) => { setName(e.target.value); setSavedNote(false); }}
                 aria-invalid={Boolean(fields.name) || (name !== "" && Boolean(nameProblem))} />
        </Field>
        <Field id="scenario-description" label="Description (optional)" error={fields.description ?? descriptionProblem}>
          <textarea id="scenario-description" rows={2} maxLength={5000} value={description}
                    onChange={(e) => { setDescription(e.target.value); setSavedNote(false); }} />
        </Field>
        <label className="flex items-center gap-2 text-tx">
          <input type="checkbox" className="w-auto" checked={active}
                 onChange={(e) => { setActive(e.target.checked); setSavedNote(false); }} />
          Active (counted on the Dashboard)
        </label>
      </Card>

      {drafts.length === 0 && (
        <Card className="mt-[14px] max-w-[720px]">
          <p className="m-0">No hazard: this scenario is a calm evacuation drill.</p>
        </Card>
      )}
      {drafts.map((draft, index) => (
        <HazardFields key={draft.key} index={index} draft={draft} facility={facility}
                      serverErrors={prefixed(fields, `hazards.${index}.`)}
                      onChange={(update) => change(draft.key, update)}
                      onRemove={() => { setSavedNote(false); setDrafts((current) => current.filter((d) => d.key !== draft.key)); }} />
      ))}
      <p className="max-w-[720px]">
        <button type="button" className="btn l" disabled={drafts.length >= MAX_HAZARDS}
                onClick={() => setDrafts((current) => [...current, newDraft(lastPlace(current) ?? firstFloor(facility))])}>
          {drafts.length === 0 ? "Add a hazard" : "Add another hazard"}
        </button>
        {drafts.length >= MAX_HAZARDS && <span className="sm ml-2">At most {MAX_HAZARDS} hazards.</span>}
      </p>

      <Card className="mt-[14px] max-w-[720px]">
        <h2 className="mt-0">Run</h2>
        {facility.buildings.length === 0 ? (
          <p className="m-0">Add a building first in the <Link href="/facilities">Facility Manager</Link>.</p>
        ) : (
          <RunOptions facility={facility} algorithm={algorithm} setAlgorithm={setAlgorithm}
                      buildingId={runBuilding} setBuildingId={setBuildingChoice} hazardBuildings={hazardBuildings} />
        )}
        <FormError error={error} />
        {error !== null && Object.keys(fields).length > 0 && (
          <p role="alert" className="field-error">Please correct the fields marked above.</p>
        )}
        {savedNote && <p role="status"><Tag tone="ok">Saved</Tag> The scenario is saved.</p>}
        <p className="flex flex-wrap gap-2">
          <button type="submit" className="btn l" disabled={busy || !complete}>{busy ? "Saving…" : "Save scenario"}</button>
          <button type="button" className="btn" disabled={busy || !complete || runBuilding === null}
                  onClick={() => void save(true)}>
            {busy ? "Working…" : "Save and run"}
          </button>
          <button type="button" className="btn l" onClick={onClose}>{savedId === null ? "Cancel" : "Back to scenarios"}</button>
        </p>
      </Card>
    </form>
  );
}

function prefixed(fields: Record<string, string>, prefix: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [field, message] of Object.entries(fields)) {
    if (field.startsWith(prefix)) found[field.slice(prefix.length)] = message;
  }
  return found;
}

function firstFloor(facility: Facility): { buildingId: number | null; floorId: number | null } {
  const building = facility.buildings[0];
  if (!building) return { buildingId: null, floorId: null };
  return { buildingId: building.id, floorId: facility.floorsOf(building.id)[0]?.id ?? null };
}

function lastPlace(drafts: HazardDraft[]) {
  const last = drafts.at(-1);
  return last ? { buildingId: last.buildingId, floorId: last.floorId } : null;
}

function HazardFields({ index, draft, facility, serverErrors, onChange, onRemove }: {
  index: number;
  draft: HazardDraft;
  facility: Facility;
  serverErrors: Record<string, string>;
  onChange: (update: Partial<HazardDraft>) => void;
  onRemove: () => void;
}) {
  const id = (field: string) => `hazard-${draft.key}-${field}`;
  const problems = draftProblems(draft, facility.places);
  const floors = draft.buildingId !== null ? facility.floorsOf(draft.buildingId) : [];
  const places = draft.floorId !== null ? facility.placesOf(draft.floorId) : [];
  const spreadShown = draft.spread.trim() !== "" ? problems.spread : undefined;

  return (
    <Card className="mt-[14px] max-w-[720px]">
      <fieldset className="m-0 border-0 p-0">
        <legend className="m-0 p-0 text-[15px] font-bold text-ink">Hazard {index + 1}</legend>
        <p className="mt-1 mb-0">
          <button type="button" className="btn l" onClick={onRemove}>Remove hazard {index + 1}</button>
        </p>

        <Field id={id("type")} label="1. Hazard type" error={serverErrors.type}>
          <select id={id("type")} value={draft.type} onChange={(e) => onChange({ type: e.target.value as HazardType })}>
            {HAZARD_TYPES.map((type) => <option key={type} value={type}>{capital(type)}</option>)}
          </select>
        </Field>

        <p className="mb-0 mt-3 font-semibold text-tx">2. Where does it start?</p>
        {draft.lostPlace && <p className="field-error">The place this hazard started at no longer exists. Choose a new one.</p>}
        <label htmlFor={id("building")}>Building</label>
        <select id={id("building")} value={draft.buildingId ?? ""}
                onChange={(e) => {
                  const buildingId = Number(e.target.value);
                  onChange({ buildingId, floorId: facility.floorsOf(buildingId)[0]?.id ?? null, originId: null });
                }}>
          <option value="" disabled>Choose a building</option>
          {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
        </select>
        {draft.buildingId !== null && floors.length === 0 && (
          <p className="sm mt-1 mb-0">This building has no floors yet. Add one in the <Link href="/facilities">Facility Manager</Link>.</p>
        )}
        {floors.length > 0 && (
          <>
            <label htmlFor={id("floor")}>Floor</label>
            <select id={id("floor")} value={draft.floorId ?? ""}
                    onChange={(e) => onChange({ floorId: Number(e.target.value), originId: null })}>
              <option value="" disabled>Choose a floor</option>
              {floors.map((f) => <option key={f.id} value={f.id}>{f.floor_number} · {f.name}</option>)}
            </select>
          </>
        )}
        {draft.floorId !== null && places.length === 0 && (
          <p className="sm mt-1 mb-0">
            This floor has no places yet.{" "}
            {graphBuilder?.ready && <>Draw them in the <Link href={`${graphBuilder.href}?floor=${draft.floorId}`}>Graph Builder</Link>.</>}
          </p>
        )}
        {places.length > 0 && (
          <Field id={id("origin")} label="Place" error={serverErrors.origin_node_id}>
            <select id={id("origin")} value={draft.originId ?? ""} onChange={(e) => onChange({ originId: Number(e.target.value) })}
                    aria-invalid={Boolean(serverErrors.origin_node_id)}>
              <option value="" disabled>Choose a place</option>
              {places.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
            </select>
          </Field>
        )}

        <p className="mb-0 mt-3 font-semibold text-tx">3. Severity and spread</p>
        <label htmlFor={id("severity")}>
          Severity: <output htmlFor={id("severity")}>{draft.severity} ({SEVERITY_LABELS[draft.severity]})</output>
        </label>
        <input id={id("severity")} type="range" min={1} max={5} step={1} value={draft.severity}
               aria-valuetext={`${draft.severity}, ${SEVERITY_LABELS[draft.severity]}`}
               onChange={(e) => onChange({ severity: Number(e.target.value) })} />
        <Field id={id("spread")} label="Spread (metres per minute, 0 = stays where it starts)"
               error={serverErrors.spread_rate ?? spreadShown}>
          <input id={id("spread")} type="number" min={0} max={MAX_SPREAD} step="any" value={draft.spread}
                 onChange={(e) => onChange({ spread: e.target.value })}
                 aria-invalid={Boolean(serverErrors.spread_rate ?? spreadShown)} />
        </Field>

        <Field id={id("name")} label="Hazard name" hint="Filled in from the type and place; you can change it."
               error={serverErrors.name ?? (draft.originId !== null ? problems.name : undefined)}>
          <input id={id("name")} maxLength={200} value={draft.name} aria-describedby={`${id("name")}-hint`}
                 onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-tx">
          <input type="checkbox" className="w-auto" checked={draft.active} onChange={(e) => onChange({ active: e.target.checked })} />
          Active (switch off to keep the hazard but leave it out of runs)
        </label>
      </fieldset>
    </Card>
  );
}

export default function ScenariosPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ScenarioBuilder />
    </Suspense>
  );
}
