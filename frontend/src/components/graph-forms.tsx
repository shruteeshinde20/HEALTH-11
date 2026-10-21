"use client";

// Forms for places (nodes) and paths (edges), and links between floors.
// Limits mirror backend/app/graph_api.py; the backend validates again.

import { useEffect, useState, type FormEvent } from "react";

import { apiAll, apiRequest } from "@/lib/client/api.ts";
import { fieldErrors } from "@/lib/client/field-errors.ts";
import { useAction } from "@/lib/client/use-action.ts";
import type { Floor, GraphEdge, GraphNode } from "@/lib/shared/api-types.ts";
import { describeError } from "@/lib/shared/errors.ts";
import { NODE_TYPES } from "@/lib/shared/files.ts";
import { isVertical, parseNumber } from "@/lib/shared/graph.ts";
import { readSize } from "@/lib/shared/place-size.ts";

import { Buttons, Field, FormError } from "./facility-forms.tsx";

const MAX_COUNT = 100_000;

// --- Place --------------------------------------------------------------------------------

export function PlaceForm({ floorId, place, position, onSaved, onCancel }: {
  floorId: number;
  place?: GraphNode;
  position?: { x: number; y: number };   // for a new place
  onSaved: (saved: GraphNode) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(place?.name ?? "");
  const [type, setType] = useState(place?.type ?? "");
  const [capacity, setCapacity] = useState(place ? String(place.capacity) : "");
  const [blocked, setBlocked] = useState(place?.is_blocked ?? false);
  const [evacuationLift, setEvacuationLift] = useState(place?.is_evacuation_lift ?? false);
  const [width, setWidth] = useState(place?.width_m != null ? String(place.width_m) : "");
  const [length, setLength] = useState(place?.length_m != null ? String(place.length_m) : "");
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  const capacityValue = capacity.trim() === "" ? 0 : parseNumber(capacity, 0, MAX_COUNT, true);
  const capacityValid = capacityValue !== null && !Number.isNaN(capacityValue);
  const size = readSize(width, length);
  const complete = name.trim() !== "" && type !== "" && capacityValid && size.ok;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || !size.ok) return;
    const body = {
      name: name.trim(), type, capacity: capacityValue, is_blocked: blocked,
      is_evacuation_lift: type === "lift" && evacuationLift,
      width_m: size.width_m, length_m: size.length_m,
    };
    const saved = await run(() => place
      ? apiRequest<GraphNode>(`/nodes/${place.id}`, { method: "PATCH", body })
      : apiRequest<GraphNode>("/nodes", { method: "POST", body: { floor_id: floorId, ...body, ...position } }));
    if (saved) onSaved(saved);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="place-name" label="Name" error={fields.name}>
        <input id="place-name" required maxLength={150} value={name} onChange={(e) => setName(e.target.value)}
               aria-invalid={Boolean(fields.name)} />
      </Field>
      <Field id="place-type" label="Type" error={fields.type}>
        <select id="place-type" required value={type} onChange={(e) => setType(e.target.value)}>
          <option value="" disabled>Choose a type</option>
          {NODE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </Field>
      <Field id="place-capacity" label="Capacity (people, optional)" error={fields.capacity ?? (!capacityValid ? "Enter a whole number from 0 to 100,000." : undefined)}>
        <input id="place-capacity" type="number" min={0} max={MAX_COUNT} step={1} value={capacity}
               onChange={(e) => setCapacity(e.target.value)} aria-invalid={!capacityValid} />
      </Field>
      <fieldset className="mt-3">
        <legend className="font-bold">Size (optional)</legend>
        <p id="place-size-hint" className="sm mt-1 mb-2">
          In metres, used to draw the floor plan. Routes use the paths&apos; distances, not this.
        </p>
        <Field id="place-width" label="Width in metres (left to right)"
               error={!size.ok && size.field === "width" ? size.message : fields.width_m}>
          <input id="place-width" inputMode="decimal" autoComplete="off" value={width}
                 onChange={(e) => setWidth(e.target.value)} aria-describedby="place-size-hint"
                 aria-invalid={(!size.ok && size.field === "width") || Boolean(fields.width_m)} />
        </Field>
        <Field id="place-length" label="Length in metres (top to bottom)"
               error={!size.ok && size.field === "length" ? size.message : fields.length_m}>
          <input id="place-length" inputMode="decimal" autoComplete="off" value={length}
                 onChange={(e) => setLength(e.target.value)} aria-describedby="place-size-hint"
                 aria-invalid={(!size.ok && size.field === "length") || Boolean(fields.length_m)} />
        </Field>
      </fieldset>
      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} />
        Blocked (cannot be used)
      </label>
      {type === "lift" && (
        <label className="flex items-center gap-2 text-tx">
          <input type="checkbox" className="w-auto" checked={evacuationLift}
                 onChange={(e) => setEvacuationLift(e.target.checked)} />
          Evacuation lift (protected; usable during fire or smoke)
        </label>
      )}
      <FormError error={error} />
      <Buttons busy={busy} disabled={!complete} label={place ? "Save" : "Add place"} onCancel={onCancel} />
    </form>
  );
}

