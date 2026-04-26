// server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Serve static files from public (includes public/vendor)
app.use(express.static(path.join(__dirname, 'public')));

// IMPORTANT: Do NOT add a catch-all that returns index.html before static middleware.
// If you need SPA fallback, add it after verifying static file not found and only for HTML routes.
// For this simple app we avoid any catch-all to prevent CSS/JS requests returning HTML.

// WebSocket server for SSH transport at /ssh
const wss = new WebSocketServer({ server, path: '/ssh' });

wss.on('connection', (ws) => {
  let conn = null;
  let sshStream = null;

  ws.on('message', (msg) => {
    // Expect JSON messages from client
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      // ignore non-json or binary messages
      return;
    }

    if (data.type === 'connect') {
      // create ssh connection
      conn = new Client();
      conn.on('ready', () => {
        conn.shell((err, stream) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
            conn.end();
            return;
          }
          sshStream = stream;
          ws.send(JSON.stringify({ type: 'ready' }));

          stream.on('data', (chunk) => {
            ws.send(JSON.stringify({ type: 'data', data: chunk.toString('utf8') }));
          });

          stream.on('close', () => {
            try { ws.close(); } catch (e) {}
            conn.end();
          });

          // write initial command if provided
          if (data.init && data.init.trim() !== '') {
            stream.write(data.init + '\n');
          }
        });
      }).on('error', (err) => {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }).connect({
        host: data.host,
        port: Number(data.port) || 22,
        username: data.username,
        password: data.password || undefined,
        privateKey: data.privateKey || undefined,
        passphrase: data.passphrase || undefined
      });
    }

    if (data.type === 'input' && sshStream) {
      // forward terminal input to ssh
      sshStream.write(data.data);
    }
  });

  ws.on('close', () => {
    if (conn) conn.end();
  });

  ws.on('error', () => {
    if (conn) conn.end();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Zephyr-SSH listening on ${PORT}`);
});