const fs = require('fs');
const { execSync } = require('child_process');

let lastCPU = null;
let lastNet = null;
let lastTime = Date.now();

function readCPUStat() {
  // 读取第一行 cpu 总数据
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
  let model = 'N/A', freq = 'N/A';
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
  return { model, freq };
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
    memUsed: (mt - ma) / 1024,      // MB
    memTotal: mt / 1024,
    swapUsed: (st - sf) / 1024,
    swapTotal: st / 1024
  };
}

function readDisk() {
  const stat = fs.statfsSync('/');
  const total = stat.blocks * stat.bsize;
  const free = stat.bfree * stat.bsize;
  return {
    used: (total - free) / 1024 / 1024 / 1024,
    total: total / 1024 / 1024 / 1024
  };
}

function readNet() {
  const now = Date.now();
  const data = fs.readFileSync('/proc/net/dev', 'utf8');
  let rx = 0, tx = 0;
  const lines = data.split('\n');
  // 统计所有非lo网卡，可根据需要调整接口名称
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const iface = parts[0].replace(':', '');
    if (iface === 'lo') continue;         // 跳过回环
    // 可增加过滤：docker、veth、br- 等
    if (iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) continue;
    rx += parseInt(parts[1]);
    tx += parseInt(parts[9]);
  }

  if (!lastNet) {
    lastNet = { rx, tx };
    lastTime = now;
    return { rx: 0, tx: 0 };
  }
  const dt = (now - lastTime) / 1000;
  const rxRate = ((rx - lastNet.rx) * 8) / dt / 1024 / 1024;   // Mbps
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
  } catch (_) { /* ignore */ }
  try {
    ipv6 = execSync('curl -6 -s --max-time 2 https://api64.ipify.org').toString().trim();
  } catch (_) { /* ignore */ }
  return { ipv4, ipv6 };
}

// 单次采集接口
module.exports = function getStats() {
  return {
    cpu: {
      usage: readCPUStat(),
      ...readCPUInfo()
    },
    ...readMem(),
    disk: readDisk(),
    net: readNet(),
    ip: getIP()
  };
};