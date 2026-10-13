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
  // A full page load (not client-side navigation) on purpose: when a session
  // ends, nothing loaded for it may stay in the browser's memory.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
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

type PageOf<T> = { items: T[]; total: number };

/** Every item of a paginated list (pages of 200, the API maximum). */
export async function apiAll<T>(path: string, query: Query = {}, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const page = await apiRequest<PageOf<T>>(path, { query: { ...query, limit, offset }, signal });
    items.push(...page.items);
    if (page.items.length < limit || items.length >= page.total) return items;
  }
}

/** Upload a file as the raw request body with the given Content-Type. */
export async function apiUpload<T>(path: string, file: Blob, contentType: string): Promise<T> {
  const response = await fetch(`/api/backend${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": contentType },
    body: file,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    goToLogin();
    throw new ApiError(401, "UNAUTHORIZED", "Your session has ended. Please log in again.");
  }
  if (!response.ok) {
    throw toApiError(response.status, await response.json().catch(() => null), response.headers.get("retry-after"));
  }
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
