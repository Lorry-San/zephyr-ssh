const $ = (sel) => document.querySelector(sel);

function getParams() {
    try {
        const raw = sessionStorage.getItem('zephyr_ssh_params');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

const params = getParams();
if (!params) {
    window.location.href = '/';
    throw new Error('缺少连接参数');
}

// ---------- DOM 元素 ----------
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const terminalOverlay = $('#terminalOverlay');
const overlayMsg = $('#overlayMsg');
const wtermWrapper = $('#wtermWrapper');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const themeToggle = $('#themeToggle');
const cmdInput = $('#cmdInput');
const cmdSendBtn = $('#cmdSendBtn');
const copyBtn = $('#copyBtn');
const fileBtn = $('#fileBtn');
const infoBtn = $('#infoBtn');

// 文件管理器 DOM
const fileManager = $('#fileManager');
const fmBackBtn = $('#fmBackBtn');
const fmPathInput = $('#fmPathInput');
const fmGoBtn = $('#fmGoBtn');
const fmRefreshBtn = $('#fmRefreshBtn');
const fmCloseBtn = $('#fmCloseBtn');
const fmNewFolderBtn = $('#fmNewFolderBtn');
const fmNewFileBtn = $('#fmNewFileBtn');
const fmUploadInput = $('#fmUploadInput');
const fmSearchInput = $('#fmSearchInput');
const fmList = $('#fmList');
const fmEditorModal = $('#fmEditorModal');
const fmEditorTitle = $('#fmEditorTitle');
const fmEditorTextarea = $('#fmEditorTextarea');
const fmEditorSaveBtn = $('#fmEditorSaveBtn');
const fmEditorCancelBtn = $('#fmEditorCancelBtn');
const fmEditorCloseBtn = $('#fmEditorCloseBtn');

// 监控相关 DOM
const infoModal = $('#infoModal');
const infoCloseBtn = $('#infoCloseBtn');
const infoBody = $('#infoBody');
const chartContainer = $('#chartContainer');

// ---------- 全局变量 ----------
let term = null;
let wsConnection = null;
let isConnected = false;
let sftpReady = false;
let currentPath = '.';
let allFiles = [];
let searchQuery = '';
let editorFilePath = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// 图表实例
let charts = {};

// ---------- 主题管理 ----------
function getPreferredTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('zephyr-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}
applyTheme(getPreferredTheme());

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zephyr-theme')) {
        applyTheme(e.matches ? 'light' : 'dark');
    }
});

// ---------- 复制功能 ----------
copyBtn.addEventListener('click', async () => {
    const selection = window.getSelection();
    const text = selection.toString();
    if (!text) return;
    const originalText = copyBtn.textContent;
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✅ 已复制';
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); copyBtn.textContent = '✅ 已复制'; } catch (_) { copyBtn.textContent = '❌ 失败'; }
        document.body.removeChild(ta);
    }
    setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
});

// ---------- Ctrl+C 智能判断 ----------
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'c') {
        const selection = window.getSelection();
        const text = selection.toString();
        if (text) return;
        e.preventDefault();
        sendData('\x03');
    }
});

// ---------- 文件管理器 ----------
function showFileManager() {
    fileManager.classList.add('open');
    if (!sftpReady) {
        initSFTP();
    } else {
        refreshFileList();
    }
}
function hideFileManager() { fileManager.classList.remove('open'); }
fileBtn.addEventListener('click', () => {
    if (fileManager.classList.contains('open')) hideFileManager();
    else showFileManager();
});
fmCloseBtn.addEventListener('click', hideFileManager);

function initSFTP() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-init' }));
}
function refreshFileList() {
    if (!sftpReady) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-list', path: currentPath }));
    fmPathInput.value = currentPath;
}
fmRefreshBtn.addEventListener('click', refreshFileList);

function navigateTo(path) {
    currentPath = path;
    searchQuery = '';
    fmSearchInput.value = '';
    refreshFileList();
}
fmGoBtn.addEventListener('click', () => {
    const p = fmPathInput.value.trim();
    if (p) navigateTo(p);
});
fmPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const p = fmPathInput.value.trim();
        if (p) navigateTo(p);
    }
});
fmBackBtn.addEventListener('click', () => {
    const parts = currentPath.replace(/\/+$/, '').split('/');
    parts.pop();
    navigateTo(parts.join('/') || '/');
});
fmSearchInput.addEventListener('input', () => {
    searchQuery = fmSearchInput.value.trim();
    renderFileList(allFiles);
});

