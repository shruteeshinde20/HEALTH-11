// Algorithm Comparison rules (POST /compare, backend/app/simulation_api.py).

import type { Comparison } from "./api-types.ts";

/** What each algorithm does (backend/app/services/routing.py). */
export const ALGORITHM_EXPLANATIONS: Record<string, string> = {
  bfs: "Fewest steps between places; path lengths and hazard risk are not considered.",
  dfs: "The first route it finds; no guarantee it is short or safe.",
  dijkstra: "Shortest walking distance, with nearby hazard risk counted as extra distance.",
  astar: "Same route length as Dijkstra, guided by straight-line distance on the floor plan.",
};

export type Best = { fastest: Set<string>; shortest: Set<string>; safest: Set<string> };

function lowest(rows: Comparison[], value: (row: Comparison) => number | null): Set<string> {
  const known = rows.filter((row) => value(row) !== null);
  if (known.length === 0) return new Set();
  const min = Math.min(...known.map((row) => value(row) as number));
  return new Set(known.filter((row) => Math.abs((value(row) as number) - min) < 1e-9).map((row) => row.algorithm));
}

/**
 * The best algorithms by each measure (ties share the title). "Fastest" only
 * counts algorithms that got everyone out: a quicker time for fewer people is
 * not better.
 */
export function bestOf(rows: Comparison[]): Best {
  const complete = rows.filter((row) => row.all_evacuated && row.total > 0);
  return {
    fastest: lowest(complete, (row) => row.evacuation_time_s),
    shortest: lowest(rows.filter((row) => row.total > 0), (row) => row.distance_m),
    safest: lowest(rows.filter((row) => row.total > 0), (row) => row.risk),
  };
}
