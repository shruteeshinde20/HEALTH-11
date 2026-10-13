// POST /api/session/login {organization_slug, email, password}
// Logs in at the backend and keeps the tokens in httpOnly cookies.

import { NextResponse, type NextRequest } from "next/server";

import { badRequest, jsonOrNull, passThrough, readBody, tooLarge } from "@/lib/server/respond.ts";
import { callBackend, forbiddenOrigin, originAllowed, setSessionCookies, unavailable } from "@/lib/server/session.ts";
import type { TokenResponse } from "@/lib/server/session-core.ts";

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const body = await readBody(request);
  if (body === null) return tooLarge();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return badRequest("Expected a JSON request.");
  }

  let backend: Response;
  try {
    backend = await callBackend(request, { method: "POST", path: "/auth/login", body, contentType: "application/json" });
  } catch {
    return unavailable();
  }
  if (!backend.ok) return passThrough(backend);

  const tokens = (await jsonOrNull(backend)) as TokenResponse | null;
  if (!tokens?.access_token || !tokens.refresh_token) return unavailable();
  const response = NextResponse.json({ user: tokens.user }, { headers: { "Cache-Control": "no-store" } });
  setSessionCookies(response, tokens);
  return response;
}
