import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_STATUSES, PLAN_STATUS_LABELS, planActions, routeText, suggestedPlanName, whoLabel,
} from "../../src/lib/shared/plans.ts";

test("every plan status has a label and at least one way out of it", () => {
  for (const status of PLAN_STATUSES) {
    assert.ok(PLAN_STATUS_LABELS[status]);
    const actions = planActions(status);
    assert.ok(actions.length > 0);
    assert.ok(actions.every((a) => a.to !== status), `${status} offers a change to itself`);
  }
});

test("status changes offered for each status", () => {
  assert.deepEqual(planActions("draft").map((a) => a.to), ["approved", "archived"]);
  assert.deepEqual(planActions("approved").map((a) => a.to), ["archived", "draft"]);
  assert.deepEqual(planActions("archived").map((a) => a.to), ["draft"]);
});

test("who an instruction is for", () => {
  assert.equal(whoLabel({ kind: "patient", mobility: "stretcher", people: 1 }), "1 stretcher patient");
  assert.equal(whoLabel({ kind: "patient", mobility: "wheelchair", people: 3 }), "3 wheelchair patients");
  assert.equal(whoLabel({ kind: "staff", mobility: "ambulatory", people: 4 }), "4 walking staff");
  assert.equal(whoLabel({ kind: "staff", mobility: "ambulatory", people: 1 }), "1 walking staff");
  assert.equal(whoLabel({ kind: null, mobility: null, people: 2 }), "2 people");
});

test("route text, and people without a safe route", () => {
  assert.equal(routeText({ route: ["ICU", "C2", "R2", "E2"], needs_assistance: false }), "ICU → C2 → R2 → E2");
  assert.match(routeText({ route: [], needs_assistance: true }), /needs assisted evacuation/);
  assert.match(routeText({ route: [], needs_assistance: false }), /needs assisted evacuation/);
});

test("suggested plan names stay within the 200 characters the API accepts", () => {
  assert.equal(suggestedPlanName("Fire at C1", 7), "Fire at C1 – plan from run 7");
  assert.equal(suggestedPlanName("   ", 2), "Scenario – plan from run 2");
  assert.equal(suggestedPlanName("x".repeat(300), 1).length, 200);
});
