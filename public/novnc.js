import RFB from '/vendor/novnc/core/rfb.js';
import KeyTable from '/vendor/novnc/core/input/keysym.js';

const $ = (sel) => document.querySelector(sel);
const NOVNC_CLIENT_VERSION = '2026-06-14-vnc-redesign';
console.info('[novnc-client]', 'script loaded', { version: NOVNC_CLIENT_VERSION });

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const statusCard = $('#statusCard') || document.querySelector('.novnc-topbar');
const connInfo = $('#connInfo');
const connTitle = $('#connTitle');
const overlay = $('#novncOverlay');
const overlayTitle = $('#overlayTitle');
const overlayMsg = $('#overlayMsg');
const stage = $('#novncStage');
const screenShell = $('#screenShell');
const screen = $('#screen');
const qualityBtn = $('#qualityBtn');
const qualityLabel = $('#qualityLabel');
const fitBtn = $('#fitBtn');
const fitLabel = $('#fitLabel');
const dragBtn = $('#dragBtn');
const clipboardBtn = $('#clipboardBtn');
const keyboardBtn = $('#keyboardBtn');
const shortcutsBtn = $('#shortcutsBtn');
const cadBtn = $('#cadBtn');
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
let rfb = null;
let connected = false;
let manualClose = false;
let reconnecting = false;
let mobileComposing = false;
let lastRemoteClipboard = '';
let vncLastFrameAt = 0;
let qualityMode = localStorage.getItem('zephyr-novnc-quality') || 'balanced';
let fitMode = localStorage.getItem('zephyr-novnc-fit') || 'fit';

const qualityModes = ['balanced', 'performance', 'quality'];
const fitModes = ['fit', 'original', 'drag'];

function loadParams() {
    const key = tabId ? `zephyr_remote_desktop_params_${tabId}` : 'zephyr_remote_desktop_params';
    try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; }
}

function notifyParentStatus(status) {
    if (!embeddedMode || !window.parent || window.parent === window) return;
    window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId || tabId, status }, '*');
}

function notifyParentActivity() {
    if (!embeddedMode || !window.parent || window.parent === window) return;
    window.parent.postMessage({ source: 'zephyr-terminal', type: 'activity', tabId: params?.tabId || tabId }, '*');
}

function notifyParentAiActionResult(actionId, payload = {}) {
    if (!embeddedMode || !window.parent || window.parent === window || !actionId) return;
    window.parent.postMessage({
        source: 'zephyr-terminal',
        type: 'ai-remote-desktop-action-result',
        tabId: params?.tabId || tabId,
        actionId,
        ...payload,
    }, '*');
}

function notifyParentCloseRequest(reason = 'novnc-disconnected') {
    if (!embeddedMode || !window.parent || window.parent === window) return;
    window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId || tabId, reason }, '*');
}

function connectionLabel() {
    const host = params.host || 'VNC';
    const port = params.port || 5900;
    return `${host}:${port}`;
}

function setStatus(state, message = '') {
    const stateForParent = state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'closed' : 'connecting';
    notifyParentStatus(stateForParent);
    statusDot.className = 'status-dot';
    statusCard?.classList.remove('connected', 'error', 'connecting');
    if (state === 'connected') {
        connected = true;
        statusDot.classList.add('connected');
        statusCard?.classList.add('connected');
        statusText.textContent = message || 'VNC 已连接';
        overlay.classList.add('hidden');
    } else if (state === 'error') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusCard?.classList.add('error');
        statusText.textContent = '连接失败';
        overlayTitle.textContent = 'noVNC 连接失败';
        overlayMsg.textContent = message || '无法建立 VNC 连接';
        overlay.classList.remove('hidden');
    } else if (state === 'disconnected') {
        connected = false;
        statusDot.classList.add('disconnected');
        statusText.textContent = message || '已断开';
        overlayTitle.textContent = '连接已断开';
        overlayMsg.textContent = message || 'VNC 连接已断开';
        overlay.classList.remove('hidden');
    } else {
        connected = false;
        statusCard?.classList.add('connecting');
        statusText.textContent = message || '连接中...';
        overlayTitle.textContent = '正在建立 noVNC 连接';
        overlayMsg.textContent = message || '通过 Zephyr 安全代理连接 VNC，密码不会发送到浏览器。';
        overlay.classList.remove('hidden');
    }
}

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ connectionId: params.connectionId || urlParams.get('connectionId') || '', tabId: params.tabId || tabId });
    return `${proto}//${location.host}/novnc?${q.toString()}`;
}

