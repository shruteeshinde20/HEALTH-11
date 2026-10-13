import { test } from "node:test";
import assert from "node:assert/strict";
import { hazardName, isVertical, newPlacePosition, parseNumber, placeColour, roundPosition } from "../../src/lib/shared/graph.ts";

test("colours follow the design: blocked, exits, stairs/ramps/lifts, wards/ICU, others", () => {
  assert.equal(placeColour("exit", false), "#BFE8D0");
  assert.equal(placeColour("exit", true), "#F9C5C5");
  assert.equal(placeColour("stair", false), "#FCE9B2");
  assert.equal(placeColour("lift", false), "#FCE9B2");
  assert.equal(placeColour("icu", false), "#D6E9F8");
  assert.equal(placeColour("corridor", false), "#FFFFFF");
});

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
