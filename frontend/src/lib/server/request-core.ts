// Request checks for the website's server routes. Pure functions, unit-tested.

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
  return "/" + segments.join("/");
}

/** Response headers worth passing back to the browser. */
export const PASSED_RESPONSE_HEADERS = ["content-type", "content-disposition", "retry-after", "cache-control"];