function qualityConfig(mode = qualityMode) {
    if (mode === 'performance') return { label: '性能', quality: 4, compression: 1 };
    if (mode === 'quality') return { label: '画质', quality: 9, compression: 6 };
    return { label: '平衡', quality: 6, compression: 2 };
}

function fitLabelText(mode = fitMode) {
    if (mode === 'original') return '原始';
    if (mode === 'drag') return '拖拽';
    return '适应';
}

function applyDisplayOptions() {
    const q = qualityConfig();
    qualityLabel.textContent = q.label;
    fitLabel.textContent = fitLabelText();
    dragBtn.classList.toggle('active', fitMode === 'drag');
    screenShell.classList.toggle('fit-mode', fitMode === 'fit');
    screenShell.classList.toggle('original-mode', fitMode === 'original');
    screenShell.classList.toggle('drag-mode', fitMode === 'drag');
    if (!rfb) return;
    rfb.qualityLevel = q.quality;
    rfb.compressionLevel = q.compression;
    rfb.scaleViewport = fitMode === 'fit';
    rfb.clipViewport = fitMode === 'drag';
    rfb.dragViewport = fitMode === 'drag';
    rfb.resizeSession = false;
}

function clearScreen() {
    try { screen.innerHTML = ''; } catch {}
}

function captureCanvasSnapshotForAi(source, options = {}) {
    if (!source || !source.width || !source.height) return { error: '当前远程桌面画面还没有可读取的 canvas' };
    const maxWidth = Math.max(320, Math.min(1600, Number(options.maxWidth) || 960));
    const quality = Math.max(0.28, Math.min(0.86, Number(options.quality) || 0.55));
    const scale = Math.min(1, maxWidth / Math.max(1, source.width));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);
        return { dataUrl: canvas.toDataURL('image/jpeg', quality), width, height, originalWidth: source.width, originalHeight: source.height };
    } catch (err) {
        return { error: err.message || String(err) };
    }
}
function getRemoteDesktopSnapshotForAi(options = {}) {
    const source = screen?.querySelector?.('canvas');
    const frameAt = source ? Date.now() : 0;
    if (source) vncLastFrameAt = frameAt;
    const shot = captureCanvasSnapshotForAi(source, options);
    return {
        protocol: 'VNC',
        tabId: params?.tabId || tabId,
        connectionId: params?.connectionId || '',
        host: params?.host || '',
        port: params?.port || 5900,
        status: statusText?.textContent || '',
        title: connTitle?.textContent || connInfo?.textContent || '',
        connected,
        at: Date.now(),
        frameAt,
        ...shot,
    };
}
window.__zephyrGetRemoteDesktopSnapshot = getRemoteDesktopSnapshotForAi;

