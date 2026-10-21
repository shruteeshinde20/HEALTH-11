"use client";

// One floor drawn as a floor plan, seen from above: the building outline,
// rooms with walls and doors, corridors and passages, stairs, lifts, ramps,
// exit signs and the assembly point. During a run it also shows people (an
// icon per mobility type, gliding between frames), where fire, smoke,
// chemicals or structural damage have reached, places a hazard is about to
// reach, blocked places and queues. Everything comes from the API; the
// geometry is in lib/shared/floor-plan.ts.

import { useId, useMemo } from "react";

import {
  OUTDOOR_TYPES, bounds, drawingScale, hasSize, labelBox, passages, personSpots, placeBoxes, placeLabels, pointKey,
  scaleBarMetres, shownHazard, standingArea, wallSide,
  type Box, type PlanPath, type PlanPlace,
} from "@/lib/shared/floor-plan.ts";
import { MOBILITY_LABELS, type HazardSpot, type Position } from "@/lib/shared/live.ts";

// Light theme (PROJECT.md "Design"): tints of the design colours.
export const INK = "#1E3A5F";
export const ROOM_FILL: Record<string, string> = {
  ward: "#E3F0FB", icu: "#EDE7FB", room: "#FFFFFF", corridor: "#EEF2F7", stair: "#FDF3D3",
  ramp: "#FDF3D3", lift: "#E7ECF3", exit: "#16A34A", assembly: "#DCF5E7",
};
export const PASSAGE = "#EEF2F7";
export const PERSON_COLOURS = {
  ambulatory: "#2563EB", wheelchair: "#7C3AED", stretcher: "#C2410C", ventilator: "#BE185D", staff: "#0F766E",
} as const;
const HAZARD_LABEL: Record<string, string> = {
  fire: "fire", smoke: "smoke", hazmat: "hazardous material", structural: "structural damage",
};

type Props = {
  places: PlanPlace[];
  paths: PlanPath[];
  label: string;
  people?: Position[];
  hazards?: HazardSpot[];
  blocked?: ReadonlySet<number>;
  congested?: ReadonlySet<number>;
  /** Real milliseconds between frames, so people glide from one to the next. */
  stepMs?: number;
  className?: string;
};

