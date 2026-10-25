import test from "node:test";
import assert from "node:assert/strict";
import * as IO from "../io.js";

test("CSV parser handles quotes, commas, CRLF and a BOM; rejects broken files", () => {
  const rows = IO.parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n3,4');
  assert.deepEqual(rows.map(({ _line, ...r }) => r), [{ a: "x, y", b: 'say "hi"' }, { a: "3", b: "4" }]);
  assert.throws(() => IO.parseCsv('a\n"open'), /never closed/);
  assert.throws(() => IO.parseCsv(""), /empty/);
});

test("Drill records, camera counts and sensor readings are checked", () => {
  assert.deepEqual(IO.drillFromCsv("code,kind,mobility,exit,exit_time_s\nP1,patient,ambulatory,Exit A,120\n"), [{ code: "P1", kind: "patient", mobility: "ambulatory", exit: "Exit A", exit_time_s: 120 }]);
  assert.throws(() => IO.drillFromCsv("exit,exit_time_s\nE1,soon\n"), /seconds/);
  assert.throws(() => IO.drillFromCsv("exit\nE1\n"), /exit_time_s/);
  assert.deepEqual(IO.cameraCountsFromCsv("camera,count,time\nA,4,10\nA,9,20\nB,2,5\n"), { A: 9, B: 2 });
  assert.throws(() => IO.cameraCountsFromCsv("camera,count\nX,-1\n"), /whole number/);
  assert.deepEqual(IO.readingsFromCsv("sensor,t,value\nSD-1,5,0.02\n"), [{ sensor: "SD-1", t: 5, value: 0.02 }]);
  assert.throws(() => IO.readingsFromCsv("sensor,t,value\nSD-1,-5,0.02\n"), /0 or more/);
  assert.throws(() => IO.buildingFromJson("[1,2]"), /one building/);
  assert.throws(() => IO.buildingFromJson("{oops"), /not valid JSON/);
});

test("CSV export escapes quotes and spreadsheet formulas", () => {
  const csv = IO.toCsv([{ a: '=HYPERLINK("x")', b: "1,5", c: -3 }], ["a", "b", "c"]);
  assert.equal(csv, 'a,b,c\n"\'=HYPERLINK(""x"")","1,5",-3\n');
});