async function connect() {
    manualClose = false;
    reconnecting = false;
    params = loadParams();
    if (params.host) connTitle.textContent = `${params.name || 'VNC 远程桌面'} · ${connectionLabel()}`;
    setStatus('connecting', `正在连接 ${connectionLabel()}...`);
    clearScreen();
    try {
        if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }
        rfb = new RFB(screen, wsUrl(), { shared: true, credentials: {} });
        rfb.background = 'transparent';
        rfb.focusOnClick = true;
        applyDisplayOptions();
        rfb.addEventListener('connect', () => {
            setStatus('connected', 'VNC 已连接');
            notifyParentActivity();
            window.setTimeout(() => rfb?.focus?.(), 80);
        });
        rfb.addEventListener('disconnect', (event) => {
            const clean = event?.detail?.clean;
            const message = clean ? 'VNC 已断开' : 'VNC 异常断开';
            if (manualClose) {
                setStatus('disconnected', 'VNC 已断开');
                notifyParentCloseRequest('novnc-disconnect-button');
                return;
            }
            setStatus(clean ? 'disconnected' : 'error', message);
        });
        rfb.addEventListener('securityfailure', (event) => {
            const reason = event?.detail?.reason || 'VNC 安全协商失败';
            setStatus('error', reason);
        });
        rfb.addEventListener('credentialsrequired', () => {
            console.warn('[novnc-client]', 'unexpected credentials request; proxy should authenticate server-side');
            rfb?.sendCredentials?.({ password: '' });
        });
        rfb.addEventListener('clipboard', (event) => {
            const text = event?.detail?.text || '';
            lastRemoteClipboard = text;
            remoteClipboardText.value = text;
            clipboardHint.textContent = text ? `收到 ${text.length} 字符` : '收到空剪贴板';
            navigator.clipboard?.writeText?.(text).catch(() => {});
        });
        rfb.addEventListener('desktopname', (event) => {
            const name = event?.detail?.name || '';
            if (name) connTitle.textContent = `${name} · ${connectionLabel()}`;
        });
        rfb.addEventListener('bell', () => {
            stage.classList.add('bell');
            window.setTimeout(() => stage.classList.remove('bell'), 280);
        });
    } catch (err) {
        setStatus('error', err.message || 'noVNC 初始化失败');
    }
}

function disconnect({ closeTab = false } = {}) {
    manualClose = closeTab;
    try { rfb?.disconnect?.(); } catch {}
    if (closeTab) {
        setStatus('disconnected', 'VNC 已断开');
        notifyParentCloseRequest('novnc-disconnect-button');
    }
}

function reconnect() {
    reconnecting = true;
    manualClose = false;
    setStatus('connecting', `正在重连 ${connectionLabel()}...`);
    try { rfb?.disconnect?.(); } catch {}
    window.setTimeout(connect, 260);
}

function cycleQuality(mode = '') {
    const next = qualityModes.includes(String(mode || '')) ? String(mode) : qualityModes[(qualityModes.indexOf(qualityMode) + 1) % qualityModes.length];
    qualityMode = next;
    localStorage.setItem('zephyr-novnc-quality', qualityMode);
    applyDisplayOptions();
}

function cycleFit(mode = '') {
    let next = String(mode || '').toLowerCase();
    if (next === '1:1') next = 'original';
    fitMode = fitModes.includes(next) ? next : fitModes[(fitModes.indexOf(fitMode) + 1) % fitModes.length];
    localStorage.setItem('zephyr-novnc-fit', fitMode);
    applyDisplayOptions();
}

function toggleDragMode() {
    fitMode = fitMode === 'drag' ? 'fit' : 'drag';
    localStorage.setItem('zephyr-novnc-fit', fitMode);
    applyDisplayOptions();
}

