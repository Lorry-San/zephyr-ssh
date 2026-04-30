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
const fmEditorUndoBtn = $('#fmEditorUndoBtn');
const fmEditorRedoBtn = $('#fmEditorRedoBtn');
const fmEditorEncoding = $('#fmEditorEncoding');
const fmEditorLineEnding = $('#fmEditorLineEnding');
const fmEditorTabSize = $('#fmEditorTabSize');
const fmEditorWrap = $('#fmEditorWrap');
const fmEditorStatus = $('#fmEditorStatus');

// 监控相关 DOM
const infoModal = $('#infoModal');
const infoCloseBtn = $('#infoCloseBtn');
const infoBody = $('#infoBody');

// ---------- 全局变量 ----------
let term = null;
let wsConnection = null;
let isConnected = false;
let sftpReady = false;
let currentPath = '.';
let allFiles = [];
let searchQuery = '';
let editorFilePath = null;
let editorRawBytes = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// 图表实例管理
let chartInstances = {};
let shouldAutoScroll = true;
let terminalScrollRaf = 0;
let terminalScrollRetryTimer = 0;
let terminalScrollListeners = [];
let terminalMutationObserver = null;
let terminalResizeObserver = null;
let isProgrammaticScroll = false;

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
    fileBtn.classList.add('active');
    if (!sftpReady) {
        initSFTP();
    } else {
        refreshFileList();
    }
}
function hideFileManager() {
    fileManager.classList.remove('open');
    fileBtn.classList.remove('active');
}
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
function base64ToBytes(base64) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function decodeBytes(bytes, encoding) {
    if (!bytes) return '';
    if (encoding === 'utf-16be') {
        const swapped = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 2) {
            swapped[i] = bytes[i + 1] || 0;
            swapped[i + 1] = bytes[i] || 0;
        }
        return new TextDecoder('utf-16le').decode(swapped);
    }
    const decoderEncoding = encoding === 'latin1' ? 'iso-8859-1' : encoding;
    return new TextDecoder(decoderEncoding).decode(bytes);
}

function encodeText(text, encoding) {
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
        const bytes = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            const offset = i * 2;
            if (encoding === 'utf-16le') {
                bytes[offset] = code & 0xff;
                bytes[offset + 1] = code >> 8;
            } else {
                bytes[offset] = code >> 8;
                bytes[offset + 1] = code & 0xff;
            }
        }
        return bytes;
    }
    if (encoding === 'latin1') {
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return bytes;
    }
    return new TextEncoder().encode(text);
}

function detectEncoding(bytes) {
    if (!bytes || bytes.length < 2) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return 'utf-8';
}

function detectLineEnding(text) {
    return /\r\n/.test(text) ? 'crlf' : 'lf';
}

function normalizeLineEnding(text, lineEnding) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return lineEnding === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function updateEditorStatus() {
    const text = fmEditorTextarea.value || '';
    const lines = text.length ? text.split(/\r\n|\r|\n/).length : 1;
    fmEditorStatus.textContent = `${lines} 行 · ${text.length} 字符 · ${editorRawBytes?.length || 0} bytes`;
}

function applyEditorOptions() {
    fmEditorTextarea.wrap = fmEditorWrap.checked ? 'soft' : 'off';
    fmEditorTextarea.style.tabSize = fmEditorTabSize.value;
}

function loadEditorFromBytes(bytes, encoding = fmEditorEncoding.value) {
    editorRawBytes = bytes;
    let text = decodeBytes(bytes, encoding);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    fmEditorTextarea.value = text;
    fmEditorLineEnding.value = detectLineEnding(text);
    applyEditorOptions();
    updateEditorStatus();
}

