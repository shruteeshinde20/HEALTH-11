import { test } from "node:test";
import assert from "node:assert/strict";
import type { OsmPlace } from "../../src/lib/shared/api-types.ts";
import { formatDistance, osmChanges } from "../../src/lib/shared/outside-data.ts";

const place: OsmPlace = {
  osm_type: "node", osm_id: 111, url: "https://www.openstreetmap.org/node/111", name: "Near Hospital",
  address: "12 Station Road, Pune", latitude: 18.521, longitude: 73.857, distance_m: 85.4,
};

test("distances are shown in metres or kilometres", () => {
  assert.equal(formatDistance(85.4), "85 m");
  assert.equal(formatDistance(1000), "1 km");
  assert.equal(formatDistance(1500), "1.5 km");
  assert.equal(formatDistance(Number.NaN), "–");
});

test("Use this saves the position and address, and the name only when asked", () => {
  assert.deepEqual(osmChanges({ address: "Old address" }, place, false),
                   { address: "12 Station Road, Pune", latitude: 18.521, longitude: 73.857 });
  assert.deepEqual(osmChanges({ address: "Old address" }, place, true),
                   { address: "12 Station Road, Pune", latitude: 18.521, longitude: 73.857, name: "Near Hospital" });
  // No OpenStreetMap address or name: keep what the hospital has.
  assert.deepEqual(osmChanges({ address: "Old address" }, { ...place, address: null, name: null }, true),
                   { address: "Old address", latitude: 18.521, longitude: 73.857 });
});
