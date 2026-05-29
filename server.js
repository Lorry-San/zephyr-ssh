const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const { TOTP, generateSecret, generateURI, verifySync } = require('otplib');
const QRCode = require('qrcode');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');
const ipaddr = require('ipaddr.js');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { getRemoteStats } = require('./stats');
const storage = require('./storage');
const { handleEditorLspConnection } = require('./editor-lsp-server');
const {
    getImageExt,
    isBrowserImageExt,
    isPreviewImageExt,
    getBrowserImageContentType,
    ensurePreviewCacheFile,
    cleanupPreviewCache,
} = require('./preview/image/preview-service');

const PORT = process.env.PORT || 3000;
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT) || 4822;
const GUACD_EMBEDDED = process.env.GUACD_EMBEDDED !== 'false';
const GUACD_BIN = process.env.GUACD_BIN || 'guacd';
const GUACD_LOG_LEVEL = process.env.GUACD_LOG_LEVEL || 'info';
const SSH_STATS_ENABLED = process.env.SSH_STATS_ENABLED !== 'false';
const app = express();

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'zephyr.db');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const sessions = new Map();
const sshTerminalSessions = new Map();
const sftpDownloadTokens = new Map();
const sftpUploadTokens = new Map();
const sftpPreviewTokens = new Map();
const sftpClipboardByUser = new Map();
const previewCache = new Map();
const PREVIEW_TOKEN_TTL = 10 * 60 * 1000;
const PREVIEW_CACHE_TTL = 30 * 60 * 1000;
const PREVIEW_CACHE_DIR = path.join(os.tmpdir(), 'zephyr-preview-cache');
const BROWSER_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif']);
const BROWSER_IMAGE_CONTENT_TYPES = new Map([
    ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'],
    ['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['avif', 'image/avif'],
]);
const PREVIEW_IMAGE_EXTENSIONS = new Set([
    ...BROWSER_IMAGE_EXTENSIONS,
    'tif', 'tiff', 'heic', 'heif', 'jxl', 'jp2', 'j2k', 'bmp', 'dib', 'ico', 'cur', 'icns',
    'psd', 'psb', 'xcf', 'dds', 'tga', 'hdr', 'exr', 'pnm', 'pbm', 'pgm', 'ppm', 'pam',
    'pcx', 'sgi', 'ras', 'sun', 'fits', 'fit', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf',
    'rw2', 'raf', 'pef', 'srw', 'x3f', 'mrw', 'erf', 'kdc', 'dcr', 'mos'
]);
const SFTP_DOWNLOAD_TOKEN_TTL = 24 * 60 * 60 * 1000;
const SFTP_UPLOAD_TOKEN_TTL = 24 * 60 * 60 * 1000;
const SFTP_DOWNLOAD_KEEPALIVE_INTERVAL = 30 * 1000;
const SFTP_UPLOAD_KEEPALIVE_INTERVAL = 30 * 1000;
const tempTotpTokens = new Map();
const webauthnChallenges = new Map();
const resetRequestHits = new Map();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function wsSendJSON(targetWs, obj) {
    if (targetWs?.readyState === targetWs?.OPEN) {
        targetWs.send(JSON.stringify(obj));
    }
}

function appendSshSessionBuffer(session, data) {
    if (!session || !data) return;
    session.outputBuffer.push(String(data));
    let total = session.outputBuffer.reduce((sum, item) => sum + item.length, 0);
    while (total > 512 * 1024 && session.outputBuffer.length > 1) {
        total -= session.outputBuffer.shift().length;
    }
}

function broadcastSshSession(session, obj) {
    if (!session?.attachedWs) return;
    for (const targetWs of [...session.attachedWs]) {
        wsSendJSON(targetWs, obj);
    }
}

function sendTransferEvent(username, payload) {
    for (const session of sshTerminalSessions.values()) {
        if (session.username !== username || session.closed || !session.attachedWs) continue;
        broadcastSshSession(session, { type: 'sftp-transfer-progress', ...payload });
    }
}

function destroySshTerminalSession(sessionOrId, reason = 'session-destroy') {
    const session = typeof sessionOrId === 'string' ? sshTerminalSessions.get(sessionOrId) : sessionOrId;
    if (!session || session.closed) return;
    session.closed = true;
    sshTerminalSessions.delete(session.id);
    for (const [token, download] of sftpDownloadTokens.entries()) {
        if (download.sessionId === session.id) sftpDownloadTokens.delete(token);
    }
    for (const [token, uploadTask] of sftpUploadTokens.entries()) {
        if (uploadTask.sessionId === session.id) {
            sftpUploadTokens.delete(token);
            destroyUploadSession(token);
        }
    }
    for (const [token, previewTask] of sftpPreviewTokens.entries()) {
        if (previewTask.sessionId === session.id) sftpPreviewTokens.delete(token);
    }
    console.info('[SSH-SESSION]', 'destroy', {
        sessionId: session.id,
        reason,
        attached: session.attachedWs?.size || 0,
        connectionId: session.connectionId || '',
    });
    broadcastSshSession(session, { type: 'close', message: reason === 'client-disconnect' ? '会话已断开' : 'SSH 会话已关闭' });
    for (const targetWs of [...(session.attachedWs || [])]) {
        try { targetWs._sshTerminalSession = null; } catch {}
    }
    session.attachedWs?.clear?.();
    try { session.sshStream?.end?.(); } catch {}
    try { session.sshStream?.destroy?.(); } catch {}
    [...(session.sshClients || [])].reverse().forEach((client) => {
        try { client.end?.(); } catch {}
    });
    if (session.sshClient && !(session.sshClients || []).includes(session.sshClient)) {
        try { session.sshClient.end?.(); } catch {}
    }
}

function loadDataEnv() {
    const envFile = path.join(DATA_DIR, '.env');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, 'ENCRYPTION_KEY=please-change-this-key\nPUBLIC_ORIGIN=http://localhost:3000\n');
    const raw = fs.readFileSync(envFile, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
}
loadDataEnv();

function ensureDataFile(file, fallback) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}

function readJSON(file, fallback) {
    if (file === USERS_FILE) return storage.getUsersStore();
    if (file === CONNECTIONS_FILE) return storage.getConnectionsStore();
    if (file === SETTINGS_FILE) return storage.getSettings();
    ensureDataFile(file, fallback);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
    if (file === USERS_FILE) return storage.saveUsersStore(data);
    if (file === CONNECTIONS_FILE) return storage.saveConnectionsStore(data);
    if (file === SETTINGS_FILE) return storage.updateSettings(data);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt] = stored.split(':');
    return hashPassword(password, salt) === stored;
}

function initData() {
    ensureDataFile(USERS_FILE, {
        users: [{ username: 'admin', passwordHash: hashPassword('admin'), defaultPassword: true, createdAt: Date.now() }]
    });
    ensureDataFile(CONNECTIONS_FILE, { connections: [], activities: [] });
    ensureDataFile(SETTINGS_FILE, { version: '1.0.0', icp: '', policeBeian: '' });
}

storage.init({ hashPassword });

function parseCookies(req) {
    return String(req.headers.cookie || '').split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx > -1) acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1));
        return acc;
    }, {});
}

function currentSession(req) {
    const sid = parseCookies(req).zephyr_sid;
    return sid ? sessions.get(sid) : null;
}

function requireAuth(req, res, next) {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: '未登录' });
    req.session = session;
    next();
}

function publicConnection(conn) {
    const copy = { ...conn };
    copy.password = conn.password ? '******' : '';
    copy.privateKey = conn.privateKey ? '******' : '';
    copy.hasPassword = Boolean(conn.password);
    copy.hasPrivateKey = Boolean(conn.privateKey);
    copy.jumpHostIds = normalizeJumpHostIds(conn);
    return copy;
}

function normalizeJumpHostIds(connOrValue) {
    const value = Array.isArray(connOrValue) || typeof connOrValue === 'string' ? connOrValue : connOrValue?.jumpHostIds;
    let ids = [];
    if (Array.isArray(value)) ids = value;
    else if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            ids = Array.isArray(parsed) ? parsed : String(value).split(',');
        } catch {
            ids = value.split(',');
        }
    }
    if (!ids.length && connOrValue?.jumpHostId) ids = [connOrValue.jumpHostId];
    return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}

function applyConnectionRouteFields(conn, body) {
    if (body.connectionMode !== undefined) conn.connectionMode = ['direct', 'proxy', 'jump'].includes(body.connectionMode) ? body.connectionMode : 'direct';
    if (body.proxyId !== undefined) conn.proxyId = body.proxyId || null;
    if (body.jumpHostId !== undefined) conn.jumpHostId = body.jumpHostId || null;
    if (body.jumpHostIds !== undefined) {
        conn.jumpHostIds = normalizeJumpHostIds(body.jumpHostIds);
        conn.jumpHostId = conn.jumpHostIds[0] || conn.jumpHostId || null;
    } else if (conn.jumpHostId && !normalizeJumpHostIds(conn).length) {
        conn.jumpHostIds = [conn.jumpHostId];
    }
    if (conn.connectionMode !== 'proxy') conn.proxyId = null;
    if (conn.connectionMode !== 'jump') {
        conn.jumpHostId = null;
        conn.jumpHostIds = [];
    }
    return conn;
}

function verifySensitiveAccess(req, secretInput) {
    const user = storage.getUser(req.session?.username);
    if (!user) throw new Error('未登录或会话已过期');
    const value = String(secretInput || '').trim();
    if (user.totpEnabled) {
        if (!verifySync({ secret: user.totpSecret || '', token: value }).valid) throw new Error('动态验证码错误');
        return { method: 'totp', username: user.username };
    }
    if (!verifyPassword(value, user.passwordHash)) throw new Error('登录密码错误');
    return { method: 'password', username: user.username };
}

function resolveSshKeyForConnection(conn) {
    if (!conn?.sshKeyId) return conn;
    const key = storage.getSshKeyRaw(conn.sshKeyId);
    if (!key) {
        console.warn('[ssh-key] selected key missing', { connectionId: conn.id, sshKeyId: conn.sshKeyId });
        return conn;
    }
    const resolved = { ...conn };
    if (!resolved.privateKey || resolved.privateKey === '******') resolved.privateKey = key.privateKey || '';
    if ((!resolved.password || resolved.password === '******') && key.passphrase) resolved.password = key.passphrase || '';
    console.debug('[ssh-key] resolved key for connection', { connectionId: conn.id, sshKeyId: conn.sshKeyId, keyName: key.name, hasPrivateKey: !!resolved.privateKey, hasPassphrase: !!key.passphrase });
    return resolved;
}

function buildSSHConfig(conn, timeout = 10000) {
    const resolvedConn = resolveSshKeyForConnection(conn);
    const host = String(resolvedConn.host || '').trim();
    const username = String(resolvedConn.username || '').trim();
    const port = Number(resolvedConn.port) || 22;
    const privateKey = resolvedConn.privateKey && resolvedConn.privateKey !== '******' ? String(resolvedConn.privateKey) : '';
    const password = resolvedConn.password && resolvedConn.password !== '******' ? String(resolvedConn.password) : '';
    const hasPrivateKey = privateKey.includes('-----BEGIN');
    const hasPassword = Boolean(password);
    const cfg = { host, port, username, readyTimeout: timeout, keepaliveInterval: 10000 };
    console.info('[SSH-DIAG] build ssh config', {
        connectionId: resolvedConn.id || '',
        name: resolvedConn.name || '',
        target: `${host}:${port}`,
        username,
        mode: resolvedConn.connectionMode || 'direct',
        sshKeyId: resolvedConn.sshKeyId || '',
        authMethods: { password: hasPassword && !hasPrivateKey, privateKey: hasPrivateKey, passphrase: hasPrivateKey && hasPassword },
        timeout,
    });
    if (!host || !username) throw new Error('主机和用户名不能为空');
    if (hasPrivateKey) {
        cfg.privateKey = privateKey;
        if (hasPassword) cfg.passphrase = password;
    } else if (hasPassword) cfg.password = password;
    else throw new Error(`缺少认证凭据（password=${hasPassword}, privateKey=${hasPrivateKey}, sshKeyId=${resolvedConn.sshKeyId || '-'})`);
    return cfg;
}

function waitForSocket(socket, timeout, label = 'TCP 连接') {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.off('connect', onConnect);
            socket.off('error', onError);
            if (err) reject(err); else resolve(socket);
        };
        const onConnect = () => finish();
        const onError = (err) => finish(err);
        const timer = setTimeout(() => {
            socket.destroy();
            finish(new Error(`${label}超时`));
        }, timeout);
        socket.once('connect', onConnect);
        socket.once('error', onError);
    });
}

function readSocketChunk(socket, timeout) {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err, data) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            if (err) reject(err); else resolve(data);
        };
        const onData = (data) => finish(null, data);
        const onError = (err) => finish(err);
        const timer = setTimeout(() => finish(new Error('SOCKS5 握手超时')), timeout);
        socket.once('data', onData);
        socket.once('error', onError);
    });
}

function normalizeProxyType(type) {
    const value = String(type || 'socks5').toLowerCase();
    return ['socks5', 'http'].includes(value) ? value : 'socks5';
}

