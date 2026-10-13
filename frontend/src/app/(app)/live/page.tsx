"use client";

// Live Simulation (PROJECT.md: left controls, central floor map, right results
// panel; light theme). Replays a saved run tick by tick over the backend's
// WebSocket. Emergency Commanders and Administrators can add a hazard while
// it runs; everyone re-routes from then on. Everything comes from the API.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type FormEvent } from "react";

import { Field, FormError } from "@/components/facility-forms.tsx";
import { RunResult } from "@/components/run-result.tsx";
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import { useRunStream, type StreamPhase } from "@/lib/client/use-run-stream.ts";
import type { Floor, HazardType, Page, RunDetail, RunSummary, Scenario } from "@/lib/shared/api-types.ts";
import { algorithmLabel, formatDateTime } from "@/lib/shared/format.ts";
import { hazardName, parseNumber, placeColour } from "@/lib/shared/graph.ts";
import {
  MOBILITY_COLOURS, MOBILITY_LABELS, STREAM_SPEEDS, clock, exitLoadRows, floorView, mapFloors, spread,
  type LiveFrame, type RunMap,
} from "@/lib/shared/live.ts";
import { APP_PAGES, SAFETY_NOTICE } from "@/lib/shared/pages.ts";
import { HAZARD_TYPES, MAX_SPREAD, SEVERITY_LABELS } from "@/lib/shared/scenario.ts";

const scenarioBuilder = APP_PAGES.find((page) => page.href === "/scenarios");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// --- Page ---------------------------------------------------------------------------------

function LiveSimulation() {
  const router = useRouter();
  const params = useSearchParams();
  const runs = useApi<Page<RunSummary>>("/simulation_runs", { limit: 50 });
  const scenarios = useAll<Scenario>("/scenarios");
  const floors = useAll<Floor>("/floors");

  const requested = Number(params.get("run")) || null;
  const runId = requested ?? runs.data?.items[0]?.id ?? null;
  const detail = useApi<RunDetail>(runId ? `/simulation_runs/${runId}` : null);

  const scenarioName = (id: number) => scenarios.data?.find((s) => s.id === id)?.name ?? `Scenario ${id}`;
  const options = [...(runs.data?.items ?? [])];
  if (detail.data && !options.some((run) => run.id === detail.data!.id)) options.unshift(detail.data);
  const loadError = runs.error ?? scenarios.error ?? floors.error;

  return (
    <>
      <PageHeader title="Live Simulation" subtitle="Watch a saved evacuation step by step, and add hazards while it runs." />
      {loadError !== null && <ErrorState error={loadError} onRetry={() => { runs.reload(); scenarios.reload(); floors.reload(); }} />}
      {loadError === null && (!runs.data || !scenarios.data || !floors.data) && <LoadingState />}
      {runs.data && runs.data.items.length === 0 && !requested && (
        <Card>
          <EmptyState>
            No simulation has been run yet.{" "}
            {scenarioBuilder?.ready && <>Run one from the <Link href={scenarioBuilder.href}>Scenario Builder</Link>.</>}
          </EmptyState>
        </Card>
      )}
      {runId !== null && scenarios.data && floors.data && (
        <>
          <Card className="mb-[14px]">
            <label htmlFor="live-run" className="mt-0">Simulation run</label>
            <select id="live-run" value={runId}
                    onChange={(e) => router.replace(`/live?run=${e.target.value}`, { scroll: false })}>
              {options.map((run) => (
                <option key={run.id} value={run.id}>
                  Run {run.id} · {scenarioName(run.scenario_id)} · {algorithmLabel(run.algorithm)} · {formatDateTime(run.created_at)}
                </option>
              ))}
            </select>
          </Card>
          {detail.error !== null && <ErrorState error={detail.error} onRetry={detail.reload} />}
          {detail.error === null && detail.data?.id !== runId && <LoadingState />}
          {detail.data && detail.data.id === runId && (
            <LiveView key={runId} run={detail.data} floors={floors.data} scenarioName={scenarioName(detail.data.scenario_id)}
                      onRunChanged={detail.reload} />
          )}
        </>
      )}
    </>
  );
}

// --- One run ------------------------------------------------------------------------------

