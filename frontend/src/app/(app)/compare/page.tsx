"use client";

// Algorithm Comparison (docs/design/preview.html "cmp"): the same scenario,
// four ways to find a route. POST /compare runs BFS, DFS, Dijkstra and A* on
// the same people, hazards and settings and saves nothing; any of them can
// then be run and saved, and watched live. Everything comes from the API.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { MeasureBars } from "@/components/charts.tsx";
import { FormError } from "@/components/facility-forms.tsx";
import { RunResult } from "@/components/run-result.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll } from "@/lib/client/use-api.ts";
import { useFacility, type Facility } from "@/lib/client/use-facility.ts";
import type { Comparison, RunDetail, Scenario } from "@/lib/shared/api-types.ts";
import { ALGORITHM_EXPLANATIONS, bestOf } from "@/lib/shared/compare.ts";
import { algorithmLabel, formatSeconds } from "@/lib/shared/format.ts";
import { APP_PAGES, SAFETY_NOTICE } from "@/lib/shared/pages.ts";
import { hazardSummary } from "@/lib/shared/scenario.ts";

const scenarioBuilder = APP_PAGES.find((page) => page.href === "/scenarios");
const livePage = APP_PAGES.find((page) => page.href === "/live");

function AlgorithmComparison() {
  const user = useUser();
  const canRun = user.role !== "Staff User";
  const params = useSearchParams();
  const scenarios = useAll<Scenario>("/scenarios");
  const { facility, error: facilityError, reload: reloadFacility } = useFacility();
  const loadError = scenarios.error ?? facilityError;

  return (
    <>
      <PageHeader title="Algorithm Comparison" subtitle="Same scenario, four ways to find a route." />
      {!canRun && (
        <Card><EmptyState>Comparing algorithms runs simulations, so it is for Administrators and Emergency Commanders.</EmptyState></Card>
      )}
      {canRun && loadError !== null && <ErrorState error={loadError} onRetry={() => { scenarios.reload(); reloadFacility(); }} />}
      {canRun && loadError === null && (!scenarios.data || !facility) && <LoadingState />}
      {canRun && scenarios.data && facility && (scenarios.data.length === 0 ? (
        <Card>
          <EmptyState>
            No scenarios yet.{" "}
            {scenarioBuilder?.ready && <>Create one in the <Link href={scenarioBuilder.href}>Scenario Builder</Link>.</>}
          </EmptyState>
        </Card>
      ) : (
        <Comparer scenarios={scenarios.data} facility={facility} initial={Number(params.get("scenario")) || null} />
      ))}
    </>
  );
}

