"use client";

// Patients & Staff: who is in the hospital and where, plus the evacuation
// priority of patients (PROJECT.md AI feature 2: a transparent rule-based
// score with its breakdown). Staff Users can view only. Patients are stored
// by code, never by name. Everything comes from the API.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { Dialog } from "@/components/dialog.tsx";
import { Buttons, DeleteConfirm, Field, FormError } from "@/components/facility-forms.tsx";
import { PlacePicker } from "@/components/place-picker.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import { useFacility, type Facility } from "@/lib/client/use-facility.ts";
import type { Patient, PriorityResult, Scenario, StaffMember } from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import type { Mobility } from "@/lib/shared/live.ts";
import {
  CRITICALITY_LABELS, MAX_BATCH, MOBILITIES, MOBILITY_HELP, batchCodes, placeLabel, placementCounts,
} from "@/lib/shared/people.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";

const livePage = APP_PAGES.find((page) => page.href === "/live");
const TABS = [
  { key: "patients", label: "Patients" },
  { key: "staff", label: "Staff" },
  { key: "priority", label: "Evacuation priority" },
] as const;
type Tab = (typeof TABS)[number]["key"];
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function People() {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = TABS.find((t) => t.key === params.get("tab"))?.key ?? "patients";
  const { facility, error, reload } = useFacility();

  return (
    <>
      <PageHeader title="Patients & Staff" subtitle="Who is in the hospital, where they are, and who to evacuate first." />
      <div className="mb-[14px] flex flex-wrap gap-2" role="group" aria-label="Show">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={t.key === tab ? "btn" : "btn l"} aria-pressed={t.key === tab}
                  onClick={() => router.replace(`/people?tab=${t.key}`, { scroll: false })}>
            {t.label}
          </button>
        ))}
      </div>
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {error === null && !facility && <LoadingState />}
      {facility && tab === "patients" && <PatientList facility={facility} canEdit={canEdit} />}
      {facility && tab === "staff" && <StaffList facility={facility} canEdit={canEdit} />}
      {facility && tab === "priority" && <Priority facility={facility} />}
      {livePage?.ready && (
        <p className="sm">People placed in a building take part in its simulations; watch them in the <Link href={livePage.href}>Live Simulation</Link>.</p>
      )}
    </>
  );
}

// --- Shared list filter ------------------------------------------------------------------

function useListFilter(facility: Facility) {
  const [search, setSearch] = useState("");
  const [where, setWhere] = useState("all");      // "all", "none" or a building id
  const matches = (texts: string[], nodeId: number | null) => {
    const q = search.trim().toLowerCase();
    if (q && !texts.some((t) => t.toLowerCase().includes(q))) return false;
    if (where === "none") return nodeId === null;
    if (where !== "all") return nodeId !== null && facility.places.get(nodeId)?.building_id === Number(where);
    return true;
  };
  const controls = (idPrefix: string, searchLabel: string) => (
    <div className="flex flex-wrap gap-3">
      <div className="min-w-[200px] flex-1">
        <label htmlFor={`${idPrefix}-search`}>{searchLabel}</label>
        <input id={`${idPrefix}-search`} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="min-w-[200px] flex-1">
        <label htmlFor={`${idPrefix}-where`}>Where</label>
        <select id={`${idPrefix}-where`} value={where} onChange={(e) => setWhere(e.target.value)}>
          <option value="all">Everywhere</option>
          {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
          <option value="none">Not placed</option>
        </select>
      </div>
    </div>
  );
  return { matches, controls };
}

const whereText = (facility: Facility, nodeId: number | null) =>
  placeLabel(nodeId, facility.places, facility.floorName, facility.buildingLabel);

// --- Patients ----------------------------------------------------------------------------

type Open<T> = { kind: "add" } | { kind: "edit"; item: T } | { kind: "delete"; item: T } | null;

function PatientList({ facility, canEdit }: { facility: Facility; canEdit: boolean }) {
  const patients = useAll<Patient>("/patients");
  const [open, setOpen] = useState<Open<Patient>>(null);
  const filter = useListFilter(facility);
  const close = () => setOpen(null);
  const saved = () => { close(); patients.reload(); };

  if (patients.error !== null) return <ErrorState error={patients.error} onRetry={patients.reload} />;
  if (!patients.data) return <LoadingState />;
  const shown = [...patients.data]
    .filter((p) => filter.matches([p.patient_code], p.node_id))
    .sort((a, b) => a.patient_code.localeCompare(b.patient_code));
  const counts = placementCounts(patients.data);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="m-0">Patients ({patients.data.length})</h2>
          <p className="sm my-1">{counts.placed} placed · {counts.unplaced} not placed</p>
        </div>
        {canEdit && <button type="button" className="btn" onClick={() => setOpen({ kind: "add" })}>Add patients</button>}
      </div>
      {filter.controls("patients", "Search by code")}
      {patients.data.length === 0 ? <EmptyState>No patients yet.</EmptyState>
        : shown.length === 0 ? <EmptyState>No patient matches.</EmptyState> : (
          <DataTable caption="Patients" columns={["Code", "Mobility", "Criticality", "Where", ""]}
            rows={shown.map((p) => ({
              key: p.id,
              cells: [
                <span key="code">{p.patient_code}{p.is_synthetic && <> <Tag tone="w">Test data</Tag></>}</span>,
                capital(p.mobility),
                `${p.criticality} (${CRITICALITY_LABELS[p.criticality] ?? ""})`,
                whereText(facility, p.node_id),
                canEdit ? (
                  <span key="actions" className="flex flex-wrap gap-2">
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit", item: p })}>Edit</button>
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "delete", item: p })}>Delete</button>
                  </span>
                ) : "",
              ],
            }))} />
        )}
      <Dialog open={open?.kind === "add"} title="Add patients" onClose={close}>
        {open?.kind === "add" && <PatientForm facility={facility} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "edit"} title="Edit patient" onClose={close}>
        {open?.kind === "edit" && <PatientForm facility={facility} patient={open.item} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "delete"} title="Delete patient" onClose={close}>
        {open?.kind === "delete" && (
          <DeleteConfirm what={`the patient “${open.item.patient_code}”`} path={`/patients/${open.item.id}`}
                         onDeleted={saved} onCancel={close} />
        )}
      </Dialog>
    </Card>
  );
}