function sortFiles(files) {
    return [...files].sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'd' ? -1 : 1;
    });
}
function filterFiles(files, query) {
    if (!query) return files;
    return files.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
}

fmList.addEventListener('click', (e) => {
    if (e.target.closest('.fm-item-actions')) return;
    const item = e.target.closest('.fm-item');
    if (!item) return;
    const fileName = item.dataset.fileName;
    const fileType = item.dataset.fileType;
    if (!fileName) return;
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + fileName;
    if (fileType === 'd') navigateTo(fullPath);
    else openEditor(fullPath);
});

function renderFileList(files) {
    allFiles = sortFiles(files);
    const filtered = filterFiles(allFiles, searchQuery);
    fmList.innerHTML = '';
    filtered.forEach(file => {
        const item = document.createElement('div');
        item.className = 'fm-item';
        item.dataset.fileName = file.name;
        item.dataset.fileType = file.type;
        const icon = file.type === 'd' ? '📁' : '📄';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${icon} ${file.name}`;
        const actions = document.createElement('div');
        actions.className = 'fm-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.textContent = '✏️';
        renameBtn.title = '重命名';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newName = prompt('新名称:', file.name);
            if (!newName) return;
            const oldPath = currentPath.replace(/\/+$/, '') + '/' + file.name;
            const newPath = currentPath.replace(/\/+$/, '') + '/' + newName;
            wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath, newPath }));
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️';
        deleteBtn.title = '删除';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确认删除 ${file.name}?`)) {
                wsConnection.send(JSON.stringify({
                    type: 'sftp-delete',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            }
        });

        if (file.type !== 'd') {
            const downloadBtn = document.createElement('button');
            downloadBtn.textContent = '⬇️';
            downloadBtn.title = '下载';
            downloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                wsConnection.send(JSON.stringify({
                    type: 'sftp-download',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            });
            actions.appendChild(downloadBtn);
        }

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        item.appendChild(nameSpan);
        item.appendChild(actions);
        fmList.appendChild(item);
    });
}

// 新建文件夹
fmNewFolderBtn.addEventListener('click', () => {
    const name = prompt('请输入文件夹名称:');
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-mkdir', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 新建文件
fmNewFileBtn.addEventListener('click', () => {
    const name = prompt('请输入文件名:');
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-touch', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 上传文件
fmUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        wsConnection.send(JSON.stringify({ type: 'sftp-upload', path: currentPath.replace(/\/+$/, '') + '/' + file.name, data: base64 }));
    };
    reader.readAsDataURL(file);
    fmUploadInput.value = '';
});
// 编辑器
function openEditor(filePath) {
    editorFilePath = filePath;
    fmEditorModal.style.display = 'flex';
    fmEditorTitle.textContent = `编辑: ${filePath}`;
    wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path: filePath }));
}
fmEditorCloseBtn.addEventListener('click', () => { fmEditorModal.style.display = 'none'; });
fmEditorCancelBtn.addEventListener('click', () => { fmEditorModal.style.display = 'none'; });
fmEditorSaveBtn.addEventListener('click', () => {
    if (!editorFilePath) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-writefile', path: editorFilePath, data: fmEditorTextarea.value }));
    fmEditorModal.style.display = 'none';
});

