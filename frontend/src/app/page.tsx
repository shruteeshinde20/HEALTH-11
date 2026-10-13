// Landing page (docs/design/preview.html "landing"): what HEALTH-11 is, for
// everyone; no organization data is shown here.

import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { cookieNames } from "@/lib/server/session-core.ts";
import { HOME_PATH } from "@/lib/shared/navigation.ts";
import { SAFETY_NOTICE } from "@/lib/shared/pages.ts";

export const metadata: Metadata = {
  title: "HEALTH-11 · Hospital evacuation planning",
  description: "Plan hospital evacuations before an emergency happens, and see the safest route when one does.",
};

const STEPS = [
  { title: "Map", text: "Draw your floors, wards, stairs and exits as a simple graph." },
  { title: "Simulate", text: "Start a fire or hazard and watch routes change and bottlenecks appear." },
  { title: "Evacuate", text: "Get a clear plan and report your team can act on." },
];

export default async function Landing() {
  const names = cookieNames(process.env.NODE_ENV === "production");
  const store = await cookies();
  const signedIn = store.has(names.access) || store.has(names.refresh);

  return (
    <div className="flex min-h-screen flex-col px-4">
      <main id="main" className="mx-auto w-full max-w-[1100px] flex-1">
        <p className="mt-6 mb-0 text-[15px] font-bold tracking-wide text-ink">HEALTH-11</p>
        <section className="px-2 py-[50px] text-center" aria-labelledby="landing-title">
          <h1 id="landing-title" className="text-[34px]">Smarter Paths. Safer People. Healthier Tomorrows.</h1>
          <p className="mx-auto mt-[10px] mb-5 max-w-[520px] text-tx2">
            Plan hospital evacuations before an emergency happens, and see the safest route when one does.
          </p>
          <p className="flex flex-wrap justify-center gap-2">
            {signedIn ? (
              <Link className="btn" href={HOME_PATH}>Open your dashboard</Link>
            ) : (
              <>
                <Link className="btn" href="/login">Log in</Link>
                <Link className="btn l" href="/register">Create an account</Link>
              </>
            )}
          </p>
          <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px] text-left">
            {STEPS.map((step) => (
              <div key={step.title} className="card">
                <h2>{step.title}</h2>
                <p className="sm">{step.text}</p>
              </div>
            ))}
          </div>
          <p className="sm mx-auto mt-8 max-w-[640px]">
            For hospitals and disaster management agencies, supporting UN Sustainable Development Goals 11 (safe,
            resilient cities) and 13 (climate action). Every AI feature says how it works and how accurate it is.
          </p>
        </section>
      </main>
      <footer className="mx-auto mb-4 w-full max-w-[1100px]">
        <p className="note">{SAFETY_NOTICE}</p>
      </footer>
    </div>
  );
}