async function openSocks5Connection(proxy, targetHost, targetPort, timeout = 10000) {
    if (!proxy?.host || !proxy?.port) throw new Error('代理配置不完整');
    console.debug('[proxy]', 'open SOCKS5 tunnel', { proxyId: proxy.id, proxy: proxy.name || proxy.host, targetHost, targetPort });
    const socket = net.createConnection(Number(proxy.port) || 1080, proxy.host);
    await waitForSocket(socket, timeout, 'SOCKS5 代理');

    const hasAuth = Boolean(proxy.username || proxy.password);
    socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    let chunk = await readSocketChunk(socket, timeout);
    if (chunk[0] !== 0x05 || chunk[1] === 0xff) throw new Error('SOCKS5 代理不支持可用认证方式');

    if (chunk[1] === 0x02) {
        const user = Buffer.from(String(proxy.username || ''));
        const pass = Buffer.from(String(proxy.password || ''));
        if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 用户名或密码过长');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        chunk = await readSocketChunk(socket, timeout);
        if (chunk[1] !== 0x00) throw new Error('SOCKS5 代理认证失败');
    }

    const host = String(targetHost || '');
    const port = Number(targetPort) || 22;
    let addr;
    const ipType = net.isIP(host);
    if (ipType === 4) addr = Buffer.from([0x01, ...host.split('.').map((n) => Number(n))]);
    else {
        const hostBuf = Buffer.from(host);
        if (!hostBuf.length || hostBuf.length > 255) throw new Error('目标主机名无效');
        addr = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
    chunk = await readSocketChunk(socket, timeout);
    if (chunk[1] !== 0x00) throw new Error(`SOCKS5 代理连接目标失败（状态 ${chunk[1]}）`);
    return socket;
}

async function openHttpProxyConnection(proxy, targetHost, targetPort, timeout = 10000) {
    if (!proxy?.host || !proxy?.port) throw new Error('代理配置不完整');
    console.debug('[proxy]', 'open HTTP CONNECT tunnel', { proxyId: proxy.id, proxy: proxy.name || proxy.host, targetHost, targetPort });
    const socket = net.createConnection(Number(proxy.port) || 8080, proxy.host);
    await waitForSocket(socket, timeout, 'HTTP 代理');
    const target = `${targetHost}:${Number(targetPort) || 22}`;
    const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, 'Proxy-Connection: Keep-Alive'];
    if (proxy.username || proxy.password) {
        const token = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');
        headers.push(`Proxy-Authorization: Basic ${token}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    const chunk = await readSocketChunk(socket, timeout);
    const head = chunk.toString('latin1');
    const status = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1];
    if (status !== '200') {
        socket.destroy();
        throw new Error(`HTTP 代理 CONNECT 失败（状态 ${status || 'unknown'}）`);
    }
    return socket;
}

function openProxyConnection(proxy, targetHost, targetPort, timeout = 10000) {
    const type = normalizeProxyType(proxy?.type);
    if (type === 'http') return openHttpProxyConnection(proxy, targetHost, targetPort, timeout);
    return openSocks5Connection(proxy, targetHost, targetPort, timeout);
}

function connectSSHClient(conn, { timeout = 10000, sock = undefined } = {}) {
    return new Promise((resolve, reject) => {
        const client = new Client();
        const label = `${conn?.name || conn?.host || 'unknown'}@${conn?.host || '-'}:${Number(conn?.port) || 22}`;
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            client.off('ready', onReady);
            client.off('error', onError);
            if (err) {
                console.warn('[SSH-DIAG] ssh client connect failed', {
                    connectionId: conn?.id || '',
                    label,
                    code: err.code || '',
                    level: err.level || '',
                    description: err.description || '',
                    message: err.message,
                });
                try { client.end(); } catch {}
                reject(err);
            } else {
                console.info('[SSH-DIAG] ssh client ready', { connectionId: conn?.id || '', label, viaSocket: !!sock });
                resolve(client);
            }
        };
        const onReady = () => finish();
        const onError = (err) => finish(err);
        client.once('ready', onReady);
        client.once('error', onError);
        client.once('end', () => console.info('[SSH-DIAG] ssh client end', { connectionId: conn?.id || '', label }));
        client.once('close', () => console.info('[SSH-DIAG] ssh client close', { connectionId: conn?.id || '', label, settled }));
        try {
            const cfg = buildSSHConfig(conn, timeout);
            if (sock) cfg.sock = sock;
            client.connect(cfg);
        } catch (err) {
            finish(err);
        }
    });
}

function forwardOut(client, host, port) {
    return new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, host, Number(port) || 22, (err, stream) => err ? reject(err) : resolve(stream));
    });
}

function resolveRoutePlan(conn) {
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const connections = store.connections || [];
    const mode = conn.connectionMode || 'direct';
    if (mode === 'proxy') {
        const proxy = storage.getProxyRaw(conn.proxyId);
        if (!proxy) throw new Error('代理配置不存在或已删除');
        return { target: conn, hops: [], firstProxy: proxy };
    }
    if (mode !== 'jump') return { target: conn, hops: [], firstProxy: null };

    const jumpHostIds = normalizeJumpHostIds(conn);
    if (!jumpHostIds.length) throw new Error('未配置跳板机路径');
    if (jumpHostIds.length > 8) throw new Error('跳板机层级过多（最多 8 级）');
    const jumpHostConfigs = storage.listJumpHosts();
    const hops = jumpHostIds.map((rawJumpHostId) => {
        const jumpHostConfig = jumpHostConfigs.find((j) => j.id === rawJumpHostId);
        const jumpConnectionId = jumpHostConfig?.connectionId || rawJumpHostId;
        const hop = connections.find((c) => c.id === jumpConnectionId);
        if (!hop) throw new Error(`跳板机连接不存在或已删除：${jumpHostConfig?.name || rawJumpHostId}`);
        if (hop.id === conn.id) throw new Error('跳板机不能引用当前目标连接');
        if (String(hop.protocol || 'SSH').toUpperCase() !== 'SSH') throw new Error(`跳板机必须是 SSH 连接：${hop.name || hop.host}`);
        return { ...hop, routeName: jumpHostConfig?.name || hop.name || hop.host, jumpHostConfigId: jumpHostConfig?.id || null };
    });
    console.debug('[route-plan]', 'resolved jump route', {
        target: conn.name || conn.host,
        jumpHostIds,
        hops: hops.map((hop) => ({ jumpHostConfigId: hop.jumpHostConfigId, connectionId: hop.id, name: hop.routeName || hop.name, host: hop.host }))
    });
    const firstProxy = hops[0]?.connectionMode === 'proxy' && hops[0].proxyId ? storage.getProxyRaw(hops[0].proxyId) : null;
    if (hops[0]?.connectionMode === 'proxy' && !firstProxy) throw new Error(`首级跳板机代理配置不存在：${hops[0].name}`);
    return { target: conn, hops, firstProxy };
}

async function createRoutedSSHConnection(conn, timeout = 10000) {
    const plan = resolveRoutePlan(conn);
    const clients = [];
    try {
        if (!plan.hops.length) {
            const sock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, conn.host, conn.port, timeout) : undefined;
            const client = await connectSSHClient(conn, { timeout, sock });
            clients.push(client);
            return { client, clients, route: plan.firstProxy ? `代理 ${plan.firstProxy.name || plan.firstProxy.host} -> ${conn.name || conn.host}` : conn.name || conn.host };
        }

        let firstSock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, plan.hops[0].host, plan.hops[0].port, timeout) : undefined;
        let currentClient = await connectSSHClient(plan.hops[0], { timeout, sock: firstSock });
        clients.push(currentClient);
        for (const next of [...plan.hops.slice(1), plan.target]) {
            const tunnel = await forwardOut(currentClient, next.host, next.port);
            currentClient = await connectSSHClient(next, { timeout, sock: tunnel });
            clients.push(currentClient);
        }
        const route = [...plan.hops.map((h) => h.routeName || h.name || h.host), plan.target.name || plan.target.host].join(' -> ');
        return { client: currentClient, clients, route };
    } catch (err) {
        clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        throw err;
    }
}

function listenLocalTcpForward({ route, targetLabel, openTargetStream, onClose }) {
    return new Promise((resolve, reject) => {
        const sockets = new Set();
        const server = net.createServer(async (localSocket) => {
            let remoteSocket = null;
            sockets.add(localSocket);
            localSocket.on('close', () => sockets.delete(localSocket));
            localSocket.on('error', (err) => console.warn('[tcp-forward]', 'local socket error', { route, target: targetLabel, error: err.message }));

            try {
                remoteSocket = await openTargetStream();
                sockets.add(remoteSocket);
                remoteSocket.on('close', () => sockets.delete(remoteSocket));
                remoteSocket.on('error', (err) => console.warn('[tcp-forward]', 'remote socket error', { route, target: targetLabel, error: err.message }));
                localSocket.pipe(remoteSocket);
                remoteSocket.pipe(localSocket);
            } catch (err) {
                console.warn('[tcp-forward]', 'failed to open target stream', { route, target: targetLabel, error: err.message });
                try { localSocket.destroy(err); } catch {}
                try { remoteSocket?.destroy?.(); } catch {}
            }
        });

        const close = () => {
            console.info('[tcp-forward]', 'closing local forward', { route, target: targetLabel });
            try { server.close(); } catch {}
            sockets.forEach((socket) => {
                try { socket.destroy(); } catch {}
            });
            try { onClose?.(); } catch {}
        };

        server.once('error', (err) => {
            close();
            reject(err);
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            console.info('[tcp-forward]', 'local forward ready', { local: `127.0.0.1:${address.port}`, route, target: targetLabel });
            resolve({ host: '127.0.0.1', port: address.port, route, close });
        });
    });
}

async function createRoutedTcpForward(conn, targetPort, timeout = 10000) {
    const plan = resolveRoutePlan(conn);
    const targetHost = String(conn.host || '');
    const port = Number(targetPort) || Number(conn.port) || 0;
    const targetLabel = `${targetHost}:${port}`;
    const clients = [];

    try {
        if (!plan.hops.length) {
            if (!plan.firstProxy) {
                return null;
            }

            const route = `代理 ${plan.firstProxy.name || plan.firstProxy.host} -> ${conn.name || targetLabel}`;
            return await listenLocalTcpForward({
                route,
                targetLabel,
                openTargetStream: () => openProxyConnection(plan.firstProxy, targetHost, port, timeout),
            });
        }

        const firstSock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, plan.hops[0].host, plan.hops[0].port, timeout) : undefined;
        let currentClient = await connectSSHClient(plan.hops[0], { timeout, sock: firstSock });
        clients.push(currentClient);

        for (const hop of plan.hops.slice(1)) {
            const tunnel = await forwardOut(currentClient, hop.host, hop.port);
            currentClient = await connectSSHClient(hop, { timeout, sock: tunnel });
            clients.push(currentClient);
        }

        const route = [...plan.hops.map((h) => h.routeName || h.name || h.host), conn.name || targetLabel].join(' -> ');
        return await listenLocalTcpForward({
            route,
            targetLabel,
            openTargetStream: () => forwardOut(currentClient, targetHost, port),
            onClose: () => clients.reverse().forEach((client) => { try { client.end(); } catch {} }),
        });
    } catch (err) {
        clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        throw err;
    }
}

function classifySSHError(err) {
    const msg = String(err?.message || err || '连接失败');
    if (/timed out|timeout/i.test(msg)) return { code: 'timeout', message: '连接超时' };
    if (/authentication|auth|All configured authentication methods failed/i.test(msg)) return { code: 'auth_failed', message: '认证失败' };
    if (/ECONNREFUSED|refused/i.test(msg)) return { code: 'refused', message: '连接被拒绝' };
    if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH|unreachable/i.test(msg)) return { code: 'unreachable', message: '网络不可达或主机不存在' };
    return { code: 'unknown', message: msg };
}

function testSSHConnection(conn, timeout = 10000) {
    return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        let routed = null;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
            resolve({ ...result, durationMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish({ ok: false, ...classifySSHError(new Error('timeout')) }), timeout + 1000);
        createRoutedSSHConnection(conn, timeout)
            .then((result) => { routed = result; finish({ ok: true, code: 'success', message: `连接成功（${result.route}）` }); })
            .catch((err) => finish({ ok: false, ...classifySSHError(err) }));
    });
}

function isLocalGuacdHost(host = GUACD_HOST) {
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(String(host || '').toLowerCase());
}

function probeTcpPort(host, port, timeout = 700) {
    return new Promise((resolve) => {
        const socket = net.createConnection(Number(port), host);
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch {}
            resolve(ok);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function ensureEmbeddedGuacd() {
    if (!GUACD_EMBEDDED) {
        console.info('[guacd-embedded]', 'disabled by GUACD_EMBEDDED=false');
        return null;
    }
    if (!isLocalGuacdHost()) {
        console.info('[guacd-embedded]', 'skip embedded guacd for non-local host', { guacdHost: GUACD_HOST, guacdPort: GUACD_PORT });
        return null;
    }
    if (await probeTcpPort(GUACD_HOST, GUACD_PORT)) {
        console.info('[guacd-embedded]', 'guacd already listening', { guacdHost: GUACD_HOST, guacdPort: GUACD_PORT });
        return null;
    }

    console.info('[guacd-embedded]', 'starting bundled guacd', { bin: GUACD_BIN, guacdHost: GUACD_HOST, guacdPort: GUACD_PORT, logLevel: GUACD_LOG_LEVEL });
    const child = spawn(GUACD_BIN, ['-f', '-b', GUACD_HOST, '-l', String(GUACD_PORT), '-L', GUACD_LOG_LEVEL], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
    });

    child.stdout.on('data', (chunk) => console.info('[guacd]', chunk.toString('utf8').trim()));
    child.stderr.on('data', (chunk) => console.warn('[guacd]', chunk.toString('utf8').trim()));
    child.on('error', (err) => console.error('[guacd-embedded]', 'failed to start guacd', { error: err.message, bin: GUACD_BIN }));
    child.on('exit', (code, signal) => console.warn('[guacd-embedded]', 'guacd exited', { code, signal }));

    process.on('exit', () => { try { child.kill('SIGTERM'); } catch {} });
    process.on('SIGINT', () => { try { child.kill('SIGTERM'); } catch {}; process.exit(0); });
    process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {}; process.exit(0); });

    for (let i = 0; i < 20; i += 1) {
        if (await probeTcpPort(GUACD_HOST, GUACD_PORT, 500)) {
            console.info('[guacd-embedded]', 'bundled guacd ready', { guacdHost: GUACD_HOST, guacdPort: GUACD_PORT });
            return child;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.warn('[guacd-embedded]', 'guacd did not become ready before timeout; VNC connect will report detailed errors');
    return child;
}

function guacamoleProtocol(conn) {
    const protocol = String(conn?.protocol || '').toLowerCase();
    if (protocol === 'rdp' || protocol === 'vnc') return protocol;
    throw new Error(`不支持的 Guacamole 协议：${conn?.protocol || '-'}`);
}

function guacamoleDefaultPort(protocol) {
    return protocol === 'rdp' ? 3389 : protocol === 'vnc' ? 5900 : 0;
}

function guacInstruction(opcode, ...args) {
    return [opcode, ...args].map((value) => {
        const text = String(value ?? '');
        return `${text.length}.${text}`;
    }).join(',') + ';';
}

class GuacParser {
    constructor(oninstruction) {
        this.buffer = '';
        this.elements = [];
        this.oninstruction = oninstruction;
    }

    receive(chunk) {
        this.buffer += String(chunk || '');
        while (this.buffer.length) {
            const lengthEnd = this.buffer.indexOf('.');
            if (lengthEnd === -1) return;

            const lengthText = this.buffer.slice(0, lengthEnd);
            if (!/^\d+$/.test(lengthText)) throw new Error('guacd 返回了非法指令长度');
            const length = Number.parseInt(lengthText, 10);
            const elementStart = lengthEnd + 1;
            const elementEnd = elementStart + length;
            if (this.buffer.length <= elementEnd) return;

            const terminator = this.buffer[elementEnd];
            if (terminator !== ',' && terminator !== ';') throw new Error('guacd 返回了非法指令终止符');

            this.elements.push(this.buffer.slice(elementStart, elementEnd));
            this.buffer = this.buffer.slice(elementEnd + 1);

            if (terminator === ';') {
                const opcode = this.elements.shift();
                const args = this.elements;
                this.elements = [];
                if (opcode) this.oninstruction?.(opcode, args);
            }
        }
    }
}

function guacamoleParameterMap(conn, { width = 1280, height = 720, dpi = 96 } = {}) {
    const protocol = guacamoleProtocol(conn);
    const port = Number(conn.port) || guacamoleDefaultPort(protocol);
    const base = {
        hostname: String(conn.host || ''),
        port: String(port),
        username: String(conn.username || ''),
        password: String(conn.password || ''),
        width: String(Math.max(320, Number(width) || 1280)),
        height: String(Math.max(240, Number(height) || 720)),
        dpi: String(Math.max(72, Number(dpi) || 96)),
        'enable-wallpaper': 'false',
        'ignore-cert': 'true',
        'server-layout': 'en-us-qwerty',
        'color-depth': '24',
        'resize-method': 'display-update',
    };

    if (protocol === 'rdp') {
        base.security = 'any';
        base['disable-auth'] = 'false';
        base['enable-font-smoothing'] = 'true';
        base['enable-desktop-composition'] = 'false';

        // 明确启用 RDP 剪贴板双向重定向。guacd/RDP 默认通常启用，
        // 但显式传参可以避免连接配置或旧 guacd 默认值导致复制/粘贴被禁用。
        base['disable-copy'] = 'false';
        base['disable-paste'] = 'false';
        base['clipboard-encoding'] = 'UTF-8';
        console.info('[guacamole]', 'RDP clipboard redirection enabled', {
            connectionId: conn.id || '',
            disableCopy: base['disable-copy'],
            disablePaste: base['disable-paste'],
            clipboardEncoding: base['clipboard-encoding'],
        });
    }

    if (protocol === 'vnc') {
        base['encodings'] = 'tight zrle ultra copyrect hextile raw';
        base['read-only'] = 'false';
    }

    return base;
}

function nextGuacdInstruction(socket, parser, timeout, label = 'guacd 握手') {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(new Error(`${label}超时`)), timeout);
        const onData = (chunk) => {
            try { parser.receive(chunk.toString('utf8')); } catch (err) { finish(err); }
        };
        const onError = (err) => finish(err);
        const oldHandler = parser.oninstruction;
        const finish = (err, instruction) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            parser.oninstruction = oldHandler;
            if (err) reject(err); else resolve(instruction);
        };
        parser.oninstruction = (opcode, args) => finish(null, { opcode, args });
        socket.on('data', onData);
        socket.once('error', onError);
    });
}

async function openGuacdSession(conn, display = {}, timeout = 10000) {
    const protocol = guacamoleProtocol(conn);
    if (!conn.host) throw new Error('主机不能为空');

    const targetPort = Number(conn.port) || guacamoleDefaultPort(protocol);
    let routedForward = null;
    let effectiveConn = conn;
    let socket = null;

    try {
        routedForward = await createRoutedTcpForward(conn, targetPort, timeout);
        if (routedForward) {
            effectiveConn = { ...conn, host: routedForward.host, port: routedForward.port };
            console.info('[guacamole]', 'RDP/VNC using routed local forward', {
                connectionId: conn.id,
                mode: conn.connectionMode || 'direct',
                protocol,
                route: routedForward.route,
                originalTarget: `${conn.host}:${targetPort}`,
                guacdTarget: `${routedForward.host}:${routedForward.port}`,
            });
        }

        console.info('[guacd]', 'opening session', {
            guacdHost: GUACD_HOST,
            guacdPort: GUACD_PORT,
            protocol,
            target: `${effectiveConn.host}:${Number(effectiveConn.port) || guacamoleDefaultPort(protocol)}`,
            originalTarget: `${conn.host}:${targetPort}`,
            route: routedForward?.route || 'direct',
        });

        socket = net.createConnection(GUACD_PORT, GUACD_HOST);
        socket.setEncoding('utf8');
        await waitForSocket(socket, timeout, 'guacd');
        const parser = new GuacParser();

        socket.write(guacInstruction('select', protocol));
        const argsInstruction = await nextGuacdInstruction(socket, parser, timeout, 'guacd args');
        if (argsInstruction.opcode !== 'args') throw new Error(`guacd 未返回 args 指令：${argsInstruction.opcode}`);

        const params = guacamoleParameterMap(effectiveConn, display);
        socket.write(guacInstruction('size', params.width, params.height, params.dpi));
        socket.write(guacInstruction('audio', 'audio/L16;rate=44100,channels=2'));
        socket.write(guacInstruction('video'));
        socket.write(guacInstruction('image', 'image/png', 'image/jpeg'));
        socket.write(guacInstruction('connect', ...argsInstruction.args.map((name) => params[name] ?? '')));

        const readyInstruction = await nextGuacdInstruction(socket, parser, timeout, 'guacd ready');
        if (readyInstruction.opcode !== 'ready') throw new Error(`guacd 连接目标失败：${readyInstruction.opcode} ${readyInstruction.args.join(' ')}`.trim());
        const uuid = readyInstruction.args[0] || crypto.randomUUID();
        console.info('[guacd]', 'session ready', { protocol, uuid, target: conn.name || conn.host, route: routedForward?.route || 'direct' });
        return { socket, uuid, routedForward };
    } catch (err) {
        try { socket?.destroy(); } catch {}
        try { routedForward?.close?.(); } catch {}
        throw err;
    }
}

async function testGuacamoleConnection(conn, timeout = 10000) {
    const started = Date.now();
    let session = null;
    try {
        session = await openGuacdSession(conn, { width: 1024, height: 768, dpi: 96 }, timeout);
        return { ok: true, code: 'success', message: `${String(conn.protocol).toUpperCase()} 连接成功（guacd ${GUACD_HOST}:${GUACD_PORT}）`, durationMs: Date.now() - started };
    } catch (err) {
        const msg = String(err?.message || err || '连接失败');
        const code = /timeout|超时/i.test(msg) ? 'timeout' : /ECONNREFUSED|refused/i.test(msg) ? 'refused' : /auth|认证|password/i.test(msg) ? 'auth_failed' : 'unknown';
        console.warn('[guacamole-test]', 'connection failed', { protocol: conn.protocol, target: conn.host, code, error: msg });
        return { ok: false, code, message: msg, durationMs: Date.now() - started };
    } finally {
        try { session?.socket?.write(guacInstruction('disconnect')); } catch {}
        try { session?.socket?.end(); } catch {}
        try { session?.socket?.destroy(); } catch {}
        try { session?.routedForward?.close?.(); } catch {}
    }
}

function runRemoteCommand(conn, command, timeoutSeconds = 30) {
    return new Promise((resolve) => {
        const started = Date.now();
        let settled = false;
        let stdout = '';
        let stderr = '';
        const timeoutMs = Math.max(1, Math.min(Number(timeoutSeconds) || 30, 300)) * 1000;
        let routed = null;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
            resolve({ connectionId: conn.id, name: conn.name, host: conn.host, stdout, stderr, durationMs: Date.now() - started, ...result });
        };
        const timer = setTimeout(() => done({ status: 'timeout', success: false, error: `执行超时（${timeoutSeconds}s）` }), timeoutMs);
        createRoutedSSHConnection(conn, Math.min(timeoutMs, 15000)).then((result) => {
            routed = result;
            const client = result.client;
            client.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
                if (err) return done({ status: 'failed', success: false, error: err.message });
                stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
                stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
                stream.on('close', (code) => done({ status: code === 0 ? 'success' : 'failed', success: code === 0, exitCode: code, error: code === 0 ? '' : (stderr || stdout || `退出码 ${code}`).trim() }));
            });
        }).catch((err) => done({ status: 'failed', success: false, error: classifySSHError(err).message }));
    });
}

function addActivity(message) {
    storage.addActivity({ id: crypto.randomUUID(), time: Date.now(), message, type: 'info' });
}

function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '') || 'unknown';
}

function publicOrigin(req) { return req.headers.origin || (process.env.PUBLIC_ORIGIN && process.env.PUBLIC_ORIGIN !== 'http://localhost:3000' ? process.env.PUBLIC_ORIGIN : `${req.protocol}://${req.get('host')}`); }
function rpIdFromOrigin(origin) { try { return new URL(origin).hostname; } catch { return 'localhost'; } }
function safeSettings(s = storage.getSettings()) {
    const copy = JSON.parse(JSON.stringify(s || {}));
    if (copy.mail?.pass) copy.mail.pass = '******';
    if (copy.captcha?.secretKey) copy.captcha.secretKey = '******';
    if (copy.captcha?.tencentAppSecretKey) copy.captcha.tencentAppSecretKey = '******';
    if (copy.captcha?.tencentSecretKey) copy.captcha.tencentSecretKey = '******';
    if (copy.captcha?.aliyunAccessKeySecret) copy.captcha.aliyunAccessKeySecret = '******';
    return copy;
}
function mergeSecret(oldValue, newValue) { return newValue === '******' ? oldValue : (newValue ?? oldValue ?? ''); }
function normalizeSettingsInput(body) {
    const current = storage.getSettings();
    const next = { ...body };
    if (body.mail) next.mail = { ...(current.mail || {}), ...body.mail, pass: mergeSecret(current.mail?.pass, body.mail.pass) };
    if (body.captcha) next.captcha = {
        ...(current.captcha || {}),
        ...body.captcha,
        provider: normalizeCaptchaProvider(body.captcha.provider || current.captcha?.provider),
        secretKey: mergeSecret(current.captcha?.secretKey, body.captcha.secretKey),
        tencentAppSecretKey: mergeSecret(current.captcha?.tencentAppSecretKey, body.captcha.tencentAppSecretKey),
        tencentSecretKey: mergeSecret(current.captcha?.tencentSecretKey, body.captcha.tencentSecretKey),
        aliyunAccessKeySecret: mergeSecret(current.captcha?.aliyunAccessKeySecret, body.captcha.aliyunAccessKeySecret)
    };
    if (body.appearance) {
        const currentAppearance = current.appearance || {};
        const brandName = String(body.appearance.brandName ?? currentAppearance.brandName ?? 'Zephyr').trim().slice(0, 40) || 'Zephyr';
        const rawIcon = String(body.appearance.brandIcon ?? currentAppearance.brandIcon ?? '🌬️').trim();
        const isAllowedIcon = rawIcon === '🌬️' || /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(rawIcon);
        const theme = body.appearance.theme === 'light' || body.appearance.theme === 'dark' ? body.appearance.theme : 'auto';
        next.appearance = {
            ...currentAppearance,
            ...body.appearance,
            brandName,
            brandIcon: isAllowedIcon ? rawIcon : (currentAppearance.brandIcon || '🌬️'),
            theme,
            autoThemeEnabled: body.appearance.autoThemeEnabled !== false,
        };
        console.info('[appearance-settings]', 'normalized appearance settings', {
            brandName,
            customIcon: next.appearance.brandIcon !== '🌬️',
            theme: next.appearance.theme,
            autoThemeEnabled: next.appearance.autoThemeEnabled,
        });
    }
    if (body.beian) {
        next.beian = { ...(current.beian || {}), ...body.beian };
        next.icp = next.beian.icp || '';
        next.icpUrl = next.beian.icpUrl || '';
        next.policeBeian = next.beian.policeBeian || '';
        next.policeBeianUrl = next.beian.policeBeianUrl || '';
        next.showBeian = next.beian.show !== false;
    }
    if (Array.isArray(body.snippets)) {
        next.snippets = body.snippets.slice(0, 500).map((item) => ({
            id: String(item?.id || crypto.randomUUID()).slice(0, 80),
            name: String(item?.name || '').slice(0, 60),
            command: String(item?.command || '').slice(0, 20000),
            group: String(item?.group || '').slice(0, 40),
            autoRun: !!item?.autoRun,
            updatedAt: Number(item?.updatedAt || Date.now()),
        })).filter((item) => item.name && item.command.trim());
    }
    return next;
}

function createSession(res, user, { remember = false } = {}) {
    const sid = crypto.randomUUID();
    sessions.set(sid, { username: user.username, createdAt: Date.now(), mustChangePassword: !!user.defaultPassword });
    const maxAge = remember ? '; Max-Age=2592000' : '';
    res.setHeader('Set-Cookie', `zephyr_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax${maxAge}`);
    return sid;
}

function isPrivateOrLocalIp(ip) {
    try {
        if (!ip || ip === 'unknown') return true;
        const addr = ipaddr.parse(ip);
        const range = addr.range();
        return ['private', 'loopback', 'linkLocal', 'uniqueLocal', 'unspecified'].includes(range);
    } catch {
        return true;
    }
}

async function regionOf(ip) {
    const normalizedIp = String(ip || '').trim();
    if (!normalizedIp || normalizedIp === 'unknown') return '';
    if (isPrivateOrLocalIp(normalizedIp)) {
        console.info('[IP-GEO] 跳过本地/私有地址查询', { ip: normalizedIp });
        return '本地/内网';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
        const url = `http://ip-api.com/json/${encodeURIComponent(normalizedIp)}?fields=status,country,city,message,query`;
        console.info('[IP-GEO] 开始查询 IP 地区', { ip: normalizedIp, provider: 'ip-api.com' });
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== 'success') {
            console.warn('[IP-GEO] 查询失败', { ip: normalizedIp, httpStatus: response.status, status: data.status || '', message: data.message || '' });
            return '未查询';
        }
        const country = String(data.country || '').trim();
        const city = String(data.city || '').trim();
        const region = [country, city].filter(Boolean).join('/');
        console.info('[IP-GEO] 查询成功', { ip: normalizedIp, query: data.query || '', region: region || '未查询' });
        return region || '未查询';
    } catch (err) {
        console.warn('[IP-GEO] 查询异常', { ip: normalizedIp, error: err.message });
        return '未查询';
    } finally {
        clearTimeout(timer);
    }
}
function publicMailDebug(mail = {}, to = '') {
    return {
        enabled: !!mail.enabled,
        host: mail.host || '',
        port: Number(mail.port) || 465,
        secure: mail.secure !== false,
        user: mail.user ? '******' : '',
        from: mail.from || mail.user || '',
        to: to || mail.adminEmail || '',
        hasPass: !!mail.pass,
    };
}
function validateMailConfig(mail = {}, to = '') {
    const recipient = String(to || mail.adminEmail || '').trim();
    if (!mail.enabled) throw new Error('邮件通知未启用，请先保存并启用邮件通知');
    if (!mail.host) throw new Error('SMTP Host 未配置');
    if (!recipient) throw new Error('收件人邮箱未配置，请填写后台管理员邮箱');
    if (!mail.from && !mail.user) throw new Error('发件人或 SMTP 用户名未配置');
    return recipient;
}
function mailTransport(mail) {
    console.debug('[MAIL] 创建 SMTP 传输器:', publicMailDebug(mail));
    return nodemailer.createTransport({ host: mail.host, port: Number(mail.port) || 465, secure: mail.secure !== false, auth: mail.user ? { user: mail.user, pass: mail.pass || '' } : undefined });
}
async function sendMail(subject, text, to) {
    const mail = storage.getSettings().mail || {};
    const recipient = validateMailConfig(mail, to);
    const info = await mailTransport(mail).sendMail({ from: mail.from || mail.user, to: recipient, subject, text });
    console.info('[MAIL] 邮件发送成功:', { to: recipient, subject, messageId: info?.messageId || '' });
    return { ok: true, messageId: info?.messageId || '' };
}
async function notifyLogin({ username, ip, userAgent, success, reason }) {
    const s = storage.getSettings();
    const mail = s.mail || {};
    const region = mail.geoLookupEnabled ? await regionOf(ip) : '';
    storage.addLoginEvent({ id: crypto.randomUUID(), username, ip, region, userAgent, success, reason, time: Date.now() });
    if (!mail.enabled || (success && !mail.notifyLoginSuccess) || (!success && !mail.notifyLoginFailure)) return;
    const title = success ? 'Zephyr 登录成功通知' : 'Zephyr 登录失败通知';
    const text = `${title}\n\n时间：${new Date().toLocaleString()}\n账号：${username || '-'}\nIP地址：${ip}\n地区：${region || '-'}\n${success ? '' : `失败原因：${reason || '-'}\n`}User-Agent：${userAgent || '-'}`;
    sendMail(title, text).catch((err) => console.error('[MAIL] 登录通知失败:', err.message));
}

function normalizeCaptchaProvider(provider) {
    const value = String(provider || 'turnstile').toLowerCase();
    if (value === 'recaptcha' || value === 'google-recaptcha') return 'google';
    if (['turnstile', 'hcaptcha', 'google', 'tencent', 'aliyun'].includes(value)) return value;
    return 'turnstile';
}

function parseCaptchaToken(token) {
    if (typeof token !== 'string') return token || {};
    try { return JSON.parse(token); } catch { return token; }
}

function hmacSha256(key, value, encoding) {
    return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function tencentTc3Sign({ secretId, secretKey, service, host, action, version, region = '', payload }) {
    const algorithm = 'TC3-HMAC-SHA256';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const hashedRequestPayload = sha256Hex(payload);
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
    const secretDate = hmacSha256(`TC3${secretKey}`, date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign, 'hex');
    return {
        authorization: `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        timestamp,
        region,
        version
    };
}

async function verifyTencentCaptcha(captcha, token, remoteIp) {
    const parsed = parseCaptchaToken(token);
    const ticket = parsed?.ticket || parsed?.Ticket || '';
    const randstr = parsed?.randstr || parsed?.Randstr || '';
    const captchaAppId = captcha.tencentCaptchaAppId || captcha.siteKey || '';
    const appSecretKey = captcha.tencentAppSecretKey || captcha.secretKey || '';
    const secretId = captcha.tencentSecretId || process.env.TENCENT_SECRET_ID || '';
    const secretKey = captcha.tencentSecretKey || process.env.TENCENT_SECRET_KEY || '';
    if (!ticket || !randstr || !captchaAppId || !appSecretKey) return { ok: false, message: '腾讯云验证码参数不完整' };

    const payload = JSON.stringify({ CaptchaType: 9, Ticket: ticket, Randstr: randstr, CaptchaAppId: Number(captchaAppId) || captchaAppId, AppSecretKey: appSecretKey, UserIp: remoteIp || '' });

    if (!secretId || !secretKey) {
        const params = new URLSearchParams({ aid: captchaAppId, AppSecretKey: appSecretKey, Ticket: ticket, Randstr: randstr, UserIP: remoteIp || '' });
        const response = await fetch('https://ssl.captcha.qq.com/ticket/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
        const data = await response.json().catch(() => ({}));
        return { ok: data.response === '1' || data.CaptchaCode === 1, message: data.err_msg || data.CaptchaMsg || '' };
    }

    const host = 'captcha.tencentcloudapi.com';
    const service = 'captcha';
    const action = 'DescribeCaptchaResult';
    const version = '2019-07-22';
    const signed = tencentTc3Sign({ secretId, secretKey, service, host, action, version, payload });
    const response = await fetch(`https://${host}`, {
        method: 'POST',
        headers: {
            Authorization: signed.authorization,
            'Content-Type': 'application/json; charset=utf-8',
            Host: host,
            'X-TC-Action': action,
            'X-TC-Timestamp': String(signed.timestamp),
            'X-TC-Version': signed.version,
            ...(signed.region ? { 'X-TC-Region': signed.region } : {})
        },
        body: payload
    });
    const data = await response.json().catch(() => ({}));
    const result = data.Response || {};
    return { ok: Number(result.CaptchaCode) === 1, message: result.CaptchaMsg || data.Response?.Error?.Message || '' };
}

function aliyunPercentEncode(value) {
    return encodeURIComponent(String(value)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function parseAliyunAccessKeys(captcha) {
    const rawSecret = captcha.aliyunAccessKeySecret || captcha.secretKey || '';
    const rawId = captcha.aliyunAccessKeyId || process.env.ALIYUN_ACCESS_KEY_ID || '';
    if (rawSecret.includes(':')) {
        const [accessKeyId, ...secretParts] = rawSecret.split(':');
        return { accessKeyId: accessKeyId.trim(), accessKeySecret: secretParts.join(':').trim() };
    }
    return { accessKeyId: rawId, accessKeySecret: rawSecret };
}

async function verifyAliyunCaptcha(captcha, token) {
    const captchaVerifyParam = typeof token === 'string' ? token : JSON.stringify(token || {});
    const { accessKeyId, accessKeySecret } = parseAliyunAccessKeys(captcha);
    if (!captchaVerifyParam || !accessKeyId || !accessKeySecret) return { ok: false, message: '阿里云验证码参数不完整：Secret Key 请填写 AccessKeyId:AccessKeySecret，或通过环境变量 ALIYUN_ACCESS_KEY_ID 提供 AccessKeyId' };
    const params = {
        AccessKeyId: accessKeyId,
        Action: 'VerifyCaptcha',
        CaptchaVerifyParam: captchaVerifyParam,
        Format: 'JSON',
        RegionId: captcha.aliyunRegionId || process.env.ALIYUN_CAPTCHA_REGION || 'cn-shanghai',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: new Date().toISOString(),
        Version: '2023-03-05'
    };
    const canonicalizedQuery = Object.keys(params).sort().map((key) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`).join('&');
    const stringToSign = `GET&%2F&${aliyunPercentEncode(canonicalizedQuery)}`;
    params.Signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
    const url = `https://captcha.cn-shanghai.aliyuncs.com/?${Object.keys(params).sort().map((key) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`).join('&')}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    return { ok: data.Result === true || data.Result?.VerifyResult === true || data.Data?.Result === true || data.Success === true, message: data.Message || data.Code || '' };
}

async function verifyCaptcha(provider, token, remoteIp) {
    const captcha = storage.getSettings().captcha || {};
    if (!captcha.enabled) return true;
    const normalizedProvider = normalizeCaptchaProvider(provider || captcha.provider);
    if (!token) {
        console.warn('[captcha-verify]', 'missing token', { provider: normalizedProvider, remoteIp });
        return false;
    }
    try {
        if (normalizedProvider === 'turnstile' || normalizedProvider === 'hcaptcha' || normalizedProvider === 'google') {
            const url = normalizedProvider === 'turnstile'
                ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
                : normalizedProvider === 'hcaptcha'
                    ? 'https://hcaptcha.com/siteverify'
                    : 'https://www.google.com/recaptcha/api/siteverify';
            const body = new URLSearchParams({ secret: captcha.secretKey || '', response: token, remoteip: remoteIp });
            const r = await fetch(url, { method: 'POST', body });
            const data = await r.json().catch(() => ({}));
            console.info('[captcha-verify]', 'siteverify result', { provider: normalizedProvider, success: !!data.success, errors: data['error-codes'] || [] });
            return !!data.success;
        }
        if (normalizedProvider === 'tencent') {
            const result = await verifyTencentCaptcha(captcha, token, remoteIp);
            console.info('[captcha-verify]', 'tencent result', { success: result.ok, message: result.message || '' });
            return !!result.ok;
        }
        if (normalizedProvider === 'aliyun') {
            const result = await verifyAliyunCaptcha(captcha, token);
            console.info('[captcha-verify]', 'aliyun result', { success: result.ok, message: result.message || '' });
            return !!result.ok;
        }
        console.warn('[captcha-verify]', 'unsupported provider', { provider: normalizedProvider });
        return false;
    } catch (err) {
        console.error('[captcha-verify]', 'verification failed', { provider: normalizedProvider, error: err.message });
        return false;
    }
}

function ipAllowed(ip, listText) {
    const rules = String(listText || '').split(/[\n,\s]+/).map((v) => v.trim()).filter(Boolean);
    if (!rules.length) return true;
    try {
        const addr = ipaddr.parse(ip);
        return rules.some((rule) => {
            try { return rule.includes('/') ? addr.match(ipaddr.parseCIDR(rule)) : addr.toString() === ipaddr.parse(rule).toString(); } catch { return false; }
        });
    } catch { return false; }
}
function checkLoginGuards(req) {
    const ip = clientIp(req), s = storage.getSettings(), sec = s.security || {};
    if (sec.ipWhitelistEnabled && !ipAllowed(ip, sec.ipWhitelist)) return { ok: false, ip, reason: 'IP 不在白名单' };
    const ban = storage.getIpBan(ip);
    if (sec.bruteForceEnabled && ban?.bannedUntil && ban.bannedUntil > Date.now()) return { ok: false, ip, reason: 'IP 已被临时封禁' };
    return { ok: true, ip };
}
function recordLoginFailure(ip) {
    const sec = storage.getSettings().security || {};
    if (!sec.bruteForceEnabled || !ip || ip === 'unknown') return;
    const old = storage.getIpBan(ip) || { ip, failedCount: 0, bannedUntil: null };
    const failedCount = Number(old.failedCount || 0) + 1;
    const max = Number(sec.bruteForceMaxFailures) || 5;
    const bannedUntil = failedCount >= max ? Date.now() + (Number(sec.bruteForceBanMinutes) || 15) * 60000 : old.bannedUntil;
    storage.saveIpBan({ ip, failedCount, bannedUntil, updatedAt: Date.now() });
}
function recordLoginSuccess(ip) { if (ip && ip !== 'unknown') storage.clearIpBan(ip); }

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function encryptionKey(password = process.env.ENCRYPTION_KEY || 'please-change-this-key') { return crypto.createHash('sha256').update(String(password)).digest(); }
function encryptBuffer(buffer, password) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(password), iv); const enc = Buffer.concat([cipher.update(buffer), cipher.final()]); return Buffer.concat([Buffer.from('ZEPHYR3'), iv, cipher.getAuthTag(), enc]); }
function decryptBuffer(buffer, password) { const b = Buffer.from(buffer); if (b.slice(0, 7).toString() !== 'ZEPHYR3') throw new Error('备份格式不正确'); const iv = b.slice(7, 19), tag = b.slice(19, 35), enc = b.slice(35); const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(password), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(enc), decipher.final()]); }
async function zipBuffer(files) {
    return new Promise((resolve, reject) => {
        const chunks = []; const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('data', (c) => chunks.push(c)); archive.on('error', reject); archive.on('end', () => resolve(Buffer.concat(chunks)));
        Object.entries(files).forEach(([name, content]) => archive.append(content, { name })); archive.finalize();
    });
}

initData();
app.use(express.json({ limit: '1mb' }));

app.post('/api/auth/login', async (req, res) => {
    const { username, password, captchaToken, remember } = req.body || {};
    const guard = checkLoginGuards(req);
    const ua = req.headers['user-agent'] || '';
    if (!guard.ok) { await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: guard.reason }); return res.status(403).json({ error: guard.reason }); }
    const s = storage.getSettings();
    if (!(await verifyCaptcha(s.captcha?.provider, captchaToken, guard.ip))) { recordLoginFailure(guard.ip); await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: 'CAPTCHA 错误' }); return res.status(400).json({ error: '人机验证失败' }); }
    const user = storage.getUser(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
        recordLoginFailure(guard.ip);
        await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: '密码错误' });
        return res.status(401).json({ error: '账号或密码错误' });
    }
    if (user.totpEnabled) {
        const tempToken = crypto.randomUUID();
        tempTotpTokens.set(tempToken, { username: user.username, createdAt: Date.now(), ip: guard.ip, userAgent: ua, remember: !!remember });
        return res.json({ ok: true, requireTotp: true, tempToken });
    }
    recordLoginSuccess(guard.ip);
    createSession(res, user, { remember: !!remember });
    addActivity(`用户登录：${user.username}`);
    await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: true, reason: '' });
    res.json({ ok: true, user: { username: user.username }, mustChangePassword: !!user.defaultPassword });
});

