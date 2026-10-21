"use client";

// Graph Builder canvas pieces for React Flow, drawn like the floor plan in
// Live Simulation: each place is a room at its size (or a size from its
// type), inside the building outline; each path is a passage between doors,
// labelled with its length in metres. React Flow still does the dragging,
// connecting, zooming and selecting.

import {
  BaseEdge, EdgeLabelRenderer, Handle, Position, useInternalNode,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";

import type { GraphEdge, GraphNode } from "@/lib/shared/api-types.ts";
import {
  DEFAULT_PATH_WIDTH_M, OUTDOOR_TYPES, PX_PER_METRE, bounds, canvasRect, doorsBetween, drawingScale, placeBoxes,
  type Box,
} from "@/lib/shared/floor-plan.ts";
import { formatSize } from "@/lib/shared/place-size.ts";

import { INK, PASSAGE, ROOM_FILL } from "./floor-plan.tsx";

export type PlaceNode = Node<{ place: GraphNode; sized: boolean }, "place">;
export type OutlineNode = Node<Record<string, never>, "outline">;
export type CanvasNode = PlaceNode | OutlineNode;
export type PassageEdgeType = Edge<{ path: GraphEdge; widthPx: number }, "passage">;

export const OUTLINE_ID = "outline";

/** Pixels per drawing unit on the canvas for this floor, and the rooms' boxes. */
export function canvasScale(places: GraphNode[], paths: GraphEdge[]): { pxPerUnit: number; boxes: Map<number, Box> } {
  const { scale } = drawingScale(places, paths);
  return { pxPerUnit: PX_PER_METRE / scale, boxes: placeBoxes(places, scale) };
}

/**
 * The canvas nodes: the building outline, then one room per place. A room
 * keeps React Flow's measurement from `previous` while its size is the same.
 */
export function buildCanvasNodes(places: GraphNode[], paths: GraphEdge[], previous: CanvasNode[] = []): CanvasNode[] {
  const { pxPerUnit, boxes } = canvasScale(places, paths);
  const before = new Map(previous.map((n) => [n.id, n]));
  const nodes: CanvasNode[] = [];
  const indoor = places.filter((p) => !OUTDOOR_TYPES.has(p.type)).map((p) => boxes.get(p.id)!);
  const outline = bounds(indoor, (PX_PER_METRE * 1.2) / pxPerUnit);
  if (outline) {
    nodes.push({
      id: OUTLINE_ID, type: "outline", data: {},
      position: { x: outline.x * pxPerUnit, y: outline.y * pxPerUnit },
      width: outline.width * pxPerUnit, height: outline.height * pxPerUnit,
      draggable: false, selectable: false, focusable: false, connectable: false, zIndex: -1,
      style: { pointerEvents: "none" },
    });
  }
  for (const place of places) {
    const rect = canvasRect(boxes.get(place.id)!, pxPerUnit);
    const id = String(place.id);
    const old = before.get(id);
    const node: PlaceNode = {
      id, type: "place", data: { place, sized: place.width_m != null && place.length_m != null },
      position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height,
      selected: old?.selected ?? false,
    };
    if (old?.measured && old.width === rect.width && old.height === rect.height) node.measured = old.measured;
    nodes.push(node);
  }
  return nodes;
}

/** One passage per path; its width in pixels is the path's width in metres (the canvas has a fixed pixels per metre). */
export function buildCanvasEdges(paths: GraphEdge[], selectedId: number | null): PassageEdgeType[] {
  return paths.map((path) => ({
    id: String(path.id), source: String(path.from_node_id), target: String(path.to_node_id), type: "passage",
    selected: selectedId === path.id,
    data: { path, widthPx: (path.width > 0 ? Math.min(path.width, 4) : DEFAULT_PATH_WIDTH_M) * PX_PER_METRE },
  }));
}

// --- Views ---------------------------------------------------------------------------------

export function OutlineNodeView() {
  return <div className="h-full w-full bg-white" style={{ border: `5px solid ${INK}` }} aria-hidden="true" />;
}

export function PlaceNodeView({ data, selected }: NodeProps<PlaceNode>) {
  const { place, sized } = data;
  const type = place.type;
  const evacuation = type === "lift" && place.is_evacuation_lift;
  const size = formatSize(place);
  const title = [place.name, type, size ?? (sized ? null : "size from its type"),
                 place.is_blocked ? "blocked" : null, evacuation ? "evacuation lift" : null].filter(Boolean).join(" · ");
  const exit = type === "exit";
  const outdoor = OUTDOOR_TYPES.has(type);
  const corridor = type === "corridor";
  const ring = selected ? "0 0 0 3px #5FA3D9" : undefined;
  return (
    <div
      title={title}
      className={`relative flex h-full w-full items-start justify-center overflow-visible ${outdoor ? "rounded-full" : "rounded-[3px]"}`}
      style={{
        background: place.is_blocked
          ? "repeating-linear-gradient(45deg, #FEE2E2 0 6px, #FCA5A5 6px 9px)"
          : type === "stair" ? `repeating-linear-gradient(0deg, ${ROOM_FILL.stair} 0 5px, #E7C988 5px 6px)`
          : ROOM_FILL[type] ?? "#FFFFFF",
        border: outdoor ? "2px dashed #16A34A"
          : evacuation ? "3px solid #16A34A"
          : exit ? "1.5px solid #166534"
          : corridor ? "1px solid #CBD5E1" : `2.5px solid ${INK}`,
        boxShadow: ring,
      }}
    >
      {type === "lift" && (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="M 1 1 L 9 9 M 9 1 L 1 9" stroke={evacuation ? "#16A34A" : "#94A3B8"} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {exit && (
        <svg className="absolute inset-0 m-auto h-[70%] w-[70%]" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M 1.5 5 L 7.5 5 M 5 2 L 8 5 L 5 8" fill="none" stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span
        className={`pointer-events-none z-10 whitespace-nowrap px-1 text-[11px] font-semibold leading-tight ${exit ? "absolute top-full mt-0.5 text-[#166534]" : "mt-0.5 text-ink"}`}
        style={{ textShadow: "0 0 3px #fff, 0 0 3px #fff" }}
      >
        {place.name}
      </span>
      <Handle type="source" position={Position.Right} aria-label={`Connect ${place.name}`} />
    </div>
  );
}

/** A passage between the two rooms' doors, with its length in metres. */
export function PassageEdgeView({ id, source, target, data, selected }: EdgeProps<PassageEdgeType>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b || !data) return null;
  const box = (n: NonNullable<typeof a>): Box => {
    const w = n.measured.width ?? n.width ?? 0;
    const h = n.measured.height ?? n.height ?? 0;
    return { cx: n.internals.positionAbsolute.x + w / 2, cy: n.internals.positionAbsolute.y + h / 2, w, h };
  };
  const boxA = box(a);
  const boxB = box(b);
  const [doorA, doorB] = doorsBetween(boxA, boxB);
  const apart = (doorB.x - doorA.x) * (boxB.cx - boxA.cx) + (doorB.y - doorA.y) * (boxB.cy - boxA.cy) > 0;
  const { path, widthPx } = data;
  const colour = path.is_blocked ? "#DC2626" : selected ? "#5FA3D9" : apart ? PASSAGE : "#94A3B8";
  // Rooms that touch share a door: a short dashed mark between their centres keeps the path clickable.
  const d = apart ? `M ${doorA.x} ${doorA.y} L ${doorB.x} ${doorB.y}` : `M ${boxA.cx} ${boxA.cy} L ${boxB.cx} ${boxB.cy}`;
  const mid = { x: (doorA.x + doorB.x) / 2, y: (doorA.y + doorB.y) / 2 };
  return (
    <>
      {apart && <BaseEdge id={`${id}-wall`} path={d} style={{ stroke: "#CBD5E1", strokeWidth: widthPx + 3 }} interactionWidth={0} />}
      <BaseEdge id={id} path={d} interactionWidth={Math.max(widthPx, 16)}
                style={{
                  stroke: colour, strokeWidth: apart ? widthPx : selected ? 3 : 1.5,
                  strokeDasharray: path.is_blocked || !apart ? "6 4" : undefined,
                }} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan pointer-events-none absolute rounded bg-white/90 px-1 text-[10px] text-tx"
             style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}>
          {path.distance} m
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// Defined outside the components, as the React Flow docs advise.
export const nodeTypes = { place: PlaceNodeView, outline: OutlineNodeView };
export const edgeTypes = { passage: PassageEdgeView };
