const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 兜底路由
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
    let sftpStream = null;   // 用于 SFTP 会话

    const sendJSON = (obj) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const cleanup = () => {
        if (sftpStream) {
            try { sftpStream.end(); } catch {}
            sftpStream = null;
        }
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

        // ---------- 原有 SSH 连接逻辑 ----------
        if (msg.type === 'connect') {
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

            try { sshClient.connect(sshConfig); } catch (err) {
                sendJSON({ type: 'error', message: `SSH 连接异常: ${err.message}` });
                cleanup();
            }

            return;
        }

        if (msg.type === 'input') {
            if (sshStream && sshStream.writable) {
                sshStream.write(msg.data);
            }
            return;
        }

        if (msg.type === 'resize') {
            if (sshStream && sshStream.setWindow) {
                sshStream.setWindow(msg.rows, msg.cols, 0, 0);
            }
            return;
        }

        if (msg.type === 'disconnect') {
            cleanup();
            ws.close();
            return;
        }

        // ---------- SFTP 相关操作 ----------
        // 初始化 SFTP 会话
        if (msg.type === 'sftp-init') {
            if (!sshClient) {
                sendJSON({ type: 'sftp-error', message: 'SSH 未连接' });
                return;
            }
            sshClient.sftp((err, sftp) => {
                if (err) {
                    sendJSON({ type: 'sftp-error', message: `SFTP 初始化失败: ${err.message}` });
                    return;
                }
                sftpStream = sftp;
                sendJSON({ type: 'sftp-ready' });
            });
            return;
        }

        // 后续所有 SFTP 操作都需要 sftpStream 存在
        if (!sftpStream) {
            sendJSON({ type: 'sftp-error', message: 'SFTP 会话未建立' });
            return;
        }

        // 列出目录
        if (msg.type === 'sftp-list') {
            const dir = msg.path || '.';
            sftpStream.readdir(dir, (err, list) => {
                if (err) {
                    sendJSON({ type: 'sftp-list', path: dir, error: err.message, files: [] });
                    return;
                }
                // 转换为统一格式，包含类型
                const files = list.map(entry => ({
                    name: entry.filename,
                    type: entry.longname.startsWith('d') ? 'd' : '-',
                    size: entry.attrs.size,
                    modifyTime: entry.attrs.mtime * 1000,
                    rights: entry.longname.substr(0, 10),
                }));
                sendJSON({ type: 'sftp-list', path: dir, files });
            });
            return;
        }

        // 创建目录
        if (msg.type === 'sftp-mkdir') {
            sftpStream.mkdir(msg.path, (err) => {
                sendJSON({ type: 'sftp-mkdir', path: msg.path, success: !err, error: err ? err.message : null });
            });
            return;
        }

        // 创建空文件
        if (msg.type === 'sftp-touch') {
            const { path: filePath } = msg;
            // 创建一个写入流然后立刻关闭
            const writeStream = sftpStream.createWriteStream(filePath);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-touch', path: filePath, success: false, error: err.message });
            });
            writeStream.end('', () => {
                sendJSON({ type: 'sftp-touch', path: filePath, success: true });
            });
            return;
        }

        // 删除文件/目录 (注意 ssh2 sftp 没有直接 rmdir 递归，需要先清空，这里简单处理不支持删除非空目录)
        if (msg.type === 'sftp-delete') {
            // 先尝试 stat 判断是文件还是目录
            sftpStream.stat(msg.path, (err, stats) => {
                if (err) {
                    sendJSON({ type: 'sftp-delete', path: msg.path, success: false, error: err.message });
                    return;
                }
                if (stats.isDirectory()) {
                    sftpStream.rmdir(msg.path, (err2) => {
                        sendJSON({ type: 'sftp-delete', path: msg.path, success: !err2, error: err2 ? err2.message : null });
                    });
                } else {
                    sftpStream.unlink(msg.path, (err2) => {
                        sendJSON({ type: 'sftp-delete', path: msg.path, success: !err2, error: err2 ? err2.message : null });
                    });
                }
            });
            return;
        }

        // 重命名
        if (msg.type === 'sftp-rename') {
            sftpStream.rename(msg.oldPath, msg.newPath, (err) => {
                sendJSON({ type: 'sftp-rename', oldPath: msg.oldPath, newPath: msg.newPath, success: !err, error: err ? err.message : null });
            });
            return;
        }

        // 下载文件 (读取为 base64)
        if (msg.type === 'sftp-download') {
            sftpStream.readFile(msg.path, (err, data) => {
                if (err) {
                    sendJSON({ type: 'sftp-download', path: msg.path, error: err.message });
                    return;
                }
                const base64 = Buffer.isBuffer(data) ? data.toString('base64') : '';
                sendJSON({ type: 'sftp-download', path: msg.path, data: base64 });
            });
            return;
        }

        // 上传文件 (base64 -> 写入)
        if (msg.type === 'sftp-upload') {
            const { path: uploadPath, data: base64 } = msg;
            if (!base64) {
                sendJSON({ type: 'sftp-upload', path: uploadPath, success: false, error: '缺少数据' });
                return;
            }
            const buffer = Buffer.from(base64, 'base64');
            const writeStream = sftpStream.createWriteStream(uploadPath);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-upload', path: uploadPath, success: false, error: err.message });
            });
            writeStream.end(buffer, () => {
                sendJSON({ type: 'sftp-upload', path: uploadPath, success: true });
            });
            return;
        }

        // 编辑文件：先读取内容
        if (msg.type === 'sftp-readfile') {
            sftpStream.readFile(msg.path, { encoding: 'utf8' }, (err, data) => {
                if (err) {
                    sendJSON({ type: 'sftp-readfile', path: msg.path, error: err.message });
                    return;
                }
                sendJSON({ type: 'sftp-readfile', path: msg.path, data: data });
            });
            return;
        }

        // 编辑文件：保存内容
        if (msg.type === 'sftp-writefile') {
            const { path: filePath, data } = msg;
            const writeStream = sftpStream.createWriteStream(filePath);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-writefile', path: filePath, success: false, error: err.message });
            });
            writeStream.end(Buffer.from(data, 'utf8'), () => {
                sendJSON({ type: 'sftp-writefile', path: filePath, success: true });
            });
            return;
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

app.get('/healthz', (req, res) => res.status(200).send('OK'));

server.listen(PORT, () => {
    console.log(`🌬️  Zephyr-SSH 服务运行在 http://localhost:${PORT}`);
    console.log(`   WebSocket 路径: /ssh`);
});