app.post('/api/auth/totp/verify', async (req, res) => {
    const { tempToken, code } = req.body || {};
    const tmp = tempTotpTokens.get(tempToken);
    if (!tmp || Date.now() - tmp.createdAt > 5 * 60000) return res.status(400).json({ error: '验证会话已过期' });
    const user = storage.getUser(tmp.username);
    if (!user?.totpSecret || !verifySync({ secret: user.totpSecret, token: String(code || '') }).valid) { recordLoginFailure(tmp.ip); await notifyLogin({ username: tmp.username, ip: tmp.ip, userAgent: tmp.userAgent, success: false, reason: 'TOTP 错误' }); return res.status(401).json({ error: '动态验证码错误' }); }
    tempTotpTokens.delete(tempToken); recordLoginSuccess(tmp.ip); createSession(res, user, { remember: !!tmp.remember }); addActivity(`用户登录：${user.username}`); await notifyLogin({ username: user.username, ip: tmp.ip, userAgent: tmp.userAgent, success: true, reason: '' });
    res.json({ ok: true, user: { username: user.username }, mustChangePassword: !!user.defaultPassword });
});

app.post('/api/auth/forgot-password/request', async (req, res) => {
    const ip = clientIp(req), nowTs = Date.now();
    const hits = (resetRequestHits.get(ip) || []).filter((t) => nowTs - t < 10 * 60000);
    if (hits.length >= 5) return res.json({ ok: true, message: '如果邮箱匹配，验证码将发送到邮箱' });
    resetRequestHits.set(ip, [...hits, nowTs]);
    const { email, captchaToken } = req.body || {}, s = storage.getSettings();
    if (!(await verifyCaptcha(s.captcha?.provider, captchaToken, ip))) return res.json({ ok: true, message: '如果邮箱匹配，验证码将发送到邮箱' });
    const user = storage.getFirstUser(); const adminEmail = s.mail?.adminEmail || user?.email || '';
    if (user && adminEmail && String(email || '').trim().toLowerCase() === String(adminEmail).toLowerCase()) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        storage.createResetCode({ id: crypto.randomUUID(), username: user.username, email: adminEmail, codeHash: sha256(code), expiresAt: Date.now() + 10 * 60000, createdAt: Date.now() });
        sendMail('Zephyr 密码重置验证码', `Zephyr 密码重置验证码：${code}\n有效期：10 分钟。`, adminEmail).catch((err) => console.error('[MAIL] 重置验证码发送失败:', err.message));
    }
    res.json({ ok: true, message: '如果邮箱匹配，验证码将发送到邮箱' });
});

