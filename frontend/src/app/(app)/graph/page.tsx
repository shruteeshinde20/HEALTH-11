"use client";

// Graph Builder (docs/design/preview.html "graph"): the floor plan as places
// (nodes) and paths (edges) on a React Flow canvas, edited through the API.
// Everything on the canvas can also be done from the lists below it with the
// keyboard.

import {
  ConnectionMode, Handle, Position, ReactFlow, applyNodeChanges,
  type Connection, type Edge, type Node, type NodeChange, type NodeMouseHandler, type NodeProps,
} from "@xyflow/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";

import { Dialog } from "@/components/dialog.tsx";
import { DeleteConfirm } from "@/components/facility-forms.tsx";
import { FloorLinks, PathForm, PlaceForm } from "@/components/graph-forms.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Tag } from "@/components/ui.tsx";
import { apiRequest } from "@/lib/client/api.ts";
import { useUser } from "@/lib/client/session.tsx";
import { useAll, useApi } from "@/lib/client/use-api.ts";
import type { Building, Floor, FloorGraph, GraphEdge, GraphNode, Hospital } from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import { isVertical, newPlacePosition, placeColour, roundPosition } from "@/lib/shared/graph.ts";
import { formatSize } from "@/lib/shared/place-size.ts";

// --- Canvas node ---------------------------------------------------------------------------

type PlaceNode = Node<{ place: GraphNode }, "place">;

function PlaceNodeView({ data, selected }: NodeProps<PlaceNode>) {
  const { place } = data;
  return (
    <div
      title={`${place.name} (${place.type}${place.is_blocked ? ", blocked" : ""})`}
      className="flex h-[40px] min-w-[40px] items-center justify-center rounded-full px-2 text-[11px] text-tx"
      style={{
        background: placeColour(place.type, place.is_blocked),
        border: selected ? "2.5px solid #1E3A5F" : "1.2px solid #94A3B8",
      }}
    >
      {place.name}
      <Handle type="source" position={Position.Right} aria-label={`Connect ${place.name}`} />
    </div>
  );
}

// Defined outside the component, as the React Flow docs advise.
const nodeTypes = { place: PlaceNodeView };

const toFlowNode = (place: GraphNode): PlaceNode => ({
  id: String(place.id), type: "place", position: { x: place.x, y: place.y }, data: { place },
});

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
  const [nodes, setNodes] = useState<PlaceNode[]>(() => graph.nodes.map(toFlowNode));
  const [paths, setPaths] = useState<GraphEdge[]>(graph.edges);
  const [selection, setSelection] = useState<Selection>(null);
  const [open, setOpen] = useState<Open>(null);
  const [moveError, setMoveError] = useState<unknown>(null);

  const places = useMemo(() => nodes.map((n) => n.data.place), [nodes]);
  const placeName = useCallback((id: number) => places.find((p) => p.id === id)?.name ?? `#${id}`, [places]);

  const edges: Edge[] = useMemo(() => paths.map((path) => ({
    id: String(path.id),
    source: String(path.from_node_id),
    target: String(path.to_node_id),
    type: "straight",
    label: `${path.distance}`,
    selected: selection?.kind === "path" && selection.id === path.id,
    style: {
      stroke: path.is_blocked ? "#DC2626" : selection?.kind === "path" && selection.id === path.id ? "#5FA3D9" : "#CBD5E1",
      strokeWidth: selection?.kind === "path" && selection.id === path.id ? 4 : 2,
      strokeDasharray: path.is_blocked ? "6 4" : undefined,
    },
  })), [paths, selection]);

  const updatePlace = useCallback((saved: GraphNode) => {
    setNodes((current) => current.map((n) => (n.id === String(saved.id) ? { ...n, data: { place: saved } } : n)));
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<PlaceNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  // React Flow passes a native mouse or touch event here, so the event is not used.
  const onNodeDragStop = useCallback((_event: unknown, node: PlaceNode) => {
    const x = roundPosition(node.position.x);
    const y = roundPosition(node.position.y);
    setMoveError(null);
    apiRequest<GraphNode>(`/nodes/${node.id}`, { method: "PATCH", body: { x, y } })
      .then(updatePlace, (error: unknown) => setMoveError(error));
  }, [updatePlace]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target && connection.source !== connection.target) {
      setOpen({ kind: "add-path", from: Number(connection.source), to: Number(connection.target) });
    }
  }, []);

  const onNodeClick = useCallback<NodeMouseHandler<PlaceNode>>((_event, node) => {
    setSelection({ kind: "place", id: Number(node.id) });
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
                  minZoom={0.2}
                  fitView
                />
              )}
          </div>
          <p className="sm mb-0">
            Numbers are path lengths in metres. Stairs and ramps are yellow, exits green, blocked places red.
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
            <p className="sm mt-0">It appears to the right of the plan; drag it into position.</p>
            <PlaceForm floorId={floor.id} position={newPlacePosition(places)}
                       onSaved={(saved) => { setNodes((c) => [...c, toFlowNode(saved)]); setSelection({ kind: "place", id: saved.id }); close(); }}
                       onCancel={close} />
          </>
        )}
      </Dialog>
      <Dialog open={open?.kind === "add-path"} title="Add path" onClose={close}>
        {open?.kind === "add-path" && (
          <PathForm fromId={open.from} toId={open.to} label={`${placeName(open.from)} – ${placeName(open.to)}`}
                    onSaved={(saved) => { setPaths((c) => [...c, saved]); setSelection({ kind: "path", id: saved.id }); close(); }}
                    onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "delete-place"} title="Delete place" onClose={close}>
        {open?.kind === "delete-place" && (
          <DeleteConfirm what={`the place “${open.place.name}” and its paths`} path={`/nodes/${open.place.id}`} onCancel={close}
            onDeleted={() => {
              const id = open.place.id;
              setNodes((c) => c.filter((n) => n.id !== String(id)));
              setPaths((c) => c.filter((p) => p.from_node_id !== id && p.to_node_id !== id));
              setSelection(null);
              close();
            }} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "delete-path"} title="Delete path" onClose={close}>
        {open?.kind === "delete-path" && (
          <DeleteConfirm what={`the path ${placeName(open.path.from_node_id)} – ${placeName(open.path.to_node_id)}`}
            path={`/edges/${open.path.id}`} onCancel={close}
            onDeleted={() => { const id = open.path.id; setPaths((c) => c.filter((p) => p.id !== id)); setSelection(null); close(); }} />
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
