const $ = (sel) => document.querySelector(sel);

// 读取连接参数
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

let wtermInstance = null;
let wsConnection = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// 状态更新
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

// 初始化 wterm
async function initWTerm() {
    let WTermClass;
    try {
        const wtermModule = await import('/vendor/@wterm/dom/dist/index.js');
        WTermClass = wtermModule.WTerm || wtermModule.default || wtermModule;
    } catch {
        try {
            const wtermModule = await import('/vendor/@wterm/dom/dist/wterm.js');
            WTermClass = wtermModule.WTerm || wtermModule.default || wtermModule;
        } catch (err2) {
            throw new Error('无法加载终端引擎 @wterm/dom，请检查 vendor 目录');
        }
    }
    if (!WTermClass) throw new Error('WTerm 类未找到');

    wtermWrapper.innerHTML = '';
    const termConfig = {
        element: wtermWrapper,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
        cursorBlink: true,
        theme: {
            background: '#0a0a0a',
            foreground: '#e6edf3',
            cursor: '#58a6ff',
            selectionBackground: 'rgba(88,166,255,0.3)',
        },
    };
    try {
        wtermInstance = new WTermClass(termConfig);
    } catch {
        wtermInstance = new WTermClass({ element: wtermWrapper });
    }

    const sendInput = (data) => {
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
            wsConnection.send(JSON.stringify({ type: 'input', data }));
        }
    };
    if (typeof wtermInstance.onData === 'function') {
        wtermInstance.onData(sendInput);
    } else if (typeof wtermInstance.on === 'function') {
        wtermInstance.on('data', sendInput);
    }

    const observeResize = () => {
        if (wtermInstance && typeof wtermInstance.getSize === 'function') {
            const size = wtermInstance.getSize();
            if (size && wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
                wsConnection.send(JSON.stringify({
                    type: 'resize',
                    rows: size.rows || size.lines || 24,
                    cols: size.cols || size.columns || 80,
                }));
            }
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

// WebSocket 连接
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/ssh`;
        const ws = new WebSocket(wsUrl);

        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket 连接超时（10秒）'));
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
                switch (msg.type) {
                    case 'ready':
                        setStatus('connected', '已连接');
                        if (wtermInstance && typeof wtermInstance.focus === 'function') wtermInstance.focus();
                        reconnectAttempts = 0;
                        resolve(ws);
                        break;
                    case 'data':
                        if (wtermInstance && typeof wtermInstance.write === 'function') wtermInstance.write(msg.data);
                        break;
                    case 'error':
                        setStatus('error', msg.message);
                        reject(new Error(msg.message));
                        break;
                    case 'close':
                        setStatus('disconnected', msg.message || '会话已关闭');
                        break;
                    case 'banner':
                        if (wtermInstance && typeof wtermInstance.write === 'function' && msg.data) wtermInstance.write(msg.data);
                        break;
                }
            } catch {}
        });

        ws.addEventListener('error', () => {
            clearTimeout(timeout);
        });

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
    if (wtermInstance) {
        try { if (typeof wtermInstance.destroy === 'function') wtermInstance.destroy(); } catch {}
        try { if (typeof wtermInstance.dispose === 'function') wtermInstance.dispose(); } catch {}
        wtermInstance = null;
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
    wtermInstance = null;
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