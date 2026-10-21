"use client";

// AI Assistant (PROJECT.md AI feature 4): describe an emergency in your own
// words and get a draft scenario that uses only the places of the chosen
// floor, or a question when something is unclear. Nothing is saved or run
// until you press "Run it". It also explains a saved run in plain language,
// from that run's stored results only. Everything comes from the API.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { Field, FormError } from "@/components/facility-forms.tsx";
import { RunResult } from "@/components/run-result.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAction } from "@/lib/client/use-action.ts";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import { useFacility, type Facility } from "@/lib/client/use-facility.ts";
import type {
  AssistantDraft, AssistantSummary, Page, RunDetail, RunSummary, Scenario,
} from "@/lib/shared/api-types.ts";
import { ALGORITHM_LABELS, algorithmLabel, formatDateTime } from "@/lib/shared/format.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";
import { SEVERITY_LABELS } from "@/lib/shared/scenario.ts";

const MAX_TEXT = 2000;      // backend/app/services/assistant.py MAX_TEXT_LENGTH
const scenarioBuilder = APP_PAGES.find((page) => page.href === "/scenarios");

function Assistant() {
  const user = useUser();
  const canDraft = user.role !== "Staff User";
  const params = useSearchParams();
  const { facility, error, reload } = useFacility();

  return (
    <>
      <PageHeader title="AI Assistant" subtitle="Describe the emergency in your own words." />
      {canDraft ? (
        <>
          {error !== null && <ErrorState error={error} onRetry={reload} />}
          {error === null && !facility && <LoadingState />}
          {facility && <DraftScenario facility={facility} />}
        </>
      ) : (
        <Card><EmptyState>Drafting scenarios is for Administrators and Emergency Commanders. You can still have a run explained below.</EmptyState></Card>
      )}
      <ExplainRun initialRun={Number(params.get("run")) || null} />
    </>
  );
}

// --- Draft a scenario from text ----------------------------------------------------------

function DraftScenario({ facility }: { facility: Facility }) {
  const floors = facility.buildings.flatMap((b) => facility.floorsOf(b.id).map((f) => ({
    id: f.id, building_id: b.id, label: `${facility.buildingLabel(b.id)} / ${f.name}`,
  })));
  const [floorId, setFloorId] = useState<number | null>(floors[0]?.id ?? null);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<AssistantDraft | null>(null);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);
  const tooShort = text.trim().length < 3;

  if (floors.length === 0) {
    return <Card><EmptyState>Add a floor with places first, in the <Link href="/facilities">Facility Manager</Link>.</EmptyState></Card>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (floorId === null || tooShort) return;
    setDraft(null);
    const answer = await run(() => apiRequest<AssistantDraft>("/assistant", {
      method: "POST", body: { text: text.trim(), floor_id: floorId },
    }));
    if (answer) setDraft(answer);
  }

  const floor = floors.find((f) => f.id === floorId);
  return (
    <Card className="mb-[14px]">
      <h2 className="mt-0">Describe an emergency</h2>
      <form onSubmit={submit} noValidate>
        <Field id="assistant-floor" label="Floor" hint="The assistant only sees the place names of this floor." error={fields.floor_id}>
          <select id="assistant-floor" value={floorId ?? ""} aria-describedby="assistant-floor-hint"
                  onChange={(e) => { setFloorId(Number(e.target.value)); setDraft(null); }}>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field id="assistant-text" label="What is happening?"
               hint={`For example: “Fire in WardA spreading 2 metres a minute, severity 4.” Do not include patient names. ${text.length}/${MAX_TEXT}`}
               error={fields.text}>
          <textarea id="assistant-text" rows={4} maxLength={MAX_TEXT} value={text} aria-describedby="assistant-text-hint"
                    onChange={(e) => setText(e.target.value)} />
        </Field>
        <FormError error={error} />
        <p>
          <button type="submit" className="btn" disabled={busy || tooShort}>{busy ? "Thinking…" : "Draft scenario"}</button>
        </p>
      </form>
      {draft && floor && <DraftResult key={JSON.stringify(draft)} draft={draft} buildingId={floor.building_id} />}
    </Card>
  );
}

