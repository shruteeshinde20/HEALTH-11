// POST /api/session/password {current_password, new_password}
// Changes the signed-in user's password. The backend signs out every other
// session and returns new tokens, which replace this session's cookies.

import { NextResponse, type NextRequest } from "next/server";

import { badRequest, jsonOrNull, passThrough, readBody, tooLarge } from "@/lib/server/respond.ts";
import {
  callWithSession, clearSessionCookies, forbiddenOrigin, originAllowed, setSessionCookies, unavailable,
} from "@/lib/server/session.ts";
import type { TokenResponse } from "@/lib/server/session-core.ts";
import { errorBody } from "@/lib/shared/errors.ts";

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const body = await readBody(request);
  if (body === null) return tooLarge();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return badRequest("Expected a JSON request.");
  }

  let result;
  try {
    result = await callWithSession(request, {
      method: "POST", path: "/auth/change-password", body, contentType: "application/json",
    });
  } catch {
    return unavailable();
  }
  if (result.sessionEnded) {
    const ended = NextResponse.json(errorBody("UNAUTHORIZED", "Your session has ended. Please log in again."),
                                    { status: 401, headers: { "Cache-Control": "no-store" } });
    clearSessionCookies(ended);
    return ended;
  }
  if (!result.response.ok) {
    const failed = passThrough(result.response);
    if (result.newTokens) setSessionCookies(failed, result.newTokens);
    return failed;
  }

  const tokens = (await jsonOrNull(result.response)) as TokenResponse | null;
  if (!tokens?.access_token || !tokens.refresh_token) return unavailable();
  const response = NextResponse.json({ user: tokens.user }, { headers: { "Cache-Control": "no-store" } });
  setSessionCookies(response, tokens);
  return response;
}
