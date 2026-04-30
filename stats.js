const STAT_COMMAND = [
  'cat /proc/stat || true',
  "printf '\n__END_CPU__\n'",
  'cat /proc/meminfo || true',
  "printf '\n__END_MEM__\n'",
  'df -kP -x tmpfs -x devtmpfs -x squashfs -x overlay || true',
  "printf '\n__END_DISK__\n'",
  'cat /proc/diskstats || true',
  "printf '\n__END_DISKSTATS__\n'",
  'cat /proc/net/dev || true',
  "printf '\n__END_NET__\n'",
  'curl -4fsS --connect-timeout 3 https://api.ipify.org || true',
  "printf '\n__END_IP4__\n'",
  'curl -6fsS --connect-timeout 3 https://api.ipify.org || true',
  "printf '\n__END_IP6__\n'",
  'cat /proc/cpuinfo || true',
  "printf '\n__END_CPUINFO__\n'",
  'uname -srmo 2>/dev/null || true',
  "printf '\n__END_UNAME__\n'",
  'hostname 2>/dev/null || true'
].join(' && ');

function execRemote(sshClient, command) {
  return new Promise((resolve, reject) => {
    sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => {
        if (code !== 0 && stdout.trim().length === 0) {
          return reject(new Error(`Remote command failed: ${stderr.trim()}`));
        }
        resolve(stdout);
      });
    });
  });
}

function splitSections(raw) {
  const parts = raw.split('\n__END_CPU__\n');
  const cpu = parts[0] || '';
  const rest1 = parts[1] || '';
  const [mem, rest2] = rest1.split('\n__END_MEM__\n');
  const [disk, rest3] = (rest2 || '').split('\n__END_DISK__\n');
  const [diskstats, rest4] = (rest3 || '').split('\n__END_DISKSTATS__\n');
  const [net, rest5] = (rest4 || '').split('\n__END_NET__\n');
  const [ip4, rest6] = (rest5 || '').split('\n__END_IP4__\n');
  const [ip6, rest7] = (rest6 || '').split('\n__END_IP6__\n');
  const [cpuinfo, rest8] = (rest7 || '').split('\n__END_CPUINFO__\n');
  const [unameInfo, hostname] = (rest8 || '').split('\n__END_UNAME__\n');
  return { cpu, mem, disk, diskstats, net, ip4, ip6, cpuinfo, unameInfo, hostname };
}

function parseCpuStat(raw) {
  const line = raw.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { idle, total };
}

function parseMemory(raw) {
  const result = { memUsed: 0, memTotal: 0, swapUsed: 0, swapTotal: 0 };
  raw.split('\n').forEach((line) => {
    if (line.startsWith('MemTotal')) result.memTotal = Number(line.split(/\s+/)[1]) / 1024;
    if (line.startsWith('MemAvailable')) result.memUsed = result.memTotal - (Number(line.split(/\s+/)[1]) / 1024);
    if (line.startsWith('SwapTotal')) result.swapTotal = Number(line.split(/\s+/)[1]) / 1024;
    if (line.startsWith('SwapFree')) result.swapUsed = result.swapTotal - (Number(line.split(/\s+/)[1]) / 1024);
  });
  if (result.memUsed < 0) result.memUsed = 0;
  if (result.swapUsed < 0) result.swapUsed = 0;
  return result;
}

function getDiskBaseName(filesystem) {
  if (!filesystem) return null;
  const name = filesystem.replace(/^\/dev\//, '').replace(/^mapper\//, '');
  if (/^nvme\d+n\d+p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  if (/^mmcblk\d+p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  return name.replace(/\d+$/, '');
}

function parseDisk(raw) {
  const lines = raw.trim().split('\n');
  if (lines.length <= 1) return { total: 0, used: 0, devices: [] };
  const devices = lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const [filesystem, blocks, used, available, usePercent, mountpoint] = parts;
    const totalGB = Number(blocks) / 1024 / 1024;
    const usedGB = Number(used) / 1024 / 1024;
    const percent = parseInt(usePercent.replace('%', ''), 10) || 0;
    return {
      id: `disk-${filesystem.replace(/[^a-zA-Z0-9_-]/g, '')}-${mountpoint.replace(/[^a-zA-Z0-9_-]/g, '')}`,
      filesystem,
      mountpoint,
      diskName: getDiskBaseName(filesystem),
      usedGB: Number(usedGB.toFixed(1)),
      totalGB: Number(totalGB.toFixed(1)),
      percent,
      usageLabel: `${percent}%`,
      readKBps: 0,
      writeKBps: 0
    };
  }).filter(Boolean);
  return {
    devices,
    total: devices.reduce((sum, device) => sum + device.totalGB, 0),
    used: devices.reduce((sum, device) => sum + device.usedGB, 0)
  };
}

function parseDiskStats(raw) {
  const stats = {};
  raw.split('\n').forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) return;
    const dev = parts[2];
    const reads = Number(parts[5]) || 0;
    const writes = Number(parts[9]) || 0;
    stats[dev] = { reads, writes };
  });
  return stats;
}

