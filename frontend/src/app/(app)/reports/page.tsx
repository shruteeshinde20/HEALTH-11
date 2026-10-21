"use client";

// Reports & History: every saved simulation run with its PDF and CSV reports,
// the evacuation-time predictor with "About this prediction" (PROJECT.md AI
// feature 1) and the full list of alerts (AI feature 5). Everything comes
// from the API; missing data is said plainly, never filled in.

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { EvacuationTimeline } from "@/components/charts.tsx";
import { FormError } from "@/components/facility-forms.tsx";
import { RunResult } from "@/components/run-result.tsx";
import { ALERT_TAGS, RunStatus } from "@/components/run-status.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import { useFacility, type Facility } from "@/lib/client/use-facility.ts";
import type { Alerts, Page, Prediction, RunDetail, RunSummary, Scenario } from "@/lib/shared/api-types.ts";
import { ALGORITHM_LABELS, algorithmLabel, formatDateTime, formatSeconds } from "@/lib/shared/format.ts";
import { pageFor } from "@/lib/shared/pages.ts";

const PAGE_SIZE = 20;

export default function ReportsPage() {
  const user = useUser();
  const scenarios = useAll<Scenario>("/scenarios");
  return (
    <>
      <PageHeader title="Reports & History" subtitle="Every run is saved and can be downloaded." />
      <History scenarios={scenarios.data ?? []} />
      <div className="mt-[14px] grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-[14px]">
        {user.role !== "Staff User" && <PredictorCard scenarios={scenarios.data} />}
        <AlertsCard />
      </div>
    </>
  );
}

// --- Run history -------------------------------------------------------------------------

