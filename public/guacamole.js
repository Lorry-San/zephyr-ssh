const $ = (sel) => document.querySelector(sel);

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const overlay = $('#guacOverlay');
const overlayMsg = $('#overlayMsg');
const stage = $('#guacStage');
const displayRoot = $('#display');
const displayShell = $('#displayShell');
const fitBtn = $('#fitBtn');
const clipboardBtn = $('#clipboardBtn');
const ctrlAltDelBtn = $('#ctrlAltDelBtn');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');

const urlParams = new URLSearchParams(location.search);
const tabId = urlParams.get('tabId') || '';
const embeddedMode = urlParams.get('embed') === '1';

let params = loadParams();
let Guacamole = null;
let tunnel = null;
let client = null;
let keyboard = null;
let mouse = null;
let connected = false;
let fitToWindow = true;
let displayWidth = 0;
let displayHeight = 0;
let resizeTimer = 0;

function loadParams() {
    const key = tabId ? `zephyr_guac_params_${tabId}` : 'zephyr_guac_params';
    try {
        return JSON.parse(sessionStorage.getItem(key) || '{}');
    } catch {
        return {};
    }
}

function protocolLabel() {
    return String(params?.protocol || 'VNC').toUpperCase() === 'RDP' ? 'RDP' : 'VNC';
}

function protocolDefaultPort() {
    return protocolLabel() === 'RDP' ? 3389 : 5900;
}

function notifyParentStatus(status) {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId || tabId, status }, '*');
    }
}

function notifyParentActivity() {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'activity', tabId: params?.tabId || tabId }, '*');
    }
}

function setStatus(state, message = '') {
    const label = protocolLabel();
    notifyParentStatus(state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'closed' : 'connecting');
    statusDot.className = 'status-dot';
    if (state === 'connected') {
        connected = true;
        statusDot.classList.add('connected');
        statusText.textContent = message || `${label} 已连接`;
        overlay.classList.add('hidden');
    } else if (state === 'error') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusText.textContent = '错误';
        overlayMsg.textContent = message || `${label} 连接失败`;
        overlay.classList.remove('hidden');
    } else if (state === 'disconnected') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusText.textContent = message || '已断开';
        overlayMsg.textContent = message || `${label} 连接已断开`;
        overlay.classList.remove('hidden');
    } else {
        connected = false;
        statusText.textContent = message || '连接中...';
        overlayMsg.textContent = message || `正在建立 ${label} 连接...`;
        overlay.classList.remove('hidden');
    }
}

function encodeInstruction(opcode, ...args) {
    return [opcode, ...args].map((value) => {
        const text = String(value ?? '');
        return `${text.length}.${text}`;
    }).join(',') + ';';
}

class GuacInstructionParser {
    constructor(oninstruction) {
        this.buffer = '';
        this.elements = [];
        this.oninstruction = oninstruction;
    }

    receive(data) {
        this.buffer += String(data || '');
        while (this.buffer.length) {
            const lengthEnd = this.buffer.indexOf('.');
            if (lengthEnd === -1) return;

            const lengthText = this.buffer.slice(0, lengthEnd);
            if (!/^\d+$/.test(lengthText)) throw new Error('非法 Guacamole 指令长度');
            const length = Number.parseInt(lengthText, 10);
            const elementStart = lengthEnd + 1;
            const elementEnd = elementStart + length;
            if (this.buffer.length <= elementEnd) return;

            const terminator = this.buffer[elementEnd];
            if (terminator !== ',' && terminator !== ';') throw new Error('非法 Guacamole 指令终止符');

            this.elements.push(this.buffer.slice(elementStart, elementEnd));
            this.buffer = this.buffer.slice(elementEnd + 1);

            if (terminator === ';') {
                const opcode = this.elements.shift();
                const args = this.elements;
                this.elements = [];
                if (opcode) this.oninstruction?.(opcode, args);
            }
        }
    }
}

class RawGuacWebSocketTunnel {
    constructor(url) {
        this.url = url;
        this.uuid = '';
        this.state = 2;
        this.oninstruction = null;
        this.onstatechange = null;
        this.onerror = null;
        this.socket = null;
        this.parser = new GuacInstructionParser((opcode, args) => {
            console.debug('[guac-client]', 'instruction', { opcode, argCount: args.length });
            if (opcode === 'ready') {
                this.uuid = args[0] || `zephyr-${Date.now()}`;
                console.info('[guac-client]', 'tunnel ready', { uuid: this.uuid });
                this.setState(1);
                return;
            }
            if (opcode === 'error') {
                const err = new Error(args[0] || 'Guacamole 隧道错误');
                err.code = args[1] || '';
                this.onerror?.(err);
                return;
            }
            this.oninstruction?.(opcode, args);
        });
    }

