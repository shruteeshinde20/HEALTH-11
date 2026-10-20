// A stand-in for the OpenStreetMap Overpass API during end-to-end tests, so
// no internet is used. The backend runs with OVERPASS_URL pointed here. For a
// search "around:R,LAT,LON" it answers one hospital about 110 m north of the
// position. Listens on 127.0.0.1 only.

import http from "node:http";

const port = Number(process.env.E2E_OSM_PORT ?? 11527);

http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const query = new URLSearchParams(body).get("data") ?? "";
    const match = /around:\d+,(-?[\d.]+),(-?[\d.]+)/.exec(query);
    const elements = match ? [{
      type: "node", id: 4242, lat: Number(match[1]) + 0.001, lon: Number(match[2]),
      tags: { amenity: "hospital", name: "E2E Nearby Hospital", "addr:housenumber": "1",
              "addr:street": "Test Road", "addr:city": "Pune" },
    }] : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 0.6, generator: "fake overpass", elements }));
  });
}).listen(port, "127.0.0.1");
