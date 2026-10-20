// POST /api/session/password-reset/confirm
// "Forgot password?" (code and new password), passed to the backend's
// /auth/password-reset/confirm. Public (no session), but only from this site's pages.

import type { NextRequest } from "next/server";

import { badRequest, passThrough, readBody, tooLarge } from "@/lib/server/respond.ts";
import { callBackend, forbiddenOrigin, originAllowed, unavailable } from "@/lib/server/session.ts";

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const body = await readBody(request);
  if (body === null) return tooLarge();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return badRequest("Expected a JSON request.");
  }
  try {
    return passThrough(await callBackend(request, {
      method: "POST", path: "/auth/password-reset/confirm", body, contentType: "application/json",
    }));
  } catch {
    return unavailable();
  }
}
