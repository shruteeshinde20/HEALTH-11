// POST /api/session/logout: revokes the refresh token at the backend and
// clears the session cookies. Always ends the session in this browser.

import { NextResponse, type NextRequest } from "next/server";

import {
  callBackend, clearSessionCookies, forbiddenOrigin, originAllowed, readSession,
} from "@/lib/server/session.ts";

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const { refresh } = readSession(request);
  if (refresh) {
    try {
      await callBackend(request, {
        method: "POST", path: "/auth/logout", body: JSON.stringify({ refresh_token: refresh }),
        contentType: "application/json",
      });
    } catch {
      // The backend is unreachable: the cookies are still cleared below; the
      // refresh token then expires on its own.
    }
  }
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearSessionCookies(response);
  return response;
}