app.post('/api/auth/forgot-password/reset', (req, res) => {
    const { email, code, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
    const user = storage.getFirstUser(); const adminEmail = storage.getSettings().mail?.adminEmail || user?.email || '';
    const rec = user ? storage.findResetCode(user.username, adminEmail) : null;
    if (!user || !adminEmail || String(email || '').toLowerCase() !== String(adminEmail).toLowerCase() || !rec || rec.expiresAt < Date.now() || rec.codeHash !== sha256(code)) return res.status(400).json({ error: '验证码无效或已过期' });
    storage.updateUser(user.username, { passwordHash: hashPassword(newPassword), defaultPassword: false }); storage.markResetCodeUsed(rec.id); addActivity('通过邮箱验证码重置密码');
    res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req).zephyr_sid;
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'zephyr_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: { username: req.session.username }, mustChangePassword: !!req.session.mustChangePassword });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
    const data = readJSON(USERS_FILE, { users: [] });
    const user = data.users.find((u) => u.username === req.session.username);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) return res.status(400).json({ error: '当前密码错误' });
    user.passwordHash = hashPassword(newPassword);
    user.defaultPassword = false;
    user.updatedAt = Date.now();
    writeJSON(USERS_FILE, data);
    req.session.mustChangePassword = false;
    res.json({ ok: true });
});

app.post('/api/security/totp/setup', requireAuth, async (req, res) => {
    const user = storage.getUser(req.session.username); const secret = generateSecret();
    const otpauth = generateURI({ label: user.username, issuer: 'Zephyr', secret }); const qr = await QRCode.toDataURL(otpauth);
    req.session.pendingTotpSecret = secret; res.json({ secret, qr });
});
app.post('/api/security/totp/enable', requireAuth, (req, res) => {
    const secret = req.session.pendingTotpSecret; if (!secret || !verifySync({ secret, token: String(req.body?.code || '') }).valid) return res.status(400).json({ error: '动态验证码错误' });
    storage.updateUser(req.session.username, { totpEnabled: true, totpSecret: secret }); delete req.session.pendingTotpSecret; addActivity('开启 TOTP 两步验证'); res.json({ ok: true });
});
app.post('/api/security/totp/disable', requireAuth, (req, res) => {
    const user = storage.getUser(req.session.username); const { currentPassword, code } = req.body || {};
    if (!verifyPassword(currentPassword, user.passwordHash) || !verifySync({ secret: user.totpSecret || '', token: String(code || '') }).valid) return res.status(400).json({ error: '密码或动态验证码错误' });
    storage.updateUser(user.username, { totpEnabled: false, totpSecret: null }); addActivity('关闭 TOTP 两步验证'); res.json({ ok: true });
});
app.get('/api/security/status', requireAuth, (req, res) => { const u = storage.getUser(req.session.username); res.json({ user: { username: u.username, email: u.email || '', totpEnabled: !!u.totpEnabled }, passkeys: storage.listPasskeys(u.username).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) }); });
app.put('/api/security/profile', requireAuth, (req, res) => {
    const nextUsername = String(req.body?.username || '').trim();
    if (!nextUsername) return res.status(400).json({ error: '用户名不能为空' });
    if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(nextUsername)) return res.status(400).json({ error: '用户名需为 2-32 位字母、数字或 ._@-' });
    try {
        let u = storage.updateUser(req.session.username, { email: String(req.body?.email || '') });
        if (nextUsername !== req.session.username) {
            u = storage.renameUser(req.session.username, nextUsername);
            req.session.username = nextUsername;
            addActivity(`修改登录用户名：${nextUsername}`);
        }
        res.json({ user: { username: u.username, email: u.email || '', totpEnabled: !!u.totpEnabled } });
    } catch (err) {
        res.status(400).json({ error: err.message || '修改资料失败' });
    }
});

app.get('/api/connections', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    res.json({ connections: (store.connections || []).map(publicConnection), activities: store.activities || [] });
});

app.post('/api/connections', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const body = req.body || {};
    const protocol = String(body.protocol || 'SSH').toUpperCase();
    if (!body.name || !body.host || (protocol === 'SSH' && !body.username)) return res.status(400).json({ error: protocol === 'SSH' ? '名称、主机、用户名不能为空' : '名称、主机不能为空' });
    const conn = {
        id: crypto.randomUUID(),
        name: String(body.name).trim(),
        host: String(body.host).trim(),
        port: Number(body.port) || (protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : 22),
        protocol,
        username: String(body.username || '').trim(),
        password: String(body.password || ''),
        privateKey: String(body.privateKey || ''),
        sshKeyId: String(body.sshKeyId || ''),
        remark: String(body.remark || ''),
        tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : String(body.tags || '').split(',').map((v) => v.trim()).filter(Boolean),
        connectionMode: ['direct', 'proxy', 'jump'].includes(body.connectionMode) ? body.connectionMode : 'direct',
        proxyId: body.proxyId || null,
        jumpHostId: body.jumpHostId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastConnectedAt: null,
    };
    applyConnectionRouteFields(conn, body);
    store.connections.unshift(conn);
    store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `新增连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ connection: publicConnection(conn) });
});

app.put('/api/connections/:id', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const conn = (store.connections || []).find((c) => c.id === req.params.id);
    if (!conn) return res.status(404).json({ error: '连接不存在' });
    const body = req.body || {};
    ['name', 'host', 'username', 'remark'].forEach((key) => { if (body[key] !== undefined) conn[key] = String(body[key]); });
    if (body.port !== undefined) conn.port = Number(body.port) || 22;
    if (body.protocol !== undefined) conn.protocol = String(body.protocol).toUpperCase();
    if (body.tags !== undefined) conn.tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : String(body.tags || '').split(',').map((v) => v.trim()).filter(Boolean);
    if (body.sshKeyId !== undefined) conn.sshKeyId = String(body.sshKeyId || '');
    applyConnectionRouteFields(conn, body);
    if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
    if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
    conn.updatedAt = Date.now();
    store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `编辑连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ connection: publicConnection(conn) });
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const target = (store.connections || []).find((c) => c.id === req.params.id);
    store.connections = (store.connections || []).filter((c) => c.id !== req.params.id);
    if (target) store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `删除连接：${target.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ ok: true });
});

app.post('/api/connections/:id/open', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const conn = (store.connections || []).find((c) => c.id === req.params.id);
    if (!conn) return res.status(404).json({ error: '连接不存在' });
    const reveal = req.body?.purpose === 'reveal' || req.body?.secret !== undefined;
    try {
        if (reveal) {
            const auth = verifySensitiveAccess(req, req.body?.secret);
            console.info('[secret-open] reveal connection secrets', { connectionId: conn.id, name: conn.name, authMethod: auth.method });
            return res.json({ connection: { ...conn, jumpHostIds: normalizeJumpHostIds(conn) } });
        }
        conn.jumpHostIds = normalizeJumpHostIds(conn);
        conn.lastConnectedAt = Date.now();
        store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `打开连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
        writeJSON(CONNECTIONS_FILE, store);
        res.json({ connection: publicConnection(conn) });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.get('/api/settings', requireAuth, (req, res) => res.json(safeSettings(readJSON(SETTINGS_FILE, { version: '3.0.0' }))));

app.put('/api/settings', requireAuth, (req, res) => {
    const body = normalizeSettingsInput(req.body || {});
    if (body.security?.ipWhitelistEnabled && !ipAllowed(clientIp(req), body.security.ipWhitelist)) return res.status(400).json({ error: '当前 IP 不在白名单内，已阻止启用以避免误锁' });
    const settings = storage.updateSettings(body);
    addActivity('更新系统设置');
    res.json(safeSettings(settings));
});

app.post('/api/settings/test-mail', requireAuth, async (req, res) => {
    const to = String(req.body?.to || storage.getSettings().mail?.adminEmail || '').trim();
    const mail = storage.getSettings().mail || {};
    console.info('[MAIL] 开始发送测试邮件:', publicMailDebug(mail, to));
    try {
        const result = await sendMail('Zephyr 测试邮件', `这是一封 Zephyr 测试邮件。\n时间：${new Date().toLocaleString()}`, to);
        addActivity(`发送测试邮件：${to || mail.adminEmail}`);
        res.json({ ok: true, message: '测试邮件已发送', messageId: result.messageId || '' });
    } catch (err) {
        console.error('[MAIL] 测试邮件发送失败:', { ...publicMailDebug(mail, to), error: err.message });
        res.status(400).json({ error: err.message || '测试邮件发送失败' });
    }
});

app.post('/api/settings/mail/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const mail = storage.getSettings().mail || {};
        console.info('[MAIL] 读取已保存 SMTP 密码:', { ...publicMailDebug(mail), authMethod: auth.method });
        res.json({ pass: mail.pass || '', hasPass: !!mail.pass });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.post('/api/settings/captcha/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const captcha = storage.getSettings().captcha || {};
        const normalizedProvider = normalizeCaptchaProvider(captcha.provider || 'turnstile');
        const secretKey = captcha.secretKey || captcha.tencentAppSecretKey || captcha.aliyunAccessKeySecret || '';
        console.info('[captcha-open] reveal saved captcha secret', { provider: normalizedProvider, hasSecretKey: !!secretKey, authMethod: auth.method });
        res.json({
            provider: normalizedProvider,
            secretKey,
            tencentAppSecretKey: captcha.tencentAppSecretKey || captcha.secretKey || '',
            tencentSecretKey: captcha.tencentSecretKey || '',
            aliyunAccessKeySecret: captcha.aliyunAccessKeySecret || captcha.secretKey || '',
            hasSecretKey: !!secretKey
        });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.get('/api/security/ip-bans', requireAuth, (req, res) => res.json({ bans: storage.listIpBans() }));
app.delete('/api/security/ip-bans/:ip', requireAuth, (req, res) => { storage.clearIpBan(req.params.ip); res.json({ ok: true }); });
app.get('/api/security/login-events', requireAuth, (req, res) => res.json({ events: storage.listLoginEvents(100) }));
app.delete('/api/security/login-events', requireAuth, (req, res) => { storage.clearLoginEvents(); addActivity('清理登录事件日志'); res.json({ ok: true }); });
app.delete('/api/activities', requireAuth, (req, res) => { storage.clearActivities(); res.json({ ok: true }); });

app.get('/api/public/settings', (req, res) => {
    const s = storage.getSettings();
    const user = storage.getFirstUser();
    const captcha = s.captcha || {};
    const appearance = s.appearance || {};
    res.json({
        defaultUsername: user?.username || 'admin',
        appearance: {
            brandName: String(appearance.brandName || 'Zephyr').slice(0, 40) || 'Zephyr',
            brandIcon: String(appearance.brandIcon || '🌬️'),
            theme: appearance.theme === 'light' || appearance.theme === 'dark' ? appearance.theme : 'auto',
            autoThemeEnabled: appearance.autoThemeEnabled !== false,
        },
        icp: s.icp || s.beian?.icp || '',
        icpUrl: s.icpUrl || s.beian?.icpUrl || '',
        policeBeian: s.policeBeian || s.beian?.policeBeian || '',
        policeBeianUrl: s.policeBeianUrl || s.beian?.policeBeianUrl || '',
        showBeian: s.showBeian !== false && s.beian?.show !== false,
        captcha: {
            enabled: !!captcha.enabled,
            provider: normalizeCaptchaProvider(captcha.provider || 'turnstile'),
            siteKey: captcha.siteKey || captcha.tencentCaptchaAppId || captcha.aliyunCaptchaId || captcha.aliyunSceneId || '',
            tencentCaptchaAppId: captcha.tencentCaptchaAppId || captcha.siteKey || '',
            aliyunCaptchaId: captcha.aliyunCaptchaId || captcha.siteKey || '',
            aliyunSceneId: captcha.aliyunSceneId || captcha.siteKey || ''
        }
    });
});

app.get('/api/passkeys', requireAuth, (req, res) => res.json({ passkeys: storage.listPasskeys(req.session.username).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) }));
app.post('/api/passkeys/register/options', requireAuth, async (req, res) => {
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin), user = storage.getUser(req.session.username);
    const options = await generateRegistrationOptions({ rpName: 'Zephyr', rpID, userID: Buffer.from(user.username), userName: user.username, attestationType: 'none', excludeCredentials: storage.listPasskeys(user.username).map((p) => ({ id: p.credentialId, transports: p.transports })) });
    webauthnChallenges.set(`reg:${user.username}`, { challenge: options.challenge, origin, rpID }); res.json(options);
});
app.post('/api/passkeys/register/verify', requireAuth, async (req, res) => {
    const state = webauthnChallenges.get(`reg:${req.session.username}`); if (!state) return res.status(400).json({ error: '注册会话已过期' });
    try {
        const result = await verifyRegistrationResponse({ response: req.body, expectedChallenge: state.challenge, expectedOrigin: state.origin, expectedRPID: state.rpID });
        if (!result.verified) return res.status(400).json({ error: 'Passkey 验证失败' });
        const info = result.registrationInfo;
        storage.savePasskey({ id: crypto.randomUUID(), username: req.session.username, credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString('base64'), counter: info.credential.counter || 0, transports: req.body?.response?.transports || [], createdAt: Date.now(), lastUsedAt: null });
        webauthnChallenges.delete(`reg:${req.session.username}`); addActivity('绑定 Passkey'); res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message || 'Passkey 注册失败' }); }
});
app.delete('/api/passkeys/:id', requireAuth, (req, res) => { storage.deletePasskey(req.session.username, req.params.id); addActivity('删除 Passkey'); res.json({ ok: true }); });
app.post('/api/passkeys/login/options', async (req, res) => {
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin), user = storage.getFirstUser(), passkeys = user ? storage.listPasskeys(user.username) : [];
    if (!passkeys.length) return res.status(400).json({ error: '当前账号尚未绑定 Passkey' });
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })) });
    webauthnChallenges.set('login', { challenge: options.challenge, origin, rpID }); res.json(options);
});
app.post('/api/passkeys/login/verify', async (req, res) => {
    const credId = req.body?.id; const passkey = storage.getPasskeyByCredentialId(credId); if (!passkey) return res.status(400).json({ error: 'Passkey 不存在' });
    const state = webauthnChallenges.get('login');
    if (!state) return res.status(400).json({ error: 'Passkey 登录会话已过期' });
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin);
    try {
        const result = await verifyAuthenticationResponse({ response: req.body, expectedChallenge: state?.challenge || req.body?.challenge, expectedOrigin: state?.origin || origin, expectedRPID: state?.rpID || rpID, credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, 'base64'), counter: passkey.counter || 0, transports: passkey.transports } });
        if (!result.verified) return res.status(400).json({ error: 'Passkey 登录失败' });
        webauthnChallenges.delete('login'); storage.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter); const user = storage.getUser(passkey.username); createSession(res, user); addActivity(`Passkey 登录：${user.username}`); res.json({ ok: true, mustChangePassword: !!user.defaultPassword });
    } catch (err) { res.status(400).json({ error: err.message || 'Passkey 登录失败' }); }
});