export function FloorPlan({ places, paths, label, people = [], hazards = [], blocked, congested, stepMs, className }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const plan = useMemo(() => layout(places, paths), [places, paths]);
  const { boxes, scale, measured, view, footprint, ways, placeAt, labels, minFont } = plan;
  const s = scale;                                  // drawing units per metre
  const personR = Math.max(0.45 * s, view.width / 150);
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);
  const spots = hazards.filter((h) => byId.has(h.node_id));
  const where = useMemo(() => personSpots(people, placeAt, ways, personR * 2), [people, placeAt, ways, personR]);
  const id = (name: string) => `${uid}-${name}`;

  return (
    <svg role="img" aria-label={label} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
         className={className ?? "h-[460px] w-full rounded-lg border border-line bg-[#F4F7FA]"}>
      <defs>
        <pattern id={id("grid")} width={s * 5} height={s * 5} patternUnits="userSpaceOnUse">
          <path d={`M ${s * 5} 0 L 0 0 0 ${s * 5}`} fill="none" stroke="#E2E8F0" strokeWidth={s * 0.06} />
        </pattern>
        <pattern id={id("blocked")} width={s * 1.2} height={s * 1.2} patternUnits="userSpaceOnUse"
                 patternTransform="rotate(45)">
          <rect width={s * 0.45} height={s * 1.2} fill="#DC2626" opacity="0.45" />
        </pattern>
        <pattern id={id("structural")} width={s * 1.6} height={s * 1.6} patternUnits="userSpaceOnUse"
                 patternTransform="rotate(-35)">
          <rect width={s * 1.6} height={s * 1.6} fill="#D6A77A" opacity="0.45" />
          <rect width={s * 0.35} height={s * 1.6} fill="#92400E" opacity="0.6" />
        </pattern>
        <radialGradient id={id("fire")}>
          <stop offset="0%" stopColor="#FDE047" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#F97316" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#DC2626" stopOpacity="0.45" />
        </radialGradient>
        <radialGradient id={id("smoke")}>
          <stop offset="0%" stopColor="#475569" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#94A3B8" stopOpacity="0.35" />
        </radialGradient>
        <radialGradient id={id("hazmat")}>
          <stop offset="0%" stopColor="#BEF264" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#65A30D" stopOpacity="0.4" />
        </radialGradient>
      </defs>

      {/* Ground around the building, with a 5 m grid. */}
      <rect x={view.x} y={view.y} width={view.width} height={view.height} fill={`url(#${id("grid")})`} />
      {footprint && (
        <rect x={footprint.x} y={footprint.y} width={footprint.width} height={footprint.height}
              fill="#FFFFFF" stroke={INK} strokeWidth={s * 0.5} />
      )}

      {/* Passages between places (under the rooms), queues and blocked paths. */}
      {ways.map((way) => {
        const path = paths.find((p) => p.id === way.id);
        const isBlocked = path?.is_blocked;
        const busy = congested?.has(way.id);
        const open = way.from.x !== way.to.x || way.from.y !== way.to.y;
        return (
          <g key={way.id}>
            {/* A passage: grey side walls, then its floor on top. */}
            {open && <line x1={way.from.x} y1={way.from.y} x2={way.to.x} y2={way.to.y}
                           stroke="#CBD5E1" strokeWidth={way.width + s * 0.24} />}
            {open && <line x1={way.from.x} y1={way.from.y} x2={way.to.x} y2={way.to.y}
                           stroke={PASSAGE} strokeWidth={way.width} />}
            {busy && <line x1={way.doorA.x} y1={way.doorA.y} x2={way.doorB.x} y2={way.doorB.y}
                           stroke="#F97316" strokeOpacity="0.7" strokeWidth={Math.max(way.width * 0.6, s * 0.6)}
                           strokeLinecap="round" />}
            {isBlocked && <line x1={way.doorA.x} y1={way.doorA.y} x2={way.doorB.x} y2={way.doorB.y}
                                stroke="#DC2626" strokeWidth={s * 0.3} strokeDasharray={`${s * 0.8} ${s * 0.5}`} />}
          </g>
        );
      })}

      {/* Places: floor, walls and their symbol. */}
      {places.map((place) => {
        const box = boxes.get(place.id)!;
        return <Place key={place.id} place={place} box={box} s={s} sized={hasSize(place)} />;
      })}

      {/* Doors: a gap in the wall where each path leaves a room. */}
      {ways.flatMap((way) => {
        const path = paths.find((p) => p.id === way.id);
        if (!path) return [];
        return ([[path.from_node_id, way.doorA], [path.to_node_id, way.doorB]] as const).flatMap(([nodeId, point]) => {
          const place = byId.get(nodeId);
          const box = boxes.get(nodeId);
          if (!place || !box || place.type === "corridor" || place.type === "exit" || OUTDOOR_TYPES.has(place.type)) return [];
          const side = wallSide(box, point);
          if (side === "inside") return [];
          const along = side === "top" || side === "bottom";
          const half = Math.min(way.width, (along ? box.w : box.h) * 0.6) / 2;
          return [
            <line key={`${way.id}-${nodeId}`}
                  x1={along ? point.x - half : point.x} y1={along ? point.y : point.y - half}
                  x2={along ? point.x + half : point.x} y2={along ? point.y : point.y + half}
                  stroke={PASSAGE} strokeWidth={s * 0.42} />,
          ];
        });
      })}

      {/* Hazards: reached places glow; places about to be reached pulse. */}
      {spots.map((spot) => {
        const box = boxes.get(spot.node_id)!;
        const kind = shownHazard(spot.types);
        const grow = s * 0.6;
        const rect = { x: box.cx - box.w / 2 - grow, y: box.cy - box.h / 2 - grow, width: box.w + 2 * grow, height: box.h + 2 * grow };
        const name = byId.get(spot.node_id)?.name ?? "";
        if (spot.reached && kind) {
          const fill = kind === "structural" ? `url(#${id("structural")})` : `url(#${id(kind)})`;
          return (
            <rect key={spot.node_id} {...rect} rx={s * 1.2} fill={fill}
                  className={kind === "fire" ? "plan-fire" : kind === "smoke" ? "plan-smoke" : undefined}>
              <title>{`${name}: ${spot.types.map((t) => HAZARD_LABEL[t] ?? t).join(", ")}`}</title>
            </rect>
          );
        }
        if (spot.risk <= 0) return null;
        return (
          <rect key={spot.node_id} {...rect} rx={s * 1.2} fill="#FDBA74" fillOpacity={0.15 + spot.risk * 0.35}
                stroke="#EA580C" strokeWidth={s * 0.2} strokeDasharray={`${s * 0.7} ${s * 0.45}`} className="plan-coming">
            <title>{`${name}: a hazard is coming`}</title>
          </rect>
        );
      })}

      {/* Blocked places (by a hazard, or lifts that cannot be used in a fire). */}
      {places.filter((p) => p.is_blocked || blocked?.has(p.id)).map((place) => {
        const box = boxes.get(place.id)!;
        return (
          <rect key={`blocked-${place.id}`} x={box.cx - box.w / 2} y={box.cy - box.h / 2} width={box.w} height={box.h}
                fill={`url(#${id("blocked")})`} stroke="#DC2626" strokeWidth={s * 0.18}>
            <title>{`${place.name}: blocked`}</title>
          </rect>
        );
      })}

      {/* Names, on top of the floor and the hazards. */}
      {places.map((place) => {
        const label = labels.get(place.id);
        if (!label) return null;
        const exit = place.type === "exit";
        return (
          <text key={`label-${place.id}`} x={label.x} y={label.y} textAnchor={label.anchor} fontSize={label.size}
                fill={exit ? "#166534" : INK} fontWeight={600}
                paintOrder="stroke" stroke="#FFFFFF" strokeWidth={label.size * 0.25} strokeOpacity={label.inside ? 0.6 : 0.9}>
            {place.name}
          </text>
        );
      })}

      {/* People: one icon each, gliding from frame to frame. */}
      {people.map((person) => {
        const spot = where.get(person.id) ?? person;
        return (
          <g key={person.id} className="plan-person"
             style={{ transform: `translate(${spot.x}px, ${spot.y}px)`, transitionDuration: stepMs ? `${Math.round(stepMs)}ms` : "0ms" }}>
            <PersonIcon person={person} r={personR} />
          </g>
        );
      })}

      {measured && <ScaleBar view={view} s={s} font={Math.max(minFont, s * 0.9)} />}
    </svg>
  );
}

