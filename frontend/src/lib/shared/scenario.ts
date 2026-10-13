// Scenario Builder rules: hazard drafts in the form, and the request body the
// API expects (backend/app/scenario_api.py). Limits mirror the backend, which
// validates again.

import type { Hazard, HazardType } from "./api-types.ts";
import { hazardName, parseNumber } from "./graph.ts";

export const HAZARD_TYPES: readonly HazardType[] = ["fire", "smoke", "hazmat", "structural"];
export const MAX_HAZARDS = 50;
export const MAX_SPREAD = 1000;
export const SEVERITY_LABELS: Record<number, string> = {
  1: "minor", 2: "moderate", 3: "serious", 4: "severe", 5: "extreme",
};

/** A place a hazard can start at, with where it is. */
export type PlaceRef = { id: number; name: string; type: string; floor_id: number; building_id: number };

export type HazardDraft = {
  key: string;               // React key only
  type: HazardType;
  buildingId: number | null;
  floorId: number | null;
  originId: number | null;
  severity: number;          // 1-5
  spread: string;            // metres per minute, as typed
  name: string;
  nameEdited: boolean;       // false: the name follows type and place
  active: boolean;
  lostPlace: boolean;        // a saved hazard whose place was deleted since
};

export type HazardBody = {
  name: string;
  type: HazardType;
  origin_node_id: number;
  spread_rate: number;
  severity: number;
  is_active: boolean;
};

let counter = 0;
const nextKey = () => `h${++counter}`;

export function newDraft(defaults: { buildingId?: number | null; floorId?: number | null } = {}): HazardDraft {
  return {
    key: nextKey(), type: "fire", buildingId: defaults.buildingId ?? null, floorId: defaults.floorId ?? null,
    originId: null, severity: 3, spread: "0", name: "", nameEdited: false, active: true, lostPlace: false,
  };
}

/** A saved hazard as a draft. If its place no longer exists, the place must be chosen again. */
export function draftFromHazard(hazard: Hazard, places: Map<number, PlaceRef>): HazardDraft {
  const place = places.get(hazard.origin_node_id);
  const suggested = place ? hazardName(hazard.type, place.name) : "";
  return {
    key: nextKey(), type: hazard.type,
    buildingId: place?.building_id ?? null, floorId: place?.floor_id ?? null, originId: place ? place.id : null,
    severity: hazard.severity, spread: String(hazard.spread_rate), name: hazard.name,
    nameEdited: hazard.name !== suggested, active: hazard.is_active, lostPlace: !place,
  };
}

/** Apply a change; the suggested name follows type and place until the user edits the name. */
export function updateDraft(draft: HazardDraft, change: Partial<HazardDraft>, places: Map<number, PlaceRef>): HazardDraft {
  const next = { ...draft, ...change };
  if (change.originId != null) next.lostPlace = false;
  if (change.name !== undefined) next.nameEdited = change.name.trim() !== "";
  if (!next.nameEdited) {
    const place = next.originId !== null ? places.get(next.originId) : undefined;
    next.name = place ? hazardName(next.type, place.name) : "";
  }
  return next;
}

export type DraftProblems = { origin?: string; spread?: string; name?: string };

export function draftProblems(draft: HazardDraft, places: Map<number, PlaceRef>): DraftProblems {
  const problems: DraftProblems = {};
  if (draft.originId === null || !places.has(draft.originId)) problems.origin = "Choose the place where it starts.";
  const spread = parseNumber(draft.spread, 0, MAX_SPREAD);
  if (spread === null || Number.isNaN(spread)) problems.spread = `Enter a number from 0 to ${MAX_SPREAD}.`;
  if (draft.name.trim() === "") problems.name = "Enter a name.";
  else if (draft.name.trim().length > 200) problems.name = "Use at most 200 characters.";
  return problems;
}

export function draftsValid(drafts: HazardDraft[], places: Map<number, PlaceRef>): boolean {
  return drafts.length <= MAX_HAZARDS && drafts.every((d) => Object.keys(draftProblems(d, places)).length === 0);
}

/** The `hazards` list for POST /scenarios or PATCH /scenarios/{id} (PATCH replaces the list). */
export function hazardBodies(drafts: HazardDraft[]): HazardBody[] {
  return drafts.map((draft) => {
    if (draft.originId === null) throw new Error("A hazard has no place");
    return {
      name: draft.name.trim(), type: draft.type, origin_node_id: draft.originId,
      spread_rate: Number(draft.spread), severity: draft.severity, is_active: draft.active,
    };
  });
}

/** The building a run should simulate by default: the first hazard's building. */
export function defaultRunBuilding(drafts: { buildingId: number | null }[]): number | null {
  return drafts.find((draft) => draft.buildingId !== null)?.buildingId ?? null;
}

/** "Fire at C1 (severity 3)" lines for the scenario list. */
export function hazardSummary(hazards: Hazard[]): string {
  if (hazards.length === 0) return "No hazard (evacuation drill)";
  return hazards.map((h) => `${h.name} (severity ${h.severity}${h.is_active ? "" : ", off"})`).join("; ");
}
