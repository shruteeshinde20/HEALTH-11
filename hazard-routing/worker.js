// Runs the long batches (method comparison, drill check, calibration) off the
// page's main thread, so the page stays responsive.
import * as E from "./engine.js";

let model = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "model") {
      model = E.buildModel(msg.data, msg.params ?? {});
      self.postMessage({ type: "ready", id: msg.id });
      return;
    }
    if (!model) throw new Error("No building loaded");
    if (msg.type === "runs") {
      // jobs: [{key, scenario, options}] each run once per seed
      const out = {};
      let done = 0;
      const total = msg.jobs.length * msg.seeds.length;
      for (const job of msg.jobs) {
        const results = [];
        for (const seed of msg.seeds) {
          const r = E.simulate(model, job.scenario, { ...job.options, seed });
          delete r.events;
          delete r.estimates;
          results.push(r);
          done++;
          self.postMessage({ type: "progress", id: msg.id, done, total });
        }
        out[job.key] = { results, stats: E.statsOf(results) };
      }
      self.postMessage({ type: "done", id: msg.id, out });
      return;
    }
    if (msg.type === "calibrate") {
      const grid = msg.grid;
      const total = grid.speed.length * grid.delay.length * msg.seeds.length;
      let done = 0;
      const tried = [];
      for (const sp of grid.speed) {
        for (const de of grid.delay) {
          const runs = msg.seeds.map((seed) => {
            const r = E.simulate(model, msg.scenario, { ...msg.options, seed, params: E.scaledParams(msg.options.params, sp, de) });
            done++;
            self.postMessage({ type: "progress", id: msg.id, done, total });
            return r;
          });
          const cmp = E.compareWithDrill(msg.rows, runs);
          tried.push({ speed: sp, delay: de, rmse: cmp.rmse, fit: cmp.fit });
        }
      }
      tried.sort((a, b) => a.fit - b.fit);
      const close = tried.filter((x) => x.fit <= tried[0].fit * 1.15);
      self.postMessage({ type: "done", id: msg.id, out: { best: tried[0], close, tried } });
      return;
    }
    throw new Error(`Unknown job ${msg.type}`);
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: err.message });
  }
};
