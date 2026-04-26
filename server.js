const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 兜底路由：SPA 支持
app.get('*', (req, res) => {
    if (req.url.startsWith('/vendor') || req.url.startsWith('/ssh')) {
        return res.status(404).end();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

// WebSocket 服务
const wss = new WebSocketServer({ server, path: '/ssh' });

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    let sshClient = null;
    let sshStream = null;

    const sendJSON = (obj) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const cleanup = () => {
        if (sshStream) {
            try { sshStream.end(); } catch {}
            sshStream = null;
        }
        if (sshClient) {
            try { sshClient.end(); } catch {}
            sshClient = null;
        }
    };

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'connect') {
            // 建立 SSH 连接
            const { host, port, username, password, privateKey, init } = msg;
            sshClient = new Client();

            const sshConfig = {
                host,
                port: port || 22,
                username,
                readyTimeout: 10000,
                keepaliveInterval: 10000,
            };
            if (privateKey && privateKey.includes('-----BEGIN')) {
                sshConfig.privateKey = privateKey;
                if (password) sshConfig.passphrase = password;
            } else if (password) {
                sshConfig.password = password;
            } else {
                sendJSON({ type: 'error', message: '缺少认证凭据' });
                return;
            }

            sshClient.on('ready', () => {
                console.log(`[SSH] 已连接到 ${host}:${port}`);
                sshClient.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (err, stream) => {
                    if (err) {
                        sendJSON({ type: 'error', message: `打开 Shell 失败: ${err.message}` });
                        cleanup();
                        return;
                    }
                    sshStream = stream;
                    sendJSON({ type: 'ready' });

                    stream.on('data', (data) => {
                        sendJSON({ type: 'data', data: data.toString('utf-8') });
                    });

                    stream.on('close', (code, signal) => {
                        console.log(`[SSH] Shell 关闭 code=${code} signal=${signal}`);
                        sendJSON({ type: 'close', message: `Shell 已关闭 (code=${code})` });
                        cleanup();
                    });

                    stream.stderr.on('data', (data) => {
                        sendJSON({ type: 'data', data: data.toString('utf-8') });
                    });

                    // 执行初始命令
                    if (init && typeof init === 'string' && init.trim().length > 0) {
                        stream.write(init + '\n');
                    }
                });
            });

            sshClient.on('error', (err) => {
                console.error(`[SSH] 错误: ${err.message}`);
                sendJSON({ type: 'error', message: `SSH 连接失败: ${err.message}` });
                cleanup();
            });

            sshClient.on('close', () => {
                console.log('[SSH] 连接关闭');
                sendJSON({ type: 'close', message: 'SSH 连接已关闭' });
                cleanup();
            });

            try {
                sshClient.connect(sshConfig);
            } catch (err) {
                sendJSON({ type: 'error', message: `SSH 连接异常: ${err.message}` });
                cleanup();
            }

        } else if (msg.type === 'input') {
            if (sshStream && sshStream.writable) {
                sshStream.write(msg.data);
            }
        } else if (msg.type === 'resize') {
            if (sshStream && sshStream.setWindow) {
                sshStream.setWindow(msg.rows, msg.cols, 0, 0);
            }
        } else if (msg.type === 'disconnect') {
            cleanup();
            ws.close();
        }
    });

    ws.on('close', () => {
        console.log('[WS] 客户端断开');
        cleanup();
    });

    ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
        cleanup();
    });
});

// 健康检查
app.get('/healthz', (req, res) => res.status(200).send('OK'));

server.listen(PORT, () => {
    console.log(`🌬️  Zephyr-SSH 服务运行在 http://localhost:${PORT}`);
    console.log(`   WebSocket 路径: /ssh`);
});