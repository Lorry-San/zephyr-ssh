const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// ================= 配置项 =================
// 使用 DNS over HTTPS (DoH) 获取公网 IP，相比 curl 外部服务更稳定、更快。
// 可以自行更换为其他 DoH 服务商。
const IPV4_DOH_URL = 'https://1.1.1.1/dns-query?name=myip.opendns.com&type=A';
const IPV6_DOH_URL = 'https://1.1.1.1/dns-query?name=myip.opendns.com&type=AAAA';
// ==========================================

let lastCPU = null;
let lastNet = null;
let lastDisk = null;
let lastTime = Date.now();

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

function readDisk() {
    try {
        const stat = fs.statfsSync('/');
        const total = stat.blocks * stat.bsize;
        const free = stat.bfree * stat.bsize;
        const usedGB = (total - free) / 1024 / 1024 / 1024;
        const totalGB = total / 1024 / 1024 / 1024;

        let readKBps = 0, writeKBps = 0;
        try {
            const data = fs.readFileSync('/proc/diskstats', 'utf8');
            const lines = data.split('\n');
            let rs = 0, ws = 0;
            for (const line of lines) {
                const p = line.trim().split(/\s+/);
                if (p.length > 13 && (p[2].startsWith('sd') || p[2].startsWith('vd') || p[2].startsWith('nvme'))) {
                    rs += parseInt(p[5]) || 0;
                    ws += parseInt(p[9]) || 0;
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
        return { used: usedGB, total: totalGB, readKBps, writeKBps };
    } catch (e) {
        return { used: 0, total: 0, readKBps: 0, writeKBps: 0 };
    }
}

function readNet() {
    try {
        const now = Date.now();
        const data = fs.readFileSync('/proc/net/dev', 'utf8');
        let rx = 0, tx = 0;
        const lines = data.split('\n');
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 10) continue;
            const iface = parts[0].replace(':', '');
            if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) continue;
            rx += parseInt(parts[1]);
            tx += parseInt(parts[9]);
        }
        if (!lastNet) {
            lastNet = { rx, tx };
            lastTime = now;
            return { rx: 0, tx: 0 };
        }
        const dt = (now - lastTime) / 1000;
        const rxRate = ((rx - lastNet.rx) * 8) / dt / 1024 / 1024;
        const txRate = ((tx - lastNet.tx) * 8) / dt / 1024 / 1024;
        lastNet = { rx, tx };
        lastTime = now;
        return {
            rx: Math.max(rxRate, 0),
            tx: Math.max(txRate, 0)
        };
    } catch (e) {
        return { rx: 0, tx: 0 };
    }
}

// 使用 DNS over HTTPS 获取公网 IP，更稳定、快速
function getIPViaDoH(url) {
    try {
        const result = execSync(`curl -s -H "Accept: application/dns-json" "${url}"`, { timeout: 3000 }).toString().trim();
        const json = JSON.parse(result);
        if (json.Answer && json.Answer.length > 0) {
            return json.Answer[0].data || 'N/A';
        }
    } catch (_) {}
    return 'N/A';
}

function getIP() {
    return {
        ipv4: getIPViaDoH(IPV4_DOH_URL),
        ipv6: getIPViaDoH(IPV6_DOH_URL)
    };
}

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