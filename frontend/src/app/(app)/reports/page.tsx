"use client";

// Reports & History: every saved simulation run with its PDF and CSV reports,
// evacuation plans saved from runs (PROJECT.md data model, evacuation_plans),
// the evacuation-time predictor with "About this prediction" (PROJECT.md AI
// feature 1) and the full list of alerts (AI feature 5). Everything comes
// from the API; missing data is said plainly, never filled in.

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { EvacuationTimeline } from "@/components/charts.tsx";
import { Dialog } from "@/components/dialog.tsx";
import { DeleteConfirm, Field, FormError } from "@/components/facility-forms.tsx";
import { RunResult } from "@/components/run-result.tsx";
import { ALERT_TAGS, RunStatus } from "@/components/run-status.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import { useFacility, type Facility } from "@/lib/client/use-facility.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import type {
  Alerts, EvacuationPlan, EvacuationPlanSummary, Page, Prediction, RunDetail, RunSummary, Scenario,
} from "@/lib/shared/api-types.ts";
import { ALGORITHM_LABELS, algorithmLabel, formatDateTime, formatSeconds } from "@/lib/shared/format.ts";
import { pageFor } from "@/lib/shared/pages.ts";
import {
  PLAN_STATUSES, PLAN_STATUS_LABELS, PLAN_STATUS_TONES, planActions, routeText, suggestedPlanName, whoLabel,
  type PlanStatus,
} from "@/lib/shared/plans.ts";

const PAGE_SIZE = 20;

export default function ReportsPage() {
  const user = useUser();
  const scenarios = useAll<Scenario>("/scenarios");
  // Bumped when a plan is saved from a run, so the plans list loads again.
  const [plansVersion, setPlansVersion] = useState(0);
  return (
    <>
      <PageHeader title="Reports & History" subtitle="Every run is saved and can be downloaded." />
      <History scenarios={scenarios.data ?? []} onPlanSaved={() => setPlansVersion((n) => n + 1)} />
      <PlansCard key={plansVersion} />
      <div className="mt-[14px] grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-[14px]">
        {user.role !== "Staff User" && <PredictorCard scenarios={scenarios.data} />}
        <AlertsCard />
      </div>
    </>
  );
}

// --- Run history -------------------------------------------------------------------------

function History({ scenarios, onPlanSaved }: { scenarios: Scenario[]; onPlanSaved: () => void }) {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const [saving, setSaving] = useState<RunSummary | null>(null);
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
                  {canEdit && run.status === "completed" && (
                    <button type="button" className="btn l" onClick={() => setSaving(run)}>Save as plan</button>
                  )}
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
      <Dialog open={saving !== null} title="Save as evacuation plan" onClose={() => setSaving(null)}>
        {saving && (
          <SavePlan run={saving} scenarioName={scenarioName(saving.scenario_id)}
                    onSaved={() => { setSaving(null); onPlanSaved(); }} onCancel={() => setSaving(null)} />
        )}
      </Dialog>
    </Card>
  );
}

function SavePlan({ run, scenarioName, onSaved, onCancel }: {
  run: RunSummary; scenarioName: string; onSaved: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(() => suggestedPlanName(scenarioName, run.id));
  const { busy, error, run: act } = useAction();
  const errors = fieldErrors(error);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await act(() => apiRequest<EvacuationPlan>("/evacuation_plans", {
      method: "POST", body: { run_id: run.id, name: name.trim() },
    }));
    if (saved) onSaved();
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="mt-0">
        The plan keeps a copy of run {run.id}: who starts where, the route to take by place names, the exit,
        who needs assisted evacuation, and the run&apos;s bottlenecks and recommendations. Later changes to the run
        or the floor plan do not change the saved plan. It starts as a draft.
      </p>
      <Field id="plan-name" label="Plan name" error={errors.name}>
        <input id="plan-name" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <FormError error={error} />
      <p className="flex flex-wrap gap-2">
        <button type="submit" className="btn" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save plan"}</button>
        <button type="button" className="btn l" onClick={onCancel}>Cancel</button>
      </p>
    </form>
  );
}

// --- Evacuation plans --------------------------------------------------------------------

