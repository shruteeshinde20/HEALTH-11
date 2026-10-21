"use client";

// Graph Builder (docs/design/preview.html "graph"): the floor plan as places
// (nodes) and paths (edges) on a React Flow canvas, edited through the API.
// Everything on the canvas can also be done from the lists below it with the
// keyboard.

import {
  Background, BackgroundVariant, ConnectionMode, ReactFlow, applyNodeChanges,
  type Connection, type Edge, type NodeChange, type NodeMouseHandler,
} from "@xyflow/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";

import { Dialog } from "@/components/dialog.tsx";
import { DeleteConfirm } from "@/components/facility-forms.tsx";
import { FloorLinks, PathForm, PlaceForm } from "@/components/graph-forms.tsx";
import {
  OUTLINE_ID, buildCanvasEdges, buildCanvasNodes, canvasScale, edgeTypes, nodeTypes, type CanvasNode,
} from "@/components/plan-canvas.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import type { Building, Floor, FloorGraph, GraphEdge, GraphNode, Hospital } from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import { PX_PER_METRE, centreFromCanvas, drawingScale } from "@/lib/shared/floor-plan.ts";
import { isVertical, newPlacePosition, roundPosition } from "@/lib/shared/graph.ts";
import { formatSize } from "@/lib/shared/place-size.ts";

// --- Page ----------------------------------------------------------------------------------

function GraphBuilder() {
  const params = useSearchParams();
  const router = useRouter();
  const floorId = Number(params.get("floor")) || null;
  const hospitals = useAll<Hospital>("/hospitals");
  const buildings = useAll<Building>("/buildings");
  const floors = useAll<Floor>("/floors");
  const graph = useApi<FloorGraph>(floorId ? `/floors/${floorId}/graph` : null);

  const loadError = hospitals.error ?? buildings.error ?? floors.error;
  const label = (floor: Floor) => {
    const building = buildings.data?.find((b) => b.id === floor.building_id);
    const hospital = hospitals.data?.find((h) => h.id === building?.hospital_id);
    return `${hospital?.name ?? "?"} / ${building?.name ?? "?"} / ${floor.name}`;
  };
  const options = [...(floors.data ?? [])].sort((a, b) => label(a).localeCompare(label(b)));
  const floor = floors.data?.find((f) => f.id === floorId) ?? null;

  return (
    <>
      <PageHeader title="Graph Builder" subtitle="Add rooms and paths. Every change is saved straight away." />
      {loadError !== null && <ErrorState error={loadError} onRetry={() => { hospitals.reload(); buildings.reload(); floors.reload(); }} />}
      {loadError === null && !floors.data && <LoadingState />}
      {floors.data && floors.data.length === 0 && (
        <Card><EmptyState>No floors yet. Add one in the <Link href="/facilities">Facility Manager</Link>.</EmptyState></Card>
      )}
      {floors.data && floors.data.length > 0 && (
        <Card className="mb-[14px]">
          <label htmlFor="graph-floor" className="mt-0">Floor</label>
          <select id="graph-floor" value={floorId ?? ""}
                  onChange={(e) => router.replace(`/graph?floor=${e.target.value}`, { scroll: false })}>
            <option value="" disabled>Choose a floor</option>
            {options.map((f) => <option key={f.id} value={f.id}>{label(f)}</option>)}
          </select>
        </Card>
      )}
      {floorId !== null && floors.data && !floor && (
        <Card><EmptyState>That floor was not found (it may have been deleted). Choose another floor.</EmptyState></Card>
      )}
      {floor && graph.error !== null && <ErrorState error={graph.error} onRetry={graph.reload} />}
      {floor && graph.error === null && graph.data?.floor_id !== floor.id && <LoadingState />}
      {floor && graph.data && graph.data.floor_id === floor.id && (
        <FloorEditor
          key={floor.id}
          floor={floor}
          graph={graph.data}
          otherFloors={(floors.data ?? []).filter((f) => f.building_id === floor.building_id && f.id !== floor.id)}
        />
      )}
    </>
  );
}

