import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as E from "../engine.js";
import * as IO from "../io.js";

const repo = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), "utf8");

test("CSV parser handles quotes, commas, CRLF and a BOM", () => {
  const rows = IO.parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n3,4');
  assert.deepEqual(rows.map(({ _line, ...r }) => r), [{ a: "x, y", b: 'say "hi"' }, { a: "3", b: "4" }]);
  assert.throws(() => IO.parseCsv('a\n"open'), /never closed/);
  assert.throws(() => IO.parseCsv(""), /empty/);
});

test("The HEALTH-11 example files (copied from docs/examples) load into the prototype", () => {
  const floor = IO.floorFromHealth11Csv(read("prototype/examples/riverside-ground-floor.csv"), 0);
  const patients = IO.patientsFromCsv(read("prototype/examples/riverside-patients.csv"));
  const staff = IO.staffFromCsv(read("prototype/examples/riverside-staff.csv"));
  const model = E.buildModel({ name: "Riverside", ...floor, patients, staff });
  assert.equal(model.nodes.length, 15);
  assert.equal(model.edges.length, 14);
  assert.equal(model.people.length, 28);
  const r = E.simulate(model, { alarm: "start", hazards: [] }, {}, { seed: 1 });
  assert.equal(r.out, 28);
});

test("Fire-model, camera, device and drill files", () => {
  const hazards = IO.hazardsFromFireModelCsv(read("prototype/examples/fire-model-arrivals.csv"));
  assert.equal(hazards.length, 1);
  assert.equal(hazards[0].type, "smoke");
  assert.ok(hazards[0].arrivals.length >= 10);
  const demo = JSON.parse(read("prototype/examples/demo-building.json"));
  const model = E.buildModel(demo);
  assert.doesNotThrow(() => E.hazardArrivals(model, { hazards }, E.defaultParams()));
  assert.deepEqual(IO.cameraCountsFromCsv("camera,count,time\nCAM-OPD,4,10\nCAM-OPD,9,20\nCAM-ED,2,5\n"), { "CAM-OPD": 9, "CAM-ED": 2 });
  assert.throws(() => IO.cameraCountsFromCsv("camera,count\nX,-1\n"), /whole number/);
  const counts = IO.cameraCountsFromCsv(read("prototype/examples/camera-counts.csv"));
  assert.equal(counts["CAM-OPD"], 13); // the later of the two counts
  assert.throws(() => IO.cameraCountsFromCsv("camera,count,time\nX,1,yesterday\n"), /date-time/);
  const dev = IO.devicesFromCsv("id,kind,place,count\nS1,smoke,OPD,\nC1,camera,OPD,7\n");
  assert.deepEqual(dev, { sensors: [{ id: "S1", kind: "smoke", place: "OPD" }], cameras: [{ id: "C1", place: "OPD", count: 7 }] });
  const drill = IO.drillFromCsv(read("prototype/examples/drill-observations.csv"));
  assert.equal(drill.length, 55);
  assert.throws(() => IO.drillFromCsv("exit,exit_time_s\nE1,soon\n"), /0 or more/);
});

test("CSV export escapes quotes and spreadsheet formulas", () => {
  const out = IO.toCsv([{ a: '=HYPERLINK("x")', b: "-3", c: "a,b" }], ["a", "b", "c"]);
  assert.equal(out, `a,b,c\n"'=HYPERLINK(""x"")",-3,"a,b"\n`);
});

test("Building JSON must be one object", () => {
  assert.throws(() => IO.buildingFromJson("[1]"), /one building/);
  assert.throws(() => IO.buildingFromJson("{"), /not valid JSON/);
});
