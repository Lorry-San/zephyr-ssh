const $ = (sel) => document.querySelector(sel);
const GUAC_CLIENT_VERSION = '2026-05-31.4-rdp-mse-fmp4';
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
const zoomBtn = $('#zoomBtn');
const clipboardBtn = $('#clipboardBtn');
const keyboardBtn = $('#keyboardBtn');
const shortcutsBtn = $('#shortcutsBtn');
const ctrlAltDelBtn = $('#ctrlAltDelBtn');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const mobileKeyboardInput = $('#mobileKeyboardInput');
const rdpTouchHud = $('#rdpTouchHud');
const rdpPointer = $('#rdpPointer');
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
let rdpInputSender = null;
let rdpAudioSocket = null;
let rdpAudioMediaSource = null;
let rdpAudioSourceBuffer = null;
let rdpAudioElement = null;
let rdpAudioQueue = [];
let keyboard = null;
let mouse = null;
let connected = false;
let fitModes = ['fit', '1:1', '16:9', '4:3'];
let fitModeIdx = 0;
let displayWidth = 0;
let displayHeight = 0;
let resizeTimer = 0;
let requestedRdpWidth = 0;
let requestedRdpHeight = 0;
let rdpScaleZoom = 1;
let mobileInputMirror = '';
let lastRemoteClipboard = '';
let clipboardAutoWriteOk = false;
let clipboardAutoWriteFailed = false;
let panelLayoutMenu = null;
let suppressNextLayoutClick = false;
let lastLocalClipboardText = '';
let lastLocalClipboardSentAt = 0;
let pasteShortcutInProgress = false;
let clipboardAutoSyncTimer = 0;
let lastClipboardReadAttemptAt = 0;
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
        if (status === 'connecting' && connected) return;
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

function computeRdpTargetSize(mode = fitModes[fitModeIdx]) {
    const bounds = stage?.getBoundingClientRect?.() || { width: innerWidth || 1280, height: innerHeight || 720 };
    const effDpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxW = 2560;
    const maxH = 1600;
    const minW = 800;
    const minH = 600;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    const fitBounds = () => {
        const w = even(Math.max(minW, Math.min(maxW, (bounds.width || innerWidth || 1280) * effDpr)));
        const h = even(Math.max(minH, Math.min(maxH, (bounds.height || innerHeight || 720) * effDpr)));
        return { width: w, height: h, mode };
    };
    const byAspect = (num, den) => {
        let w = even(Math.max(minW, Math.min(maxW, (bounds.width || innerWidth || 1280) * effDpr)));
        let h = even(w * den / num);
        if (h < minH) { h = even(minH); w = even(h * num / den); }
        if (w > maxW) { w = even(maxW); h = even(w * den / num); }
        if (h > maxH) { h = even(maxH); w = even(h * num / den); }
        // 最后一遍严格按整数比例回算，避免四舍五入和最小尺寸导致 16:9 变形。
        const unitW = Math.max(1, Math.floor(w / num));
        const unitH = Math.max(1, Math.floor(h / den));
        const unit = Math.max(1, Math.min(unitW, unitH));
        return { width: num * unit, height: den * unit, mode };
    };
    if (mode === '16:9') return byAspect(16, 9);
    if (mode === '4:3') return byAspect(4, 3);
    return fitBounds();
}



function requestRdpCanvasSize(mode = fitModes[fitModeIdx], force = false) {
    if (!rdpInputSender || client || !connected) return false;
    const target = computeRdpTargetSize(mode);
    const changed = Math.abs((requestedRdpWidth || 0) - target.width) >= 2 || Math.abs((requestedRdpHeight || 0) - target.height) >= 2;
    if (!force && !changed) return false;
    requestedRdpWidth = target.width;
    requestedRdpHeight = target.height;
    rdpInputSender({ type: 'resize', width: target.width, height: target.height, mode: target.mode });
    console.info('[guac-client]', 'rdp canvas remote resize requested', target);
    return true;
}

function applyDisplayScale() {
    if (!displayShell) return;
    const rdpCanvas = displayRoot?.querySelector?.('#rdp-canvas');
    if (rdpCanvas && !client) {
        const bounds = stage.getBoundingClientRect();
        const curW = displayWidth || rdpCanvas.width || 1280;
        const curH = displayHeight || rdpCanvas.height || 720;
        if (!curW || !curH) return;
        const mode = fitModes[fitModeIdx];
        const setCanvasCss = (w, h) => {
            const cssW = Math.ceil(w * rdpScaleZoom);
            const cssH = Math.ceil(h * rdpScaleZoom);
            displayRoot.style.width = `${cssW}px`;
            displayRoot.style.height = `${cssH}px`;
            rdpCanvas.style.width = `${cssW}px`;
            rdpCanvas.style.height = `${cssH}px`;
        };
        if (mode === '1:1') {
            setCanvasCss(curW, curH);
            return;
        }
        let scale = 1;
        if (mode === 'fit') scale = Math.max(bounds.width / curW, bounds.height / curH);
        else scale = Math.min(bounds.width / curW, bounds.height / curH);
        setCanvasCss(curW * scale, curH * scale);
        return;
    }
    if (!client) return;
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

    const scale = mode === 'fit' ? Math.max(bounds.width / curW, bounds.height / curH) : Math.min(bounds.width / curW, bounds.height / curH);
    display.scale(Math.max(0.1, scale));
    displayRoot.style.width = `${Math.ceil(curW * scale)}px`;
    displayRoot.style.height = `${Math.ceil(curH * scale)}px`;
    console.debug('[guac-client]', `display scale ${mode}`, { w: curW, h: curH, scale });
}