// ---------- SFTP 消息处理 ----------
function handleSFTPMessage(msg) {
    switch (msg.type) {
        case 'sftp-ready': sftpReady = true; refreshFileList(); break;
        case 'sftp-list':
            if (msg.error) alert('列出目录失败: ' + msg.error);
            else { renderFileList(msg.files); currentPath = msg.path; fmPathInput.value = currentPath; }
            break;
        case 'sftp-mkdir': case 'sftp-touch': case 'sftp-delete': case 'sftp-rename': case 'sftp-upload':
            if (msg.success) refreshFileList(); else alert('操作失败: ' + (msg.error || '未知错误'));
            break;
        case 'sftp-download':
            if (msg.error) alert('下载失败: ' + msg.error);
            else {
                const byteChars = atob(msg.data);
                const byteNums = new Array(byteChars.length).fill(0).map((_, i) => byteChars.charCodeAt(i));
                const blob = new Blob([new Uint8Array(byteNums)]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = msg.path.split('/').pop(); a.click();
                URL.revokeObjectURL(url);
            }
            break;
        case 'sftp-readfile':
            if (msg.error) alert('读取失败: ' + msg.error); else fmEditorTextarea.value = msg.data;
            break;
        case 'sftp-writefile':
            if (msg.success) { refreshFileList(); fmEditorModal.style.display = 'none'; } else alert('保存失败: ' + (msg.error || '未知错误'));
            break;
        case 'sftp-error': alert('SFTP 错误: ' + msg.message); sftpReady = false; break;
    }
}

// ---------- 监控面板 ----------
function initCharts() {
    if (Object.keys(charts).length) return;

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        elements: { point: { radius: 0 }, line: { tension: 0.2 } },
        scales: { x: { display: false }, y: { display: false } }
    };

    function createDoughnut(canvasId) {
        const ctx = $(`#${canvasId}`).getContext('2d');
        return new Chart(ctx, {
            type: 'doughnut',
            data: { datasets: [{ data: [0, 100], backgroundColor: ['#3fb950', 'rgba(255,255,255,0.05)'], borderWidth: 0 }] },
            options: { circumference: 270, rotation: 225, cutout: '80%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
        });
    }

    function createLine(canvasId, color) {
        const ctx = $(`#${canvasId}`).getContext('2d');
        return new Chart(ctx, {
            type: 'line',
            data: { labels: Array(20).fill(''), datasets: [{ data: Array(20).fill(0), borderColor: color, borderWidth: 1.5, fill: false }] },
            options: { ...commonOptions }
        });
    }

    charts = {
        cpu: createDoughnut('cpuDoughnut'),
        ram: createDoughnut('ramDoughnut'),
        swap: createDoughnut('swapDoughnut'),
        disk: createDoughnut('diskDoughnut'),
        rxLine: createLine('rxLine', '#3fb950'),
        txLine: createLine('txLine', '#58a6ff'),
        diskReadLine: createLine('diskReadLine', '#f0883e'),
        diskWriteLine: createLine('diskWriteLine', '#d2991d'),
    };
}

function updateDoughnut(chart, value) {
    chart.data.datasets[0].data = [value, 100 - value];
    const color = value < 50 ? '#3fb950' : value < 80 ? '#d2991d' : '#f85149';
    chart.data.datasets[0].backgroundColor = [color, 'rgba(255,255,255,0.05)'];
    chart.update();
}

function updateLine(chart, value) {
    const data = chart.data.datasets[0].data;
    data.push(value);
    if (data.length > 20) data.shift();
    chart.update();
}

function renderStats(d) {
    // 初始化图表（首次）
    initCharts();

    // 更新环形图
    updateDoughnut(charts.cpu, d.cpu.usage);
    updateDoughnut(charts.ram, (d.memUsed / d.memTotal) * 100);
    updateDoughnut(charts.swap, d.swapTotal ? (d.swapUsed / d.swapTotal) * 100 : 0);
    updateDoughnut(charts.disk, (d.disk.used / d.disk.total) * 100);

    // 更新折线图
    updateLine(charts.rxLine, d.net.rx);
    updateLine(charts.txLine, d.net.tx);
    updateLine(charts.diskReadLine, d.disk.readKBps);
    updateLine(charts.diskWriteLine, d.disk.writeKBps);

    // 生成 HTML 布局
    infoBody.innerHTML = `
        <div class="doughnut-row">
            <div class="doughnut-item">
                <div class="doughnut-label">CPU</div>
                <div class="doughnut-wrap"><canvas id="cpuDoughnut"></canvas></div>
                <div class="doughnut-text">${d.cpu.usage.toFixed(1)}%</div>
                <div class="doughnut-sub">${d.cpu.model} @ ${d.cpu.freq} · ${d.cpu.cores}核</div>
            </div>
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">内存</div>
                <div class="doughnut-wrap"><canvas id="ramDoughnut"></canvas></div>
                <div class="doughnut-text">${(d.memUsed / 1024).toFixed(1)} / ${(d.memTotal / 1024).toFixed(1)} GB</div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">Swap</div>
                <div class="doughnut-wrap"><canvas id="swapDoughnut"></canvas></div>
                <div class="doughnut-text">${(d.swapUsed / 1024).toFixed(1)} / ${(d.swapTotal / 1024).toFixed(1)} GB</div>
            </div>
        </div>
        <div class="doughnut-row">
            <div class="doughnut-item">
                <div class="doughnut-label">磁盘</div>
                <div class="doughnut-wrap"><canvas id="diskDoughnut"></canvas></div>
                <div class="doughnut-text">${d.disk.used.toFixed(1)} / ${d.disk.total.toFixed(1)} GB</div>
                <div class="doughnut-sub">读 ${d.disk.readKBps.toFixed(0)} KB/s · 写 ${d.disk.writeKBps.toFixed(0)} KB/s</div>
                <div class="sparkline-row"><canvas id="diskReadLine" height="30"></canvas><canvas id="diskWriteLine" height="30"></canvas></div>
            </div>
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">下载</div>
                <div class="doughnut-wrap"><canvas id="rxLine" height="30"></canvas></div>
                <div class="doughnut-text">${d.net.rx.toFixed(1)} Mbps</div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">上传</div>
                <div class="doughnut-wrap"><canvas id="txLine" height="30"></canvas></div>
                <div class="doughnut-text">${d.net.tx.toFixed(1)} Mbps</div>
            </div>
        </div>
        <div class="ip-section">
            <div class="ip-box"><span>IPv4</span><code>${d.ip.ipv4}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${d.ip.ipv4}')">📋</button></div>
            <div class="ip-box"><span>IPv6</span><code>${d.ip.ipv6}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${d.ip.ipv6}')">📋</button></div>
        </div>
    `;

    // 重新绑定图表 canvas，因为 innerHTML 会清除原有 canvas
    initCharts();
}

infoBtn.addEventListener('click', () => {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        alert('请先连接 SSH'); return;
    }
    infoModal.style.display = 'flex';
    initCharts();
});
infoCloseBtn.addEventListener('click', () => { infoModal.style.display = 'none'; });

