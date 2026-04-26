const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');

const app = express();
const server = http.createServer(app);

// 1. 静态资源服务（确保 public/vendor 第一优先级）
app.use(express.static(path.join(__dirname, 'public')));

// 注意：绝不添加 app.get('*', ...) 之类会覆盖静态文件的 catch‑all 路由
// 此项目无需 SPA fallback，静态文件 404 时自然返回 404，不会落入 HTML

const wss = new WebSocketServer({ server, path: '/ssh' });

wss.on('connection', (ws) => {
  let conn = null;
  let sshStream = null;

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch _ { return; }

    if (data.type === 'connect') {
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
            try { ws.close(); } catch _ {}
            conn.end();
          });

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
        passphrase: data.passphrase || undefined,
      });
    }

    if (data.type === 'input' && sshStream) {
      sshStream.write(data.data);
    }
  });

  ws.on('close', () => { if (conn) conn.end(); });
  ws.on('error', () => { if (conn) conn.end(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Zephyr-SSH listening on ${PORT}`));