function bringPanelToFront(panel) {
    if (!panel) return;
    const wasFront = panel.classList.contains('front');
    [clipboardPanel, shortcutsPanel].filter(Boolean).forEach((item) => {
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
}
function openPanel(panel) {
    [clipboardPanel, shortcutsPanel].forEach((item) => {
        if (!item) return;
        const show = item === panel && item.hidden;
        item.hidden = !show;
        item.classList.toggle('open', show);
        item.classList.toggle('panel-opening', show);
        item.classList.remove('panel-closing');
        if (show) {
            ensurePanelPosition(item);
            bringPanelToFront(item);
            window.setTimeout(() => item.classList.remove('panel-opening'), 420);
        }
    });
    clipboardBtn?.classList.toggle('active', clipboardPanel && !clipboardPanel.hidden);
    shortcutsBtn?.classList.toggle('active', shortcutsPanel && !shortcutsPanel.hidden);
}

function closePanel(id) {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.classList.remove('open', 'panel-opening');
    panel.classList.add('panel-closing');
    window.setTimeout(() => { panel.hidden = true; panel.classList.remove('panel-closing', 'front'); }, 260);
    clipboardBtn?.classList.toggle('active', clipboardPanel && !clipboardPanel.hidden && panel !== clipboardPanel);
    shortcutsBtn?.classList.toggle('active', shortcutsPanel && !shortcutsPanel.hidden && panel !== shortcutsPanel);
}

function sendKey(keysym, code = '', down = undefined) {
    if (!rfb || !connected) return;
    rfb.sendKey(keysym, code, down);
    notifyParentActivity();
}

function tapKey(keysym, code = '') { sendKey(keysym, code); }
function down(keysym, code = '') { sendKey(keysym, code, true); }
function up(keysym, code = '') { sendKey(keysym, code, false); }

function charKeysym(ch) {
    if (!ch) return 0;
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0xff) return code;
    return 0;
}

function sendText(text) {
    if (!text || !rfb || !connected) return;
    const value = String(text);
    if (/[^\u0008\u0009\u000a\u000d\u0020-\u00ff]/.test(value) || value.length > 24) {
        rfb.clipboardPasteFrom(value);
        clipboardHint.textContent = `已发送 ${value.length} 字符到远程剪贴板，请在远程粘贴`;
        return;
    }
    for (const ch of value) {
        if (ch === '\n' || ch === '\r') tapKey(KeyTable.XK_Return, 'Enter');
        else if (ch === '\t') tapKey(KeyTable.XK_Tab, 'Tab');
        else if (ch === '\b') tapKey(KeyTable.XK_BackSpace, 'Backspace');
        else {
            const ks = charKeysym(ch);
            if (ks) tapKey(ks, '');
            else rfb.clipboardPasteFrom(ch);
        }
    }
}

function sendSequence(seq) {
    const s = String(seq || '').toLowerCase();
    const special = {
        esc: [KeyTable.XK_Escape, 'Escape'], tab: [KeyTable.XK_Tab, 'Tab'], enter: [KeyTable.XK_Return, 'Enter'], backspace: [KeyTable.XK_BackSpace, 'Backspace'], delete: [KeyTable.XK_Delete, 'Delete'],
        up: [KeyTable.XK_Up, 'ArrowUp'], down: [KeyTable.XK_Down, 'ArrowDown'], left: [KeyTable.XK_Left, 'ArrowLeft'], right: [KeyTable.XK_Right, 'ArrowRight'],
        home: [KeyTable.XK_Home, 'Home'], end: [KeyTable.XK_End, 'End'], pageup: [KeyTable.XK_Page_Up, 'PageUp'], pagedown: [KeyTable.XK_Page_Down, 'PageDown'],
        super: [KeyTable.XK_Super_L, 'MetaLeft'], win: [KeyTable.XK_Super_L, 'MetaLeft'],
    };
    if (s === 'ctrl-alt-del') { rfb?.sendCtrlAltDel?.(); return; }
    if (s === 'alt-tab') {
        down(KeyTable.XK_Alt_L, 'AltLeft'); tapKey(KeyTable.XK_Tab, 'Tab'); up(KeyTable.XK_Alt_L, 'AltLeft'); return;
    }
    if (s === 'win-r') {
        down(KeyTable.XK_Super_L, 'MetaLeft'); tapKey('r'.charCodeAt(0), 'KeyR'); up(KeyTable.XK_Super_L, 'MetaLeft'); return;
    }
    const fn = s.match(/^f(\d{1,2})$/);
    if (fn) {
        const n = Number(fn[1]);
        if (n >= 1 && n <= 12) tapKey(KeyTable[`XK_F${n}`], `F${n}`);
        return;
    }
    const ctrl = s.match(/^ctrl-([a-z])$/);
    if (ctrl) {
        const letter = ctrl[1];
        down(KeyTable.XK_Control_L, 'ControlLeft'); tapKey(letter.charCodeAt(0), `Key${letter.toUpperCase()}`); up(KeyTable.XK_Control_L, 'ControlLeft'); return;
    }
    if (special[s]) tapKey(special[s][0], special[s][1]);
}

function focusMobileKeyboard() {
    mobileKeyboardInput.value = '';
    mobileKeyboardInput.focus({ preventScroll: true });
}

function setupMobileInput() {
    mobileKeyboardInput.addEventListener('compositionstart', () => { mobileComposing = true; });
    mobileKeyboardInput.addEventListener('compositionend', (event) => {
        mobileComposing = false;
        sendText(event.data || mobileKeyboardInput.value || '');
        mobileKeyboardInput.value = '';
    });
    mobileKeyboardInput.addEventListener('beforeinput', (event) => {
        if (event.inputType?.startsWith('delete')) {
            event.preventDefault();
            tapKey(KeyTable.XK_BackSpace, 'Backspace');
        }
    });
    mobileKeyboardInput.addEventListener('input', () => {
        if (mobileComposing) return;
        const value = mobileKeyboardInput.value;
        if (value) sendText(value);
        mobileKeyboardInput.value = '';
    });
}

function setupClipboard() {
    clipboardSendBtn.addEventListener('click', () => {
        if (!rfb || !connected) return;
        const text = clipboardText.value || '';
        rfb.clipboardPasteFrom(text);
        clipboardHint.textContent = `已发送 ${text.length} 字符到远程剪贴板`;
    });
    clipboardReadLocalBtn.addEventListener('click', async () => {
        try { clipboardText.value = await navigator.clipboard.readText(); }
        catch (err) { clipboardHint.textContent = err.message || '读取本机剪贴板失败'; }
    });
    clipboardCopyRemoteBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(remoteClipboardText.value || lastRemoteClipboard || ''); clipboardHint.textContent = '已复制到本机剪贴板'; }
        catch (err) { clipboardHint.textContent = err.message || '复制失败'; }
    });
    window.addEventListener('paste', (event) => {
        if (!connected || document.activeElement === clipboardText || document.activeElement === remoteClipboardText) return;
        const text = event.clipboardData?.getData('text/plain') || '';
        if (text) { event.preventDefault(); sendText(text); }
    });
}

