const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const app = express();

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 兜底路由
app.get('*', (req, res) => {
    if (req.url.startsWith('/vendor') || req.url.startsWith('/ssh')) {
        return res.status(404).end();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ssh' });

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    let sshClient = null;
    let sshStream = null;
    let sftpStream = null;
    let monitorTimer = null;
    let lastCpu = null;
    let lastNet = null;
    let lastTime = null;
    let cpuModel = 'N/A';
    let cpuFreq = 'N/A';

    const sendJSON = (obj) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const cleanup = () => {
        if (monitorTimer) {
            clearInterval(monitorTimer);
            monitorTimer = null;
        }
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

    // 读取本机 CPU 统计
    function readCPU() {
        try {
            const stat = fs.readFileSync('/proc/stat', 'utf8');
            const parts = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
            return { idle: parts[3], total: parts.reduce((a, b) => a + b, 0) };
        } catch (e) {
            return { idle: 0, total: 0 };
        }
    }

    function calcCPU(prev, curr) {
        if (!prev) return 0;
        const idle = curr.idle - prev.idle;
        const total = curr.total - prev.total;
        return total ? ((1 - idle / total) * 100).toFixed(1) : 0;
    }

    // 读取本机网络统计（排除虚拟网卡）
    function readNet() {
        try {
            const data = fs.readFileSync('/proc/net/dev', 'utf8');
            const lines = data.split('\n').slice(2);
            let rx = 0, tx = 0;
            lines.forEach(line => {
                const i = line.indexOf(':');
                if (i === -1) return;
                const iface = line.substring(0, i).trim();
                if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) return;
                const parts = line.substring(i+1).trim().split(/\s+/).map(Number);
                rx += parts[0];
                tx += parts[8];
            });
            return { rx, tx };
        } catch (e) {
            return { rx: 0, tx: 0 };
        }
    }

    function calcNet(prev, curr, timeDiffSec) {
        if (!prev || !timeDiffSec) return { rx: 0, tx: 0 };
        const r = ((curr.rx - prev.rx) * 8) / timeDiffSec / 1024 / 1024;
        const t = ((curr.tx - prev.tx) * 8) / timeDiffSec / 1024 / 1024;
        return { rx: r.toFixed(2), tx: t.toFixed(2) };
    }

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // ---------- SSH 连接 ----------
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

                // 获取 CPU 型号和频率（仅一次，去除频率重复）
                sshClient.exec(`sh -c "
                    cat /proc/cpuinfo 2>/dev/null | grep 'model name' | head -1 | cut -d: -f2 | sed 's/ @.*//'
                    cat /proc/cpuinfo 2>/dev/null | grep 'cpu MHz' | head -1 | cut -d: -f2
                "`, (err, stream) => {
                    if (err) return;
                    let out = '';
                    stream.on('data', d => out += d.toString());
                    stream.on('close', () => {
                        const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
                        cpuModel = lines[0] ? lines[0].replace(/\s*@.*$/, '').trim() : 'N/A';
                        cpuFreq = lines[1] ? (parseFloat(lines[1]).toFixed(0) + ' MHz') : 'N/A';
                    });
                });

                // 打开 shell
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

        // 输入
        if (msg.type === 'input') {
            if (sshStream && sshStream.writable) sshStream.write(msg.data);
            return;
        }

        // 窗口大小调整
        if (msg.type === 'resize') {
            if (sshStream && sshStream.setWindow) sshStream.setWindow(msg.rows, msg.cols, 0, 0);
            return;
        }

        // 断开
        if (msg.type === 'disconnect') {
            cleanup();
            ws.close();
            return;
        }

        // ---------- 实时监控 ----------
        if (msg.type === 'start-monitor') {
            if (!sshClient) return;
            if (monitorTimer) return; // 已启动

            lastCpu = readCPU();
            lastNet = readNet();
            lastTime = Date.now();

            monitorTimer = setInterval(() => {
                const now = Date.now();
                const timeDiffSec = (now - lastTime) / 1000;
                lastTime = now;

                const currCpu = readCPU();
                const cpu = calcCPU(lastCpu, currCpu);
                lastCpu = currCpu;

                const currNet = readNet();
                const net = calcNet(lastNet, currNet, timeDiffSec);
                lastNet = currNet;

                // 通过 SSH 执行内存、磁盘、IP 命令
                sshClient.exec(`sh -c "
                    echo IPV4: hostname -I 2>/dev/null | awk '{print \\$1}'
                    echo IPV6: ip -6 addr show 2>/dev/null | grep global | awk '{print \\$2}' | head -1
                    echo RAM: awk '/MemTotal/{t=\\$2}/MemAvailable/{a=\\$2} END{printf \"%.0f/%.0f MB\", (t-a)/1024, t/1024}' /proc/meminfo
                    echo SWAP: awk '/SwapTotal/{t=\\$2}/SwapFree/{f=\\$2} END{printf \"%.0f/%.0f MB\", (t-f)/1024, t/1024}' /proc/meminfo
                    echo DISK: df -h / 2>/dev/null | awk 'NR==2{print \$3\"/\"\$2\" (\"\$5\")\"}'
                "`, (err, stream) => {
                    if (err) return;
                    let out = '';
                    stream.on('data', d => out += d.toString());
                    stream.on('close', () => {
                        const lines = out.split('\n');
                        let ipv4 = 'N/A', ipv6 = 'N/A', ram = 'N/A', swap = 'N/A', disk = 'N/A';
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line.startsWith('IPV4:')) ipv4 = line.substring(5).trim() || 'N/A';
                            if (line.startsWith('IPV6:')) ipv6 = line.substring(5).trim() || 'N/A';
                            if (line.startsWith('RAM:')) ram = line.substring(4).trim() || 'N/A';
                            if (line.startsWith('SWAP:')) swap = line.substring(5).trim() || 'N/A';
                            if (line.startsWith('DISK:')) disk = line.substring(5).trim() || 'N/A';
                        }
                        sendJSON({
                            type: 'monitor-data',
                            data: {
                                cpu, cpuModel, cpuFreq,
                                ram, swap, disk,
                                ipv4, ipv6,
                                rx: net.rx, tx: net.tx,
                            }
                        });
                    });
                });
            }, 1000);
            return;
        }

        if (msg.type === 'stop-monitor') {
            if (monitorTimer) {
                clearInterval(monitorTimer);
                monitorTimer = null;
            }
            return;
        }

        // ---------- SFTP 操作 ----------
        // 初始化 SFTP
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
            const writeStream = sftpStream.createWriteStream(msg.path);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-touch', path: msg.path, success: false, error: err.message });
            });
            writeStream.end('', () => {
                sendJSON({ type: 'sftp-touch', path: msg.path, success: true });
            });
            return;
        }

        // 删除
        if (msg.type === 'sftp-delete') {
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

        // 下载文件
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

        // 上传文件
        if (msg.type === 'sftp-upload') {
            const buffer = Buffer.from(msg.data, 'base64');
            const writeStream = sftpStream.createWriteStream(msg.path);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-upload', path: msg.path, success: false, error: err.message });
            });
            writeStream.end(buffer, () => {
                sendJSON({ type: 'sftp-upload', path: msg.path, success: true });
            });
            return;
        }

        // 编辑文件：读取
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

        // 编辑文件：保存
        if (msg.type === 'sftp-writefile') {
            const writeStream = sftpStream.createWriteStream(msg.path);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-writefile', path: msg.path, success: false, error: err.message });
            });
            writeStream.end(Buffer.from(msg.data, 'utf8'), () => {
                sendJSON({ type: 'sftp-writefile', path: msg.path, success: true });
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