function computeDiskRates(current, diskStats, previousDiskStats = {}, elapsedSeconds) {
  const devices = current.devices.map((device) => {
    const stats = device.diskName ? diskStats[device.diskName] : null;
    const prevStats = device.diskName ? previousDiskStats[device.diskName] : null;
    const readDiff = Math.max(0, (stats?.reads || 0) - (prevStats?.reads || 0));
    const writeDiff = Math.max(0, (stats?.writes || 0) - (prevStats?.writes || 0));
    const readKBps = elapsedSeconds > 0 ? readDiff / 2 / elapsedSeconds : 0;
    const writeKBps = elapsedSeconds > 0 ? writeDiff / 2 / elapsedSeconds : 0;
    return {
      ...device,
      readKBps: Number(readKBps.toFixed(1)),
      writeKBps: Number(writeKBps.toFixed(1))
    };
  });
  return {
    devices,
    total: current.total,
    used: current.used
  };
}

function parseNet(raw) {
  const lines = raw.split('\n');
  let rx = 0;
  let tx = 0;
  lines.forEach((line) => {
    const cleaned = line.replace(':', ' ');
    const parts = cleaned.trim().split(/\s+/);
    if (parts.length < 17) return;
    const iface = parts[0];
    if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') || iface.startsWith('br-')) return;
    rx += Number(parts[1]) || 0;
    tx += Number(parts[9]) || 0;
  });
  return { rx, tx };
}

function parseIp(raw) {
  const value = raw.trim();
  if (!value) return 'N/A';
  const lines = value.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed) || /:/g.test(trimmed)) {
      return trimmed;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 4 && parts[3] && parts[3].includes('/')) {
      return parts[3].split('/')[0];
    }
  }
  return 'N/A';
}

function parseCPUInfo(raw) {
  let model = 'N/A';
  let freq = 'N/A';
  let cores = 0;
  raw.split('\n').forEach((line) => {
    if (line.startsWith('model name') && model === 'N/A') {
      model = line.split(':')[1]?.trim() || 'N/A';
    }
    if (line.startsWith('cpu MHz') && freq === 'N/A') {
      freq = Math.round(Number(line.split(':')[1]) || 0) + ' MHz';
    }
    if (line.startsWith('processor')) {
      cores += 1;
    }
  });
  if (cores === 0 && model !== 'N/A') cores = 1;
  return { model, freq, cores };
}

function parseUname(raw) {
  return raw.trim() || 'N/A';
}

function computeCpuUsage(current, previous) {
  if (!current || !previous || typeof previous.idle !== 'number' || typeof previous.total !== 'number') return 0;
  const totalDiff = current.total - previous.total;
  const idleDiff = current.idle - previous.idle;
  if (totalDiff <= 0) return 0;
  return Number(((1 - idleDiff / totalDiff) * 100).toFixed(1));
}

function computeNetRates(current, previous, elapsedSeconds) {
  if (!previous || elapsedSeconds <= 0) return { rx: 0, tx: 0 };
  return {
    rx: Math.max(((current.rx - previous.rx) * 8) / elapsedSeconds / 1024 / 1024, 0),
    tx: Math.max(((current.tx - previous.tx) * 8) / elapsedSeconds / 1024 / 1024, 0)
  };
}

async function getRemoteStats(sshClient, previous = {}) {
  const raw = await execRemote(sshClient, STAT_COMMAND);
  const sections = splitSections(raw);
  const cpuStat = parseCpuStat(sections.cpu);
  const mem = parseMemory(sections.mem);
  const rawDisk = parseDisk(sections.disk);
  const diskStats = parseDiskStats(sections.diskstats);
  const netValues = parseNet(sections.net);
  const ipv4 = parseIp(sections.ip4);
  const ipv6 = parseIp(sections.ip6);
  const cpuInfo = parseCPUInfo(sections.cpuinfo);
  const osInfo = parseUname(sections.unameInfo);
  const hostname = sections.hostname.trim() || 'N/A';
  const now = Date.now();
  const elapsed = previous.timestamp ? (now - previous.timestamp) / 1000 : 0;
  const disk = computeDiskRates(rawDisk, diskStats, previous.diskStats, elapsed);
  const cpuUsage = computeCpuUsage(cpuStat, previous.cpuStat);
  const net = computeNetRates(netValues, previous.netValues, elapsed);

  return {
    stats: {
      cpu: {
        usage: cpuUsage,
        model: cpuInfo.model,
        freq: cpuInfo.freq,
        cores: cpuInfo.cores
      },
      ...mem,
      disk,
      net,
      ip: { ipv4, ipv6 },
      host: { hostname, os: osInfo }
    },
    state: {
      cpuStat,
      netValues,
      diskStats,
      timestamp: now
    }
  };
}

module.exports = { getRemoteStats };
