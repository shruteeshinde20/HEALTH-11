"use client";

import Link from "next/link";

import { ALERT_TAGS, RunStatus } from "@/components/run-status.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Stat, Tag } from "@/components/ui.tsx";
import { useUser } from "@/lib/client/session.tsx";
import { useApi } from "@/lib/client/use-api.ts";
import type { Alerts, Dashboard, Page, RunSummary, ScenarioName } from "@/lib/shared/api-types.ts";
import { algorithmLabel, formatSeconds } from "@/lib/shared/format.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";

const RECENT_RUNS = 5;
const scenarioBuilder = APP_PAGES.find((page) => page.href === "/scenarios");
const reportsPage = APP_PAGES.find((page) => page.href === "/reports");

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

export default function DashboardPage() {
  const user = useUser();
  const dashboard = useApi<Dashboard>("/dashboard");
  const runs = useApi<Page<RunSummary>>("/simulation_runs", { limit: RECENT_RUNS });
  const scenarios = useApi<Page<ScenarioName>>("/scenarios", { limit: 200 });
  const alerts = useApi<Alerts>("/alerts");

  const scenarioName = (id: number) =>
    scenarios.data?.items.find((scenario) => scenario.id === id)?.name ?? `Scenario ${id}`;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Where your hospital stands right now." />

      {dashboard.data && !dashboard.data.last_run && (
        <Card className="mb-[14px]">
          <h2>Get started</h2>
          {user.role === "Staff User"
            ? <p className="m-0">Your organization has not finished setting up yet. An Administrator or Emergency Commander can do this.</p>
            : (
              <p className="m-0">
                {dashboard.data.hospitals === 0 ? "Set up your first hospital in four steps." : "Finish setting up your hospital."}{" "}
                <Link className="btn ml-2" href="/onboarding">
                  {dashboard.data.hospitals === 0 ? "Start" : "Continue"}
                </Link>
              </p>
            )}
        </Card>
      )}

      {dashboard.loading && <LoadingState />}
      {dashboard.error !== null && <ErrorState error={dashboard.error} onRetry={dashboard.reload} />}
      {dashboard.data && !dashboard.loading && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-[14px]">
            <Stat value={dashboard.data.hospitals} label={plural(dashboard.data.hospitals, "Hospital", "Hospitals")} />
            <Stat value={dashboard.data.scenarios}
                  label={plural(dashboard.data.scenarios, "Active scenario", "Active scenarios")} />
            <Stat value={formatSeconds(dashboard.data.last_evacuation_time_s)} label="Last evacuation time" />
            <Stat value={dashboard.data.bottlenecks.length}
                  label={plural(dashboard.data.bottlenecks.length, "Bottleneck found", "Bottlenecks found")} />
          </div>
          {dashboard.data.last_run && dashboard.data.note && <p className="sm mt-2">{dashboard.data.note}</p>}
        </>
      )}

      <div className="mt-[14px] grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-[14px]">
        <Card>
          <h2>Recent simulations</h2>
          {runs.loading && <LoadingState />}
          {runs.error !== null && <ErrorState error={runs.error} onRetry={runs.reload} />}
          {runs.data && !runs.loading && (runs.data.items.length === 0
            ? <EmptyState>No simulations have been run yet.</EmptyState>
            : (
              <DataTable
                caption="Recent simulations"
                columns={["Scenario", "Algorithm", "Time", "Status"]}
                rows={runs.data.items.map((run) => ({
                  key: run.id,
                  cells: [
                    scenarioName(run.scenario_id),
                    algorithmLabel(run.algorithm),
                    run.summary?.all_evacuated ? formatSeconds(run.summary.evacuation_time_s) : "–",
                    <RunStatus key="status" run={run} />,
                  ],
                }))}
              />
            ))}
          <p className="flex flex-wrap gap-2">
            {scenarioBuilder?.ready && <Link className="btn" href={scenarioBuilder.href}>Run new simulation</Link>}
            {reportsPage?.ready && <Link className="btn l" href={reportsPage.href}>All runs and reports</Link>}
          </p>
        </Card>

        <Card>
          <h2>Alerts</h2>
          {alerts.loading && <LoadingState />}
          {alerts.error !== null && <ErrorState error={alerts.error} onRetry={alerts.reload} />}
          {alerts.data && !alerts.loading && (
            <>
              {alerts.data.message && (
                <p>
                  <Tag tone="w">Needs data</Tag> {alerts.data.message}
                </p>
              )}
              {alerts.data.alerts.length === 0
                ? !alerts.data.message && <EmptyState>No alerts.</EmptyState>
                : (
                  <ul className="m-0 list-none p-0">
                    {alerts.data.alerts.slice(0, 8).map((alert, index) => (
                      <li key={`${alert.run_id}-${index}`} className="mb-2">
                        <Tag tone={ALERT_TAGS[alert.kind].tone}>{ALERT_TAGS[alert.kind].label}</Tag>{" "}
                        Run {alert.run_id}: {alert.reason}
                      </li>
                    ))}
                  </ul>
                )}
              <details className="sm mt-2">
                <summary>How alerts work</summary>
                <p>{alerts.data.method}</p>
              </details>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
