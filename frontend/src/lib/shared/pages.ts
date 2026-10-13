// The app's pages (PROJECT.md: 13 pages). A page appears in the navigation
// once it is built ("ready"), so no link leads to an unfinished page.
//
// Roles (PROJECT.md): Administrators see everything; Emergency Commanders
// everything except Admin; Staff Users read Dashboard, Live Simulation,
// Patients & Staff and Reports. Settings / Profile is open to everyone so
// each person can change their own name and password. The API enforces the
// same rules; this only keeps people away from pages they cannot use.

import type { Role } from "./api-types.ts";

export type AppPage = { href: string; label: string; ready: boolean; roles?: Role[] };

const PLANNERS: Role[] = ["Administrator", "Emergency Commander"];

export const APP_PAGES: AppPage[] = [
  { href: "/dashboard", label: "Dashboard", ready: true },
  { href: "/facilities", label: "Facility Manager", ready: true, roles: PLANNERS },
  { href: "/graph", label: "Graph Builder", ready: true, roles: PLANNERS },
  { href: "/scenarios", label: "Scenario Builder", ready: true, roles: PLANNERS },
  { href: "/live", label: "Live Simulation", ready: true },
  { href: "/compare", label: "Algorithm Comparison", ready: true, roles: PLANNERS },
  { href: "/people", label: "Patients & Staff", ready: true },
  { href: "/assistant", label: "AI Assistant", ready: true, roles: PLANNERS },
  { href: "/reports", label: "Reports & History", ready: true },
  { href: "/admin", label: "Admin", ready: true, roles: ["Administrator"] },
  { href: "/settings", label: "Settings / Profile", ready: true },
];

/** Pages that are not in the navigation but belong to a role (the onboarding wizard). */
const OTHER_PAGES: AppPage[] = [{ href: "/onboarding", label: "Get started", ready: true, roles: PLANNERS }];

function allowed(page: AppPage, role: Role | null): boolean {
  return page.ready && (!page.roles || (role !== null && page.roles.includes(role)));
}

export function visiblePages(role: Role | null): AppPage[] {
  return APP_PAGES.filter((page) => allowed(page, role));
}

/** May this role open the page at `pathname`? (Unknown paths are left to Next.js.) */
export function canOpen(pathname: string, role: Role | null): boolean {
  const page = [...APP_PAGES, ...OTHER_PAGES].find(
    (p) => pathname === p.href || pathname.startsWith(p.href + "/"));
  return page ? allowed(page, role) : true;
}

/** The page at `href` if this role may open it (for links between pages). */
export function pageFor(href: string, role: Role | null): AppPage | null {
  const page = APP_PAGES.find((p) => p.href === href);
  return page && allowed(page, role) ? page : null;
}

export const SAFETY_NOTICE =
  "HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals.";