// ---------- 辅助键 / 终端输入 ----------
const modifierState = { ctrl: false, alt: false, shift: false };
const modifierButtons = document.querySelectorAll('.modifier');
function updateModifierUI() {
    modifierButtons.forEach(btn => btn.classList.toggle('active', modifierState[btn.dataset.key]));
}
function processModifiers(data) {
    if (!modifierState.ctrl && !modifierState.alt && !modifierState.shift) return data;
    let result = '';
    for (const ch of data) {
        const code = ch.charCodeAt(0);
        let transformed = ch;
        if (modifierState.ctrl) {
            if (code >= 65 && code <= 90) transformed = String.fromCharCode(code - 64);
            else if (code >= 97 && code <= 122) transformed = String.fromCharCode(code - 96);
        }
        if (modifierState.alt) transformed = '\x1b' + transformed;
        result += transformed;
    }
    return result;
}
function sendData(data) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        wsConnection.send(JSON.stringify({ type: 'input', data: processModifiers(data) }));
    }
}
function sendCommand() {
    const text = cmdInput.value;
    if (text && wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        sendData(text + '\r\n');
    }
    cmdInput.value = '';
}
cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendCommand(); } });
cmdSendBtn.addEventListener('click', sendCommand);

document.querySelectorAll('.func, .arrow, .combo, .modifier').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (btn.classList.contains('modifier')) { modifierState[key] = !modifierState[key]; updateModifierUI(); return; }
        if (keySequences[key]) sendData(keySequences[key]);
        if (comboSequences[key]) sendData(comboSequences[key]);
    });
});

const keySequences = {
    esc: '\x1b', tab: '\t', home: '\x1b[1~', end: '\x1b[4~',
    up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
};
const comboSequences = { 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-l': '\x0c', 'ctrl-u': '\x15' };

// 保留选区
wtermWrapper.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) term?.focus?.();
});

