import { test } from "node:test";
import assert from "node:assert/strict";

import type { Hazard } from "../../src/lib/shared/api-types.ts";
import {
  MAX_HAZARDS, defaultRunBuilding, draftFromHazard, draftProblems, draftsValid, hazardBodies, hazardSummary,
  newDraft, updateDraft, type PlaceRef,
} from "../../src/lib/shared/scenario.ts";

const places = new Map<number, PlaceRef>([
  [11, { id: 11, name: "C1", type: "corridor", floor_id: 2, building_id: 1 }],
  [12, { id: 12, name: "ICU", type: "icu", floor_id: 2, building_id: 1 }],
  [21, { id: 21, name: "Lab", type: "room", floor_id: 5, building_id: 4 }],
]);

const hazard = (over: Partial<Hazard> = {}): Hazard => ({
  id: 1, name: "Fire at C1", type: "fire", origin_node_id: 11, spread_rate: 2.5, severity: 4, is_active: true, ...over,
});

test("a new hazard starts as a serious fire that does not spread, with no place yet", () => {
  const draft = newDraft({ buildingId: 1, floorId: 2 });
  assert.equal(draft.type, "fire");
  assert.equal(draft.severity, 3);
  assert.equal(draft.spread, "0");
  assert.equal(draft.originId, null);
  assert.deepEqual(draftProblems(draft, places), { origin: "Choose the place where it starts.", name: "Enter a name." });
  assert.notEqual(newDraft().key, newDraft().key);
});

test("the name follows type and place until the user types one", () => {
  let draft = newDraft({ buildingId: 1, floorId: 2 });
  draft = updateDraft(draft, { originId: 11 }, places);
  assert.equal(draft.name, "Fire at C1");
  draft = updateDraft(draft, { type: "smoke" }, places);
  assert.equal(draft.name, "Smoke at C1");
  draft = updateDraft(draft, { name: "Kitchen smoke" }, places);
  draft = updateDraft(draft, { originId: 12 }, places);
  assert.equal(draft.name, "Kitchen smoke");
  // Clearing the name goes back to the suggestion.
  draft = updateDraft(draft, { name: "" }, places);
  assert.equal(draft.name, "Smoke at ICU");
});

test("a saved hazard becomes a draft in its building and floor", () => {
  const draft = draftFromHazard(hazard(), places);
  assert.equal(draft.buildingId, 1);
  assert.equal(draft.floorId, 2);
  assert.equal(draft.originId, 11);
  assert.equal(draft.spread, "2.5");
  assert.equal(draft.severity, 4);
  assert.equal(draft.nameEdited, false);
  assert.equal(draft.lostPlace, false);
  assert.equal(draftFromHazard(hazard({ name: "Main fire" }), places).nameEdited, true);
});

test("a saved hazard whose place was deleted must get a new place, and keeps its name", () => {
  let draft = draftFromHazard(hazard({ origin_node_id: 999 }), places);
  assert.equal(draft.lostPlace, true);
  assert.equal(draft.originId, null);
  assert.equal(draft.name, "Fire at C1");
  assert.ok(draftProblems(draft, places).origin);
  draft = updateDraft(draft, { buildingId: 4, floorId: 5, originId: 21 }, places);
  assert.equal(draft.lostPlace, false);
  assert.equal(draft.name, "Fire at C1");
});

test("spread must be 0 to 1000 and the name at most 200 characters", () => {
  const base = updateDraft(newDraft(), { originId: 11 }, places);
  assert.deepEqual(draftProblems(base, places), {});
  assert.ok(draftProblems({ ...base, spread: "-1" }, places).spread);
  assert.ok(draftProblems({ ...base, spread: "1000.5" }, places).spread);
  assert.ok(draftProblems({ ...base, spread: "" }, places).spread);
  assert.ok(draftProblems({ ...base, spread: "abc" }, places).spread);
  assert.deepEqual(draftProblems({ ...base, spread: "1000" }, places), {});
  assert.ok(draftProblems({ ...base, name: "x".repeat(201) }, places).name);
  assert.ok(draftProblems({ ...base, name: "   " }, places).name);
});

test("no hazards is valid (a drill); more than 50 is not", () => {
  assert.equal(draftsValid([], places), true);
  const one = updateDraft(newDraft(), { originId: 11 }, places);
  assert.equal(draftsValid(Array.from({ length: MAX_HAZARDS }, () => one), places), true);
  assert.equal(draftsValid(Array.from({ length: MAX_HAZARDS + 1 }, () => one), places), false);
});

test("the request body has exactly the fields the API accepts", () => {
  const draft = updateDraft(newDraft(), { originId: 12, severity: 5, spread: " 3 ", type: "hazmat", active: false }, places);
  assert.deepEqual(hazardBodies([{ ...draft, name: "  Spill  " }]), [{
    name: "Spill", type: "hazmat", origin_node_id: 12, spread_rate: 3, severity: 5, is_active: false,
  }]);
  assert.throws(() => hazardBodies([newDraft()]));
});

test("runs default to the first hazard's building", () => {
  assert.equal(defaultRunBuilding([]), null);
  assert.equal(defaultRunBuilding([{ buildingId: null }, { buildingId: 4 }, { buildingId: 1 }]), 4);
});

test("the scenario list describes hazards in words", () => {
  assert.equal(hazardSummary([]), "No hazard (evacuation drill)");
  assert.equal(hazardSummary([hazard(), hazard({ name: "Smoke at ICU", severity: 2, is_active: false })]),
    "Fire at C1 (severity 4); Smoke at ICU (severity 2, off)");
});