function AboutAssistant({ method, notice }: { method: string; notice: string | null }) {
  return (
    <>
      {notice && <p className="note">{notice}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold text-ink">How this works</summary>
        <p className="sm">{method}</p>
      </details>
    </>
  );
}

function DraftResult({ draft, buildingId }: { draft: AssistantDraft; buildingId: number }) {
  const [name, setName] = useState(draft.scenario?.name ?? "");
  const [algorithm, setAlgorithm] = useState("astar");
  const [result, setResult] = useState<RunDetail | null>(null);
  const [savedOnly, setSavedOnly] = useState<Scenario | null>(null);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  if (draft.clarification !== undefined) {
    return (
      <div role="status" className="border-t border-line pt-3">
        <p><Tag tone="w">Question</Tag> {draft.clarification}</p>
        {draft.unknown_names.length > 0 && <p className="sm">Not found on this floor: {draft.unknown_names.join(", ")}</p>}
        <p className="sm">Answer by changing your text above and drafting again.</p>
        <AboutAssistant method={draft.method} notice={draft.data_notice} />
      </div>
    );
  }
  const scenario = draft.scenario;

  async function save(andRun: boolean) {
    if (!name.trim()) return;
    const body = {
      name: name.trim(), description: scenario.description,
      hazards: scenario.hazards.map((h) => ({
        name: h.name, type: h.type, origin_node_id: h.origin_node_id, severity: h.severity, spread_rate: h.spread_rate,
      })),
    };
    const outcome = await run(async () => {
      const created = await apiRequest<Scenario>("/scenarios", { method: "POST", body });
      if (!andRun) return { created, detail: null };
      const { run_id } = await apiRequest<{ run_id: number }>("/simulate", {
        method: "POST", body: { scenario_id: created.id, algorithm, building_id: buildingId },
      });
      return { created, detail: await apiRequest<RunDetail>(`/simulation_runs/${run_id}`) };
    });
    if (!outcome) return;
    if (outcome.detail) setResult(outcome.detail);
    else setSavedOnly(outcome.created);
  }

  if (result) {
    return (
      <div className="border-t border-line pt-3">
        <h3 className="m-0 text-[14px] font-bold text-ink">Result</h3>
        <RunResult result={result} showAlgorithm />
      </div>
    );
  }
  if (savedOnly) {
    return (
      <p role="status" className="border-t border-line pt-3">
        <Tag tone="ok">Saved</Tag> “{savedOnly.name}” is saved and was not run.{" "}
        {scenarioBuilder?.ready && <Link href={`${scenarioBuilder.href}?edit=${savedOnly.id}`}>Open it in the Scenario Builder</Link>}
      </p>
    );
  }

  return (
    <div className="border-t border-line pt-3">
      <p className="mt-0"><Tag tone="p">Draft</Tag> {draft.note}</p>
      <DataTable caption="Drafted hazards" columns={["Hazard", "Type", "Place", "Severity", "Spread (m/min)"]}
        rows={scenario.hazards.map((h, i) => ({
          key: i,
          cells: [h.name, h.type, h.origin_node_name, `${h.severity} (${SEVERITY_LABELS[h.severity] ?? ""})`, h.spread_rate],
        }))} />
      {scenario.description && <p className="sm">{scenario.description}</p>}
      <Field id="draft-name" label="Scenario name" hint="Scenario names must be unique; change it if it is taken." error={fields.name}>
        <input id="draft-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} aria-describedby="draft-name-hint" />
      </Field>
      <label htmlFor="draft-algorithm">Route finding</label>
      <select id="draft-algorithm" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
        {Object.entries(ALGORITHM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <FormError error={error} />
      <p className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void save(true)}>
          {busy ? "Working…" : "Run it"}
        </button>
        <button type="button" className="btn l" disabled={busy || !name.trim()} onClick={() => void save(false)}>
          Save without running
        </button>
      </p>
      <AboutAssistant method={draft.method} notice={draft.data_notice} />
    </div>
  );
}

// --- Explain a saved run -----------------------------------------------------------------

function ExplainRun({ initialRun }: { initialRun: number | null }) {
  const runs = useApi<Page<RunSummary>>("/simulation_runs", { limit: 50 });
  const scenarios = useAll<Scenario>("/scenarios");
  const [chosen, setChosen] = useState<number | null>(initialRun);
  const [summary, setSummary] = useState<AssistantSummary | null>(null);
  const { busy, error, run } = useAction();
  const runId = chosen ?? runs.data?.items[0]?.id ?? null;
  const scenarioName = (id: number) => scenarios.data?.find((s) => s.id === id)?.name ?? `Scenario ${id}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (runId === null) return;
    setSummary(null);
    const answer = await run(() => apiRequest<AssistantSummary>("/assistant/summary", { method: "POST", body: { run_id: runId } }));
    if (answer) setSummary(answer);
  }

  return (
    <Card>
      <h2 className="mt-0">Explain a run</h2>
      {runs.error !== null && <ErrorState error={runs.error} onRetry={runs.reload} />}
      {runs.error === null && !runs.data && <LoadingState />}
      {runs.data && runs.data.items.length === 0 && !initialRun && <EmptyState>No simulation has been run yet.</EmptyState>}
      {runs.data && runId !== null && (
        <form onSubmit={submit} noValidate>
          <label htmlFor="explain-run">Simulation run</label>
          <select id="explain-run" value={runId} onChange={(e) => { setChosen(Number(e.target.value)); setSummary(null); }}>
            {!runs.data.items.some((r) => r.id === runId) && <option value={runId}>Run {runId}</option>}
            {runs.data.items.map((r) => (
              <option key={r.id} value={r.id}>
                Run {r.id} · {scenarioName(r.scenario_id)} · {algorithmLabel(r.algorithm)} · {formatDateTime(r.created_at)}
              </option>
            ))}
          </select>
          <FormError error={error} />
          <p><button type="submit" className="btn" disabled={busy}>{busy ? "Writing…" : "Explain this run"}</button></p>
        </form>
      )}
      {summary && (
        <div role="status" className="border-t border-line pt-3">
          <p className="mt-0">
            {summary.source === "ai" ? <Tag tone="p">AI-written</Tag> : <Tag tone="w">Standard summary</Tag>}{" "}
            <span className="sm">{summary.note}</span>
          </p>
          {summary.summary.split(/\n{2,}/).map((paragraph, i) => <p key={i}>{paragraph}</p>)}
          <AboutAssistant method={summary.method} notice={summary.data_notice} />
        </div>
      )}
    </Card>
  );
}

export default function AssistantPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Assistant />
    </Suspense>
  );
}
