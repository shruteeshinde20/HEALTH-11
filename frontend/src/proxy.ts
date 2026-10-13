// Runs before every page (Next.js 16 "proxy", formerly middleware):
// 1) sends visitors without a session to the login page (a quick cookie check;
//    every API call is still authorised by the backend);
// 2) gives each page a fresh nonce and a strict Content-Security-Policy, so
//    only this site's own scripts can run.

import { NextResponse, type NextRequest } from "next/server";

import { serverConfig } from "@/lib/server/config.ts";
import { buildCsp, newNonce, wsOrigin } from "@/lib/server/csp.ts";
import { cookieNames } from "@/lib/server/session-core.ts";
import { HOME_PATH, PUBLIC_PATHS } from "@/lib/shared/navigation.ts";

function streamOrigin(): string | null {
  try {
    return wsOrigin(serverConfig().publicWsUrl);
  } catch {
    return null;   // misconfigured backend address: live streams cannot connect anyway
  }
}

export function proxy(request: NextRequest) {
  const production = process.env.NODE_ENV === "production";
  const names = cookieNames(production);
  const hasSession = request.cookies.has(names.access) || request.cookies.has(names.refresh);
  const { pathname, search } = request.nextUrl;

  if (!PUBLIC_PATHS.has(pathname) && !hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }
  if ((pathname === "/login" || pathname === "/register") && hasSession) {
    return NextResponse.redirect(new URL(HOME_PATH, request.url));
  }

  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    development: process.env.NODE_ENV === "development",
    secure: production,
    streamOrigin: streamOrigin(),
  });
  // Next.js reads the nonce from the request's CSP header and puts it on its scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