function LiveView({ run, floors, scenarioName, onRunChanged }: {
  run: RunDetail;
  floors: Floor[];
  scenarioName: string;
  onRunChanged: () => void;
}) {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const stream = useRunStream();
  const [speed, setSpeed] = useState(10);
  const floorIds = useMemo(() => mapFloors(run.map), [run.map]);
  const [floorId, setFloorId] = useState<number | null>(floorIds[0] ?? null);
  const floorName = (id: number) => floors.find((f) => f.id === id)?.name ?? `Floor ${id}`;
  const nodeNames = useMemo(() => new Map(run.map.nodes.map((n) => [n.id, n.name])), [run.map]);
  const frame = stream.frame;

  if (run.map.nodes.length === 0) {
    return <Card><EmptyState>This run has no floor plan to show (its building had no places).</EmptyState></Card>;
  }

  const live = stream.phase === "running" || stream.phase === "paused" || stream.phase === "connecting";
  const shownFloor = floorId ?? floorIds[0]!;
  const onFloor = (frame?.positions ?? []).filter((p) => p.floor_id === shownFloor).length;

  return (
    <div className="grid gap-[14px] xl:grid-cols-[260px_minmax(0,1fr)_300px]">
      <Card>
        <h2 className="mt-0">Controls</h2>
        <p className="sm my-1">{scenarioName} · {algorithmLabel(run.algorithm)}</p>
        <label htmlFor="live-speed">Speed</label>
        <select id="live-speed" value={speed} disabled={live} aria-describedby="live-speed-hint"
                onChange={(e) => setSpeed(Number(e.target.value))}>
          {STREAM_SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
        <p id="live-speed-hint" className="sm mt-1 mb-0">
          {speed}× = {speed} simulated {speed === 1 ? "second" : "seconds"} per real second.
        </p>
        <p className="flex flex-wrap gap-2">
          {!live && (
            <button type="button" className="btn" onClick={() => void stream.start(run.id, speed)}>
              {stream.phase === "done" ? "Watch again" : "Start"}
            </button>
          )}
          {stream.phase === "running" && <button type="button" className="btn" onClick={stream.pause}>Pause</button>}
          {stream.phase === "paused" && <button type="button" className="btn" onClick={stream.resume}>Resume</button>}
          {live && <button type="button" className="btn l" onClick={stream.reset}>Stop</button>}
        </p>
        <StreamStatus phase={stream.phase} frame={frame} error={stream.error} />
        {canEdit && (
          <AddHazard run={run} floorName={floorName} now={frame?.t ?? 0} live={live}
                     onAdded={onRunChanged} />
        )}
      </Card>

      <Card>
        {floorIds.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Floor">
            {floorIds.map((id) => {
              const people = (frame?.positions ?? []).filter((p) => p.floor_id === id).length;
              return (
                <button key={id} type="button" className={id === shownFloor ? "btn" : "btn l"}
                        aria-pressed={id === shownFloor} onClick={() => setFloorId(id)}>
                  {floorName(id)}{frame ? ` (${people})` : ""}
                </button>
              );
            })}
          </div>
        )}
        <FloorMap map={run.map} floorId={shownFloor} frame={frame}
                  label={`Floor plan of ${floorName(shownFloor)}${frame ? `, ${onFloor} people on this floor` : ""}`} />
        <Legend />
        <p className="note mb-0">{SAFETY_NOTICE}</p>
      </Card>

      <Card>
        <h2 className="mt-0">Results</h2>
        <LiveResults frame={frame} nodeNames={nodeNames} />
        {stream.phase === "done" && (
          <div className="mt-3 border-t border-line pt-3">
            <h3 className="m-0 text-[14px] font-bold text-ink">Saved results</h3>
            <RunResult result={run} showLive={false} />
          </div>
        )}
      </Card>
    </div>
  );
}

function StreamStatus({ phase, frame, error }: { phase: StreamPhase; frame: LiveFrame | null; error: string | null }) {
  const text: Record<StreamPhase, string> = {
    idle: "Press Start to watch this run.",
    connecting: "Connecting…",
    running: "Running.",
    paused: `Paused at ${clock(frame?.t ?? 0)}.`,
    done: `Finished at ${clock(frame?.t ?? 0)}.`,
    error: error ?? "The live stream stopped.",
  };
  return (
    <p role="status" aria-live="polite" className={phase === "error" ? "field-error" : "sm"}>
      {text[phase]}
    </p>
  );
}

// --- Map ----------------------------------------------------------------------------------

