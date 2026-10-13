"use client";

// Onboarding wizard (PROJECT.md): 1) create hospital, 2) create building and
// floor, 3) import or draw the floor graph, 4) run a first simulation.
// Progress is worked out from the organization's real data, so the wizard can
// be left and resumed at any time.

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";

import {
  BuildingForm, FloorForm, FloorImport, HospitalForm,
} from "@/components/facility-forms.tsx";
import { Card, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import type {
  Building, Floor, FloorGraph, Hospital, HazardType, Page, RunDetail, RunSummary,
} from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import { ALGORITHM_LABELS, formatSeconds } from "@/lib/shared/format.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";

const graphBuilder = APP_PAGES.find((page) => page.href === "/graph");
const peoplePage = APP_PAGES.find((page) => page.href === "/people");
const HAZARD_TYPES: HazardType[] = ["fire", "smoke", "hazmat", "structural"];

type StepState = "done" | "current" | "later";

function Step({ number, title, state, summary, children }: {
  number: number; title: string; state: StepState; summary?: ReactNode; children?: ReactNode;
}) {
  const tag = state === "done" ? <Tag tone="ok">Done</Tag> : state === "current" ? <Tag tone="p">Now</Tag> : <Tag tone="w">Later</Tag>;
  return (
    <Card className="mb-[14px]">
      <section aria-labelledby={`step-${number}`} aria-current={state === "current" ? "step" : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={`step-${number}`} className="m-0">{number}. {title}</h2>
          {tag}
        </div>
        {state === "done" && summary && <p className="sm mb-0">{summary}</p>}
        {state === "current" && children}
      </section>
    </Card>
  );
}

export default function OnboardingPage() {
  const user = useUser();
  const hospitals = useAll<Hospital>("/hospitals");
  const buildings = useAll<Building>("/buildings");
  const floors = useAll<Floor>("/floors");
  const runs = useApi<Page<RunSummary>>("/simulation_runs", { limit: 1 });
  const [chosenFloorId, setChosenFloorId] = useState<number | null>(null);

  const sortedFloors = [...(floors.data ?? [])].sort((a, b) => a.id - b.id);
  const floor = sortedFloors.find((f) => f.id === chosenFloorId) ?? sortedFloors[0] ?? null;
  const graph = useApi<FloorGraph>(floor ? `/floors/${floor.id}/graph` : null);

  const reloadAll = () => {
    hospitals.reload();
    buildings.reload();
    floors.reload();
    runs.reload();
    graph.reload();
  };

  if (user.role === "Staff User") {
    return (
      <>
        <PageHeader title="Get started" subtitle="Set up your hospital in four steps." />
        <Card>
          <p className="m-0">Setting up hospitals needs an Administrator or Emergency Commander. You can follow progress on the <Link href="/dashboard">Dashboard</Link>.</p>
        </Card>
      </>
    );
  }

  const loadError = hospitals.error ?? buildings.error ?? floors.error ?? runs.error ?? graph.error;
  if (loadError !== null) return <ErrorState error={loadError} onRetry={reloadAll} />;
  if (!hospitals.data || !buildings.data || !floors.data || !runs.data || (floor && !graph.data)) {
    return <LoadingState />;
  }

  const hospital = [...hospitals.data].sort((a, b) => a.id - b.id)[0] ?? null;
  const placeCount = graph.data?.nodes.length ?? 0;
  const done = [hospital !== null, floor !== null, placeCount > 0, runs.data.total > 0];
  const current = done.indexOf(false);           // -1 when everything is done
  const state = (i: number): StepState => (done[i] ? "done" : i === current ? "current" : "later");
  const buildingOfFloor = floor ? buildings.data.find((b) => b.id === floor.building_id) ?? null : null;

  return (
    <>
      <PageHeader title="Get started" subtitle="Set up your hospital in four steps. You can stop and come back at any time." />

      <Step number={1} title="Create your hospital" state={state(0)}
            summary={hospital && <>{hospital.name}{hospital.address ? `, ${hospital.address}` : ""}</>}>
        <HospitalForm onSaved={reloadAll} submitLabel="Create hospital" />
      </Step>

      <Step number={2} title="Add a building and a floor" state={state(1)}
            summary={floor && buildingOfFloor && <>{buildingOfFloor.name} · {floor.name} (floor {floor.floor_number})</>}>
        {hospital && <BuildingAndFloor hospitalId={hospital.id} buildings={buildings.data} onDone={reloadAll} />}
      </Step>

      <Step number={3} title="Add the floor plan" state={state(2)}
            summary={<>{placeCount} places on {floor?.name}</>}>
        {floor && (
          <>
            {sortedFloors.length > 1 && (
              <>
                <label htmlFor="wizard-floor">Floor to set up</label>
                <select id="wizard-floor" value={floor.id} onChange={(e) => setChosenFloorId(Number(e.target.value))}>
                  {sortedFloors.map((f) => <option key={f.id} value={f.id}>{f.name} (floor {f.floor_number})</option>)}
                </select>
              </>
            )}
            <p>
              The floor plan is a graph: <strong>places</strong> (rooms, wards, corridors, stairs, lifts, exits) and the
              <strong> paths</strong> between them with their length in metres.
            </p>
            <h3 className="mb-1 text-[14px] font-bold text-ink">Import a floor file</h3>
            <FloorImport floorId={floor.id} onImported={reloadAll} />
            {graphBuilder?.ready
              ? <p>Or <Link href={`${graphBuilder.href}?floor=${floor.id}`}>draw it in the Graph Builder</Link>.</p>
              : <p className="sm">Drawing the plan on screen comes with the Graph Builder page, which is built next.</p>}
          </>
        )}
      </Step>

      <Step number={4} title="Run a first simulation" state={state(3)}
            summary={<>{runs.data.total} simulation{runs.data.total === 1 ? "" : "s"} saved. <Link href="/dashboard">Open the Dashboard</Link></>}>
        {floor && graph.data && <FirstSimulation floor={floor} graph={graph.data} onDone={runs.reload} />}
      </Step>

      {current === -1 && (
        <Card>
          <p className="m-0">
            <Tag tone="ok">All set</Tag> Your hospital is set up. Continue on the <Link href="/dashboard">Dashboard</Link>
            {" "}or in the <Link href="/facilities">Facility Manager</Link>.
          </p>
        </Card>
      )}
    </>
  );
}

function BuildingAndFloor({ hospitalId, buildings, onDone }: {
  hospitalId: number; buildings: Building[]; onDone: () => void;
}) {
  const existing = buildings.filter((b) => b.hospital_id === hospitalId).sort((a, b) => a.id - b.id)[0] ?? null;
  const [building, setBuilding] = useState<Building | null>(existing);

  if (!building) {
    return (
      <>
        <p>First the building, then its first floor.</p>
        <BuildingForm hospitalId={hospitalId} onSaved={setBuilding} submitLabel="Add building" />
      </>
    );
  }
  return (
    <>
      <p>Building: <strong>{building.name}</strong>. Now its first floor.</p>
      <FloorForm buildingId={building.id} onSaved={onDone} submitLabel="Add floor" />
    </>
  );
}

function FirstSimulation({ floor, graph, onDone }: { floor: Floor; graph: FloorGraph; onDone: () => void }) {
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState("astar");
  const [withHazard, setWithHazard] = useState(true);
  const [hazardType, setHazardType] = useState<HazardType>("fire");
  const [origin, setOrigin] = useState<number | null>(graph.nodes[0]?.id ?? null);
  const [severity, setSeverity] = useState("3");
  const [spread, setSpread] = useState("0");
  const [result, setResult] = useState<RunDetail | null>(null);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  if (graph.nodes.length === 0) return <p>Add the floor plan first (step 3).</p>;

  const spreadValue = Number(spread);
  const spreadValid = spread.trim() !== "" && Number.isFinite(spreadValue) && spreadValue >= 0 && spreadValue <= 1000;
  const originNode = graph.nodes.find((node) => node.id === origin);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (withHazard && (!originNode || !spreadValid)) return;
    const detail = await run(async () => {
      const hazards = withHazard && originNode ? [{
        name: `${hazardType[0]!.toUpperCase()}${hazardType.slice(1)} at ${originNode.name}`,
        type: hazardType, origin_node_id: originNode.id, severity: Number(severity), spread_rate: spreadValue,
      }] : [];
      const scenario = await apiRequest<{ id: number }>("/scenarios", { method: "POST", body: { name: name.trim(), hazards } });
      const { run_id } = await apiRequest<{ run_id: number }>("/simulate", {
        // The hazard (if any) is on this floor, so this floor's building is simulated.
        method: "POST", body: { scenario_id: scenario.id, algorithm, building_id: floor.building_id },
      });
      return apiRequest<RunDetail>(`/simulation_runs/${run_id}`);
    });
    if (detail) setResult(detail);
  }

  if (result) {
    const summary = result.summary;
    return (
      <div role="status">
        {!summary || summary.total === 0 ? (
          <p>
            <Tag tone="p">Nobody to evacuate</Tag> The simulation was saved, but nobody is placed in this building yet.
            {peoplePage?.ready ? <> Add people on <Link href={peoplePage.href}>Patients &amp; Staff</Link>.</>
                               : " Placing patients and staff comes with the Patients & Staff page."}
          </p>
        ) : (
          <>
            <p>
              <Tag tone={summary.all_evacuated ? "ok" : "b"}>{summary.all_evacuated ? "Everyone out" : "Not everyone out"}</Tag>{" "}
              {summary.evacuated} of {summary.total} people reached an exit
              {summary.all_evacuated ? ` in ${formatSeconds(summary.evacuation_time_s)}.` : "."}
            </p>
            <ul>
              {result.recommendations.map((item, i) => <li key={i}>{item.text}</li>)}
            </ul>
          </>
        )}
        <p className="flex flex-wrap gap-2">
          <a className="btn l" href={`/api/backend/reports/${result.id}?format=pdf`} download>Report (PDF)</a>
          <a className="btn l" href={`/api/backend/reports/${result.id}?format=csv`} download>Report (CSV)</a>
          <button type="button" className="btn" onClick={onDone}>Finish</button>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <p>A scenario describes an emergency. The simulation moves every patient and staff member placed in the building to the safest exit.</p>
      <label htmlFor="scenario-name">Scenario name</label>
      <input id="scenario-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)}
             aria-invalid={Boolean(fields.name)} />
      {fields.name && <p className="field-error">{fields.name}</p>}

      <label htmlFor="scenario-algorithm">Route finding</label>
      <select id="scenario-algorithm" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
        {Object.entries(ALGORITHM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>

      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={withHazard} onChange={(e) => setWithHazard(e.target.checked)} />
        Add a hazard (otherwise a calm evacuation drill)
      </label>
      {withHazard && (
        <fieldset className="m-0 border-0 p-0">
          <legend className="sr-only">Hazard</legend>
          <label htmlFor="hazard-type">Hazard type</label>
          <select id="hazard-type" value={hazardType} onChange={(e) => setHazardType(e.target.value as HazardType)}>
            {HAZARD_TYPES.map((type) => <option key={type} value={type}>{type[0]!.toUpperCase() + type.slice(1)}</option>)}
          </select>
          <label htmlFor="hazard-origin">Where does it start?</label>
          <select id="hazard-origin" value={origin ?? ""} onChange={(e) => setOrigin(Number(e.target.value))}>
            {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.name} ({node.type})</option>)}
          </select>
          <label htmlFor="hazard-severity">Severity (1 minor to 5 extreme)</label>
          <select id="hazard-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {["1", "2", "3", "4", "5"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label htmlFor="hazard-spread">Spread (metres per minute, 0 = does not spread)</label>
          <input id="hazard-spread" type="number" min={0} max={1000} step="any" value={spread}
                 onChange={(e) => setSpread(e.target.value)} aria-invalid={!spreadValid} />
          {!spreadValid && <p className="field-error">Enter a number from 0 to 1000.</p>}
        </fieldset>
      )}
      {error !== null && Object.keys(fields).length === 0 && <p role="alert" className="field-error">{describeError(error)}</p>}
      <p>
        <button type="submit" className="btn" disabled={busy || !name.trim() || (withHazard && (!originNode || !spreadValid))}>
          {busy ? "Running…" : "Save and run"}
        </button>
      </p>
    </form>
  );
}
