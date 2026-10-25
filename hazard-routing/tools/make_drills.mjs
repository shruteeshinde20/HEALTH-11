// Writes two MADE-UP drill records for the Drill check page.
//
//   node hazard-routing/tools/make_drills.mjs
//
// They are NOT real drills. They are made with this same simulator, using
// hidden "true" settings (people 10% slower, delays 25% longer than the
// defaults), a seed the page does not use, no sensor faults (a drill has no
// fire to sense) and +-5 s of timing noise. So the
// Drill check can only show that the comparison and calibration code work
// (it should find speed about 0.9 and delay about 1.25); it says nothing about
// how well the model matches a real hospital. Replace the files with a real
// drill record (columns: code, kind, mobility, exit, exit_time_s).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.join(here, "..", "examples");
const data = JSON.parse(fs.readFileSync(path.join(examples, "hospital.json"), "utf8"));
const model = E.buildModel(data);
const HIDDEN = { speed: 0.9, delay: 1.25, seed: 9001 };
const noise = E.makeRandom(4242);

function write(file, scenarioName) {
  const scenario = model.scenarios.find((s) => s.name === scenarioName);
  const sim = E.createSimulation(model, scenario, { seed: HIDDEN.seed, params: E.scaledParams({}, HIDDEN.speed, HIDDEN.delay), info: "realistic", rescue: false, sensorFaults: false });
  sim.run();
  const rows = ["code,kind,mobility,exit,exit_time_s"];
  for (const a of sim.agents) {
    if (a.state !== "out" || a.kind === "rescue") continue;
    const t = Math.max(1, Math.round(a.outAt + E.normal(noise, 0, 5)));
    rows.push([a.code, a.kind, a.mobility, model.nodes[a.exit].id, t].join(","));
  }
  fs.writeFileSync(path.join(examples, file), rows.join("\n") + "\n");
  console.log(`${file}: ${rows.length - 1} people, last out ${Math.max(...rows.slice(1).map((r) => Number(r.split(",")[4])))} s`);
}

write("drill-a-full.csv", "Evacuation drill (no hazard)");
write("drill-b-main-entrance-closed.csv", "Drill with the Main Entrance closed");

// A made-up recording of sensor readings during the kitchen fire (same
// simulator, seed 31, realistic sensor faults), for the "replay readings"
// part of the Sensors page. Columns: sensor,t,value.
{
  const scenario = model.scenarios.find((s) => s.name.startsWith("Kitchen fire"));
  const sim = E.createSimulation(model, scenario, { seed: 31 });
  const rows = ["sensor,t,value"];
  let last = new Map();
  while (!sim.done && sim.t < 900) {
    sim.step();
    for (const s of sim.net.sensors) {
      const h = s.history[s.history.length - 1];
      if (h && last.get(s.id) !== h[0]) {
        last.set(s.id, h[0]);
        rows.push([s.id, h[0], Math.round(h[1] * 1000) / 1000].join(","));
      }
    }
  }
  fs.writeFileSync(path.join(examples, "sensor-readings-kitchen.csv"), rows.join("\n") + "\n");
  console.log(`sensor-readings-kitchen.csv: ${rows.length - 1} readings, true spread ${sim.truth.smokeRate.toFixed(3)} m/s`);
}
