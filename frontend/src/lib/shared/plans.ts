// Evacuation plans: labels and the status changes the Reports page offers.
// Plain functions only, so they can be unit tested without a browser.

import type { TagTone } from "../../components/ui.tsx";

export type PlanStatus = "draft" | "approved" | "archived";

export const PLAN_STATUSES: readonly PlanStatus[] = ["draft", "approved", "archived"];

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  archived: "Archived",
};

export const PLAN_STATUS_TONES: Record<PlanStatus, TagTone> = {
  draft: "w",
  approved: "ok",
  archived: "b",
};

export type PlanAction = { to: PlanStatus; label: string };

/** The status changes offered for a plan, in the order the buttons appear. */
export function planActions(status: PlanStatus): PlanAction[] {
  switch (status) {
    case "draft":
      return [{ to: "approved", label: "Approve" }, { to: "archived", label: "Archive" }];
    case "approved":
      return [{ to: "archived", label: "Archive" }, { to: "draft", label: "Back to draft" }];
    case "archived":
      return [{ to: "draft", label: "Back to draft" }];
  }
}

export type PlanInstructionLike = {
  start: string;
  kind: string | null;
  mobility: string | null;
  people: number;
  route: string[];
  exit: string | null;
  needs_assistance: boolean;
};

const MOBILITY_WORDS: Record<string, string> = {
  ambulatory: "walking",
  wheelchair: "wheelchair",
  stretcher: "stretcher",
  ventilator: "ventilator",
};

/** "3 walking staff", "1 stretcher patient". */
export function whoLabel(item: Pick<PlanInstructionLike, "kind" | "mobility" | "people">): string {
  const kind = item.kind === "patient" ? "patient" : item.kind === "staff" ? "staff" : "person";
  const plural = item.people === 1 ? kind : kind === "staff" ? "staff" : kind === "person" ? "people" : `${kind}s`;
  const word = MOBILITY_WORDS[item.mobility ?? ""];
  const mobility = word ? `${word} ` : "";
  return `${item.people} ${mobility}${plural}`;
}

/** The instruction staff read: route by place names, or the assisted-evacuation note. */
export function routeText(item: Pick<PlanInstructionLike, "route" | "needs_assistance">): string {
  if (item.needs_assistance || item.route.length === 0) {
    return "No safe route found: needs assisted evacuation (staff help or rescue team).";
  }
  return item.route.join(" → ");
}

/** A name for a new plan, from the scenario and run (the user can change it). */
export function suggestedPlanName(scenarioName: string, runId: number): string {
  const base = scenarioName.trim() || "Scenario";
  return `${base} – plan from run ${runId}`.slice(0, 200);
}
