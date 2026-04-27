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

// DOM 元素
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
const cpuChartCanvas = $('#cpuChart');
const netChartCanvas = $('#netChart');

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

// 图表变量
let cpuChart = null;
let netChart = null;
const cpuData = [];
const netRxData = [];
const netTxData = [];
const chartLabels = [];

// --- 主题管理 ---
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

// --- 复制功能 ---
copyBtn.addEventListener('click', async () => {
    const selection = window.getSelection();
    const text = selection.toString();
    if (!text) return;
    const originalText = copyBtn.textContent;
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✅ 已复制';
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); copyBtn.textContent = '✅ 已复制'; }
        catch (e) { copyBtn.textContent = '❌ 失败'; }
        document.body.removeChild(textarea);
    }
    setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
});

// --- Ctrl+C 智能判断 ---
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'c') {
        const selection = window.getSelection();
        const text = selection.toString();
        if (text) return;
        e.preventDefault();
        sendData('\x03');
    }
});

// --- 文件管理器动画 ---
function showFileManager() {
    fileManager.classList.add('open');
    if (!sftpReady) {
        initSFTP();
    } else {
        refreshFileList();
    }
}

function hideFileManager() {
    fileManager.classList.remove('open');
}

fileBtn.addEventListener('click', () => {
    if (fileManager.classList.contains('open')) {
        hideFileManager();
    } else {
        showFileManager();
    }
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
    const path = fmPathInput.value.trim();
    if (path) navigateTo(path);
});

fmPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const path = fmPathInput.value.trim();
        if (path) navigateTo(path);
    }
});

fmBackBtn.addEventListener('click', () => {
    const parts = currentPath.replace(/\/+$/, '').split('/');
    parts.pop();
    const parent = parts.join('/') || '/';
    navigateTo(parent);
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

// 文件列表点击委托
fmList.addEventListener('click', (e) => {
    if (e.target.closest('.fm-item-actions')) return;
    const item = e.target.closest('.fm-item');
    if (!item) return;
    const fileName = item.dataset.fileName;
    const fileType = item.dataset.fileType;
    if (!fileName) return;
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + fileName;
    if (fileType === 'd') {
        navigateTo(fullPath);
    } else {
        openEditor(fullPath);
    }
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

        // 重命名
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

        // 删除
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

        // 下载（仅文件）
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
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + name;
    wsConnection.send(JSON.stringify({ type: 'sftp-mkdir', path: fullPath }));
});

// 新建文件
fmNewFileBtn.addEventListener('click', () => {
    const name = prompt('请输入文件名:');
    if (!name) return;
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + name;
    wsConnection.send(JSON.stringify({ type: 'sftp-touch', path: fullPath }));
});

// 上传文件
fmUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        const targetPath = currentPath.replace(/\/+$/, '') + '/' + file.name;
        wsConnection.send(JSON.stringify({ type: 'sftp-upload', path: targetPath, data: base64 }));
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
    const content = fmEditorTextarea.value;
    wsConnection.send(JSON.stringify({ type: 'sftp-writefile', path: editorFilePath, data: content }));
    fmEditorModal.style.display = 'none';
});

// --- 实时监控功能 ---
function initCharts() {
    if (cpuChart) return;
    cpuChart = new Chart(cpuChartCanvas, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [{
                label: 'CPU %',
                data: cpuData,
                borderColor: '#58a6ff',
                backgroundColor: 'rgba(88,166,255,0.1)',
                tension: 0.3,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, max: 100 } },
        }
    });
    netChart = new Chart(netChartCanvas, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [
                { label: '↓ Mbps', data: netRxData, borderColor: '#3fb950', tension: 0.3 },
                { label: '↑ Mbps', data: netTxData, borderColor: '#f85149', tension: 0.3 },
            ]
        },
        options: { responsive: true, maintainAspectRatio: false },
    });
}

infoBtn.addEventListener('click', () => {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        alert('请先连接 SSH');
        return;
    }
    infoModal.style.display = 'flex';
    initCharts();
    wsConnection.send(JSON.stringify({ type: 'start-monitor' }));
});

infoCloseBtn.addEventListener('click', () => {
    infoModal.style.display = 'none';
    wsConnection.send(JSON.stringify({ type: 'stop-monitor' }));
});

// 复制 IP 工具函数
function copyTextToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
}