function FloorMap({ map, floorId, frame, label }: { map: RunMap; floorId: number; frame: LiveFrame | null; label: string }) {
  const nodes = useMemo(() => map.nodes.filter((n) => n.floor_id === floorId), [map, floorId]);
  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map]);
  const edges = useMemo(
    () => map.edges.filter((e) => byId.get(e.from_node_id)?.floor_id === floorId && byId.get(e.to_node_id)?.floor_id === floorId),
    [map, byId, floorId],
  );
  const view = useMemo(() => floorView(nodes), [nodes]);
  const blocked = new Set(frame?.blocked_nodes ?? []);
  const congested = new Set(frame?.congested_edges ?? []);
  const people = (frame?.positions ?? []).filter((p) => p.floor_id === floorId);
  const u = view.unit;

  return (
    <svg role="img" aria-label={label} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
         className="h-[460px] w-full rounded-lg border border-line bg-white">
      {edges.map((edge) => {
        const a = byId.get(edge.from_node_id)!;
        const b = byId.get(edge.to_node_id)!;
        const busy = congested.has(edge.id);
        return (
          <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={edge.is_blocked ? "#DC2626" : busy ? "#EA580C" : "#CBD5E1"}
                strokeWidth={busy ? u * 0.9 : u * 0.45} strokeDasharray={edge.is_blocked ? `${u} ${u * 0.7}` : undefined}
                strokeLinecap="round" />
        );
      })}
      {nodes.map((node) => {
        const isBlocked = node.is_blocked || blocked.has(node.id);
        return (
          <g key={node.id}>
            <circle cx={node.x} cy={node.y} r={u * 1.6} fill={placeColour(node.type, isBlocked)}
                    stroke={isBlocked ? "#DC2626" : "#94A3B8"} strokeWidth={u * 0.25} />
            <text x={node.x} y={node.y - u * 2.3} textAnchor="middle" fontSize={u * 1.5} fill="#334155">{node.name}</text>
          </g>
        );
      })}
      {people.map((person) => {
        const { dx, dy } = spread(person.id, u);
        const moving = person.status === "active";
        return (
          <circle key={person.id} cx={person.x + dx} cy={person.y + dy} r={u * 0.6}
                  fill={moving ? MOBILITY_COLOURS[person.mobility] ?? "#334155" : "#FFFFFF"}
                  stroke={moving ? "#FFFFFF" : "#1E3A5F"} strokeWidth={u * 0.18} />
        );
      })}
    </svg>
  );
}