// ---------- 状态指示 ----------
function setStatus(state, msg) {
    statusDot.className = 'status-dot';
    if (state === 'connecting') {
        statusText.textContent = msg || '连接中...';
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '正在建立 SSH 连接...';
    } else if (state === 'connected') {
        statusDot.classList.add('connected');
        statusText.textContent = msg || '已连接';
        terminalOverlay.classList.add('hidden');
        isConnected = true;
    } else if (state === 'disconnected') {
        statusDot.classList.add('disconnected');
        statusText.textContent = msg || '已断开';
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '连接已断开';
    } else if (state === 'error') {
        statusDot.classList.add('disconnected');
        statusText.textContent = '错误';
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '连接出错';
    }
}
connInfo.textContent = `${params.username}@${params.host}:${params.port}`;

// ---------- WTerm 初始化 ----------
async function initWTerm() {
    let WTermClass;
    try {
        const module = await import('/vendor/@wterm/dom/dist/index.js');
        WTermClass = module.WTerm;
    } catch {
        const module = await import('/vendor/@wterm/dom/dist/wterm.js');
        WTermClass = module.WTerm || module.default;
    }
    wtermWrapper.innerHTML = '';
    try {
        term = new WTermClass(wtermWrapper, {
            cols: 80, rows: 24, autoResize: true, cursorBlink: true,
            onData: (data) => sendData(data),
        });
    } catch {
        term = new WTermClass(wtermWrapper);
        if (typeof term.onData === 'function') term.onData(data => sendData(data));
        else if (typeof term.on === 'function') term.on('data', data => sendData(data));
    }
    if (typeof term.init === 'function') await term.init();

    const observeResize = () => {
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
            const rect = wtermWrapper.getBoundingClientRect();
            wsConnection.send(JSON.stringify({ type: 'resize', rows: Math.floor(rect.height / 17), cols: Math.floor(rect.width / 7.2) }));
        }
    };
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => { clearTimeout(ro._timer); ro._timer = setTimeout(observeResize, 150); });
        ro.observe(wtermWrapper);
    }
    window.addEventListener('resize', observeResize);
}

// ---------- WebSocket ----------
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ssh`);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('超时')); }, 10000);

        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            ws.send(JSON.stringify({ type: 'connect', host: params.host, port: params.port, username: params.username, password: params.password || '', privateKey: params.privateKey || '', init: params.init || '' }));
        });

        ws.addEventListener('message', (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'stats') { renderStats(msg.data); return; }
                if (msg.type?.startsWith('sftp-')) { handleSFTPMessage(msg); return; }
                switch (msg.type) {
                    case 'ready': setStatus('connected'); if (term?.focus) term.focus(); reconnectAttempts = 0; resolve(ws); break;
                    case 'data': if (term?.write) term.write(msg.data); break;
                    case 'error': setStatus('error', msg.message); reject(new Error(msg.message)); break;
                    case 'close': setStatus('disconnected', msg.message || '会话关闭'); break;
                    case 'banner': if (term?.write) term.write(msg.data); break;
                }
            } catch (_) {}
        });

        ws.addEventListener('error', () => clearTimeout(timeout));
        ws.addEventListener('close', (e) => {
            clearTimeout(timeout);
            wsConnection = null;
            if (isConnected) setStatus('disconnected', `连接断开 (${e.code})`);
            if (term) { try { term.destroy?.(); } catch (_) {} term = null; }
        });

        wsConnection = ws;
    });
}

function disconnect() {
    if (wsConnection) { try { wsConnection.send(JSON.stringify({ type: 'disconnect' })); } catch {} wsConnection.close(1000, '用户断连'); wsConnection = null; }
    if (term) { try { term.destroy?.(); } catch {} term = null; }
    setStatus('disconnected', '已断开');
    isConnected = false;
}
async function reconnect() {
    disconnect();
    wtermWrapper.innerHTML = '';
    reconnectAttempts = 0;
    setStatus('connecting', '正在重连...');
    try { await initWTerm(); await connectWebSocket(); } catch (err) { setStatus('error', err.message); }
}

async function main() {
    setStatus('connecting');
    try { await initWTerm(); await connectWebSocket(); } catch (err) {
        setStatus('error', err.message);
        if (reconnectAttempts++ < MAX_RECONNECT_ATTEMPTS) setTimeout(() => { if (!isConnected) main(); }, 2000);
    }
}

reconnectBtn.addEventListener('click', reconnect);
disconnectBtn.addEventListener('click', () => { disconnect(); sessionStorage.removeItem('zephyr_ssh_params'); window.location.href = '/'; });
window.addEventListener('beforeunload', disconnect);

main();