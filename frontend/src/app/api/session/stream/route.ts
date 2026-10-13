// POST /api/session/stream {run_id, speed}: the address of a run's live stream.
//
// Browsers cannot send headers when opening a WebSocket, so the backend gives
// a stream token (60 seconds, this run only, not usable for anything else)
// that travels in the URL. The session's access token never leaves this server.

import { NextResponse, type NextRequest } from "next/server";

import { serverConfig } from "@/lib/server/config.ts";
import { streamUrl } from "@/lib/server/request-core.ts";
import { badRequest, jsonOrNull, passThrough } from "@/lib/server/respond.ts";
import {
  callWithSession, clearSessionCookies, forbiddenOrigin, originAllowed, setSessionCookies, unavailable,
} from "@/lib/server/session.ts";
import { errorBody } from "@/lib/shared/errors.ts";

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const body = await request.json().catch(() => null) as { run_id?: unknown; speed?: unknown } | null;
  const runId = body?.run_id;
  const speed = body?.speed;
  // Check the request before asking the backend (the token itself is checked when used).
  if (streamUrl(serverConfig().publicWsUrl, runId, "check", speed) === null) {
    return badRequest("Choose a simulation run and one of the offered speeds.");
  }

  let result;
  try {
    result = await callWithSession(request, { method: "POST", path: `/simulations/${String(runId)}/stream-token` });
  } catch {
    return unavailable();
  }
  if (result.sessionEnded) {
    const ended = NextResponse.json(errorBody("UNAUTHORIZED", "Your session has ended. Please log in again."),
                                    { status: 401, headers: { "Cache-Control": "no-store" } });
    clearSessionCookies(ended);
    return ended;
  }
  if (!result.response.ok) return passThrough(result.response);

  const issued = await jsonOrNull(result.response) as { token?: unknown; expires_in?: unknown } | null;
  const url = typeof issued?.token === "string"
    ? streamUrl(serverConfig().publicWsUrl, runId, issued.token, speed) : null;
  if (!url) return unavailable();
  const response = NextResponse.json({ url, expires_in: issued?.expires_in ?? null },
                                     { headers: { "Cache-Control": "no-store" } });
  if (result.newTokens) setSessionCookies(response, result.newTokens);
  return response;
}