function History({ scenarios }: { scenarios: Scenario[] }) {
  const user = useUser();
  const livePage = pageFor("/live", user.role);
  const assistantPage = pageFor("/assistant", user.role);
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<number | null>(null);
  const runs = useApi<Page<RunSummary>>("/simulation_runs", {
    limit: PAGE_SIZE, offset: page * PAGE_SIZE, scenario_id: scenarioId ?? undefined,
  });
  const scenarioName = (id: number) => scenarios.find((s) => s.id === id)?.name ?? `Scenario ${id}`;
  const total = runs.data?.total ?? 0;
  const first = page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="m-0">Simulation runs</h2>
        <div className="min-w-[240px]">
          <label htmlFor="history-scenario" className="mt-0">Scenario</label>
          <select id="history-scenario" value={scenarioId ?? ""}
                  onChange={(e) => { setScenarioId(e.target.value === "" ? null : Number(e.target.value)); setPage(0); }}>
            <option value="">All scenarios</option>
            {[...scenarios].sort((a, b) => a.name.localeCompare(b.name)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>
      {runs.error !== null && <ErrorState error={runs.error} onRetry={runs.reload} />}
      {runs.error === null && runs.loading && <LoadingState />}
      {runs.data && !runs.loading && (runs.data.items.length === 0 ? <EmptyState>No simulation runs{scenarioId !== null ? " for this scenario" : ""} yet.</EmptyState> : (
        <>
          <DataTable caption="Simulation runs, newest first"
            columns={["Run", "When", "Scenario", "Route finding", "People", "Outcome", "Evacuation time", "Reports and more"]}
            rows={runs.data.items.map((run) => ({
              key: run.id,
              cells: [
                run.id,
                formatDateTime(run.created_at),
                scenarioName(run.scenario_id),
                algorithmLabel(run.algorithm),
                run.summary ? `${run.summary.evacuated} of ${run.summary.total} out` : "–",
                <RunStatus key="status" run={run} />,
                run.summary?.all_evacuated ? formatSeconds(run.summary.evacuation_time_s) : "–",
                <span key="links" className="flex flex-wrap gap-2">
                  <a className="btn l" href={`/api/backend/reports/${run.id}?format=pdf`} download>PDF</a>
                  <a className="btn l" href={`/api/backend/reports/${run.id}?format=csv`} download>CSV</a>
                  {livePage && <Link className="btn l" href={`${livePage.href}?run=${run.id}`}>Watch</Link>}
                  {assistantPage && <Link className="btn l" href={`${assistantPage.href}?run=${run.id}`}>Explain</Link>}
                  <button type="button" className="btn l" aria-expanded={detailId === run.id}
                          onClick={() => setDetailId(detailId === run.id ? null : run.id)}>
                    {detailId === run.id ? "Hide details" : "Details"}
                  </button>
                </span>,
              ],
            }))} />
          <p className="flex flex-wrap items-center gap-2">
            <span className="sm">Showing {first}–{last} of {total}</span>
            <button type="button" className="btn l" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</button>
            <button type="button" className="btn l" disabled={last >= total} onClick={() => setPage((p) => p + 1)}>Older</button>
          </p>
          {detailId !== null && <RunDetails key={detailId} runId={detailId} />}
        </>
      ))}
    </Card>
  );
}

function RunDetails({ runId }: { runId: number }) {
  const detail = useApi<RunDetail>(`/simulation_runs/${runId}`);
  return (
    <section className="mt-3 border-t border-line pt-3" aria-label={`Details of run ${runId}`}>
      <h3 className="m-0 text-[14px] font-bold text-ink">Run {runId}</h3>
      {detail.error !== null && <ErrorState error={detail.error} onRetry={detail.reload} />}
      {detail.error === null && !detail.data && <LoadingState />}
      {detail.data && (
        <>
          <RunResult result={detail.data} showAlgorithm showLive={false} />
          {detail.data.summary && detail.data.summary.total > 0 && (
            <>
              <EvacuationTimeline points={detail.data.timeline} />
              <details className="mt-2">
                <summary className="cursor-pointer text-[13px]">Show the timeline as a table</summary>
                <DataTable caption={`Timeline of run ${runId}`}
                  columns={["Time (s)", "Reached an exit", "Still moving", "Need assisted evacuation", "Reached by the hazard"]}
                  rows={detail.data.timeline.map((f, i) => ({
                    key: i, cells: [f.t, f.evacuated, f.active, f.needs_assistance, f.reached_by_hazard],
                  }))} />
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

// --- Evacuation-time predictor -----------------------------------------------------------

function PredictorCard({ scenarios }: { scenarios: Scenario[] | null }) {
  const { facility, error, reload } = useFacility();
  return (
    <Card>
      <h2 className="mt-0">Estimate without simulating</h2>
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {error === null && (!facility || !scenarios) && <LoadingState />}
      {facility && scenarios && (scenarios.length === 0
        ? <EmptyState>Create a scenario first.</EmptyState>
        : <Predictor facility={facility} scenarios={scenarios} />)}
    </Card>
  );
}

function Predictor({ facility, scenarios }: { facility: Facility; scenarios: Scenario[] }) {
  const sorted = [...scenarios].sort((a, b) => a.name.localeCompare(b.name));
  const [scenarioId, setScenarioId] = useState(sorted[0]!.id);
  const [buildingChoice, setBuildingChoice] = useState<number | null>(null);
  const [algorithm, setAlgorithm] = useState("astar");
  const [answer, setAnswer] = useState<Prediction | null>(null);
  const { busy, error, run } = useAction();
  const scenario = sorted.find((s) => s.id === scenarioId) ?? sorted[0]!;
  const hazardBuilding = scenario.hazards
    .map((h) => facility.places.get(h.origin_node_id)?.building_id)
    .find((id): id is number => id !== undefined) ?? null;
  const buildingId = buildingChoice ?? hazardBuilding ?? (facility.buildings.length === 1 ? facility.buildings[0]!.id : null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (buildingId === null) return;
    setAnswer(null);
    const result = await run(() => apiRequest<Prediction>("/predict", {
      method: "POST", body: { scenario_id: scenarioId, building_id: buildingId, algorithm },
    }));
    if (result) setAnswer(result);
  }

  return (
    <>
      <form onSubmit={submit} noValidate>
        <label htmlFor="predict-scenario" className="mt-0">Scenario</label>
        <select id="predict-scenario" value={scenarioId}
                onChange={(e) => { setScenarioId(Number(e.target.value)); setBuildingChoice(null); setAnswer(null); }}>
          {sorted.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label htmlFor="predict-building">Building</label>
        <select id="predict-building" value={buildingId ?? ""} onChange={(e) => { setBuildingChoice(Number(e.target.value)); setAnswer(null); }}>
          <option value="" disabled>Choose a building</option>
          {facility.buildings.map((b) => <option key={b.id} value={b.id}>{facility.buildingLabel(b.id)}</option>)}
        </select>
        <label htmlFor="predict-algorithm">Route finding</label>
        <select id="predict-algorithm" value={algorithm} onChange={(e) => { setAlgorithm(e.target.value); setAnswer(null); }}>
          {Object.entries(ALGORITHM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <FormError error={error} />
        <p><button type="submit" className="btn" disabled={busy || buildingId === null}>{busy ? "Estimating…" : "Estimate evacuation time"}</button></p>
      </form>
      {answer && (
        <div role="status" className="border-t border-line pt-3">
          {answer.predicted_time_s === null ? (
            <p className="mt-0"><Tag tone="w">No estimate</Tag> {answer.note}</p>
          ) : (
            <>
              <p className="m-0 text-[28px] font-bold text-ink">{formatSeconds(answer.predicted_time_s)}</p>
              <p className="sm mt-0">estimated evacuation time</p>
              <p>{answer.note}</p>
            </>
          )}
          <details className="mt-2" open={answer.predicted_time_s !== null}>
            <summary className="cursor-pointer font-semibold text-ink">About this prediction</summary>
            <p className="sm">{answer.method}</p>
            {answer.about && (
              <dl className="sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>Model</dt><dd className="m-0">{answer.about.model}</dd>
                <dt>Trained</dt><dd className="m-0">{formatDateTime(answer.about.trained_at)}</dd>
                <dt>Runs used to train</dt><dd className="m-0">{answer.about.training_runs}</dd>
                <dt>Runs held out to test</dt><dd className="m-0">{answer.about.test_runs}</dd>
                <dt>Typical error on test runs</dt><dd className="m-0">{answer.mae !== null ? `${answer.mae.toFixed(1)} s` : "–"}</dd>
                <dt>Error of always guessing the average</dt><dd className="m-0">{answer.about.baseline_mae_s.toFixed(1)} s</dd>
                <dt>R² on test runs</dt><dd className="m-0">{answer.r2 !== null ? answer.r2.toFixed(3) : "not available"}</dd>
                <dt>Inputs</dt><dd className="m-0">{answer.about.features.join(", ")}</dd>
              </dl>
            )}
          </details>
        </div>
      )}
    </>
  );
}

// --- Alerts ------------------------------------------------------------------------------

function AlertsCard() {
  const alerts = useApi<Alerts>("/alerts");
  return (
    <Card>
      <h2 className="mt-0">Alerts</h2>
      {alerts.error !== null && <ErrorState error={alerts.error} onRetry={alerts.reload} />}
      {alerts.error === null && !alerts.data && <LoadingState />}
      {alerts.data && (
        <>
          {alerts.data.message && <p><Tag tone="w">Needs data</Tag> {alerts.data.message}</p>}
          {alerts.data.alerts.length === 0 ? (!alerts.data.message && <EmptyState>No alerts.</EmptyState>) : (
            <ul className="m-0 list-none p-0">
              {alerts.data.alerts.map((alert, index) => (
                <li key={`${alert.run_id}-${index}`} className="mb-2">
                  <Tag tone={ALERT_TAGS[alert.kind].tone}>{ALERT_TAGS[alert.kind].label}</Tag>{" "}
                  Run {alert.run_id}: {alert.reason}
                </li>
              ))}
            </ul>
          )}
          <details className="sm mt-2">
            <summary className="cursor-pointer">How alerts work</summary>
            <p>{alerts.data.method} Runs considered: {alerts.data.runs_considered}.</p>
          </details>
        </>
      )}
    </Card>
  );
}