function switchFitMode(mode) {
    if (!tunnel || !connected) return;
    if (rdpInputSender && !client) {
        rdpScaleZoom = 1;
        requestRdpCanvasSize(mode, true);
        applyDisplayScale();
        return;
    }
    const target = computeRdpTargetSize(mode);
    if (mode === '16:9' || mode === '4:3' || mode === 'fit' || mode === '1:1') {
        tunnel.sendMessage('size', target.width, target.height);
        console.debug('[guac-client]', 'display resize requested', target);
    }
}

function sendDisplaySize() {
    if (!tunnel || !connected) return;
    if (!client) { requestRdpCanvasSize(fitModes[fitModeIdx], false); applyDisplayScale(); return; }
    const mode = fitModes[fitModeIdx];
    const target = computeRdpTargetSize(mode);
    tunnel.sendMessage('size', target.width, target.height);
    console.debug('[guac-client]', 'display resize requested', target);
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

// Guacamole client 模式只保留长按右键；双指缩放已移到顶部缩放按钮，避免和双指滚动冲突。
let guacTouches = new Map();   // pointerId → {sx, sy, pos, moved}
let guacLongPress = null;
let rdpInputMode = localStorage.getItem('zephyr-rdp-input-mode') || 'touch';
let rdpHudTimer = 0;

function showRdpHud(text, timeout = 900) {
    if (!rdpTouchHud) return;
    rdpTouchHud.textContent = text;
    rdpTouchHud.hidden = false;
    clearTimeout(rdpHudTimer);
    rdpHudTimer = setTimeout(() => { rdpTouchHud.hidden = true; }, timeout);
}

function updateRdpPointer(clientX, clientY, visible = true) {
    if (!rdpPointer) return;
    const rect = stage.getBoundingClientRect();
    rdpPointer.hidden = !visible || rdpInputMode !== 'mouse';
    if (!rdpPointer.hidden) rdpPointer.style.transform = `translate3d(${clientX - rect.left}px, ${clientY - rect.top}px, 0)`;
}

function setupMobilePointerMouse() {
    if (!stage) return;
    stage.style.touchAction = 'none';
    stage.style.webkitTouchCallout = 'none';
    stage.style.userSelect = 'none';
    stage.addEventListener('contextmenu', (e) => { if (guacTouches.size > 0) e.preventDefault(); });
    const isUI = (el) => el?.closest?.('.guac-floating-panel, .guac-mobile-keyboard-input, button, textarea, input, select');
    function cancelLP() { if (guacLongPress) { clearTimeout(guacLongPress); guacLongPress = null; } }
    function doRightClick(pos) {
        if (!client || !connected || !pos) return;
        const d = createMouseState(pos.x, pos.y, false, false, true);
        const u = createMouseState(pos.x, pos.y, false, false, false);
        client.sendMouseState(d);
        setTimeout(() => { try { client?.sendMouseState?.(u); } catch {} }, 45);
    }
    stage.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        if (isUI(event.target)) return;
        const pos = getRemotePointerPosition(event);
        if (!pos) return;
        const t = { id: event.pointerId, sx: event.clientX, sy: event.clientY, cx: event.clientX, cy: event.clientY, pos, moved: false };
        guacTouches.set(event.pointerId, t);
        if (guacTouches.size === 1) {
            cancelLP();
            guacLongPress = setTimeout(() => { if (guacTouches.size === 1 && !t.moved) doRightClick(pos); guacLongPress = null; }, 600);
        } else cancelLP();
    }, { passive: true });
    stage.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'touch') return;
        const t = guacTouches.get(event.pointerId);
        if (!t) return;
        t.cx = event.clientX; t.cy = event.clientY;
        if (!t.moved && Math.hypot(t.cx-t.sx, t.cy-t.sy) > 10) { t.moved = true; cancelLP(); }
    }, { passive: true });
    stage.addEventListener('pointerup', (event) => {
        if (event.pointerType !== 'touch') return;
        guacTouches.delete(event.pointerId);
        if (guacTouches.size === 0) cancelLP();
    }, { passive: true });
    stage.addEventListener('pointercancel', (event) => {
        guacTouches.delete(event.pointerId);
        if (guacTouches.size === 0) cancelLP();
    }, { passive: true });
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

function createRdpCanvasDisplay(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    return {
        ctx,
        setSize(width, height) {
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                displayWidth = width;
                displayHeight = height;
                applyDisplayScale();
            }
        },
        draw(frame) {
            this.setSize(frame.displayWidth || frame.codedWidth || canvas.width || 1280, frame.displayHeight || frame.codedHeight || canvas.height || 720);
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        },
    };
}