type Selection = { kind: "place"; id: number } | { kind: "path"; id: number } | null;
type Open =
  | { kind: "add-place" }
  | { kind: "add-path"; from: number; to: number }
  | { kind: "delete-place"; place: GraphNode }
  | { kind: "delete-path"; path: GraphEdge }
  | null;

function FloorEditor({ floor, graph, otherFloors }: { floor: Floor; graph: FloorGraph; otherFloors: Floor[] }) {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const [nodes, setNodes] = useState<CanvasNode[]>(() => buildCanvasNodes(graph.nodes, graph.edges));
  const [paths, setPaths] = useState<GraphEdge[]>(graph.edges);
  const [selection, setSelection] = useState<Selection>(null);
  const [open, setOpen] = useState<Open>(null);
  const [moveError, setMoveError] = useState<unknown>(null);

  const places = useMemo(() => nodes.flatMap((n) => (n.type === "place" ? [n.data.place] : [])), [nodes]);
  const placeName = useCallback((id: number) => places.find((p) => p.id === id)?.name ?? `#${id}`, [places]);

  const edges = useMemo(() => buildCanvasEdges(paths, selection?.kind === "path" ? selection.id : null), [paths, selection]);
  // Places and paths changed: draw the rooms again (sizes and scale may change).
  const redraw = useCallback((nextPlaces: GraphNode[], nextPaths: GraphEdge[]) => {
    setNodes((current) => buildCanvasNodes(nextPlaces, nextPaths, current));
  }, []);

  const updatePlace = useCallback((saved: GraphNode) => {
    setNodes((current) => {
      const nextPlaces = current.flatMap((n) => (n.type === "place" ? [n.data.place.id === saved.id ? saved : n.data.place] : []));
      return buildCanvasNodes(nextPlaces, paths, current);
    });
  }, [paths]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  // React Flow passes a native mouse or touch event here, so the event is not used.
  const onNodeDragStop = useCallback((_event: unknown, node: CanvasNode) => {
    if (node.type !== "place") return;
    // The canvas is in pixels; the place is saved in the floor's own units.
    const { pxPerUnit } = canvasScale(places, paths);
    const size = { width: node.measured?.width ?? node.width ?? 0, height: node.measured?.height ?? node.height ?? 0 };
    const centre = centreFromCanvas(node.position, size, pxPerUnit);
    const x = roundPosition(centre.x);
    const y = roundPosition(centre.y);
    setMoveError(null);
    apiRequest<GraphNode>(`/nodes/${node.id}`, { method: "PATCH", body: { x, y } })
      .then(updatePlace, (error: unknown) => setMoveError(error));
  }, [updatePlace, places, paths]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target && connection.source !== connection.target) {
      setOpen({ kind: "add-path", from: Number(connection.source), to: Number(connection.target) });
    }
  }, []);

  const onNodeClick = useCallback<NodeMouseHandler<CanvasNode>>((_event, node) => {
    if (node.id !== OUTLINE_ID) setSelection({ kind: "place", id: Number(node.id) });
  }, []);
  const onEdgeClick = useCallback((_event: unknown, edge: Edge) => setSelection({ kind: "path", id: Number(edge.id) }), []);
  const onPaneClick = useCallback(() => setSelection(null), []);

  const selectedPlace = selection?.kind === "place" ? places.find((p) => p.id === selection.id) ?? null : null;
  const selectedPath = selection?.kind === "path" ? paths.find((p) => p.id === selection.id) ?? null : null;
  const close = () => setOpen(null);

  return (
    <>
      <div className="grid gap-[14px] lg:grid-cols-[2fr_1fr]">
        <Card>
          <div className="h-[460px] w-full" role="region" aria-label={`Floor plan of ${floor.name}`}>
            {nodes.length === 0
              ? <EmptyState>This floor has no places yet. {canEdit ? "Add the first one, or import a floor file in the Facility Manager." : ""}</EmptyState>
              : (
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={onNodesChange}
                  onNodeDragStop={onNodeDragStop}
                  onConnect={onConnect}
                  onNodeClick={onNodeClick}
                  onEdgeClick={onEdgeClick}
                  onPaneClick={onPaneClick}
                  connectionMode={ConnectionMode.Loose}
                  nodesDraggable={canEdit}
                  nodesConnectable={canEdit}
                  deleteKeyCode={null}
                  minZoom={0.1}
                  fitView
                >
                  {/* A 5 m grid, like the Live Simulation plan. */}
                  <Background variant={BackgroundVariant.Lines} gap={PX_PER_METRE * 5} color="#E2E8F0" />
                </ReactFlow>
              )}
          </div>
          <p className="sm mb-0">
            Rooms are drawn at their size in metres (or a size from their type); a grid square is 5 m. Numbers are
            path lengths in metres. Stairs and ramps are yellow, exits green, evacuation lifts green-edged, blocked places red.
            {canEdit && " Drag a place to move it; drag from its dot to another place to add a path."}
          </p>
          {moveError !== null && <p role="alert" className="field-error">Moving was not saved: {describeError(moveError)}</p>}
        </Card>

        <Card>
          {!selectedPlace && !selectedPath && (
            <>
              <h2>Nothing selected</h2>
              <p className="sm">Click a place or a path on the map, or choose one from the lists below.</p>
            </>
          )}
          {selectedPlace && (
            <>
              <h2>Selected: {selectedPlace.name}</h2>
              {canEdit
                ? <PlaceForm key={selectedPlace.id} floorId={floor.id} place={selectedPlace} onSaved={updatePlace} />
                : <p>{selectedPlace.type} · capacity {selectedPlace.capacity}{formatSize(selectedPlace) ? ` · ${formatSize(selectedPlace)}` : ""}{selectedPlace.is_blocked ? " · blocked" : ""}</p>}
              {isVertical(selectedPlace.type) && (
                <>
                  <h3 className="mb-1 text-[14px] font-bold text-ink">Links to other floors</h3>
                  <FloorLinks place={selectedPlace} floors={otherFloors} canEdit={canEdit} onChanged={() => undefined} />
                </>
              )}
              {canEdit && (
                <p><button type="button" className="btn l" onClick={() => setOpen({ kind: "delete-place", place: selectedPlace })}>Delete place</button></p>
              )}
            </>
          )}
          {selectedPath && (
            <>
              <h2>Selected path</h2>
              {canEdit
                ? <PathForm key={selectedPath.id} path={selectedPath}
                            label={`${placeName(selectedPath.from_node_id)} – ${placeName(selectedPath.to_node_id)}`}
                            onSaved={(saved) => setPaths((current) => current.map((p) => (p.id === saved.id ? saved : p)))} />
                : <p>{placeName(selectedPath.from_node_id)} – {placeName(selectedPath.to_node_id)} · {selectedPath.distance} m</p>}
              {canEdit && (
                <p><button type="button" className="btn l" onClick={() => setOpen({ kind: "delete-path", path: selectedPath })}>Delete path</button></p>
              )}
            </>
          )}
          {canEdit && (
            <p className="flex flex-wrap gap-2 border-t border-line pt-3">
              <button type="button" className="btn" onClick={() => setOpen({ kind: "add-place" })}>Add place</button>
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-[14px]">
        <h2>Places ({places.length})</h2>
        {places.length === 0 ? <EmptyState>No places yet.</EmptyState> : (
          <DataTable caption="Places" columns={["Name", "Type", "Capacity", "Size", "State", ""]}
            rows={[...places].sort((a, b) => a.name.localeCompare(b.name)).map((place) => ({
              key: place.id,
              cells: [place.name, place.type, place.capacity, formatSize(place) ?? "–",
                place.is_blocked ? <Tag key="s" tone="b">Blocked</Tag> : place.is_evacuation_lift ? <Tag key="s" tone="ok">Evacuation lift</Tag> : "–",
                <button key="sel" type="button" className="btn l" onClick={() => setSelection({ kind: "place", id: place.id })}>
                  {canEdit ? "Edit" : "View"}
                </button>],
            }))} />
        )}
        <h2 className="mt-4">Paths on this floor ({paths.length})</h2>
        {paths.length === 0 ? <EmptyState>No paths yet.</EmptyState> : (
          <DataTable caption="Paths" columns={["From – to", "Length (m)", "Width (m)", "People/min", "Access", ""]}
            rows={paths.map((path) => ({
              key: path.id,
              cells: [`${placeName(path.from_node_id)} – ${placeName(path.to_node_id)}`, path.distance, path.width, path.max_flow,
                [path.wheelchair_accessible && "wheelchair", path.stretcher_accessible && "stretcher"].filter(Boolean).join(", ") || "walking only",
                <button key="sel" type="button" className="btn l" onClick={() => setSelection({ kind: "path", id: path.id })}>
                  {canEdit ? "Edit" : "View"}
                </button>],
            }))} />
        )}
        {canEdit && places.length >= 2 && <AddPathByList places={places} onChoose={(from, to) => setOpen({ kind: "add-path", from, to })} />}
      </Card>

      <Dialog open={open?.kind === "add-place"} title="Add place" onClose={close}>
        {open?.kind === "add-place" && (
          <>
            <p className="sm mt-0">It appears 20 m to the right of the plan; drag it into position.</p>
            <PlaceForm floorId={floor.id} position={newPlacePosition(places, 20 * drawingScale(places, paths).scale)}
                       onSaved={(saved) => { redraw([...places, saved], paths); setSelection({ kind: "place", id: saved.id }); close(); }}
                       onCancel={close} />
          </>
        )}
      </Dialog>
      <Dialog open={open?.kind === "add-path"} title="Add path" onClose={close}>
        {open?.kind === "add-path" && (
          <PathForm fromId={open.from} toId={open.to} label={`${placeName(open.from)} – ${placeName(open.to)}`}
                    onSaved={(saved) => { const next = [...paths, saved]; setPaths(next); redraw(places, next); setSelection({ kind: "path", id: saved.id }); close(); }}
                    onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "delete-place"} title="Delete place" onClose={close}>
        {open?.kind === "delete-place" && (
          <DeleteConfirm what={`the place “${open.place.name}” and its paths`} path={`/nodes/${open.place.id}`} onCancel={close}
            onDeleted={() => {
              const id = open.place.id;
              const nextPaths = paths.filter((p) => p.from_node_id !== id && p.to_node_id !== id);
              setPaths(nextPaths);
              redraw(places.filter((p) => p.id !== id), nextPaths);
              setSelection(null);
              close();
            }} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "delete-path"} title="Delete path" onClose={close}>
        {open?.kind === "delete-path" && (
          <DeleteConfirm what={`the path ${placeName(open.path.from_node_id)} – ${placeName(open.path.to_node_id)}`}
            path={`/edges/${open.path.id}`} onCancel={close}
            onDeleted={() => {
              const id = open.path.id;
              const nextPaths = paths.filter((p) => p.id !== id);
              setPaths(nextPaths);
              redraw(places, nextPaths);
              setSelection(null);
              close();
            }} />
        )}
      </Dialog>
    </>
  );
}

/** Adding a path without dragging (keyboard users). */
function AddPathByList({ places, onChoose }: { places: GraphNode[]; onChoose: (from: number, to: number) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const sorted = [...places].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-[160px] flex-1">
        <label htmlFor="path-from">New path from</label>
        <select id="path-from" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Choose</option>
          {sorted.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="min-w-[160px] flex-1">
        <label htmlFor="path-to">to</label>
        <select id="path-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose</option>
          {sorted.filter((p) => String(p.id) !== from).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <button type="button" className="btn" disabled={!from || !to || from === to}
              onClick={() => onChoose(Number(from), Number(to))}>Add path</button>
    </div>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <GraphBuilder />
    </Suspense>
  );
}
