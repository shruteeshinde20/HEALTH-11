import { test } from "node:test";
import assert from "node:assert/strict";
import { hazardName, isVertical, newPlacePosition, parseNumber, roundPosition } from "../../src/lib/shared/graph.ts";

test("only stairs, ramps and lifts link floors", () => {
  assert.ok(isVertical("stair") && isVertical("ramp") && isVertical("lift"));
  assert.ok(!isVertical("corridor") && !isVertical("exit"));
});

test("new places appear to the right of the existing ones", () => {
  assert.deepEqual(newPlacePosition([]), { x: 0, y: 0 });
  assert.deepEqual(newPlacePosition([{ x: 50, y: 150 }, { x: 440, y: 70 }]), { x: 520, y: 70 });
  assert.equal(roundPosition(12.345), 12.3);
});

test("number fields: empty, valid, out of range", () => {
  assert.equal(parseNumber("", 0, 10), null);
  assert.equal(parseNumber("2.5", 0, 10), 2.5);
  assert.ok(Number.isNaN(parseNumber("11", 0, 10)));
  assert.ok(Number.isNaN(parseNumber("2.5", 0, 10, true)));
  assert.ok(Number.isNaN(parseNumber("abc", 0, 10)));
  assert.equal(hazardName("smoke", "Ward A"), "Smoke at Ward A");
});

test("capacity suggested from a path's width (SFPE, 1.3158 people/s per usable metre)", async () => {
  const { suggestedMaxFlow } = await import("../../src/lib/shared/graph.ts");
  assert.equal(suggestedMaxFlow(2.4), 165);   // 2.1 m usable x 1.3158 x 60 = 165.8
  assert.equal(suggestedMaxFlow(1.5), 94);    // 1.2 m usable
  assert.equal(suggestedMaxFlow(0.9), 47);    // 0.6 m usable
  assert.equal(suggestedMaxFlow(0.2), 23);    // never below 0.3 m usable
  assert.equal(suggestedMaxFlow(0), null);
  assert.equal(suggestedMaxFlow(null), null);
  assert.equal(suggestedMaxFlow(Number.NaN), null);
});