app.get('/api/data/export', requireAuth, async (req, res) => {
    try { storage.rawDb().pragma('wal_checkpoint(FULL)'); } catch (err) { console.error('[DB] WAL checkpoint failed:', err.message); }
    const files = { 'zephyr.db': fs.readFileSync(path.join(DATA_DIR, 'zephyr.db')), 'manifest.json': JSON.stringify({ app: 'Zephyr', version: '3.0.0', exportedAt: Date.now() }, null, 2) };
    const encrypted = encryptBuffer(await zipBuffer(files), process.env.ENCRYPTION_KEY);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="zephyr-backup-${stamp}.zip.enc"`); res.end(encrypted);
});
app.post('/api/data/import', requireAuth, upload.single('backup'), async (req, res) => {
    try {
        const { loginPassword, backupPassword } = req.body || {}; const user = storage.getUser(req.session.username);
        if (!verifyPassword(loginPassword, user.passwordHash)) return res.status(403).json({ error: '登录密码错误' });
        if (!req.file?.buffer) return res.status(400).json({ error: '请上传备份文件' });
        const zip = decryptBuffer(req.file.buffer, backupPassword || process.env.ENCRYPTION_KEY); const dir = await unzipper.Open.buffer(zip); const dbEntry = dir.files.find((f) => f.path === 'zephyr.db');
        if (!dbEntry) return res.status(400).json({ error: '备份包缺少 zephyr.db' });
        try { storage.rawDb().pragma('wal_checkpoint(FULL)'); } catch {}
        const backupName = path.join(DATA_DIR, `zephyr-before-import-${Date.now()}.db`); fs.copyFileSync(path.join(DATA_DIR, 'zephyr.db'), backupName);
        storage.rawDb().close();
        fs.writeFileSync(path.join(DATA_DIR, 'zephyr.db'), await dbEntry.buffer());
        storage.init({ hashPassword });
        addActivity('导入数据备份');
        res.json({ ok: true, message: '导入完成，数据已重新加载' });
    } catch (err) { res.status(400).json({ error: err.message || '导入失败' }); }
});

app.post('/api/connections/test', requireAuth, async (req, res) => {
    const body = req.body || {};
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    let conn = body.connectionId ? (store.connections || []).find((c) => c.id === body.connectionId) : null;
    if (conn) {
        conn = { ...conn };
        ['name', 'host', 'username', 'remark'].forEach((key) => { if (body[key] !== undefined) conn[key] = String(body[key]); });
        if (body.port !== undefined) conn.port = Number(body.port) || 22;
        if (body.protocol !== undefined) conn.protocol = String(body.protocol).toUpperCase();
        if (body.sshKeyId !== undefined) conn.sshKeyId = String(body.sshKeyId || '');
        if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
        if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
        applyConnectionRouteFields(conn, body);
    } else {
        conn = { ...body, port: Number(body.port) || 22 };
        applyConnectionRouteFields(conn, body);
    }
    const protocol = String(conn.protocol || 'SSH').toUpperCase();
    if (!conn.host || (protocol === 'SSH' && !conn.username)) return res.status(400).json({ error: protocol === 'SSH' ? '主机和用户名不能为空' : '主机不能为空' });
    const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutSeconds || 10) * 1000, 30000));
    const result = protocol === 'SSH'
        ? await testSSHConnection(conn, timeoutMs)
        : await testGuacamoleConnection(conn, timeoutMs);
    addActivity(`测试连接：${conn.name || conn.host} - ${result.message}`);
    res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/remote-execute', requireAuth, async (req, res) => {
    const { connectionIds, command, timeoutSeconds } = req.body || {};
    if (!Array.isArray(connectionIds) || !connectionIds.length) return res.status(400).json({ error: '请选择服务器' });
    if (!String(command || '').trim()) return res.status(400).json({ error: '请输入命令' });
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const targets = (store.connections || []).filter((c) => connectionIds.includes(c.id) && c.protocol === 'SSH');
    const started = Date.now();
    const results = await Promise.all(targets.map((conn) => runRemoteCommand(conn, String(command), timeoutSeconds)));
    addActivity(`远程执行：${targets.length} 台服务器，命令 ${String(command).slice(0, 40)}`);
    res.json({ startedAt: started, durationMs: Date.now() - started, results });
});

app.get('/api/proxies', requireAuth, (req, res) => res.json({ proxies: storage.listProxies() }));
app.post('/api/proxies', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.host || !b.port) return res.status(400).json({ error: '名称、IP、端口不能为空' });
    const proxy = storage.saveProxy({ id: crypto.randomUUID(), name: String(b.name), host: String(b.host), port: Number(b.port) || 1080, type: normalizeProxyType(b.type), username: String(b.username || ''), password: String(b.password || ''), createdAt: Date.now(), updatedAt: Date.now() });
    console.debug('[proxy]', 'saved proxy', { id: proxy.id, name: proxy.name, host: proxy.host, port: proxy.port, type: proxy.type });
    addActivity(`新增代理：${proxy.name}`);
    res.json({ proxy });
});
app.put('/api/proxies/:id', requireAuth, (req, res) => {
    const old = storage.getProxyRaw(req.params.id);
    if (!old) return res.status(404).json({ error: '代理不存在' });
    const b = req.body || {};
    const proxy = storage.saveProxy({ ...old, name: String(b.name ?? old.name), host: String(b.host ?? old.host), port: Number(b.port ?? old.port) || 1080, type: normalizeProxyType(b.type ?? old.type), username: String(b.username ?? old.username ?? ''), password: b.password === '******' ? old.password : String(b.password ?? old.password ?? ''), updatedAt: Date.now() });
    console.debug('[proxy]', 'updated proxy', { id: proxy.id, name: proxy.name, host: proxy.host, port: proxy.port, type: proxy.type });
    addActivity(`编辑代理：${proxy.name}`);
    res.json({ proxy });
});
app.post('/api/proxies/:id/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const proxy = storage.getProxyRaw(req.params.id);
        if (!proxy) return res.status(404).json({ error: '代理不存在' });
        console.info('[secret-open] reveal proxy', { id: proxy.id, name: proxy.name, hasPassword: !!proxy.password, authMethod: auth.method });
        res.json({ proxy: { ...proxy, hasPassword: !!proxy.password } });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});
app.delete('/api/proxies/:id', requireAuth, (req, res) => { storage.deleteProxy(req.params.id); addActivity('删除代理'); res.json({ ok: true }); });

app.get('/api/ssh-keys', requireAuth, (req, res) => res.json({ sshKeys: storage.listSshKeys() }));
app.post('/api/ssh-keys', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: '密钥名称不能为空' });
    if (!String(b.privateKey || '').includes('-----BEGIN')) return res.status(400).json({ error: '请填写有效的 SSH 私钥' });
    const sshKey = storage.saveSshKey({ id: crypto.randomUUID(), name: String(b.name).trim(), privateKey: String(b.privateKey), passphrase: String(b.passphrase || ''), remark: String(b.remark || ''), createdAt: Date.now(), updatedAt: Date.now() });
    console.debug('[ssh-key] saved key', { id: sshKey.id, name: sshKey.name, hasPrivateKey: sshKey.hasPrivateKey, hasPassphrase: sshKey.hasPassphrase });
    addActivity(`新增 SSH 密钥：${sshKey.name}`);
    res.json({ sshKey });
});
app.put('/api/ssh-keys/:id', requireAuth, (req, res) => {
    const old = storage.getSshKeyRaw(req.params.id);
    if (!old) return res.status(404).json({ error: 'SSH 密钥不存在' });
    const b = req.body || {};
    const privateKey = b.privateKey === '******' || b.privateKey === undefined ? old.privateKey : String(b.privateKey || '');
    const passphrase = b.passphrase === '******' || b.passphrase === undefined ? old.passphrase : String(b.passphrase || '');
    if (!String((b.name ?? old.name) || '').trim()) return res.status(400).json({ error: '密钥名称不能为空' });
    if (!privateKey.includes('-----BEGIN')) return res.status(400).json({ error: '请填写有效的 SSH 私钥' });
    const sshKey = storage.saveSshKey({ ...old, name: String(b.name ?? old.name).trim(), privateKey, passphrase, remark: String(b.remark ?? old.remark ?? ''), updatedAt: Date.now() });
    console.debug('[ssh-key] updated key', { id: sshKey.id, name: sshKey.name, hasPrivateKey: sshKey.hasPrivateKey, hasPassphrase: sshKey.hasPassphrase });
    addActivity(`编辑 SSH 密钥：${sshKey.name}`);
    res.json({ sshKey });
});
app.post('/api/ssh-keys/:id/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const key = storage.getSshKeyRaw(req.params.id);
        if (!key) return res.status(404).json({ error: 'SSH 密钥不存在' });
        console.info('[secret-open] reveal ssh key', { id: key.id, name: key.name, authMethod: auth.method });
        res.json({ sshKey: { ...key, hasPrivateKey: !!key.privateKey, hasPassphrase: !!key.passphrase } });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});
app.delete('/api/ssh-keys/:id', requireAuth, (req, res) => { storage.deleteSshKey(req.params.id); addActivity('删除 SSH 密钥'); res.json({ ok: true }); });

function ensureSshJumpConnection(connectionId) {
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const conn = (store.connections || []).find((c) => c.id === String(connectionId || ''));
    if (!conn) throw new Error('跳板机连接不存在或已删除');
    if (String(conn.protocol || 'SSH').toUpperCase() !== 'SSH') throw new Error('跳板机只能选择 SSH 连接，VNC/RDP 只能作为目标通过跳板访问');
    return conn;
}

app.get('/api/jump-hosts', requireAuth, (req, res) => res.json({ jumpHosts: storage.listJumpHosts() }));
app.post('/api/jump-hosts', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.connectionId) return res.status(400).json({ error: '名称和 SSH 连接不能为空' });
    try {
        ensureSshJumpConnection(b.connectionId);
        const jumpHost = storage.saveJumpHost({ id: crypto.randomUUID(), name: String(b.name), connectionId: String(b.connectionId), createdAt: Date.now(), updatedAt: Date.now() });
        addActivity(`新增跳板机：${jumpHost.name}`);
        res.json({ jumpHost });
    } catch (err) {
        res.status(400).json({ error: err.message || '跳板机配置无效' });
    }
});
app.put('/api/jump-hosts/:id', requireAuth, (req, res) => {
    const old = storage.listJumpHosts().find((j) => j.id === req.params.id);
    if (!old) return res.status(404).json({ error: '跳板机不存在' });
    const b = req.body || {};
    const nextConnectionId = String(b.connectionId ?? old.connectionId);
    try {
        ensureSshJumpConnection(nextConnectionId);
        const jumpHost = storage.saveJumpHost({ ...old, name: String(b.name ?? old.name), connectionId: nextConnectionId, updatedAt: Date.now() });
        addActivity(`编辑跳板机：${jumpHost.name}`);
        res.json({ jumpHost });
    } catch (err) {
        res.status(400).json({ error: err.message || '跳板机配置无效' });
    }
});
app.delete('/api/jump-hosts/:id', requireAuth, (req, res) => { storage.deleteJumpHost(req.params.id); addActivity('删除跳板机'); res.json({ ok: true }); });

function execRemoteCommand(sshClient, command) {
    return new Promise((resolve, reject) => {
        if (!sshClient) return reject(new Error('SSH 未连接'));
        sshClient.exec(`sh -lc ${shellQuote(command)}`, (err, stream) => {
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

function remoteCommandArg(value) {
    return shellQuote(value);
}

function buildRemoteScript(lines) {
    return (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join('\n');
}

function remoteSameFileSafeCopyCommand(sourcePath, targetPath, { move = false, conflict = 'rename' } = {}) {
    const sourceArg = remoteCommandArg(sourcePath);
    const targetArg = remoteCommandArg(targetPath);
    return buildRemoteScript([
        'set -e',
        `src=${sourceArg}`,
        `dst=${targetArg}`,
        '[ -e "$src" ] || { echo "源文件不存在: $src" >&2; exit 2; }',
        conflict === 'cancel' ? '[ ! -e "$dst" ] || { echo "目标已存在: $dst" >&2; exit 3; }' : '',
        conflict === 'rename' ? 'if [ -e "$dst" ]; then d=$(dirname -- "$dst"); b=$(basename -- "$dst"); case "$b" in *.*) n=${b%.*}; e=.${b##*.};; *) n=$b; e=;; esac; i=1; while :; do c="$d/$n ($i)$e"; [ ! -e "$c" ] && { dst="$c"; break; }; i=$((i+1)); done; fi' : '',
        move ? 'mv -- "$src" "$dst"' : 'cp -a -- "$src" "$dst"',
    ]);
}

function normalizeRemotePath(value) {
    return String(value || '').replace(/\/+/g, '/') || '/';
}
function remoteJoin(dir, name) {
    const base = normalizeRemotePath(dir || '/').replace(/\/+$/, '') || '/';
    return base === '/' ? `/${name}` : `${base}/${name}`;
}
function isDangerousRemotePath(value) {
    const p = normalizeRemotePath(value).trim();
    return !p || p === '/' || p === '.' || p === '..';
}
function basenameRemote(value) {
    return path.posix.basename(normalizeRemotePath(value));
}
function dirnameRemote(value) {
    return path.posix.dirname(normalizeRemotePath(value));
}
function sftpStat(sftp, targetPath) {
    return new Promise((resolve, reject) => sftp.stat(targetPath, (err, stats) => err ? reject(err) : resolve(stats)));
}
function sftpMkdir(sftp, targetPath) {
    return new Promise((resolve, reject) => sftp.mkdir(targetPath, (err) => err && err.code !== 4 ? reject(err) : resolve()));
}
function sftpReaddir(sftp, targetPath) {
    return new Promise((resolve, reject) => sftp.readdir(targetPath, (err, list) => err ? reject(err) : resolve(list || [])));
}
function sftpFastGetStream(sourceSftp, sourcePath, targetSftp, targetPath, onProgress) {
    return new Promise((resolve, reject) => {
        const rs = sourceSftp.createReadStream(sourcePath, { highWaterMark: 512 * 1024 });
        const ws = targetSftp.createWriteStream(targetPath, { highWaterMark: 512 * 1024 });
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { rs.destroy?.(); } catch {}
            try { ws.destroy?.(); } catch {}
            reject(err);
        };
        rs.on('data', (chunk) => { try { onProgress?.(chunk.length); } catch {} });
        rs.on('error', fail);
        ws.on('error', fail);
        ws.on('finish', () => { if (!settled) { settled = true; resolve(); } });
        rs.pipe(ws);
    });
}
async function ensureRemoteDirRecursive(sftp, dirPath) {
    const normalized = normalizeRemotePath(dirPath);
    if (!normalized || normalized === '/') return;
    const parts = normalized.split('/').filter(Boolean);
    let cur = normalized.startsWith('/') ? '/' : '';
    for (const part of parts) {
        cur = cur === '/' ? `/${part}` : (cur ? `${cur}/${part}` : part);
        try { await sftpMkdir(sftp, cur); } catch {}
    }
}
async function copyRemoteTree(sourceSftp, sourcePath, targetSftp, targetPath, onProgress) {
    const stats = await sftpStat(sourceSftp, sourcePath);
    if (stats.isDirectory?.()) {
        await ensureRemoteDirRecursive(targetSftp, targetPath);
        const list = await sftpReaddir(sourceSftp, sourcePath);
        for (const entry of list) {
            if (!entry.filename || entry.filename === '.' || entry.filename === '..') continue;
            await copyRemoteTree(sourceSftp, remoteJoin(sourcePath, entry.filename), targetSftp, remoteJoin(targetPath, entry.filename), onProgress);
        }
        return;
    }
    await ensureRemoteDirRecursive(targetSftp, dirnameRemote(targetPath));
    await sftpFastGetStream(sourceSftp, sourcePath, targetSftp, targetPath, onProgress);
}
async function removeRemotePath(connectionConfig, targetPath) {
    if (isDangerousRemotePath(targetPath)) throw new Error('拒绝删除空路径或根目录');
    const routed = await createRoutedSSHConnection(connectionConfig, 10000);
    try { await execRemoteCommand(routed.client, `rm -rf -- ${shellQuote(targetPath)}`); }
    finally { [...(routed.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} }); }
}
async function cleanupRemoteTempFile(connectionConfig, targetPath) {
    if (!connectionConfig || !targetPath || !String(targetPath).startsWith('/tmp/zephyr-sftp-')) return;
    try { await removeRemotePath(connectionConfig, targetPath); } catch (err) { console.warn('[sftp-temp-cleanup]', 'failed', { path: targetPath, error: err.message }); }
}
async function withRoutedSftp(connectionConfig, callback) {
    const routed = await createRoutedSSHConnection(connectionConfig, 10000);
    let sftp = null;
    try {
        sftp = await new Promise((resolve, reject) => routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp)));
        return await callback({ routed, sftp });
    } finally {
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    }
}
async function pasteSftpClipboard({ username, targetSession, targetDir, mode, conflict = 'rename', sendProgress }) {
    const clip = sftpClipboardByUser.get(username);
    if (!clip || !Array.isArray(clip.items) || !clip.items.length) throw new Error('剪贴板为空');
    const targetConnectionConfig = targetSession?.connectionConfig;
    if (!targetConnectionConfig) throw new Error('目标 SSH 连接已失效');
    const sameConnection = String(clip.sourceConnectionId || '') && String(clip.sourceConnectionId) === String(targetSession.connectionId || '');
    const opId = crypto.randomUUID();
    const total = clip.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    let loaded = 0;
    const bump = (n, currentPath = '') => {
        loaded += Number(n) || 0;
        sendProgress?.({ transferId: opId, direction: mode === 'cut' ? 'move' : 'copy', path: currentPath || targetDir, loaded, size: total, status: 'active' });
    };
    if (sameConnection) {
        const commands = [];
        for (const item of clip.items) {
            const targetPath = remoteJoin(targetDir, basenameRemote(item.path));
            const command = remoteSameFileSafeCopyCommand(item.path, targetPath, { move: mode === 'cut', conflict });
            commands.push(command);
        }
        console.info('[sftp-clipboard-paste]', 'same connection paste', { count: clip.items.length, targetDir, mode });
        for (const command of commands) await execRemoteCommand(targetSession.sshClient, command);
        loaded = total;
        sendProgress?.({ transferId: opId, direction: mode === 'cut' ? 'move' : 'copy', path: targetDir, loaded, size: total, status: 'done' });
    } else {
        await withRoutedSftp(clip.sourceConnectionConfig, async ({ sftp: sourceSftp }) => {
            await withRoutedSftp(targetConnectionConfig, async ({ sftp: targetSftp }) => {
                for (const item of clip.items) {
                    const targetPath = remoteJoin(targetDir, basenameRemote(item.path));
                    await copyRemoteTree(sourceSftp, item.path, targetSftp, targetPath, (n) => bump(n, item.path));
                }
            });
        });
        if (mode === 'cut') {
            for (const item of clip.items) await removeRemotePath(clip.sourceConnectionConfig, item.path);
        }
        sendProgress?.({ transferId: opId, direction: mode === 'cut' ? 'move' : 'copy', path: targetDir, loaded: total || loaded, size: total, status: 'done' });
    }
    if (mode === 'cut') sftpClipboardByUser.delete(username);
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
app.get('/api/sftp/preview/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const previewTask = sftpPreviewTokens.get(token);
    if (!previewTask || previewTask.username !== req.session.username || previewTask.expiresAt < Date.now()) {
        sftpPreviewTokens.delete(token);
        return res.status(404).json({ error: '预览链接已失效' });
    }
    const connectionConfig = previewTask.connectionConfig;
    if (!connectionConfig) {
        sftpPreviewTokens.delete(token);
        return res.status(410).json({ error: '预览连接配置已失效，请重新打开文件管理器后预览' });
    }
    const ext = getImageExt(previewTask.path);
    if (!isPreviewImageExt(ext, PREVIEW_IMAGE_EXTENSIONS)) return res.status(415).json({ error: '当前文件不是已知图片格式' });

    let routed = null;
    let sftp = null;
    const closeConnection = () => {
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    };
    try {
        cleanupPreviewCache(previewCache);
        routed = await createRoutedSSHConnection(connectionConfig, 10000);
        sftp = await new Promise((resolve, reject) => {
            routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp));
        });
        const stats = await new Promise((resolve, reject) => {
            sftp.stat(previewTask.path, (err, nextStats) => err ? reject(err) : resolve(nextStats));
        });
        if (stats.isDirectory?.()) throw new Error('目录不支持图片预览');
        const size = Number(stats.size) || 0;
        const mtime = Number(stats.mtime) || Number(stats.modifyTime) || 0;
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(previewTask.path))}`);
        previewTask.expiresAt = Date.now() + PREVIEW_TOKEN_TTL;

        if (isBrowserImageExt(ext, BROWSER_IMAGE_EXTENSIONS)) {
            res.type(getBrowserImageContentType(ext, BROWSER_IMAGE_CONTENT_TYPES));
            if (size) res.setHeader('Content-Length', String(size));
            const readStream = sftp.createReadStream(previewTask.path);
            readStream.on('error', (err) => {
                closeConnection();
                if (!res.headersSent) res.status(500).end(err.message || '图片预览读取失败');
                else res.destroy(err);
            });
            res.on('close', closeConnection);
            res.on('finish', closeConnection);
            readStream.pipe(res);
            return;
        }

        const result = await ensurePreviewCacheFile({
            cache: { ttl: PREVIEW_CACHE_TTL },
            cacheMap: previewCache,
            cacheDir: PREVIEW_CACHE_DIR,
            sourcePath: previewTask.path,
            sourceSize: size,
            sourceMtime: mtime,
            ext,
            readSourceFile: (inputPath) => new Promise((resolve, reject) => {
                let settled = false;
                const done = (err) => {
                    if (settled) return;
                    settled = true;
                    err ? reject(err) : resolve();
                };
                const readStream = sftp.createReadStream(previewTask.path);
                const writeStream = fs.createWriteStream(inputPath);
                readStream.on('error', done);
                writeStream.on('error', done);
                writeStream.on('finish', () => done());
                readStream.pipe(writeStream);
            }),
        });
        res.type('image/webp');
        res.setHeader('X-Zephyr-Preview-Engine', result.engine || 'unknown');
        res.sendFile(result.outputPath, (err) => {
            closeConnection();
            if (err) console.warn('[sftp-preview]', 'send failed', { path: previewTask.path, error: err.message });
        });
    } catch (err) {
        closeConnection();
        console.warn('[sftp-preview]', 'failed', { path: previewTask?.path || '', error: err.message });
        if (!res.headersSent) res.status(500).json({ error: err.message || '图片预览失败' });
    }
});

