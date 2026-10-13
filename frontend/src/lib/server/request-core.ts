// Request checks for the website's server routes. Pure functions, unit-tested.

import { STREAM_SPEEDS } from "../shared/live.ts";

/** Largest request body passed on to the backend (floor imports are up to 5 MiB). */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * Cross-site request forgery protection (in addition to SameSite=Strict
 * cookies): a request that changes data must come from a page of this site.
 */
export function isSameOrigin(headers: { origin: string | null; host: string | null; secFetchSite: string | null }): boolean {
  if (headers.secFetchSite && headers.secFetchSite !== "same-origin") return false;
  if (!headers.origin || !headers.host) return false;
  try {
    return new URL(headers.origin).host.toLowerCase() === headers.host.toLowerCase();
  } catch {
    return false;
  }
}

const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The visitor's IP for the backend's rate limits. Only trusted when a reverse
 * proxy we control sets X-Forwarded-For; the right-most entry is the one that
 * proxy added itself, so a visitor cannot forge it.
 */
export function clientIp(forwardedFor: string | null, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders || !forwardedFor) return null;
  const parts = forwardedFor.split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && IP_LIKE.test(last) ? last : null;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Which backend paths the browser may reach through the website's server.
 * Token endpoints are excluded so tokens can never be handed to JavaScript;
 * sessions go through /api/session/* instead.
 */
export function backendPath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null;
  }
  if (segments[0] === "auth" && !(segments.length === 2 && segments[1] === "me")) return null;
  // Live-stream tokens are only handed out by /api/session/stream, already inside a URL.
  if (segments.includes("stream-token")) return null;
  return "/" + segments.join("/");
}

/**
 * The WebSocket base URL browsers use to reach the backend: the configured
 * public URL, or else BACKEND_URL with ws:// / wss://. Null if invalid.
 */
export function publicWsBase(backendUrl: string, configured: string | undefined): string | null {
  const raw = (configured ?? "").trim().replace(/\/+$/, "");
  try {
    if (raw) {
      const url = new URL(raw);
      return url.protocol === "ws:" || url.protocol === "wss:" ? raw : null;
    }
    const backend = new URL(backendUrl);
    if (backend.protocol !== "http:" && backend.protocol !== "https:") return null;
    backend.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
    return backend.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The live stream address of one run, or null for a bad run id or speed. */
export function streamUrl(base: string, runId: unknown, token: string, speed: unknown): string | null {
  if (typeof runId !== "number" || !Number.isInteger(runId) || runId <= 0) return null;
  if (typeof speed !== "number" || !(STREAM_SPEEDS as readonly number[]).includes(speed)) return null;
  const query = new URLSearchParams({ token, speed: String(speed) });
  return `${base}/api/v1/ws/simulations/${runId}?${query.toString()}`;
}

/** Response headers worth passing back to the browser. */
export const PASSED_RESPONSE_HEADERS = ["content-type", "content-disposition", "retry-after", "cache-control"];
