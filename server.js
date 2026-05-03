const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

const PORT = process.env.PORT || 3000;
const app = express();

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const sessions = new Map();
const tempTotpTokens = new Map();
const webauthnChallenges = new Map();
const resetRequestHits = new Map();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

function buildSSHConfig(conn, timeout = 10000) {
    const cfg = { host: conn.host, port: Number(conn.port) || 22, username: conn.username, readyTimeout: timeout, keepaliveInterval: 10000 };
    if (conn.privateKey && conn.privateKey.includes('-----BEGIN')) {
        cfg.privateKey = conn.privateKey;
        if (conn.password) cfg.passphrase = conn.password;
    } else if (conn.password) cfg.password = conn.password;
    else throw new Error('缺少认证凭据');
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
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            client.off('ready', onReady);
            client.off('error', onError);
            if (err) {
                try { client.end(); } catch {}
                reject(err);
            } else resolve(client);
        };
        const onReady = () => finish();
        const onError = (err) => finish(err);
        client.once('ready', onReady);
        client.once('error', onError);
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
    if (body.beian) {
        next.beian = { ...(current.beian || {}), ...body.beian };
        next.icp = next.beian.icp || '';
        next.policeBeian = next.beian.policeBeian || '';
        next.policeBeianUrl = next.beian.policeBeianUrl || '';
        next.showBeian = next.beian.show !== false;
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

async function regionOf(ip) { return ip && ip !== 'unknown' ? '未查询' : ''; }
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
    if (!body.name || !body.host || !body.username) return res.status(400).json({ error: '名称、主机、用户名不能为空' });
    const conn = {
        id: crypto.randomUUID(),
        name: String(body.name).trim(),
        host: String(body.host).trim(),
        port: Number(body.port) || 22,
        protocol: String(body.protocol || 'SSH').toUpperCase(),
        username: String(body.username).trim(),
        password: String(body.password || ''),
        privateKey: String(body.privateKey || ''),
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
    conn.jumpHostIds = normalizeJumpHostIds(conn);
    conn.lastConnectedAt = Date.now();
    store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `打开连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ connection: conn });
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
    const mail = storage.getSettings().mail || {};
    console.info('[MAIL] 读取已保存 SMTP 密码:', publicMailDebug(mail));
    res.json({ pass: mail.pass || '', hasPass: !!mail.pass });
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
    res.json({
        defaultUsername: user?.username || 'admin',
        icp: s.icp || s.beian?.icp || '',
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
        if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
        if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
        applyConnectionRouteFields(conn, body);
    } else {
        conn = { ...body, port: Number(body.port) || 22 };
        applyConnectionRouteFields(conn, body);
    }
    if (!conn.host || !conn.username) return res.status(400).json({ error: '主机和用户名不能为空' });
    const result = await testSSHConnection(conn, Math.max(1000, Math.min(Number(body.timeoutSeconds || 10) * 1000, 30000)));
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
app.delete('/api/proxies/:id', requireAuth, (req, res) => { storage.deleteProxy(req.params.id); addActivity('删除代理'); res.json({ ok: true }); });

app.get('/api/jump-hosts', requireAuth, (req, res) => res.json({ jumpHosts: storage.listJumpHosts() }));
app.post('/api/jump-hosts', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.connectionId) return res.status(400).json({ error: '名称和 SSH 连接不能为空' });
    const jumpHost = storage.saveJumpHost({ id: crypto.randomUUID(), name: String(b.name), connectionId: String(b.connectionId), createdAt: Date.now(), updatedAt: Date.now() });
    addActivity(`新增跳板机：${jumpHost.name}`);
    res.json({ jumpHost });
});
app.put('/api/jump-hosts/:id', requireAuth, (req, res) => {
    const old = storage.listJumpHosts().find((j) => j.id === req.params.id);
    if (!old) return res.status(404).json({ error: '跳板机不存在' });
    const b = req.body || {};
    const jumpHost = storage.saveJumpHost({ ...old, name: String(b.name ?? old.name), connectionId: String(b.connectionId ?? old.connectionId), updatedAt: Date.now() });
    addActivity(`编辑跳板机：${jumpHost.name}`);
    res.json({ jumpHost });
});
app.delete('/api/jump-hosts/:id', requireAuth, (req, res) => { storage.deleteJumpHost(req.params.id); addActivity('删除跳板机'); res.json({ ok: true }); });

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
const wss = new WebSocketServer({ server, path: '/ssh' });

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    let sshClient = null;
    let sshClients = [];
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
            sshClients.reverse().forEach((client) => { try { client.end(); } catch {} });
            if (!sshClients.includes(sshClient)) {
                try { sshClient.end(); } catch {}
            }
            sshClient = null;
            sshClients = [];
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
            const { host, port, username, password, privateKey, init, connectionId } = msg;
            cleanup();
            let conn;
            try {
                if (connectionId) {
                    const session = currentSession(req);
                    if (!session) throw new Error('未登录或会话已过期');
                    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
                    conn = (store.connections || []).find((c) => c.id === connectionId);
                    if (!conn) throw new Error('连接不存在或已删除');
                } else {
                    conn = { host, port: port || 22, username, password: password || '', privateKey: privateKey || '', connectionMode: 'direct' };
                }
                if (!conn.host || !conn.username) throw new Error('主机和用户名不能为空');
                if (connectionId) console.log(`[SSH] 使用已保存路由连接 ${conn.name || conn.host}`);
                const routed = await createRoutedSSHConnection(conn, 10000);
                sshClient = routed.client;
                sshClients = routed.clients || [routed.client];
                console.log(`[SSH] 已连接: ${routed.route}`);
            } catch (err) {
                sendJSON({ type: 'error', message: `SSH 连接失败: ${err.message}` });
                cleanup();
                return;
            }

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

server.listen(PORT, () => {
    console.log(`🌬️  Zephyr 服务运行在 http://localhost:${PORT}`);
    console.log(`   WebSocket 路径: /ssh`);
});