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
const terminalThemeSelect = $('#terminalThemeSelect');

let term = null;
let wsConnection = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// ---------- 终端主题预设 ----------
const TERMINAL_THEMES = {
    default: {
        background: '#0a0a0a',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88,166,255,0.3)',
    },
    solarized: {
        background: '#002b36',
        foreground: '#839496',
        cursor: '#93a1a1',
        selectionBackground: 'rgba(131,148,150,0.3)',
    },
    monokai: {
        background: '#272822',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        selectionBackground: 'rgba(248,248,242,0.3)',
    },
    light: {
        background: '#f6f8fa',
        foreground: '#1f2328',
        cursor: '#0969da',
        selectionBackground: 'rgba(9,105,218,0.2)',
    },
};

function getSavedTerminalTheme() {
    return localStorage.getItem('zephyr-terminal-theme') || 'default';
}

function applyTerminalTheme(themeName) {
    const theme = TERMINAL_THEMES[themeName] || TERMINAL_THEMES.default;
    const root = wtermWrapper.querySelector('[data-wterm-root]');
    if (root) {
        root.style.backgroundColor = theme.background;
        root.style.color = theme.foreground;
        root.style.setProperty('--w-cursor-color', theme.cursor);
        root.style.setProperty('--w-selection-bg', theme.selectionBackground);
    }
    if (term && typeof term.setTheme === 'function') {
        term.setTheme(theme);
    }
    localStorage.setItem('zephyr-terminal-theme', themeName);
}

// ---------- 页面 UI 主题（亮/暗） ----------
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
    const text = selection.toString().trim();
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
        try { document.execCommand('copy'); copyBtn.textContent = '✅ 已复制'; } catch { copyBtn.textContent = '❌ 失败'; }
        document.body.removeChild(textarea);
    }
    setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
});

// ---------- 辅助键处理 ----------
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

wtermWrapper.addEventListener('click', () => {
    if (term && typeof term.focus === 'function') term.focus();
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
    const savedTermTheme = getSavedTerminalTheme();
    const initialTheme = TERMINAL_THEMES[savedTermTheme] || TERMINAL_THEMES.default;

    try {
        term = new WTermClass(wtermWrapper, {
            cols: 80,
            rows: 24,
            autoResize: true,
            cursorBlink: true,
            theme: initialTheme,
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

    // 应用主题选择器初始值
    terminalThemeSelect.value = savedTermTheme;
    applyTerminalTheme(savedTermTheme);

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

// ---------- WebSocket 连接 ----------
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/ssh`;
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('WebSocket 连接超时')); }, 10000);

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

// ---------- 主题切换事件 ----------
terminalThemeSelect.addEventListener('change', () => {
    applyTerminalTheme(terminalThemeSelect.value);
});

// ---------- 启动 ----------
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