// ===== 分片上传 API =====
// POST /api/sftp/upload/:token       — 上传一个分片（X-Upload-Offset 指定偏移）
// POST /api/sftp/upload/:token/complete — 完成上传，关闭句柄并校验

// 存储每个 token 对应的 SFTP session 缓存（conn/file handle）
const sftpUploadSessions = new Map(); // token -> { routed, sftp, fileHandle, totalLoaded, keepaliveTimer, settled }

function getUploadSession(token, uploadTask) {
    let session = sftpUploadSessions.get(token);
    if (session) {
        session.expiresAt = Date.now() + SFTP_UPLOAD_TOKEN_TTL;
        return session;
    }
    return null;
}

async function createUploadSession(token, uploadTask) {
    const connectionConfig = uploadTask.connectionConfig;
    if (!connectionConfig) throw new Error('上传连接配置已失效');

    const routed = await createRoutedSSHConnection(connectionConfig, 10000);
    const sftp = await new Promise((resolve, reject) => {
        routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp));
    });

    // Open file handle for offset writes
    // 断点续传: 如果已有部分数据(offset>0)，用 'r+' 避免 truncate
    // 首次上传用 'w'（create+truncate）
    const isResume = (uploadTask.loaded > 0);
    let fileHandle;
    try {
        fileHandle = await new Promise((resolve, reject) => {
            sftp.open(uploadTask.path, isResume ? 'r+' : 'w', (err, handle) => err ? reject(err) : resolve(handle));
        });
    } catch (openErr) {
        // r+ 失败（文件不存在），降级为 w
        if (isResume) {
            fileHandle = await new Promise((resolve, reject) => {
                sftp.open(uploadTask.path, 'w', (err, handle) => err ? reject(err) : resolve(handle));
            });
        } else {
            throw openErr;
        }
    }

    if (routed?.client?._sock?.setKeepAlive) {
        try { routed.client._sock.setKeepAlive(true, SFTP_UPLOAD_KEEPALIVE_INTERVAL); } catch {}
    }

    let sftpKeepaliveSeq = 0;
    const keepaliveTimer = setInterval(() => {
        if (session.settled) {
            clearInterval(keepaliveTimer);
            return;
        }
        try { routed?.client?._sock?.setKeepAlive?.(true, SFTP_UPLOAD_KEEPALIVE_INTERVAL); } catch {}
        sftpKeepaliveSeq++;
        if (sftpKeepaliveSeq % 2 === 0 && sftp && !session.settled) {
            try { sftp.realpath('.', () => {}); } catch {}
        }
    }, SFTP_UPLOAD_KEEPALIVE_INTERVAL);
    keepaliveTimer.unref?.();

    const session = {
        routed,
        sftp,
        fileHandle,
        totalLoaded: 0,
        keepaliveTimer,
        settled: false,
        expiresAt: Date.now() + SFTP_UPLOAD_TOKEN_TTL,
        username: uploadTask.username,
        path: uploadTask.path,
        uploadId: uploadTask.uploadId || '',
    };
    sftpUploadSessions.set(token, session);
    return session;
}

function destroyUploadSession(token) {
    const session = sftpUploadSessions.get(token);
    if (!session) return;
    session.settled = true;
    if (session.keepaliveTimer) clearInterval(session.keepaliveTimer);
    try {
        if (session.fileHandle) session.sftp.close(session.fileHandle, () => {});
    } catch {}
    try { session.sftp?.end?.(); } catch {}
    [...(session.routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    sftpUploadSessions.delete(token);
}

// 分片上传：每个分片一个 POST，URL query ?offset=N 指定写入位置
// 使用 query 参数而非自定义头，避免 CORS 预检（自定义头+非简单 content-type 触发 OPTIONS）
app.post('/api/sftp/upload/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const uploadTask = sftpUploadTokens.get(token);

    if (!uploadTask || uploadTask.username !== req.session.username || uploadTask.expiresAt < Date.now()) {
        sftpUploadTokens.delete(token);
        destroyUploadSession(token);
        return res.status(404).json({ error: '上传链接已失效' });
    }

    const offset = Number(req.query.offset);
    if (!Number.isFinite(offset) || offset < 0) {
        return res.status(400).json({ error: '缺少或无效的 ?offset 参数' });
    }

    let session = getUploadSession(token, uploadTask);
    if (!session) {
        try {
            session = await createUploadSession(token, uploadTask);
        } catch (err) {
            sftpUploadTokens.delete(token);
            return res.status(410).json({ error: `创建上传会话失败：${err.message}` });
        }
    }

    if (session.settled) {
        return res.status(410).json({ error: '上传会话已结束' });
    }
    if (session.username !== req.session.username) {
        return res.status(403).json({ error: '上传会话用户不匹配' });
    }

    // Collect the body (may arrive in multiple data events)
    const chunks = [];
    let bodyLength = 0;
    req.on('data', (chunk) => {
        chunks.push(chunk);
        bodyLength += chunk.length;
    });

    req.on('end', () => {
        const buffer = Buffer.concat(chunks);

        // Write chunk at offset using low-level sftp.write()
        session.sftp.write(session.fileHandle, buffer, 0, buffer.length, offset, (writeErr) => {
            if (writeErr || session.settled) {
                if (writeErr) {
                    console.warn('[sftp-upload-chunk]', 'write failed', { path: uploadTask.path, offset, size: buffer.length, error: writeErr.message });
                }
                if (!res.headersSent) {
                    return res.status(500).json({ error: writeErr ? `写入分片失败：${writeErr.message}` : '上传会话已结束' });
                }
                return;
            }

            session.totalLoaded = Math.max(session.totalLoaded, offset + buffer.length);
            uploadTask.loaded = session.totalLoaded;
            uploadTask.expiresAt = Date.now() + SFTP_UPLOAD_TOKEN_TTL;

            // Broadcast progress
            sendTransferEvent(uploadTask.username, {
                transferId: uploadTask.uploadId || token,
                direction: 'upload',
                path: uploadTask.path,
                loaded: session.totalLoaded,
                size: Number(uploadTask.size) || 0,
                status: 'active',
            });

            res.json({
                ok: true,
                received: buffer.length,
                offset,
                nextOffset: offset + buffer.length,
                totalLoaded: session.totalLoaded,
                totalSize: Number(uploadTask.size) || 0,
            });
        });
    });

    req.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).json({ error: `读取分片数据失败：${err.message}` });
        }
    });
});

// 完成上传：关闭句柄并校验
app.post('/api/sftp/upload/:token/complete', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const uploadTask = sftpUploadTokens.get(token);
    if (!uploadTask || uploadTask.username !== req.session.username) {
        sftpUploadTokens.delete(token);
        destroyUploadSession(token);
        return res.status(404).json({ error: '上传任务不存在' });
    }

    const session = sftpUploadSessions.get(token);
    if (!session) {
        sftpUploadTokens.delete(token);
        return res.status(410).json({ error: '上传会话不存在或已过期' });
    }

    // Close file handle
    try {
        await new Promise((resolve, reject) => {
            session.sftp.close(session.fileHandle, (err) => err ? reject(err) : resolve());
        });
    } catch (err) {
        console.warn('[sftp-upload-complete]', 'close handle failed', { path: uploadTask.path, error: err.message });
    }

    // Verify via stat
    try {
        const stats = await new Promise((resolve, reject) => {
            session.sftp.stat(uploadTask.path, (err, st) => err ? reject(err) : resolve(st));
        });
        const remoteSize = Number(stats.size) || 0;
        const expectedSize = Number(uploadTask.size) || 0;

        if (expectedSize && remoteSize !== expectedSize) {
            destroyUploadSession(token);
            sftpUploadTokens.delete(token);
            return res.status(500).json({
                error: `上传文件大小不匹配：期望 ${expectedSize} 字节，远端 ${remoteSize} 字节`,
                remoteSize,
                expectedSize,
            });
        }

        uploadTask.loaded = remoteSize;
        uploadTask.status = 'done';
        uploadTask.activeStream = null;
        sendTransferEvent(uploadTask.username, {
            transferId: uploadTask.uploadId || token,
            direction: 'upload',
            path: uploadTask.path,
            loaded: remoteSize,
            size: Number(uploadTask.size) || 0,
            status: 'done',
        });
        destroyUploadSession(token);
        sftpUploadTokens.delete(token);

        res.json({ ok: true, uploadId: uploadTask.uploadId || '', path: uploadTask.path, size: remoteSize });
    } catch (err) {
        console.warn('[sftp-upload-complete]', 'stat failed', { path: uploadTask.path, error: err.message });
        destroyUploadSession(token);
        sftpUploadTokens.delete(token);
        res.status(500).json({ error: `校验远端文件失败：${err.message}` });
    }
});

app.get('/api/sftp/download-progress/:token', requireAuth, (req, res) => {
    const token = String(req.params.token || '');
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) {
        return res.status(404).json({ error: '下载任务不存在' });
    }
    res.json({
        downloadId: download.downloadId || '',
        path: download.path,
        size: Number(download.size) || 0,
        loaded: Number(download.loaded) || 0,
        status: download.status || 'pending',
    });
});

app.post('/api/sftp/download-control/:token', requireAuth, (req, res) => {
    const token = String(req.params.token || '');
    const action = String(req.body?.action || '').toLowerCase();
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) return res.status(404).json({ error: '下载任务不存在' });
    if (action === 'pause') {
        download.status = 'paused';
        download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
        try { download.activeStream?.destroy?.(); } catch {}
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: Number(download.loaded) || 0, size: Number(download.size) || 0, status: 'paused' });
        return res.json({ ok: true, status: 'paused' });
    }
    if (action === 'cancel') {
        download.status = 'error';
        // fileHandle 不是 stream，destroy() 对它无效；必须直接销毁 HTTP response，
        // 并关闭底层 SFTP/SSH 连接，才能真正终止浏览器原生下载任务。
        try { download.activeResponse?.destroy?.(new Error('download cancelled')); } catch {}
        try { download.activeStream?.destroy?.(); } catch {}
        try { if (download.activeSftp && download.activeFileHandle) download.activeSftp.close(download.activeFileHandle, () => {}); } catch {}
        try { download.activeSftp?.end?.(); } catch {}
        try { [...(download.activeRouted?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} }); } catch {}
        download.activeResponse = null;
        download.activeStream = null;
        download.activeFileHandle = null;
        download.activeSftp = null;
        download.activeRouted = null;
        if (download.cleanupAfterDownload) cleanupRemoteTempFile(download.connectionConfig, download.path);
        sftpDownloadTokens.delete(token);
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: Number(download.loaded) || 0, size: Number(download.size) || 0, status: 'error' });
        return res.json({ ok: true, status: 'cancelled' });
    }
    res.status(400).json({ error: '不支持的操作' });
});

app.get('/api/sftp/download/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) {
        sftpDownloadTokens.delete(token);
        return res.status(404).send('下载链接已失效');
    }
    const session = sshTerminalSessions.get(download.sessionId);
    const connectionConfig = download.connectionConfig || session?.connectionConfig;
    if (!connectionConfig) {
        sftpDownloadTokens.delete(token);
        return res.status(410).send('下载连接配置已失效，请重新打开文件管理器后下载');
    }
    let routed = null;
    let sftp = null;
    let fileHandle = null;
    try {
        routed = await createRoutedSSHConnection(connectionConfig, 10000);
        sftp = await new Promise((resolve, reject) => {
            routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp));
        });
    } catch (err) {
        if (routed?.clients) routed.clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        sftpDownloadTokens.delete(token);
        return res.status(410).send(`下载专用 SFTP 连接失败：${err.message}`);
    }
    const fileName = String(download.displayName || path.basename(download.path || 'download') || 'download');
    const size = Number(download.size) || 0;
    const range = String(req.headers.range || '');
    let start = 0;
    let end = size > 0 ? size - 1 : undefined;
    let partial = false;
    if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        const rejectRange = () => {
            res.setHeader('Content-Range', `bytes */${size || '*'}`);
            return res.status(416).end();
        };
        if (!match || !size) return rejectRange();
        if (match[1] === '' && match[2] === '') return rejectRange();
        if (match[1] === '') {
            const suffix = Number(match[2]);
            if (!Number.isFinite(suffix) || suffix <= 0) return rejectRange();
            start = Math.max(0, size - suffix);
        } else {
            start = Number(match[1]);
            if (match[2] !== '') end = Number(match[2]);
        }
        if (!Number.isFinite(start) || start < 0 || start >= size || !Number.isFinite(end) || end < start) return rejectRange();
        end = Math.min(end, size - 1);
        partial = true;
    }
    const contentLength = size > 0 && Number.isFinite(end) ? end - start + 1 : size;
    download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
    res.status(partial ? 206 : 200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    if (size > 0) res.setHeader('Content-Length', String(contentLength));
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    let keepaliveTimer = null;
    const stopKeepalive = () => {
        if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
    };

    if (routed?.client?._sock?.setKeepAlive) {
        try { routed.client._sock.setKeepAlive(true, SFTP_DOWNLOAD_KEEPALIVE_INTERVAL); } catch {}
    }

    let settled = false;
    let cleanedUp = false;
    let pumpPaused = false;

    const closeDownloadConnection = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    };

    const finalizeDone = () => {
        if (settled) return;
        settled = true;
        download.loaded = size || download.loaded;
        download.status = 'done';
        download.activeStream = null;
        download.activeFileHandle = null;
        download.activeResponse = null;
        download.activeSftp = null;
        download.activeRouted = null;
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: download.loaded, size, status: 'done' });
        stopKeepalive();
        closeDownloadConnection();
        try { if (fileHandle) sftp.close(fileHandle, () => {}); } catch {}
        if (download.cleanupAfterDownload) cleanupRemoteTempFile(connectionConfig, download.path);
        if (!partial || end >= size - 1) setTimeout(() => sftpDownloadTokens.delete(token), 10000);
    };

    const failDownload = (errMessage) => {
        if (settled) return;
        settled = true;
        download.status = 'error';
        download.activeStream = null;
        download.activeFileHandle = null;
        download.activeResponse = null;
        download.activeSftp = null;
        download.activeRouted = null;
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: Number(download.loaded) || 0, size, status: 'error' });
        stopKeepalive();
        closeDownloadConnection();
        try { if (fileHandle) sftp.close(fileHandle, () => {}); } catch {}
        console.warn('[sftp-download]', 'failed', { path: download.path, range, error: errMessage });
        if (!res.headersSent) res.status(500).send(errMessage || '下载失败');
        else res.destroy();
    };

    // === Fix: Explicit chunked SFTP read (分片读取) using sftp.open() + sftp.read() ===
    // Instead of createReadStream which can silently buffer too much, we read in
    // controlled chunks with keepalive between reads to prevent SSH channel timeout.
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB per SFTP read chunk — larger chunks = higher throughput

    try {
        fileHandle = await new Promise((resolve, reject) => {
            sftp.open(download.path, 'r', (err, handle) => err ? reject(err) : resolve(handle));
        });
    } catch (err) {
        return failDownload(`打开远端文件失败：${err.message}`);
    }

    download.activeStream = fileHandle;
    download.activeFileHandle = fileHandle;
    download.activeResponse = res;
    download.activeSftp = sftp;
    download.activeRouted = routed;
    download.status = 'active';
    download.loaded = start;

    // Start reading in chunks from the requested start position
    let position = start;
    const readEnd = end != null ? end : (size > 0 ? size - 1 : Infinity);
    let sftpKeepaliveSeq = 0;
    let lastProgressSentAt = 0;

    const pumpNext = () => {
        if (settled || res.destroyed) return;

        const remaining = readEnd - position + 1;
        if (remaining <= 0) {
            // Done reading all chunks
            res.end();
            finalizeDone();
            return;
        }

        const thisChunkSize = Math.min(CHUNK_SIZE, remaining);
        const buf = Buffer.alloc(thisChunkSize);

        sftp.read(fileHandle, buf, 0, thisChunkSize, position, (readErr, bytesRead) => {
            if (settled) return;
            if (readErr) return failDownload(`读取远端文件失败：${readErr.message}`);

            if (bytesRead <= 0) {
                // EOF
                res.end();
                finalizeDone();
                return;
            }

            const data = bytesRead < thisChunkSize ? buf.subarray(0, bytesRead) : buf;
            position += bytesRead;
            download.loaded = Math.min(size || Number.MAX_SAFE_INTEGER, position);
            download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;

            // Progress broadcast (throttled)
            const now = Date.now();
            if (now - lastProgressSentAt > 250) {
                lastProgressSentAt = now;
                sendTransferEvent(download.username, {
                    transferId: download.downloadId || token,
                    direction: 'download',
                    path: download.path,
                    loaded: download.loaded,
                    size,
                    status: 'active',
                });
            }

            // Write to HTTP response with backpressure handling
            pumpPaused = false;
            const canContinue = res.write(data);
            if (!canContinue) {
                pumpPaused = true;
                res.once('drain', () => {
                    pumpPaused = false;
                    pumpNext();
                });
            } else {
                pumpNext();
            }
        });
    };

    // Start the chunked read loop
    pumpNext();

    // Keepalive: TCP + SFTP channel layer
    keepaliveTimer = setInterval(() => {
        if (res.destroyed || settled) {
            stopKeepalive();
            return;
        }
        download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
        try { routed?.client?._sock?.setKeepAlive?.(true, SFTP_DOWNLOAD_KEEPALIVE_INTERVAL); } catch {}
        sftpKeepaliveSeq++;
        if (sftpKeepaliveSeq % 2 === 0 && sftp && !settled) {
            try { sftp.realpath('.', () => {}); } catch {}
        }
    }, SFTP_DOWNLOAD_KEEPALIVE_INTERVAL);
    keepaliveTimer.unref?.();

    res.on('finish', () => {
        if (!settled) finalizeDone();
    });

    res.on('close', () => {
        stopKeepalive();
        try { if (fileHandle) sftp.close(fileHandle, () => {}); } catch {}
        if (download.activeStream === fileHandle) download.activeStream = null;
        if (download.activeFileHandle === fileHandle) download.activeFileHandle = null;
        if (download.activeResponse === res) download.activeResponse = null;
        if (download.activeSftp === sftp) download.activeSftp = null;
        if (download.activeRouted === routed) download.activeRouted = null;
        closeDownloadConnection();
        if (!settled) download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
    });
});

