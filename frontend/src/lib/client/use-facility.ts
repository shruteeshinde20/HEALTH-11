"use client";

// The organization's buildings, floors and places, loaded once for forms that
// pick a building or a place (Scenario Builder, Algorithm Comparison).

import { useMemo } from "react";

import type { Building, Floor, GraphNode, Hospital } from "../shared/api-types.ts";
import type { PlaceRef } from "../shared/scenario.ts";
import { useAll } from "./use-api.ts";

/** What the forms need to know about the organization's buildings, floors and places. */
export type Facility = {
  buildings: Building[];                  // sorted by label
  floorsOf: (buildingId: number) => Floor[];
  placesOf: (floorId: number) => PlaceRef[];
  places: Map<number, PlaceRef>;
  buildingLabel: (buildingId: number) => string;
};

export function useFacility(): { facility: Facility | null; error: unknown; reload: () => void } {
  const hospitals = useAll<Hospital>("/hospitals");
  const buildings = useAll<Building>("/buildings");
  const floors = useAll<Floor>("/floors");
  const nodes = useAll<GraphNode>("/nodes");

  const hospitalList = hospitals.data;
  const buildingList = buildings.data;
  const floorList = floors.data;
  const nodeList = nodes.data;

  const facility = useMemo<Facility | null>(() => {
    if (!hospitalList || !buildingList || !floorList || !nodeList) return null;
    const hospitalName = new Map(hospitalList.map((h) => [h.id, h.name]));
    const buildingById = new Map(buildingList.map((b) => [b.id, b]));
    const floorById = new Map(floorList.map((f) => [f.id, f]));
    const buildingLabel = (id: number) => {
      const building = buildingById.get(id);
      return building ? `${hospitalName.get(building.hospital_id) ?? "?"} / ${building.name}` : `Building ${id}`;
    };
    const places = new Map<number, PlaceRef>();
    for (const node of nodeList) {
      const floor = floorById.get(node.floor_id);
      if (!floor) continue;
      places.set(node.id, { id: node.id, name: node.name, type: node.type, floor_id: floor.id, building_id: floor.building_id });
    }
    const allFloors = floorList;
    return {
      buildings: [...buildingList].sort((a, b) => buildingLabel(a.id).localeCompare(buildingLabel(b.id))),
      floorsOf: (buildingId) =>
        allFloors.filter((f) => f.building_id === buildingId).sort((a, b) => a.floor_number - b.floor_number),
      placesOf: (floorId) =>
        [...places.values()].filter((p) => p.floor_id === floorId).sort((a, b) => a.name.localeCompare(b.name)),
      places,
      buildingLabel,
    };
  }, [hospitalList, buildingList, floorList, nodeList]);

  return {
    facility,
    error: hospitals.error ?? buildings.error ?? floors.error ?? nodes.error,
    reload: () => {
      hospitals.reload();
      buildings.reload();
      floors.reload();
      nodes.reload();
    },
  };
}
