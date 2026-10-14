// A stand-in for the AI service during end-to-end tests, so no real AI (and no
// internet) is used. It answers like Ollama's /api/chat (the backend runs with
// AI_PROVIDER=ollama pointed here): a draft request gets a fire at the first
// place name that appears in the text, a summary request gets a sentence
// without numbers. Listens on 127.0.0.1 only.

import http from "node:http";

const port = Number(process.env.E2E_AI_PORT ?? 11500);

function answerFor(request) {
  const user = JSON.parse(request.messages.at(-1).content);
  if (Array.isArray(user.floor_node_names)) {
    const place = user.floor_node_names.find((name) => user.request.includes(name)) ?? user.floor_node_names[0];
    return {
      status: "scenario", clarification_question: "", unknown_names: [],
      scenario_name: `Fire at ${place}`, scenario_description: "Drafted by the end-to-end test model.",
      hazards: [{ node_name: place, type: "fire", severity: 4, spread_rate_m_per_min: 2 }],
    };
  }
  return { summary: "This is a simulation result for planning and training." };
}

http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      const request = JSON.parse(body);
      const content = JSON.stringify(answerFor(request));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: request.model, message: { role: "assistant", content }, done: true, done_reason: "stop" }));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fake AI: unreadable request" }));
    }
  });
}).listen(port, "127.0.0.1");
