// The outcome of a saved run as a short tag (Dashboard, Reports & History).

import type { RunSummary } from "@/lib/shared/api-types.ts";

import { Tag } from "./ui.tsx";

export function RunStatus({ run }: { run: RunSummary }) {
  if (run.status !== "completed" || !run.summary) return <Tag tone="p">{run.status}</Tag>;
  if (run.summary.total === 0) return <Tag tone="p">Nobody placed</Tag>;
  return run.summary.all_evacuated ? <Tag tone="ok">Done</Tag> : <Tag tone="b">Not everyone out</Tag>;
}

export const ALERT_TAGS = {
  anomaly: { tone: "p", label: "Unusual run" },
  safety: { tone: "b", label: "Safety" },
  bottleneck: { tone: "w", label: "Bottleneck" },
} as const;
