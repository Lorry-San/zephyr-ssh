const $ = (sel) => document.querySelector(sel);
const GUAC_CLIENT_VERSION = '2026-05-29.2-standard-ws-tunnel';
console.info('[guac-client]', 'script loaded', { version: GUAC_CLIENT_VERSION });

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
const keyboardBtn = $('#keyboardBtn');
const shortcutsBtn = $('#shortcutsBtn');
const ctrlAltDelBtn = $('#ctrlAltDelBtn');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const mobileKeyboardInput = $('#mobileKeyboardInput');
const clipboardPanel = $('#clipboardPanel');
const clipboardText = $('#clipboardText');
const clipboardReadLocalBtn = $('#clipboardReadLocalBtn');
const clipboardSendBtn = $('#clipboardSendBtn');
const remoteClipboardText = $('#remoteClipboardText');
const clipboardCopyRemoteBtn = $('#clipboardCopyRemoteBtn');
const clipboardHint = $('#clipboardHint');
const shortcutsPanel = $('#shortcutsPanel');
const shortcutGrid = $('#shortcutGrid');

const urlParams = new URLSearchParams(location.search);
const tabId = urlParams.get('tabId') || '';
const embeddedMode = urlParams.get('embed') === '1';

let params = loadParams();
const qualityModes = ['balanced', 'performance', 'quality'];
let qualityIdx = qualityModes.indexOf(params.quality || 'balanced');
if (qualityIdx < 0) qualityIdx = 0;
let Guacamole = null;
let tunnel = null;
let client = null;
let keyboard = null;
let mouse = null;
let connected = false;
let fitModes = ['fit', '1:1', '16:9', '4:3'];
let fitModeIdx = 0;
let displayWidth = 0;
let displayHeight = 0;
let resizeTimer = 0;
let mobileInputMirror = '';
let lastRemoteClipboard = '';
let clipboardAutoWriteOk = false;
let clipboardAutoWriteFailed = false;
let panelLayoutMenu = null;
let suppressNextLayoutClick = false;
let lastLocalClipboardText = '';
let lastLocalClipboardSentAt = 0;
let pasteShortcutInProgress = false;
let rdpFileClipboardSeq = 0;
const rdpFileClipboardFiles = new Map();

const RDP_FILE_CLIPBOARD_MIMETYPE = 'application/vnd.zephyr.rdp.file-clipboard';