function openEditor(filePath) {
    editorFilePath = filePath;
    fmEditorModal.style.display = 'flex';
    fmEditorTitle.textContent = `编辑: ${filePath}`;
    fmEditorStatus.textContent = '读取中...';
    fmEditorTextarea.value = '';
    wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path: filePath }));
}
fmEditorCloseBtn.addEventListener('click', () => { fmEditorModal.style.display = 'none'; });
fmEditorCancelBtn.addEventListener('click', () => { fmEditorModal.style.display = 'none'; });
fmEditorUndoBtn.addEventListener('click', () => {
    fmEditorTextarea.focus();
    document.execCommand('undo');
    updateEditorStatus();
});
fmEditorRedoBtn.addEventListener('click', () => {
    fmEditorTextarea.focus();
    document.execCommand('redo');
    updateEditorStatus();
});
fmEditorSaveBtn.addEventListener('click', () => {
    if (!editorFilePath) return;
    const text = normalizeLineEnding(fmEditorTextarea.value, fmEditorLineEnding.value);
    const bytes = encodeText(text, fmEditorEncoding.value);
    wsConnection.send(JSON.stringify({
        type: 'sftp-writefile',
        path: editorFilePath,
        data: bytesToBase64(bytes),
        encoding: 'base64',
    }));
    fmEditorModal.style.display = 'none';
});
fmEditorEncoding.addEventListener('change', () => {
    if (editorRawBytes) loadEditorFromBytes(editorRawBytes, fmEditorEncoding.value);
});
fmEditorLineEnding.addEventListener('change', updateEditorStatus);
fmEditorTabSize.addEventListener('change', applyEditorOptions);
fmEditorWrap.addEventListener('change', applyEditorOptions);
fmEditorTextarea.addEventListener('input', updateEditorStatus);
fmEditorTextarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const tab = ' '.repeat(Number(fmEditorTabSize.value) || 4);
    const { selectionStart, selectionEnd, value } = fmEditorTextarea;
    fmEditorTextarea.value = value.slice(0, selectionStart) + tab + value.slice(selectionEnd);
    fmEditorTextarea.selectionStart = fmEditorTextarea.selectionEnd = selectionStart + tab.length;
    updateEditorStatus();
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
            if (msg.error) {
                alert('读取失败: ' + msg.error);
                fmEditorStatus.textContent = '读取失败';
            } else {
                const bytes = msg.encoding === 'base64' ? base64ToBytes(msg.data) : new TextEncoder().encode(msg.data || '');
                fmEditorEncoding.value = detectEncoding(bytes);
                loadEditorFromBytes(bytes, fmEditorEncoding.value);
            }
            break;
        case 'sftp-writefile':
            if (msg.success) { refreshFileList(); fmEditorModal.style.display = 'none'; } else alert('保存失败: ' + (msg.error || '未知错误'));
            break;
        case 'sftp-error': alert('SFTP 错误: ' + msg.message); sftpReady = false; break;
    }
}

// ---------- 监控面板 ----------
function safeVal(val, fallback = 0) {
    return (val != null && !isNaN(val)) ? val : fallback;
}

function destroyCharts() {
    Object.values(chartInstances).forEach(chart => {
        try { chart.destroy(); } catch (_) {}
    });
    chartInstances = {};
}