/** Add one after another; on a failure, say how many were added before it. */
async function addAll(bodies: unknown[], path: string): Promise<void> {
  for (let i = 0; i < bodies.length; i++) {
    try {
      await apiRequest(path, { method: "POST", body: bodies[i] });
    } catch (caught) {
      if (i === 0) throw caught;
      throw new Error(`${i} of ${bodies.length} were added; then: ${describeError(caught)}`);
    }
  }
}

function PatientForm({ facility, patient, onSaved, onCancel }: {
  facility: Facility; patient?: Patient; onSaved: () => void; onCancel: () => void;
}) {
  const [code, setCode] = useState(patient?.patient_code ?? "");
  const [count, setCount] = useState("1");
  const [mobility, setMobility] = useState<Mobility>(patient?.mobility ?? "ambulatory");
  const [criticality, setCriticality] = useState(String(patient?.criticality ?? 3));
  const [nodeId, setNodeId] = useState<number | null>(patient?.node_id ?? null);
  const [synthetic, setSynthetic] = useState(patient?.is_synthetic ?? false);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);
  const codes = patient ? (code.trim() ? [code.trim()] : null) : batchCodes(code, Number(count));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!codes) return;
    const body = { mobility, criticality: Number(criticality), node_id: nodeId, is_synthetic: synthetic };
    const done = await run(async () => {
      if (patient) await apiRequest(`/patients/${patient.id}`, { method: "PATCH", body: { patient_code: codes[0], ...body } });
      else await addAll(codes.map((c) => ({ patient_code: c, ...body })), "/patients");
      return true;
    });
    if (done) onSaved();
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="patient-code" label="Patient code" hint="A code from your records, never the patient's name." error={fields.patient_code}>
        <input id="patient-code" required maxLength={100} value={code} onChange={(e) => setCode(e.target.value)}
               aria-describedby="patient-code-hint" />
      </Field>
      {!patient && (
        <Field id="patient-count" label={`How many (1–${MAX_BATCH})`}
               hint={Number(count) > 1 ? `Codes become ${code.trim() || "CODE"}-1 … -${count}.` : undefined}
               error={codes === null && code.trim() ? `Enter a whole number from 1 to ${MAX_BATCH}.` : undefined}>
          <input id="patient-count" type="number" min={1} max={MAX_BATCH} step={1} value={count}
                 onChange={(e) => setCount(e.target.value)} />
        </Field>
      )}
      <Field id="patient-mobility" label="Mobility" error={fields.mobility}>
        <select id="patient-mobility" value={mobility} onChange={(e) => setMobility(e.target.value as Mobility)}>
          {MOBILITIES.map((m) => <option key={m} value={m}>{MOBILITY_HELP[m]}</option>)}
        </select>
      </Field>
      <Field id="patient-criticality" label="Criticality" error={fields.criticality}>
        <select id="patient-criticality" value={criticality} onChange={(e) => setCriticality(e.target.value)}>
          {[1, 2, 3, 4, 5].map((c) => <option key={c} value={c}>{c} ({CRITICALITY_LABELS[c]})</option>)}
        </select>
      </Field>
      <PlacePicker id="patient-place" facility={facility} value={nodeId} onChange={setNodeId} error={fields.node_id} />
      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} />
        Test data (not a real patient)
      </label>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!codes} label={patient ? "Save" : codes && codes.length > 1 ? `Add ${codes.length} patients` : "Add patient"}
               onCancel={onCancel} />
    </form>
  );
}

