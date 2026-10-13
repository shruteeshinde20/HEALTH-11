// Calling the backend from the website's server with the visitor's session.

import { NextResponse, type NextRequest } from "next/server";

import { errorBody } from "../shared/errors.ts";
import { serverConfig } from "./config.ts";
import { clientIp, isSameOrigin, isUnsafeMethod } from "./request-core.ts";
import {
  cookieNames, cookieOptions, createRefresher, sessionCookieAges,
  type RefreshResult, type TokenResponse,
} from "./session-core.ts";

const BACKEND_TIMEOUT_MS = 60_000;

export type BackendCall = {
  method: string;
  path: string;            // e.g. "/floors/3/graph?x=1" (after /api/v1)
  body?: ArrayBuffer | string;
  contentType?: string | null;
  accept?: string | null;
};

function forwardedHeaders(request: NextRequest): Record<string, string> {
  const ip = clientIp(request.headers.get("x-forwarded-for"), serverConfig().trustProxyHeaders);
  return ip ? { "X-Forwarded-For": ip } : {};
}

export async function callBackend(request: NextRequest, call: BackendCall,
                                  accessToken?: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...forwardedHeaders(request) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (call.contentType) headers["Content-Type"] = call.contentType;
  if (call.accept) headers.Accept = call.accept;
  return fetch(`${serverConfig().backendUrl}/api/v1${call.path}`, {
    method: call.method,
    headers,
    body: call.body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
}

/** The backend could not be reached (down, wrong BACKEND_URL, timeout). */
export function unavailable(): NextResponse {
  return NextResponse.json(
    errorBody("SERVICE_UNAVAILABLE", "The HEALTH-11 server cannot be reached right now. Please try again shortly."),
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export function forbiddenOrigin(): NextResponse {
  return NextResponse.json(errorBody("FORBIDDEN", "This request must come from the HEALTH-11 website."),
                           { status: 403, headers: { "Cache-Control": "no-store" } });
}

/** CSRF check for requests that change data. */
export function originAllowed(request: NextRequest): boolean {
  if (!isUnsafeMethod(request.method)) return true;
  return isSameOrigin({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
}

export function readSession(request: NextRequest) {
  const names = cookieNames(serverConfig().secureCookies);
  return {
    access: request.cookies.get(names.access)?.value ?? null,
    refresh: request.cookies.get(names.refresh)?.value ?? null,
  };
}

export function setSessionCookies(response: NextResponse, tokens: TokenResponse): void {
  const { secureCookies } = serverConfig();
  const names = cookieNames(secureCookies);
  const ages = sessionCookieAges(tokens);
  response.cookies.set(names.access, tokens.access_token, cookieOptions(ages.access, secureCookies));
  response.cookies.set(names.refresh, tokens.refresh_token, cookieOptions(ages.refresh, secureCookies));
}

export function clearSessionCookies(response: NextResponse): void {
  const { secureCookies } = serverConfig();
  const names = cookieNames(secureCookies);
  response.cookies.set(names.access, "", cookieOptions(0, secureCookies));
  response.cookies.set(names.refresh, "", cookieOptions(0, secureCookies));
}

// One shared renewal per refresh token in this server process.
const refresh = createRefresher<NextRequest>(async (refreshToken, request): Promise<RefreshResult> => {
  const response = await callBackend(request, {
    method: "POST", path: "/auth/refresh", body: JSON.stringify({ refresh_token: refreshToken }),
    contentType: "application/json",
  });
  const body: unknown = await response.json().catch(() => null);
  return response.ok ? { ok: true, tokens: body as TokenResponse } : { ok: false, status: response.status, body };
});

export type SessionCallResult = {
  response: Response;
  newTokens: TokenResponse | null;   // set when the session was renewed
  sessionEnded: boolean;             // the visitor must log in again
};

/**
 * Make a backend call with the visitor's session, renewing it once if the
 * access token is missing or rejected.
 */
export async function callWithSession(request: NextRequest, call: BackendCall): Promise<SessionCallResult> {
  const session = readSession(request);
  const state: { access: string | null; newTokens: TokenResponse | null } = { access: session.access, newTokens: null };

  const renew = async (): Promise<boolean> => {
    if (!session.refresh) return false;
    const result = await refresh(session.refresh, request);
    if (!result.ok) return false;
    state.newTokens = result.tokens;
    state.access = result.tokens.access_token;
    return true;
  };

  if (!state.access && !(await renew())) {
    return { response: new Response(null, { status: 401 }), newTokens: null, sessionEnded: true };
  }
  let response = await callBackend(request, call, state.access);
  if (response.status === 401 && !state.newTokens && (await renew())) {
    response = await callBackend(request, call, state.access);
  }
  return { response, newTokens: state.newTokens, sessionEnded: response.status === 401 };
}
