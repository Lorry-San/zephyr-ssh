const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const path = require('path');
const { getRemoteStats } = require('./stats');

const PORT = process.env.PORT || 3000;
const app = express();

function execRemoteCommand(sshClient, command) {
    return new Promise((resolve, reject) => {
        if (!sshClient) return reject(new Error('SSH 未连接'));
        sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
            if (err) return reject(err);
            let stdout = '';
            let stderr = '';
            stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            stream.on('close', (code) => {
                if (code !== 0) {
                    const message = (stderr || stdout || `远程命令退出码 ${code}`).trim();
                    reject(new Error(message));
                    return;
                }
                resolve(stdout);
            });
        });
    });
}

function shellQuote(value) {
    return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function parseJSONLines(raw) {
    return String(raw || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
        });
}

function normalizeDockerMirrors(raw) {
    try {
        const json = JSON.parse(raw || '{}');
        return Array.isArray(json['registry-mirrors']) ? json['registry-mirrors'].filter(Boolean) : [];
    } catch {
        return [];
    }
}

function dockerServiceRestartCommand() {
    return [
        'set -e',
        'if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo -n"; fi',
        'if command -v systemctl >/dev/null 2>&1; then',
        '  $SUDO systemctl restart docker',
        'elif command -v service >/dev/null 2>&1; then',
        '  $SUDO service docker restart',
        'else',
        '  echo "未找到 systemctl/service，无法自动重启 Docker" >&2',
        '  exit 1',
        'fi',
        'echo "Docker 服务已重启"'
    ].join('\n');
}

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
const wss = new WebSocketServer({ server, path: '/ssh' });

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    let sshClient = null;
    let sshStream = null;
    let sftpStream = null;
    let statsTimer = null;
    let statsRunning = false;
    let remoteStatsState = {};
    const dockerLogStreams = new Map();

    const sendJSON = (obj) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    // 启动实时监控推送
    function startStatsPush() {
        if (statsTimer) return;
        const pushStats = async () => {
            if (ws.readyState !== ws.OPEN || !sshClient || statsRunning) return;
            statsRunning = true;
            try {
                const result = await getRemoteStats(sshClient, remoteStatsState);
                remoteStatsState = result.state;
                sendJSON({ type: 'stats', data: result.stats });
            } catch (err) {
                console.error('[STATS] 读取远程统计失败:', err.message);
                sendJSON({ type: 'stats-error', message: err.message || '读取远程统计失败' });
            } finally {
                statsRunning = false;
            }
        };
        pushStats();
        statsTimer = setInterval(pushStats, 1000);
    }

    // 停止实时推送
    function stopStatsPush() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
        statsRunning = false;
        remoteStatsState = {};
    }

    function stopDockerLogStreams() {
        for (const stream of dockerLogStreams.values()) {
            try { stream.close?.(); } catch {}
            try { stream.end?.(); } catch {}
            try { stream.destroy?.(); } catch {}
        }
        dockerLogStreams.clear();
    }

    const cleanup = () => {
        stopStatsPush();
        stopDockerLogStreams();
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

    function execDockerStream(command, onMessage, onComplete) {
        if (!sshClient) {
            onComplete?.(new Error('SSH 未连接'));
            return null;
        }
        sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
            if (err) {
                onComplete?.(err);
                return;
            }
            stream.on('data', (chunk) => onMessage?.(chunk.toString('utf8'), 'stdout'));
            stream.stderr.on('data', (chunk) => onMessage?.(chunk.toString('utf8'), 'stderr'));
            stream.on('close', (code) => onComplete?.(code === 0 ? null : new Error(`远程命令退出码 ${code}`), code));
            return stream;
        });
        return null;
    }

    function startDockerLogStream(container) {
        const key = String(container || '').trim();
        if (!key) {
            sendJSON({ type: 'docker-log-error', message: '缺少容器 ID/名称' });
            return;
        }
        if (dockerLogStreams.has(key)) {
            try { dockerLogStreams.get(key).close?.(); } catch {}
            dockerLogStreams.delete(key);
        }
        const command = `docker logs --tail 200 --timestamps -f ${shellQuote(key)}`;
        sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
            if (err) {
                sendJSON({ type: 'docker-log-error', container: key, message: err.message });
                return;
            }
            dockerLogStreams.set(key, stream);
            sendJSON({ type: 'docker-log-start', container: key });
            stream.on('data', (chunk) => sendJSON({ type: 'docker-log-data', container: key, data: chunk.toString('utf8') }));
            stream.stderr.on('data', (chunk) => sendJSON({ type: 'docker-log-data', container: key, data: chunk.toString('utf8') }));
            stream.on('close', (code) => {
                dockerLogStreams.delete(key);
                sendJSON({ type: 'docker-log-end', container: key, code });
            });
        });
    }

    async function handleDockerMessage(msg) {
        if (!sshClient) {
            sendJSON({ type: 'docker-error', message: 'SSH 未连接' });
            return;
        }
        try {
            if (msg.type === 'docker-check') {
                const raw = await execRemoteCommand(sshClient, [
                    "if command -v docker >/dev/null 2>&1; then",
                    "  echo __DOCKER_INSTALLED__=1; docker --version 2>/dev/null || true;",
                    "  if [ -S /var/run/docker.sock ]; then echo __DOCKER_SOCKET__=1; else echo __DOCKER_SOCKET__=0; fi;",
                    "else echo __DOCKER_INSTALLED__=0; fi"
                ].join(' '));
                sendJSON({
                    type: 'docker-status',
                    installed: raw.includes('__DOCKER_INSTALLED__=1'),
                    socket: raw.includes('__DOCKER_SOCKET__=1'),
                    version: (raw.split('\n').find((line) => line.toLowerCase().startsWith('docker version')) || '').trim(),
                    raw,
                });
                return;
            }

            if (msg.type === 'docker-list-containers') {
                const raw = await execRemoteCommand(sshClient, "docker ps -a --no-trunc --format '{{json .}}'");
                sendJSON({ type: 'docker-containers', containers: parseJSONLines(raw) });
                return;
            }

            if (msg.type === 'docker-list-images') {
                const raw = await execRemoteCommand(sshClient, "docker image ls --no-trunc --format '{{json .}}'");
                sendJSON({ type: 'docker-images', images: parseJSONLines(raw) });
                return;
            }

            if (msg.type === 'docker-container-action') {
                const action = String(msg.action || '');
                const target = String(msg.id || msg.name || '').trim();
                const actionMap = { start: 'start', stop: 'stop', restart: 'restart', remove: 'rm -f' };
                if (!actionMap[action] || !target) throw new Error('容器操作参数不完整');
                const raw = await execRemoteCommand(sshClient, `docker ${actionMap[action]} ${shellQuote(target)}`);
                sendJSON({ type: 'docker-action', action, target, success: true, output: raw });
                return;
            }

            if (msg.type === 'docker-delete-image') {
                const image = String(msg.id || msg.image || '').trim();
                const force = !!msg.force;
                if (!image) throw new Error('缺少镜像 ID/名称');
                const usedBy = await execRemoteCommand(sshClient, `docker ps -a --filter ${shellQuote(`ancestor=${image}`)} --format '{{.ID}} {{.Names}}' || true`);
                if (usedBy.trim() && !force) {
                    sendJSON({ type: 'docker-image-delete', image, success: false, requiresForce: true, usedBy: usedBy.trim() });
                    return;
                }
                const raw = await execRemoteCommand(sshClient, `docker rmi ${force ? '-f ' : ''}${shellQuote(image)}`);
                sendJSON({ type: 'docker-image-delete', image, success: true, output: raw });
                return;
            }

            if (msg.type === 'docker-pull-image') {
                const image = String(msg.image || '').trim();
                if (!image) throw new Error('请输入镜像名，例如 nginx:alpine');
                sendJSON({ type: 'docker-pull-start', image });
                sshClient.exec(`sh -lc ${JSON.stringify(`docker pull ${shellQuote(image)}`)}`, (err, stream) => {
                    if (err) {
                        sendJSON({ type: 'docker-pull-complete', image, success: false, error: err.message });
                        return;
                    }
                    stream.on('data', (chunk) => sendJSON({ type: 'docker-pull-log', image, data: chunk.toString('utf8') }));
                    stream.stderr.on('data', (chunk) => sendJSON({ type: 'docker-pull-log', image, data: chunk.toString('utf8') }));
                    stream.on('close', (code) => sendJSON({ type: 'docker-pull-complete', image, success: code === 0, code }));
                });
                return;
            }

            if (msg.type === 'docker-logs-start') {
                startDockerLogStream(msg.id || msg.name);
                return;
            }

            if (msg.type === 'docker-logs-stop') {
                const key = String(msg.id || msg.name || '').trim();
                const stream = dockerLogStreams.get(key);
                if (stream) {
                    try { stream.close?.(); } catch {}
                    try { stream.end?.(); } catch {}
                    dockerLogStreams.delete(key);
                }
                sendJSON({ type: 'docker-log-end', container: key, code: 0 });
                return;
            }

            if (msg.type === 'docker-mirrors-get') {
                const raw = await execRemoteCommand(sshClient, "if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json; else printf '{}'; fi");
                sendJSON({ type: 'docker-mirrors', mirrors: normalizeDockerMirrors(raw), raw });
                return;
            }

            if (msg.type === 'docker-mirrors-set') {
                const mirrors = Array.isArray(msg.mirrors) ? msg.mirrors.map((v) => String(v).trim()).filter(Boolean) : [];
                const encoded = Buffer.from(JSON.stringify(mirrors), 'utf8').toString('base64');
                const command = `
set -e
PY=$(command -v python3 || command -v python || true)
[ -n "$PY" ] || { echo "目标主机需要 python3/python 才能安全更新 daemon.json" >&2; exit 1; }
TMP=$(mktemp)
OUT=$(mktemp)
if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json > "$TMP"; else printf '{}' > "$TMP"; fi
"$PY" - "$TMP" "$OUT" ${shellQuote(encoded)} <<'PY'
import base64, json, sys
src, out, encoded = sys.argv[1:4]
try:
    with open(src, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
except Exception:
    data = {}
mirrors = json.loads(base64.b64decode(encoded).decode('utf-8'))
data['registry-mirrors'] = mirrors
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\\n')
PY
if [ "$(id -u)" = "0" ]; then
  mkdir -p /etc/docker && cp "$OUT" /etc/docker/daemon.json
else
  sudo -n mkdir -p /etc/docker && sudo -n cp "$OUT" /etc/docker/daemon.json
fi
rm -f "$TMP" "$OUT"
echo "Docker registry-mirrors 已更新，请重启 Docker 服务使配置生效。"
`;
                const raw = await execRemoteCommand(sshClient, command);
                sendJSON({ type: 'docker-mirrors-save', success: true, output: raw, mirrors });
                return;
            }

            if (msg.type === 'docker-restart-service') {
                const raw = await execRemoteCommand(sshClient, dockerServiceRestartCommand());
                sendJSON({ type: 'docker-service-restart', success: true, output: raw });
                return;
            }
        } catch (err) {
            const responseType = msg.type === 'docker-check' ? 'docker-status'
                : msg.type === 'docker-list-containers' ? 'docker-containers'
                : msg.type === 'docker-list-images' ? 'docker-images'
                : msg.type === 'docker-mirrors-get' ? 'docker-mirrors'
                : 'docker-error';
            sendJSON({ type: responseType, success: false, error: err.message, message: err.message, containers: [], images: [] });
        }
    }

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // ------------------------- SSH 连接 -------------------------
        if (msg.type === 'connect') {
            const { host, port, username, password, privateKey, init } = msg;
            cleanup();
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

                // 打开 shell
                sshClient.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (err, stream) => {
                    if (err) {
                        sendJSON({ type: 'error', message: `打开 Shell 失败: ${err.message}` });
                        cleanup();
                        return;
                    }
                    sshStream = stream;
                    sendJSON({ type: 'ready' });

                    // SSH 连接就绪后，启动实时监控推送
                    startStatsPush();

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

        // 手动请求一帧实时监控数据（打开监控面板时使用）
        if (msg.type === 'stats-request') {
            if (!sshClient || statsRunning) return;
            statsRunning = true;
            try {
                const result = await getRemoteStats(sshClient, remoteStatsState);
                remoteStatsState = result.state;
                sendJSON({ type: 'stats', data: result.stats });
            } catch (err) {
                console.error('[STATS] 手动读取远程统计失败:', err.message);
                sendJSON({ type: 'stats-error', message: err.message || '读取远程统计失败' });
            } finally {
                statsRunning = false;
            }
            return;
        }

        // 断开
        if (msg.type === 'disconnect') {
            cleanup();
            ws.close();
            return;
        }

        // ------------------------- Docker 操作 -------------------------
        if (typeof msg.type === 'string' && msg.type.startsWith('docker-')) {
            await handleDockerMessage(msg);
            return;
        }

        // ------------------------- SFTP 操作 -------------------------
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

        // 删除（文件或空目录）
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

        // 下载文件（返回 base64）
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

        // 上传文件（base64）
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

        // 编辑文件：读取内容
        if (msg.type === 'sftp-readfile') {
            sftpStream.readFile(msg.path, (err, data) => {
                if (err) {
                    sendJSON({ type: 'sftp-readfile', path: msg.path, error: err.message });
                    return;
                }
                sendJSON({
                    type: 'sftp-readfile',
                    path: msg.path,
                    data: Buffer.isBuffer(data) ? data.toString('base64') : '',
                    encoding: 'base64',
                    size: Buffer.isBuffer(data) ? data.length : 0,
                });
            });
            return;
        }

        // 编辑文件：保存内容
        if (msg.type === 'sftp-writefile') {
            const writeStream = sftpStream.createWriteStream(msg.path);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-writefile', path: msg.path, success: false, error: err.message });
            });
            const buffer = msg.encoding === 'base64'
                ? Buffer.from(msg.data || '', 'base64')
                : Buffer.from(msg.data || '', 'utf8');
            writeStream.end(buffer, () => {
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

// 健康检查
app.get('/healthz', (req, res) => res.status(200).send('OK'));

server.listen(PORT, () => {
    console.log(`🌬️  Zephyr-SSH 服务运行在 http://localhost:${PORT}`);
    console.log(`   WebSocket 路径: /ssh`);
});