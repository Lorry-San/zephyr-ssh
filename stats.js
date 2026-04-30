const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

// ================= 配置项 =================
const PUBLIC_IPV4_URL = 'https://api.ipify.org?format=json';
const PUBLIC_IPV6_URL = 'https://api64.ipify.org?format=json';
const PUBLIC_IP_CACHE_TTL_MS = 60 * 1000;
// ==========================================

let lastCPU = null;
let lastNet = null;
let lastDisk = null;
let lastTime = Date.now();
let cachedIP = { ...getLocalIPs(), updatedAt: 0 };

function readCPUStat() {
    try {
        const stat = fs.readFileSync('/proc/stat', 'utf8')
            .split('\n')[0]
            .split(/\s+/)
            .slice(1)
            .map(Number);
        const idle = stat[3];
        const total = stat.reduce((a, b) => a + b, 0);
        if (!lastCPU) {
            lastCPU = { idle, total };
            return 0;
        }
        const idleDiff = idle - lastCPU.idle;
        const totalDiff = total - lastCPU.total;
        lastCPU = { idle, total };
        return totalDiff === 0 ? 0 : ((1 - idleDiff / totalDiff) * 100);
    } catch (e) {
        return 0;
    }
}

function readCPUInfo() {
    let model = 'N/A', freq = 'N/A';
    try {
        const data = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const lines = data.split('\n');
        for (const line of lines) {
            if (line.startsWith('model name') && model === 'N/A') {
                model = line.split(':')[1].trim();
            }
            if (line.startsWith('cpu MHz') && freq === 'N/A') {
                freq = Math.round(parseFloat(line.split(':')[1])) + ' MHz';
            }
        }
    } catch (e) {}
    // 核心数改用 Node.js os 模块获取，确保准确
    const cores = os.cpus().length;
    return { model, freq, cores };
}

function readMem() {
    try {
        const data = fs.readFileSync('/proc/meminfo', 'utf8');
        let mt = 0, ma = 0, st = 0, sf = 0;
        const lines = data.split('\n');
        for (const line of lines) {
            if (line.startsWith('MemTotal')) mt = parseInt(line.split(/\s+/)[1]);
            if (line.startsWith('MemAvailable')) ma = parseInt(line.split(/\s+/)[1]);
            if (line.startsWith('SwapTotal')) st = parseInt(line.split(/\s+/)[1]);
            if (line.startsWith('SwapFree')) sf = parseInt(line.split(/\s+/)[1]);
        }
        return {
            memUsed: (mt - ma) / 1024,
            memTotal: mt / 1024,
            swapUsed: (st - sf) / 1024,
            swapTotal: st / 1024
        };
    } catch (e) {
        return { memUsed: 0, memTotal: 0, swapUsed: 0, swapTotal: 0 };
    }
}

