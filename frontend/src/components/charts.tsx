"use client";

// Charts (Recharts, PROJECT.md stack). Colors are fixed slots validated for
// color-vision deficiency on the light surface; text uses the text colors,
// never the series color. Every chart sits next to a table with the same
// numbers, so nothing is told by color alone. The drawings are hidden from
// screen readers (the table carries the numbers), so Recharts' keyboard layer
// is switched off: nothing focusable may sit inside aria-hidden content.

import {
  Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

const SERIES_1 = "#2a78d6";   // blue
const SERIES_2 = "#eb6834";   // orange
const GRID = "#e2e8f0";       // --color-line
const TEXT = "#64748b";       // --color-tx2
const AXIS_TICK = { fill: TEXT, fontSize: 12 };

export type BarDatum = { label: string; value: number | null };

/** One measure across a few categories (for example, evacuation time per algorithm). */
export function MeasureBars({ title, unit, data }: { title: string; unit: string; data: BarDatum[] }) {
  const shown = data.filter((d): d is { label: string; value: number } => d.value !== null);
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-[13px] font-semibold text-ink">{title}</figcaption>
      {shown.length === 0 ? (
        <p className="sm m-0">No values to show.</p>
      ) : (
        <div className="h-[180px] w-full" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={shown} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} />
              <Tooltip cursor={{ fill: "#f1f5f9" }} formatter={(value) => [`${String(value)} ${unit}`, title]} />
              <Bar dataKey="value" fill={SERIES_1} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                <LabelList dataKey="value" position="top" fill={TEXT} fontSize={12} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}

export type TimelinePoint = { t: number; evacuated: number; active: number };

/** People out and still moving over simulated time (from a run's saved timeline). */
export function EvacuationTimeline({ points }: { points: TimelinePoint[] }) {
  if (points.length < 2) return <p className="sm m-0">This run has too few timeline points to draw.</p>;
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-[13px] font-semibold text-ink">People over time</figcaption>
      <div className="h-[240px] w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tick={AXIS_TICK} tickLine={false}
                   axisLine={{ stroke: GRID }} unit=" s" />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <Tooltip labelFormatter={(label) => `${String(label)} s`} />
            <Legend wrapperStyle={{ color: TEXT, fontSize: 12 }} />
            <Line type="stepAfter" dataKey="evacuated" name="Reached an exit" stroke={SERIES_1} strokeWidth={2}
                  dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="active" name="Still moving" stroke={SERIES_2} strokeWidth={2}
                  dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