class MseRdpVideoSink {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        this.video = document.createElement('video');
        this.video.style.display = 'none';
        this.video.muted = true;
        this.video.playsInline = true;
        this.ms = null;
        this.sb = null;
        this.ready = false;
        this.streaming = false;
        this.firstFrameDrawn = false;
        this._rafId = 0;
        this._onConnected = null;
        this._queued = [];
        document.body.appendChild(this.video);
        const loop = () => {
            this._rafId = requestAnimationFrame(loop);
            if (!this.video || this.video.readyState < 2) return;
            if (this.canvas.width !== this.video.videoWidth || this.canvas.height !== this.video.videoHeight) {
                this.canvas.width = this.video.videoWidth;
                this.canvas.height = this.video.videoHeight;
                displayWidth = this.video.videoWidth;
                displayHeight = this.video.videoHeight;
                applyDisplayScale();
            }
            this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
            if (!this.firstFrameDrawn && this.video.videoWidth > 0) {
                this.firstFrameDrawn = true;
                this._onConnected?.();
            }
        };
        loop();
    }
    init(codec = 'video/mp4; codecs="avc1.42E01E"') {
        if (this.ready) return;
        if (!window.MediaSource) throw new Error('浏览器不支持 MSE 视频解码');
        this.ms = new MediaSource();
        this.video.src = URL.createObjectURL(this.ms);
        this.video.play().catch(() => {});
        const self = this;
        this.ms.addEventListener('sourceopen', () => {
            if (!MediaSource.isTypeSupported(codec)) {
                console.warn('[rdp]', 'codec not supported, try generic', codec);
                codec = 'video/mp4; codecs="avc1.42E01E"';
                if (!MediaSource.isTypeSupported(codec)) {
                    self.destroy();
                    return;
                }
            }
            try {
                self.sb = self.ms.addSourceBuffer(codec);
                self.sb.mode = 'sequence';
                self.sb.addEventListener('updateend', () => {
                    if (self._queued.length) {
                        try { self.sb.appendBuffer(self._queued.shift()); }
                        catch { self._queued.length = 0; }
                    }
                });
                self.ready = true;
                for (const chunk of self._queued) self.feed(chunk);
                self._queued.length = 0;
            } catch (err) {
                console.warn('[rdp]', 'sourcebuffer failed', err);
            }
        }, { once: true });
    }
    feed(buf) {
        if (!this.sb || this.sb.updating) {
            if (this._queued.length > 120) this._queued.splice(0, this._queued.length - 120);
            this._queued.push(buf);
        } else {
            try { this.sb.appendBuffer(buf); } catch { this._queued.push(buf); }
        }
    }
    onConnected(cb) { this._onConnected = cb; }
    destroy() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;
        try { this.sb?.abort(); } catch {}
        try { URL.revokeObjectURL(this.video.src); } catch {}
        this.video.remove();
        this.video = null;
        this.sb = null;
        this.ms = null;
        this.ready = false;
    }
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
    setStatus('connecting', `正在连接 ${label} H.264...`);

    try {
        displayRoot.innerHTML = '';
        client = null;
        const canvas = document.createElement('canvas');
        canvas.id = 'rdp-canvas';
        canvas.tabIndex = 0;
        canvas.style.cssText = 'display:block;width:100%;height:auto;image-rendering:auto;cursor:none;touch-action:none;-webkit-user-select:none;user-select:none;outline:none';
        displayRoot.appendChild(canvas);

        const mseSink = new MseRdpVideoSink(canvas);
        const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rdp-h264`;
        rdpScaleZoom = 1;
        zoomBtn && (zoomBtn.textContent = '🔍 100%');
        const initialTarget = computeRdpTargetSize(fitModes[fitModeIdx]);
        requestedRdpWidth = initialTarget.width;
        requestedRdpHeight = initialTarget.height;
        const wsQuery = new URLSearchParams({ connectionId: params.connectionId, width: String(initialTarget.width), height: String(initialTarget.height), mode: initialTarget.mode });
        tunnel = new WebSocket(`${wsBase}?${wsQuery.toString()}`);
        tunnel.binaryType = 'arraybuffer';
        mseSink.init();

        mseSink.onConnected(() => {
            setStatus('connected', `${label} 已连接 [MSE H.264]`);
            connected = true;
            startClipboardAutoSync();
            startRdpAudio();
            requestRdpCanvasSize(fitModes[fitModeIdx], true);
            notifyParentStatus('connected');
        });

        tunnel.onopen = () => {
            setStatus('connecting', `${label} 视频通道已建立，等待首帧...`);
            connected = true;
            canvas.focus({ preventScroll: true });
            notifyParentStatus('connecting');
        };
        tunnel.onclose = (event) => {
            connected = false;
            notifyParentStatus('disconnected');
            if (event.code === 1012) {
                stopClipboardAutoSync();
                stopRdpAudio();
                mseSink.destroy();
                setStatus('connecting', event.reason || '正在切换 RDP 分辨率...');
                window.setTimeout(() => connect(), 250);
                return;
            }
            mseSink.destroy();
            setStatus('disconnected', event.reason || `${label} 已断开`);
            stopRdpAudio();
            stopClipboardAutoSync();
        };
        tunnel.onerror = () => setStatus('error', `${label} WebSocket 连接失败`);
        tunnel.onmessage = async (ev) => {
            if (typeof ev.data === 'string') {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.type === 'hello') {
                        if (msg.width && msg.height) {
                            displayWidth = Number(msg.width);
                            displayHeight = Number(msg.height);
                            requestedRdpWidth = Number(msg.width) || requestedRdpWidth;
                            requestedRdpHeight = Number(msg.height) || requestedRdpHeight;
                            window.setTimeout(() => requestRdpCanvasSize(fitModes[fitModeIdx], true), 300);
                        }
                    }
                } catch {}
                return;
            }
            const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data instanceof Blob ? new Uint8Array(await ev.data.arrayBuffer()) : null;
            if (!buf || buf.byteLength < 5) return;
            mseSink.feed(buf);
        };

        function wsInput(msg) { if (tunnel && tunnel.readyState === WebSocket.OPEN) tunnel.send(JSON.stringify(msg)); }
        rdpInputSender = wsInput;
        function pos(e) { const r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * (canvas.width / Math.max(1, r.width))), y: Math.round((e.clientY - r.top) * (canvas.height / Math.max(1, r.height))) }; }
        function sendMouseMove(e) { const p = pos(e); wsInput({ type: 'mouse', x: p.x, y: p.y }); notifyParentActivity(); }
        canvas.addEventListener('mousemove', sendMouseMove);
        canvas.addEventListener('mousedown', (e) => { e.preventDefault(); canvas.focus({ preventScroll: true }); const p = pos(e); wsInput({ type: 'mouse', x: p.x, y: p.y }); wsInput({ type: 'mousedown', button: e.button + 1 }); notifyParentActivity(); });
        canvas.addEventListener('mouseup', (e) => { e.preventDefault(); wsInput({ type: 'mouseup', button: e.button + 1 }); notifyParentActivity(); });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        canvas.addEventListener('wheel', (e) => { e.preventDefault(); wsInput({ type: 'scroll', deltaY: e.deltaY }); notifyParentActivity(); }, { passive: false });
        installRdpTouchControls(canvas, wsInput, pos);
function installRdpTouchControls(canvas, wsInput, pos) {
    const touches = new Map();
    let leftDown = false;
    let longPressTimer = 0;
    let longPressFired = false;
    let lastTapAt = 0;
    let lastTap = null;
    let panStart = null;
    let startScroll = null;
    let lastTwoFingerCenter = null;
    let edgeTimer = 0;
    let pointer = { clientX: 0, clientY: 0 };
    const clearLongPress = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; } };
    const toPos = (point) => pos(point);
    const sendMove = (point) => { pointer = { clientX: point.clientX, clientY: point.clientY }; updateRdpPointer(point.clientX, point.clientY, true); const p = toPos(point); wsInput({ type: 'mouse', x: p.x, y: p.y }); return p; };
    const clickButton = (button, p) => {
        wsInput({ type: 'mouse', x: p.x, y: p.y });
        wsInput({ type: 'click', button });
    };
    const updateTouch = (touch) => {
        const item = touches.get(touch.identifier);
        if (!item) return null;
        item.x = touch.clientX;
        item.y = touch.clientY;
        item.moved = item.moved || Math.hypot(item.x - item.sx, item.y - item.sy) > 10;
        return item;
    };
    const stopEdgeScroll = () => { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = 0; } };
    const startEdgeScroll = (pt) => {
        if (edgeTimer || !pt) return;
        edgeTimer = setInterval(() => {
            const rect = displayShell.getBoundingClientRect();
            const margin = 34;
            let dx = 0, dy = 0;
            if (pt.clientX < rect.left + margin) dx = -18;
            else if (pt.clientX > rect.right - margin) dx = 18;
            if (pt.clientY < rect.top + margin) dy = -18;
            else if (pt.clientY > rect.bottom - margin) dy = 18;
            if (dx || dy) {
                displayShell.scrollLeft += dx;
                displayShell.scrollTop += dy;
                showRdpHud('边缘滚动', 500);
            }
        }, 45);
    };
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        canvas.focus({ preventScroll: true });
        for (const t of e.changedTouches) touches.set(t.identifier, { id: t.identifier, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, moved: false, startedAt: Date.now() });
        clearLongPress();
        stopEdgeScroll();
        longPressFired = false;
        if (touches.size === 1) {
            const t = [...touches.values()][0];
            const p = sendMove({ clientX: t.x, clientY: t.y });
            longPressTimer = setTimeout(() => {
                const cur = touches.get(t.id);
                if (!cur || cur.moved || touches.size !== 1) return;
                longPressFired = true;
                clickButton(3, p);
                showRdpHud('右键');
                if (navigator.vibrate) navigator.vibrate(20);
            }, 600);
        } else if (touches.size >= 2) {
            clearLongPress();
            if (leftDown) { wsInput({ type: 'mouseup', button: 1 }); leftDown = false; }
            const pts = [...touches.values()].slice(0, 2);
            panStart = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            lastTwoFingerCenter = { x: panStart.x, y: panStart.y };
            startScroll = { left: displayShell.scrollLeft, top: displayShell.scrollTop };
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            panStart.dist = dist;
            panStart.w = displayRoot.getBoundingClientRect().width;
            panStart.h = displayRoot.getBoundingClientRect().height;
            showRdpHud('双指滚动', 700);
        }
        notifyParentActivity();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) updateTouch(t);
        if (touches.size >= 2 && panStart && startScroll) {
            const pts = [...touches.values()].slice(0, 2);
            const cx = (pts[0].x + pts[1].x) / 2;
            const cy = (pts[0].y + pts[1].y) / 2;
            const dx = cx - (lastTwoFingerCenter?.x ?? cx);
            const dy = cy - (lastTwoFingerCenter?.y ?? cy);
            lastTwoFingerCenter = { x: cx, y: cy };
            const beforeLeft = displayShell.scrollLeft;
            const beforeTop = displayShell.scrollTop;
            displayShell.scrollLeft -= dx;
            displayShell.scrollTop -= dy;
            const didPanViewport = Math.abs(displayShell.scrollLeft - beforeLeft) > 0.5 || Math.abs(displayShell.scrollTop - beforeTop) > 0.5;
            if (!didPanViewport) wsInput({ type: 'scroll', deltaX: -dx * 8, deltaY: -dy * 8 });
            showRdpHud(didPanViewport ? '平移' : '双指滚动', 400);
            return;
        }
        const t = [...touches.values()][0];
        if (!t || longPressFired) return;
        const point = { clientX: t.x, clientY: t.y };
        const p = sendMove(point);
        if (t.moved) {
            clearLongPress();
            if (rdpInputMode === 'touch') {
                if (!leftDown) { wsInput({ type: 'mousedown', button: 1 }); leftDown = true; }
                wsInput({ type: 'mouse', x: p.x, y: p.y });
            }
            startEdgeScroll(point);
        }
        notifyParentActivity();
    }, { passive: false });
    const finishTouch = (e) => {
        e.preventDefault();
        const before = touches.size;
        for (const t of e.changedTouches) {
            const item = touches.get(t.identifier);
            if (!item) continue;
            const p = sendMove({ clientX: item.x, clientY: item.y });
            if (!item.moved && !longPressFired && before === 1) {
                const now = Date.now();
                const isDouble = lastTap && now - lastTapAt < 320 && Math.hypot(item.x - lastTap.x, item.y - lastTap.y) < 24;
                clickButton(1, p);
                if (isDouble) setTimeout(() => clickButton(1, p), 90);
                lastTapAt = now;
                lastTap = { x: item.x, y: item.y };
            }
            touches.delete(t.identifier);
        }
        clearLongPress();
        stopEdgeScroll();
        if (leftDown && touches.size === 0) { wsInput({ type: 'mouseup', button: 1 }); leftDown = false; }
        if (touches.size < 2) { panStart = null; startScroll = null; lastTwoFingerCenter = null; }
        notifyParentActivity();
    };
    canvas.addEventListener('touchend', finishTouch, { passive: false });
    canvas.addEventListener('touchcancel', finishTouch, { passive: false });
    canvas.addEventListener('dblclick', () => {
        rdpInputMode = rdpInputMode === 'touch' ? 'mouse' : 'touch';
        localStorage.setItem('zephyr-rdp-input-mode', rdpInputMode);
        updateRdpPointer(pointer.clientX, pointer.clientY, rdpInputMode === 'mouse');
        showRdpHud(rdpInputMode === 'mouse' ? '浮动鼠标模式' : '触控模式');
    });
}



        const keyMap = { Backspace: 'BackSpace', Tab: 'Tab', Enter: 'Return', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down', ShiftLeft: 'Shift_L', ShiftRight: 'Shift_R', ControlLeft: 'Control_L', ControlRight: 'Control_R', AltLeft: 'Alt_L', AltRight: 'Alt_R', MetaLeft: 'Super_L', MetaRight: 'Super_R', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12' };
        const sendKeyboardEventToRdp = (e) => {
            const k = keyMap[e.code] || (e.key && e.key.length === 1 ? e.key : '');
            if (!k) return false;
            e.preventDefault();
            wsInput({ type: 'key', key: k });
            notifyParentActivity();
            return true;
        };
        canvas.addEventListener('keydown', sendKeyboardEventToRdp);
        document.addEventListener('keydown', (e) => {
            if (!connected) return;
            if (isTextInputTarget(e.target)) return;
            sendKeyboardEventToRdp(e);
        }, true);
    } catch (err) {
        console.error('[guac-client]', 'connect failed', err);
        setStatus('error', err.message || `${label} 连接失败`);
    }
}

function disconnect(userInitiated = true) {
    if (tunnel && tunnel.readyState === WebSocket.OPEN) {
        try { tunnel.close(); } catch {}
    }
    tunnel = null;
    rdpInputSender = null;
    connected = false;
    if (userInitiated) {
        stopClipboardAutoSync();
        stopRdpAudio();
        setStatus('disconnected', `${protocolLabel()} 已断开`);
        try { sessionStorage.removeItem(params?.tabId ? `zephyr_guac_params_${params.tabId}` : 'zephyr_guac_params'); } catch {}
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

function stopRdpAudio() {
    try { rdpAudioSocket?.close(); } catch {}
    rdpAudioSocket = null;
    try { rdpAudioElement?.pause(); } catch {}
    if (rdpAudioElement) {
        try { URL.revokeObjectURL(rdpAudioElement.src); } catch {}
        rdpAudioElement.remove();
    }
    rdpAudioElement = null;
    rdpAudioMediaSource = null;
    rdpAudioSourceBuffer = null;
    rdpAudioQueue = [];
}

function pumpRdpAudioQueue() {
    if (!rdpAudioSourceBuffer || rdpAudioSourceBuffer.updating || !rdpAudioQueue.length) return;
    const chunk = rdpAudioQueue.shift();
    try { rdpAudioSourceBuffer.appendBuffer(chunk); }
    catch (err) { console.warn('[rdp-audio]', 'append failed', { error: err.message }); rdpAudioQueue.length = 0; }
}

function startRdpAudio() {
    if (rdpAudioSocket || !params?.connectionId || !window.MediaSource || !MediaSource.isTypeSupported('audio/webm; codecs="opus"')) return;
    stopRdpAudio();
    rdpAudioElement = document.createElement('audio');
    rdpAudioElement.autoplay = true;
    rdpAudioElement.playsInline = true;
    rdpAudioElement.controls = false;
    rdpAudioElement.style.display = 'none';
    document.body.appendChild(rdpAudioElement);
    rdpAudioMediaSource = new MediaSource();
    rdpAudioElement.src = URL.createObjectURL(rdpAudioMediaSource);
    rdpAudioElement.play().catch((err) => console.debug('[rdp-audio]', 'autoplay deferred', { error: err.message }));
    rdpAudioMediaSource.addEventListener('sourceopen', () => {
        try {
            rdpAudioSourceBuffer = rdpAudioMediaSource.addSourceBuffer('audio/webm; codecs="opus"');
            rdpAudioSourceBuffer.mode = 'sequence';
            rdpAudioSourceBuffer.addEventListener('updateend', pumpRdpAudioQueue);
            pumpRdpAudioQueue();
        } catch (err) { console.warn('[rdp-audio]', 'sourcebuffer failed', { error: err.message }); }
    }, { once: true });
    const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rdp-audio`;
    rdpAudioSocket = new WebSocket(`${wsBase}?connectionId=${encodeURIComponent(params.connectionId)}`);
    rdpAudioSocket.binaryType = 'arraybuffer';
    rdpAudioSocket.onmessage = async (ev) => {
        if (typeof ev.data === 'string') return;
        const buf = ev.data instanceof ArrayBuffer ? ev.data : ev.data instanceof Blob ? await ev.data.arrayBuffer() : null;
        if (!buf || !buf.byteLength) return;
        rdpAudioQueue.push(buf);
        if (rdpAudioQueue.length > 60) rdpAudioQueue.splice(0, rdpAudioQueue.length - 60);
        pumpRdpAudioQueue();
    };
    rdpAudioSocket.onclose = () => { rdpAudioSocket = null; };
    rdpAudioSocket.onerror = (err) => console.warn('[rdp-audio]', 'socket error', err);
}

