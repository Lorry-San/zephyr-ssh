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
const keyboardBtn = $('#keyboardBtn');
const shortcutsBtn = $('#shortcutsBtn');
const ctrlAltDelBtn = $('#ctrlAltDelBtn');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const mobileKeyboardInput = $('#mobileKeyboardInput');
const clipboardPanel = $('#clipboardPanel');
const clipboardCloseBtn = $('#clipboardCloseBtn');
const clipboardText = $('#clipboardText');
const clipboardReadLocalBtn = $('#clipboardReadLocalBtn');
const clipboardSendBtn = $('#clipboardSendBtn');
const remoteClipboardText = $('#remoteClipboardText');
const clipboardCopyRemoteBtn = $('#clipboardCopyRemoteBtn');
const clipboardHint = $('#clipboardHint');
const shortcutsPanel = $('#shortcutsPanel');
const shortcutsCloseBtn = $('#shortcutsCloseBtn');
const shortcutGrid = $('#shortcutGrid');

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
let mobileInputMirror = '';
let lastRemoteClipboard = '';
let clipboardAutoWriteOk = false;
let clipboardAutoWriteFailed = false;

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

function togglePanel(panel, force) {
    if (!panel) return;
    const shouldShow = force ?? panel.hidden;
    panel.hidden = !shouldShow;
    if (shouldShow) panel.classList.add('open');
    else panel.classList.remove('open');
}

function setClipboardHint(message, level = 'info') {
    if (!clipboardHint) return;
    clipboardHint.textContent = message;
    clipboardHint.dataset.level = level;
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
    try {
        await navigator.clipboard.writeText(lastRemoteClipboard);
        clipboardAutoWriteOk = true;
        setClipboardHint('远程剪贴板已复制到本机', 'success');
        console.info('[guac-client]', 'remote clipboard copied to local clipboard', { length: lastRemoteClipboard.length });
    } catch (err) {
        clipboardAutoWriteFailed = true;
        setClipboardHint('自动复制被浏览器拦截，请长按/全选手动复制', 'warning');
        console.warn('[guac-client]', 'remote clipboard copy to local failed', { error: err.message });
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
        setClipboardHint(`收到远程剪贴板 ${lastRemoteClipboard.length} 字符`, 'success');
        console.info('[guac-client]', 'remote clipboard received', { length: lastRemoteClipboard.length, mimetype });

        try {
            await navigator.clipboard.writeText(lastRemoteClipboard);
            clipboardAutoWriteOk = true;
            clipboardAutoWriteFailed = false;
            setClipboardHint('远程剪贴板已自动同步到本机', 'success');
            console.info('[guac-client]', 'remote clipboard auto-written to local', { length: lastRemoteClipboard.length });
        } catch (err) {
            clipboardAutoWriteFailed = true;
            setClipboardHint('已收到远程剪贴板；点“复制到本机”完成同步', 'warning');
            console.warn('[guac-client]', 'remote clipboard auto-write blocked', { error: err.message });
        }
    };
}

function sendKeyDownUp(keysym) {
    if (!client || !connected) return;
    console.debug('[guac-client]', 'shortcut key', { keysym });
    client.sendKeyEvent(1, keysym);
    client.sendKeyEvent(0, keysym);
    notifyParentActivity();
}

function sendKeyCombo(...keysyms) {
    if (!client || !connected) return;
    console.info('[guac-client]', 'shortcut combo', { keysyms });
    keysyms.forEach((keysym) => client.sendKeyEvent(1, keysym));
    [...keysyms].reverse().forEach((keysym) => client.sendKeyEvent(0, keysym));
    notifyParentActivity();
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

function runShortcut(name) {
    const lower = String(name || '').toLowerCase();
    const ctrlChar = (char) => char.toLowerCase().codePointAt(0);
    const actions = {
        esc: () => sendKeyDownUp(KEY.ESC),
        tab: () => sendKeyDownUp(KEY.TAB),
        enter: () => sendKeyDownUp(KEY.ENTER),
        backspace: () => sendKeyDownUp(KEY.BACKSPACE),
        win: () => sendKeyDownUp(KEY.SUPER),
        'alt-tab': () => sendKeyCombo(KEY.ALT, KEY.TAB),
        'ctrl-c': () => sendKeyCombo(KEY.CTRL, ctrlChar('c')),
        'ctrl-v': () => sendKeyCombo(KEY.CTRL, ctrlChar('v')),
        'ctrl-a': () => sendKeyCombo(KEY.CTRL, ctrlChar('a')),
        'ctrl-z': () => sendKeyCombo(KEY.CTRL, ctrlChar('z')),
        up: () => sendKeyDownUp(KEY.UP),
        down: () => sendKeyDownUp(KEY.DOWN),
        left: () => sendKeyDownUp(KEY.LEFT),
        right: () => sendKeyDownUp(KEY.RIGHT),
        home: () => sendKeyDownUp(KEY.HOME),
        end: () => sendKeyDownUp(KEY.END),
        pageup: () => sendKeyDownUp(KEY.PAGE_UP),
        pagedown: () => sendKeyDownUp(KEY.PAGE_DOWN),
    };
    actions[lower]?.();
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

clipboardBtn.addEventListener('click', () => {
    togglePanel(clipboardPanel);
    togglePanel(shortcutsPanel, false);
    if (!clipboardPanel.hidden) clipboardText?.focus?.();
});
clipboardCloseBtn?.addEventListener('click', () => togglePanel(clipboardPanel, false));
clipboardReadLocalBtn?.addEventListener('click', () => readLocalClipboardIntoPanel());
clipboardSendBtn?.addEventListener('click', () => {
    const text = clipboardText?.value || '';
    if (sendRemoteClipboardText(text)) setClipboardHint(`已发送 ${text.length} 字符到远程`, 'success');
});
clipboardCopyRemoteBtn?.addEventListener('click', () => copyRemoteClipboardToLocal());

keyboardBtn?.addEventListener('click', focusMobileKeyboard);
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
    togglePanel(clipboardPanel, false);
});
shortcutsCloseBtn?.addEventListener('click', () => togglePanel(shortcutsPanel, false));
shortcutGrid?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-keyseq]');
    if (!btn) return;
    runShortcut(btn.dataset.keyseq);
});

stage?.addEventListener('pointerdown', () => {
    stage.focus({ preventScroll: true });
    notifyParentActivity();
});
ctrlAltDelBtn.addEventListener('click', sendCtrlAltDel);
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

fitBtn.classList.add('active');
setStatus('connecting');
connect();