function Comparer({ scenarios, facility, initial }: { scenarios: Scenario[]; facility: Facility; initial: number | null }) {
  const router = useRouter();
  const sorted = [...scenarios].sort((a, b) => a.name.localeCompare(b.name));
  const [scenarioId, setScenarioId] = useState<number>(
    sorted.find((s) => s.id === initial)?.id ?? sorted[0]!.id);
  const scenario = sorted.find((s) => s.id === scenarioId) ?? sorted[0]!;
  const hazardBuilding = scenario.hazards
    .map((h) => facility.places.get(h.origin_node_id)?.building_id)
    .find((id): id is number => id !== undefined) ?? null;
  const [buildingChoice, setBuildingChoice] = useState<number | null>(null);
  const buildingId = buildingChoice ?? hazardBuilding
    ?? (facility.buildings.length === 1 ? facility.buildings[0]!.id : null);

  const [rows, setRows] = useState<{ key: string; data: Comparison[] } | null>(null);
  const [saved, setSaved] = useState<RunDetail | null>(null);
  const compare = useAction();
  const save = useAction();
  const key = `${scenarioId}|${buildingId}`;
  const current = rows?.key === key ? rows.data : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (buildingId === null) return;
    setSaved(null);
    const data = await compare.run(() => apiRequest<Comparison[]>("/compare", {
      method: "POST", body: { scenario_id: scenarioId, building_id: buildingId },
    }));
    if (data) setRows({ key, data });
  }

  async function runWith(algorithm: string) {
    if (buildingId === null) return;
    const detail = await save.run(async () => {
      const { run_id } = await apiRequest<{ run_id: number }>("/simulate", {
        method: "POST", body: { scenario_id: scenarioId, algorithm, building_id: buildingId },
      });
      return apiRequest<RunDetail>(`/simulation_runs/${run_id}`);
    });
    if (!detail) return;
    if (livePage?.ready) router.push(`${livePage.href}?run=${detail.id}`);
    else setSaved(detail);
  }

  return (
    <>
      <Card className="mb-[14px] max-w-[720px]">
        <form onSubmit={submit} noValidate>
          <label htmlFor="compare-scenario" className="mt-0">Scenario</label>
          <select id="compare-scenario" value={scenarioId}
                  onChange={(e) => { setScenarioId(Number(e.target.value)); setBuildingChoice(null); }}>
            {sorted.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <p className="sm mt-1 mb-0">{hazardSummary(scenario.hazards)}</p>
          <label htmlFor="compare-building">Building to evacuate</label>
          <select id="compare-building" value={buildingId ?? ""} onChange={(e) => setBuildingChoice(Number(e.target.value))}>
            <option value="" disabled>Choose a building</option>
            {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
          </select>
          <FormError error={compare.error} />
          <p className="mb-0">
            <button type="submit" className="btn" disabled={compare.busy || buildingId === null}>
              {compare.busy ? "Comparing…" : "Compare"}
            </button>
          </p>
        </form>
      </Card>

      {current && <Results rows={current} busy={save.busy} onRun={(algorithm) => void runWith(algorithm)} />}
      {current && <FormError error={save.error} />}
      {saved && (
        <Card className="mt-[14px]">
          <h2 className="mt-0">Saved run</h2>
          <RunResult result={saved} showAlgorithm />
        </Card>
      )}
    </>
  );
}

function Results({ rows, busy, onRun }: { rows: Comparison[]; busy: boolean; onRun: (algorithm: string) => void }) {
  if (rows.every((row) => row.total === 0)) {
    return (
      <Card>
        <p className="m-0"><Tag tone="p">Nobody to evacuate</Tag> Nobody is placed in this building, so there is nothing to compare.</p>
      </Card>
    );
  }
  const best = bestOf(rows);
  const tags = (algorithm: string) => (
    <span className="flex flex-wrap gap-1">
      {best.fastest.has(algorithm) && <Tag tone="ok">Fastest</Tag>}
      {best.shortest.has(algorithm) && <Tag tone="p">Shortest walk</Tag>}
      {best.safest.has(algorithm) && <Tag tone="p">Lowest risk</Tag>}
    </span>
  );
  return (
    <Card>
      <h2 className="mt-0">Results</h2>
      <div className="mb-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[14px]">
        <MeasureBars title="Evacuation time (s), everyone out only" unit="s"
                     data={rows.map((r) => ({ label: algorithmLabel(r.algorithm), value: r.all_evacuated ? r.evacuation_time_s : null }))} />
        <MeasureBars title="Mean walk (m)" unit="m"
                     data={rows.map((r) => ({ label: algorithmLabel(r.algorithm), value: r.distance_m }))} />
        <MeasureBars title="Mean risk exposure" unit=""
                     data={rows.map((r) => ({ label: algorithmLabel(r.algorithm), value: r.risk }))} />
      </div>
      <DataTable
        caption="Results per algorithm"
        columns={["Algorithm", "Everyone out?", "Evacuation time", "Mean walk (m)", "Mean risk exposure", "Need help", "Reached by hazard", "Best at", ""]}
        rows={rows.map((row) => ({
          key: row.algorithm,
          cells: [
            <span key="name"><strong>{algorithmLabel(row.algorithm)}</strong>
              <span className="sm block">{ALGORITHM_EXPLANATIONS[row.algorithm] ?? ""}</span></span>,
            row.all_evacuated ? <Tag key="out" tone="ok">Yes</Tag>
                              : <Tag key="out" tone="b">{row.evacuated} of {row.total}</Tag>,
            row.all_evacuated ? formatSeconds(row.evacuation_time_s) : "not complete",
            row.distance_m ?? "–",
            row.risk ?? "–",
            row.needs_assistance,
            row.reached_by_hazard,
            tags(row.algorithm),
            <button key="run" type="button" className="btn l" disabled={busy} onClick={() => onRun(row.algorithm)}>
              {busy ? "Running…" : livePage?.ready ? "Run and watch" : "Run and save"}
            </button>,
          ],
        }))}
      />
      <h3 className="mb-1 mt-4 text-[14px] font-bold text-ink">How this comparison works</h3>
      <ul className="sm mt-0 pl-5">
        <li>All four use the same people, hazards and speeds from your saved data. Nothing is saved until you press a run button.</li>
        <li>Evacuation time is when the last person reached an exit. It is only shown when everyone got out.</li>
        <li>Mean walk is the average distance walked by the people who reached an exit.</li>
        <li>
          Mean risk exposure adds up, for each person, the seconds spent at places a hazard has reached or will
          soon reach, weighted by that place&apos;s hazard risk (0 = safe, 1 = most dangerous), then averages over
          everyone. Lower is safer; 0 means nobody came near a hazard.
        </li>
        <li>This is a rule-based simulation, not a prediction from data. {SAFETY_NOTICE}</li>
      </ul>
    </Card>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AlgorithmComparison />
    </Suspense>
  );
}
