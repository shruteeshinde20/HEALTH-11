// Sends visitors without a session to the login page (Next.js 16 "proxy",
// formerly middleware). This is only a quick check for a session cookie; every
// API call is still authorised by the backend.

import { NextResponse, type NextRequest } from "next/server";

import { cookieNames } from "@/lib/server/session-core.ts";
import { HOME_PATH, PUBLIC_PATHS } from "@/lib/shared/navigation.ts";

export function proxy(request: NextRequest) {
  const names = cookieNames(process.env.NODE_ENV === "production");
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
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