// --- Staff -------------------------------------------------------------------------------

function StaffList({ facility, canEdit }: { facility: Facility; canEdit: boolean }) {
  const staff = useAll<StaffMember>("/staff");
  const [open, setOpen] = useState<Open<StaffMember>>(null);
  const filter = useListFilter(facility);
  const close = () => setOpen(null);
  const saved = () => { close(); staff.reload(); };

  if (staff.error !== null) return <ErrorState error={staff.error} onRetry={staff.reload} />;
  if (!staff.data) return <LoadingState />;
  const shown = [...staff.data]
    .filter((s) => filter.matches([s.staff_code, s.full_name, s.role], s.node_id))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const counts = placementCounts(staff.data);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="m-0">Staff ({staff.data.length})</h2>
          <p className="sm my-1">{counts.placed} placed · {counts.unplaced} not placed. Staff walk at walking speed in simulations.</p>
        </div>
        {canEdit && <button type="button" className="btn" onClick={() => setOpen({ kind: "add" })}>Add staff</button>}
      </div>
      {filter.controls("staff", "Search by name, code or role")}
      {staff.data.length === 0 ? <EmptyState>No staff yet.</EmptyState>
        : shown.length === 0 ? <EmptyState>No staff member matches.</EmptyState> : (
          <DataTable caption="Staff" columns={["Name", "Code", "Role", "Where", ""]}
            rows={shown.map((s) => ({
              key: s.id,
              cells: [
                <span key="name">{s.full_name}{s.is_synthetic && <> <Tag tone="w">Test data</Tag></>}</span>,
                s.staff_code,
                s.role,
                whereText(facility, s.node_id),
                canEdit ? (
                  <span key="actions" className="flex flex-wrap gap-2">
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit", item: s })}>Edit</button>
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "delete", item: s })}>Delete</button>
                  </span>
                ) : "",
              ],
            }))} />
        )}
      <Dialog open={open?.kind === "add"} title="Add staff" onClose={close}>
        {open?.kind === "add" && <StaffForm facility={facility} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "edit"} title="Edit staff member" onClose={close}>
        {open?.kind === "edit" && <StaffForm facility={facility} member={open.item} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "delete"} title="Delete staff member" onClose={close}>
        {open?.kind === "delete" && (
          <DeleteConfirm what={`the staff member “${open.item.full_name}”`} path={`/staff/${open.item.id}`}
                         onDeleted={saved} onCancel={close} />
        )}
      </Dialog>
    </Card>
  );
}

function StaffForm({ facility, member, onSaved, onCancel }: {
  facility: Facility; member?: StaffMember; onSaved: () => void; onCancel: () => void;
}) {
  const [code, setCode] = useState(member?.staff_code ?? "");
  const [name, setName] = useState(member?.full_name ?? "");
  const [role, setRole] = useState(member?.role ?? "");
  const [count, setCount] = useState("1");
  const [nodeId, setNodeId] = useState<number | null>(member?.node_id ?? null);
  const [synthetic, setSynthetic] = useState(member?.is_synthetic ?? false);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);
  const codes = member ? (code.trim() ? [code.trim()] : null) : batchCodes(code, Number(count));
  const complete = codes !== null && name.trim() !== "" && role.trim() !== "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || !codes) return;
    const several = codes.length > 1;
    const body = (staffCode: string, i: number) => ({
      staff_code: staffCode, full_name: several ? `${name.trim()} ${i + 1}` : name.trim(), role: role.trim(),
      node_id: nodeId, is_synthetic: synthetic,
    });
    const done = await run(async () => {
      if (member) await apiRequest(`/staff/${member.id}`, { method: "PATCH", body: body(codes[0]!, 0) });
      else await addAll(codes.map(body), "/staff");
      return true;
    });
    if (done) onSaved();
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="staff-name" label="Full name" error={fields.full_name}>
        <input id="staff-name" required maxLength={190} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="staff-code" label="Staff code" error={fields.staff_code}>
        <input id="staff-code" required maxLength={100} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field id="staff-role" label="Role" hint="For example nurse, doctor or porter." error={fields.role}>
        <input id="staff-role" required maxLength={100} value={role} onChange={(e) => setRole(e.target.value)}
               aria-describedby="staff-role-hint" />
      </Field>
      {!member && (
        <Field id="staff-count" label={`How many (1–${MAX_BATCH})`}
               hint={Number(count) > 1 ? `Codes become ${code.trim() || "CODE"}-1 … -${count}; names get a number too.` : undefined}
               error={codes === null && code.trim() ? `Enter a whole number from 1 to ${MAX_BATCH}.` : undefined}>
          <input id="staff-count" type="number" min={1} max={MAX_BATCH} step={1} value={count}
                 onChange={(e) => setCount(e.target.value)} />
        </Field>
      )}
      <PlacePicker id="staff-place" facility={facility} value={nodeId} onChange={setNodeId} error={fields.node_id} />
      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} />
        Test data (not a real person)
      </label>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!complete} label={member ? "Save" : codes && codes.length > 1 ? `Add ${codes.length} staff` : "Add staff member"}
               onCancel={onCancel} />
    </form>
  );
}