// 自定义插件：环形图中心显示百分比
const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
        const { ctx, chartArea, config: { type } } = chart;
        if (type !== 'doughnut' || !chartArea) return;
        const { left, top, right, bottom } = chartArea;
        if ([left, top, right, bottom].some((v) => typeof v !== 'number' || isNaN(v))) return;
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2 + (bottom - top) * 0.05;
        const value = chart.data.datasets[0].data[0] || 0;
        ctx.save();
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e6edf3';
        ctx.font = 'bold 18px "JetBrains Mono", "Fira Code", monospace';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(value)}%`, centerX, centerY);
        ctx.restore();
    }
};

function initCharts() {
    destroyCharts();

    const commonDoughnut = {
        type: 'doughnut',
        data: { datasets: [{ data: [0, 100], backgroundColor: ['#3fb950', 'rgba(139,148,158,0.25)'], borderWidth: 0 }] },
        options: {
            circumference: 270,
            rotation: 225,
            cutout: '80%',
            responsive: true,
            maintainAspectRatio: true,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        },
        plugins: [centerTextPlugin]
    };

    const commonLine = {
        type: 'line',
        data: { labels: Array(20).fill(''), datasets: [{ data: Array(20).fill(0), borderWidth: 1.5, pointRadius: 0, tension: 0.2 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } }
        }
    };

    document.querySelectorAll('.doughnut-wrap canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        chartInstances[id] = new Chart(canvas, commonDoughnut);
    });

    document.querySelectorAll('.sparkline-row canvas, .line-canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        const color = canvas.dataset.color || '#3fb950';
        const config = JSON.parse(JSON.stringify(commonLine));
        config.data.datasets[0].borderColor = color;
        config.data.datasets[0].fill = false;
        chartInstances[id] = new Chart(canvas, config);
    });
}

function updateDoughnut(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const p = Math.min(100, Math.max(0, safeVal(value)));
    if (chart.data.datasets[0].data[0] === p) return; // 无变化不更新
    chart.data.datasets[0].data = [p, 100 - p];
    const color = p < 50 ? '#3fb950' : p < 80 ? '#d2991d' : '#f85149';
    chart.data.datasets[0].backgroundColor = [color, 'rgba(139,148,158,0.25)'];
    chart.update('none');
}

function updateLine(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const data = chart.data.datasets[0].data;
    data.push(safeVal(value));
    if (data.length > 20) data.shift();
    chart.update('none');
}

function getTerminalScrollElement() {
    // @wterm/dom 的真实滚动容器是渲染后的 DOM 根节点。
    // 优先使用它，避免混用内部 viewport API 造成高频输出时滚动抖动。
    const root = wtermWrapper.querySelector('[data-wterm-root]');
    if (root) return root;
    if (term?._core?.viewport?.element) return term._core.viewport.element;
    return wtermWrapper;
}

function getTerminalBottomDistance(el = getTerminalScrollElement()) {
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isTerminalAtBottom(el = getTerminalScrollElement(), threshold = 48) {
    if (!el) return true;
    return getTerminalBottomDistance(el) <= threshold;
}

function scrollTerminalToBottom() {
    if (!shouldAutoScroll) return;
    try {
        const el = getTerminalScrollElement();
        if (el) {
            isProgrammaticScroll = true;
            el.scrollTop = el.scrollHeight;
        }
    } catch (_) {
        // 兼容兜底：如果后续 wterm 暴露稳定的公开滚动 API，则仍可使用。
        try { term?.scrollToBottom?.(); } catch (_) {}
        try { term?._core?.viewport?.scrollToBottom?.(); } catch (_) {}
    } finally {
        requestAnimationFrame(() => { isProgrammaticScroll = false; });
    }
}

function clearTerminalAutoScrollTimers() {
    if (terminalScrollRaf) {
        cancelAnimationFrame(terminalScrollRaf);
        terminalScrollRaf = 0;
    }
    if (terminalScrollRetryTimer) {
        clearTimeout(terminalScrollRetryTimer);
        terminalScrollRetryTimer = 0;
    }
}

function scheduleTerminalScrollToBottom({ retry = true } = {}) {
    if (!shouldAutoScroll || terminalScrollRaf) return;
    terminalScrollRaf = requestAnimationFrame(() => {
        terminalScrollRaf = 0;
        scrollTerminalToBottom();

        // wterm 写 DOM 可能分批完成，补一次短延迟即可覆盖边界换行/大量输出，
        // 不使用 setInterval 或 smooth scroll，避免“一抽一抽”。
        if (retry && shouldAutoScroll && !terminalScrollRetryTimer) {
            terminalScrollRetryTimer = window.setTimeout(() => {
                terminalScrollRetryTimer = 0;
                scrollTerminalToBottom();
            }, 32);
        }
    });
}

function stopTerminalAutoScrollObserver() {
    clearTerminalAutoScrollTimers();
    terminalScrollListeners.forEach(({ el, handler }) => el.removeEventListener('scroll', handler));
    terminalScrollListeners = [];

    if (terminalMutationObserver) {
        terminalMutationObserver.disconnect();
        terminalMutationObserver = null;
    }
    if (terminalResizeObserver) {
        terminalResizeObserver.disconnect();
        terminalResizeObserver = null;
    }
}

function setupTerminalScrollHooks() {
    stopTerminalAutoScrollObserver();
    shouldAutoScroll = true;

    const scrollEl = getTerminalScrollElement();
    const scrollTargets = [...new Set([scrollEl, wtermWrapper].filter(Boolean))];
    scrollTargets.forEach((el) => {
        const handler = () => {
            if (isProgrammaticScroll) return;
            shouldAutoScroll = isTerminalAtBottom(scrollEl);
        };
        el.addEventListener('scroll', handler, { passive: true });
        terminalScrollListeners.push({ el, handler });
    });

    if (window.MutationObserver && scrollEl) {
        terminalMutationObserver = new MutationObserver(() => scheduleTerminalScrollToBottom({ retry: false }));
        terminalMutationObserver.observe(scrollEl, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    if (window.ResizeObserver && scrollEl) {
        terminalResizeObserver = new ResizeObserver(() => scheduleTerminalScrollToBottom());
        terminalResizeObserver.observe(scrollEl);
    }

    scheduleTerminalScrollToBottom();
}

function renderStats(d) {
    const cpuUsage = safeVal(d.cpu?.usage);
    const memUsedGB = (safeVal(d.memUsed) / 1024).toFixed(1);
    const memTotalGB = (safeVal(d.memTotal) / 1024).toFixed(1);
    const swapUsedGB = (safeVal(d.swapUsed) / 1024).toFixed(1);
    const swapTotalGB = (safeVal(d.swapTotal) / 1024).toFixed(1);
    const rxMbps = safeVal(d.net?.rx).toFixed(1);
    const txMbps = safeVal(d.net?.tx).toFixed(1);
    const ipv4 = d.ip?.ipv4 || 'N/A';
    const ipv6 = d.ip?.ipv6 || 'N/A';
    const hostName = d.host?.hostname || 'N/A';
    const hostOS = d.host?.os || 'N/A';
    const diskDevices = Array.isArray(d.disk?.devices) ? d.disk.devices : [];
    const diskDeviceCards = diskDevices.map(device => `
        <div class="doughnut-item disk-card">
            <div class="disk-card-meta">
                <div class="doughnut-label">${device.mountpoint}</div>
                <div class="doughnut-text">${device.usedGB} / ${device.totalGB} GB</div>
                <div class="doughnut-sub">${device.filesystem}</div>
                <div class="doughnut-sub">已用 ${device.usageLabel}</div>
                <div class="doughnut-sub">读 ${device.readKBps} KB/s · 写 ${device.writeKBps} KB/s</div>
            </div>
            <div class="doughnut-wrap"><canvas id="${device.id}"></canvas></div>
        </div>
    `).join('');

    infoBody.innerHTML = `
        <div class="doughnut-row">
            <div class="doughnut-item disk-card full-width">
                <div class="disk-card-meta">
                    <div class="doughnut-label">CPU</div>
                    <div class="doughnut-text">${d.cpu?.model || 'N/A'}</div>
                    <div class="doughnut-sub">${d.cpu?.freq || 'N/A'}</div>
                    <div class="doughnut-sub">${d.cpu?.cores || 0} 核心</div>
                </div>
                <div class="doughnut-wrap"><canvas id="cpuDoughnut"></canvas></div>
            </div>
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">内存</div>
                <div class="doughnut-wrap"><canvas id="ramDoughnut"></canvas></div>
                <div class="doughnut-text">${memUsedGB} / ${memTotalGB} GB</div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">Swap</div>
                <div class="doughnut-wrap"><canvas id="swapDoughnut"></canvas></div>
                <div class="doughnut-text">${swapUsedGB} / ${swapTotalGB} GB</div>
            </div>
        </div>
        <div class="doughnut-row disk-card-row">
            ${diskDeviceCards}
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">下载</div>
                <div class="doughnut-text">${rxMbps} Mbps</div>
                <div class="sparkline-row">
                    <canvas id="rxLine" data-color="#3fb950" class="line-canvas" height="30"></canvas>
                </div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">上传</div>
                <div class="doughnut-text">${txMbps} Mbps</div>
                <div class="sparkline-row">
                    <canvas id="txLine" data-color="#58a6ff" class="line-canvas" height="30"></canvas>
                </div>
            </div>
        </div>
        <div class="ip-section">
            <div class="ip-box"><span>IPv4</span><code>${ipv4}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${ipv4}')">📋</button></div>
            <div class="ip-box"><span>IPv6</span><code>${ipv6}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${ipv6}')">📋</button></div>
        </div>
    `;

    initCharts();

    updateDoughnut('cpuDoughnut', cpuUsage);
    updateDoughnut('ramDoughnut', (safeVal(d.memUsed) / safeVal(d.memTotal)) * 100);
    updateDoughnut('swapDoughnut', safeVal(d.swapTotal) ? (safeVal(d.swapUsed) / safeVal(d.swapTotal)) * 100 : 0);
    diskDevices.forEach(device => updateDoughnut(device.id, device.percent));

    updateLine('rxLine', rxMbps);
    updateLine('txLine', txMbps);
}

function showInfoModal() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        alert('请先连接 SSH');
        return;
    }
    infoModal.style.display = 'flex';
    // display 从 none 切换为 flex 后，下一帧再加 open，确保浏览器能播放开启动画。
    requestAnimationFrame(() => {
        infoModal.classList.add('open');
        infoBtn.classList.add('active');
    });
}

function hideInfoModal() {
    infoModal.classList.remove('open');
    infoBtn.classList.remove('active');
    window.setTimeout(() => {
        if (!infoModal.classList.contains('open')) {
            infoModal.style.display = 'none';
        }
    }, 280);
}

function toggleInfoModal() {
    if (infoModal.classList.contains('open')) hideInfoModal();
    else showInfoModal();
}

infoBtn.addEventListener('click', toggleInfoModal);

infoCloseBtn.addEventListener('click', hideInfoModal);

// ---------- 浮动面板拖动 / 缩放 ----------
const panelState = new WeakMap();

function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panelState.has(panel)) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const width = defaults.width || Math.min(parentRect.width * 0.72, 760);
    const height = defaults.height || Math.min(parentRect.height * 0.72, 560);
    const left = defaults.left ?? Math.max(12, (parentRect.width - width) / 2);
    const top = defaults.top ?? 52;

    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    panelState.set(panel, { left, top, width, height });
}

function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function bringPanelToFront(panel) {
    document.querySelectorAll('.file-manager, .info-modal').forEach((p) => p.classList.remove('front'));
    panel.classList.add('front');
}

function setupFloatingPanel(panel, options) {
    ensureFloatingPanel(panel, options);
    panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
}

function setupPanelDrag() {
    document.querySelectorAll('[data-drag-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.dragPanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button,input,select,textarea,label')) return;
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;

            const onMove = (ev) => {
                panel.style.left = `${startLeft + ev.clientX - startX}px`;
                panel.style.top = `${startTop + ev.clientY - startY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const minWidth = Number(getComputedStyle(panel).minWidth.replace('px', '')) || 420;
            const minHeight = Number(getComputedStyle(panel).minHeight.replace('px', '')) || 320;

            const onMove = (ev) => {
                let nextLeft = startLeft;
                let nextWidth = startWidth + ev.clientX - startX;
                if (edge === 'left') {
                    nextWidth = startWidth - (ev.clientX - startX);
                    nextLeft = startLeft + (ev.clientX - startX);
                    if (nextWidth < minWidth) {
                        nextLeft -= minWidth - nextWidth;
                        nextWidth = minWidth;
                    }
                    if (nextLeft < 8) {
                        nextWidth += nextLeft - 8;
                        nextLeft = 8;
                    }
                    panel.style.left = `${nextLeft}px`;
                }
                const maxWidth = edge === 'left' ? startLeft + startWidth - 8 : parentRect.width - panel.offsetLeft - 12;
                const maxHeight = parentRect.height - panel.offsetTop - 12;
                const width = Math.min(Math.max(minWidth, nextWidth), maxWidth);
                const height = Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight);
                panel.style.width = `${width}px`;
                panel.style.height = `${height}px`;
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

setupFloatingPanel(fileManager, { width: Math.min(window.innerWidth * 0.72, 820), height: Math.min(window.innerHeight * 0.68, 620), left: 16, top: 52 });
setupFloatingPanel(infoModal, { width: 480, height: Math.min(window.innerHeight * 0.72, 620), top: 52 });
setupPanelDrag();
setupPanelResize();
window.addEventListener('resize', () => {
    [fileManager, infoModal].forEach((panel) => panel && clampPanel(panel));
});

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
    setupTerminalScrollHooks();
}

