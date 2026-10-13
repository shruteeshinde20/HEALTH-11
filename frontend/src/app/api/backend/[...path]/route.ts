// /api/backend/<path> -> backend /api/v1/<path>, with the visitor's session.
// The browser only ever talks to this website; tokens stay in httpOnly cookies.

import { NextResponse, type NextRequest } from "next/server";

import { backendPath } from "@/lib/server/request-core.ts";
import { passThrough, readBody, tooLarge } from "@/lib/server/respond.ts";
import {
  callWithSession, clearSessionCookies, forbiddenOrigin, originAllowed, setSessionCookies, unavailable,
} from "@/lib/server/session.ts";
import { errorBody } from "@/lib/shared/errors.ts";

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, context: Context) {
  if (!originAllowed(request)) return forbiddenOrigin();
  const path = backendPath((await context.params).path);
  if (!path) {
    return NextResponse.json(errorBody("NOT_FOUND", "Not found."),
                             { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const read = await readBody(request);
    if (read === null) return tooLarge();
    body = read.byteLength ? read : undefined;
  }

  let result;
  try {
    result = await callWithSession(request, {
      method: request.method,
      path: path + request.nextUrl.search,
      body,
      contentType: request.headers.get("content-type"),
      accept: request.headers.get("accept"),
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
  const response = passThrough(result.response);
  if (result.newTokens) setSessionCookies(response, result.newTokens);
  return response;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