// --- Path ---------------------------------------------------------------------------------

export function PathForm({ fromId, toId, path, label, onSaved, onCancel }: {
  fromId?: number;
  toId?: number;
  path?: GraphEdge;
  label: string;          // e.g. "C1 – S1"
  onSaved: (saved: GraphEdge) => void;
  onCancel?: () => void;
}) {
  const [distance, setDistance] = useState(path ? String(path.distance) : "");
  const [width, setWidth] = useState(path ? String(path.width) : "");
  const [maxFlow, setMaxFlow] = useState(path ? String(path.max_flow) : "");
  const [wheelchair, setWheelchair] = useState(path?.wheelchair_accessible ?? true);
  const [stretcher, setStretcher] = useState(path?.stretcher_accessible ?? true);
  const [blocked, setBlocked] = useState(path?.is_blocked ?? false);
  const { busy, error, run } = useAction();
  const fields = fieldErrors(error);

  const distanceValue = parseNumber(distance, 0, Number.MAX_VALUE);
  const widthValue = parseNumber(width, Number.MIN_VALUE, Number.MAX_VALUE);
  const flowValue = parseNumber(maxFlow, 1, MAX_COUNT, true);
  const ok = (value: number | null) => value !== null && !Number.isNaN(value);
  const complete = ok(distanceValue) && ok(widthValue) && ok(flowValue);
  const bad = (raw: string, value: number | null) => raw.trim() !== "" && Number.isNaN(value);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) return;
    const body = {
      distance: distanceValue, width: widthValue, max_flow: flowValue,
      wheelchair_accessible: wheelchair, stretcher_accessible: stretcher, is_blocked: blocked,
    };
    const saved = await run(() => path
      ? apiRequest<GraphEdge>(`/edges/${path.id}`, { method: "PATCH", body })
      : apiRequest<GraphEdge>("/edges", { method: "POST", body: { from_node_id: fromId, to_node_id: toId, ...body } }));
    if (saved) onSaved(saved);
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="mt-0">Path <strong>{label}</strong> (works in both directions).</p>
      <Field id="path-distance" label="Length (metres)"
             error={fields.distance ?? (bad(distance, distanceValue) ? "Enter 0 or more metres." : undefined)}>
        <input id="path-distance" type="number" min={0} step="any" required value={distance}
               onChange={(e) => setDistance(e.target.value)} aria-invalid={bad(distance, distanceValue)} />
      </Field>
      <Field id="path-width" label="Width (metres)"
             error={fields.width ?? (bad(width, widthValue) ? "Enter a width above 0." : undefined)}>
        <input id="path-width" type="number" min={0} step="any" required value={width}
               onChange={(e) => setWidth(e.target.value)} aria-invalid={bad(width, widthValue)} />
      </Field>
      <Field id="path-flow" label="Capacity (people per minute)" hint="How many people can enter this path per minute."
             error={fields.max_flow ?? (bad(maxFlow, flowValue) ? "Enter a whole number from 1 to 100,000." : undefined)}>
        <input id="path-flow" type="number" min={1} max={MAX_COUNT} step={1} required value={maxFlow}
               onChange={(e) => setMaxFlow(e.target.value)} aria-describedby="path-flow-hint"
               aria-invalid={bad(maxFlow, flowValue)} />
      </Field>
      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={wheelchair} onChange={(e) => setWheelchair(e.target.checked)} />
        Wheelchair accessible
      </label>
      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={stretcher} onChange={(e) => setStretcher(e.target.checked)} />
        Stretcher accessible
      </label>
      <label className="flex items-center gap-2 text-tx">
        <input type="checkbox" className="w-auto" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} />
        Blocked (cannot be used)
      </label>
      <FormError error={error} />
      <Buttons busy={busy} disabled={!complete} label={path ? "Save" : "Add path"} onCancel={onCancel} />
    </form>
  );
}