function parseDiskDevices() {
    try {
        const output = execSync('df -kP -x tmpfs -x devtmpfs -x squashfs -x overlay', { encoding: 'utf8', timeout: 2000 });
        const lines = output.trim().split('\n');
        lines.shift();
        return lines.map((line, index) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6) return null;
            const [filesystem, blocks, used, available, usePercent, mountpoint] = parts;
            const totalGB = Number(blocks) / 1024 / 1024;
            const usedGB = Number(used) / 1024 / 1024;
            const percent = parseInt(usePercent.replace('%', ''), 10) || 0;
            return {
                id: `disk-${index}`,
                filesystem,
                mountpoint,
                usedGB: Number(usedGB.toFixed(1)),
                totalGB: Number(totalGB.toFixed(1)),
                percent,
                usageLabel: `${percent}%`
            };
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

function readDisk() {
    try {
        const devices = parseDiskDevices();
        const total = devices.reduce((sum, device) => sum + device.totalGB, 0);
        const used = devices.reduce((sum, device) => sum + device.usedGB, 0);

        let readKBps = 0, writeKBps = 0;
        try {
            const data = fs.readFileSync('/proc/diskstats', 'utf8');
            const lines = data.split('\n');
            let rs = 0, ws = 0;
            for (const line of lines) {
                const p = line.trim().split(/\s+/);
                if (p.length > 13 && (p[2].startsWith('sd') || p[2].startsWith('vd') || p[2].startsWith('nvme'))) {
                    rs += Number(p[5]) || 0;
                    ws += Number(p[9]) || 0;
                }
            }
            const now = Date.now();
            if (!lastDisk) {
                lastDisk = { rs, ws, time: now };
            } else {
                const dt = (now - lastDisk.time) / 1000;
                if (dt > 0) {
                    readKBps = ((rs - lastDisk.rs) * 512) / 1024 / dt;
                    writeKBps = ((ws - lastDisk.ws) * 512) / 1024 / dt;
                }
                lastDisk = { rs, ws, time: now };
            }
        } catch (_) {}
        return { used, total, readKBps, writeKBps, devices };
    } catch (e) {
        return { used: 0, total: 0, readKBps: 0, writeKBps: 0, devices: [] };
    }
}

function readNet() {
    try {
        const now = Date.now();
        const data = fs.readFileSync('/proc/net/dev', 'utf8');
        let rx = 0, tx = 0;
        const lines = data.split('\n');
        for (const line of lines) {
            const cleaned = line.replace(':', ' ');
            const parts = cleaned.trim().split(/\s+/);
            if (parts.length < 17) continue;
            const iface = parts[0];
            if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) continue;
            const rxBytes = Number(parts[1]) || 0;
            const txBytes = Number(parts[9]) || 0;
            rx += rxBytes;
            tx += txBytes;
        }
        if (!lastNet) {
            lastNet = { rx, tx };
            lastTime = now;
            return { rx: 0, tx: 0 };
        }
        const dt = (now - lastTime) / 1000;
        const prevNet = lastNet;
        lastNet = { rx, tx };
        lastTime = now;
        if (dt <= 0) return { rx: 0, tx: 0 };
        const rxRate = ((rx - prevNet.rx) * 8) / dt / 1024 / 1024;
        const txRate = ((tx - prevNet.tx) * 8) / dt / 1024 / 1024;
        return {
            rx: Math.max(rxRate, 0),
            tx: Math.max(txRate, 0)
        };
    } catch (e) {
        return { rx: 0, tx: 0 };
    }
}

function fetchJson(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('Request timed out'));
        });
    });
}

function getLocalIPs() {
    const nets = os.networkInterfaces();
    const result = { ipv4: 'N/A', ipv6: 'N/A' };
    for (const iface of Object.values(nets)) {
        if (!iface) continue;
        for (const entry of iface) {
            if (entry.internal) continue;
            if (entry.family === 'IPv4' && result.ipv4 === 'N/A') {
                result.ipv4 = entry.address;
            }
            if (entry.family === 'IPv6' && result.ipv6 === 'N/A') {
                result.ipv6 = entry.address;
            }
            if (result.ipv4 !== 'N/A' && result.ipv6 !== 'N/A') {
                return result;
            }
        }
    }
    return result;
}

async function refreshIPCache() {
    const now = Date.now();
    if (now - cachedIP.updatedAt < PUBLIC_IP_CACHE_TTL_MS) {
        return cachedIP;
    }
    const local = getLocalIPs();
    try {
        const ipv4Res = await fetchJson(PUBLIC_IPV4_URL);
        if (ipv4Res && ipv4Res.ip) cachedIP.ipv4 = ipv4Res.ip;
    } catch (_) {
        cachedIP.ipv4 = cachedIP.ipv4 || local.ipv4;
    }
    try {
        const ipv6Res = await fetchJson(PUBLIC_IPV6_URL);
        if (ipv6Res && ipv6Res.ip) cachedIP.ipv6 = ipv6Res.ip;
    } catch (_) {
        cachedIP.ipv6 = cachedIP.ipv6 || local.ipv6;
    }
    if (cachedIP.ipv4 === 'N/A') cachedIP.ipv4 = local.ipv4;
    if (cachedIP.ipv6 === 'N/A') cachedIP.ipv6 = local.ipv6;
    cachedIP.updatedAt = now;
    return cachedIP;
}

function getIP() {
    if (Date.now() - cachedIP.updatedAt > PUBLIC_IP_CACHE_TTL_MS) {
        refreshIPCache().catch(() => {});
    }
    return {
        ipv4: cachedIP.ipv4,
        ipv6: cachedIP.ipv6
    };
}

refreshIPCache().catch(() => {});

module.exports = function getStats() {
    const cpuInfo = readCPUInfo();
    return {
        cpu: {
            usage: readCPUStat(),
            model: cpuInfo.model,
            freq: cpuInfo.freq,
            cores: cpuInfo.cores
        },
        ...readMem(),
        disk: readDisk(),
        net: readNet(),
        ip: getIP()
    };
};