function PlansCard() {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<EvacuationPlanSummary | null>(null);
  const plans = useApi<Page<EvacuationPlanSummary>>("/evacuation_plans", {
    limit: PAGE_SIZE, offset: page * PAGE_SIZE, status: status ?? undefined,
  });
  const { busy, error, run } = useAction();
  const total = plans.data?.total ?? 0;
  const first = page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);

  async function change(plan: EvacuationPlanSummary, to: PlanStatus) {
    const done = await run(() => apiRequest<EvacuationPlan>(`/evacuation_plans/${plan.id}`, {
      method: "PATCH", body: { status: to },
    }));
    if (done) plans.reload();
  }

  return (
    <Card className="mt-[14px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="m-0">Evacuation plans</h2>
        <div className="min-w-[200px]">
          <label htmlFor="plans-status" className="mt-0">Status</label>
          <select id="plans-status" value={status ?? ""}
                  onChange={(e) => { setStatus(e.target.value === "" ? null : (e.target.value as PlanStatus)); setPage(0); }}>
            <option value="">All plans</option>
            {PLAN_STATUSES.map((s) => <option key={s} value={s}>{PLAN_STATUS_LABELS[s]}</option>)}
          </select>
        </div>
      </div>
      <p className="sm">
        A plan is saved from a simulation run (“Save as plan” above) and keeps that run&apos;s routes for staff to act on.
        Emergency Commanders and Administrators approve or archive plans; every change is in the audit log.
      </p>
      <FormError error={error} />
      {plans.error !== null && <ErrorState error={plans.error} onRetry={plans.reload} />}
      {plans.error === null && plans.loading && <LoadingState />}
      {plans.data && !plans.loading && (plans.data.items.length === 0 ? (
        <EmptyState>
          No evacuation plans{status !== null ? ` with status “${PLAN_STATUS_LABELS[status]}”` : ""} yet.
          {canEdit && status === null && " Run a scenario, then choose “Save as plan” on that run."}
        </EmptyState>
      ) : (
        <>
          <DataTable caption="Evacuation plans, newest first"
            columns={["Plan", "Scenario", "Status", "People out", "Need assisted evacuation", "Evacuation time", "Approved", "Actions"]}
            rows={plans.data.items.map((plan) => ({
              key: plan.id,
              cells: [
                plan.name,
                plan.scenario_name ?? `Scenario ${plan.scenario_id}`,
                <Tag key="status" tone={PLAN_STATUS_TONES[plan.status]}>{PLAN_STATUS_LABELS[plan.status]}</Tag>,
                plan.total === null ? "–" : `${plan.evacuated ?? 0} of ${plan.total}`,
                plan.needs_assistance ?? "–",
                plan.total !== null && plan.evacuated === plan.total ? formatSeconds(plan.evacuation_time_s) : "–",
                plan.approved_by ? `${plan.approved_by}, ${formatDateTime(plan.approved_at)}` : "–",
                <span key="actions" className="flex flex-wrap gap-2">
                  <button type="button" className="btn l" aria-expanded={openId === plan.id}
                          onClick={() => setOpenId(openId === plan.id ? null : plan.id)}>
                    {openId === plan.id ? "Close" : "Open"}
                  </button>
                  {canEdit && planActions(plan.status).map((action) => (
                    <button key={action.to} type="button" className="btn l" disabled={busy}
                            onClick={() => void change(plan, action.to)}>{action.label}</button>
                  ))}
                  {canEdit && <button type="button" className="btn l" onClick={() => setDeleting(plan)}>Delete</button>}
                </span>,
              ],
            }))} />
          <p className="flex flex-wrap items-center gap-2">
            <span className="sm">Showing {first}–{last} of {total}</span>
            <button type="button" className="btn l" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</button>
            <button type="button" className="btn l" disabled={last >= total} onClick={() => setPage((p) => p + 1)}>Older</button>
          </p>
          {openId !== null && <PlanDetails key={`${openId}-${plans.data.items.find((p) => p.id === openId)?.updated_at}`} planId={openId} />}
        </>
      ))}
      <Dialog open={deleting !== null} title="Delete evacuation plan" onClose={() => setDeleting(null)}>
        {deleting && (
          <DeleteConfirm what={`the plan “${deleting.name}”`} path={`/evacuation_plans/${deleting.id}`}
                         onDeleted={() => { if (openId === deleting.id) setOpenId(null); setDeleting(null); plans.reload(); }}
                         onCancel={() => setDeleting(null)} />
        )}
      </Dialog>
    </Card>
  );
}

