const fs = require('fs');
const { execSync } = require('child_process');

let lastCPU = null;
let lastNet = null;
let lastDisk = null;
let lastTime = Date.now();

function readCPUStat() {
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
}

function readCPUInfo() {
  let model = 'N/A', freq = 'N/A', cores = 0;
  const data = fs.readFileSync('/proc/cpuinfo', 'utf8');
  const lines = data.split('\n');
  for (const line of lines) {
    if (line.startsWith('model name') && model === 'N/A') {
      model = line.split(':')[1].trim();
    }
    if (line.startsWith('cpu MHz') && freq === 'N/A') {
      freq = Math.round(parseFloat(line.split(':')[1])) + ' MHz';
    }
    if (line.startsWith('processor')) cores++;
  }
  return { model, freq, cores };
}

function readMem() {
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
}

function readDisk() {
  const stat = fs.statfsSync('/');
  const total = stat.blocks * stat.bsize;
  const free = stat.bfree * stat.bsize;
  const usedGB = (total - free) / 1024 / 1024 / 1024;
  const totalGB = total / 1024 / 1024 / 1024;

  let readKBps = 0, writeKBps = 0;
  try {
    const out = execSync('iostat -d sda 1 2 | tail -2', { timeout: 3000 }).toString().trim();
    const lines = out.split('\n').filter(Boolean);
    if (lines.length >= 2) {
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      readKBps = parseFloat(parts[2]) || 0;
      writeKBps = parseFloat(parts[3]) || 0;
    }
  } catch (_) {
    // 回退：读取 /proc/diskstats
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
  }
  return { used: usedGB, total: totalGB, readKBps, writeKBps };
}

function readNet() {
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
}

function getIP() {
  let ipv4 = 'N/A', ipv6 = 'N/A';
  try {
    ipv4 = execSync('curl -4 -s --max-time 2 https://api.ipify.org').toString().trim();
  } catch (_) {}
  try {
    ipv6 = execSync('curl -6 -s --max-time 2 https://api64.ipify.org').toString().trim();
  } catch (_) {}
  return { ipv4, ipv6 };
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