function renderMonitorData(d) {
    const ipv4 = d.ipv4 || 'N/A';
    const ipv6 = d.ipv6 || 'N/A';
    infoBody.innerHTML = `
        <div class="card">
            <div class="card-title">🖥️ CPU <span style="float:right">${d.cpu}%</span></div>
            <div class="card-sub">${d.cpuModel} @ ${d.cpuFreq}</div>
        </div>
        <div style="display:flex;gap:8px">
            <div class="card" style="flex:1">
                <div class="card-title">🧠 RAM</div>
                <div>${d.ram || 'N/A'}</div>
            </div>
            <div class="card" style="flex:1">
                <div class="card-title">💾 Swap</div>
                <div>${d.swap || 'N/A'}</div>
            </div>
        </div>
        <div class="card">
            <div class="card-title">📦 磁盘</div>
            <div>${d.disk || 'N/A'}</div>
        </div>
        <div style="display:flex;gap:8px">
            <div class="card" style="flex:1">
                <div class="card-title">🌐 IPv4</div>
                <div class="ip-row">
                    <span>${ipv4}</span>
                    <button class="copy-ip-btn" onclick="copyTextToClipboard('${ipv4}')">📋</button>
                </div>
            </div>
            <div class="card" style="flex:1">
                <div class="card-title">🌐 IPv6</div>
                <div class="ip-row">
                    <span>${ipv6}</span>
                    <button class="copy-ip-btn" onclick="copyTextToClipboard('${ipv6}')">📋</button>
                </div>
            </div>
        </div>
        <div style="display:flex;gap:8px">
            <div class="card" style="flex:1">
                <div class="card-title">⬇️ 下载</div>
                <div>${d.rx} Mbps</div>
            </div>
            <div class="card" style="flex:1">
                <div class="card-title">⬆️ 上传</div>
                <div>${d.tx} Mbps</div>
            </div>
        </div>
    `;

    const now = new Date().toLocaleTimeString();
    chartLabels.push(now);
    cpuData.push(parseFloat(d.cpu) || 0);
    netRxData.push(parseFloat(d.rx) || 0);
    netTxData.push(parseFloat(d.tx) || 0);
    if (chartLabels.length > 30) {
        chartLabels.shift();
        cpuData.shift();
        netRxData.shift();
        netTxData.shift();
    }
    cpuChart.update();
    netChart.update();
}

// --- SFTP 消息处理 ---
function handleSFTPMessage(msg) {
    switch (msg.type) {
        case 'sftp-ready':
            sftpReady = true;
            refreshFileList();
            break;
        case 'sftp-list':
            if (msg.error) {
                alert('列出目录失败: ' + msg.error);
            } else {
                renderFileList(msg.files);
                currentPath = msg.path;
                fmPathInput.value = currentPath;
            }
            break;
        case 'sftp-mkdir':
        case 'sftp-touch':
        case 'sftp-delete':
        case 'sftp-rename':
        case 'sftp-upload':
            if (msg.success) {
                refreshFileList();
            } else {
                alert('操作失败: ' + (msg.error || '未知错误'));
            }
            break;
        case 'sftp-download':
            if (msg.error) {
                alert('下载失败: ' + msg.error);
            } else {
                const byteChars = atob(msg.data);
                const byteNums = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) {
                    byteNums[i] = byteChars.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNums);
                const blob = new Blob([byteArray]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = msg.path.split('/').pop();
                a.click();
                URL.revokeObjectURL(url);
            }
            break;
        case 'sftp-readfile':
            if (msg.error) {
                alert('读取文件失败: ' + msg.error);
            } else {
                fmEditorTextarea.value = msg.data;
            }
            break;
        case 'sftp-writefile':
            if (msg.success) {
                refreshFileList();
            } else {
                alert('保存失败: ' + (msg.error || '未知错误'));
            }
            break;
        case 'sftp-error':
            alert('SFTP 错误: ' + msg.message);
            sftpReady = false;
            break;
    }
}

// --- 辅助键处理 ---
const modifierState = { ctrl: false, alt: false, shift: false };
const modifierButtons = document.querySelectorAll('.modifier');

function updateModifierUI() {
    modifierButtons.forEach(btn => {
        const key = btn.dataset.key;
        btn.classList.toggle('active', modifierState[key]);
    });
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
        const processed = processModifiers(data);
        wsConnection.send(JSON.stringify({ type: 'input', data: processed }));
    }
}

function sendCommand() {
    const text = cmdInput.value;
    if (text && wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        sendData(text + '\r\n');
    }
    cmdInput.value = '';
}

cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendCommand();
    }
});

cmdSendBtn.addEventListener('click', sendCommand);

document.querySelectorAll('.func, .arrow, .combo, .modifier').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (btn.classList.contains('modifier')) {
            modifierState[key] = !modifierState[key];
            updateModifierUI();
            return;
        }
        if (keySequences[key]) { sendData(keySequences[key]); return; }
        if (comboSequences[key]) { sendData(comboSequences[key]); return; }
    });
});

const keySequences = {
    esc: '\x1b', tab: '\t', home: '\x1b[1~', end: '\x1b[4~',
    up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
};

const comboSequences = {
    'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-l': '\x0c', 'ctrl-u': '\x15',
};

// 保留选区
wtermWrapper.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) {
        term?.focus?.();
    }
});

// --- 状态指示 ---
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