    setState(state) {
        this.state = state;
        this.onstatechange?.(state);
    }

    connect() {
        if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
        this.setState(0);
        this.socket = new WebSocket(this.url);
        this.socket.binaryType = 'arraybuffer';

        this.socket.addEventListener('open', () => {
            console.info('[guac-client]', 'websocket open; waiting for server ready', { url: this.url });
        });

        this.socket.addEventListener('message', (event) => {
            try {
                const data = typeof event.data === 'string'
                    ? event.data
                    : new TextDecoder().decode(event.data);
                this.parser.receive(data);
            } catch (err) {
                console.error('[guac-client]', 'parse instruction failed', err);
                this.onerror?.(err);
            }
        });

        this.socket.addEventListener('close', (event) => {
            console.info('[guac-client]', 'websocket closed', { code: event.code, reason: event.reason });
            this.setState(2);
        });

        this.socket.addEventListener('error', () => {
            const err = new Error(`${protocolLabel()} WebSocket 隧道异常`);
            console.error('[guac-client]', err.message);
            this.onerror?.(err);
        });
    }

    disconnect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try { this.sendMessage('disconnect'); } catch {}
            this.socket.close();
        }
        this.setState(2);
    }

    sendMessage(opcode, ...args) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const payload = encodeInstruction(opcode, ...args);
        console.debug('[guac-client]', 'send instruction', { opcode, bytes: payload.length });
        this.socket.send(payload);
    }
}

async function loadGuacamole() {
    if (Guacamole) return Guacamole;
    const sources = [
        '/vendor/guacamole-common-js/guacamole-common.min.js',
        '/vendor/guacamole-common-js/guacamole-common.js',
        'https://cdn.jsdelivr.net/npm/guacamole-common-js@1.5.0/dist/esm/guacamole-common.min.js',
        'https://unpkg.com/guacamole-common-js@1.5.0/dist/esm/guacamole-common.min.js',
        'https://cdn.jsdelivr.net/npm/guacamole-common-js@1.5.0/dist/esm/guacamole-common.js',
    ];
    let lastError = null;
    for (const source of sources) {
        try {
            const mod = await import(source);
            Guacamole = mod.default || mod.Guacamole || mod;
            if (Guacamole?.Client) {
                console.info('[guac-client]', 'guacamole-common-js loaded', { source });
                return Guacamole;
            }
        } catch (err) {
            lastError = err;
            console.warn('[guac-client]', 'failed to load guacamole-common-js', { source, error: err.message });
        }
    }
    throw new Error(`无法加载 guacamole-common-js：${lastError?.message || '未知错误'}`);
}

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rect = stage.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || innerWidth || 1280));
    const height = Math.max(240, Math.round((rect.height || innerHeight || 720) - 2));
    const dpi = Math.max(72, Math.round(window.devicePixelRatio ? 96 * window.devicePixelRatio : 96));
    const query = new URLSearchParams({
        connectionId: params.connectionId || '',
        width: String(width),
        height: String(height),
        dpi: String(dpi),
    });
    return `${proto}//${location.host}/guacamole?${query.toString()}`;
}

function updateInfo() {
    const parts = [
        protocolLabel(),
        params.host ? `${params.host}:${params.port || protocolDefaultPort()}` : '',
        params.username || '',
    ].filter(Boolean);
    connInfo.textContent = parts.join(' · ');
}

function applyDisplayScale() {
    if (!client || !displayShell) return;
    const display = client.getDisplay();
    const bounds = stage.getBoundingClientRect();
    const width = displayWidth || display.getWidth?.() || bounds.width;
    const height = displayHeight || display.getHeight?.() || bounds.height;
    if (!fitToWindow || !width || !height) {
        display.scale(1);
        displayRoot.style.width = '';
        displayRoot.style.height = '';
        return;
    }
    const scale = Math.min(bounds.width / width, bounds.height / height, 1);
    display.scale(Math.max(0.1, scale));
    displayRoot.style.width = `${Math.ceil(width * scale)}px`;
    displayRoot.style.height = `${Math.ceil(height * scale)}px`;
    console.debug('[guac-client]', 'display scale', { width, height, scale });
}

function sendDisplaySize() {
    if (!tunnel || !connected) return;
    const rect = stage.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || innerWidth || 1280));
    const height = Math.max(240, Math.round((rect.height || innerHeight || 720) - 2));
    tunnel.sendMessage('size', width, height);
    console.debug('[guac-client]', 'display resize requested', { width, height });
}

function scheduleResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        applyDisplayScale();
        sendDisplaySize();
    }, 180);
}

