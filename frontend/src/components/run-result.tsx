"use client";

// The outcome of one simulation run (GET /simulation_runs/{id}) with its
// report downloads. Used by the onboarding wizard and the Scenario Builder.

import Link from "next/link";
import type { ReactNode } from "react";

import type { RunDetail } from "@/lib/shared/api-types.ts";
import { algorithmLabel, formatSeconds } from "@/lib/shared/format.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";

import { Tag } from "./ui.tsx";

const peoplePage = APP_PAGES.find((page) => page.href === "/people");
const livePage = APP_PAGES.find((page) => page.href === "/live");

export function RunResult({ result, showAlgorithm = false, children }: {
  result: RunDetail;
  showAlgorithm?: boolean;
  children?: ReactNode;      // extra buttons after the report links
}) {
  const summary = result.summary;
  return (
    <div role="status">
      {showAlgorithm && <p className="sm mb-0">Run {result.id} · {algorithmLabel(result.algorithm)}</p>}
      {!summary || summary.total === 0 ? (
        <p>
          <Tag tone="p">Nobody to evacuate</Tag> The simulation was saved, but nobody is placed in this building yet.
          {peoplePage?.ready ? <> Add people on <Link href={peoplePage.href}>Patients &amp; Staff</Link>.</>
                             : " Placing patients and staff comes with the Patients & Staff page."}
        </p>
      ) : (
        <>
          <p>
            <Tag tone={summary.all_evacuated ? "ok" : "b"}>{summary.all_evacuated ? "Everyone out" : "Not everyone out"}</Tag>{" "}
            {summary.evacuated} of {summary.total} people reached an exit
            {summary.all_evacuated ? ` in ${formatSeconds(summary.evacuation_time_s)}.` : "."}
          </p>
          <ul>
            {result.recommendations.map((item, i) => <li key={i}>{item.text}</li>)}
          </ul>
        </>
      )}
      <p className="flex flex-wrap gap-2">
        {livePage?.ready && <Link className="btn" href={`${livePage.href}?run=${result.id}`}>Watch it live</Link>}
        <a className="btn l" href={`/api/backend/reports/${result.id}?format=pdf`} download>Report (PDF)</a>
        <a className="btn l" href={`/api/backend/reports/${result.id}?format=csv`} download>Report (CSV)</a>
        {children}
      </p>
    </div>
  );
}