// --- Links to other floors ------------------------------------------------------------------

type Candidate = GraphNode & { floorName: string };

/**
 * Paths between floors join a stair, ramp or lift on this floor with one on
 * another floor of the same building (the backend enforces this).
 */
export function FloorLinks({ place, floors, canEdit, onChanged }: {
  place: GraphNode;
  floors: Floor[];            // the other floors of this building
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [links, setLinks] = useState<{ edge: GraphEdge; other: Candidate }[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState<number | null>(null);
  const floorKey = floors.map((f) => f.id).join(",");

  useEffect(() => {
    const controller = new AbortController();
    const floorName = new Map(floors.map((f) => [f.id, f.name]));
    Promise.all([
      apiAll<GraphEdge>("/edges", { node_id: place.id }, controller.signal),
      ...floors.map((floor) => apiAll<GraphNode>("/nodes", { floor_id: floor.id }, controller.signal)),
    ]).then(([edges, ...perFloor]) => {
      const others = (perFloor as GraphNode[][]).flat()
        .map((node) => ({ ...node, floorName: floorName.get(node.floor_id) ?? "" }));
      const byId = new Map(others.map((node) => [node.id, node]));
      setCandidates(others.filter((node) => isVertical(node.type)));
      setLinks((edges as GraphEdge[]).flatMap((edge) => {
        const otherId = edge.from_node_id === place.id ? edge.to_node_id : edge.from_node_id;
        const other = byId.get(otherId);
        return other ? [{ edge, other }] : [];
      }));
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error);
    });
    return () => controller.abort();
    // floorKey stands for `floors`; attempt reloads after a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.id, floorKey, attempt]);

  if (floors.length === 0) return <p className="sm">This building has only one floor.</p>;
  if (loadError !== null) return <p role="alert" className="field-error">{describeError(loadError)}</p>;
  if (links === null) return <p className="sm" role="status">Loading links…</p>;

  const linked = new Set(links.map((link) => link.other.id));
  const available = candidates.filter((node) => !linked.has(node.id));
  const chosen = available.find((node) => node.id === target) ?? null;

  return (
    <div>
      {links.length === 0
        ? <p className="sm">Not linked to another floor yet.</p>
        : (
          <ul className="my-2 pl-5">
            {links.map(({ edge, other }) => (
              <li key={edge.id}>{other.name} on {other.floorName} · {edge.distance} m{edge.is_blocked ? " · blocked" : ""}</li>
            ))}
          </ul>
        )}
      {canEdit && (available.length === 0
        ? <p className="sm">No stair, ramp or lift on another floor of this building is left to link.</p>
        : (
          <>
            <label htmlFor="link-target">Link to</label>
            <select id="link-target" value={target ?? ""} onChange={(e) => setTarget(Number(e.target.value) || null)}>
              <option value="">Choose a stair, ramp or lift</option>
              {available.map((node) => (
                <option key={node.id} value={node.id}>{node.name} ({node.type}) on {node.floorName}</option>
              ))}
            </select>
            {chosen && (
              <PathForm key={chosen.id} fromId={place.id} toId={chosen.id} label={`${place.name} – ${chosen.name}`}
                        onSaved={() => { setTarget(null); setAttempt((n) => n + 1); onChanged(); }} />
            )}
          </>
        ))}
    </div>
  );
}
