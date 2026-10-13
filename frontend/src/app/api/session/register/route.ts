// POST /api/session/register {organization_name, full_name, email, password}
// Creates an organization with its first Administrator and logs them in.

import { NextResponse, type NextRequest } from "next/server";

import { badRequest, jsonOrNull, passThrough, readBody, tooLarge } from "@/lib/server/respond.ts";
import { callBackend, forbiddenOrigin, originAllowed, setSessionCookies, unavailable } from "@/lib/server/session.ts";
import type { TokenResponse } from "@/lib/server/session-core.ts";

type RegisterResponse = TokenResponse & { organization: { id: number; name: string; slug: string } };

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const body = await readBody(request);
  if (body === null) return tooLarge();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return badRequest("Expected a JSON request.");
  }

  let backend: Response;
  try {
    backend = await callBackend(request, {
      method: "POST", path: "/auth/register-organization", body, contentType: "application/json",
    });
  } catch {
    return unavailable();
  }
  if (!backend.ok) return passThrough(backend);

  const result = (await jsonOrNull(backend)) as RegisterResponse | null;
  if (!result?.access_token || !result.refresh_token) return unavailable();
  const response = NextResponse.json({ user: result.user, organization: result.organization },
                                     { status: 201, headers: { "Cache-Control": "no-store" } });
  setSessionCookies(response, result);
  return response;
}