function Legend() {
  return (
    <ul className="sm my-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
      {Object.entries(MOBILITY_LABELS).map(([key, label]) => (
        <li key={key} className="flex items-center gap-1">
          <svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill={MOBILITY_COLOURS[key]} /></svg>{label}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="#FFFFFF" stroke="#1E3A5F" strokeWidth="1.5" /></svg>
        Waiting for help or reached by the hazard
      </li>
      <li className="flex items-center gap-1">
        <svg width="16" height="12" aria-hidden="true"><line x1="1" y1="6" x2="15" y2="6" stroke="#EA580C" strokeWidth="4" /></svg>
        Queue at this path
      </li>
      <li className="flex items-center gap-1">
        <svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="#F9C5C5" stroke="#DC2626" /></svg>
        Blocked by a hazard
      </li>
    </ul>
  );
}

// --- Results ------------------------------------------------------------------------------

function LiveResults({ frame, nodeNames }: { frame: LiveFrame | null; nodeNames: Map<number, string> }) {
  if (!frame) return <p className="sm">The numbers appear here while the run plays.</p>;
  const share = frame.total ? Math.round((frame.evacuated / frame.total) * 100) : 0;
  const exits = exitLoadRows(frame.exit_load, nodeNames);
  return (
    <>
      <p className="m-0 text-[28px] font-bold text-ink" aria-label={`Simulated time ${clock(frame.t)}`}>{clock(frame.t)}</p>
      <p className="sm mt-0">simulated time (minutes:seconds)</p>
      {frame.total === 0 ? (
        <p><Tag tone="p">Nobody to evacuate</Tag> Nobody is placed in this building.</p>
      ) : (
        <>
          <p className="mb-1"><strong>{frame.evacuated} of {frame.total}</strong> people reached an exit</p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className="h-full bg-pri" style={{ width: `${share}%` }} />
          </div>
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt>Still moving</dt><dd className="m-0 text-right">{frame.active}</dd>
            <dt>Need assisted evacuation</dt><dd className="m-0 text-right">{frame.needs_assistance}</dd>
            <dt>Reached by the hazard</dt><dd className="m-0 text-right">{frame.reached_by_hazard}</dd>
            <dt>Blocked places</dt><dd className="m-0 text-right">{frame.blocked_nodes.length}</dd>
            <dt>Paths with a queue</dt><dd className="m-0 text-right">{frame.congested_edges.length}</dd>
          </dl>
          <h3 className="mb-1 mt-3 text-[14px] font-bold text-ink">People per exit</h3>
          {exits.length === 0 ? <p className="sm m-0">Nobody has reached an exit yet.</p> : (
            <ul className="m-0 pl-5">
              {exits.map((row) => <li key={row.name}>{row.name}: {row.people}</li>)}
            </ul>
          )}
        </>
      )}
    </>
  );
}

// --- Adding a hazard during the run --------------------------------------------------------

function AddHazard({ run, floorName, now, live, onAdded }: {
  run: RunDetail;
  floorName: (id: number) => string;
  now: number;
  live: boolean;
  onAdded: () => void;
}) {
  const places = useMemo(
    () => [...run.map.nodes].sort((a, b) => floorName(a.floor_id).localeCompare(floorName(b.floor_id)) || a.name.localeCompare(b.name)),
    [run.map, floorName],
  );
  const [type, setType] = useState<HazardType>("fire");
  const [origin, setOrigin] = useState<number | null>(null);
  const [severity, setSeverity] = useState("3");
  const [spreadRate, setSpreadRate] = useState("0");
  const [at, setAt] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const { busy, error, run: act } = useAction();
  const fields = fieldErrors(error);

  const spreadValue = parseNumber(spreadRate, 0, MAX_SPREAD);
  const atValue = at.trim() === "" ? Math.ceil(now) : parseNumber(at, 0, 36_000);
  const place = places.find((p) => p.id === origin);
  const valid = place !== undefined && spreadValue !== null && !Number.isNaN(spreadValue)
    && atValue !== null && !Number.isNaN(atValue);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || !place) return;
    const body = {
      name: hazardName(type, place.name), type, origin_node_id: place.id,
      severity: Number(severity), spread_rate: spreadValue, at_seconds: atValue,
    };
    const done = await act(() => apiRequest(`/simulations/${run.id}/hazards`, { method: "POST", body }));
    if (done !== undefined) {
      setAdded(`${body.name} added at ${clock(atValue as number)}. Everyone re-routes from then on; the saved results were updated.`);
      setAt("");
      onAdded();
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-3 border-t border-line pt-3">
      <h3 className="m-0 text-[14px] font-bold text-ink">Add a hazard</h3>
      <Field id="add-hazard-type" label="Hazard type" error={fields.type}>
        <select id="add-hazard-type" value={type} onChange={(e) => setType(e.target.value as HazardType)}>
          {HAZARD_TYPES.map((value) => <option key={value} value={value}>{capital(value)}</option>)}
        </select>
      </Field>
      <Field id="add-hazard-place" label="Where does it start?" error={fields.origin_node_id}>
        <select id="add-hazard-place" value={origin ?? ""} onChange={(e) => setOrigin(Number(e.target.value))}>
          <option value="" disabled>Choose a place</option>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type}) · {floorName(p.floor_id)}</option>)}
        </select>
      </Field>
      <Field id="add-hazard-severity" label="Severity" error={fields.severity}>
        <select id="add-hazard-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} ({SEVERITY_LABELS[value]})</option>)}
        </select>
      </Field>
      <Field id="add-hazard-spread" label="Spread (metres per minute)"
             error={fields.spread_rate ?? (spreadValue !== null && Number.isNaN(spreadValue) ? `Enter 0 to ${MAX_SPREAD}.` : undefined)}>
        <input id="add-hazard-spread" type="number" min={0} max={MAX_SPREAD} step="any" value={spreadRate}
               onChange={(e) => setSpreadRate(e.target.value)} />
      </Field>
      <Field id="add-hazard-at" label="Starts at (seconds of simulated time)"
             hint={live ? `Empty = now (${Math.ceil(now)} s). A time already passed in the live view starts now.` : "Empty = at the start (0 s)."}
             error={fields.at_seconds ?? (atValue !== null && Number.isNaN(atValue) ? "Enter 0 to 36,000 seconds." : undefined)}>
        <input id="add-hazard-at" type="number" min={0} max={36_000} step={1} value={at} placeholder={String(Math.ceil(now))}
               onChange={(e) => setAt(e.target.value)} aria-describedby="add-hazard-at-hint" />
      </Field>
      <FormError error={error} />
      {added && <p role="status" className="sm">{added}</p>}
      <p className="mb-0">
        <button type="submit" className="btn" disabled={busy || !valid}>{busy ? "Adding…" : "Add hazard"}</button>
      </p>
    </form>
  );
}

export default function LivePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <LiveSimulation />
    </Suspense>
  );
}