app.use('/vendor/viewerjs', express.static(path.join(__dirname, 'node_modules', 'viewerjs', 'dist')));
app.use('/vendor/guacamole-common-js', express.static(path.join(__dirname, 'node_modules', 'guacamole-common-js', 'dist', 'esm')));
app.get('/vendor/@wterm/dom/terminal.css', (req, res) => {
    res.type('text/css').sendFile(path.join(__dirname, 'node_modules', '@wterm', 'dom', 'src', 'terminal.css'));
});
app.use('/vendor/@wterm', express.static(path.join(__dirname, 'node_modules', '@wterm')));
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// 兜底路由
app.get('*', (req, res) => {
    if (req.url.startsWith('/vendor') || req.url.startsWith('/ssh')) {
        return res.status(404).end();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wsServerOptions = {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 10 * 1024 * 1024,
};
const wss = new WebSocketServer(wsServerOptions);
const guacWss = new WebSocketServer(wsServerOptions);
const editorLspWss = new WebSocketServer(wsServerOptions);

server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
        pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
        pathname = req.url || '';
    }

    const targetWss = pathname === '/ssh' ? wss : pathname === '/guacamole' ? guacWss : pathname === '/editor-lsp' ? editorLspWss : null;
    if (!targetWss) {
        console.warn('[WS-DIAG] rejected websocket upgrade for unknown path', { url: req.url || '' });
        try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch {}
        try { socket.destroy(); } catch {}
        return;
    }
    if (targetWss === editorLspWss && !currentSession(req)) {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
        try { socket.destroy(); } catch {}
        return;
    }

    targetWss.handleUpgrade(req, socket, head, (ws) => {
        targetWss.emit('connection', ws, req);
    });
});

editorLspWss.on('connection', handleEditorLspConnection);