// --- WTerm 初始化 ---
async function initWTerm() {
    console.log('[Zephyr] 开始加载 WTerm 模块...');
    let WTermClass;
    try {
        const module = await import('/vendor/@wterm/dom/dist/index.js');
        WTermClass = module.WTerm;
    } catch (e) {
        console.error('[Zephyr] 主入口加载失败，尝试直接导入 wterm.js:', e);
        try {
            const module = await import('/vendor/@wterm/dom/dist/wterm.js');
            WTermClass = module.WTerm || module.default;
        } catch (e2) {
            throw new Error('无法加载 WTerm 模块：' + e2.message);
        }
    }
    if (!WTermClass) throw new Error('WTerm 类未找到');

    wtermWrapper.innerHTML = '';

    try {
        term = new WTermClass(wtermWrapper, {
            cols: 80,
            rows: 24,
            autoResize: true,
            cursorBlink: true,
            onData: (data) => { sendData(data); },
        });
    } catch (e) {
        console.warn('[Zephyr] 完整配置失败，使用最小配置:', e);
        term = new WTermClass(wtermWrapper);
        if (typeof term.onData === 'function') {
            term.onData((data) => sendData(data));
        } else if (typeof term.on === 'function') {
            term.on('data', (data) => sendData(data));
        }
    }

    if (typeof term.init === 'function') {
        await term.init();
        console.log('[Zephyr] WASM 初始化完成');
    }

    const observeResize = () => {
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
            const rect = wtermWrapper.getBoundingClientRect();
            const cols = Math.floor(rect.width / 7.2);
            const rows = Math.floor(rect.height / 17);
            wsConnection.send(JSON.stringify({ type: 'resize', rows, cols }));
        }
    };
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            clearTimeout(ro._timer);
            ro._timer = setTimeout(observeResize, 150);
        });
        ro.observe(wtermWrapper);
    }
    window.addEventListener('resize', observeResize);
    console.log('[Zephyr] wterm 终端初始化完成');
}

// --- WebSocket 连接 ---
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/ssh`;
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket 连接超时'));
        }, 10000);

        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            ws.send(JSON.stringify({
                type: 'connect',
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password || '',
                privateKey: params.privateKey || '',
                init: params.init || '',
            }));
        });

        ws.addEventListener('message', (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type && msg.type.startsWith('sftp-')) {
                    handleSFTPMessage(msg);
                    return;
                }
                if (msg.type === 'monitor-data') {
                    renderMonitorData(msg.data);
                    return;
                }
                switch (msg.type) {
                    case 'ready':
                        setStatus('connected', '已连接');
                        if (term && typeof term.focus === 'function') term.focus();
                        reconnectAttempts = 0;
                        resolve(ws);
                        break;
                    case 'data':
                        if (term && typeof term.write === 'function') term.write(msg.data);
                        break;
                    case 'error':
                        setStatus('error', msg.message);
                        reject(new Error(msg.message));
                        break;
                    case 'close':
                        setStatus('disconnected', msg.message || '会话已关闭');
                        break;
                    case 'banner':
                        if (term && typeof term.write === 'function' && msg.data) term.write(msg.data);
                        break;
                }
            } catch {}
        });

        ws.addEventListener('error', () => clearTimeout(timeout));
        ws.addEventListener('close', (event) => {
            clearTimeout(timeout);
            wsConnection = null;
            if (isConnected) setStatus('disconnected', `连接已断开 (${event.code || '未知'})`);
            cleanupWTerm();
        });

        wsConnection = ws;
    });
}

function cleanupWTerm() {
    if (term) {
        try { if (typeof term.destroy === 'function') term.destroy(); } catch {}
        term = null;
    }
}

function disconnect() {
    if (wsConnection) {
        try { wsConnection.send(JSON.stringify({ type: 'disconnect' })); } catch {}
        wsConnection.close(1000, '用户主动断开');
        wsConnection = null;
    }
    cleanupWTerm();
    setStatus('disconnected', '已断开');
    isConnected = false;
}

async function reconnect() {
    disconnect();
    cleanupWTerm();
    reconnectAttempts = 0;
    wtermWrapper.innerHTML = '';
    setStatus('connecting', '正在重新连接...');
    try {
        await initWTerm();
        await connectWebSocket();
    } catch (err) {
        setStatus('error', err.message || '重连失败');
    }
}

async function main() {
    setStatus('connecting', '正在初始化终端...');
    try {
        await initWTerm();
        await connectWebSocket();
    } catch (err) {
        setStatus('error', err.message || '初始化失败');
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            setTimeout(() => { if (!isConnected) main(); }, reconnectAttempts * 1000);
        }
    }
}

reconnectBtn.addEventListener('click', reconnect);
disconnectBtn.addEventListener('click', () => {
    disconnect();
    sessionStorage.removeItem('zephyr_ssh_params');
    window.location.href = '/';
});
window.addEventListener('beforeunload', disconnect);

main();