function PlanDetails({ planId }: { planId: number }) {
  const plan = useApi<EvacuationPlan>(`/evacuation_plans/${planId}`);
  const data = plan.data;
  return (
    <section className="mt-3 border-t border-line pt-3" aria-label={`Evacuation plan ${planId}`}>
      {plan.error !== null && <ErrorState error={plan.error} onRetry={plan.reload} />}
      {plan.error === null && !data && <LoadingState />}
      {data && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="m-0 text-[16px] font-bold text-ink">{data.name}</h3>
              <p className="sm m-0">
                <Tag tone={PLAN_STATUS_TONES[data.status]}>{PLAN_STATUS_LABELS[data.status]}</Tag>{" "}
                Scenario: {data.scenario_name ?? `Scenario ${data.scenario_id}`} · From run {data.source_run_id ?? "–"}
                {" "}({data.algorithm ? algorithmLabel(data.algorithm) : "–"}, {formatDateTime(data.run_created_at)})
                {data.approved_by && <> · Approved by {data.approved_by}, {formatDateTime(data.approved_at)}</>}
              </p>
            </div>
            <button type="button" className="btn l" onClick={() => window.print()}>Print</button>
          </div>

          <h4 className="mb-1 text-[14px] font-bold text-ink">Hazards</h4>
          {data.hazards.length === 0 ? <p className="sm m-0">None: a calm evacuation (drill).</p> : (
            <ul className="m-0 pl-5 text-[13px]">
              {data.hazards.map((h, i) => (
                <li key={i}>{h.name}: {h.type} at {h.origin ?? "an unknown place"}, severity {h.severity}
                  {h.starts_at_s > 0 ? `, from ${formatSeconds(h.starts_at_s)}` : ""}</li>
              ))}
            </ul>
          )}

          <h4 className="mb-1 text-[14px] font-bold text-ink">Who goes where</h4>
          {data.instructions.length === 0 ? <EmptyState>Nobody was placed in the building in this run.</EmptyState> : (
            <DataTable caption={`Instructions of plan ${data.name}`}
              columns={["From", "Who", "Route", "Exit", "Last one out"]}
              rows={data.instructions.map((item, i) => ({
                key: i,
                cells: [
                  item.start,
                  whoLabel(item),
                  item.needs_assistance ? <span key="r"><Tag tone="b">Assisted</Tag> {routeText(item)}</span> : routeText(item),
                  item.exit ?? "–",
                  formatSeconds(item.last_out_s),
                ],
              }))} />
          )}

          <h4 className="mb-1 text-[14px] font-bold text-ink">People per exit</h4>
          {Object.keys(data.exit_load).length === 0 ? <p className="sm m-0">Nobody reached an exit.</p> : (
            <p className="m-0 text-[13px]">
              {Object.entries(data.exit_load).map(([exit, count]) => `${exit}: ${count}`).join(" · ")}
            </p>
          )}

          <h4 className="mb-1 text-[14px] font-bold text-ink">Bottlenecks</h4>
          {data.bottlenecks.length === 0 ? <p className="sm m-0">None found in this run.</p> : (
            <ul className="m-0 pl-5 text-[13px]">
              {data.bottlenecks.map((b) => <li key={b.edge_id}>{b.label}: {b.reasons.join(", ")}</li>)}
            </ul>
          )}

          <h4 className="mb-1 text-[14px] font-bold text-ink">Recommendations</h4>
          {data.recommendations.length === 0 ? <p className="sm m-0">None.</p> : (
            <ul className="m-0 pl-5 text-[13px]">
              {data.recommendations.map((r, i) => <li key={i}><strong>{r.severity}:</strong> {r.text}</li>)}
            </ul>
          )}
          <p className="sm">
            Calculated by the HEALTH-11 simulator from this organization&apos;s data and parameters. It supports planning
            and training and does not replace the hospital&apos;s official emergency procedures.
          </p>
        </>
      )}
    </section>
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
