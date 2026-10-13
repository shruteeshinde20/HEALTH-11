// Session rules for the website's server. Pure functions (no Next.js imports),
// so they are unit-tested with Node's test runner.
//
// The browser never sees the backend's tokens: they live in httpOnly cookies
// that JavaScript cannot read, and the website's server attaches them to
// backend calls.

import { createHash } from "node:crypto";

import type { User } from "../shared/api-types.ts";

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
};

export type CookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/";
  maxAge: number;
};

/** "__Host-" cookies must be Secure with Path=/ and no Domain: browsers then
 *  refuse any attempt to set or overwrite them from another (sub)domain. */
export function cookieNames(secure: boolean) {
  const prefix = secure ? "__Host-" : "";
  return { access: `${prefix}h11_access`, refresh: `${prefix}h11_refresh` };
}

export function cookieOptions(maxAgeSeconds: number, secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: Math.max(0, Math.floor(maxAgeSeconds)) };
}

/** Seconds until a JWT's "exp" claim (read only to size the cookie; the
 *  backend verifies the signature). Returns null if it cannot be read. */
export function secondsUntilExpiry(token: string, nowMs: number = Date.now()): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof claims.exp !== "number") return null;
    return Math.max(0, Math.floor(claims.exp - nowMs / 1000));
  } catch {
    return null;
  }
}

/** Cookie lifetimes for a token pair: the access cookie lives as long as the
 *  access token, the refresh cookie as long as the refresh token. */
export function sessionCookieAges(tokens: Pick<TokenResponse, "access_token" | "refresh_token" | "expires_in">,
                                  nowMs: number = Date.now()) {
  const access = tokens.expires_in > 0 ? tokens.expires_in : secondsUntilExpiry(tokens.access_token, nowMs) ?? 0;
  // Fallback of 7 days matches the backend default REFRESH_TOKEN_EXPIRE_DAYS.
  const refresh = secondsUntilExpiry(tokens.refresh_token, nowMs) ?? 7 * 24 * 3600;
  return { access, refresh };
}

export type RefreshResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; status: number; body: unknown };

/**
 * The backend's refresh tokens work once (they rotate). When a page sends
 * several requests at the moment the session needs renewing, they all carry
 * the same refresh token; without sharing, all but the first would fail and
 * log the user out. This shares one renewal between them, and for a short
 * grace period answers late requests that still carry the old token with the
 * same new tokens.
 */
export function createRefresher<Context>(
  callRefresh: (refreshToken: string, context: Context) => Promise<RefreshResult>,
  options: { graceMs?: number; now?: () => number } = {},
) {
  const graceMs = options.graceMs ?? 30_000;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<RefreshResult>>();
  const recent = new Map<string, { result: RefreshResult; at: number }>();

  const key = (token: string) => createHash("sha256").update(token).digest("hex");

  // `context` is the caller's request details; callers sharing one renewal
  // belong to the same session, so the first caller's context is used.
  return async function refresh(refreshToken: string, context: Context): Promise<RefreshResult> {
    const id = key(refreshToken);
    const cutoff = now() - graceMs;
    for (const [k, v] of recent) if (v.at < cutoff) recent.delete(k);

    const done = recent.get(id);
    if (done) return done.result;
    const pending = inFlight.get(id);
    if (pending) return pending;

    const promise = callRefresh(refreshToken, context).then((result) => {
      if (result.ok) recent.set(id, { result, at: now() });
      return result;
    }).finally(() => inFlight.delete(id));
    inFlight.set(id, promise);
    return promise;
  };
}
