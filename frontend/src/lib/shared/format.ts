// Display helpers. They only format numbers that come from the API.

/** 260 -> "4m 20s", 45 -> "45s", null -> "–". */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** ISO timestamp -> "13 Oct 2026, 08:05" in the viewer's time zone. */
export function formatDateTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(locale ?? "en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export const ALGORITHM_LABELS: Record<string, string> = {
  bfs: "BFS",
  dfs: "DFS",
  dijkstra: "Dijkstra",
  astar: "A*",
};

export function algorithmLabel(value: string): string {
  return ALGORITHM_LABELS[value] ?? value;
}
