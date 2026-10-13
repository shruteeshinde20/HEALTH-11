// The app's pages (PROJECT.md: 13 pages). A page appears in the navigation
// once it is built ("ready"), so no link leads to an unfinished page.

import type { Role } from "./api-types.ts";

export type AppPage = { href: string; label: string; ready: boolean; roles?: Role[] };

export const APP_PAGES: AppPage[] = [
  { href: "/dashboard", label: "Dashboard", ready: true },
  { href: "/facilities", label: "Facility Manager", ready: true },
  { href: "/graph", label: "Graph Builder", ready: true },
  { href: "/scenarios", label: "Scenario Builder", ready: true },
  { href: "/live", label: "Live Simulation", ready: true },
  { href: "/compare", label: "Algorithm Comparison", ready: true, roles: ["Administrator", "Emergency Commander"] },
  { href: "/people", label: "Patients & Staff", ready: true },
  { href: "/assistant", label: "AI Assistant", ready: true },
  { href: "/reports", label: "Reports & History", ready: true },
  { href: "/admin", label: "Admin", ready: true, roles: ["Administrator"] },
  { href: "/settings", label: "Settings / Profile", ready: true },
];

export function visiblePages(role: Role | null): AppPage[] {
  return APP_PAGES.filter((page) => page.ready && (!page.roles || (role !== null && page.roles.includes(role))));
}

export const SAFETY_NOTICE =
  "HEALTH-11 supports planning and training. It does not replace a hospital's official emergency procedures or fire-safety professionals.";
