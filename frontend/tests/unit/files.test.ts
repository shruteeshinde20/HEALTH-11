import { test } from "node:test";
import assert from "node:assert/strict";
import { floorImportType } from "../../src/lib/shared/files.ts";

test("the upload type comes from the file extension, not the browser's guess", () => {
  assert.equal(floorImportType("Ground floor.CSV"), "text/csv");
  assert.equal(floorImportType("plan.json"), "application/json");
  assert.equal(floorImportType("plan.geojson"), "application/geo+json");
  assert.equal(floorImportType("plan.xlsx"), null);
  assert.equal(floorImportType("no-extension"), null);
});
