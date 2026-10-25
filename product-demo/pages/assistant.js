// AI Assistant (demo): type a request in plain English and get a scenario you can run.
// In this demo the request is read by fixed rules in the browser (assistant-parse.js).
// The main HEALTH-11 app sends the request to an AI model, with made-up data only.
import { esc, header, toast, fmtS } from "../ui.js";
import { parseRequest } from "./assistant-parse.js";
import { recommendations } from "./shared.js";

const EXAMPLES = [
  "Fire in NICU Bay 2, spreading fast",
  "Short circuit in the store room on the third floor",
  "Kitchen fire with the Main Entrance closed and broken sensors",
  "Fire in OT 3 at night, no phones and people panic",
  "Run a drill with Stair A closed",
  "Summarise the last run",
];

let chat = []; // kept while the browser tab is open

export function render(main, ctx) {
  const s = ctx.store;
  const places = () => {
    const m = ctx.model();
    return m.nodes.map((n) => ({ id: n.id, type: n.type, floor: n.floor }));
  };
  if (!chat.length) chat.push({ who: "ai", html: `Hello. Describe a fire or a drill in your own words and I will turn it into a scenario you can check and run. For example: <i>${esc(EXAMPLES[0])}</i>. I can also summarise the last run.` });

  main.innerHTML = `${header("AI Assistant", "Ask in plain English. The assistant writes the scenario; you check it before it runs.")}
  <p class="note info">Demo assistant: in this demo your words are read by fixed rules in this browser, so nothing is sent anywhere. The main HEALTH-11 app uses an AI model for this step, and only with made-up data, never real patient details.</p>
  <div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(240px,1fr);margin-top:16px">
    <div class="card stack">
      <div class="chat" id="aChat" aria-live="polite"></div>
      <form class="row" id="aForm" novalidate><input type="text" id="aIn" maxlength="500" placeholder="For example: fire in the kitchen, smoke spreading fast" style="flex:1" aria-label="Your request"><button class="btn primary" type="submit">Send</button></form>
    </div>
    <div class="card stack"><h2>Try</h2>${EXAMPLES.map((e) => `<button class="btn" data-ex="${esc(e)}" style="justify-content:flex-start;text-align:left">${esc(e)}</button>`).join("")}
      <p class="small muted">The assistant understands: a room name (with a floor if several match), fast or slow smoke or a speed in m/s, closed exits, stairs or lifts, broken sensors, no phones, panic, broken signs, and a missing alarm.</p>
      <button class="btn sm" id="aClear">Clear the conversation</button></div>
  </div>`;
  const box = main.querySelector("#aChat");
  const drawChat = () => {
    box.innerHTML = chat.map((m, i) => `<div class="msg ${m.who}" data-i="${i}">${m.html}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  };

  const scenarioCard = (sc, notes) => {
    const show = { ...sc };
    if (!Object.keys(show.params ?? {}).length) delete show.params;
    return `<div class="stack" style="gap:6px"><b>Here is the scenario:</b>
      <ul style="margin:0 0 0 18px;padding:0">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <pre style="white-space:pre-wrap;font-size:12px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;margin:0">${esc(JSON.stringify(show, null, 2))}</pre>
      <div class="row"><button class="btn primary sm" data-run>Save and run live</button><button class="btn sm" data-save>Save only</button></div></div>`;
  };

  const answer = (text, forced = null) => {
    const r = forced ?? parseRequest(text, places());
    if (r.kind === "help") return { html: `I can write fire and drill scenarios for ${esc(s.hospital().name)} and summarise runs. Try one of the examples on the right.` };
    if (r.kind === "unknown") return { html: "I did not understand that. Mention a fire or smoke and where it starts (for example <i>fire in the Kitchen</i>), ask for a drill, or ask me to summarise the last run." };
    if (r.kind === "summary") {
      const run = s.state.runs[0];
      if (!run) return { html: "There is no run yet. Run a scenario on the Live Simulation page first." };
      const x = run.summary;
      const rec = recommendations(x, ctx.model()).slice(0, 3);
      return { html: `<b>${esc(run.scenario)}</b> with ${esc(run.methodLabel)} (run ${run.seed}): ${x.safe} of ${x.total} people reached safety; 90% were safe at ${fmtS(x.t90)} and the last at ${fmtS(x.lastSafe)}. ${x.harmed} were reached by the hazard and ${x.incapacitated} were overcome. ${rec.map((q) => esc(q.text)).join(" ")} <a href="#/reports" data-rep="${run.id}">Open the full report</a>.` };
    }
    if (r.kind === "clarify") {
      return { html: `${esc(r.question)}${r.options.length ? `<div class="row" style="margin-top:6px">${r.options.map((o) => `<button class="btn sm" data-pick="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}`, pending: r };
    }
    return { html: scenarioCard(r.scenario, r.notes), scenario: r.scenario };
  };

  const send = (text) => {
    const clean = String(text).trim().slice(0, 500);
    if (!clean) return;
    chat.push({ who: "me", html: esc(clean) });
    const a = answer(clean);
    chat.push({ who: "ai", ...a });
    s.audit("ask", "assistant", clean.slice(0, 120));
    drawChat();
  };

  const saveScenario = (sc) => {
    let name = sc.name;
    const names = new Set(s.data().scenarios.map((x) => x.name));
    for (let k = 2; names.has(name); k++) name = `${sc.name} (${k})`;
    s.updateData((d) => d.scenarios.push({ ...sc, name }), "create", `scenario ${name} (assistant)`);
    return s.data().scenarios.length - 1;
  };

  box.onclick = (ev) => {
    const b = ev.target.closest("button,a");
    if (!b) return;
    const msg = chat[Number(b.closest("[data-i]")?.dataset.i)];
    if (b.dataset.rep) {
      ctx.pending.run = Number(b.dataset.rep);
      return;
    }
    if (b.dataset.pick !== undefined && msg?.pending) {
      const p = msg.pending.partial;
      const sc = { name: `Assistant: fire in ${b.dataset.pick}`, origin: b.dataset.pick, ...p, note: "Made by the demo assistant." };
      chat.push({ who: "me", html: esc(b.dataset.pick) });
      chat.push({ who: "ai", html: scenarioCard(sc, msg.pending.notes ?? []), scenario: sc });
      msg.pending = null;
      drawChat();
      return;
    }
    if (!msg?.scenario) return;
    if (ctx.readOnly()) return toast("Your role cannot save scenarios.", "bad");
    try {
      const idx = saveScenario(msg.scenario);
      if (b.dataset.run !== undefined) {
        ctx.pending.scenario = idx;
        ctx.go("live");
      } else toast("Saved. Find it in the Scenario Builder.");
    } catch (err) {
      toast(`Not saved: ${err.message}`, "bad");
    }
  };
  main.querySelector("#aForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const inp = main.querySelector("#aIn");
    send(inp.value);
    inp.value = "";
  });
  for (const b of main.querySelectorAll("[data-ex]")) b.onclick = () => send(b.dataset.ex);
  main.querySelector("#aClear").onclick = () => {
    chat = [];
    render(main, ctx);
  };
  drawChat();
}
