// Zephyr‑SSH backend
// WebSocket + ssh2 (no socket.io) — required for WTerm WebSocketTransport

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Client } = require("ssh2");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// WebSocket server for SSH transport
const wss = new WebSocketServer({ server, path: "/ssh" });

wss.on("connection", (ws) => {
  let conn = new Client();
  let sshStream = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Step 1: Establish SSH connection
      if (data.type === "connect") {
        const { host, port, username, password, privateKey, passphrase, init } = data;

        conn
          .on("ready", () => {
            conn.shell((err, stream) => {
              if (err) {
                ws.send(JSON.stringify({ type: "error", message: err.message }));
                ws.close();
                return;
              }

              sshStream = stream;

              ws.send(JSON.stringify({ type: "ready" }));

              // SSH → WebSocket
              stream.on("data", (chunk) => {
                ws.send(JSON.stringify({ type: "data", data: chunk.toString() }));
              });

              stream.on("close", () => {
                ws.close();
                conn.end();
              });

              // Execute initial command if provided
              if (init && init.trim() !== "") {
                stream.write(init + "\n");
              }
            });
          })
          .on("error", (err) => {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
            ws.close();
          })
          .connect({
            host,
            port: Number(port) || 22,
            username,
            password: password || undefined,
            privateKey: privateKey || undefined,
            passphrase: passphrase || undefined,
          });
      }

      // Step 2: Terminal input → SSH
      if (data.type === "input" && sshStream) {
        sshStream.write(data.data);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: e.message }));
    }
  });

  ws.on("close", () => {
    if (conn) conn.end();
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Zephyr‑SSH running on port ${PORT}`);
});