function layout(places: PlanPlace[], paths: PlanPath[]) {
  const { scale, measured } = drawingScale(places, paths);
  const boxes = placeBoxes(places, scale);
  const ways = passages(paths, boxes, scale);
  const indoor = places.filter((p) => !OUTDOOR_TYPES.has(p.type)).map((p) => boxes.get(p.id)!);
  const footprint = bounds(indoor, scale * 1.2);
  const base = bounds(boxes.values(), scale * 4) ?? { x: -50, y: -50, width: 100, height: 100 };
  const minFont = base.width / 95;                 // readable at the card's width
  const labels = placeLabels(places, boxes, footprint, scale, minFont);
  // Grow the drawing so exit names outside the building are not cut off.
  const named = places.flatMap((p) => {
    const label = labels.get(p.id);
    if (!label || label.inside) return [];
    const b = labelBox(p.name, label);
    return [{ cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h }];
  });
  const all = bounds([...boxes.values(), ...named], scale * 2) ?? base;
  const grown = {
    x: Math.min(all.x, base.x), y: Math.min(all.y, base.y),
    width: 0, height: 0,
  };
  grown.width = Math.max(all.x + all.width, base.x + base.width) - grown.x;
  grown.height = Math.max(all.y + all.height, base.y + base.height) - grown.y;
  const view = { ...grown, height: grown.height + scale * 3 };      // room for the scale bar
  const placeAt = new Map<string, Box>();
  for (const place of places) placeAt.set(pointKey(place), standingArea(boxes.get(place.id)!, labels.get(place.id)));
  return { boxes, scale, measured, view, footprint, ways, placeAt, labels, minFont };
}