// ---------- WebSocket 连接 ----------
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ssh`);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('连接超时')); }, 10000);

        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            ws.send(JSON.stringify({
                type: 'connect',
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password || '',
                privateKey: params.privateKey || '',
                init: params.init || ''
            }));
        });

        ws.addEventListener('message', (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'stats') { renderStats(msg.data); return; }
                if (msg.type?.startsWith('sftp-')) { handleSFTPMessage(msg); return; }
                switch (msg.type) {
                    case 'ready':
                        setStatus('connected', '已连接');
                        if (term?.focus) term.focus();
                        reconnectAttempts = 0;
                        resolve(ws);
                        break;
                    case 'data':
                        if (term?.write) {
                            const nearBottom = isTerminalAtBottom();
                            term.write(msg.data);
                            if (nearBottom) scheduleTerminalScrollToBottom();
                        }
                        break;
                    case 'error':
                        setStatus('error', msg.message);
                        reject(new Error(msg.message));
                        break;
                    case 'close':
                        setStatus('disconnected', msg.message || '会话已关闭');
                        break;
                    case 'banner':
                        if (term?.write) term.write(msg.data);
                        break;
                }
            } catch (_) {}
        });

        ws.addEventListener('error', () => clearTimeout(timeout));
        ws.addEventListener('close', (e) => {
            clearTimeout(timeout);
            wsConnection = null;
            if (isConnected) setStatus('disconnected', `断开 (${e.code})`);
            if (term) { try { term.destroy?.(); } catch (_) {} term = null; }
        });

        wsConnection = ws;
    });
}

function disconnect() {
    if (wsConnection) {
        try { wsConnection.send(JSON.stringify({ type: 'disconnect' })); } catch (_) {}
        wsConnection.close(1000, '用户主动断开');
        wsConnection = null;
    }
    stopTerminalAutoScrollObserver();
    if (term) { try { term.destroy?.(); } catch (_) {} term = null; }
    setStatus('disconnected', '已断开');
    isConnected = false;
}

async function reconnect() {
    disconnect();
    wtermWrapper.innerHTML = '';
    reconnectAttempts = 0;
    setStatus('connecting', '正在重连...');
    try {
        await initWTerm();
        await connectWebSocket();
    } catch (err) {
        setStatus('error', err.message);
    }
}

async function main() {
    setStatus('connecting', '正在初始化终端...');
    try {
        await initWTerm();
        await connectWebSocket();
    } catch (err) {
        setStatus('error', err.message);
        if (reconnectAttempts++ < MAX_RECONNECT_ATTEMPTS) {
            setTimeout(() => { if (!isConnected) main(); }, 2000);
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