function panelDefaults(panel) {
    const parent = stage?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    const compact = Math.min(window.innerWidth, window.innerHeight) <= 700;
    if (compact) return { left: 8, top: 44, width: Math.max(280, parent.width - 16), height: Math.max(260, Math.min(parent.height - 58, panel === shortcutsPanel ? 360 : 430)) };
    if (panel === shortcutsPanel) return { width: Math.min(460, parent.width - 24), height: Math.min(360, parent.height - 80), left: 18, top: 54 };
    return { width: Math.min(440, parent.width - 24), height: Math.min(500, parent.height - 80), left: Math.max(18, parent.width - 460), top: 54 };
}
function ensurePanelPosition(panel) {
    if (!panel || panel.dataset.floatingReady === '1') return;
    const d = panelDefaults(panel);
    Object.assign(panel.style, { left: `${d.left}px`, top: `${d.top}px`, right: 'auto', bottom: 'auto', width: `${d.width}px`, height: `${d.height}px` });
    panel.dataset.floatingReady = '1';
}
function clampPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parent = stage.getBoundingClientRect();
    const minVisible = Math.min(window.innerWidth, window.innerHeight) <= 700 ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parent.left, -rect.width + minVisible), parent.width - minVisible);
    const top = Math.min(Math.max(rect.top - parent.top, 8), parent.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parent = stage.getBoundingClientRect();
    const compact = Math.min(window.innerWidth, window.innerHeight) <= 700;
    const margin = compact ? 6 : 12;
    const topbar = compact ? 38 : 52;
    let left = margin, top = topbar, width = parent.width - margin * 2, height = parent.height - topbar - margin;
    if (layout === 'half') { width = parent.width; height = Math.max(260, parent.height / 2); left = 0; top = parent.height - height; }
    else if (layout === 'left-quarter') { width = Math.max(260, parent.width / 4); height = parent.height - topbar; left = 0; top = topbar; }
    else if (layout === 'right-quarter') { width = Math.max(260, parent.width / 4); height = parent.height - topbar; left = parent.width - width; top = topbar; }
    panel.classList.add('layout-animating');
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px` });
    bringPanelToFront(panel);
    window.clearTimeout(panel._layoutAnimationTimer);
    panel._layoutAnimationTimer = window.setTimeout(() => { panel.classList.remove('layout-animating'); clampPanel(panel); }, 480);
}
let panelLayoutMenu = null;
let panelLayoutButton = null;
function closePanelLayoutMenu({ instant = false } = {}) {
    const menu = panelLayoutMenu;
    const button = panelLayoutButton;
    if (!menu) { button?.classList.remove('active-layout'); panelLayoutButton = null; return; }
    button?.classList.remove('active-layout');
    button?.style.removeProperty('opacity');
    menu.remove();
    panelLayoutMenu = null;
    panelLayoutButton = null;
}
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    const rect = button.getBoundingClientRect();
    const vw = window.visualViewport?.width || window.innerWidth;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vw - 16));
    menu.style.left = `${collapsed ? rect.left : anchorX - finalWidth / 2}px`;
    menu.style.top = `${rect.top}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : 50}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
}
function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.innerHTML = '<button data-layout="full" title="全屏"><span class="panel-layout-icon full"></span></button><button data-layout="half" title="半屏"><span class="panel-layout-icon half"></span></button><button data-layout="left-quarter" title="左侧四分之一"><span class="panel-layout-icon left"></span></button><button data-layout="right-quarter" title="右侧四分之一"><span class="panel-layout-icon right"></span></button><button data-layout="close" class="panel-layout-close" title="关闭窗口"><span class="panel-layout-icon close"></span></button>';
    document.body.appendChild(menu);
    panelLayoutMenu = menu;
    positionPanelLayoutMenu(menu, button, { collapsed: true });
    button.classList.add('active-layout');
    button.style.opacity = '0';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => { menu.classList.add('island-open'); positionPanelLayoutMenu(menu, button, { collapsed: false }); window.setTimeout(() => menu.classList.remove('island-animating'), 540); });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') closePanel(panel.id);
        else { applyPanelLayout(panel, item.dataset.layout); closePanelLayoutMenu(); }
    });
}
function makeDraggable(panel) {
    ensurePanelPosition(panel);
    const handles = [panel?.querySelector('[data-drag-panel]'), panel?.querySelector('.panel-titlebar')].filter(Boolean);
    handles.forEach((head) => {
        head.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button,input,select,textarea,label')) return;
            event.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
            const move = (ev) => { ev.preventDefault(); panel.style.left = `${start.left + ev.clientX - start.x}px`; panel.style.top = `${start.top + ev.clientY - start.y}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto'; clampPanel(panel); };
            const end = () => { panel.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
            window.addEventListener('pointermove', move, { passive: false });
            window.addEventListener('pointerup', end, { once: true });
        });
    });
    panel.querySelectorAll('[data-layout-panel]').forEach((button) => {
        button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); bringPanelToFront(panel); if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu(); else openPanelLayoutMenu(button, panel); });
    });
    panel.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault(); event.stopPropagation(); bringPanelToFront(panel); panel.classList.add('resizing');
            const start = { x: event.clientX, y: event.clientY, width: panel.offsetWidth, height: panel.offsetHeight, left: panel.offsetLeft };
            const edge = handle.dataset.resizeEdge || 'right';
            const parent = stage.getBoundingClientRect();
            const minWidth = Math.min(window.innerWidth, window.innerHeight) <= 700 ? 260 : 320;
            const minHeight = Math.min(window.innerWidth, window.innerHeight) <= 700 ? 220 : 260;
            const move = (ev) => {
                ev.preventDefault();
                let width = start.width + ev.clientX - start.x;
                let left = start.left;
                if (edge === 'left') { width = start.width - (ev.clientX - start.x); left = start.left + (ev.clientX - start.x); if (width < minWidth) { left -= minWidth - width; width = minWidth; } panel.style.left = `${Math.max(8, left)}px`; }
                panel.style.width = `${Math.min(Math.max(minWidth, width), parent.width - panel.offsetLeft - 12)}px`;
                panel.style.height = `${Math.min(Math.max(minHeight, start.height + ev.clientY - start.y), parent.height - panel.offsetTop - 12)}px`;
            };
            const end = () => { panel.classList.remove('resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
            window.addEventListener('pointermove', move, { passive: false });
            window.addEventListener('pointerup', end, { once: true });
        });
    });
    panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
}

function sleep(ms = 0) { return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

async function clickRemotePoint(x, y, button = 1) {
    const canvas = screen?.querySelector?.('canvas');
    const target = canvas || screen;
    const rect = target?.getBoundingClientRect?.();
    if (!target || !rect || rect.width <= 0 || rect.height <= 0) return false;
    const remoteWidth = canvas?.width || rect.width;
    const remoteHeight = canvas?.height || rect.height;
    const clientX = rect.left + Math.max(0, Math.min(remoteWidth - 1, Number(x) || 0)) * rect.width / Math.max(1, remoteWidth);
    const clientY = rect.top + Math.max(0, Math.min(remoteHeight - 1, Number(y) || 0)) * rect.height / Math.max(1, remoteHeight);
    const btn = Math.max(0, Math.min(2, Number(button || 1) - 1));
    ['mousemove', 'mousedown', 'mouseup', 'click'].forEach((type) => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY, button: btn, buttons: type === 'mousedown' ? (1 << btn) : 0 }));
    });
    notifyParentActivity();
    return true;
}

async function performAiRemoteDesktopAction(data = {}) {
    const control = String(data.control || '').toLowerCase().replace(/-/g, '_');
    const text = String(data.text || '');
    if (control === 'quality') { cycleQuality(data.qualityMode || ''); return { ok: true, control, qualityMode }; }
    if (control === 'fit') { cycleFit(data.fitMode || ''); return { ok: true, control, fitMode }; }
    if (control === 'joystick' || control === 'drag') { toggleDragMode(); return { ok: true, control, fitMode }; }
    if (control === 'clipboard') { openPanel(clipboardPanel); clipboardText?.focus?.(); return { ok: true, control, panel: 'clipboard' }; }
    if (control === 'keyboard') { focusMobileKeyboard(); return { ok: true, control }; }
    if (control === 'shortcuts') { openPanel(shortcutsPanel); return { ok: true, control, panel: 'shortcuts' }; }
    if (control === 'ctrl_alt_del' || control === 'cad') { rfb?.sendCtrlAltDel?.(); notifyParentActivity(); return { ok: true, control: 'ctrl_alt_del' }; }
    if (control === 'reconnect') { reconnect(); return { ok: true, control }; }
    if (control === 'disconnect') { disconnect({ closeTab: true }); return { ok: true, control }; }
    if (control === 'clipboard_read_local') {
        try { clipboardText.value = await navigator.clipboard.readText(); clipboardHint.textContent = '已读取本机剪贴板'; return { ok: true, control, length: clipboardText.value.length }; }
        catch (err) { clipboardHint.textContent = err.message || '读取本机剪贴板失败'; throw err; }
    }
    if (control === 'clipboard_copy_remote') {
        try { const value = remoteClipboardText.value || lastRemoteClipboard || ''; await navigator.clipboard.writeText(value); clipboardHint.textContent = '已复制到本机剪贴板'; return { ok: true, control, length: value.length }; }
        catch (err) { clipboardHint.textContent = err.message || '复制失败'; throw err; }
    }
    if (control === 'clipboard_send') {
        if (!rfb || !connected) throw new Error('VNC 尚未连接，无法发送剪贴板');
        if (clipboardText && text) clipboardText.value = text;
        const value = text || clipboardText?.value || '';
        if (!value) throw new Error('VNC 剪贴板文本为空');
        rfb.clipboardPasteFrom(value);
        clipboardHint.textContent = `已发送 ${value.length} 字符到远程剪贴板`;
        if (data.paste !== false) { await sleep(80); sendSequence('ctrl-v'); }
        return { ok: true, control, length: value.length, paste: data.paste !== false };
    }
    if (control === 'shortcut') {
        if (!rfb || !connected) throw new Error('VNC 尚未连接，无法发送快捷键');
        sendSequence(data.sequence || text);
        return { ok: true, control, sequence: data.sequence || text || '' };
    }
    if (control === 'text') {
        if (!rfb || !connected) throw new Error('VNC 尚未连接，无法输入文本');
        if (!text) throw new Error('VNC 输入文本为空');
        if (data.paste !== false) {
            rfb?.clipboardPasteFrom?.(text);
            clipboardHint.textContent = `已发送 ${text.length} 字符到远程剪贴板`;
            await sleep(80);
            sendSequence('ctrl-v');
        } else sendText(text);
        return { ok: true, control, length: text.length, paste: data.paste !== false };
    }
    if (control === 'mouse_click') {
        const x = Math.round(Number(data.x));
        const y = Math.round(Number(data.y));
        const button = Number(data.button) || 1;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('AI 远程桌面点击缺少 x/y');
        const ok = await clickRemotePoint(x, y, button);
        if (!ok) throw new Error('远程画面尚未准备好，无法点击坐标');
        clipboardHint.textContent = `AI 已点击 ${x}, ${y}`;
        return { ok: true, control, x, y, button };
    }
    throw new Error(`未知远程桌面 UI 动作：${control}`);
}

function bindEvents() {
    qualityBtn.addEventListener('click', cycleQuality);
    fitBtn.addEventListener('click', cycleFit);
    dragBtn.addEventListener('click', toggleDragMode);
    clipboardBtn.addEventListener('click', () => openPanel(clipboardPanel));
    shortcutsBtn.addEventListener('click', () => openPanel(shortcutsPanel));
    keyboardBtn.addEventListener('click', focusMobileKeyboard);
    cadBtn.addEventListener('click', () => rfb?.sendCtrlAltDel?.());
    reconnectBtn.addEventListener('click', reconnect);
    disconnectBtn.addEventListener('click', () => disconnect({ closeTab: true }));
    shortcutGrid.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-keyseq]');
        if (btn) sendSequence(btn.dataset.keyseq);
    });
    document.addEventListener('click', (event) => {
        const close = event.target.closest('[data-close-panel]');
        if (close) closePanel(close.dataset.closePanel);
    });
    document.addEventListener('pointerdown', (event) => {
        if (panelLayoutMenu && !event.target.closest('.panel-layout-menu') && !event.target.closest('[data-layout-panel]')) closePanelLayoutMenu();
    });
    window.addEventListener('resize', () => closePanelLayoutMenu({ instant: true }));
    screenShell.addEventListener('pointerdown', () => { rfb?.focus?.(); notifyParentActivity(); }, { passive: true });
    stage.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.altKey && event.key === 'Delete') { event.preventDefault(); rfb?.sendCtrlAltDel?.(); }
    });
    window.addEventListener('message', (event) => {
        if (event.data?.source !== 'zephyr-app') return;
        if (event.data.type === 'reconnect-terminal') reconnect();
        if (event.data.type === 'focus-terminal') rfb?.focus?.();
        if (event.data.type === 'ai-remote-desktop-action') {
            const actionId = String(event.data.actionId || '');
            performAiRemoteDesktopAction(event.data).then((result = {}) => {
                notifyParentAiActionResult(actionId, { ok: true, control: event.data?.control || '', result });
            }).catch((err) => {
                console.warn('[novnc-client]', 'AI remote desktop action failed', { error: err.message, control: event.data?.control });
                clipboardHint.textContent = err.message || 'AI 远程桌面操作失败';
                notifyParentAiActionResult(actionId, { ok: false, control: event.data?.control || '', error: err.message || 'AI 远程桌面操作失败' });
            });
        }
    });
    window.addEventListener('beforeunload', () => { try { rfb?.disconnect?.(); } catch {} });
    setupMobileInput();
    setupClipboard();
    makeDraggable(clipboardPanel);
    makeDraggable(shortcutsPanel);
}

applyDisplayOptions();
bindEvents();
connect();