guacWss.on('connection', async (ws, req) => {
    const started = Date.now();
    let session = null;
    let closed = false;
    const closeGuac = (reason = 'cleanup') => {
        if (closed) return;
        closed = true;
        console.info('[guacamole-ws]', 'closing session', { reason, uuid: session?.uuid || '-', durationMs: Date.now() - started });
        try { session?.socket?.write(guacInstruction('disconnect')); } catch {}
        try { session?.socket?.end(); } catch {}
        try { session?.socket?.destroy(); } catch {}
        try { session?.routedForward?.close?.(); } catch {}
        try { if (ws.readyState === ws.OPEN) ws.close(); } catch {}
    };

    try {
        const sessionUser = currentSession(req);
        if (!sessionUser) throw new Error('未登录或会话已过期');

        const url = new URL(req.url || '/guacamole', `http://${req.headers.host || 'localhost'}`);
        const connectionId = url.searchParams.get('connectionId') || '';
        const width = Number(url.searchParams.get('width')) || 1280;
        const height = Number(url.searchParams.get('height')) || 720;
        const dpi = Number(url.searchParams.get('dpi')) || 96;
        const store = readJSON(CONNECTIONS_FILE, { connections: [] });
        const conn = (store.connections || []).find((c) => c.id === connectionId);
        if (!conn) throw new Error('连接不存在或已删除');

        const protocol = guacamoleProtocol(conn);

        console.info('[guacamole-ws]', 'opening browser tunnel', { connectionId, name: conn.name, protocol, target: `${conn.host}:${Number(conn.port) || guacamoleDefaultPort(protocol)}`, width, height, dpi, user: sessionUser.username });
        session = await openGuacdSession(conn, { width, height, dpi }, 15000);
        if (ws.readyState === ws.OPEN) {
            ws.send(guacInstruction('ready', session.uuid));
            console.info('[guacamole-ws]', 'browser tunnel ready', { uuid: session.uuid, connectionId });
        }

        session.socket.on('data', (chunk) => {
            if (ws.readyState === ws.OPEN) {
                console.debug('[guacamole-ws]', 'guacd -> browser', { bytes: Buffer.byteLength(String(chunk || ''), 'utf8'), uuid: session.uuid });
                ws.send(String(chunk));
            }
        });
        session.socket.on('error', (err) => {
            console.error('[guacamole-ws]', 'guacd socket error', { uuid: session?.uuid || '-', error: err.message });
            if (ws.readyState === ws.OPEN) ws.close(1011, 'guacd error');
        });
        session.socket.on('close', () => {
            console.info('[guacamole-ws]', 'guacd socket closed', { uuid: session?.uuid || '-' });
            if (ws.readyState === ws.OPEN) ws.close();
        });

        ws.on('message', (raw) => {
            const data = raw.toString('utf8');
            console.debug('[guacamole-ws]', 'browser -> guacd', { bytes: Buffer.byteLength(data, 'utf8'), uuid: session?.uuid || '-' });
            if (session?.socket?.writable) session.socket.write(data);
        });
        ws.on('close', () => closeGuac('browser-close'));
        ws.on('error', (err) => {
            console.error('[guacamole-ws]', 'browser websocket error', { error: err.message });
            closeGuac('browser-error');
        });
    } catch (err) {
        console.warn('[guacamole-ws]', 'failed to open tunnel', { error: err.message });
        try {
            if (ws.readyState === ws.OPEN) ws.close(1011, err.message.slice(0, 120));
        } catch {}
        closeGuac('open-failed');
    }
});

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    let sshClient = null;
    let sshClients = [];
    let sshStream = null;
    let attachedSshSession = null;
    let sftpStream = null;
    let guacdSocket = null;
    let guacdParser = null;
    let guacdSessionUuid = '';
    let statsTimer = null;
    let statsRunning = false;
    let remoteStatsState = {};
    const dockerLogStreams = new Map();
    const sftpUploadStreams = new Map();

    const sendJSON = (obj) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    let handleWsMessage = null;
    const pendingWsMessages = [];
    ws.on('message', (raw) => {
        if (handleWsMessage) {
            handleWsMessage(raw);
            return;
        }
        pendingWsMessages.push(raw);
        console.info('[WS-DIAG] queued early message before handler ready', {
            remoteAddress: req.socket.remoteAddress,
            pending: pendingWsMessages.length,
            bytes: Buffer.byteLength(raw.toString()),
        });
    });

    // 启动实时监控推送
    function startStatsPush() {
        if (!SSH_STATS_ENABLED) {
            console.info('[STATS] realtime stats disabled by SSH_STATS_ENABLED=false');
            return;
        }
        if (statsTimer) return;
        console.info('[STATS] realtime stats started');
        const pushStats = async () => {
            if (ws.readyState !== ws.OPEN || !sshClient || statsRunning) return;
            statsRunning = true;
            const startedAt = Date.now();
            try {
                const result = await getRemoteStats(sshClient, remoteStatsState);
                remoteStatsState = result.state;
                sendJSON({ type: 'stats', data: result.stats });
                console.debug('[STATS] remote stats pushed', { durationMs: Date.now() - startedAt });
            } catch (err) {
                console.error('[STATS] 读取远程统计失败:', {
                    message: err.message,
                    code: err.code || '',
                    level: err.level || '',
                    durationMs: Date.now() - startedAt,
                });
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

    function stopSftpUploadStreams() {
        for (const upload of sftpUploadStreams.values()) {
            try { upload.stream?.end?.(); } catch {}
            try { upload.stream?.destroy?.(); } catch {}
        }
        sftpUploadStreams.clear();
    }

    const detachSshSession = (reason = 'ws-detach') => {
        stopStatsPush();
        stopDockerLogStreams();
        stopSftpUploadStreams();
        if (attachedSshSession) {
            attachedSshSession.attachedWs?.delete(ws);
            attachedSshSession.lastDetachedAt = Date.now();
            console.info('[SSH-SESSION]', 'detach websocket', {
                sessionId: attachedSshSession.id,
                reason,
                remaining: attachedSshSession.attachedWs?.size || 0,
            });
            attachedSshSession = null;
            sshClient = null;
            sshClients = [];
            sshStream = null;
        }
        ws._sshTerminalSession = null;
    };

    const cleanup = ({ destroySsh = true, reason = 'cleanup' } = {}) => {
        stopStatsPush();
        stopDockerLogStreams();
        stopSftpUploadStreams();
        if (guacdSocket) {
            console.info('[guacamole]', 'closing guacd session', { uuid: guacdSessionUuid || '-' });
            try { guacdSocket.write(guacInstruction('disconnect')); } catch {}
            try { guacdSocket.end(); } catch {}
            try { guacdSocket.destroy(); } catch {}
            guacdSocket = null;
            guacdParser = null;
            guacdSessionUuid = '';
        }
        if (sftpStream) {
            const closingSftp = sftpStream;
            try { closingSftp.end(); } catch {}
            sftpStream = null;
            if (attachedSshSession?.sftpStream === closingSftp) attachedSshSession.sftpStream = null;
        }
        if (destroySsh) {
            if (attachedSshSession) {
                destroySshTerminalSession(attachedSshSession, reason);
                attachedSshSession = null;
            } else {
                if (sshStream) {
                    try { sshStream.end(); } catch {}
                    sshStream = null;
                }
                if (sshClient) {
                    sshClients.reverse().forEach((client) => { try { client.end(); } catch {} });
                    if (!sshClients.includes(sshClient)) {
                        try { sshClient.end(); } catch {}
                    }
                    sshClient = null;
                    sshClients = [];
                }
            }
        } else {
            detachSshSession(reason);
        }
    };

    function attachSshSession(session, { replay = true } = {}) {
        if (!session || session.closed) return false;
        cleanup({ destroySsh: false, reason: 'attach-existing-session' });
        attachedSshSession = session;
        sshClient = session.sshClient;
        sshClients = session.sshClients || [session.sshClient].filter(Boolean);
        sshStream = session.sshStream;
        sftpStream = session.sftpStream || null;
        session.attachedWs.add(ws);
        session.lastActive = Date.now();
        ws._sshTerminalSession = session;
        console.info('[SSH-SESSION]', 'attach websocket', {
            sessionId: session.id,
            connectionId: session.connectionId || '',
            attached: session.attachedWs.size,
            replay,
        });
        const pty = session.pty || { cols: 80, rows: 24 };
        sendJSON({ type: 'ready', sessionId: session.id, attached: true, cols: pty.cols, rows: pty.rows });
        if (replay && session.outputBuffer.length) {
            sendJSON({ type: 'data', data: session.outputBuffer.join('') });
        }
        startStatsPush();
        return true;
    }

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

    handleWsMessage = async (raw) => {
        const rawText = raw.toString();
        let msg;
        try {
            msg = JSON.parse(rawText);
        } catch (err) {
            console.warn('[WS-DIAG] received non-json message', {
                remoteAddress: req.socket.remoteAddress,
                bytes: Buffer.byteLength(rawText),
                preview: rawText.slice(0, 80),
                error: err.message,
            });
            return;
        }
        console.info('[WS-DIAG] message received', {
            remoteAddress: req.socket.remoteAddress,
            type: msg.type || '',
            hasConnectionId: !!msg.connectionId,
            connectionId: msg.connectionId || '',
            bytes: Buffer.byteLength(rawText),
        });

        // ------------------------- SSH 连接 -------------------------
        if (msg.type === 'connect') {
            const { host, port, username, password, privateKey, init, connectionId } = msg;
            const requestedSessionId = String(msg.sessionId || msg.terminalSessionId || msg.tabId || connectionId || crypto.randomUUID());
            const existingSession = sshTerminalSessions.get(requestedSessionId);
            if (existingSession && !existingSession.closed) {
                attachSshSession(existingSession, { replay: true });
                return;
            }
            cleanup({ destroySsh: false, reason: 'connect-new-session' });
            let conn;
            try {
                console.info('[SSH-DIAG] connect request received', {
                    remoteAddress: req.socket.remoteAddress,
                    hasConnectionId: !!connectionId,
                    connectionId: connectionId || '',
                    fallbackTarget: connectionId ? '' : `${host || ''}:${port || 22}`,
                    hasFallbackPassword: !!password && password !== '******',
                    hasFallbackPrivateKey: !!privateKey && privateKey !== '******',
                });
                let connectionSource = 'fallback-message';
                let storeConnectionCount = null;
                if (connectionId) {
                    const session = currentSession(req);
                    if (!session) throw new Error('未登录或会话已过期');
                    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
                    storeConnectionCount = (store.connections || []).length;
                    conn = (store.connections || []).find((c) => c.id === connectionId);
                    if (!conn) throw new Error('连接不存在或已删除');
                    connectionSource = 'sqlite-by-connectionId';
                } else {
                    conn = { host, port: port || 22, username, password: password || '', privateKey: privateKey || '', connectionMode: 'direct' };
                }
                if (!conn.host || !conn.username) throw new Error('主机和用户名不能为空');
                console.info('[SSH-DIAG] resolved connection config', {
                    connectionId: conn.id || connectionId || '',
                    requestedConnectionId: connectionId || '',
                    source: connectionSource,
                    dataDir: DATA_DIR,
                    dbFile: DB_FILE,
                    storeConnectionCount,
                    name: conn.name || '',
                    target: `${conn.host}:${Number(conn.port) || 22}`,
                    host: conn.host || '',
                    port: Number(conn.port) || 22,
                    username: conn.username || '',
                    protocol: conn.protocol || 'SSH',
                    mode: conn.connectionMode || 'direct',
                    proxyId: conn.proxyId || '',
                    jumpHostIds: normalizeJumpHostIds(conn),
                    sshKeyId: conn.sshKeyId || '',
                    hasPassword: !!conn.password,
                    hasPrivateKey: !!conn.privateKey,
                });
                if (connectionId) console.log(`[SSH] 使用已保存路由连接 ${conn.name || conn.host}`);
                const routed = await createRoutedSSHConnection(conn, 10000);
                sshClient = routed.client;
                sshClients = routed.clients || [routed.client];
                console.log(`[SSH] 已连接: ${routed.route}`);
                console.info('[SSH-DIAG] ssh ready before shell', {
                    connectionId: conn.id || connectionId || '',
                    route: routed.route,
                    clientCount: sshClients.length,
                });
            } catch (err) {
                console.warn('[SSH-DIAG] ssh connection failed before shell', {
                    connectionId: connectionId || '',
                    error: err.message,
                    stack: err.stack,
                });
                sendJSON({ type: 'error', message: `SSH 连接失败: ${err.message}` });
                cleanup();
                return;
            }

            sshClient.on('error', (err) => {
                console.error(`[SSH] 错误: ${err.message}`);
                if (attachedSshSession) {
                    broadcastSshSession(attachedSshSession, { type: 'error', message: `SSH 连接失败: ${err.message}` });
                    destroySshTerminalSession(attachedSshSession, 'ssh-error');
                } else {
                    sendJSON({ type: 'error', message: `SSH 连接失败: ${err.message}` });
                    cleanup();
                }
            });

            sshClient.on('close', () => {
                console.log('[SSH] 连接关闭');
                if (attachedSshSession) {
                    broadcastSshSession(attachedSshSession, { type: 'close', message: 'SSH 连接已关闭' });
                    destroySshTerminalSession(attachedSshSession, 'ssh-close');
                } else {
                    sendJSON({ type: 'close', message: 'SSH 连接已关闭' });
                    cleanup();
                }
            });

            // 打开 shell
            const initialRows = Number.isFinite(Number(msg.rows)) ? Math.min(200, Math.max(2, Math.floor(Number(msg.rows)))) : 24;
            const initialCols = Number.isFinite(Number(msg.cols)) ? Math.min(500, Math.max(20, Math.floor(Number(msg.cols)))) : 80;
            sshClient.shell({ term: 'xterm-256color', rows: initialRows, cols: initialCols }, (err, stream) => {
                if (err) {
                    console.warn('[SSH-DIAG] shell open failed after ssh ready', {
                        connectionId: conn.id || connectionId || '',
                        target: `${conn.host}:${Number(conn.port) || 22}`,
                        username: conn.username || '',
                        error: err.message,
                        stack: err.stack,
                    });
                    sendJSON({ type: 'error', message: `打开 Shell 失败: ${err.message}` });
                    cleanup();
                    return;
                }
                console.info('[SSH-DIAG] shell opened successfully', {
                    connectionId: conn.id || connectionId || '',
                    target: `${conn.host}:${Number(conn.port) || 22}`,
                    username: conn.username || '',
                });
                sshStream = stream;
                const session = {
                    id: requestedSessionId,
                    connectionId: conn.id || connectionId || '',
                    sshClient,
                    sshClients,
                    sshStream,
                    attachedWs: new Set([ws]),
                    pty: { rows: initialRows, cols: initialCols },
                    outputBuffer: [],
                    createdAt: Date.now(),
                    lastActive: Date.now(),
                    lastDetachedAt: 0,
                    username: currentSession(req)?.username || '',
                    connectionConfig: conn,
                    closed: false,
                };
                attachedSshSession = session;
                ws._sshTerminalSession = session;
                sshTerminalSessions.set(session.id, session);
                const pty = session.pty || { rows: initialRows, cols: initialCols };
                sendJSON({ type: 'ready', sessionId: session.id, cols: pty.cols, rows: pty.rows });

                // SSH 连接就绪后，启动实时监控推送
                startStatsPush();

                stream.on('data', (data) => {
                    const text = data.toString('utf-8');
                    appendSshSessionBuffer(session, text);
                    broadcastSshSession(session, { type: 'data', data: text });
                });
                stream.on('close', (code, signal) => {
                    console.log(`[SSH] Shell 关闭 code=${code} signal=${signal}`);
                    broadcastSshSession(session, { type: 'close', message: `Shell 已关闭 (code=${code})` });
                    destroySshTerminalSession(session, `shell-close-${code ?? 'N/A'}`);
                });
                stream.stderr.on('data', (data) => {
                    const text = data.toString('utf-8');
                    appendSshSessionBuffer(session, text);
                    broadcastSshSession(session, { type: 'data', data: text });
                });

                if (init && typeof init === 'string' && init.trim().length > 0) {
                    stream.write(init + '\n');
                }
            });
            return;
        }

        // 输入
        if (msg.type === 'input') {
            if (sshStream && sshStream.writable) sshStream.write(msg.data);
            return;
        }

        // 窗口大小调整
        if (msg.type === 'resize') {
            const rows = Math.floor(Number(msg.rows));
            const cols = Math.floor(Number(msg.cols));
            if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 2 || cols < 20 || rows > 200 || cols > 500) {
                console.warn('[SSH] 忽略异常 PTY resize', { rows: msg.rows, cols: msg.cols });
                return;
            }
            if (sshStream && sshStream.setWindow) {
                sshStream.setWindow(rows, cols, 0, 0);
                if (attachedSshSession) {
                    attachedSshSession.pty = { rows, cols };
                    attachedSshSession.lastActive = Date.now();
                }
            }
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
            if (attachedSshSession) destroySshTerminalSession(attachedSshSession, 'client-disconnect');
            else cleanup({ destroySsh: true, reason: 'client-disconnect' });
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
                if (attachedSshSession) attachedSshSession.sftpStream = sftp;
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

        // 删除（文件或目录；目录支持递归删除非空内容）
        if (msg.type === 'sftp-delete') {
            const targetPath = String(msg.path || '');
            if (!targetPath || targetPath === '/') {
                console.warn('[sftp-delete]', '拒绝删除危险路径', { path: targetPath });
                sendJSON({ type: 'sftp-delete', path: msg.path, success: false, error: '拒绝删除空路径或根目录' });
                return;
            }

            sftpStream.stat(targetPath, async (err, stats) => {
                if (err) {
                    console.warn('[sftp-delete]', 'stat failed', { path: targetPath, error: err.message });
                    sendJSON({ type: 'sftp-delete', path: targetPath, success: false, error: err.message });
                    return;
                }
                if (stats.isDirectory()) {
                    try {
                        console.info('[sftp-delete]', 'recursive directory delete requested', { path: targetPath });
                        await execRemoteCommand(sshClient, `rm -rf -- ${shellQuote(targetPath)}`);
                        sendJSON({ type: 'sftp-delete', path: targetPath, success: true, error: null });
                    } catch (err2) {
                        console.warn('[sftp-delete]', 'recursive directory delete failed', { path: targetPath, error: err2.message });
                        sendJSON({ type: 'sftp-delete', path: targetPath, success: false, error: err2.message });
                    }
                } else {
                    sftpStream.unlink(targetPath, (err2) => {
                        if (err2) console.warn('[sftp-delete]', 'file delete failed', { path: targetPath, error: err2.message });
                        else console.info('[sftp-delete]', 'file deleted', { path: targetPath });
                        sendJSON({ type: 'sftp-delete', path: targetPath, success: !err2, error: err2 ? err2.message : null });
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

        // 修改权限
        if (msg.type === 'sftp-chmod') {
            const targetPath = String(msg.path || '');
            const modeText = String(msg.mode || '').trim();
            if (!targetPath || !/^[0-7]{3,4}$/.test(modeText)) {
                sendJSON({ type: 'sftp-chmod', path: targetPath, success: false, error: '权限格式不正确' });
                return;
            }
            sftpStream.chmod(targetPath, parseInt(modeText, 8), (err) => {
                sendJSON({ type: 'sftp-chmod', path: targetPath, mode: modeText, success: !err, error: err ? err.message : null });
            });
            return;
        }

        // 下载文件：签发一次性 HTTP 下载地址，由浏览器通过响应流直接落盘，避免在 WebSocket/JS 内存中拼接大文件。
        if (msg.type === 'sftp-download') {
            const targetPath = String(msg.path || '');
            if (!targetPath) {
                sendJSON({ type: 'sftp-download', path: targetPath, error: '缺少下载路径' });
                return;
            }
            sftpStream.stat(targetPath, (err, stats) => {
                if (err) {
                    sendJSON({ type: 'sftp-download', path: targetPath, error: err.message });
                    return;
                }
                if (stats.isDirectory?.()) {
                    sendJSON({ type: 'sftp-download', path: targetPath, error: '暂不支持直接下载目录' });
                    return;
                }
                const token = crypto.randomBytes(24).toString('hex');
                sftpDownloadTokens.set(token, {
                    sessionId: attachedSshSession?.id || '',
                    username: currentSession(req)?.username || '',
                    connectionConfig: attachedSshSession?.connectionConfig || conn,
                    downloadId: msg.downloadId || '',
                    path: targetPath,
                    size: Number(stats.size) || 0,
                    loaded: 0,
                    status: 'pending',
                    expiresAt: Date.now() + SFTP_DOWNLOAD_TOKEN_TTL,
                });
                sendJSON({ type: 'sftp-download-ready', downloadId: msg.downloadId || '', path: targetPath, url: `/api/sftp/download/${token}`, progressUrl: `/api/sftp/download-progress/${token}`, controlUrl: `/api/sftp/download-control/${token}`, size: Number(stats.size) || 0 });
            });
            return;
        }


        if (msg.type === 'sftp-clipboard-set') {
            const username = currentSession(req)?.username || '';
            const rawItems = Array.isArray(msg.items) ? msg.items : [];
            const items = rawItems.map((item) => ({
                path: normalizeRemotePath(item.path || ''),
                name: String(item.name || basenameRemote(item.path || '')).slice(0, 255),
                type: item.type === 'd' ? 'd' : '-',
                size: Number(item.size) || 0,
                modifyTime: Number(item.modifyTime) || 0,
            })).filter((item) => item.path && item.path !== '/');
            if (sftpStream && items.length) {
                try {
                    await Promise.all(items.map((item) => sftpStat(sftpStream, item.path)));
                } catch (err) {
                    sendJSON({ type: 'sftp-clipboard-set', success: false, error: `复制失败：源路径无效或不存在（${err.message}）` });
                    return;
                }
            }
            if (!username || !items.length) {
                sendJSON({ type: 'sftp-clipboard-set', success: false, error: '没有可复制的项目' });
                return;
            }
            const mode = msg.mode === 'cut' ? 'cut' : 'copy';
            sftpClipboardByUser.set(username, {
                mode,
                username,
                sourceSessionId: attachedSshSession?.id || '',
                sourceConnectionId: attachedSshSession?.connectionId || '',
                sourceConnectionConfig: attachedSshSession?.connectionConfig || conn,
                items,
                createdAt: Date.now(),
            });
            sendJSON({ type: 'sftp-clipboard-set', success: true, mode, count: items.length });
            return;
        }

        if (msg.type === 'sftp-clipboard-paste') {
            const username = currentSession(req)?.username || '';
            const targetDir = String(msg.targetDir || msg.path || '.');
            const clip = sftpClipboardByUser.get(username);
            if (!clip) {
                sendJSON({ type: 'sftp-clipboard-paste', success: false, error: '剪贴板为空' });
                return;
            }
            pasteSftpClipboard({
                username,
                targetSession: attachedSshSession,
                targetDir,
                mode: clip.mode,
                conflict: msg.conflict || 'rename',
                sendProgress: (payload) => sendTransferEvent(username, payload),
            }).then(() => {
                sendJSON({ type: 'sftp-clipboard-paste', success: true, path: targetDir });
            }).catch((err) => {
                console.warn('[sftp-clipboard-paste]', 'failed', { targetDir, error: err.message });
                sendJSON({ type: 'sftp-clipboard-paste', success: false, error: err.message });
            });
            return;
        }

        if (msg.type === 'sftp-compress') {
            const items = Array.isArray(msg.items) ? msg.items.map((item) => normalizeRemotePath(item.path)).filter((p) => p && p !== '/') : [];
            const targetPath = normalizeRemotePath(msg.targetPath || '');
            if (!items.length || !targetPath) {
                sendJSON({ type: 'sftp-compress', success: false, error: '缺少压缩项目或目标路径' });
                return;
            }
            const parent = dirnameRemote(items[0]);
            const names = items.map((p) => basenameRemote(p));
            const cmd = `mkdir -p -- ${shellQuote(dirnameRemote(targetPath))} && tar -czf ${shellQuote(targetPath)} -C ${shellQuote(parent)} -- ${names.map(shellQuote).join(' ')}`;
            execRemoteCommand(sshClient, cmd).then(() => {
                sendJSON({ type: 'sftp-compress', success: true, path: targetPath });
            }).catch((err) => sendJSON({ type: 'sftp-compress', success: false, error: err.message }));
            return;
        }

        if (msg.type === 'sftp-extract') {
            const archivePath = normalizeRemotePath(msg.path || '');
            const targetDir = normalizeRemotePath(msg.targetDir || dirnameRemote(archivePath));
            if (!archivePath || !targetDir) {
                sendJSON({ type: 'sftp-extract', success: false, error: '缺少压缩包或解压路径' });
                return;
            }
            const lower = archivePath.toLowerCase();
            let cmd = `mkdir -p -- ${shellQuote(targetDir)} && `;
            if (lower.endsWith('.zip')) cmd += `unzip -o -- ${shellQuote(archivePath)} -d ${shellQuote(targetDir)}`;
            else if (/\.(tar\.gz|tgz)$/.test(lower)) cmd += `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
            else if (/\.(tar\.bz2|tbz2)$/.test(lower)) cmd += `tar -xjf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
            else if (/\.(tar\.xz|txz)$/.test(lower)) cmd += `tar -xJf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
            else if (lower.endsWith('.tar')) cmd += `tar -xf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
            else if (lower.endsWith('.7z')) cmd += `(command -v 7z >/dev/null && 7z x -y -o${shellQuote(targetDir)} ${shellQuote(archivePath)} || command -v 7za >/dev/null && 7za x -y -o${shellQuote(targetDir)} ${shellQuote(archivePath)})`;
            else if (lower.endsWith('.rar')) cmd += `unrar x -o+ ${shellQuote(archivePath)} ${shellQuote(targetDir + '/')}`;
            else { sendJSON({ type: 'sftp-extract', success: false, error: '暂不支持该压缩格式' }); return; }
            execRemoteCommand(sshClient, cmd).then(() => {
                sendJSON({ type: 'sftp-extract', success: true, path: archivePath, targetDir });
            }).catch((err) => sendJSON({ type: 'sftp-extract', success: false, error: err.message }));
            return;
        }

        if (msg.type === 'sftp-download-bundle') {
            const items = Array.isArray(msg.items) ? msg.items.map((item) => normalizeRemotePath(item.path)).filter((p) => p && p !== '/') : [];
            if (!items.length) {
                sendJSON({ type: 'sftp-download', downloadId: msg.downloadId || '', error: '没有可下载的项目' });
                return;
            }
            const tmpName = `zephyr-sftp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tar.gz`;
            const tmpPath = `/tmp/${tmpName}`;
            const parent = dirnameRemote(items[0]);
            const names = items.map((p) => basenameRemote(p));
            const cmd = `tar -czf ${shellQuote(tmpPath)} -C ${shellQuote(parent)} -- ${names.map(shellQuote).join(' ')}`;
            execRemoteCommand(sshClient, cmd).then(() => {
                sftpStream.stat(tmpPath, (err, stats) => {
                    if (err) {
                        sendJSON({ type: 'sftp-download', downloadId: msg.downloadId || '', error: err.message });
                        return;
                    }
                    const token = crypto.randomBytes(24).toString('hex');
                    sftpDownloadTokens.set(token, {
                        sessionId: attachedSshSession?.id || '',
                        username: currentSession(req)?.username || '',
                        connectionConfig: attachedSshSession?.connectionConfig || conn,
                        downloadId: msg.downloadId || '',
                        path: tmpPath,
                        displayName: msg.name || tmpName,
                        size: Number(stats.size) || 0,
                        loaded: 0,
                        status: 'pending',
                        cleanupAfterDownload: true,
                        expiresAt: Date.now() + SFTP_DOWNLOAD_TOKEN_TTL,
                    });
                    sendJSON({ type: 'sftp-download-ready', downloadId: msg.downloadId || '', path: tmpPath, name: msg.name || tmpName, url: `/api/sftp/download/${token}`, progressUrl: `/api/sftp/download-progress/${token}`, controlUrl: `/api/sftp/download-control/${token}`, size: Number(stats.size) || 0 });
                });
            }).catch((err) => sendJSON({ type: 'sftp-download', downloadId: msg.downloadId || '', error: err.message }));
            return;
        }

        // 上传文件：兼容旧版整包上传；新版使用分片，避免大文件撑爆 WebSocket/内存导致 SSH 断开。
        if (msg.type === 'sftp-upload') {
            const buffer = Buffer.from(msg.data || '', 'base64');
            const writeStream = sftpStream.createWriteStream(msg.path);
            let settled = false;
            writeStream.on('error', (err) => {
                if (settled) return;
                settled = true;
                sendJSON({ type: 'sftp-upload', path: msg.path, success: false, error: err.message });
            });
            writeStream.end(buffer, () => {
                if (settled) return;
                settled = true;
                sendJSON({ type: 'sftp-upload', path: msg.path, success: true });
            });
            return;
        }

        if (msg.type === 'sftp-upload-start') {
            const uploadId = String(msg.uploadId || '');
            const targetPath = String(msg.path || '');
            if (!uploadId) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: targetPath, error: '缺少上传 ID' });
                return;
            }
            if (!targetPath) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: targetPath, error: '缺少上传路径' });
                return;
            }
            const token = crypto.randomBytes(24).toString('hex');
            sftpUploadTokens.set(token, {
                sessionId: attachedSshSession?.id || '',
                username: currentSession(req)?.username || '',
                connectionConfig: attachedSshSession?.connectionConfig || conn,
                uploadId,
                path: targetPath,
                size: Number(msg.size) || 0,
                loaded: 0,
                status: 'pending',
                expiresAt: Date.now() + SFTP_UPLOAD_TOKEN_TTL,
            });
            sendJSON({ type: 'sftp-upload-ready', uploadId, path: targetPath, url: `/api/sftp/upload/${token}`, size: Number(msg.size) || 0 });
            return;
        }

        if (msg.type === 'sftp-upload-chunk') {
            const uploadId = String(msg.uploadId || '');
            const upload = sftpUploadStreams.get(uploadId);
            if (!upload || upload.failed) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: msg.path, error: '上传会话不存在' });
                return;
            }
            const offset = Number(msg.offset) || 0;
            if (offset !== upload.offset) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: upload.path, error: `上传偏移错误：期望 ${upload.offset}，收到 ${offset}` });
                return;
            }
            const buffer = Buffer.from(msg.data || '', 'base64');
            upload.offset += buffer.length;
            const next = () => sendJSON({ type: 'sftp-upload-progress', uploadId, path: upload.path, nextOffset: upload.offset, size: upload.size });
            if (!upload.stream.write(buffer)) upload.stream.once('drain', next);
            else next();
            return;
        }

        if (msg.type === 'sftp-upload-cancel') {
            const uploadId = String(msg.uploadId || '');
            for (const [token, uploadTask] of sftpUploadTokens.entries()) {
                if (uploadTask.uploadId !== uploadId) continue;
                uploadTask.status = 'error';
                try { uploadTask.activeStream?.destroy?.(); } catch {}
                sftpUploadTokens.delete(token);
                sendTransferEvent(uploadTask.username, { transferId: uploadId || token, direction: 'upload', path: uploadTask.path, loaded: Number(uploadTask.loaded) || 0, size: Number(uploadTask.size) || 0, status: 'error' });
            }
            const upload = sftpUploadStreams.get(uploadId);
            if (upload) {
                upload.failed = true;
                try { upload.stream?.destroy?.(); } catch {}
                sftpUploadStreams.delete(uploadId);
            }
            sendJSON({ type: 'sftp-upload-error', uploadId, error: '已取消上传' });
            return;
        }

        if (msg.type === 'sftp-upload-complete') {
            const uploadId = String(msg.uploadId || '');
            const upload = sftpUploadStreams.get(uploadId);
            if (!upload || upload.failed) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: msg.path, error: '上传会话不存在' });
                return;
            }
            upload.ending = true;
            upload.stream.end();
            return;
        }

        // 编辑文件：读取内容
        if (msg.type === 'sftp-preview') {
            const targetPath = String(msg.path || '').trim();
            const ext = path.extname(targetPath).slice(1).toLowerCase();
            if (!targetPath) {
                sendJSON({ type: 'sftp-preview', path: targetPath, error: '缺少预览路径' });
                return;
            }
            if (!PREVIEW_IMAGE_EXTENSIONS.has(ext)) {
                sendJSON({ type: 'sftp-preview', path: targetPath, error: '当前文件不是已知图片格式' });
                return;
            }
            sftpStream.stat(targetPath, (err, stats) => {
                if (err) {
                    sendJSON({ type: 'sftp-preview', path: targetPath, error: err.message });
                    return;
                }
                if (stats.isDirectory?.()) {
                    sendJSON({ type: 'sftp-preview', path: targetPath, error: '目录不支持图片预览' });
                    return;
                }
                const token = crypto.randomBytes(24).toString('hex');
                sftpPreviewTokens.set(token, {
                    path: targetPath,
                    username: currentSession(req)?.username || '',
                    sessionId: attachedSshSession?.id || '',
                    connectionConfig: attachedSshSession?.connectionConfig || conn,
                    size: Number(stats.size) || 0,
                    mtime: Number(stats.mtime) || Number(stats.modifyTime) || 0,
                    expiresAt: Date.now() + PREVIEW_TOKEN_TTL,
                });
                sendJSON({
                    type: 'sftp-preview-ready',
                    path: targetPath,
                    url: `/api/sftp/preview/${token}`,
                    contentType: isBrowserImageExt(ext, BROWSER_IMAGE_EXTENSIONS) ? getBrowserImageContentType(ext, BROWSER_IMAGE_CONTENT_TYPES) : 'image/webp',
                    converted: !isBrowserImageExt(ext, BROWSER_IMAGE_EXTENSIONS),
                    size: Number(stats.size) || 0,
                });
            });
            return;
        }

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
    };

    if (pendingWsMessages.length) {
        console.info('[WS-DIAG] replay queued early messages', {
            remoteAddress: req.socket.remoteAddress,
            count: pendingWsMessages.length,
        });
        const queued = pendingWsMessages.splice(0);
        queued.forEach((raw) => handleWsMessage(raw));
    }

    ws.on('close', () => {
        console.log('[WS] 客户端断开');
        cleanup({ destroySsh: false, reason: 'ws-close' });
    });

    ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
        cleanup({ destroySsh: false, reason: 'ws-error' });
    });
});

async function startServer() {
    await ensureEmbeddedGuacd();
    server.listen(PORT, () => {
        let dataDirEntries = [];
        try { dataDirEntries = fs.readdirSync(DATA_DIR).sort(); } catch {}
        console.info('[DATA-DIAG] runtime data directory', {
            dataDir: DATA_DIR,
            dbFile: DB_FILE,
            dbExists: fs.existsSync(DB_FILE),
            envFileExists: fs.existsSync(path.join(DATA_DIR, '.env')),
            entries: dataDirEntries,
            dockerHint: 'Docker 部署请确认宿主机数据卷已挂载到 /app/data，否则连接数据会随容器重建而丢失。',
        });
        console.log(`🌬️  Zephyr 服务运行在 http://localhost:${PORT}`);
        console.log(`   WebSocket 路径: /ssh`);
        console.log(`   Guacamole/VNC 路径: /guacamole -> guacd ${GUACD_HOST}:${GUACD_PORT}`);
    });
}

startServer().catch((err) => {
    console.error('[startup] Zephyr 启动失败:', err);
    process.exit(1);
});