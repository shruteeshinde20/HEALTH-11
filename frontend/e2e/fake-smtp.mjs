// A stand-in mail server for the end-to-end tests, so no real e-mail is sent.
// The backend sends "Forgot password?" codes here (SMTP_HOST=127.0.0.1,
// SMTP_SECURITY=none, allowed on this computer only). It speaks just enough
// SMTP to receive messages and keeps them in memory; the tests read them over
// HTTP: GET /messages?to=<address> returns [{to, data}], newest last.
// Both listen on 127.0.0.1 only.

import http from "node:http";
import net from "node:net";

const smtpPort = Number(process.env.E2E_SMTP_PORT ?? 11525);
const httpPort = Number(process.env.E2E_MAIL_PORT ?? 11526);
const messages = [];

net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let inData = false;
  let recipients = [];
  let lines = [];
  const reply = (text) => socket.write(`${text}\r\n`);
  reply("220 fake-smtp ready");

  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          for (const to of recipients) messages.push({ to, data: lines.join("\n") });
          recipients = [];
          lines = [];
          reply("250 OK queued");
        } else {
          lines.push(line.startsWith("..") ? line.slice(1) : line);
        }
        continue;
      }
      const command = line.slice(0, 4).toUpperCase();
      if (command === "EHLO") { reply("250-fake-smtp"); reply("250 8BITMIME"); }
      else if (command === "HELO") reply("250 fake-smtp");
      else if (command === "RCPT") {
        const match = /<([^>]*)>/.exec(line);
        recipients.push((match ? match[1] : "").toLowerCase());
        reply("250 OK");
      } else if (command === "DATA") { inData = true; reply("354 End data with <CR><LF>.<CR><LF>"); }
      else if (command === "QUIT") { reply("221 Bye"); socket.end(); }
      else reply("250 OK");   // MAIL, RSET, NOOP
    }
  });
  socket.on("error", () => undefined);
}).listen(smtpPort, "127.0.0.1");

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const to = (url.searchParams.get("to") ?? "").toLowerCase();
  const body = url.pathname === "/messages" ? messages.filter((m) => !to || m.to === to) : { status: "ok" };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(httpPort, "127.0.0.1");
