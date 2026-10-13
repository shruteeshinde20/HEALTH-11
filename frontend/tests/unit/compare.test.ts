import { test } from "node:test";
import assert from "node:assert/strict";

import type { Comparison } from "../../src/lib/shared/api-types.ts";
import { ALGORITHM_EXPLANATIONS, bestOf } from "../../src/lib/shared/compare.ts";

const row = (algorithm: string, over: Partial<Comparison> = {}): Comparison => ({
  algorithm, evacuation_time_s: 100, distance_m: 50, risk: 0, all_evacuated: true,
  evacuated: 4, total: 4, needs_assistance: 0, reached_by_hazard: 0, ...over,
});

test("the fastest only counts algorithms that got everyone out", () => {
  const best = bestOf([
    row("bfs", { evacuation_time_s: 60, all_evacuated: false, evacuated: 2 }),   // quicker but left people behind
    row("dfs", { evacuation_time_s: 140 }),
    row("dijkstra", { evacuation_time_s: 90 }),
    row("astar", { evacuation_time_s: 90 }),
  ]);
  assert.deepEqual([...best.fastest].sort(), ["astar", "dijkstra"]);   // a tie shares the title
});

test("shortest distance and lowest risk", () => {
  const best = bestOf([
    row("bfs", { distance_m: 70, risk: 3.5 }),
    row("dfs", { distance_m: 90, risk: 0.25 }),
    row("dijkstra", { distance_m: 48.5, risk: 1 }),
    row("astar", { distance_m: null, risk: null, all_evacuated: false, evacuated: 0 }),
  ]);
  assert.deepEqual([...best.shortest], ["dijkstra"]);
  assert.deepEqual([...best.safest], ["dfs"]);
});

test("nothing is called best when nobody was simulated or nobody got out", () => {
  const empty = bestOf(["bfs", "dfs"].map((a) => row(a, { total: 0, evacuated: 0, evacuation_time_s: null,
                                                         distance_m: null, risk: null, all_evacuated: false })));
  assert.equal(empty.fastest.size + empty.shortest.size + empty.safest.size, 0);
  const stuck = bestOf([row("bfs", { all_evacuated: false })]);
  assert.equal(stuck.fastest.size, 0);
});

test("every algorithm the API runs is explained", () => {
  assert.deepEqual(Object.keys(ALGORITHM_EXPLANATIONS).sort(), ["astar", "bfs", "dfs", "dijkstra"]);
});
