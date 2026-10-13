// Building responses from backend answers.

import { NextResponse, type NextRequest } from "next/server";

import { errorBody } from "../shared/errors.ts";
import { MAX_BODY_BYTES, PASSED_RESPONSE_HEADERS } from "./request-core.ts";

/** Read a request body with a size limit. Returns null when it is too large. */
export async function readBody(request: NextRequest): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  return body.byteLength > MAX_BODY_BYTES ? null : body;
}

export function tooLarge(): NextResponse {
  return NextResponse.json(errorBody("PAYLOAD_TOO_LARGE", "The upload is too large."),
                           { status: 413, headers: { "Cache-Control": "no-store" } });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json(errorBody("BAD_REQUEST", message),
                           { status: 400, headers: { "Cache-Control": "no-store" } });
}

/** Pass a backend response to the browser (streamed), keeping only safe headers. */
export function passThrough(backend: Response): NextResponse {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = backend.headers.get(name);
    if (value) headers.set(name, value);
  }
  const noBody = backend.status === 204 || backend.status === 304;
  return new NextResponse(noBody ? null : backend.body, { status: backend.status, headers });
}

/** JSON from a backend response, or null if it is not JSON. */
export async function jsonOrNull(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}
