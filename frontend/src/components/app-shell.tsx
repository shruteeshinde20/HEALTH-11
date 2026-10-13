"use client";

// Layout of every signed-in page (preview: side navigation + main area),
// with the safety notice in the footer.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useSession } from "@/lib/client/session.tsx";
import { HOME_PATH } from "@/lib/shared/navigation.ts";
import { SAFETY_NOTICE, canOpen, visiblePages } from "@/lib/shared/pages.ts";

import { Card, EmptyState, ErrorState, LoadingState, PageHeader } from "./ui.tsx";

export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout, retry } = useSession();
  const pathname = usePathname();
  const role = state.status === "ready" ? state.user.role : null;

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-lg focus:bg-white focus:p-2">
        Skip to content
      </a>
      <nav
        aria-label="Pages"
        className="flex gap-1 overflow-x-auto border-b border-line bg-white p-2 md:sticky md:top-0 md:block md:h-screen md:w-[210px] md:flex-none md:overflow-auto md:border-b-0 md:border-r md:px-[10px] md:py-4"
      >
        <b className="hidden px-[10px] pb-[14px] pt-1 text-[15px] text-ink md:block">HEALTH-11</b>
        {visiblePages(role).map((page) => {
          const active = pathname === page.href || pathname.startsWith(page.href + "/");
          return (
            <Link
              key={page.href}
              href={page.href}
              aria-current={active ? "page" : undefined}
              className={`block whitespace-nowrap rounded-lg px-[10px] py-[7px] no-underline md:mb-0.5 ${
                active ? "bg-pri font-semibold text-ink" : "text-tx hover:bg-page"
              }`}
            >
              {page.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-3 px-4 pt-4 md:px-7">
          {state.status === "ready" && (
            <>
              <span className="sm">
                {state.user.full_name} · {state.user.role}
              </span>
              <button type="button" className="btn l" onClick={() => void logout()}>
                Log out
              </button>
            </>
          )}
        </header>
        <main id="main" tabIndex={-1} className="w-full max-w-[1100px] flex-1 px-4 py-4 md:px-7 md:py-[22px]">
          {state.status === "loading" && <LoadingState label="Loading your session…" />}
          {state.status === "error" && <ErrorState error={state.error} onRetry={retry} />}
          {state.status === "ready" && (canOpen(pathname, role) ? children : (
            <>
              <PageHeader title="Not available" subtitle="This page is not part of your role." />
              <Card>
                <EmptyState>
                  Your role ({state.user.role}) cannot use this page. An Administrator can change your role.{" "}
                  <Link href={HOME_PATH}>Back to the Dashboard</Link>
                </EmptyState>
              </Card>
            </>
          ))}
        </main>
        <footer className="px-4 pb-4 md:px-7">
          <p className="note">{SAFETY_NOTICE}</p>
        </footer>
      </div>
    </div>
  );
}