// --- Evacuation priority -----------------------------------------------------------------

function Priority({ facility }: { facility: Facility }) {
  const scenarios = useAll<Scenario>("/scenarios");
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const scenario = scenarios.data?.find((s) => s.id === scenarioId) ?? null;
  const hazardBuilding = scenario?.hazards
    .map((h) => facility.places.get(h.origin_node_id)?.building_id)
    .find((id): id is number => id !== undefined) ?? null;
  const building = buildingId ?? hazardBuilding;
  const query = { limit: 200, scenario_id: scenarioId ?? undefined, building_id: building ?? undefined };
  // A scenario without hazards needs a building (the API cannot tell which one).
  const ready = scenarioId === null || building !== null;
  const result = useApi<PriorityResult>(ready ? "/patient_priority" : null, query);

  return (
    <Card>
      <h2 className="mt-0">Who to evacuate first</h2>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="priority-scenario">Scenario</label>
          <select id="priority-scenario" value={scenarioId ?? ""} onChange={(e) => {
            setScenarioId(e.target.value === "" ? null : Number(e.target.value));
            setBuildingId(null);
          }}>
            <option value="">No scenario (mobility and criticality only)</option>
            {[...(scenarios.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label htmlFor="priority-building">Building</label>
          <select id="priority-building" value={building ?? ""}
                  onChange={(e) => setBuildingId(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="" disabled={scenarioId !== null}>{scenarioId === null ? "All patients" : "Choose a building"}</option>
            {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
          </select>
        </div>
      </div>
      {scenarios.error !== null && <ErrorState error={scenarios.error} onRetry={scenarios.reload} />}
      {!ready && <p className="sm">Choose the building to rank.</p>}
      {result.error !== null && <ErrorState error={result.error} onRetry={result.reload} />}
      {ready && result.error === null && !result.data && <LoadingState />}
      {result.data && (
        <>
          {result.data.items.length === 0 ? <EmptyState>No patients {building !== null ? "in this building" : "yet"}.</EmptyState> : (
            <DataTable caption="Patients by evacuation priority"
              columns={["Rank", "Patient", "Where", "Mobility", "Criticality", "Hazard", "Score"]}
              rows={result.data.items.map((row) => ({
                key: row.patient_id,
                cells: [
                  row.rank,
                  <span key="p">{row.patient_code}{row.is_synthetic && <> <Tag tone="w">Test data</Tag></>}</span>,
                  whereText(facility, row.node_id),
                  `${capital(row.breakdown.mobility.value)}: ${row.breakdown.mobility.points} pts`,
                  `${row.breakdown.criticality.value}: ${row.breakdown.criticality.points} pts`,
                  `${row.breakdown.hazard.explanation}: ${row.breakdown.hazard.points} pts`,
                  <strong key="s">{row.score}</strong>,
                ],
              }))} />
          )}
          {result.data.total > result.data.items.length && (
            <p className="sm">Showing the first {result.data.items.length} of {result.data.total} patients.</p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer font-semibold text-ink">How the score works</summary>
            <p>{result.data.method}</p>
            <p className="sm">Score = points for mobility + criticality + hazard (0–100). The weights and values used:</p>
            <ul className="sm pl-5">
              {result.data.parameters_used.map((p) => (
                <li key={p.name}>
                  <code>{p.name}</code> = {p.value}{p.unit ? ` ${p.unit}` : ""}{p.meaning ? ` — ${p.meaning}` : ""}
                  {p.source ? ` (source: ${p.source})` : ""}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Card>
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <People />
    </Suspense>
  );
}