function Place({ place, box, s, sized }: { place: PlanPlace; box: Box; s: number; sized: boolean }) {
  const x = box.cx - box.w / 2;
  const y = box.cy - box.h / 2;
  const fill = ROOM_FILL[place.type] ?? "#FFFFFF";
  const evacuation = place.type === "lift" && place.is_evacuation_lift;
  const title = [
    place.name, place.type,
    sized ? `${place.width_m} × ${place.length_m} m` : null,
    place.capacity ? `capacity ${place.capacity}` : null,
    evacuation ? "evacuation lift" : null,
  ].filter(Boolean).join(" · ");

  if (OUTDOOR_TYPES.has(place.type)) {
    return (
      <g>
        <title>{title}</title>
        <rect x={x} y={y} width={box.w} height={box.h} rx={Math.min(box.w, box.h) / 2} fill={fill}
              stroke="#16A34A" strokeWidth={s * 0.2} strokeDasharray={`${s * 0.8} ${s * 0.5}`} />
      </g>
    );
  }
  if (place.type === "exit") {
    const arrow = Math.min(box.w, box.h) * 0.35;
    return (
      <g>
        <title>{title}</title>
        <rect x={x} y={y} width={box.w} height={box.h} rx={s * 0.2} fill={fill} stroke="#166534" strokeWidth={s * 0.15} />
        <path d={`M ${box.cx - arrow} ${box.cy} L ${box.cx + arrow * 0.6} ${box.cy} M ${box.cx + arrow * 0.1} ${box.cy - arrow * 0.6} L ${box.cx + arrow * 0.7} ${box.cy} L ${box.cx + arrow * 0.1} ${box.cy + arrow * 0.6}`}
              fill="none" stroke="#FFFFFF" strokeWidth={Math.max(s * 0.18, arrow * 0.22)} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
  }

  const corridor = place.type === "corridor";
  return (
    <g>
      <title>{title}</title>
      <rect x={x} y={y} width={box.w} height={box.h} rx={corridor ? 0 : s * 0.15} fill={fill}
            stroke={corridor ? "#CBD5E1" : INK} strokeWidth={corridor ? s * 0.12 : s * 0.28} />
      {place.type === "stair" && <Treads box={box} s={s} />}
      {place.type === "ramp" && <Chevrons box={box} s={s} />}
      {place.type === "lift" && (
        <g stroke={evacuation ? "#16A34A" : "#94A3B8"} strokeWidth={s * (evacuation ? 0.22 : 0.12)}>
          <line x1={x + s * 0.3} y1={y + s * 0.3} x2={x + box.w - s * 0.3} y2={y + box.h - s * 0.3} />
          <line x1={x + box.w - s * 0.3} y1={y + s * 0.3} x2={x + s * 0.3} y2={y + box.h - s * 0.3} />
          {evacuation && <rect x={x} y={y} width={box.w} height={box.h} fill="none" strokeWidth={s * 0.3} />}
        </g>
      )}
    </g>
  );
}

/** Stair treads across the stair's shorter side. */
function Treads({ box, s }: { box: Box; s: number }) {
  const vertical = box.h >= box.w;
  const length = vertical ? box.h : box.w;
  const step = Math.max(s * 0.5, length / 14);
  const lines = [];
  for (let at = step; at < length - step / 2; at += step) {
    lines.push(vertical
      ? <line key={at} x1={box.cx - box.w / 2} y1={box.cy - box.h / 2 + at} x2={box.cx + box.w / 2} y2={box.cy - box.h / 2 + at} />
      : <line key={at} x1={box.cx - box.w / 2 + at} y1={box.cy - box.h / 2} x2={box.cx - box.w / 2 + at} y2={box.cy + box.h / 2} />);
  }
  return <g stroke="#B45309" strokeOpacity="0.55" strokeWidth={s * 0.08}>{lines}</g>;
}

/** Ramp: arrows pointing down the slope. */
function Chevrons({ box, s }: { box: Box; s: number }) {
  const size = Math.min(box.w, box.h) * 0.22;
  return (
    <g fill="none" stroke="#B45309" strokeOpacity="0.6" strokeWidth={s * 0.12} strokeLinecap="round">
      {[-1, 0, 1].map((k) => (
        <path key={k} d={`M ${box.cx - size} ${box.cy + k * size * 1.3 - size * 0.5} L ${box.cx} ${box.cy + k * size * 1.3 + size * 0.3} L ${box.cx + size} ${box.cy + k * size * 1.3 - size * 0.5}`} />
      ))}
    </g>
  );
}

function PersonIcon({ person, r }: { person: Position; r: number }) {
  const staff = person.id.startsWith("staff");
  const moving = person.status === "active";
  const mobility = person.mobility in MOBILITY_LABELS ? person.mobility : "ambulatory";
  const colour = staff ? PERSON_COLOURS.staff : PERSON_COLOURS[mobility as keyof typeof PERSON_COLOURS];
  const fill = moving ? colour : "#FFFFFF";
  const edge = moving ? "#FFFFFF" : INK;
  const title = `${staff ? "Staff" : `Patient · ${MOBILITY_LABELS[mobility]}`}${moving ? "" : ` · ${statusText(person.status)}`}`;
  if (mobility === "stretcher" || mobility === "ventilator") {
    return (
      <g>
        <title>{title}</title>
        <rect x={-r * 1.25} y={-r * 0.65} width={r * 2.5} height={r * 1.3} rx={r * 0.35} fill={fill}
              stroke={edge} strokeWidth={r * 0.25} />
        {mobility === "ventilator" && (
          <path d={`M ${-r * 0.45} 0 L ${r * 0.45} 0 M 0 ${-r * 0.4} L 0 ${r * 0.4}`} stroke={moving ? "#FFFFFF" : colour}
                strokeWidth={r * 0.22} strokeLinecap="round" />
        )}
      </g>
    );
  }
  return (
    <g>
      <title>{title}</title>
      <circle r={r} fill={fill} stroke={edge} strokeWidth={r * 0.25} />
      {mobility === "wheelchair" && !staff && (
        <circle r={r * 0.5} fill="none" stroke={moving ? "#FFFFFF" : colour} strokeWidth={r * 0.2} />
      )}
      {staff && <circle r={r * 0.32} fill={moving ? "#FFFFFF" : colour} />}
    </g>
  );
}

function statusText(status: string): string {
  if (status === "needs_assistance") return "needs help";
  if (status === "reached_by_hazard") return "reached by the hazard";
  return status;
}

function ScaleBar({ view, s, font }: { view: { x: number; y: number; width: number; height: number }; s: number; font: number }) {
  const metres = scaleBarMetres(view.width, s);
  const length = metres * s;
  const x = view.x + s * 1.5;
  const y = view.y + view.height - s * 1.4;
  return (
    <g aria-hidden="true">
      <rect x={x} y={y - s * 0.25} width={length} height={s * 0.5} fill="#FFFFFF" stroke={INK} strokeWidth={s * 0.08} />
      <rect x={x} y={y - s * 0.25} width={length / 2} height={s * 0.5} fill={INK} />
      <text x={x + length + s * 0.6} y={y + font * 0.35} fontSize={font} fill={INK}>{metres} m</text>
    </g>
  );
}
