// The browser's only way to reach the backend: through this website's server
// at /api/backend/*, which adds the session from httpOnly cookies.

import { ApiError, toApiError } from "../shared/errors.ts";

export type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

function goToLogin(): void {
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export async function apiRequest<T>(path: string, options: {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }

  const response = await fetch(`/api/backend${withQuery(path, options.query)}`, init);
  if (response.status === 401) {
    goToLogin();
    throw new ApiError(401, "UNAUTHORIZED", "Your session has ended. Please log in again.");
  }
  if (!response.ok) {
    throw toApiError(response.status, await response.json().catch(() => null), response.headers.get("retry-after"));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** For the session routes (/api/session/*), which answer login errors normally. */
export async function sessionRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/session/${path}`, {
    method: body === undefined && path === "me" ? "GET" : "POST",
    headers: body === undefined ? { Accept: "application/json" }
                                : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw toApiError(response.status, await response.json().catch(() => null), response.headers.get("retry-after"));
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
