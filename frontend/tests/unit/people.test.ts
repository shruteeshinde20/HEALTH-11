import { test } from "node:test";
import assert from "node:assert/strict";

import { MOBILITIES, batchCodes, placeLabel, placementCounts } from "../../src/lib/shared/people.ts";

test("the four mobility types of the API", () => {
  assert.deepEqual([...MOBILITIES], ["ambulatory", "wheelchair", "stretcher", "ventilator"]);
});

test("adding several people numbers their codes", () => {
  assert.deepEqual(batchCodes(" N ", 1), ["N"]);
  assert.deepEqual(batchCodes("N", 3), ["N-1", "N-2", "N-3"]);
  assert.equal(batchCodes("N", 50)?.length, 50);
  for (const count of [0, 51, 2.5, -1]) assert.equal(batchCodes("N", count), null, String(count));
  assert.equal(batchCodes("   ", 2), null);
  assert.equal(batchCodes("x".repeat(100), 1)?.length, 1);
  assert.equal(batchCodes("x".repeat(98), 10), null);   // "…-10" would be 101 characters
});

test("places are described with floor and building", () => {
  const places = new Map([[7, { name: "WardA", floor_id: 2, building_id: 1 }]]);
  const floor = (id: number) => (id === 2 ? "Ground" : `Floor ${id}`);
  const building = () => "Test Hospital / Main Block";
  assert.equal(placeLabel(7, places, floor, building), "WardA · Ground · Test Hospital / Main Block");
  assert.equal(placeLabel(null, places, floor, building), "Not placed");
  assert.equal(placeLabel(99, places, floor, building), "A place that no longer exists");
});

test("placed and not placed are counted", () => {
  assert.deepEqual(placementCounts([{ node_id: 1 }, { node_id: null }, { node_id: 3 }]), { placed: 2, unplaced: 1 });
  assert.deepEqual(placementCounts([]), { placed: 0, unplaced: 0 });
});
