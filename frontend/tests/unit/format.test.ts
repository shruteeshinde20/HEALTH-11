import { test } from "node:test";
import assert from "node:assert/strict";
import { algorithmLabel, formatDateTime, formatSeconds } from "../../src/lib/shared/format.ts";

test("seconds are shown as in the design (4m 20s)", () => {
  assert.equal(formatSeconds(260), "4m 20s");
  assert.equal(formatSeconds(185), "3m 05s");
  assert.equal(formatSeconds(45.4), "45s");
  assert.equal(formatSeconds(0), "0s");
  assert.equal(formatSeconds(null), "–");
  assert.equal(formatSeconds(Number.NaN), "–");
});

test("dates and algorithm names", () => {
  assert.equal(formatDateTime("2026-10-13T08:05:00Z", "en-GB").includes("2026"), true);
  assert.equal(formatDateTime("not a date"), "–");
  assert.equal(algorithmLabel("astar"), "A*");
  assert.equal(algorithmLabel("dijkstra"), "Dijkstra");
});
