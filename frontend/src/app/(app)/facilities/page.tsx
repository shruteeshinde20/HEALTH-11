"use client";

// Facility Manager (docs/design/preview.html "fac"): hospitals, buildings and
// floors, with floor file import and export. Everything comes from the API.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Dialog } from "@/components/dialog.tsx";
import {
  BuildingForm, DeleteConfirm, FloorExportLinks, FloorForm, FloorImport, HospitalForm,
} from "@/components/facility-forms.tsx";
import { OpenStreetMapSearch } from "@/components/openstreetmap-search.tsx";
import { Card, DataTable, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui.tsx";
import { useUser } from "@/lib/client/session.tsx";
import { useAll } from "@/lib/client/use-api.ts";
import type { Building, Floor, Hospital } from "@/lib/shared/api-types.ts";
import { formatLocation } from "@/lib/shared/location.ts";
import { APP_PAGES } from "@/lib/shared/pages.ts";

const graphBuilder = APP_PAGES.find((page) => page.href === "/graph");

type Open =
  | { kind: "add-hospital" }
  | { kind: "edit-hospital"; hospital: Hospital }
  | { kind: "openstreetmap"; hospital: Hospital }
  | { kind: "delete-hospital"; hospital: Hospital }
  | { kind: "add-building"; hospital: Hospital }
  | { kind: "edit-building"; building: Building }
  | { kind: "delete-building"; building: Building }
  | { kind: "add-floor"; building: Building }
  | { kind: "edit-floor"; floor: Floor }
  | { kind: "delete-floor"; floor: Floor }
  | { kind: "import"; floor: Floor | null }
  | null;

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function FacilityManager() {
  const user = useUser();
  const canEdit = user.role !== "Staff User";
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = Number(params.get("hospital")) || null;

  const hospitals = useAll<Hospital>("/hospitals");
  const buildings = useAll<Building>("/buildings");
  const floors = useAll<Floor>("/floors");
  const [open, setOpen] = useState<Open>(null);

  const close = () => setOpen(null);
  const reloadAll = () => {
    hospitals.reload();
    buildings.reload();
    floors.reload();
  };
  const saved = () => {
    close();
    reloadAll();
  };
  const select = (id: number | null) => router.replace(id ? `/facilities?hospital=${id}` : "/facilities", { scroll: false });

  const buildingsOf = (hospitalId: number) =>
    (buildings.data ?? []).filter((b) => b.hospital_id === hospitalId).sort((a, b) => a.name.localeCompare(b.name));
  const floorsOf = (buildingId: number) =>
    (floors.data ?? []).filter((f) => f.building_id === buildingId).sort((a, b) => a.floor_number - b.floor_number);
  const floorCount = (hospitalId: number) =>
    buildingsOf(hospitalId).reduce((sum, building) => sum + floorsOf(building.id).length, 0);

  const selected = hospitals.data?.find((h) => h.id === selectedId) ?? null;
  const loadError = hospitals.error ?? buildings.error ?? floors.error;
  const firstLoad = !hospitals.data || !buildings.data || !floors.data;

  const floorLabel = (floor: Floor) => {
    const building = buildings.data?.find((b) => b.id === floor.building_id);
    const hospital = hospitals.data?.find((h) => h.id === building?.hospital_id);
    return `${hospital?.name ?? "?"} / ${building?.name ?? "?"} / ${floor.name}`;
  };

  return (
    <>
      <PageHeader title="Facility Manager" subtitle="Hospitals, buildings and floors." />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0">Hospitals</h2>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn l" onClick={() => setOpen({ kind: "import", floor: null })}
                      disabled={!floors.data?.length}
                      title={floors.data?.length ? undefined : "Add a floor first"}>
                Import CSV / GeoJSON
              </button>
              <button type="button" className="btn" onClick={() => setOpen({ kind: "add-hospital" })}>Add hospital</button>
            </div>
          )}
        </div>

        {loadError !== null && <ErrorState error={loadError} onRetry={reloadAll} />}
        {loadError === null && firstLoad && <LoadingState />}
        {!firstLoad && hospitals.data && (hospitals.data.length === 0
          ? (
            <EmptyState>
              No hospitals yet.{" "}
              {canEdit ? <>Add one, or follow the <Link href="/onboarding">setup guide</Link>.</>
                       : "Ask an Administrator or Emergency Commander to add one."}
            </EmptyState>
          )
          : (
            <DataTable
              caption="Hospitals"
              columns={["Name", "Buildings", "Floors", "Address", ""]}
              rows={hospitals.data.map((hospital) => ({
                key: hospital.id,
                cells: [
                  hospital.name,
                  buildingsOf(hospital.id).length,
                  floorCount(hospital.id),
                  hospital.address ?? "–",
                  <button key="open" type="button" className="btn l"
                          aria-pressed={hospital.id === selectedId}
                          onClick={() => select(hospital.id === selectedId ? null : hospital.id)}>
                    {hospital.id === selectedId ? "Close" : "Buildings & floors"}
                  </button>,
                ],
              }))}
            />
          ))}
      </Card>

      {selected && buildings.data && floors.data && (
        <Card className="mt-[14px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0">{selected.name}</h2>
              <p className="sm my-1">
                {selected.address ?? "No address"} · Time zone {selected.timezone}
                {" · "}{formatLocation(selected.latitude, selected.longitude) || "No map position"}
              </p>
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit-hospital", hospital: selected })}>
                  Edit hospital
                </button>
                <button type="button" className="btn l" disabled={selected.latitude == null}
                        title={selected.latitude == null ? "Add the map position first (Edit hospital)" : undefined}
                        onClick={() => setOpen({ kind: "openstreetmap", hospital: selected })}>
                  Find on OpenStreetMap
                </button>
                <button type="button" className="btn l" onClick={() => setOpen({ kind: "delete-hospital", hospital: selected })}>
                  Delete hospital
                </button>
                <button type="button" className="btn" onClick={() => setOpen({ kind: "add-building", hospital: selected })}>
                  Add building
                </button>
              </div>
            )}
          </div>

          {buildingsOf(selected.id).length === 0 && <EmptyState>No buildings in this hospital yet.</EmptyState>}
          {buildingsOf(selected.id).map((building) => (
            <section key={building.id} className="mt-4 border-t border-line pt-3" aria-label={`Building ${building.name}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="m-0 text-[14px] font-bold text-ink">{building.name}</h3>
                  <p className="sm my-0">
                    {building.description ? `${building.description} · ` : ""}
                    {count(floorsOf(building.id).length, "floor", "floors")}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit-building", building })}>Edit</button>
                    <button type="button" className="btn l" onClick={() => setOpen({ kind: "delete-building", building })}>Delete</button>
                    <button type="button" className="btn" onClick={() => setOpen({ kind: "add-floor", building })}>Add floor</button>
                  </div>
                )}
              </div>
              {floorsOf(building.id).length > 0 && (
                <DataTable
                  caption={`Floors of ${building.name}`}
                  columns={["No.", "Floor", "Height (m)", "Floor file", ""]}
                  rows={floorsOf(building.id).map((floor) => ({
                    key: floor.id,
                    cells: [
                      floor.floor_number,
                      floor.name,
                      floor.elevation_metres ?? "–",
                      <FloorExportLinks key="export" floorId={floor.id} />,
                      <span key="actions" className="flex flex-wrap gap-2">
                        {graphBuilder?.ready && <Link href={`${graphBuilder.href}?floor=${floor.id}`}>Open map</Link>}
                        {canEdit && (
                          <>
                            <button type="button" className="btn l" onClick={() => setOpen({ kind: "import", floor })}>Import</button>
                            <button type="button" className="btn l" onClick={() => setOpen({ kind: "edit-floor", floor })}>Edit</button>
                            <button type="button" className="btn l" onClick={() => setOpen({ kind: "delete-floor", floor })}>Delete</button>
                          </>
                        )}
                      </span>,
                    ],
                  }))}
                />
              )}
            </section>
          ))}
        </Card>
      )}

      <Dialog open={open?.kind === "add-hospital"} title="Add hospital" onClose={close}>
        <HospitalForm onSaved={(hospital) => { saved(); select(hospital.id); }} onCancel={close} />
      </Dialog>
      <Dialog open={open?.kind === "edit-hospital"} title="Edit hospital" onClose={close}>
        {open?.kind === "edit-hospital" && <HospitalForm hospital={open.hospital} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "openstreetmap"} title="Find on OpenStreetMap" onClose={close}>
        {open?.kind === "openstreetmap" && <OpenStreetMapSearch hospital={open.hospital} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "delete-hospital"} title="Delete hospital" onClose={close}>
        {open?.kind === "delete-hospital" && (
          <DeleteConfirm what={`the hospital “${open.hospital.name}”`} path={`/hospitals/${open.hospital.id}`}
                         onDeleted={() => { saved(); select(null); }} onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "add-building"} title="Add building" onClose={close}>
        {open?.kind === "add-building" && <BuildingForm hospitalId={open.hospital.id} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "edit-building"} title="Edit building" onClose={close}>
        {open?.kind === "edit-building" && (
          <BuildingForm hospitalId={open.building.hospital_id} building={open.building} onSaved={saved} onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "delete-building"} title="Delete building" onClose={close}>
        {open?.kind === "delete-building" && (
          <DeleteConfirm what={`the building “${open.building.name}”`} path={`/buildings/${open.building.id}`}
                         onDeleted={saved} onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "add-floor"} title="Add floor" onClose={close}>
        {open?.kind === "add-floor" && <FloorForm buildingId={open.building.id} onSaved={saved} onCancel={close} />}
      </Dialog>
      <Dialog open={open?.kind === "edit-floor"} title="Edit floor" onClose={close}>
        {open?.kind === "edit-floor" && (
          <FloorForm buildingId={open.floor.building_id} floor={open.floor} onSaved={saved} onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "delete-floor"} title="Delete floor" onClose={close}>
        {open?.kind === "delete-floor" && (
          <DeleteConfirm what={`the floor “${open.floor.name}”`} path={`/floors/${open.floor.id}`}
                         onDeleted={saved} onCancel={close} />
        )}
      </Dialog>
      <Dialog open={open?.kind === "import"} title="Import a floor file" onClose={close}>
        {open?.kind === "import" && (
          <ImportChooser floors={floors.data ?? []} initial={open.floor} label={floorLabel} />
        )}
      </Dialog>
    </>
  );
}

/** Pick the floor to import into (preselected when opened from a floor row). */
function ImportChooser({ floors, initial, label }: {
  floors: Floor[];
  initial: Floor | null;
  label: (floor: Floor) => string;
}) {
  const [floorId, setFloorId] = useState<number | null>(initial?.id ?? floors[0]?.id ?? null);
  const options = [...floors].sort((a, b) => label(a).localeCompare(label(b)));
  return (
    <>
      <label htmlFor="import-floor">Floor</label>
      <select id="import-floor" value={floorId ?? ""} onChange={(e) => setFloorId(Number(e.target.value))}>
        {options.map((floor) => <option key={floor.id} value={floor.id}>{label(floor)}</option>)}
      </select>
      {floorId !== null && <FloorImport key={floorId} floorId={floorId} onImported={() => undefined} />}
    </>
  );
}

export default function FacilitiesPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <FacilityManager />
    </Suspense>
  );
}