const KEY = {
    BACKSPACE: 0xff08,
    TAB: 0xff09,
    ENTER: 0xff0d,
    ESC: 0xff1b,
    HOME: 0xff50,
    LEFT: 0xff51,
    UP: 0xff52,
    RIGHT: 0xff53,
    DOWN: 0xff54,
    PAGE_UP: 0xff55,
    PAGE_DOWN: 0xff56,
    END: 0xff57,
    DELETE: 0xffff,
    CTRL: 0xffe3,
    SHIFT: 0xffe1,
    ALT: 0xffe9,
    SUPER: 0xffeb,
    F1: 0xffbe,
    F2: 0xffbf,
    F3: 0xffc0,
    F4: 0xffc1,
    F5: 0xffc2,
    F6: 0xffc3,
    F7: 0xffc4,
    F8: 0xffc5,
    F9: 0xffc6,
    F10: 0xffc7,
    F11: 0xffc8,
    F12: 0xffc9,
};

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
        this.onuuid = null;
        this.onerror = null;
        this.socket = null;
        this.parser = new GuacInstructionParser((opcode, args) => {
            console.debug('[guac-client]', 'instruction', { opcode, argCount: args.length });
            if (opcode === 'ready') {
                this.setUUID(args[0] || `zephyr-${Date.now()}`);
                console.info('[guac-client]', 'tunnel ready', { uuid: this.uuid });
                this.setState(1);
                return;
            }
            if (opcode === 'zephyr-rdp') {
                handleZephyrRdpInstruction(args).catch((err) => console.warn('[guac-client]', 'zephyr-rdp instruction failed', { args, error: err.message }));
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

    setUUID(uuid) {
        this.uuid = uuid;
        this.onuuid?.(uuid);
    }

    isConnected() {
        return this.state === 1 || this.state === 3;
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

function guacamoleTunnelBaseUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/guacamole`;
}

function guacamoleConnectQuery() {
    const rect = stage.getBoundingClientRect();
    const rawDpr = window.devicePixelRatio || 1;
    const effDpr = Math.min(rawDpr, 2);
    const width = Math.round(Math.max(800, Math.min(1920, (rect.width || innerWidth || 1280) * effDpr)));
    const height = Math.round(Math.max(600, Math.min(1200, ((rect.height || innerHeight || 720) - 2) * effDpr)));
    const dpi = Math.max(72, Math.round(96 * rawDpr));
    const query = new URLSearchParams({
        connectionId: params.connectionId || '',
        width: String(width),
        height: String(height),
        dpi: String(dpi),
        quality: qualityModes[qualityIdx],
    });
    return query.toString();
}

function wsUrl() {
    return `${guacamoleTunnelBaseUrl()}?${guacamoleConnectQuery()}`;
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
    const curW = displayWidth || display.getWidth?.() || 1280;
    const curH = displayHeight || display.getHeight?.() || 720;
    if (!curW || !curH) return;

    const mode = fitModes[fitModeIdx];

    if (mode === '1:1') {
        display.scale(1);
        displayRoot.style.width = `${curW}px`;
        displayRoot.style.height = `${curH}px`;
        console.debug('[guac-client]', 'display scale 1:1', { w: curW, h: curH });
        return;
    }

    const scale = Math.min(bounds.width / curW, bounds.height / curH, 1);
    display.scale(Math.max(0.1, scale));
    displayRoot.style.width = `${Math.ceil(curW * scale)}px`;
    displayRoot.style.height = `${Math.ceil(curH * scale)}px`;
    console.debug('[guac-client]', `display scale ${mode}`, { w: curW, h: curH, scale });
}

function switchFitMode(mode) {
    if (!tunnel || !connected) return;
    const bounds = stage.getBoundingClientRect();
    const effDpr = Math.min(window.devicePixelRatio || 1, 2);
    let targetW, targetH;
    if (mode === '16:9') {
        targetW = Math.round(bounds.width * effDpr);
        targetH = Math.round(targetW / (16 / 9));
        if (targetH > bounds.height * effDpr) { targetH = Math.round(bounds.height * effDpr); targetW = Math.round(targetH * (16 / 9)); }
    } else if (mode === '4:3') {
        targetW = Math.round(bounds.width * effDpr);
        targetH = Math.round(targetW / (4 / 3));
        if (targetH > bounds.height * effDpr) { targetH = Math.round(bounds.height * effDpr); targetW = Math.round(targetH * (4 / 3)); }
    } else { return; }
    targetW = Math.max(320, Math.min(1920, targetW));
    targetH = Math.max(240, Math.min(1200, targetH));
    tunnel.sendMessage('size', targetW, targetH);
}

function sendDisplaySize() {
    if (!tunnel || !connected) return;
    const rect = stage.getBoundingClientRect();
    const rawDpr = window.devicePixelRatio || 1;
    const effDpr = Math.min(rawDpr, 2);
    const mode = fitModes[fitModeIdx];
    if (mode === '16:9' || mode === '4:3') { switchFitMode(mode); return; }
    const width = Math.round(Math.max(800, Math.min(1920, (rect.width || innerWidth || 1280) * effDpr)));
    const height = Math.round(Math.max(600, Math.min(1200, ((rect.height || innerHeight || 720) - 2) * effDpr)));
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

function getRemotePointerPosition(event) {
    const displayEl = displayRoot?.querySelector?.('.guac-display-element') || displayRoot?.firstElementChild || displayRoot;
    const rect = displayEl?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    if (rawX < -2 || rawY < -2 || rawX > rect.width + 2 || rawY > rect.height + 2) return null;
    const remoteWidth = displayWidth || client?.getDisplay?.()?.getWidth?.() || rect.width;
    const remoteHeight = displayHeight || client?.getDisplay?.()?.getHeight?.() || rect.height;
    const x = Math.max(0, Math.min(remoteWidth - 1, Math.round(rawX * remoteWidth / rect.width)));
    const y = Math.max(0, Math.min(remoteHeight - 1, Math.round(rawY * remoteHeight / rect.height)));
    return { x, y, rawX, rawY, rectWidth: rect.width, rectHeight: rect.height, remoteWidth, remoteHeight };
}

function createMouseState(x, y, left = false) {
    if (Guacamole?.Mouse?.State) return new Guacamole.Mouse.State(x, y, left, false, false, false, false);
    return { x, y, left, middle: false, right: false, up: false, down: false };
}

function sendRemoteMouseClick(position, source = 'touch') {
    if (!client || !connected || !position) return false;
    const down = createMouseState(position.x, position.y, true);
    const up = createMouseState(position.x, position.y, false);
    console.info('[guac-client]', 'remote mouse click mapped', {
        source,
        x: position.x,
        y: position.y,
        rawX: Number(position.rawX.toFixed(1)),
        rawY: Number(position.rawY.toFixed(1)),
        rectWidth: Number(position.rectWidth.toFixed(1)),
        rectHeight: Number(position.rectHeight.toFixed(1)),
        remoteWidth: position.remoteWidth,
        remoteHeight: position.remoteHeight,
    });
    client.sendMouseState(down);
    window.setTimeout(() => {
        try {
            client?.sendMouseState?.(up);
            console.debug('[guac-client]', 'remote mouse click sent', { source, x: position.x, y: position.y });
        } catch (err) {
            console.error('[guac-client]', 'remote mouse click release failed', { error: err.message });
        }
    }, 45);
    notifyParentActivity();
    return true;
}

// G.Mouse(displayEl) 已通过 touchstart/touchend 原生处理单指→鼠标事件（点击、拖拽）
// 此函数只处理 G.Mouse 覆盖不到的：长按→右键、双指→缩放/右键
let guacTouches = new Map();   // pointerId → {sx, sy, pos, moved}
let guacLongPress = null;
let guacPinchActive = false;
let guacPinchDist = 0;
let displayZoom = 1;

function setupMobilePointerMouse() {
    if (!stage) return;
    const isUI = (el) => el?.closest?.('.guac-floating-panel, .guac-mobile-keyboard-input, button, textarea, input, select');

    function cancelLP() { if (guacLongPress) { clearTimeout(guacLongPress); guacLongPress = null; } }
    
    function doRightClick(pos) {
        if (!client || !connected || !pos) return;
        const d = createMouseState(pos.x, pos.y, false, false, true);
        const u = createMouseState(pos.x, pos.y, false, false, false);
        client.sendMouseState(d);
        setTimeout(() => { try { client?.sendMouseState?.(u); } catch {} }, 45);
    }

    function doZoom(delta) {
        displayZoom = Math.max(0.25, Math.min(4, displayZoom + delta));
        if (!displayShell) return;
        displayShell.style.transform = displayZoom !== 1 ? `scale(${displayZoom})` : '';
        displayShell.style.transformOrigin = 'center center';
        const el = document.getElementById('zoomIndicator') || (() => {
            const e = document.createElement('div');
            e.id = 'zoomIndicator';
            e.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:6px 14px;border-radius:8px;font-size:13px;z-index:999;pointer-events:none;transition:opacity.3s';
            document.body.appendChild(e);
            return e;
        })();
        el.textContent = `${Math.round(displayZoom*100)}%`;
        el.style.opacity = '1';
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => el.style.opacity = '0', 1000);
    }

    // pointerdown: 跟踪触控，但不过滤/不拦截（让 G.Mouse 在 displayEl 正常接收）
    stage.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        if (isUI(event.target)) return;
        const pos = getRemotePointerPosition(event);
        if (!pos) return;
        const t = { id: event.pointerId, sx: event.clientX, sy: event.clientY, cx: event.clientX, cy: event.clientY, pos, moved: false };
        guacTouches.set(event.pointerId, t);

        if (guacTouches.size === 2) { cancelLP(); guacPinchActive = true; const p = [...guacTouches.values()]; guacPinchDist = Math.hypot(p[0].cx-p[1].cx, p[0].cy-p[1].cy); return; }
        if (guacTouches.size === 1) {
            cancelLP();
            guacLongPress = setTimeout(() => { if (guacTouches.size === 1 && !t.moved) { doRightClick(pos); } guacLongPress = null; }, 600);
        }
    }, { passive: true }); // ← 关键：passive + 无 capture，不干扰 G.Mouse

    stage.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'touch') return;
        const t = guacTouches.get(event.pointerId);
        if (!t) return;
        t.cx = event.clientX; t.cy = event.clientY;
        if (!t.moved && Math.hypot(t.cx-t.sx, t.cy-t.sy) > 10) { t.moved = true; cancelLP(); }
        if (guacPinchActive && guacTouches.size === 2) {
            event.preventDefault();
            const p = [...guacTouches.values()];
            const d = Math.hypot(p[0].cx-p[1].cx, p[0].cy-p[1].cy);
            if (guacPinchDist > 0) { const diff = d - guacPinchDist; if (Math.abs(diff) > 3) doZoom(diff * 0.008); }
            guacPinchDist = d;
        }
    }, { passive: false });

    stage.addEventListener('pointerup', (event) => {
        if (event.pointerType !== 'touch') return;
        const t = guacTouches.get(event.pointerId);
        if (!t) return;
        guacTouches.delete(event.pointerId);
        cancelLP();
        if (guacPinchActive) { guacPinchActive = false; guacPinchDist = 0; if (guacTouches.size === 0 && !t.moved) doRightClick(t.pos); return; }
        // 单指释放：G.Mouse 已发送 mouseup，这里不做任何事
    }, { passive: true });

    stage.addEventListener('pointercancel', (event) => {
        guacTouches.delete(event.pointerId);
        if (guacTouches.size === 0) { guacPinchActive = false; guacPinchDist = 0; }
        cancelLP();
    }, { passive: true });

    // 滚轮 → PageUp/PageDown
    stage.addEventListener('wheel', (event) => {
        if (isUI(event.target)) return;
        const pos = getRemotePointerPosition(event);
        if (!pos || !client || !connected) return;
        event.preventDefault();
        const steps = Math.min(5, Math.max(1, Math.abs(Math.round(event.deltaY / 40))));
        const key = event.deltaY > 0 ? 0xff57 : 0xff56;
        for (let i = 0; i < steps; i++) setTimeout(() => { try { client.sendKeyEvent(1, key); client.sendKeyEvent(0, key); } catch {} }, i * 30);
    }, { passive: false });
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
        tunnel = new G.WebSocketTunnel(guacamoleTunnelBaseUrl());
        tunnel.receiveTimeout = 30000;
        tunnel.unstableThreshold = 7000;
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

        client.onclipboard = (stream, mimetype) => {
            console.info('[guac-client]', 'remote clipboard stream received', { mimetype });
            receiveRemoteClipboard(stream, mimetype);
        };

        keyboard = new G.Keyboard(document);
        keyboard.onkeydown = (keysym) => {
            notifyParentActivity();
            console.debug('[guac-client]', 'keyboard down', { keysym });
            client.sendKeyEvent(1, keysym);
        };
        keyboard.onkeyup = (keysym) => {
            console.debug('[guac-client]', 'keyboard up', { keysym });
            client.sendKeyEvent(0, keysym);
        };

        stage?.focus?.({ preventScroll: true });
        client.connect(guacamoleConnectQuery());
        installLocalClipboardBridge();
        syncLocalClipboardToRemote({ paste: false, source: 'connect-initial' }).catch(() => {});
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

function detectInteractionEnvironment() {
    const ua = String(navigator.userAgent || '').toLowerCase();
    const mobileUA = /android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua);
    const iPadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const smallScreen = Math.min(width, height) <= 820;
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches || false;
    const hover = window.matchMedia?.('(hover: hover)')?.matches || false;
    const platform = String(navigator.platform || '').toLowerCase();
    const desktopPlatform = /win|mac|linux/.test(platform);
    let mobileScore = 0;
    if (mobileUA) mobileScore += 3;
    if (iPadOS) mobileScore += 3;
    if (smallScreen) mobileScore += 2;
    if (touch) mobileScore += 1;
    if (coarse) mobileScore += 2;
    if (!hover) mobileScore += 1;
    let desktopScore = 0;
    if (desktopPlatform) desktopScore += 2;
    if (hover) desktopScore += 2;
    if (!coarse) desktopScore += 1;
    if (!smallScreen) desktopScore += 2;
    let type = mobileScore >= desktopScore ? 'mobile' : 'desktop';
    let category = type === 'mobile' ? (width >= 768 ? 'tablet' : 'phone') : 'desktop';
    if (category === 'tablet') type = 'desktop';
    return { type, category, width, height, touch, coarse, hover, platform, ua, mobileScore, desktopScore };
}
function isPhoneLikeEnvironment() {
    const env = detectInteractionEnvironment();
    const explicitPhoneUA = /android.*mobile|iphone|ipod|blackberry|iemobile|opera mini/i.test(env.ua);
    const desktopClassInput = env.hover && !env.coarse;
    if (desktopClassInput) return false;
    return explicitPhoneUA && env.coarse && Math.min(env.width, env.height) <= 700;
}
function isCompactScreen() {
    return isPhoneLikeEnvironment();
}

function floatingPanels() {
    return [clipboardPanel, shortcutsPanel].filter(Boolean);
}

function getDefaultPanelOptions(panel) {
    const parentRect = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (isCompactScreen()) {
        return {
            left: 8,
            top: 44,
            width: Math.max(280, parentRect.width - 16),
            height: Math.max(260, Math.min(parentRect.height - 58, panel === shortcutsPanel ? 360 : 430)),
        };
    }
    if (panel === shortcutsPanel) {
        return { width: Math.min(460, parentRect.width - 24), height: Math.min(360, parentRect.height - 80), left: 18, top: 54 };
    }
    return { width: Math.min(440, parentRect.width - 24), height: Math.min(500, parentRect.height - 80), left: Math.max(18, parentRect.width - 460), top: 54 };
}

function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panel.dataset.floatingReady === '1') return;
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
    panel.dataset.floatingReady = '1';
    console.info('[guac-client]', 'floating panel initialized', { id: panel.id, left, top, width, height });
}

function clampPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function bringPanelToFront(panel) {
    if (!panel) return;
    const wasFront = panel.classList.contains('front');
    floatingPanels().forEach((item) => {
        item.classList.remove('front');
        if (item !== panel) item.classList.remove('front-switching');
    });
    panel.classList.add('front');
    if (!wasFront) {
        panel.classList.remove('front-switching');
        void panel.offsetWidth;
        panel.classList.add('front-switching');
        window.clearTimeout(panel._frontSwitchTimer);
        panel._frontSwitchTimer = window.setTimeout(() => panel.classList.remove('front-switching'), 360);
    }
    console.debug('[guac-client]', 'floating panel front', { id: panel.id });
}

function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const margin = isCompactScreen() ? 6 : 12;
    const topbar = isCompactScreen() ? 38 : 52;
    let left = margin;
    let top = topbar;
    let width = parentRect.width - margin * 2;
    let height = parentRect.height - topbar - margin;

    if (layout === 'half') {
        width = parentRect.width;
        height = Math.max(260, parentRect.height / 2);
        left = 0;
        top = parentRect.height - height;
    } else if (layout === 'left-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = 0;
        top = topbar;
    } else if (layout === 'right-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = parentRect.width - width;
        top = topbar;
    }

    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    bringPanelToFront(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => {
        panel.classList.remove('layout-animating');
        clampPanel(panel);
    }, 480);
    console.info('[guac-client]', 'floating panel layout applied', { id: panel.id, layout, left, top, width, height });
}

let panelLayoutButton = null;
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = anchorX - finalWidth / 2;
    const finalTop = rect.top;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${finalTop}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}
function closePanelLayoutMenu({ instant = false } = {}) {
    const menu = panelLayoutMenu;
    const button = panelLayoutButton;
    if (!menu) { button?.classList.remove('active-layout'); panelLayoutButton = null; return; }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout'); button?.style.removeProperty('opacity'); menu.remove(); panelLayoutMenu = null; panelLayoutButton = null; return;
    }
    menu.style.transition = 'none';
    positionPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        positionPanelLayoutMenu(menu, button, { collapsed: true });
    });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout'); button.style.opacity = '1'; requestAnimationFrame(() => button.style.removeProperty('opacity')); menu.remove();
        if (panelLayoutMenu === menu) panelLayoutMenu = null;
        if (panelLayoutButton === button) panelLayoutButton = null;
    }, 460);
}

function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '窗口布局');
    menu.innerHTML = `
        <button data-layout="full" title="全屏" aria-label="全屏"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="半屏" aria-label="半屏"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="左侧四分之一" aria-label="左侧四分之一"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="右侧四分之一" aria-label="右侧四分之一"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="关闭窗口" aria-label="关闭窗口"><span class="panel-layout-icon close"></span></button>
    `;
    menu.style.transition = 'none';
    document.body.appendChild(menu);
    panelLayoutMenu = menu;
    positionPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        menu.classList.add('island-open');
        positionPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => {
            menu.classList.remove('island-animating');
            menu.style.removeProperty('opacity');
        }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') {
            togglePanel(panel, false);
            return;
        }
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
    if (panelLayoutMenu !== menu) panelLayoutMenu = menu;
}

function setupPanelLayoutMenu() {
    document.querySelectorAll('[data-layout-panel]').forEach((button) => {
        const panel = document.getElementById(button.dataset.layoutPanel);
        if (!panel) return;
        button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            bringPanelToFront(panel);
            button.classList.add('pressing');
            button.setPointerCapture?.(event.pointerId);

            const startX = event.clientX;
            const startY = event.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;

            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 7) {
                    moved = true;
                    closePanelLayoutMenu({ instant: true });
                    panel.classList.add('dragging');
                }
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };

            const onUp = () => {
                panel.classList.remove('dragging');
                button.classList.remove('pressing');
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                if (moved) console.info('[guac-client]', 'floating panel moved by traffic handle', { id: panel.id, left: panel.offsetLeft, top: panel.offsetTop });
            };

            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            bringPanelToFront(panel);
            const willOpen = !panelLayoutMenu;
            console.info('[DynamicIslandDiagnostics]', {
                event: 'guac-layout-menu-toggle',
                panelId: panel?.id || '',
                buttonId: button?.id || '',
                open: willOpen,
                suppressNextLayoutClick: false,
            });
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu();
            else openPanelLayoutMenu(button, panel);
        });
    });
    document.addEventListener('pointerdown', (event) => {
        if (panelLayoutMenu && !event.target.closest('.panel-layout-menu') && !event.target.closest('[data-layout-panel]')) closePanelLayoutMenu();
    });
    window.addEventListener('resize', closePanelLayoutMenu);
}

function setupPanelDrag() {
    const handles = [
        ...document.querySelectorAll('[data-drag-panel]'),
        ...document.querySelectorAll('.guac-floating-panel .panel-titlebar'),
    ];
    handles.forEach((handle) => {
        const panel = handle.dataset.dragPanel
            ? document.getElementById(handle.dataset.dragPanel)
            : handle.closest('.guac-floating-panel');
        if (!panel) return;
        handle.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button,input,select,textarea,label')) return;
            event.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(event.pointerId);
            const startX = event.clientX;
            const startY = event.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;

            const onMove = (ev) => {
                ev.preventDefault();
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
                console.info('[guac-client]', 'floating panel dragged', { id: panel.id, left: panel.offsetLeft, top: panel.offsetTop });
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(event.pointerId);
            const startX = event.clientX;
            const startY = event.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const compact = isCompactScreen();
            const minWidth = compact ? 260 : 320;
            const minHeight = compact ? 220 : 260;

            const onMove = (ev) => {
                ev.preventDefault();
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
                console.info('[guac-client]', 'floating panel resized', { id: panel.id, width: panel.offsetWidth, height: panel.offsetHeight });
            };
            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupFloatingPanels() {
    floatingPanels().forEach((panel) => {
        ensureFloatingPanel(panel, getDefaultPanelOptions(panel));
        panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
    });
    setupPanelLayoutMenu();
    setupPanelDrag();
    setupPanelResize();
}

function animateGuacPanelFromButton(panel, button, opening = true) {
    if (!panel || !button) return;
    const panelRect = panel.getBoundingClientRect?.();
    const buttonRect = button.getBoundingClientRect?.();
    if (!panelRect || !buttonRect || panelRect.width <= 1 || panelRect.height <= 1) return;
    const originX = ((buttonRect.left + buttonRect.width / 2 - panelRect.left) / panelRect.width) * 100;
    const originY = ((buttonRect.top + buttonRect.height / 2 - panelRect.top) / panelRect.height) * 100;
    panel.style.setProperty('--panel-origin-x', `${Math.max(8, Math.min(92, originX))}%`);
    panel.style.setProperty('--panel-origin-y', `${Math.max(8, Math.min(92, originY))}%`);
    panel.classList.remove('panel-opening', 'panel-closing');
    void panel.offsetWidth;
    panel.classList.add(opening ? 'panel-opening' : 'panel-closing');
}
function clearGuacPanelMotion(panel) {
    panel?.classList.remove('panel-opening', 'panel-closing');
}

function togglePanel(panel, force, sourceButton = null) {
    if (!panel) return;
    ensureFloatingPanel(panel, getDefaultPanelOptions(panel));
    const shouldShow = force ?? panel.hidden;
    panel.hidden = !shouldShow;
    panel.classList.toggle('open', shouldShow);
    if (panel === clipboardPanel) clipboardBtn?.classList.toggle('active', shouldShow);
    if (panel === shortcutsPanel) shortcutsBtn?.classList.toggle('active', shouldShow);
    const button = sourceButton || (panel === clipboardPanel ? clipboardBtn : panel === shortcutsPanel ? shortcutsBtn : null);
    requestAnimationFrame(() => animateGuacPanelFromButton(panel, button, shouldShow));
    if (shouldShow) bringPanelToFront(panel);
    else {
        closePanelLayoutMenu({ instant: true });
        window.setTimeout(() => clearGuacPanelMotion(panel), 320);
    }
    console.info('[guac-client]', 'floating panel toggled', { id: panel.id, open: shouldShow });
}

function setClipboardHint(message, level = 'info') {
    if (!clipboardHint) return;
    clipboardHint.textContent = message;
    clipboardHint.dataset.level = level;
}

function setTransientStatus(message, timeout = 1800) {
    const old = statusText?.textContent || '';
    if (statusText) statusText.textContent = message;
    window.setTimeout(() => {
        if (connected && statusText && statusText.textContent === message) {
            statusText.textContent = `${protocolLabel()} 已连接`;
        } else if (!connected && statusText && statusText.textContent === message) {
            statusText.textContent = old;
        }
    }, timeout);
}

function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function ensureRemoteReady(action = '操作') {
    if (!client || !connected) {
        const msg = `${protocolLabel()} 尚未连接，无法${action}`;
        console.warn('[guac-client]', msg, { hasClient: !!client, connected });
        setTransientStatus(msg);
        return false;
    }
    return true;
}

async function writeHostClipboard(text) {
    if (!text) return false;

    try {
        const permission = await navigator.permissions?.query?.({ name: 'clipboard-write' });
        console.debug('[guac-client]', 'clipboard-write permission', { state: permission?.state || 'unknown' });
    } catch (err) {
        console.debug('[guac-client]', 'clipboard-write permission query unavailable', { error: err.message });
    }

    try {
        await navigator.clipboard.writeText(text);
        console.info('[guac-client]', 'host clipboard written via Clipboard API', { length: text.length });
        return true;
    } catch (err) {
        console.warn('[guac-client]', 'Clipboard API write failed, trying execCommand fallback', { error: err.message });
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
        console.info('[guac-client]', 'host clipboard fallback result', { ok, length: text.length });
    } catch (err) {
        console.warn('[guac-client]', 'host clipboard fallback failed', { error: err.message });
    } finally {
        textarea.remove();
        stage?.focus?.({ preventScroll: true });
    }
    return ok;
}

function isTextInputTarget(target = document.activeElement) {
    if (!target) return false;
    if (target.closest?.('.guac-floating-panel')) return true;
    const tag = target.tagName?.toLowerCase();
    return tag === 'textarea' || tag === 'input' || target.isContentEditable;
}

async function syncLocalClipboardToRemote({ paste = false, source = 'local-clipboard-sync', force = false } = {}) {
    if (!ensureRemoteReady('同步本机剪贴板')) return false;
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch (err) {
        console.warn('[guac-client]', 'local clipboard sync read failed', { source, error: err.message });
        setClipboardHint('浏览器拒绝读取本机剪贴板，请打开剪贴板面板手动发送', 'warning');
        return false;
    }
    if (!text) return false;
    const now = Date.now();
    const duplicate = text === lastLocalClipboardText && now - lastLocalClipboardSentAt < 1500;
    if (!force && duplicate && !paste) return true;
    if (!force && duplicate && paste && pasteShortcutInProgress) return true;
    lastLocalClipboardText = text;
    lastLocalClipboardSentAt = now;
    if (clipboardText) clipboardText.value = text;
    const ok = sendRemoteClipboardText(text);
    if (!ok) return false;
    setClipboardHint(`本机剪贴板已同步到远程 ${text.length} 字符${paste ? '，并发送粘贴' : ''}`, 'success');
    setTransientStatus(paste ? '已同步本机剪贴板并发送粘贴' : '已同步本机剪贴板到远程');
    if (paste) {
        pasteShortcutInProgress = true;
        const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
        await sleep(80);
        await sendKeyCombo([isMac ? KEY.SUPER : KEY.CTRL, 0x0076], isMac ? 'Cmd+V' : 'Ctrl+V');
        window.setTimeout(() => { pasteShortcutInProgress = false; }, 300);
    }
    return true;
}

function installLocalClipboardBridge() {
    if (installLocalClipboardBridge._installed) return;
    installLocalClipboardBridge._installed = true;
    document.addEventListener('paste', async (event) => {
        if (!connected || isTextInputTarget(event.target)) return;
        const files = clipboardEventFiles(event);
        if (files.length && protocolLabel() === 'RDP') {
            event.preventDefault();
            await sendRdpFilesClipboard(files, { paste: true, source: 'paste-event' });
            return;
        }
        const text = event.clipboardData?.getData('text/plain') || '';
        if (!text) return;
        event.preventDefault();
        lastLocalClipboardText = text;
        lastLocalClipboardSentAt = Date.now();
        if (clipboardText) clipboardText.value = text;
        sendRemoteClipboardText(text);
        setClipboardHint(`已捕获本机粘贴并同步到远程 ${text.length} 字符，正在发送 Ctrl+V`, 'success');
        await sleep(70);
        await sendKeyCombo([KEY.CTRL, 0x0076], 'Ctrl+V');
    }, true);
    document.addEventListener('keydown', async (event) => {
        if (!connected || isTextInputTarget(event.target)) return;
        const key = String(event.key || '').toLowerCase();
        const pasteShortcut = key === 'v' && (event.ctrlKey || event.metaKey);
        if (!pasteShortcut) return;
        event.preventDefault();
        const files = [];
        if (protocolLabel() === 'RDP') {
            try {
                const items = await navigator.clipboard?.read?.();
                for (const item of items || []) {
                    for (const type of item.types || []) {
                        if (type.startsWith('text/')) continue;
                        const blob = await item.getType(type);
                        files.push(new File([blob], blob.name || `clipboard-file-${files.length + 1}`, { type: blob.type || type }));
                    }
                }
            } catch (err) {
                console.debug('[guac-client]', 'clipboard file read unavailable', { error: err.message });
            }
            if (files.length) {
                await sendRdpFilesClipboard(files, { paste: true, source: 'keyboard-paste-shortcut' });
                return;
            }
        }
        await syncLocalClipboardToRemote({ paste: true, source: 'keyboard-paste-shortcut', force: true });
    }, true);
    document.addEventListener('drop', async (event) => {
        if (!connected || isTextInputTarget(event.target) || protocolLabel() !== 'RDP') return;
        const files = clipboardEventFiles(event);
        if (!files.length) return;
        event.preventDefault();
        await sendRdpFilesClipboard(files, { paste: false, source: 'drop-event' });
    }, true);
    document.addEventListener('dragover', (event) => {
        if (!connected || protocolLabel() !== 'RDP') return;
        const files = clipboardEventFiles(event);
        if (!files.length) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }, true);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && connected) {
            syncLocalClipboardToRemote({ paste: false, source: 'visibility-visible' }).catch(() => {});
        }
    });
    window.addEventListener('focus', () => {
        if (connected) syncLocalClipboardToRemote({ paste: false, source: 'window-focus' }).catch(() => {});
    });
}

function encodeRdpFileClipboardMimetype(file, reset = false, extra = {}) {
    const safeId = encodeURIComponent(extra.id || file?.__rdpFileClipboardId || 'file').replace(/%/g, '%25').replace(/;/g, '%3B');
    const safeName = encodeURIComponent(file?.name || extra.name || 'clipboard-file').replace(/%/g, '%25').replace(/;/g, '%3B');
    const size = Math.max(0, Number(file?.size ?? extra.size) || 0);
    const parts = [`${RDP_FILE_CLIPBOARD_MIMETYPE}`, `id=${safeId}`, `name=${safeName}`, `size=${size}`, `reset=${reset ? 1 : 0}`];
    if (extra.response) parts.push(`response=${extra.response}`);
    if (extra.request) parts.push(`request=${extra.request}`);
    return parts.join(';');
}

function sendRdpFileClipboardMetadata(file, { reset = false } = {}) {
    if (!file || !client || !connected || protocolLabel() !== 'RDP') return false;
    const id = `f${Date.now().toString(36)}${(++rdpFileClipboardSeq).toString(36)}`;
    Object.defineProperty(file, '__rdpFileClipboardId', { value: id, configurable: true });
    rdpFileClipboardFiles.set(id, file);
    const stream = client.createClipboardStream(encodeRdpFileClipboardMimetype(file, reset, { id }));
    stream.sendEnd();
    console.info('[guac-client]', 'rdp file clipboard metadata sent', { id, name: file.name, size: file.size });
    return true;
}

async function handleRdpFileRangeRequest(requestId, fileId, offsetText, lengthText) {
    const file = rdpFileClipboardFiles.get(fileId);
    if (!file || !client || !connected) {
        console.warn('[guac-client]', 'rdp file range request missing file', { requestId, fileId });
        return;
    }
    const offset = Math.max(0, Number(offsetText) || 0);
    const length = Math.max(0, Number(lengthText) || 0);
    const chunk = file.slice(offset, Math.min(offset + length, file.size));
    const stream = client.createClipboardStream(encodeRdpFileClipboardMimetype(file, false, { id: fileId, response: 'range', request: requestId }));
    const writer = new Guacamole.BlobWriter(stream);
    await new Promise((resolve) => {
        writer.onerror = (_blob, readOffset, error) => {
            console.warn('[guac-client]', 'rdp file range read failed', { requestId, fileId, readOffset, error: error?.message || String(error) });
            resolve(false);
        };
        writer.oncomplete = () => {
            writer.sendEnd();
            console.debug('[guac-client]', 'rdp file range response sent', { requestId, fileId, offset, length: chunk.size });
            resolve(true);
        };
        writer.sendBlob(chunk);
    });
}

async function handleZephyrRdpInstruction(args = []) {
    const [op, ...rest] = args;
    if (op === 'file-range-request') {
        await handleRdpFileRangeRequest(rest[0], rest[1], rest[2], rest[3]);
        return;
    }
    console.debug('[guac-client]', 'unknown zephyr-rdp instruction', { op, rest });
}

async function sendRdpFilesClipboard(files, { paste = true, source = 'file-clipboard' } = {}) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || protocolLabel() !== 'RDP') return false;
    if (!ensureRemoteReady('同步 RDP 文件剪贴板')) return false;
    list.forEach((file, index) => sendRdpFileClipboardMetadata(file, { reset: index === 0 }));
    setClipboardHint(`已把 ${list.length} 个文件注册到 RDP 文件剪贴板${paste ? '，正在发送 Ctrl+V' : ''}`, 'success');
    setTransientStatus(`RDP 文件剪贴板：${list.length} 个文件`);
    console.info('[guac-client]', 'rdp file clipboard sent', { count: list.length, source, names: list.map((file) => file.name) });
    notifyParentActivity();
    if (paste) {
        await sleep(160);
        await sendKeyCombo([KEY.CTRL, 0x0076], 'Ctrl+V');
    }
    return true;
}

function clipboardEventFiles(event) {
    const dt = event?.clipboardData || event?.dataTransfer;
    return Array.from(dt?.files || []).filter((file) => file && file.size >= 0);
}

function sendRemoteClipboardText(text) {
    const label = protocolLabel();
    if (!client || !connected) {
        setStatus('error', `${label} 尚未连接`);
        return false;
    }
    if (!text) return false;
    const G = Guacamole;
    const stream = client.createClipboardStream('text/plain');
    const writer = new G.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    console.info('[guac-client]', 'local clipboard sent to remote', { length: text.length });
    notifyParentActivity();
    return true;
}

async function readLocalClipboardIntoPanel() {
    try {
        const text = await navigator.clipboard.readText();
        clipboardText.value = text;
        console.info('[guac-client]', 'local clipboard read', { length: text.length });
        setClipboardHint('已读取本机剪贴板', 'success');
    } catch (err) {
        console.warn('[guac-client]', 'local clipboard read failed', { error: err.message });
        setClipboardHint('浏览器拒绝读取，请手动粘贴', 'warning');
        clipboardText?.focus?.();
    }
}

async function copyRemoteClipboardToLocal() {
    if (!lastRemoteClipboard) {
        setClipboardHint('还没有收到远程剪贴板', 'warning');
        return;
    }

    const ok = await writeHostClipboard(lastRemoteClipboard);
    clipboardAutoWriteOk = ok;
    clipboardAutoWriteFailed = !ok;
    if (ok) {
        setClipboardHint('远程剪贴板已复制到本机', 'success');
        setTransientStatus('远程剪贴板已同步到本机');
    } else {
        setClipboardHint('浏览器阻止写入系统剪贴板，请在文本框中手动全选复制', 'warning');
        remoteClipboardText?.focus?.();
        remoteClipboardText?.select?.();
    }
}

function receiveRemoteClipboard(stream, mimetype) {
    const isText = !mimetype || /^text\//i.test(mimetype);
    if (!isText) {
        console.warn('[guac-client]', 'remote clipboard ignored: unsupported mimetype', { mimetype });
        setClipboardHint(`收到非文本剪贴板：${mimetype || 'unknown'}`, 'warning');
        return;
    }

    const reader = new Guacamole.StringReader(stream);
    const chunks = [];
    reader.ontext = (text) => {
        chunks.push(text);
        console.debug('[guac-client]', 'remote clipboard chunk', { length: text.length });
    };
    reader.onend = async () => {
        lastRemoteClipboard = chunks.join('');
        if (remoteClipboardText) remoteClipboardText.value = lastRemoteClipboard;
        togglePanel(clipboardPanel, true);
        setClipboardHint(`收到远程剪贴板 ${lastRemoteClipboard.length} 字符，正在同步到本机...`, 'info');
        console.info('[guac-client]', 'remote clipboard received', { length: lastRemoteClipboard.length, mimetype });

        const ok = await writeHostClipboard(lastRemoteClipboard);
        clipboardAutoWriteOk = ok;
        clipboardAutoWriteFailed = !ok;
        if (ok) {
            setClipboardHint('远程剪贴板已自动同步到本机', 'success');
            setTransientStatus('远程剪贴板已自动同步到本机');
        } else {
            setClipboardHint('已收到远程剪贴板；浏览器阻止自动写入，请点“复制到本机”或手动复制文本框内容', 'warning');
            console.warn('[guac-client]', 'remote clipboard auto-write blocked by browser policy');
            remoteClipboardText?.focus?.();
            remoteClipboardText?.select?.();
        }
    };
}

async function sendKeyDownUp(keysym, label = '快捷键') {
    if (!ensureRemoteReady(`发送${label}`)) return false;
    try {
        console.info('[guac-client]', 'shortcut key send', { label, keysym });
        client.sendKeyEvent(1, keysym);
        await sleep(35);
        client.sendKeyEvent(0, keysym);
        notifyParentActivity();
        setTransientStatus(`已发送 ${label}`);
        return true;
    } catch (err) {
        console.error('[guac-client]', 'shortcut key send failed', { label, keysym, error: err.message });
        setTransientStatus(`${label} 发送失败`);
        return false;
    }
}

async function sendKeyCombo(keysyms, label = '组合键') {
    if (!ensureRemoteReady(`发送${label}`)) return false;
    try {
        console.info('[guac-client]', 'shortcut combo send', { label, keysyms });
        for (const keysym of keysyms) {
            client.sendKeyEvent(1, keysym);
            await sleep(25);
        }
        await sleep(60);
        for (const keysym of [...keysyms].reverse()) {
            client.sendKeyEvent(0, keysym);
            await sleep(25);
        }
        notifyParentActivity();
        setTransientStatus(`已发送 ${label}`);
        return true;
    } catch (err) {
        console.error('[guac-client]', 'shortcut combo send failed', { label, keysyms, error: err.message });
        setTransientStatus(`${label} 发送失败`);
        return false;
    }
}

function asciiKeysym(char) {
    if (!char) return 0;
    if (char === '\n' || char === '\r') return KEY.ENTER;
    if (char === '\t') return KEY.TAB;
    const code = char.codePointAt(0);
    if (code <= 0xff) return code;
    return code <= 0x10ffff ? (0x01000000 | code) : 0;
}

function sendTextToRemote(text) {
    if (!text || !client || !connected) return;
    for (const char of text) {
        const keysym = asciiKeysym(char);
        if (keysym) sendKeyDownUp(keysym);
    }
    console.info('[guac-client]', 'mobile keyboard text sent', { length: text.length });
}

function focusMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.value = mobileInputMirror = '';
    mobileKeyboardInput.focus({ preventScroll: true });
    keyboardBtn?.classList.add('active');
    console.info('[guac-client]', 'mobile keyboard focused');
}

function blurMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.blur();
    keyboardBtn?.classList.remove('active');
    console.info('[guac-client]', 'mobile keyboard blurred');
}

function toggleMobileKeyboard() {
    const keyboardOpen = document.activeElement === mobileKeyboardInput || keyboardBtn?.classList.contains('active');
    if (keyboardOpen) blurMobileKeyboard();
    else focusMobileKeyboard();
}

function handleMobileKeyboardInput() {
    const value = mobileKeyboardInput.value || '';
    let prefix = 0;
    while (prefix < value.length && prefix < mobileInputMirror.length && value[prefix] === mobileInputMirror[prefix]) prefix += 1;

    const removed = mobileInputMirror.length - prefix;
    const added = value.slice(prefix);
    for (let i = 0; i < removed; i += 1) sendKeyDownUp(KEY.BACKSPACE);
    sendTextToRemote(added);

    mobileInputMirror = value;
    if (value.length > 80) {
        mobileKeyboardInput.value = mobileInputMirror = '';
    }
}

async function runShortcut(name) {
    const lower = String(name || '').toLowerCase();
    const ctrlChar = (char) => char.toLowerCase().codePointAt(0);
    console.info('[guac-client]', 'shortcut button activated', { name: lower, connected, hasClient: !!client });

    const actions = {
        esc: () => sendKeyDownUp(KEY.ESC, 'Esc'),
        tab: () => sendKeyDownUp(KEY.TAB, 'Tab'),
        enter: () => sendKeyDownUp(KEY.ENTER, 'Enter'),
        backspace: () => sendKeyDownUp(KEY.BACKSPACE, 'Backspace'),
        win: () => sendKeyDownUp(KEY.SUPER, 'Win'),
        'alt-tab': () => sendKeyCombo([KEY.ALT, KEY.TAB], 'Alt+Tab'),
        up: () => sendKeyDownUp(KEY.UP, '↑'),
        down: () => sendKeyDownUp(KEY.DOWN, '↓'),
        left: () => sendKeyDownUp(KEY.LEFT, '←'),
        right: () => sendKeyDownUp(KEY.RIGHT, '→'),
        home: () => sendKeyDownUp(KEY.HOME, 'Home'),
        end: () => sendKeyDownUp(KEY.END, 'End'),
        pageup: () => sendKeyDownUp(KEY.PAGE_UP, 'PageUp'),
        pagedown: () => sendKeyDownUp(KEY.PAGE_DOWN, 'PageDown'),
    };

    if (/^ctrl-[a-z]$/.test(lower)) {
        const char = lower.slice(-1);
        return sendKeyCombo([KEY.CTRL, ctrlChar(char)], `Ctrl+${char.toUpperCase()}`);
    }
    if (/^f(?:[1-9]|1[0-2])$/.test(lower)) {
        const label = lower.toUpperCase();
        return sendKeyDownUp(KEY[label], label);
    }

    const action = actions[lower];
    if (!action) {
        console.warn('[guac-client]', 'unknown shortcut', { name: lower });
        setTransientStatus(`未知快捷键：${lower}`);
        return false;
    }
    return action();
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
    fitModeIdx = (fitModeIdx + 1) % fitModes.length;
    const m = fitModes[fitModeIdx];
    fitBtn.classList.toggle('active', m !== '1:1');
    fitBtn.textContent = m === 'fit' ? '↔ 适应' : m === '1:1' ? '1:1 原始' : m;
    if (m === '16:9' || m === '4:3') switchFitMode(m);
    else applyDisplayScale();
});

clipboardBtn.addEventListener('click', () => {
    togglePanel(clipboardPanel);
    if (!clipboardPanel.hidden) clipboardText?.focus?.();
});
clipboardReadLocalBtn?.addEventListener('click', () => readLocalClipboardIntoPanel());
clipboardSendBtn?.addEventListener('click', () => {
    const text = clipboardText?.value || '';
    if (sendRemoteClipboardText(text)) setClipboardHint(`已发送 ${text.length} 字符到远程`, 'success');
});
clipboardCopyRemoteBtn?.addEventListener('click', () => copyRemoteClipboardToLocal());
stage?.addEventListener('focus', () => {
    if (connected) syncLocalClipboardToRemote({ paste: false, source: 'stage-focus' }).catch(() => {});
});
stage?.addEventListener('pointerdown', () => {
    if (connected) syncLocalClipboardToRemote({ paste: false, source: 'stage-pointerdown' }).catch(() => {});
}, { passive: true });

keyboardBtn?.addEventListener('click', toggleMobileKeyboard);
mobileKeyboardInput?.addEventListener('input', handleMobileKeyboardInput);
mobileKeyboardInput?.addEventListener('blur', () => keyboardBtn?.classList.remove('active'));
mobileKeyboardInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !mobileKeyboardInput.value) {
        event.preventDefault();
        sendKeyDownUp(KEY.BACKSPACE);
    }
});

shortcutsBtn?.addEventListener('click', () => {
    togglePanel(shortcutsPanel);
});
shortcutGrid?.addEventListener('pointerdown', (event) => {
    const btn = event.target.closest('[data-keyseq]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    btn.classList.add('active');
    window.setTimeout(() => btn.classList.remove('active'), 140);
    runShortcut(btn.dataset.keyseq).catch((err) => {
        console.error('[guac-client]', 'shortcut action failed', { keyseq: btn.dataset.keyseq, error: err.message });
    });
}, { capture: true });

shortcutGrid?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-keyseq]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
}, { capture: true });

stage?.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
    if (event.target.closest('.guac-floating-panel, .guac-mobile-keyboard-input, button, textarea, input')) return;
    stage.focus({ preventScroll: true });
    notifyParentActivity();
});
ctrlAltDelBtn.addEventListener('click', sendCtrlAltDel);
const qualityBtn = document.getElementById('qualityBtn');
if (qualityBtn) {
    qualityBtn.textContent = qualityModes[qualityIdx] === 'balanced' ? '⚡ 平衡' : qualityModes[qualityIdx] === 'performance' ? '⚡ 性能' : '⚡ 画质';
    qualityBtn.addEventListener('click', () => {
        qualityIdx = (qualityIdx + 1) % qualityModes.length;
        qualityBtn.textContent = qualityModes[qualityIdx] === 'balanced' ? '⚡ 平衡' : qualityModes[qualityIdx] === 'performance' ? '⚡ 性能' : '⚡ 画质';
        // 保存 quality 到 params 和 sessionStorage
        params.quality = qualityModes[qualityIdx];
        const key = tabId ? `zephyr_guac_params_${tabId}` : 'zephyr_guac_params';
        try { sessionStorage.setItem(key, JSON.stringify(params)); } catch {}
        // 用 false 避免清除 sessionStorage
        disconnect(false);
        setTimeout(() => connect(), 300);
    });
}
reconnectBtn.addEventListener('click', () => connect());
disconnectBtn.addEventListener('click', () => disconnect(true));
window.addEventListener('resize', scheduleResize, { passive: true });
window.addEventListener('beforeunload', () => disconnect(false));
window.addEventListener('message', (event) => {
    if (event.data?.source !== 'zephyr-app') return;
    if (event.data.type === 'theme-change') document.documentElement.setAttribute('data-theme', event.data.theme);
    if (event.data.type === 'focus-terminal') {
        stage?.focus?.({ preventScroll: true });
        focusMobileKeyboard();
    }
});

setupFloatingPanels();
setupMobilePointerMouse();
fitBtn.classList.add('active');
setStatus('connecting');
connect();