async function connect() {
    params = loadParams();
    const label = protocolLabel();
    if (!params.connectionId) {
        setStatus('error', `缺少 ${label} 连接参数`);
        return;
    }

    disconnect(false);
    updateInfo();
    setStatus('connecting', `正在加载 ${label} 客户端...`);
    console.info('[guac-client]', 'connect requested', { protocol: label, connectionId: params.connectionId, host: params.host, port: params.port || protocolDefaultPort() });

    try {
        const G = await loadGuacamole();
        setStatus('connecting', `正在连接 guacd/${label}...`);

        displayRoot.innerHTML = '';
        tunnel = new RawGuacWebSocketTunnel(wsUrl());
        client = new G.Client(tunnel);

        const displayEl = client.getDisplay().getElement();
        displayEl.classList.add('guac-display-element');
        displayRoot.appendChild(displayEl);

        client.onerror = (error) => {
            console.error('[guac-client]', 'client error', error);
            setStatus('error', error?.message || String(error) || `${label} 客户端错误`);
        };

        client.onstatechange = (state) => {
            console.info('[guac-client]', 'client state changed', { protocol: label, state });
            if (state === 3) {
                setStatus('connected', `${label} 已连接`);
                applyDisplayScale();
            } else if (state === 4 || state === 5) {
                setStatus('disconnected', `${label} 已断开`);
            }
        };

        client.getDisplay().onresize = (width, height) => {
            displayWidth = width;
            displayHeight = height;
            applyDisplayScale();
            console.debug('[guac-client]', 'remote display resized', { width, height });
        };

        mouse = new G.Mouse(displayEl);
        mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState) => {
            notifyParentActivity();
            client.sendMouseState(mouseState);
        };

        keyboard = new G.Keyboard(document);
        keyboard.onkeydown = (keysym) => {
            notifyParentActivity();
            client.sendKeyEvent(1, keysym);
        };
        keyboard.onkeyup = (keysym) => {
            client.sendKeyEvent(0, keysym);
        };

        client.connect();
    } catch (err) {
        console.error('[guac-client]', 'connect failed', err);
        setStatus('error', err.message || `${label} 连接失败`);
    }
}

function disconnect(userInitiated = true) {
    if (keyboard) {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        keyboard = null;
    }
    if (mouse) {
        mouse.onmousedown = null;
        mouse.onmouseup = null;
        mouse.onmousemove = null;
        mouse = null;
    }
    if (client) {
        try { client.disconnect(); } catch {}
        client = null;
    } else if (tunnel) {
        try { tunnel.disconnect(); } catch {}
    }
    tunnel = null;
    connected = false;
    if (userInitiated) {
        setStatus('disconnected', `${protocolLabel()} 连接已断开`);
        sessionStorage.removeItem(params?.tabId ? `zephyr_guac_params_${params.tabId}` : 'zephyr_guac_params');
    }
}

async function sendClipboard() {
    const label = protocolLabel();
    if (!client || !connected) return setStatus('error', `${label} 尚未连接`);
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch {
        text = prompt(`请输入要发送到远程 ${label} 的剪贴板文本：`) || '';
    }
    if (!text) return;
    const stream = client.createClipboardStream('text/plain');
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    console.debug('[guac-client]', 'clipboard sent', { length: text.length });
}

function sendCtrlAltDel() {
    if (!client || !connected) return;
    const CTRL = 0xffe3;
    const ALT = 0xffe9;
    const DEL = 0xffff;
    client.sendKeyEvent(1, CTRL);
    client.sendKeyEvent(1, ALT);
    client.sendKeyEvent(1, DEL);
    client.sendKeyEvent(0, DEL);
    client.sendKeyEvent(0, ALT);
    client.sendKeyEvent(0, CTRL);
    notifyParentActivity();
}

fitBtn.addEventListener('click', () => {
    fitToWindow = !fitToWindow;
    fitBtn.classList.toggle('active', fitToWindow);
    fitBtn.textContent = fitToWindow ? '↔ 适应' : '1:1 原始';
    applyDisplayScale();
});

clipboardBtn.addEventListener('click', () => sendClipboard().catch((err) => setStatus('error', err.message)));
ctrlAltDelBtn.addEventListener('click', sendCtrlAltDel);
reconnectBtn.addEventListener('click', () => connect());
disconnectBtn.addEventListener('click', () => disconnect(true));
window.addEventListener('resize', scheduleResize, { passive: true });
window.addEventListener('beforeunload', () => disconnect(false));
window.addEventListener('message', (event) => {
    if (event.data?.source !== 'zephyr-app') return;
    if (event.data.type === 'theme-change') document.documentElement.setAttribute('data-theme', event.data.theme);
    if (event.data.type === 'focus-terminal') stage?.focus?.();
});

fitBtn.classList.add('active');
setStatus('connecting');
connect();
