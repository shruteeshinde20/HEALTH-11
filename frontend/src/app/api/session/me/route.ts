// GET /api/session/me: the signed-in user (renewing the session if needed).

import { NextResponse, type NextRequest } from "next/server";

import { jsonOrNull, passThrough } from "@/lib/server/respond.ts";
import {
  callWithSession, clearSessionCookies, setSessionCookies, unavailable,
} from "@/lib/server/session.ts";
import { errorBody } from "@/lib/shared/errors.ts";

export async function GET(request: NextRequest) {
  let result;
  try {
    result = await callWithSession(request, { method: "GET", path: "/auth/me" });
  } catch {
    return unavailable();
  }
  let response: NextResponse;
  if (result.sessionEnded) {
    response = NextResponse.json(errorBody("UNAUTHORIZED", "Please log in."),
                                 { status: 401, headers: { "Cache-Control": "no-store" } });
    clearSessionCookies(response);
    return response;
  }
  if (!result.response.ok) return passThrough(result.response);
  response = NextResponse.json({ user: await jsonOrNull(result.response) }, { headers: { "Cache-Control": "no-store" } });
  if (result.newTokens) setSessionCookies(response, result.newTokens);
  return response;
}