function ensureRemoteReady(action = '操作') {
    if ((!client && !rdpInputSender) || !connected) {
        const msg = `${protocolLabel()} 尚未连接，无法${action}`;
        console.warn('[guac-client]', msg, { hasClient: !!client, hasRdpInput: !!rdpInputSender, connected });
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

function startClipboardAutoSync() {
    if (clipboardAutoSyncTimer) return;
    const tick = () => {
        if (!connected || (!client && !rdpInputSender)) return;
        const now = Date.now();
        if (document.visibilityState !== 'visible') return;
        if (isTextInputTarget(document.activeElement) && document.activeElement !== mobileKeyboardInput) return;
        if (now - lastClipboardReadAttemptAt < 1400) return;
        lastClipboardReadAttemptAt = now;
        syncLocalClipboardToRemote({ paste: false, source: 'auto-poll', force: false, silent: true }).catch(() => {});
    };
    clipboardAutoSyncTimer = window.setInterval(tick, 1500);
    window.setTimeout(tick, 250);
}

function stopClipboardAutoSync() {
    if (clipboardAutoSyncTimer) window.clearInterval(clipboardAutoSyncTimer);
    clipboardAutoSyncTimer = 0;
}

async function syncLocalClipboardToRemote({ paste = false, source = 'local-clipboard-sync', force = false, silent = false } = {}) {
    if (!ensureRemoteReady('同步本机剪贴板')) return false;
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch (err) {
        console.warn('[guac-client]', 'local clipboard sync read failed', { source, error: err.message });
        if (!silent) setClipboardHint('浏览器拒绝读取本机剪贴板，请打开剪贴板面板手动发送', 'warning');
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
    if (!silent) {
        setClipboardHint(`本机剪贴板已同步到远程 ${text.length} 字符${paste ? '，并发送粘贴' : ''}`, 'success');
        setTransientStatus(paste ? '已同步本机剪贴板并发送粘贴' : '已同步本机剪贴板到远程');
    }
    if (paste) {
        pasteShortcutInProgress = true;
        const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
        await sleep(80);
        await sendRdpClipboardPaste(text, { paste: true });
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
        if (rdpInputSender && !client) await sendRdpClipboardPaste(text, { paste: true });
        else {
            sendRemoteClipboardText(text);
            await sleep(70);
            await sendKeyCombo([KEY.CTRL, 0x0076], 'Ctrl+V');
        }
        setClipboardHint(`已捕获本机粘贴并发送到远程 ${text.length} 字符`, 'success');
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
    document.addEventListener('pointerdown', () => {
        if (rdpAudioElement) rdpAudioElement.play().catch(() => {});
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (connected) startClipboardAutoSync();
        if (document.visibilityState === 'visible' && connected) {
            syncLocalClipboardToRemote({ paste: false, source: 'visibility-visible', silent: true }).catch(() => {});
        }
    });
    window.addEventListener('focus', () => {
        if (connected) {
            startClipboardAutoSync();
            syncLocalClipboardToRemote({ paste: false, source: 'window-focus', silent: true }).catch(() => {});
        }
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

async function sendRdpClipboardPaste(text, { paste = true } = {}) {
    if (!text || !rdpInputSender || client || !connected) return false;
    rdpInputSender({ type: paste ? 'paste' : 'clipboard', text });
    notifyParentActivity();
    return true;
}

function sendRemoteClipboardText(text) {
    const label = protocolLabel();
    if (rdpInputSender && !client) {
        if (!connected) {
            setTransientStatus(`${label} 尚未连接`);
            return false;
        }
        if (!text) return false;
        rdpInputSender({ type: 'clipboard', text });
        notifyParentActivity();
        console.info('[guac-client]', 'rdp clipboard text sent', { length: text.length, paste: false });
        return true;
    }
    if (!client || !connected) {
        setTransientStatus(`${label} 尚未连接`);
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
        if (client) {
            client.sendKeyEvent(1, keysym);
            await sleep(35);
            client.sendKeyEvent(0, keysym);
        } else if (rdpInputSender) {
            rdpInputSender({ type: 'key', key: keysymToXdotool(keysym) });
        }
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
        if (client) {
            for (const keysym of keysyms) {
                client.sendKeyEvent(1, keysym);
                await sleep(25);
            }
            await sleep(60);
            for (const keysym of [...keysyms].reverse()) {
                client.sendKeyEvent(0, keysym);
                await sleep(25);
            }
        } else if (rdpInputSender) {
            rdpInputSender({ type: 'key', key: keysyms.map(keysymToXdotool).join('+') });
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

function keysymToXdotool(keysym) {
    const map = {
        [KEY.BACKSPACE]: 'BackSpace', [KEY.TAB]: 'Tab', [KEY.ENTER]: 'Return', [KEY.ESC]: 'Escape',
        [KEY.HOME]: 'Home', [KEY.LEFT]: 'Left', [KEY.UP]: 'Up', [KEY.RIGHT]: 'Right', [KEY.DOWN]: 'Down',
        [KEY.PAGE_UP]: 'Page_Up', [KEY.PAGE_DOWN]: 'Page_Down', [KEY.END]: 'End', [KEY.DELETE]: 'Delete',
        [KEY.CTRL]: 'ctrl', [KEY.SHIFT]: 'shift', [KEY.ALT]: 'alt', [KEY.SUPER]: 'Super_L',
        [KEY.F1]: 'F1', [KEY.F2]: 'F2', [KEY.F3]: 'F3', [KEY.F4]: 'F4', [KEY.F5]: 'F5', [KEY.F6]: 'F6',
        [KEY.F7]: 'F7', [KEY.F8]: 'F8', [KEY.F9]: 'F9', [KEY.F10]: 'F10', [KEY.F11]: 'F11', [KEY.F12]: 'F12',
    };
    if (map[keysym]) return map[keysym];
    if (keysym >= 0x01000000) return `U${(keysym - 0x01000000).toString(16).padStart(4, '0')}`;
    if (keysym >= 0x20 && keysym <= 0x7e) return `U${keysym.toString(16).padStart(4, '0')}`;
    return String(keysym);
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
    if (!text || (!client && !rdpInputSender) || !connected) return;
    if (mobileKeyboardInput) mobileKeyboardInput.value = '';
    mobileInputMirror = '';
    if (rdpInputSender && !client) {
        rdpInputSender({ type: 'text', text });
        notifyParentActivity();
        console.info('[guac-client]', 'rdp mobile keyboard text sent', { length: text.length });
        return;
    }
    for (const char of text) {
        const keysym = asciiKeysym(char);
        if (keysym) sendKeyDownUp(keysym);
    }
    console.info('[guac-client]', 'mobile keyboard text sent', { length: text.length });
}

function focusMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.value = mobileInputMirror = '';
    mobileKeyboardInput.style.pointerEvents = 'auto';
    mobileKeyboardInput.focus({ preventScroll: true });
    stage?.classList.add('keyboard-open');
    keyboardBtn?.classList.add('active');
    setTimeout(() => { try { mobileKeyboardInput.focus({ preventScroll: true }); } catch {} }, 80);
    console.info('[guac-client]', 'mobile keyboard focused');
}

function blurMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    mobileKeyboardInput.blur();
    mobileKeyboardInput.style.pointerEvents = 'none';
    stage?.classList.remove('keyboard-open');
    keyboardBtn?.classList.remove('active');
    console.info('[guac-client]', 'mobile keyboard blurred');
}

function toggleMobileKeyboard() {
    const keyboardOpen = document.activeElement === mobileKeyboardInput || keyboardBtn?.classList.contains('active');
    if (keyboardOpen) blurMobileKeyboard();
    else focusMobileKeyboard();
}

function setupMobileKeyboard() {
    if (!mobileKeyboardInput) return;
    // 用 beforeinput 事件精确处理插入/删除，避免字符遍历法被粘贴替换打炸
    mobileKeyboardInput.addEventListener('compositionend', (event) => {
        const text = event.data || mobileKeyboardInput.value || '';
        if (text) sendTextToRemote(text);
        mobileKeyboardInput.value = mobileInputMirror = '';
    });
    mobileKeyboardInput.addEventListener('beforeinput', (event) => {
        if ((!client && !rdpInputSender) || !connected) return;
        const inputType = event.inputType || '';
        const data = event.data || '';
        if (inputType === 'insertCompositionText') return;
        event.preventDefault(); // 禁止浏览器实际修改 textarea

        if (inputType.startsWith('deleteContent') || inputType === 'deleteByCut') {
            // 删除：之前内容长度用 mobileInputMirror 追踪
            if (rdpInputSender && !client) {
                rdpInputSender({ type: 'key', key: keysymToXdotool(KEY.BACKSPACE) });
                notifyParentActivity();
                mobileKeyboardInput.value = mobileInputMirror = '';
                return;
            }
            const delCount = inputType === 'deleteContentBackward' ? 1
                : inputType === 'deleteContentForward' ? 1
                : inputType === 'deleteByCut' ? mobileInputMirror.length
                : parseInt(inputType.match(/deleteContent(\d+)/)?.[1] || '0') || 1;
            for (let i = 0; i < delCount; i++) sendKeyDownUp(KEY.BACKSPACE);
            mobileInputMirror = mobileInputMirror.slice(0, -Math.min(delCount, mobileInputMirror.length));
            return;
        }
        if (inputType.startsWith('insert')) {
            // 插入文本
            if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
                sendTextToRemote(data);
                mobileInputMirror += data;
                return;
            }
            if (inputType === 'insertText') {
                sendTextToRemote(data);
                mobileInputMirror += data;
                return;
            }
            // insertLineBreak, insertParagraph, etc.
            sendKeyDownUp(KEY.ENTER);
            mobileInputMirror += '\n';
            return;
        }
        // historyUndo/historyRedo: ignore
    });

    // 清理过长的同步缓存
    mobileKeyboardInput.addEventListener('input', () => {
        if (mobileInputMirror.length > 200) {
            mobileKeyboardInput.value = '';
            mobileInputMirror = '';
        }
    });
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
    if (!ensureRemoteReady('发送 Ctrl+Alt+Del')) return;
    const CTRL = 0xffe3;
    const ALT = 0xffe9;
    const DEL = 0xffff;
    if (rdpInputSender && !client) {
        rdpInputSender({ type: 'key', key: 'ctrl+alt+Delete' });
        notifyParentActivity();
        return;
    }
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
    if (rdpInputSender && !client) {
        rdpScaleZoom = 1;
        const target = computeRdpTargetSize(m);
        rdpInputSender({ type: 'reconnect', width: target.width, height: target.height, mode: target.mode });
        setTransientStatus(`正在切换 ${target.width}×${target.height}`);
    } else {
        switchFitMode(m);
        applyDisplayScale();
    }
});

zoomBtn?.addEventListener('click', () => {
    const levels = [1, 1.25, 1.5, 2, 0.75];
    const cur = rdpScaleZoom || 1;
    let idx = levels.findIndex((v) => Math.abs(v - cur) < 0.03);
    rdpScaleZoom = levels[(idx + 1 + levels.length) % levels.length];
    zoomBtn.textContent = `🔍 ${Math.round(rdpScaleZoom * 100)}%`;
    applyDisplayScale();
    showRdpHud(`缩放 ${Math.round(rdpScaleZoom * 100)}%`, 700);
});

clipboardBtn.addEventListener('click', () => {
    togglePanel(clipboardPanel);
    if (!clipboardPanel.hidden) clipboardText?.focus?.();
});
clipboardReadLocalBtn?.addEventListener('click', () => readLocalClipboardIntoPanel());
clipboardSendBtn?.addEventListener('click', async () => {
    const text = clipboardText?.value || '';
    if (sendRemoteClipboardText(text)) {
        setClipboardHint(`已发送 ${text.length} 字符到远程剪贴板，可在远程 Ctrl+V 粘贴`, 'success');
        if (rdpInputSender && !client) {
            await sleep(80);
            setTransientStatus('远程剪贴板已设置，正在粘贴');
            rdpInputSender({ type: 'paste', text });
        }
    }
});
clipboardCopyRemoteBtn?.addEventListener('click', () => copyRemoteClipboardToLocal());
stage?.addEventListener('focus', () => {
    if (connected && client) syncLocalClipboardToRemote({ paste: false, source: 'stage-focus' }).catch(() => {});
});
stage?.addEventListener('pointerdown', () => {
    if (connected && client) syncLocalClipboardToRemote({ paste: false, source: 'stage-pointerdown' }).catch(() => {});
}, { passive: true });

keyboardBtn?.addEventListener('click', toggleMobileKeyboard);
setupMobileKeyboard();
mobileKeyboardInput?.addEventListener('blur', () => { keyboardBtn?.classList.remove('active'); stage?.classList.remove('keyboard-open'); });
mobileKeyboardInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace' || mobileKeyboardInput.value) return;
    event.preventDefault();
    if (rdpInputSender && !client) {
        rdpInputSender({ type: 'key', key: keysymToXdotool(KEY.BACKSPACE) });
        notifyParentActivity();
        return;
    }
    sendKeyDownUp(KEY.BACKSPACE);
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
