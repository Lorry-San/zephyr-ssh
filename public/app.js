const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let connections = [], activities = [], proxies = [], jumpHosts = [], sshKeys = [], settings = {};
let editingId = null;
let editingSecretLoaded = false;
let connectionModalTrigger = null;
let connectionModalOriginRect = null;
let terminalTabs = [], activeTerminalTab = null;
let openOrderStack = [], visualLayout = [], recentUseStack = [];
let terminalSmartbarOpen = false;
let terminalSmartbarSide = 'center';
let terminalSmartbarPickerOpen = false;
let terminalSmartbarTimer = 0;
let terminalSmartbarClosing = false;
let smartbarDragState = null;
let suppressSmartbarClick = false;
let smartbarHoverWindowId = null;
let dockSwapAnimatingWindows = new Set();
let dockLaunchAnimatingWindows = new Set();
let terminalDragState = null;
let terminalControlLongPress = false;
let fullscreenLoadingTimer = 0;
let appKeyboardBaseline = 0;
let appKeyboardOpen = false;
let closingTerminalTabs = new Set();
let minimizingTerminalTabs = new Set();
let securityStatus = { user: {}, passkeys: [] }, ipBans = [], loginEvents = [];

const SMARTBAR_AUTO_HIDE_MS = 30000;
const TERMINAL_EDGE_SNAP_PX = 56;
const DEFAULT_BRAND_NAME = 'Zephyr';
const DEFAULT_BRAND_ICON = '🌬️';
let pendingBrandIcon = DEFAULT_BRAND_ICON;

function api(path, options = {}) {
    return fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || data.message || '请求失败'); return data; });
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
const systemThemeQuery = matchMedia('(prefers-color-scheme: dark)');
function getSystemTheme() { return systemThemeQuery.matches ? 'dark' : 'light'; }
function getAppearance() { return settings?.appearance || {}; }
function isAutoThemeEnabled() { return getAppearance().autoThemeEnabled !== false; }
function getPreferredTheme() {
    const appearance = getAppearance();
    if (isAutoThemeEnabled() || appearance.theme === 'auto') return getSystemTheme();
    if (appearance.theme === 'light' || appearance.theme === 'dark') return appearance.theme;
    const saved = localStorage.getItem('zephyr-theme');
    return saved === 'light' || saved === 'dark' ? saved : getSystemTheme();
}
function postTerminalLayoutStabilize(reason = 'layout-stabilize', { focus = false, tabId = activeTerminalTab } = {}) {
    const workspace = $('#terminalWorkspace');
    const frames = tabId
        ? $$(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)
        : $$('#terminalWorkspace iframe.terminal-frame');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const workspaceRect = workspace?.getBoundingClientRect?.();
    console.info('[TerminalLayoutDiagnostics]', {
        event: 'parent:layout-stabilize',
        reason,
        focus,
        tabId,
        frames: frames.length,
        workspace: workspaceRect ? {
            width: Math.round(workspaceRect.width),
            height: Math.round(workspaceRect.height),
            top: Math.round(workspaceRect.top),
            left: Math.round(workspaceRect.left),
        } : null,
        fullscreen: !!fullscreenElement,
        customFullscreen: !!workspace?.classList.contains('custom-fullscreen'),
        keyboardOpen: !!workspace?.classList.contains('keyboard-open'),
        appKeyboardOpen,
        appKeyboardBaseline,
        visualViewport: window.visualViewport ? {
            width: Math.round(window.visualViewport.width || 0),
            height: Math.round(window.visualViewport.height || 0),
            offsetTop: Math.round(window.visualViewport.offsetTop || 0),
            offsetLeft: Math.round(window.visualViewport.offsetLeft || 0),
        } : null,
    });
    frames.forEach((frame) => frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'layout-stabilize', reason, focus }, '*'));
}
function scheduleTerminalLayoutStabilize(reason = 'layout-stabilize', options = {}) {
    window.clearTimeout(scheduleTerminalLayoutStabilize._timer);
    scheduleTerminalLayoutStabilize._timer = window.setTimeout(() => {
        [0, 80, 220, 520].forEach((delay, index) => {
            window.setTimeout(() => postTerminalLayoutStabilize(`${reason}:phase-${index}`, options), delay);
        });
    }, 24);
}
function broadcastThemeToTerminals(theme) { $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'theme-change', theme }, '*')); scheduleTerminalLayoutStabilize('theme-change', { focus: false, tabId: null }); }
function applyTheme(theme, { persist = false } = {}) {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme') || getSystemTheme();
    const changed = previousTheme !== theme;
    root.classList.remove('theme-transitioning');
    void root.offsetWidth;
    root.classList.add('theme-transitioning');
    document.body?.classList.toggle('theme-ripple-active', changed);
    window.clearTimeout(applyTheme._timer);
    applyTheme._timer = window.setTimeout(() => {
        root.classList.remove('theme-transitioning');
        document.body?.classList.remove('theme-ripple-active');
    }, 460);
    root.setAttribute('data-theme', theme);
    if (persist) localStorage.setItem('zephyr-theme', theme);
    $('#appThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    $('#settingsThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    console.debug('[appearance-client]', 'theme transition applied', { previousTheme, theme, changed });
    broadcastThemeToTerminals(theme);
}
async function toggleTheme() {
    const nextTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('zephyr-theme', nextTheme);
    const appearance = { ...getAppearance(), theme: nextTheme, autoThemeEnabled: false };
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ appearance }) }).catch((err) => { toast(err.message); return settings; });
    $('#autoThemeEnabled').checked = false;
    applyTheme(nextTheme, { persist: true });
    console.debug('[appearance-client]', 'manual theme selected', { theme: nextTheme, autoThemeEnabled: false });
}
function escapeHtml(str) { return String(str || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function iconHtml(icon = DEFAULT_BRAND_ICON) { return String(icon).startsWith('data:image/') ? `<img src="${icon}" alt="">` : escapeHtml(icon || DEFAULT_BRAND_ICON); }
function faviconHref(icon = DEFAULT_BRAND_ICON) {
    if (String(icon).startsWith('data:image/')) return icon;
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${icon || DEFAULT_BRAND_ICON}</text></svg>`)}`;
}
function setFavicon(icon = DEFAULT_BRAND_ICON) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = faviconHref(icon);
}
function applyAppearance(appearance = getAppearance()) {
    const brandName = String(appearance.brandName || DEFAULT_BRAND_NAME).trim() || DEFAULT_BRAND_NAME;
    const brandIcon = String(appearance.brandIcon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    pendingBrandIcon = brandIcon;
    $('#brandName').textContent = brandName;
    $('#brandIcon').innerHTML = iconHtml(brandIcon);
    $('#brandNameInput').value = brandName;
    $('#brandIconPreview').innerHTML = iconHtml(brandIcon);
    $('#autoThemeEnabled').checked = appearance.autoThemeEnabled !== false;
    document.title = brandName;
    setFavicon(brandIcon);
    console.debug('[appearance-client]', 'appearance applied', { brandName, customIcon: brandIcon !== DEFAULT_BRAND_ICON, autoThemeEnabled: appearance.autoThemeEnabled !== false, theme: appearance.theme || 'auto' });
}
function readImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve('');
        if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/i.test(file.type)) return reject(new Error('仅支持 PNG/JPEG/GIF/WebP/SVG 图标'));
        if (file.size > 512 * 1024) return reject(new Error('图标文件不能超过 512KB'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图标失败'));
        reader.readAsDataURL(file);
    });
}
async function saveAppearance(e) {
    e.preventDefault();
    const autoThemeEnabled = $('#autoThemeEnabled').checked;
    const theme = autoThemeEnabled ? 'auto' : (document.documentElement.getAttribute('data-theme') || getSystemTheme());
    const appearance = { ...getAppearance(), brandName: $('#brandNameInput').value.trim() || DEFAULT_BRAND_NAME, brandIcon: pendingBrandIcon || DEFAULT_BRAND_ICON, autoThemeEnabled, theme };
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ appearance }) });
    localStorage.removeItem('zephyr-theme');
    if (!autoThemeEnabled) localStorage.setItem('zephyr-theme', theme);
    applyAppearance(settings.appearance || appearance);
    applyTheme(getPreferredTheme());
    console.info('[appearance-client]', 'appearance saved', { brandName: appearance.brandName, customIcon: appearance.brandIcon !== DEFAULT_BRAND_ICON, autoThemeEnabled, theme });
    toast('外观设置已保存');
}
async function resetAppearance() {
    const appearance = { ...getAppearance(), brandName: DEFAULT_BRAND_NAME, brandIcon: DEFAULT_BRAND_ICON };
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ appearance }) });
    $('#brandIconFile').value = '';
    applyAppearance(settings.appearance || appearance);
    applyTheme(getPreferredTheme());
    console.info('[appearance-client]', 'brand reset to defaults');
    toast('名称和图标已重置');
}
function renderMarkdown(md) { let s = escapeHtml(md); s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); return s.replace(/\n/g, '<br>'); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '从未连接'; }
function requestSensitiveSecret(actionText = '查看已保存敏感信息') {
    const usingTotp = !!securityStatus.user?.totpEnabled;
    const message = usingTotp
        ? `${actionText}\n请输入 6 位 TOTP 动态验证码：`
        : `${actionText}\n请输入当前登录密码：`;
    const secret = prompt(message);
    if (secret === null) throw new Error('已取消验证');
    if (!String(secret).trim()) throw new Error(usingTotp ? '请输入动态验证码' : '请输入当前登录密码');
    console.debug('[secret-open]', 'sensitive reveal requested', { actionText, authType: usingTotp ? 'totp' : 'password' });
    return secret;
}
function switchView(name) {
    $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    const wasTerminal = document.body.classList.contains('terminal-mode');
    document.body.classList.toggle('terminal-mode', name === 'terminal');
    document.body.classList.toggle('terminal-mode-entering', name === 'terminal' && !wasTerminal);
    window.clearTimeout(switchView._navTimer);
    if (name === 'terminal') {
        switchView._navTimer = window.setTimeout(() => document.body.classList.remove('terminal-mode-entering'), 680);
        scheduleTerminalLayoutStabilize('switch-view-terminal', { focus: true });
    } else {
        document.body.classList.remove('terminal-mode-entering');
    }
}
function parseTags(v) { return String(v || '').split(',').map((x) => x.trim()).filter(Boolean); }
function base64urlToBuffer(value) { const s = String(value).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)); }
function bufferToBase64url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

function allTags() { return [...new Set(connections.flatMap((c) => c.tags || []))].sort(); }
function refreshTagFilter() { const old = $('#tagFilter').value; $('#tagFilter').innerHTML = '<option value="all">全部标签</option>' + allTags().map((t) => `<option ${old === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join(''); }
function filteredConnections() {
    const q = $('#searchInput').value.trim().toLowerCase(), proto = $('#protocolFilter').value, tag = $('#tagFilter').value, sort = $('#sortSelect').value;
    const list = connections.filter((c) => [c.name, c.host, c.remark, c.username, (c.tags || []).join(' ')].join(' ').toLowerCase().includes(q) && (proto === 'all' || c.protocol === proto) && (tag === 'all' || (c.tags || []).includes(tag)));
    return list.sort((a, b) => sort === 'name' ? String(a.name).localeCompare(String(b.name), 'zh-CN') : sort === 'protocol' ? String(a.protocol).localeCompare(String(b.protocol)) : (b[sort] || 0) - (a[sort] || 0));
}
function renderConnections() {
    refreshTagFilter();
    $('#connectionTitle').textContent = `连接列表 (${connections.length})`;
    const list = filteredConnections();
    $('#connectionGrid').innerHTML = list.length ? list.map((c) => `
        <article class="connection-card"><div class="card-top"><span class="protocol-badge">${escapeHtml(c.protocol)}</span><span class="last-time">${fmtTime(c.lastConnectedAt)}</span></div>
        <h2>${escapeHtml(c.name)}</h2><p class="host-line">${escapeHtml(c.host)}:${escapeHtml(c.port)} · ${c.connectionMode === 'proxy' ? '代理' : c.connectionMode === 'jump' ? '跳板机' : '直连'}</p>
        <div class="tag-row">${(c.tags || []).map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div><div class="remark-md">${renderMarkdown(c.remark || '暂无备注')}</div>
        <div class="card-actions"><button class="tool-btn" data-edit="${c.id}">编辑</button><button class="tool-btn danger" data-delete="${c.id}">删除</button><button class="btn btn-primary" data-connect="${c.id}">连接</button></div></article>`).join('') : '<div class="empty-card">暂无连接，点击右上角添加新连接。</div>';
    $('#activityList').innerHTML = activities.length ? activities.map((a) => `<div class="activity-item"><span>${fmtTime(a.time)}</span><b>${escapeHtml(a.message)}</b></div>`).join('') : '<div class="muted">暂无活动</div>';
    renderRemoteServers(); renderJumpOptions();
}
async function loadConnections() { const data = await api('/api/connections'); connections = data.connections || []; activities = data.activities || []; renderConnections(); }
function waitForConnectionCardExit(card, connectionId) {
    if (!card) return Promise.resolve();
    card.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    card.classList.add('deleting');
    console.debug('[connection-card]', 'delete exit animation start', { connectionId });
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            card.removeEventListener('animationend', finish);
            console.debug('[connection-card]', 'delete exit animation end', { connectionId });
            resolve();
        };
        card.addEventListener('animationend', finish, { once: true });
        window.setTimeout(finish, 380);
    });
}

function normalizeSelectedRouteIds(selected = '') {
    return Array.isArray(selected) ? selected.map(String).filter(Boolean) : String(selected || '').split(',').map((v) => v.trim()).filter(Boolean);
}
function normalizeRouteRowIds(selected = '') {
    const list = Array.isArray(selected) ? selected.map((v) => String(v || '')) : normalizeSelectedRouteIds(selected);
    return list.length ? list : [''];
}
function jumpConnectionOptions(selected = '') {
    const selectedId = String(selected || '');
    const currentEditingId = String(editingId || '');
    const list = connections.filter((c) => String(c.protocol || 'SSH').toUpperCase() === 'SSH' && String(c.id) !== currentEditingId);
    return '<option value="">请选择跳板机</option>' + list.map((c) => `<option value="${c.id}" ${selectedId === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.host)}:${escapeHtml(c.port)})</option>`).join('');
}
function renderJumpRouteRows(selectedIds = []) {
    const list = normalizeRouteRowIds(selectedIds);
    $('#jumpRouteList').innerHTML = list.map((id, index) => `
        <div class="jump-route-row" data-jump-route-row>
            <label>跳板机 ${index + 1}:</label>
            <select data-jump-route-select>${jumpConnectionOptions(id)}</select>
            <button type="button" class="jump-route-remove" data-remove-jump-route title="移除跳板机">×</button>
        </div>`).join('');
    console.debug('[route-ui]', 'render jump rows', { selectedIds: list, availableSshConnections: connections.filter((c) => String(c.protocol || 'SSH').toUpperCase() === 'SSH' && String(c.id) !== String(editingId || '')).length });
}
function setRouteMode(mode = 'direct', selected = '') {
    const nextMode = ['direct', 'proxy', 'jump'].includes(mode) ? mode : 'direct';
    $('#connMode').value = nextMode;
    $$('.route-type-tab').forEach((btn) => {
        const active = btn.dataset.routeMode === nextMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('#proxyRouteConfig')?.classList.toggle('force-hidden', nextMode !== 'proxy');
    $('#jumpRouteConfig')?.classList.toggle('force-hidden', nextMode !== 'jump');
    updateRouteOptions(nextMode, selected);
}
function renderSshKeyOptions(selected = '') {
    const select = $('#connSshKey');
    if (!select) return;
    const selectedId = String(selected || '');
    select.innerHTML = '<option value="">不使用密钥库</option>' + sshKeys.map((k) => `<option value="${k.id}" ${selectedId === String(k.id) ? 'selected' : ''}>${escapeHtml(k.name)}${k.hasPassphrase ? '（有口令）' : ''}</option>`).join('');
    select.value = selectedId;
    console.debug('[ssh-key-ui]', 'render connection key options', { selectedId, keyCount: sshKeys.length });
}

function updateRouteOptions(mode = $('#connMode').value, selected = '') {
    const selectedIds = normalizeSelectedRouteIds(selected);
    const route = $('#connRoute');
    if (route) {
        route.innerHTML = '<option value="">请选择代理服务器</option>' + proxies.map((p) => `<option value="${p.id}" ${selectedIds.includes(String(p.id)) ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.host)}:${escapeHtml(p.port)})</option>`).join('');
        route.value = mode === 'proxy' ? (selectedIds[0] || '') : '';
    }
    if (mode === 'jump') renderJumpRouteRows(selectedIds);
    console.debug('[route-ui]', 'update route options', { mode, selectedIds, proxyCount: proxies.length, connectionCount: connections.length });
}
function addJumpRouteRow() {
    const ids = $$('#jumpRouteList [data-jump-route-select]').map((el) => el.value);
    ids.push('');
    console.debug('[route-ui]', 'add jump row', { before: ids.slice(0, -1), after: ids });
    renderJumpRouteRows(ids);
}
function updateProtocolFields({ preservePort = true } = {}) {
    const protocol = $('#connProtocol')?.value || 'SSH';
    const portInput = $('#connPort');
    const usernameInput = $('#connUsername');
    const defaultPort = protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : 22;
    if (portInput && (!preservePort || !Number(portInput.value))) portInput.value = defaultPort;
    if (usernameInput) {
        usernameInput.required = protocol === 'SSH';
        usernameInput.placeholder = protocol === 'VNC' ? '用户名（可选，取决于 VNC 服务）' : '用户名';
    }
    $('#connSshKey')?.closest('.form-group')?.classList.toggle('force-hidden', protocol !== 'SSH');
    $('#connPrivateKey')?.closest('.form-group')?.classList.toggle('force-hidden', protocol !== 'SSH');
    $('.advanced-route-panel')?.classList.remove('force-hidden');
    console.debug('[guac-client]', 'protocol fields updated', { protocol, defaultPort, usernameRequired: protocol === 'SSH', routePanelEnabled: true });
}
function setConnectionTestLatency(text = '', state = '') {
    const el = $('#connectionTestLatency');
    if (!el) return;
    el.textContent = text;
    el.dataset.state = state;
}
function viewportMetrics() {
    const vv = window.visualViewport;
    return {
        width: Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 1),
        height: Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 1),
        left: Math.round(vv?.offsetLeft || 0),
        top: Math.round(vv?.offsetTop || 0)
    };
}
function connectionTransitionTargetRect(trigger = connectionModalTrigger) {
    const source = trigger?.isConnected ? trigger : $('#addConnectionBtn');
    const rect = source?.getBoundingClientRect?.();
    if (rect?.width && rect?.height) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, source };
    const viewport = viewportMetrics();
    return { left: viewport.width - 86, top: 82, width: 74, height: 74, source: null };
}
function nextAnimationFrame(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
}
function getConnectionTransitionShadowLayer() {
    let shadow = $('#connectionTransitionShadow');
    if (!shadow) {
        shadow = document.createElement('div');
        shadow.id = 'connectionTransitionShadow';
        shadow.className = 'connection-transition-shadow';
        shadow.style.position = 'fixed';
        shadow.style.inset = 'auto';
        shadow.style.background = 'transparent';
        shadow.style.border = '0';
        shadow.style.boxSizing = 'border-box';
        shadow.style.pointerEvents = 'none';
        shadow.style.contain = 'layout paint style';
        shadow.style.willChange = 'left, top, width, height, border-radius, box-shadow, opacity';
        document.body.appendChild(shadow);
    }
    return shadow;
}
function resetConnectionTransitionShadow(shadow = $('#connectionTransitionShadow')) {
    if (!shadow) return;
    shadow.style.visibility = 'hidden';
    shadow.style.transition = 'none';
    shadow.style.opacity = '0';
    shadow.style.left = '';
    shadow.style.top = '';
    shadow.style.width = '';
    shadow.style.height = '';
    shadow.style.borderRadius = '';
    shadow.style.transform = '';
}
function setConnectionLayerRect(layer, rect) {
    layer.style.left = `${rect.left}px`;
    layer.style.top = `${rect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
}
function syncConnectionLayerVisual(layer, source) {
    if (!layer || !source?.isConnected) {
        layer.innerHTML = '';
        layer.removeAttribute('data-has-source-visual');
        return;
    }
    const style = getComputedStyle(source);
    const shellBackground = `
        radial-gradient(circle at 18% 0%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 30%),
        radial-gradient(circle at 82% 8%, color-mix(in srgb, var(--success) 6%, transparent), transparent 28%),
        var(--surface)
    `;
    layer.innerHTML = `<span class="connection-transition-source-visual">${source.innerHTML}</span>`;
    layer.dataset.hasSourceVisual = 'true';
    layer.style.background = shellBackground;
    layer.style.border = '1px solid color-mix(in srgb, var(--border) 50%, transparent)';
    layer.style.color = style.color;
    layer.style.font = style.font;
    layer.style.letterSpacing = style.letterSpacing;
    layer.style.textAlign = style.textAlign;
    layer.style.padding = '0';
    layer.style.display = 'inline-flex';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = style.gap;
    layer.style.whiteSpace = 'nowrap';

    const visual = layer.querySelector('.connection-transition-source-visual');
    if (visual) {
        visual.style.background = style.background;
        visual.style.border = style.border;
        visual.style.borderRadius = style.borderRadius;
        visual.style.color = style.color;
        visual.style.font = style.font;
        visual.style.letterSpacing = style.letterSpacing;
        visual.style.padding = style.padding;
        visual.style.gap = style.gap;
    }
    console.debug('[connection-transition]', 'source visual synced', {
        sourceRole: source.id === 'addConnectionBtn' ? 'add' : source.matches('[data-edit]') ? 'edit' : 'other',
        sourceBackground: style.background,
        shellBackground: 'neutral-surface'
    });
}
function applyConnectionLayerSourceChrome(layer, source, { revealVisual = false } = {}) {
    if (!layer || !source?.isConnected) return;

    const style = getComputedStyle(source);
    const background = style.background && style.background !== 'none'
        ? style.background
        : style.backgroundColor;

    layer.style.background = background || style.backgroundColor || 'var(--surface)';
    layer.style.border = style.border || '1px solid color-mix(in srgb, var(--border) 50%, transparent)';
    layer.style.color = style.color;
    layer.style.font = style.font;
    layer.style.letterSpacing = style.letterSpacing;
    layer.style.textAlign = style.textAlign;
    layer.style.padding = '0';
    layer.style.display = 'inline-flex';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.gap = style.gap;
    layer.style.whiteSpace = 'nowrap';

    const visual = layer.querySelector('.connection-transition-source-visual');
    if (visual) {
        visual.style.background = style.background;
        visual.style.border = style.border;
        visual.style.borderRadius = style.borderRadius;
        visual.style.color = style.color;
        visual.style.font = style.font;
        visual.style.letterSpacing = style.letterSpacing;
        visual.style.padding = style.padding;
        visual.style.gap = style.gap;
        visual.style.width = '100%';
        visual.style.height = '100%';
        visual.style.maxWidth = '100%';
        visual.style.boxSizing = 'border-box';
        visual.style.display = style.display === 'inline-flex' || style.display === 'flex' ? 'inline-flex' : 'flex';
        visual.style.alignItems = style.alignItems || 'center';
        visual.style.justifyContent = style.justifyContent || 'center';
        visual.style.whiteSpace = 'nowrap';
        visual.style.opacity = revealVisual ? '1' : '';
        visual.style.transform = revealVisual ? 'scale(1)' : '';
        visual.style.transition = revealVisual ? 'opacity 0.12s ease 0.06s, transform 0.18s cubic-bezier(.16,1,.3,1) 0.04s' : '';
    }

    console.debug('[connection-transition]', 'source chrome applied', {
        sourceRole: source.id === 'addConnectionBtn' ? 'add' : source.matches('[data-edit]') ? 'edit' : 'other',
        background,
        revealVisual
    });
}
function resetConnectionTransitionLayer(layer) {
    if (!layer) return;
    layer.style.visibility = 'hidden';
    layer.style.pointerEvents = 'none';
    layer.style.transition = 'none';
    layer.style.transform = '';
    layer.style.opacity = '';
    layer.style.borderRadius = '';
    layer.style.boxShadow = '';
    layer.style.width = '';
    layer.style.height = '';
    layer.style.left = '';
    layer.style.top = '';
    layer.style.background = '';
    layer.style.border = '';
    layer.style.color = '';
    layer.style.font = '';
    layer.style.letterSpacing = '';
    layer.style.textAlign = '';
    layer.style.padding = '';
    layer.style.display = '';
    layer.style.alignItems = '';
    layer.style.justifyContent = '';
    layer.style.gap = '';
    layer.style.whiteSpace = '';
    layer.innerHTML = '';
    layer.removeAttribute('data-has-source-visual');
    layer.classList.remove('source-visual-hidden');
}
function prepareConnectionModalForm(conn = null) {
    editingId = conn?.id || null; editingSecretLoaded = false; $('#modalTitle').textContent = editingId ? '编辑服务器' : '添加服务器'; $('#connectionId').value = editingId || '';
    setConnectionTestLatency();
    $('#connName').value = conn?.name || ''; $('#connProtocol').value = conn?.protocol || 'SSH'; $('#connHost').value = conn?.host || ''; $('#connPort').value = conn?.port || ($('#connProtocol').value === 'RDP' ? 3389 : $('#connProtocol').value === 'VNC' ? 5900 : 22); $('#connUsername').value = conn?.username || '';
    renderSshKeyOptions(conn?.sshKeyId || '');
    $('#connTags').value = (conn?.tags || []).join(', '); setRouteMode(conn?.connectionMode || 'direct', conn?.connectionMode === 'jump' ? (conn?.jumpHostIds || (conn?.jumpHostId ? [conn.jumpHostId] : [])) : (conn?.proxyId || ''));
    $('#connPassword').type = 'password'; $('#toggleConnPassword').textContent = '👁️'; $('#connPassword').value = conn?.hasPassword ? '******' : ''; $('#connPrivateKey').value = conn?.hasPrivateKey ? '******' : ''; $('#revealConnSecrets').classList.toggle('force-hidden', !editingId || (!conn?.hasPassword && !conn?.hasPrivateKey && !conn?.sshKeyId)); $('#connRemark').value = conn?.remark || ''; updateProtocolFields({ preservePort: !!conn });
}
function openModal(conn = null, trigger = null) {
    const modal = $('#connectionModal');
    const layer = $('#connectionTransitionLayer');
    if (!modal || !layer || modal.classList.contains('show')) return;
    prepareConnectionModalForm(conn);
    connectionModalTrigger = trigger || connectionTransitionTargetRect().source;
    window.clearTimeout(openModal._finishTimer);
    window.clearTimeout(closeModal._timer);
    window.clearTimeout(closeModal._restoreIconTimer);
    window.clearTimeout(closeModal._shadowTimer);
    resetConnectionTransitionShadow();
    resetConnectionTransitionLayer(layer);
    modal.classList.remove('closing', 'app-visible');
    modal.classList.add('show');
    document.body.classList.add('disable-interaction', 'connection-transition-opening');

    const viewport = viewportMetrics();
    const sourceRect = connectionTransitionTargetRect(connectionModalTrigger);
    connectionModalOriginRect = { left: sourceRect.left, top: sourceRect.top, width: sourceRect.width, height: sourceRect.height };
    syncConnectionLayerVisual(layer, sourceRect.source);
    setConnectionLayerRect(layer, connectionModalOriginRect);
    layer.style.transition = 'none';
    layer.style.borderRadius = getComputedStyle(sourceRect.source || connectionModalTrigger || layer).borderRadius || '18px';
    layer.style.boxShadow = 'none';
    layer.style.visibility = 'visible';
    layer.style.pointerEvents = 'auto';
    connectionModalTrigger?.style?.setProperty('opacity', '0');

    void layer.offsetHeight;

    console.debug('[connection-transition]', 'open:init', { mode: editingId ? 'edit' : 'create', connectionId: editingId || '', sourceRect, originRect: connectionModalOriginRect, viewport });

    requestAnimationFrame(() => {
        document.body.classList.add('connection-home-blur');
        modal.classList.add('app-visible');
        layer.classList.add('source-visual-hidden');
        layer.style.transition = `
            top var(--connection-app-duration) var(--connection-ios-spring),
            left var(--connection-app-duration) var(--connection-ios-spring),
            width var(--connection-app-duration) var(--connection-ios-spring),
            height var(--connection-app-duration) var(--connection-ios-spring),
            border-radius var(--connection-app-duration) var(--connection-ios-spring)
        `;
        layer.style.left = `${viewport.left}px`;
        layer.style.top = `${viewport.top}px`;
        layer.style.width = `${viewport.width}px`;
        layer.style.height = `${viewport.height}px`;
        layer.style.borderRadius = '0px';
        layer.style.boxShadow = 'none';
        console.debug('[connection-transition]', 'open:morph-start', { durationMs: 500 });
    });

    openModal._finishTimer = window.setTimeout(() => {
        document.body.classList.remove('disable-interaction', 'connection-transition-opening');
        modal.classList.add('app-visible');
        console.debug('[connection-transition]', 'open:complete', { durationMs: 500 });
    }, 520);
}
function closeModal() {
    const modal = $('#connectionModal');
    const layer = $('#connectionTransitionLayer');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;

    const viewport = viewportMetrics();
    const currentRect = connectionTransitionTargetRect(connectionModalTrigger);
    const sourceRect = connectionModalOriginRect || {
        left: currentRect.left,
        top: currentRect.top,
        width: currentRect.width,
        height: currentRect.height
    };

    window.clearTimeout(openModal._finishTimer);
    window.clearTimeout(closeModal._restoreIconTimer);
    window.clearTimeout(closeModal._timer);
    window.clearTimeout(closeModal._shadowTimer);

    modal.classList.add('closing');
    modal.classList.remove('app-visible');

    setConnectionTestLatency();

    document.body.classList.add('disable-interaction', 'connection-transition-closing');
    document.body.classList.remove('connection-transition-opening', 'connection-home-blur');

    const sourceEl = currentRect.source || connectionModalTrigger;
    const sourceStyle = sourceEl?.isConnected ? getComputedStyle(sourceEl) : null;
    const sourceBorderRadius = sourceStyle?.borderRadius || getComputedStyle(connectionModalTrigger || layer).borderRadius || '18px';
    const shadowLayer = getConnectionTransitionShadowLayer();

    applyConnectionLayerSourceChrome(layer, sourceEl, { revealVisual: true });

    layer.style.visibility = 'visible';
    layer.style.pointerEvents = 'auto';
    layer.style.transition = 'none';
    layer.style.left = `${viewport.left}px`;
    layer.style.top = `${viewport.top}px`;
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    layer.style.borderRadius = '0px';
    layer.style.boxShadow = 'none';
    layer.classList.remove('source-visual-hidden');

    shadowLayer.style.visibility = 'visible';
    shadowLayer.style.pointerEvents = 'none';
    shadowLayer.style.transition = 'none';
    shadowLayer.style.left = `${viewport.left}px`;
    shadowLayer.style.top = `${viewport.top}px`;
    shadowLayer.style.width = `${viewport.width}px`;
    shadowLayer.style.height = `${viewport.height}px`;
    shadowLayer.style.borderRadius = '0px';
    shadowLayer.style.boxShadow = 'var(--connection-shadow-active)';
    shadowLayer.style.opacity = '1';
    shadowLayer.style.zIndex = '99';

    void layer.offsetHeight;
    void shadowLayer.offsetHeight;

    console.debug('[connection-transition]', 'close:init', {
        connectionId: editingId || '',
        viewport,
        sourceRect,
        currentRect
    });

    requestAnimationFrame(() => {
        layer.style.transition = `
            top var(--connection-app-duration) var(--connection-ios-spring),
            left var(--connection-app-duration) var(--connection-ios-spring),
            width var(--connection-app-duration) var(--connection-ios-spring),
            height var(--connection-app-duration) var(--connection-ios-spring),
            border-radius var(--connection-app-duration) var(--connection-ios-spring)
        `;

        setConnectionLayerRect(layer, sourceRect);
        layer.style.borderRadius = sourceBorderRadius;

        shadowLayer.style.transition = `
            left var(--connection-app-duration) var(--connection-ios-spring),
            top var(--connection-app-duration) var(--connection-ios-spring),
            width var(--connection-app-duration) var(--connection-ios-spring),
            height var(--connection-app-duration) var(--connection-ios-spring),
            border-radius var(--connection-app-duration) var(--connection-ios-spring),
            opacity 0.72s cubic-bezier(.16, 1, .3, 1),
            box-shadow 0.72s cubic-bezier(.16, 1, .3, 1)
        `;
        setConnectionLayerRect(shadowLayer, sourceRect);
        shadowLayer.style.borderRadius = sourceBorderRadius;
        shadowLayer.style.boxShadow = '0 6px 18px rgba(0,0,0,0.10)';
        shadowLayer.style.opacity = '0';

        console.debug('[connection-transition]', 'close:morph-start', { durationMs: 500 });
    });

    let done = false;

    const restoreTriggerWithoutTransition = () => {
        const trigger = connectionModalTrigger;
        if (!trigger?.style) return;

        const oldTransition = trigger.style.transition;
        trigger.style.transition = 'none';
        trigger.style.removeProperty('opacity');

        void trigger.offsetHeight;

        requestAnimationFrame(() => {
            if (oldTransition) {
                trigger.style.transition = oldTransition;
            } else {
                trigger.style.removeProperty('transition');
            }
        });
    };

    const finish = () => {
        if (done) return;
        done = true;

        layer.removeEventListener('transitionend', onEnd);
        modal.classList.remove('show', 'closing', 'app-visible');
        resetConnectionTransitionLayer(layer);

        restoreTriggerWithoutTransition();
        closeModal._shadowTimer = window.setTimeout(() => resetConnectionTransitionShadow(shadowLayer), 180);

        window.setTimeout(() => {
            document.body.classList.remove(
                'disable-interaction',
                'connection-transition-closing',
                'connection-home-blur'
            );
        }, 80);
        connectionModalOriginRect = null;

        console.debug('[connection-transition]', 'close:complete', { durationMs: 500 });
    };

    const onEnd = (ev) => {
        if (ev.propertyName === 'top') finish();
    };

    layer.addEventListener('transitionend', onEnd);
    closeModal._timer = window.setTimeout(finish, 560);
}
function connectionPayload({ forTest = false } = {}) {
    const mode = $('#connMode').value;
    const proxyId = $('#connRoute')?.value || '';
    const jumpHostIds = mode === 'jump' ? [...new Set($$('#jumpRouteList [data-jump-route-select]').map((el) => el.value).filter(Boolean))] : [];
    const protocol = $('#connProtocol').value;
    const defaultPort = protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : 22;
    const payload = { name: $('#connName').value.trim(), protocol, host: $('#connHost').value.trim(), port: Number($('#connPort').value) || defaultPort, username: $('#connUsername').value.trim(), sshKeyId: protocol === 'SSH' ? ($('#connSshKey')?.value || '') : '', password: $('#connPassword').value, privateKey: protocol === 'SSH' ? $('#connPrivateKey').value : '', remark: $('#connRemark').value, tags: parseTags($('#connTags').value), connectionMode: mode, proxyId: mode === 'proxy' ? proxyId : '', jumpHostId: mode === 'jump' ? (jumpHostIds[0] || '') : '', jumpHostIds };
    console.debug('[route-ui]', 'connection payload route', { mode, proxyId: payload.proxyId, jumpHostIds, sshKeyId: payload.sshKeyId });
    if (!forTest && editingId) { if (payload.password === '******') delete payload.password; if (payload.privateKey === '******') delete payload.privateKey; }
    return payload;
}
async function saveConnection(e) { e.preventDefault(); const payload = connectionPayload(); if (editingId) await api(`/api/connections/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) }); else await api('/api/connections', { method: 'POST', body: JSON.stringify(payload) }); closeModal(); toast('连接已保存'); await loadConnections(); }
async function testConnection() {
    const btn = $('#testConnectionBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中...';
    setConnectionTestLatency('测试中...', 'pending');
    try {
        const payload = connectionPayload({ forTest: true });
        console.debug('[guac-client]', 'test connection', { protocol: payload.protocol, host: payload.host, port: payload.port });
        const result = await api('/api/connections/test', { method: 'POST', body: JSON.stringify({ ...payload, connectionId: editingId || '', timeoutSeconds: 10 }) });
        setConnectionTestLatency(`连接延迟：${result.durationMs}ms`, 'success');
        toast(result.message || '连接测试成功');
    } catch (err) {
        setConnectionTestLatency('测试失败', 'error');
        toast(err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

async function revealConnectionSecrets() {
    if (!editingId || editingSecretLoaded) return;
    const secret = requestSensitiveSecret('查看已保存连接密码/私钥');
    const data = await api(`/api/connections/${editingId}/open`, { method: 'POST', body: JSON.stringify({ purpose: 'reveal', secret }) });
    $('#connPassword').value = data.connection?.password || '';
    $('#connPrivateKey').value = data.connection?.privateKey || '';
    editingSecretLoaded = true;
    console.debug('[secret-open]', 'connection secrets loaded', { connectionId: editingId, hasPassword: !!data.connection?.password, hasPrivateKey: !!data.connection?.privateKey });
    toast('已载入保存的密码/私钥');
}

async function openConnection(id) {
    const data = await api(`/api/connections/${id}/open`, { method: 'POST' }); const c = data.connection;
    const protocol = String(c.protocol || 'SSH').toUpperCase();
    const tabId = `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    if (['RDP', 'VNC'].includes(protocol)) {
        sessionStorage.setItem(`zephyr_guac_params_${tabId}`, JSON.stringify({ connectionId: c.id, host: c.host, port: c.port, username: c.username, protocol, tabId, embedded: true, timestamp: Date.now() }));
        terminalTabs.push({ id: tabId, name: c.name, protocol, status: 'connecting', iframe: true, page: 'guacamole', createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
        console.debug('[guac-client]', 'open guacamole tab', { protocol, tabId, connectionId: c.id, host: c.host, port: c.port });
    } else {
        const sshParams = { connectionId: c.id, host: c.host, port: c.port, username: c.username, init: '', tabId, embedded: !isCompactTerminalWorkspace(), timestamp: Date.now() };
        sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify(sshParams));
        // 移动端直接进入独立终端页，不走 iframe 工作区。
        // 这样键盘只影响 terminal.html 自己，避免父页面 + iframe 双重 visualViewport 抖动。
        if (isCompactTerminalWorkspace()) {
            window.location.href = `/terminal.html?tabId=${encodeURIComponent(tabId)}`;
            return;
        }
        terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: 'connecting', iframe: true, page: 'terminal', createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
    }
    openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    renderTerminalTabs();
    switchView('terminal');
    await loadConnections();
}
function openPlaceholderTab(c) {
    const tabId = `tab_${Date.now()}`;
    terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: '占位', iframe: false, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
    openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    renderTerminalTabs();
    switchView('terminal');
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
    return detectInteractionEnvironment().category === 'phone';
}

function isCompactTerminalWorkspace() { return isPhoneLikeEnvironment(); }
function getConfiguredTerminalMaxWindows() {
    const value = Number(settings?.terminal?.maxWindows || localStorage.getItem('zephyr-terminal-max-windows') || 3);
    return Math.min(3, Math.max(1, Number.isFinite(value) ? value : 3));
}
function getConfiguredMinimizedKeepAlive() {
    const raw = settings?.terminal?.minimizedKeepAlive ?? localStorage.getItem('zephyr-terminal-minimized-keepalive') ?? 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 0;
    if (value === -1) return -1;
    return Math.max(0, Math.floor(value));
}
function getTerminalSmartbarOrder() {
    const value = settings?.terminal?.smartbarOrder || localStorage.getItem('zephyr-terminal-smartbar-order') || 'old-first';
    if (value === 'new-left' || value === 'new-first') return 'new-first';
    return 'old-first';
}
function getEffectiveTerminalMaxWindows() { return isCompactTerminalWorkspace() ? 1 : getConfiguredTerminalMaxWindows(); }
function getTerminalSession(id) { return terminalTabs.find((t) => t.id === id); }
function visibleTerminalTabs() { return terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id)); }
function terminalShortName(name = '') { const s = String(name || 'Terminal'); return s.length > 6 ? `${s.slice(0, 6)}…` : s; }
function terminalInitials(name = '') {
    const parts = String(name || 'T').trim().split(/[\s._-]+/).filter(Boolean);
    const raw = parts.length > 1 ? parts.slice(0, 2).map((x) => x[0]).join('') : (parts[0] || 'T').slice(0, 2);
    return raw.toUpperCase();
}
function touchTerminalSession(id) { const t = getTerminalSession(id); if (t) t.lastUsedAt = Date.now(); recentUseStack = [id, ...recentUseStack.filter((x) => x !== id)].filter((x) => getTerminalSession(x)); }
function orderedVisibleIds() { return openOrderStack.filter((id) => visibleTerminalTabs().some((t) => t.id === id)); }
function computeDefaultVisualLayout() {
    const ids = orderedVisibleIds();
    if (ids.length <= 2) return ids;
    return [ids[ids.length - 1], ids[1], ids[0]].filter(Boolean);
}
function syncVisualLayout({ preserve = true } = {}) {
    const visibleIds = orderedVisibleIds();
    if (!preserve || !visualLayout.length) visualLayout = computeDefaultVisualLayout();
    else visualLayout = [...visualLayout.filter((id) => visibleIds.includes(id)), ...visibleIds.filter((id) => !visualLayout.includes(id))];
    if (visibleIds.length === 3 && (!preserve || visualLayout.length !== 3)) visualLayout = computeDefaultVisualLayout();
    if (!activeTerminalTab || !getTerminalSession(activeTerminalTab) || getTerminalSession(activeTerminalTab)?.minimized) activeTerminalTab = visualLayout[0] || visibleIds[0] || terminalTabs[0]?.id || null;
}
function minimizeTerminalSession(id, { activateNext = true, animated = true } = {}) {
    const t = getTerminalSession(id); if (!t) return;
    if (animated && !t.minimized && !minimizingTerminalTabs.has(id)) {
        minimizingTerminalTabs.add(id);
        renderTerminalTabs({ rebuildWorkspace: false });
        window.setTimeout(() => {
            minimizingTerminalTabs.delete(id);
            minimizeTerminalSession(id, { activateNext, animated: false });
            renderTerminalTabs();
        }, 260);
        return;
    }
    t.minimized = true;
    visualLayout = visualLayout.filter((x) => x !== id);
    if (activeTerminalTab === id && activateNext) activeTerminalTab = visualLayout[0] || orderedVisibleIds()[0] || terminalTabs.find((x) => !x.minimized)?.id || terminalTabs[0]?.id || null;
    syncVisualLayout({ preserve: false });
}
function restoreTerminalSession(id) {
    const t = getTerminalSession(id); if (!t) return;
    t.minimized = false;
    activeTerminalTab = id;
    touchTerminalSession(id);
    enforceTerminalWorkspaceLimit(id);
}
function enforceTerminalWorkspaceLimit(newId) {
    const maxWindows = getEffectiveTerminalMaxWindows();
    if (maxWindows <= 1) {
        terminalTabs.forEach((t) => { if (t.id !== newId) t.minimized = true; });
    } else {
        while (visibleTerminalTabs().length > maxWindows) {
            const oldestVisible = openOrderStack.find((id) => id !== newId && getTerminalSession(id) && !getTerminalSession(id).minimized);
            if (!oldestVisible) break;
            minimizeTerminalSession(oldestVisible, { activateNext: false, animated: false });
        }
    }
    syncVisualLayout({ preserve: false });
}
function terminalProtocolClass(protocol) { return String(protocol || 'SSH').toLowerCase(); }
function positionSmartbarPicker() {
    const smartbar = $('#sessionTabs');
    const picker = smartbar?.querySelector('.smartbar-picker');
    const addButton = smartbar?.querySelector('[data-smartbar-add]');
    if (!smartbar || !picker || !addButton) return;
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const margin = 14;
    const addRect = addButton.getBoundingClientRect();
    const dockRect = smartbar.querySelector('.smartbar-panel')?.getBoundingClientRect?.();
    const targetWidth = Math.min(360, Math.max(300, vvWidth - margin * 2));
    const anchorX = addRect.left + addRect.width / 2;
    const left = Math.min(Math.max(anchorX - targetWidth / 2, vvLeft + margin), vvLeft + vvWidth - targetWidth - margin);
    const preferredTop = Math.round((dockRect?.bottom || addRect.bottom) + 10);
    const minTop = vvTop + margin;
    const maxTop = vvTop + Math.max(margin, vvHeight - 280 - margin);
    const top = Math.min(Math.max(preferredTop, minTop), maxTop);
    const arrowLeft = Math.min(targetWidth - 20, Math.max(20, anchorX - left));
    picker.style.width = `${targetWidth}px`;
    picker.style.setProperty('--smartbar-picker-left', `${left}px`);
    picker.style.setProperty('--smartbar-picker-top', `${top}px`);
    picker.style.setProperty('--smartbar-picker-arrow-left', `${arrowLeft}px`);
    picker.style.setProperty('--smartbar-picker-origin-x', `${arrowLeft}px`);
}
function renderTerminalSmartbar() {
    const order = getTerminalSmartbarOrder();
    const orderedIds = order === 'new-first' ? [...openOrderStack].reverse() : [...openOrderStack];
    const seen = new Set();
    const sessions = orderedIds.map(getTerminalSession).filter(Boolean).filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
    });
    const icon = (t, index) => `<button class="smartbar-session ${t.id === activeTerminalTab ? 'active' : ''} ${t.minimized ? 'minimized' : ''}" style="--dock-index:${index}" data-smartbar-tab="${t.id}" title="${escapeHtml(t.protocol)} · ${escapeHtml(t.name)} · ${escapeHtml(t.status)}"><span class="smartbar-session-icon"><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span><b>${escapeHtml(terminalInitials(t.name))}</b></span><strong>${escapeHtml(t.name || 'Terminal')}</strong></button>`;
    const launchableConnections = connections.filter((c) => ['SSH', 'RDP', 'VNC'].includes(String(c.protocol || 'SSH').toUpperCase()));
    const picker = terminalSmartbarPickerOpen ? `
        <div class="smartbar-picker" role="dialog" aria-label="选择服务器连接">
            <div class="smartbar-picker-head"><strong>选择服务器</strong><button data-smartbar-picker-close title="关闭">×</button></div>
            <div class="smartbar-picker-list">
                ${launchableConnections.length ? launchableConnections.map((c) => `<button data-smartbar-connect="${c.id}"><span class="proto-dot ${terminalProtocolClass(c.protocol)}"></span><strong>${escapeHtml(c.name)}</strong><em>${escapeHtml(c.protocol)} · ${escapeHtml(c.host)}:${escapeHtml(c.port)}</em></button>`).join('') : '<div class="smartbar-empty">暂无 SSH/RDP/VNC 服务器</div>'}
            </div>
        </div>` : '';
    const smartbarRoot = $('#sessionTabs');
    const navRectNow = $('.main-nav')?.getBoundingClientRect();
    if (navRectNow) {
        const smartbarTop = `${Math.round(navRectNow.bottom)}px`;
        smartbarRoot.style.setProperty('--smartbar-top', smartbarTop);
        document.documentElement.style.setProperty('--smartbar-top', smartbarTop);
    }
    smartbarRoot.className = `terminal-smartbar ${terminalSmartbarOpen ? 'open' : ''} ${terminalSmartbarClosing ? 'closing' : ''}`;
    smartbarRoot.innerHTML = `
        <button class="smartbar-handle" data-smartbar-toggle title="展开/收回 Dock"><span></span></button>
        <div class="smartbar-panel">
            <div class="smartbar-dock" aria-label="终端 Dock">
                ${sessions.map(icon).join('') || '<span class="smartbar-empty">暂无会话</span>'}
                <button class="smartbar-add" style="--dock-index:${sessions.length}" data-smartbar-add title="选择服务器连接">＋</button>
            </div>
        </div>
        ${picker}`;
    requestAnimationFrame(() => {
        const nav = $('.main-nav');
        const smartbar = $('#sessionTabs');
        const panel = smartbar?.querySelector('.smartbar-panel');
        if (!nav || !smartbar || !panel) return;
        const navRect = nav.getBoundingClientRect();
        const smartbarTop = `${Math.round(navRect.bottom)}px`;
        smartbar.style.setProperty('--smartbar-top', smartbarTop);
        document.documentElement.style.setProperty('--smartbar-top', smartbarTop);
        positionSmartbarPicker();
    });
}
function terminalWindowMenu(t) {
    const maxWindows = getEffectiveTerminalMaxWindows();
    const visibleCount = visibleTerminalTabs().length;
    const compact = isCompactTerminalWorkspace();
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const winFullscreen = fullscreenElement?.classList?.contains('terminal-window') || fullscreenElement === workspace;
    const customFullscreen = workspace?.classList.contains('custom-fullscreen');
    const fullscreenItem = (customFullscreen || winFullscreen) ? ['exit-fullscreen', '退出全屏'] : ['fullscreen', '全屏'];
    let items;
    if (maxWindows <= 1 || visibleCount <= 1) {
        items = compact ? [fullscreenItem, ['minimize', '最小化'], ['close', '关闭']] : [['minimize', '最小化'], ['close', '关闭']];
    } else if (maxWindows === 2 || visibleCount === 2) {
        items = [fullscreenItem, ['left-half', '左半屏'], ['right-half', '右半屏'], ['minimize', '最小化'], ['close', '关闭']];
    } else {
        items = [fullscreenItem, ['left-half', '左半屏'], ['right-half', '右半屏'], ['right-top', '右侧 1/3 上半部'], ['right-bottom', '右侧 1/3 下半部'], ['left-two-thirds', '左侧 2/3'], ['right-two-thirds', '右侧 2/3'], ['minimize', '最小化'], ['close', '关闭']];
    }
    return `<div class="terminal-window-menu" role="menu" style="--island-action-count:${items.length}">${items.map(([action, label]) => `<button data-window-action="${action}" data-window="${t.id}" title="${label}" aria-label="${label}">${label}</button>`).join('')}</div>`;
}
function terminalWindowTitlebarHtml(t) {
    return `<button class="terminal-grip terminal-window-center-dots" data-window-control="${t.id}" title="短按打开窗口操作，长按拖动交换位置" aria-label="窗口操作与拖动"><span></span></button><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span><strong>${escapeHtml(terminalShortName(t.name))}</strong>${terminalWindowMenu(t)}`;
}
function positionTerminalWindowMenu(titlebar, { collapsed = false, force = false } = {}) {
    if (!force && !titlebar?.classList.contains('menu-open')) return;
    const button = titlebar.querySelector('[data-window-control]');
    const menu = titlebar.querySelector('.terminal-window-menu');
    if (!button || !menu) return;
    const titleRect = titlebar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();

    // 竖向“岛内列表”：保持原来的上下排列，但仍从三个点的几何中心连续膨胀出来，避免横向超出窗口。
    const islandCenterX = buttonRect.left + buttonRect.width / 2;
    const islandCenterY = buttonRect.top + buttonRect.height / 2;
    const itemCount = Number.parseInt(menu.style.getPropertyValue('--island-action-count'), 10) || menu.children.length || 3;
    const windowRect = titlebar.closest('.terminal-window')?.getBoundingClientRect() || titleRect;
    const menuWidth = Math.min(260, Math.max(220, titleRect.width - 16));
    const naturalHeight = 26 + itemCount * 45;
    const targetHeight = naturalHeight;
    const finalLeft = Math.min(Math.max(islandCenterX - titleRect.left - menuWidth / 2, 8), Math.max(8, titleRect.width - menuWidth - 8));
    const finalTop = Math.round(islandCenterY - titleRect.top - buttonRect.height / 2);
    const startWidth = Math.round(buttonRect.width);
    const startHeight = Math.round(buttonRect.height);
    const startLeft = Math.round(islandCenterX - titleRect.left - startWidth / 2);
    const startTop = Math.round(buttonRect.top - titleRect.top);
    const openDown = true;
    const clampedLeft = collapsed ? startLeft : finalLeft;
    const top = collapsed ? startTop : finalTop;
    const currentWidth = collapsed ? startWidth : menuWidth;
    const currentHeight = collapsed ? startHeight : targetHeight;
    menu.style.top = `${top}px`;
    menu.style.setProperty('--terminal-window-menu-left', `${clampedLeft}px`);
    menu.style.setProperty('--terminal-island-menu-width', `${currentWidth}px`);
    menu.style.setProperty('--terminal-island-menu-height', `${currentHeight}px`);

    const originX = collapsed ? currentWidth / 2 : Math.min(menuWidth - 18, Math.max(18, islandCenterX - titleRect.left - finalLeft));
    const originY = collapsed ? currentHeight / 2 : Math.max(0, Math.min(currentHeight, islandCenterY - titleRect.top - finalTop));
    const finalOriginX = Math.min(menuWidth - 18, Math.max(18, islandCenterX - titleRect.left - finalLeft));
    const finalOriginY = Math.max(0, Math.min(targetHeight, islandCenterY - titleRect.top - finalTop));
    menu.style.setProperty('--island-origin-x', `${originX}px`);
    menu.style.setProperty('--island-origin-y', `${originY}px`);
    menu.style.setProperty('--island-dots-x', `${collapsed ? currentWidth / 2 : finalOriginX}px`);
    menu.style.setProperty('--island-dots-y', `${collapsed ? currentHeight / 2 : finalOriginY}px`);
    const collapsedRadius = Math.round(startHeight / 2);
    const finalRadius = 22;
    menu.style.setProperty('--terminal-island-radius', `${collapsed ? collapsedRadius : finalRadius}px`);
    menu.style.setProperty('--terminal-island-collapsed-radius', `${collapsedRadius}px`);
    menu.style.setProperty('--terminal-island-final-radius', `${finalRadius}px`);
    menu.style.setProperty('--terminal-island-final-left', `${finalLeft}px`);
    menu.style.setProperty('--terminal-island-final-top', `${finalTop}px`);
    menu.style.setProperty('--terminal-island-final-width', `${menuWidth}px`);
    menu.style.setProperty('--terminal-island-final-height', `${targetHeight}px`);
    console.info('[DynamicIslandDiagnostics]', {
        event: 'terminal-window-menu-align',
        tabId: button?.dataset.windowControl || '',
        mode: 'vertical-island',
        titlebarOpen: titlebar.classList.contains('menu-open'),
        buttonRect: {
            left: Number(buttonRect.left.toFixed(2)),
            top: Number(buttonRect.top.toFixed(2)),
            width: Number(buttonRect.width.toFixed(2)),
            height: Number(buttonRect.height.toFixed(2)),
            centerX: Number(islandCenterX.toFixed(2)),
            centerY: Number(islandCenterY.toFixed(2)),
        },
        islandRect: {
            left: Number((titleRect.left + clampedLeft).toFixed(2)),
            top: Number((titleRect.top + top).toFixed(2)),
            width: Number(menuWidth.toFixed(2)),
            height: Number(targetHeight.toFixed(2)),
            originX: Number(originX.toFixed(2)),
            originY: Number(originY.toFixed(2)),
            openDown,
        },
        startTransform: {
            left: Number(clampedLeft.toFixed(2)),
            top: Number(top.toFixed(2)),
            width: Number(currentWidth.toFixed(2)),
            height: Number(currentHeight.toFixed(2)),
            collapsed,
        },
        menuAnimation: getComputedStyle(menu).animationName,
    });
}
function openTerminalWindowMenu(titlebar) {
    if (!titlebar) return;
    titlebar.classList.remove('menu-closing', 'menu-animating');
    positionTerminalWindowMenu(titlebar, { collapsed: true, force: true });
    const menu = titlebar.querySelector('.terminal-window-menu');
    const button = titlebar.querySelector('[data-window-control]');
    menu?.style.setProperty('opacity', '1');
    button?.style.setProperty('opacity', '0');
    titlebar.classList.add('menu-open', 'menu-animating');
    requestAnimationFrame(() => {
        positionTerminalWindowMenu(titlebar, { collapsed: false, force: true });
        window.setTimeout(() => {
            titlebar.classList.remove('menu-animating');
            menu?.style.removeProperty('opacity');
        }, 540);
    });
}
function closeTerminalWindowMenu(titlebar) {
    if (!titlebar) return;
    window.clearTimeout(titlebar._terminalMenuCloseTimer);
    const menu = titlebar.querySelector('.terminal-window-menu');
    const button = titlebar.querySelector('[data-window-control]');
    positionTerminalWindowMenu(titlebar, { collapsed: false, force: true });
    menu?.style.setProperty('opacity', '1');
    button?.style.setProperty('opacity', '0');
    titlebar.classList.add('menu-closing', 'menu-animating');
    titlebar.classList.remove('menu-open');
    requestAnimationFrame(() => positionTerminalWindowMenu(titlebar, { collapsed: true, force: true }));
    titlebar._terminalMenuCloseTimer = window.setTimeout(() => {
        titlebar.classList.remove('menu-closing', 'menu-animating');
        menu?.style.removeProperty('opacity');
        button?.style.removeProperty('opacity');
    }, 460);
}
function closeOtherTerminalWindowMenus(currentButton = null) {
    $$('.terminal-window-titlebar.menu-open').forEach((el) => {
        if (!currentButton || !el.contains(currentButton)) closeTerminalWindowMenu(el);
    });
}
function getMinimizedKeepAliveSessions() {
    const limit = getConfiguredMinimizedKeepAlive();
    const minimized = terminalTabs
        .filter((t) => t.minimized && !closingTerminalTabs.has(t.id) && t.iframe)
        .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    if (limit === -1) return minimized;
    if (limit <= 0) return [];
    return minimized.slice(0, limit);
}
function createTerminalWindowElement(t) {
    const article = document.createElement('article');
    article.className = 'terminal-window';
    article.dataset.window = t.id;
    article.draggable = false;
    const titlebar = document.createElement('div');
    titlebar.className = 'terminal-window-titlebar';
    titlebar.innerHTML = terminalWindowTitlebarHtml(t);
    const body = document.createElement('div');
    body.className = 'terminal-window-body';
    if (t.iframe) {
        const frame = document.createElement('iframe');
        frame.className = 'terminal-frame active';
        frame.dataset.frame = t.id;
        frame.src = t.page === 'guacamole'
            ? `/guacamole.html?embed=1&tabId=${encodeURIComponent(t.id)}`
            : `/terminal.html?embed=1&tabId=${encodeURIComponent(t.id)}`;
        frame.allow = 'fullscreen; virtual-keyboard; clipboard-read; clipboard-write';
        body.appendChild(frame);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'terminal-placeholder active';
        placeholder.dataset.frame = t.id;
        placeholder.textContent = `${t.protocol} 协议将在后续版本接入。`;
        body.appendChild(placeholder);
    }
    article.append(titlebar, body);
    return article;
}
function renderTerminalWorkspace() {
    const visibleSessions = terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id));
    const visible = [
        ...visualLayout.map(getTerminalSession).filter(Boolean).filter((t) => visibleSessions.some((item) => item.id === t.id)),
        ...visibleSessions.filter((t) => !visualLayout.includes(t.id)),
    ];
    const keepAliveMinimized = getMinimizedKeepAliveSessions();
    const count = visible.length;
    const workspace = $('#terminalWorkspace');
    const preservedWorkspaceClasses = ['custom-fullscreen', 'keyboard-open', 'fullscreen-transitioning', 'fullscreen-loading']
        .filter((className) => workspace.classList.contains(className));
    workspace.className = `terminal-workspace terminal-workspace-grid layout-${Math.min(count, 3)} ${isCompactTerminalWorkspace() ? 'compact' : ''} ${preservedWorkspaceClasses.join(' ')}`;
    const visibleIds = new Set(visible.map((t) => t.id));
    const keepAliveIds = new Set([...visible.map((t) => t.id), ...keepAliveMinimized.map((t) => t.id)]);
    console.info('[terminal-keepalive]', 'workspace render decision', {
        visibleIds: [...visibleIds],
        minimizedKeepAliveLimit: getConfiguredMinimizedKeepAlive(),
        keptMinimizedIds: keepAliveMinimized.map((t) => t.id),
        existingWindowIds: Array.from(workspace.querySelectorAll(':scope > .terminal-window')).map((el) => el.dataset.window),
    });
    if (!count) {
        workspace.querySelectorAll(':scope > .workspace-splitter').forEach((el) => el.remove());
        workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => {
            if (!keepAliveIds.has(el.dataset.window)) {
                console.info('[terminal-keepalive]', 'unload terminal iframe', { tabId: el.dataset.window, reason: 'no-visible-and-not-kept' });
                el.remove();
            }
        });
        if (!workspace.querySelector(':scope > .terminal-placeholder')) {
            workspace.insertAdjacentHTML('afterbegin', '<div class="terminal-placeholder active">暂无可见会话。最小化会话可从终端栏恢复。</div>');
        }
        keepAliveMinimized.forEach((t) => {
            let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
            if (!win) {
                win = createTerminalWindowElement(t);
                workspace.appendChild(win);
                console.info('[terminal-keepalive]', 'create minimized keepalive iframe', { tabId: t.id, reason: 'no-visible' });
            }
            win.className = `terminal-window minimized-keepalive ${closingTerminalTabs.has(t.id) ? 'closing' : ''}`;
        });
        return;
    }
    workspace.querySelectorAll(':scope > .terminal-placeholder, :scope > .workspace-splitter').forEach((el) => el.remove());
    workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => {
        if (!keepAliveIds.has(el.dataset.window)) {
            console.info('[terminal-keepalive]', 'unload terminal iframe', { tabId: el.dataset.window, reason: 'outside-visible-and-minimized-keepalive' });
            el.remove();
        }
    });
    visible.forEach((t, index) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) {
            win = createTerminalWindowElement(t);
            workspace.appendChild(win);
            console.info('[terminal-keepalive]', 'create visible iframe', { tabId: t.id, slot: index + 1 });
        }
        const titlebar = win.querySelector('.terminal-window-titlebar');
        if (titlebar) {
            titlebar.innerHTML = terminalWindowTitlebarHtml(t);
        }
        win.className = `terminal-window slot-${index + 1} ${t.id === activeTerminalTab ? 'active' : 'background'} ${closingTerminalTabs.has(t.id) ? 'closing' : ''} ${minimizingTerminalTabs.has(t.id) ? 'minimizing' : ''} ${dockSwapAnimatingWindows.has(t.id) ? 'dock-swapping' : ''} ${dockLaunchAnimatingWindows.has(t.id) ? 'dock-launching' : ''}`;
    });
    keepAliveMinimized.forEach((t) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) {
            win = createTerminalWindowElement(t);
            workspace.appendChild(win);
            console.info('[terminal-keepalive]', 'create minimized keepalive iframe', { tabId: t.id, reason: 'hidden-minimized' });
        }
        win.className = `terminal-window minimized-keepalive ${closingTerminalTabs.has(t.id) ? 'closing' : ''}`;
    });
    if (count === 2 || count === 3) {
        const splitterX = document.createElement('div');
        splitterX.className = 'workspace-splitter vertical';
        splitterX.dataset.splitter = 'x';
        workspace.appendChild(splitterX);
    }
    if (count === 3) {
        const splitterY = document.createElement('div');
        splitterY.className = 'workspace-splitter horizontal';
        splitterY.dataset.splitter = 'y';
        workspace.appendChild(splitterY);
    }
    scheduleTerminalLayoutStabilize('render-terminal-workspace', { focus: true });
}
function renderTerminalTabs({ rebuildWorkspace = true } = {}) {
    syncVisualLayout({ preserve: true });
    renderTerminalSmartbar();
    if (rebuildWorkspace) renderTerminalWorkspace();
    else {
        $$('#terminalWorkspace [data-window]').forEach((el) => {
            const active = el.dataset.window === activeTerminalTab;
            el.classList.toggle('active', active);
            el.classList.toggle('background', !active);
            el.classList.toggle('closing', closingTerminalTabs.has(el.dataset.window));
            el.classList.toggle('minimizing', minimizingTerminalTabs.has(el.dataset.window));
        });
        terminalTabs.forEach((t) => { $$(`[data-window-status="${t.id}"]`).forEach((el) => { el.textContent = t.status || ''; }); });
    }
    requestAnimationFrame(() => broadcastThemeToTerminals(document.documentElement.getAttribute('data-theme') || getPreferredTheme()));
}

function exitTerminalFullscreen() {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (workspace?.classList.contains('custom-fullscreen')) {
        resetTerminalWorkspaceKeyboard();
        workspace.classList.remove('custom-fullscreen');
        document.body.classList.remove('terminal-custom-fullscreen-open');
        renderTerminalTabs();
    }
    if (fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch?.(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
}

function closeTerminalTab(tabId, { reason = 'manual' } = {}) {
    if (!terminalTabs.some((t) => t.id === tabId) || closingTerminalTabs.has(tabId)) return;
    const willBeLastTab = terminalTabs.length <= 1;
    console.info('[terminal-layout]', 'close terminal tab requested', {
        tabId,
        reason,
        willBeLastTab,
        activeTerminalTab,
        customFullscreen: $('#terminalWorkspace')?.classList.contains('custom-fullscreen'),
    });
    if (activeTerminalTab === tabId || willBeLastTab) exitTerminalFullscreen();
    closingTerminalTabs.add(tabId);
    renderTerminalTabs({ rebuildWorkspace: false });
    window.setTimeout(() => {
        terminalTabs = terminalTabs.filter((t) => t.id !== tabId);
        openOrderStack = openOrderStack.filter((id) => id !== tabId);
        visualLayout = visualLayout.filter((id) => id !== tabId);
        recentUseStack = recentUseStack.filter((id) => id !== tabId);
        closingTerminalTabs.delete(tabId);
        sessionStorage.removeItem(`zephyr_ssh_params_${tabId}`);
        sessionStorage.removeItem(`zephyr_guac_params_${tabId}`);
        if (activeTerminalTab === tabId) activeTerminalTab = visualLayout[0] || terminalTabs.find((t) => !t.minimized)?.id || terminalTabs[0]?.id || null;
        if (!terminalTabs.length) {
            activeTerminalTab = null;
            visualLayout = [];
            openOrderStack = [];
            recentUseStack = [];
            setTerminalSmartbarOpen(false);
            exitTerminalFullscreen();
            resetTerminalWorkspaceKeyboard();
            // 最后一个终端关闭后保留在终端页，显示空会话占位，不再自动回到首页。
            switchView('terminal');
        }
        renderTerminalTabs();
    }, 260);
}

function applyTerminalWindowPreset(tabId, action) {
    const t = getTerminalSession(tabId); if (!t) return;
    console.debug('[terminal-layout]', 'window action', {
        tabId,
        action,
        compact: isCompactTerminalWorkspace(),
        visibleCount: visibleTerminalTabs().length,
        maxWindows: getEffectiveTerminalMaxWindows()
    });
    if (action === 'minimize') {
        exitTerminalFullscreen();
        minimizeTerminalSession(tabId);
        renderTerminalTabs();
        return;
    }
    if (action === 'close') { closeTerminalTab(tabId); return; }
    if (action === 'exit-fullscreen') { exitTerminalFullscreen(); return; }
    if (action === 'fullscreen') { fullscreenTerminalTab(tabId).catch((err) => toast(err.message)); return; }
    restoreTerminalSession(tabId);
    const workspace = $('#terminalWorkspace');
    const others = visualLayout.filter((id) => id !== tabId);
    if (action === 'left-half' || action === 'left-two-thirds') visualLayout = [tabId, ...others].slice(0, 3);
    else if (action === 'right-half' || action === 'right-two-thirds') visualLayout = [...others, tabId].slice(-3);
    else if (action === 'right-top') visualLayout = [others[0] || tabId, tabId, ...others.filter((_, i) => i > 0)].slice(0, 3);
    else if (action === 'right-bottom') visualLayout = [others[0] || tabId, ...others.filter((_, i) => i > 0), tabId].slice(0, 3);
    if (workspace) {
        if (action === 'left-half' || action === 'right-half') workspace.style.setProperty('--workspace-split-x', '50%');
        if (action === 'left-two-thirds' || action === 'right-top' || action === 'right-bottom') workspace.style.setProperty('--workspace-split-x', '66.666%');
        if (action === 'right-two-thirds') workspace.style.setProperty('--workspace-split-x', '33.333%');
        if (action === 'right-top') workspace.style.setProperty('--workspace-split-y', '50%');
        if (action === 'right-bottom') workspace.style.setProperty('--workspace-split-y', '50%');
    }
    activeTerminalTab = tabId; touchTerminalSession(tabId); renderTerminalTabs();
}

function resetTerminalWorkspaceKeyboard() {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    appKeyboardOpen = false;
    appKeyboardBaseline = 0;
    workspace.classList.remove('keyboard-open');
    document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
    document.documentElement.style.setProperty('--app-visual-vh', '100vh');
    document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
    workspace.style.height = '';
    workspace.style.maxHeight = '';
    workspace.querySelectorAll('.terminal-frame').forEach((frame) => {
        frame.style.height = '';
        frame.style.maxHeight = '';
    });
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:keyboard-reset' });
    scheduleTerminalLayoutStabilize('parent-keyboard-reset', { focus: true });
}

function applyTerminalWorkspaceKeyboard(metrics = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const fullscreenWindow = activeTerminalTab ? workspace.querySelector(`.terminal-window[data-window="${CSS.escape(activeTerminalTab)}"]`) : null;
    const isFullscreenTerminalSurface = fullscreenElement === workspace || fullscreenElement === fullscreenWindow || workspace.classList.contains('custom-fullscreen');
    const inset = Math.round(Number(metrics.keyboardInset) || 0);
    const viewportHeight = Math.round(Number(metrics.viewportHeight) || window.visualViewport?.height || window.innerHeight || 0);
    const offsetTop = Math.round(Number(metrics.offsetTop) || window.visualViewport?.offsetTop || 0);
    const keyboardOpen = !!metrics.keyboardOpen && inset >= 100;

    if (!keyboardOpen || !isFullscreenTerminalSurface) {
        if (!keyboardOpen) resetTerminalWorkspaceKeyboard();
        return;
    }

    appKeyboardOpen = true;
    workspace.classList.add('keyboard-open');
    document.documentElement.style.setProperty('--app-keyboard-inset', `${inset}px`);
    document.documentElement.style.setProperty('--app-visual-vh', `${Math.max(240, viewportHeight)}px`);
    document.documentElement.style.setProperty('--app-visual-offset-top', `${offsetTop}px`);
    workspace.style.height = `${Math.max(240, viewportHeight)}px`;
    workspace.style.maxHeight = `${Math.max(240, viewportHeight)}px`;
    const frame = workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(activeTerminalTab || '')}"]`) || workspace.querySelector('.terminal-frame.active');
    if (frame) {
        frame.style.height = '100%';
        frame.style.maxHeight = '100%';
    }
    console.info('[TerminalLayoutDiagnostics]', {
        event: 'parent:keyboard-apply',
        inset,
        viewportHeight,
        offsetTop,
        activeTerminalTab,
        isFullscreenTerminalSurface,
    });
    scheduleTerminalLayoutStabilize('parent-keyboard-apply', { focus: true });
}

function updateFullscreenKeyboardFromViewport() {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (!workspace || (!workspace.classList.contains('custom-fullscreen') && fullscreenElement !== workspace && !fullscreenElement?.classList?.contains('terminal-window')) || !window.visualViewport) return;
    const layoutHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
    if (!appKeyboardOpen) appKeyboardBaseline = Math.max(appKeyboardBaseline || 0, layoutHeight, Math.round(window.visualViewport.height || 0));
    const baseline = Math.max(appKeyboardBaseline || 0, layoutHeight);
    const viewportHeight = Math.round(window.visualViewport.height || layoutHeight);
    const offsetTop = Math.round(window.visualViewport.offsetTop || 0);
    const inset = Math.max(0, baseline - viewportHeight - offsetTop);
    if (inset >= 100 || appKeyboardOpen) {
        applyTerminalWorkspaceKeyboard({ keyboardOpen: inset >= 16, keyboardInset: inset, viewportHeight, layoutHeight: baseline, offsetTop });
    }
}

function ensureFullscreenLoader() {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return null;
    let loader = workspace.querySelector('.terminal-fullscreen-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.className = 'terminal-fullscreen-loader';
        loader.setAttribute('aria-live', 'polite');
        loader.innerHTML = '<div class="terminal-fullscreen-spinner"></div><span>正在切换全屏...</span>';
        workspace.appendChild(loader);
    }
    return loader;
}

function showFullscreenLoading(text = '正在切换全屏...') {
    const workspace = $('#terminalWorkspace');
    const loader = ensureFullscreenLoader();
    if (!workspace || !loader) return;
    loader.querySelector('span').textContent = text;
    workspace.classList.add('fullscreen-transitioning');
    workspace.classList.add('fullscreen-loading');
    window.clearTimeout(fullscreenLoadingTimer);
    fullscreenLoadingTimer = window.setTimeout(() => hideFullscreenLoading(), 2400);
}

function hideFullscreenLoading({ delay = 520 } = {}) {
    window.clearTimeout(fullscreenLoadingTimer);
    fullscreenLoadingTimer = window.setTimeout(() => {
        const workspace = $('#terminalWorkspace');
        workspace?.classList.remove('fullscreen-loading');
        window.setTimeout(() => workspace?.classList.remove('fullscreen-transitioning'), 520);
    }, delay);
}

async function fullscreenTerminalTab(tabId) {
    const compact = isCompactTerminalWorkspace();
    const visibleBefore = visibleTerminalTabs().map((t) => t.id);
    console.debug('[terminal-layout]', 'fullscreen requested', {
        tabId,
        compact,
        visibleCount: visibleBefore.length,
        maxWindows: getEffectiveTerminalMaxWindows()
    });

    restoreTerminalSession(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    renderTerminalTabs();
    const workspace = $('#terminalWorkspace');
    const win = workspace?.querySelector(`.terminal-window[data-window="${CSS.escape(tabId)}"]`);
    if (!workspace || !win) return;
    showFullscreenLoading(compact ? '正在进入移动端全屏...' : '正在切换为单窗口...');
    try {
        if (compact) {
            workspace.classList.toggle('custom-fullscreen');
            document.body.classList.toggle('terminal-custom-fullscreen-open', workspace.classList.contains('custom-fullscreen'));
            renderTerminalTabs();
            hideFullscreenLoading({ delay: 360 });
            window.setTimeout(() => {
                win.querySelector('.terminal-frame')?.contentWindow?.postMessage({ source: 'zephyr-app', type: 'focus-terminal' }, '*');
            }, 120);
        } else {
            const minimizedIds = visibleBefore.filter((id) => id !== tabId);
            minimizedIds.forEach((id) => {
                const session = getTerminalSession(id);
                if (session) session.minimized = true;
            });
            visualLayout = [tabId];
            activeTerminalTab = tabId;
            syncVisualLayout({ preserve: false });
            console.debug('[terminal-layout]', 'desktop fullscreen uses single-window layout', {
                tabId,
                minimizedIds,
                visualLayout: [...visualLayout]
            });
            renderTerminalTabs();
            hideFullscreenLoading({ delay: 220 });
            window.setTimeout(() => {
                workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)?.contentWindow?.postMessage({ source: 'zephyr-app', type: 'focus-terminal' }, '*');
            }, 120);
        }
    } catch (err) {
        hideFullscreenLoading({ delay: 0 });
        throw err;
    }
}

function setTerminalSmartbarOpen(open) {
    window.clearTimeout(terminalSmartbarTimer);
    window.clearTimeout(setTerminalSmartbarOpen._closeTimer);
    if (!open) {
        if (!terminalSmartbarOpen) return;
        terminalSmartbarOpen = false;
        terminalSmartbarPickerOpen = false;
        terminalSmartbarClosing = true;
        renderTerminalSmartbar();
        setTerminalSmartbarOpen._closeTimer = window.setTimeout(() => {
            terminalSmartbarClosing = false;
            renderTerminalSmartbar();
        }, 460);
        return;
    }
    terminalSmartbarClosing = false;
    terminalSmartbarOpen = true;
    renderTerminalSmartbar();
}
function noteTerminalWorkspaceActivity() {}
function swapTerminalWindows(a, b) {
    if (!a || !b || a === b) return;
    const ia = visualLayout.indexOf(a), ib = visualLayout.indexOf(b);
    if (ia < 0 || ib < 0) return;
    [visualLayout[ia], visualLayout[ib]] = [visualLayout[ib], visualLayout[ia]];
    renderTerminalTabs();
}
function snapTerminalWindowToEdge(tabId, clientX, clientY) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || isCompactTerminalWorkspace()) return false;
    const rect = workspace.getBoundingClientRect();
    const nearLeft = clientX - rect.left <= TERMINAL_EDGE_SNAP_PX;
    const nearRight = rect.right - clientX <= TERMINAL_EDGE_SNAP_PX;
    const nearTop = clientY - rect.top <= TERMINAL_EDGE_SNAP_PX;
    const nearBottom = rect.bottom - clientY <= TERMINAL_EDGE_SNAP_PX;
    if (!nearLeft && !nearRight && !nearTop && !nearBottom) return false;
    if (nearLeft) applyTerminalWindowPreset(tabId, 'left-half');
    else if (nearRight && nearTop) applyTerminalWindowPreset(tabId, 'right-top');
    else if (nearRight && nearBottom) applyTerminalWindowPreset(tabId, 'right-bottom');
    else if (nearRight) applyTerminalWindowPreset(tabId, 'right-half');
    else if (nearTop) applyTerminalWindowPreset(tabId, 'left-two-thirds');
    else applyTerminalWindowPreset(tabId, 'right-two-thirds');
    return true;
}
function reorderTerminalOrder(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId) return;
    const from = openOrderStack.indexOf(dragId);
    const to = openOrderStack.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [id] = openOrderStack.splice(from, 1);
    openOrderStack.splice(to, 0, id);
}
function resetDockMagnification(dock = document.querySelector('.smartbar-dock')) {
    dock?.querySelectorAll('.smartbar-session, .smartbar-add').forEach((item) => {
        item.style.removeProperty('--dock-scale');
        item.style.removeProperty('--dock-lift');
        item.style.removeProperty('--dock-shift');
        item.style.removeProperty('--dock-blur');
    });
}
function updateDockMagnification(clientX, dock = document.querySelector('.smartbar-dock')) {
    if (!dock) return;
    const influence = 132;
    dock.querySelectorAll('.smartbar-session, .smartbar-add').forEach((item) => {
        const rect = item.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        const d = Math.abs(clientX - center);
        const t = Math.max(0, 1 - d / influence);
        const eased = t * t * (3 - 2 * t);
        const direction = Math.sign(center - clientX);
        item.style.setProperty('--dock-scale', (1 + eased * 0.22).toFixed(3));
        item.style.setProperty('--dock-lift', `${(-eased * 13).toFixed(2)}px`);
        item.style.setProperty('--dock-shift', `${(direction * eased * 7).toFixed(2)}px`);
        item.style.setProperty('--dock-blur', `${((1 - eased) * 0.2).toFixed(2)}px`);
    });
}
function animateWindowFromDock(tabId, sourceRect, { swap = false } = {}) {
    if (!tabId || !sourceRect) return;
    requestAnimationFrame(() => {
        const win = document.querySelector(`#terminalWorkspace .terminal-window[data-window="${CSS.escape(tabId)}"]`);
        if (!win) return;
        const rect = win.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const sx = Math.max(0.08, sourceRect.width / rect.width);
        const sy = Math.max(0.06, sourceRect.height / rect.height);
        const dx = (sourceRect.left + sourceRect.width / 2) - (rect.left + rect.width / 2);
        const dy = (sourceRect.top + sourceRect.height / 2) - (rect.top + rect.height / 2);
        win.animate([
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale3d(${sx}, ${sy}, 1)`, opacity: 0.28, filter: 'blur(18px) saturate(.82)', borderRadius: '30px' },
            { transform: `translate3d(${dx * 0.16}px, ${dy * 0.16 - 8}px, 0) scale3d(1.025, 1.018, 1)`, opacity: 1, filter: 'blur(0) saturate(1.08)', borderRadius: '12px', offset: 0.72 },
            { transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1)', opacity: 1, filter: 'blur(0) saturate(1)', borderRadius: '0px' }
        ], { duration: swap ? 620 : 560, easing: 'cubic-bezier(.16,1,.3,1)' });
    });
}
function activateTerminalFromDock(tabId, sourceEl = null) {
    const sourceRect = sourceEl?.getBoundingClientRect?.();
    const t = getTerminalSession(tabId);
    if (!t) return;
    dockLaunchAnimatingWindows.add(tabId);
    if (t && !t.minimized && activeTerminalTab === tabId) minimizeTerminalSession(tabId);
    else { restoreTerminalSession(tabId); activeTerminalTab = tabId; touchTerminalSession(tabId); }
    setTerminalSmartbarOpen(false);
    renderTerminalTabs();
    animateWindowFromDock(tabId, sourceRect, { swap: false });
    window.setTimeout(() => {
        dockLaunchAnimatingWindows.delete(tabId);
        renderTerminalTabs({ rebuildWorkspace: false });
    }, 620);
}
function replaceWindowWithDockTab(targetWindowId, draggedTabId) {
    if (!targetWindowId || !draggedTabId || targetWindowId === draggedTabId) return false;
    const target = getTerminalSession(targetWindowId);
    const dragged = getTerminalSession(draggedTabId);
    if (!target || !dragged) return false;
    dockSwapAnimatingWindows.add(targetWindowId);
    dockSwapAnimatingWindows.add(draggedTabId);
    target.minimized = true;
    dragged.minimized = false;
    const idx = visualLayout.indexOf(targetWindowId);
    if (idx >= 0) visualLayout[idx] = draggedTabId;
    else visualLayout.unshift(draggedTabId);
    activeTerminalTab = draggedTabId;
    touchTerminalSession(draggedTabId);
    syncVisualLayout({ preserve: true });
    window.setTimeout(() => {
        dockSwapAnimatingWindows.delete(targetWindowId);
        dockSwapAnimatingWindows.delete(draggedTabId);
        renderTerminalTabs({ rebuildWorkspace: false });
    }, 520);
    return true;
}
function startSmartbarIconDrag(e, tabId) {
    const btn = e.target.closest('[data-smartbar-tab]');
    if (!btn || e.button === 2) return;
    e.preventDefault();
    suppressSmartbarClick = false;
    const ghost = btn.cloneNode(true);
    ghost.classList.add('smartbar-drag-ghost');
    document.body.appendChild(ghost);
    const moveGhost = (ev) => {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
    };
    smartbarDragState = { tabId, startX: e.clientX, startY: e.clientY, moved: false, ghost };
    btn.classList.add('dragging');
    moveGhost(e);
    const onMove = (ev) => {
        const dx = ev.clientX - smartbarDragState.startX;
        const dy = ev.clientY - smartbarDragState.startY;
        if (Math.hypot(dx, dy) > 6) smartbarDragState.moved = true;
        moveGhost(ev);
        ghost.style.pointerEvents = 'none';
        const hoverWin = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-window]')?.dataset.window || null;
        if (hoverWin !== smartbarHoverWindowId) {
            smartbarHoverWindowId = hoverWin;
            document.querySelectorAll('.terminal-window').forEach((el) => el.classList.toggle('dock-drop-target', !!hoverWin && el.dataset.window === hoverWin && hoverWin !== tabId));
        }
    };
    const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        btn.classList.remove('dragging');
        document.querySelectorAll('.terminal-window.dock-drop-target').forEach((el) => el.classList.remove('dock-drop-target'));
        smartbarHoverWindowId = null;
        ghost.remove();
        if (smartbarDragState?.moved) {
            suppressSmartbarClick = true;
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const targetDock = el?.closest?.('[data-smartbar-tab]')?.dataset.smartbarTab;
            const targetWin = el?.closest?.('[data-window]')?.dataset.window;
            if (targetWin && targetWin !== tabId) {
                const sourceRect = ghost.getBoundingClientRect();
                replaceWindowWithDockTab(targetWin, tabId);
                setTerminalSmartbarOpen(false);
                renderTerminalTabs();
                animateWindowFromDock(tabId, sourceRect, { swap: true });
            } else if (targetDock && targetDock !== tabId) {
                reorderTerminalOrder(tabId, targetDock);
                renderTerminalSmartbar();
            }
        }
        smartbarDragState = null;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { once: true });
}
function startTerminalWindowDrag(e, tabId) {
    if (isCompactTerminalWorkspace() || (e.target.closest('button') && !e.target.closest('.terminal-grip'))) return;
    const win = e.target.closest('.terminal-window');
    if (!win) return;
    e.preventDefault();
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    terminalDragState = { id: tabId, startX: e.clientX, startY: e.clientY, moved: false };
    win.classList.add('dragging');
    document.body.classList.add('terminal-window-dragging');
    const onMove = (ev) => {
        const dx = ev.clientX - terminalDragState.startX, dy = ev.clientY - terminalDragState.startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) terminalDragState.moved = true;
        win.style.setProperty('--drag-x', `${dx}px`);
        win.style.setProperty('--drag-y', `${dy}px`);
    };
    const onUp = (ev) => {
        win.style.pointerEvents = 'none';
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window')?.dataset.window;
        win.style.pointerEvents = '';
        win.classList.remove('dragging');
        win.style.removeProperty('--drag-x');
        win.style.removeProperty('--drag-y');
        document.body.classList.remove('terminal-window-dragging');
        window.removeEventListener('pointermove', onMove);
        if (target && target !== tabId) swapTerminalWindows(tabId, target);
        else if (!snapTerminalWindowToEdge(tabId, ev.clientX, ev.clientY)) renderTerminalTabs({ rebuildWorkspace: false });
        terminalDragState = null;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { once: true });
}
function startWorkspaceSplitterDrag(e, axis) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    e.preventDefault();
    const splitter = e.target.closest('[data-splitter]');
    const rect = workspace.getBoundingClientRect();

    const splitterGapHalf = 6;

    const applyPosition = (clientX, clientY) => {
        if (axis === 'x') {
            const pct = Math.min(82, Math.max(24, ((clientX - rect.left - splitterGapHalf) / rect.width) * 100));
            workspace.style.setProperty('--workspace-split-x', `${pct.toFixed(2)}%`);
        } else {
            const pct = Math.min(78, Math.max(22, ((clientY - rect.top - splitterGapHalf) / rect.height) * 100));
            workspace.style.setProperty('--workspace-split-y', `${pct.toFixed(2)}%`);
        }
    };

    const onMove = (ev) => {
        ev.preventDefault?.();
        applyPosition(ev.clientX, ev.clientY);
    };

    const cleanup = () => {
        splitter?.releasePointerCapture?.(e.pointerId);
        splitter?.classList.remove('arming', 'dragging');
        workspace.classList.remove('splitting');
        document.body.classList.remove('terminal-workspace-splitting');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
    };

    splitter?.setPointerCapture?.(e.pointerId);
    splitter?.classList.add('dragging');
    workspace.classList.add('splitting');
    document.body.classList.add('terminal-workspace-splitting');
    applyPosition(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
}

function renderRemoteServers() { const ssh = connections.filter((c) => c.protocol === 'SSH'); $('#remoteServerList').innerHTML = ssh.length ? ssh.map((c) => `<label class="server-check"><input type="checkbox" value="${c.id}"> <span>${escapeHtml(c.name)}</span><em>${escapeHtml(c.host)}</em></label>`).join('') : '<div class="empty-card">暂无 SSH 连接</div>'; }
async function remoteExecute(e) { e.preventDefault(); const ids = $$('#remoteServerList input:checked').map((i) => i.value); try { $('#remoteResults').innerHTML = '<div class="empty-card">执行中...</div>'; const data = await api('/api/remote-execute', { method: 'POST', body: JSON.stringify({ connectionIds: ids, command: $('#remoteCommand').value, timeoutSeconds: Number($('#remoteTimeout').value) || 30 }) }); $('#remoteResults').innerHTML = data.results.map((r) => `<article class="result-card ${r.success ? 'ok' : 'fail'}"><h3>${escapeHtml(r.name)} <span>${escapeHtml(r.status)} · ${r.durationMs}ms</span></h3>${r.error ? `<p class="error-text">${escapeHtml(r.error)}</p>` : ''}<pre>${escapeHtml(r.stdout || '')}</pre>${r.stderr ? `<pre class="stderr">${escapeHtml(r.stderr)}</pre>` : ''}</article>`).join(''); await loadConnections(); } catch (err) { toast(err.message); } }

async function loadSettings() {
    settings = await api('/api/settings').catch(() => ({})); const sec = settings.security || {}, cap = settings.captcha || {}, mail = settings.mail || {}, beian = settings.beian || {};
    $('#versionText').textContent = settings.version || '3.0.0'; $('#icpInput').value = beian.icp ?? settings.icp ?? ''; $('#icpUrlInput').value = beian.icpUrl ?? settings.icpUrl ?? ''; $('#policeInput').value = beian.policeBeian ?? settings.policeBeian ?? ''; $('#policeUrlInput').value = beian.policeBeianUrl ?? settings.policeBeianUrl ?? ''; $('#showBeianInput').checked = (beian.show ?? settings.showBeian) !== false;
    $('#ipWhitelistEnabled').checked = !!sec.ipWhitelistEnabled; $('#ipWhitelist').value = sec.ipWhitelist || ''; $('#bruteForceEnabled').checked = sec.bruteForceEnabled !== false; $('#bruteForceMaxFailures').value = sec.bruteForceMaxFailures || 5; $('#bruteForceBanMinutes').value = sec.bruteForceBanMinutes || 15;
    $('#captchaEnabled').checked = !!cap.enabled; $('#captchaProvider').value = cap.provider || 'turnstile'; $('#captchaSiteKey').value = cap.siteKey || cap.tencentCaptchaAppId || cap.aliyunCaptchaId || cap.aliyunSceneId || ''; $('#captchaSecretKey').value = cap.secretKey || cap.tencentAppSecretKey || cap.aliyunAccessKeySecret || '';
    $('#mailEnabled').checked = !!mail.enabled; $('#mailHost').value = mail.host || ''; $('#mailPort').value = mail.port || 465; $('#mailSecure').checked = mail.secure !== false; $('#mailUser').value = mail.user || ''; $('#mailPass').value = mail.pass || ''; $('#mailFrom').value = mail.from || ''; $('#mailAdminEmail').value = mail.adminEmail || ''; $('#notifyLoginSuccess').checked = mail.notifyLoginSuccess !== false; $('#notifyLoginFailure').checked = mail.notifyLoginFailure !== false; $('#geoLookupEnabled').checked = mail.geoLookupEnabled !== false;
    $('#terminalMaxWindows').value = String(getConfiguredTerminalMaxWindows());
    $('#terminalMinimizedKeepAlive').value = String(getConfiguredMinimizedKeepAlive());
    $('#terminalSmartbarOrder').value = getTerminalSmartbarOrder();
    settings.appearance = { brandName: DEFAULT_BRAND_NAME, brandIcon: DEFAULT_BRAND_ICON, theme: 'auto', autoThemeEnabled: true, ...(settings.appearance || {}) };
    applyAppearance(settings.appearance);
    applyTheme(getPreferredTheme());
    await loadSecurityStatus(); await loadSecurityLists();
}
async function saveBeian(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ beian: { icp: $('#icpInput').value, icpUrl: $('#icpUrlInput').value, policeBeian: $('#policeInput').value, policeBeianUrl: $('#policeUrlInput').value, show: $('#showBeianInput').checked } }) }); toast('备案信息已保存'); }
async function loadSecurityStatus() { securityStatus = await api('/api/security/status').catch(() => ({ user: {}, passkeys: [] })); $('#profileUsername').value = securityStatus.user.username || ''; $('#profileEmail').value = securityStatus.user.email || ''; renderTotp(); renderPasskeys(); }
async function loadSecurityLists() { ipBans = (await api('/api/security/ip-bans').catch(() => ({ bans: [] }))).bans || []; loginEvents = (await api('/api/security/login-events').catch(() => ({ events: [] }))).events || []; renderSecurityLists(); }
function renderTotp() { $('#totpBox').innerHTML = `<div class="mini-item"><b>TOTP 状态</b><span>${securityStatus.user.totpEnabled ? '已开启' : '未开启'}</span><button id="setupTotpBtn">${securityStatus.user.totpEnabled ? '重新绑定' : '开启 TOTP'}</button></div>`; $('#totpDisableForm').classList.toggle('force-hidden', !securityStatus.user.totpEnabled); }
function renderPasskeys() { $('#passkeyList').innerHTML = (securityStatus.passkeys || []).map((p) => `<div class="mini-item"><b>Passkey</b><span>${fmtTime(p.createdAt)}</span><button data-del-passkey="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无 Passkey</p>'; }
function renderSecurityLists() { $('#ipBanList').innerHTML = ipBans.map((b) => `<div class="mini-item"><b>${escapeHtml(b.ip)}</b><span>失败 ${b.failedCount} · 解封 ${fmtTime(b.bannedUntil)}</span><button data-unban="${escapeHtml(b.ip)}">解除</button></div>`).join('') || '<p class="muted">暂无封禁 IP</p>'; $('#loginEventList').innerHTML = loginEvents.slice(0, 20).map((e) => `<div class="mini-item"><b>${e.success ? '成功' : '失败'} · ${escapeHtml(e.username || '-')}</b><span>${escapeHtml(e.ip || '')} · ${escapeHtml(e.reason || '')} · ${fmtTime(e.time)}</span></div>`).join('') || '<p class="muted">暂无登录事件</p>'; }
async function saveSecurityPolicy(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ security: { ipWhitelistEnabled: $('#ipWhitelistEnabled').checked, ipWhitelist: $('#ipWhitelist').value, bruteForceEnabled: $('#bruteForceEnabled').checked, bruteForceMaxFailures: Number($('#bruteForceMaxFailures').value) || 5, bruteForceBanMinutes: Number($('#bruteForceBanMinutes').value) || 15 } }) }); toast('安全策略已保存'); }
async function saveCaptcha(e) {
    e.preventDefault();
    const provider = $('#captchaProvider').value;
    const siteKey = $('#captchaSiteKey').value.trim();
    const secretKey = $('#captchaSecretKey').value.trim();
    const captcha = {
        enabled: $('#captchaEnabled').checked,
        provider,
        siteKey,
        secretKey,
        tencentCaptchaAppId: provider === 'tencent' ? siteKey : '',
        tencentAppSecretKey: provider === 'tencent' ? secretKey : '',
        aliyunCaptchaId: provider === 'aliyun' ? siteKey : '',
        aliyunSceneId: provider === 'aliyun' ? siteKey : '',
        aliyunAccessKeySecret: provider === 'aliyun' ? secretKey : ''
    };
    console.debug('[captcha-client]', 'save captcha settings', { provider, enabled: captcha.enabled, hasSiteKey: !!siteKey, hasSecretKey: !!secretKey });
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ captcha }) });
    toast('CAPTCHA 已保存');
}
async function revealCaptchaSecret() {
    const secret = requestSensitiveSecret('查看已保存 CAPTCHA 密钥');
    const data = await api('/api/settings/captcha/open', { method: 'POST', body: JSON.stringify({ secret }) });
    $('#captchaSecretKey').value = data.secretKey || '';
    $('#captchaSecretKey').type = 'text';
    $('#toggleCaptchaSecret').textContent = '🙈';
    console.debug('[captcha-client]', 'captcha secret loaded', { provider: data.provider, hasSecretKey: !!data.hasSecretKey });
    toast(data.hasSecretKey ? '已载入保存的 CAPTCHA 密钥' : '当前未保存 CAPTCHA 密钥');
}
async function saveMail(e) {
    e.preventDefault();
    try {
        settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ mail: { enabled: $('#mailEnabled').checked, host: $('#mailHost').value.trim(), port: Number($('#mailPort').value) || 465, secure: $('#mailSecure').checked, user: $('#mailUser').value.trim(), pass: $('#mailPass').value, from: $('#mailFrom').value.trim(), adminEmail: $('#mailAdminEmail').value.trim(), notifyLoginSuccess: $('#notifyLoginSuccess').checked, notifyLoginFailure: $('#notifyLoginFailure').checked, geoLookupEnabled: $('#geoLookupEnabled').checked } }) });
        $('#mailPass').type = 'password';
        $('#toggleMailPassword').textContent = '👁️';
        toast('邮件设置已保存');
    } catch (err) {
        toast(err.message || '邮件设置保存失败');
    }
}
async function revealMailPass() {
    const secret = requestSensitiveSecret('查看已保存 SMTP 密码');
    const data = await api('/api/settings/mail/open', { method: 'POST', body: JSON.stringify({ secret }) });
    $('#mailPass').value = data.pass || '';
    $('#mailPass').type = 'text';
    $('#toggleMailPassword').textContent = '🙈';
    console.debug('[secret-open]', 'mail password loaded', { hasPass: !!data.hasPass });
    toast(data.hasPass ? '已载入保存的 SMTP 密码' : '当前未保存 SMTP 密码');
}
async function testMail() {
    const btn = $('#testMailBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '发送中...';
    try {
        const result = await api('/api/settings/test-mail', { method: 'POST', body: JSON.stringify({ to: $('#mailAdminEmail').value.trim() }) });
        toast(result.message || '测试邮件已发送');
    } catch (err) {
        toast(err.message || '测试邮件发送失败');
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}
async function saveTerminalLayout(e) {
    e.preventDefault();
    const maxWindows = Math.min(3, Math.max(1, Number($('#terminalMaxWindows').value) || 3));
    const rawKeepAlive = Number($('#terminalMinimizedKeepAlive').value);
    const minimizedKeepAlive = rawKeepAlive === -1 ? -1 : Math.max(0, Math.floor(Number.isFinite(rawKeepAlive) ? rawKeepAlive : 0));
    const smartbarOrder = $('#terminalSmartbarOrder').value === 'new-first' ? 'new-first' : 'old-first';
    localStorage.setItem('zephyr-terminal-max-windows', String(maxWindows));
    localStorage.setItem('zephyr-terminal-minimized-keepalive', String(minimizedKeepAlive));
    localStorage.setItem('zephyr-terminal-smartbar-order', smartbarOrder);
    settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ terminal: { ...(settings.terminal || {}), maxWindows, minimizedKeepAlive, smartbarOrder } }) });
    enforceTerminalWorkspaceLimit(activeTerminalTab);
    renderTerminalTabs();
    const keepAliveText = minimizedKeepAlive === -1 ? '最小化无限保活' : `最小化保活 ${minimizedKeepAlive} 个`;
    toast(`终端布局已保存：最多 ${maxWindows} 窗，${keepAliveText}`);
}
async function setupTotp() { const r = await api('/api/security/totp/setup', { method: 'POST', body: '{}' }); $('#totpEnableForm').classList.remove('force-hidden'); $('#totpQrBox').innerHTML = `<img class="qr-img" src="${r.qr}"><p class="muted">密钥：${escapeHtml(r.secret)}</p>`; }
async function registerPasskey() { try { if (!window.PublicKeyCredential) return toast('当前浏览器不支持 Passkey'); const options = await api('/api/passkeys/register/options', { method: 'POST', body: '{}' }); options.challenge = base64urlToBuffer(options.challenge); options.user.id = base64urlToBuffer(options.user.id); (options.excludeCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); }); const cred = await navigator.credentials.create({ publicKey: options }); if (!cred) return toast('Passkey 创建被取消'); const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), attestationObject: bufferToBase64url(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] } }; await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(payload) }); toast('Passkey 已绑定'); await loadSecurityStatus(); } catch (err) { toast('Passkey 注册失败：' + err.message); } }
async function loadNetwork() {
    const [proxyData, keyData] = await Promise.all([
        api('/api/proxies'),
        api('/api/ssh-keys').catch(() => ({ sshKeys: [] }))
    ]);
    proxies = proxyData.proxies || [];
    sshKeys = keyData.sshKeys || [];
    renderNetwork();
    updateRouteOptions();
    renderSshKeyOptions($('#connSshKey')?.value || '');
}
function renderNetwork() {
    $('#proxyList').innerHTML = proxies.map((p) => `<div class="mini-item"><b>${escapeHtml(p.name)}</b><span>${escapeHtml((p.type || 'socks5').toUpperCase())} · ${escapeHtml(p.host)}:${p.port}</span><button data-edit-proxy="${p.id}">编辑</button><button data-open-proxy="${p.id}">查看</button><button data-del-proxy="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无代理</p>';
    $('#sshKeyList').innerHTML = sshKeys.map((k) => `<div class="mini-item"><b>${escapeHtml(k.name)}</b><span>${k.hasPrivateKey ? '已保存私钥' : '无私钥'}${k.hasPassphrase ? ' · 有口令' : ''}${k.remark ? ` · ${escapeHtml(k.remark)}` : ''}</span><button data-edit-ssh-key="${k.id}">编辑</button><button data-open-ssh-key="${k.id}">查看</button><button data-del-ssh-key="${k.id}">删除</button></div>`).join('') || '<p class="muted">暂无 SSH 密钥</p>';
}
function renderJumpOptions() { if ($('#jumpRouteConfig') && $('#connMode')?.value === 'jump') updateRouteOptions('jump', $$('#jumpRouteList [data-jump-route-select]').map((el) => el.value).filter(Boolean)); }
async function saveProxy(e) { e.preventDefault(); const id = $('#proxyId').value, payload = { name: $('#proxyName').value, type: $('#proxyType').value, host: $('#proxyHost').value, port: Number($('#proxyPort').value), username: $('#proxyUsername').value, password: $('#proxyPassword').value }; console.debug('[route-ui]', 'save proxy payload', { id, ...payload, password: payload.password ? '******' : '' }); await api(id ? `/api/proxies/${id}` : '/api/proxies', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); e.target.reset(); $('#proxyId').value = ''; $('#proxyType').value = 'socks5'; await loadNetwork(); toast('代理已保存'); }
async function openProxySecret(id) {
    const secret = requestSensitiveSecret('查看已保存代理密码');
    const data = await api(`/api/proxies/${id}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const p = data.proxy || {};
    $('#proxyId').value = p.id || '';
    $('#proxyName').value = p.name || '';
    $('#proxyType').value = p.type || 'socks5';
    $('#proxyHost').value = p.host || '';
    $('#proxyPort').value = p.port || '';
    $('#proxyUsername').value = p.username || '';
    $('#proxyPassword').value = p.password || '';
    console.debug('[proxy-ui]', 'proxy secret loaded', { id, hasPassword: !!p.password });
    toast('已载入代理密码');
}
function resetSshKeyForm() { $('#sshKeyForm').reset(); $('#sshKeyId').value = ''; $('#sshKeyPrivateKey').value = ''; $('#sshKeyPassphrase').value = ''; }
async function saveSshKey(e) {
    e.preventDefault();
    const id = $('#sshKeyId').value;
    const payload = { name: $('#sshKeyName').value.trim(), privateKey: $('#sshKeyPrivateKey').value, passphrase: $('#sshKeyPassphrase').value, remark: $('#sshKeyRemark').value.trim() };
    console.debug('[ssh-key-ui]', 'save ssh key payload', { id, name: payload.name, hasPrivateKey: !!payload.privateKey && payload.privateKey !== '******', hasPassphrase: !!payload.passphrase && payload.passphrase !== '******' });
    await api(id ? `/api/ssh-keys/${id}` : '/api/ssh-keys', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    resetSshKeyForm();
    await loadNetwork();
    toast('SSH 密钥已保存');
}
async function openSshKeySecret(id) {
    const secret = requestSensitiveSecret('查看已保存 SSH 密钥');
    const data = await api(`/api/ssh-keys/${id}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const k = data.sshKey || {};
    $('#sshKeyId').value = k.id || '';
    $('#sshKeyName').value = k.name || '';
    $('#sshKeyPrivateKey').value = k.privateKey || '';
    $('#sshKeyPassphrase').value = k.passphrase || '';
    $('#sshKeyRemark').value = k.remark || '';
    console.debug('[ssh-key-ui]', 'ssh key secret loaded', { id, hasPrivateKey: !!k.privateKey, hasPassphrase: !!k.passphrase });
    toast('已载入 SSH 密钥内容');
}

function bindConnectionPressFeedback(root = document) {
    const pressableSelector = '#addConnectionBtn, [data-edit]';
    const clearPress = (el) => el?.classList?.remove('connection-pressing');
    root.addEventListener('pointerdown', (e) => {
        const target = e.target.closest(pressableSelector);
        if (!target || target.disabled) return;
        target.classList.add('connection-pressing');
    }, { passive: true });
    root.addEventListener('pointerup', (e) => clearPress(e.target.closest(pressableSelector)), { passive: true });
    root.addEventListener('pointercancel', (e) => clearPress(e.target.closest(pressableSelector)), { passive: true });
    root.addEventListener('pointerleave', (e) => clearPress(e.target.closest(pressableSelector)), { passive: true });
    root.addEventListener('click', (e) => {
        const target = e.target.closest(pressableSelector);
        if (!target) return;
        window.setTimeout(() => clearPress(target), 120);
    }, true);
}

function bindEvents() {
    bindConnectionPressFeedback();
    $$('.nav-tab').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('.settings-tab').forEach((btn) => btn.addEventListener('click', () => { $$('.settings-tab').forEach((b) => b.classList.remove('active')); btn.classList.add('active'); $$('.settings-panel').forEach((p) => p.classList.remove('active')); $(`#settings-${btn.dataset.settings}`).classList.add('active'); }));
    $('#appThemeToggle').addEventListener('click', () => toggleTheme().catch((err) => toast(err.message))); $('#settingsThemeToggle').addEventListener('click', () => toggleTheme().catch((err) => toast(err.message))); $('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
    $('#addConnectionBtn').addEventListener('click', (e) => openModal(null, e.currentTarget)); $('#closeModalBtn').addEventListener('click', closeModal); $('#cancelModalBtn').addEventListener('click', closeModal); $('#toggleConnPassword').addEventListener('click', () => { const el = $('#connPassword'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleConnPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; }); $('#revealConnSecrets').addEventListener('click', () => revealConnectionSecrets().catch((err) => toast(err.message))); $$('.route-type-tab').forEach((btn) => btn.addEventListener('click', () => setRouteMode($('#connMode').value === btn.dataset.routeMode ? 'direct' : btn.dataset.routeMode))); $('#addJumpRouteBtn').addEventListener('click', addJumpRouteRow); $('#jumpRouteList').addEventListener('click', (e) => { if (!e.target.closest('[data-remove-jump-route]')) return; const ids = $$('#jumpRouteList [data-jump-route-select]').filter((el) => !el.closest('[data-jump-route-row]').contains(e.target)).map((el) => el.value).filter(Boolean); renderJumpRouteRows(ids); }); $('#testConnectionBtn').addEventListener('click', testConnection);
    $('#connProtocol').addEventListener('change', () => updateProtocolFields({ preservePort: false }));
    $('#connectionForm').addEventListener('submit', saveConnection); ['searchInput', 'protocolFilter', 'tagFilter', 'sortSelect'].forEach((id) => $(`#${id}`).addEventListener('input', renderConnections));
    $('#connectionGrid').addEventListener('click', async (e) => {
        const edit = e.target.closest('[data-edit]')?.dataset.edit, del = e.target.closest('[data-delete]')?.dataset.delete, connect = e.target.closest('[data-connect]')?.dataset.connect;
        if (edit) openModal(connections.find((c) => c.id === edit), e.target.closest('[data-edit]'));
        if (del && confirm('确定删除该连接？')) {
            const card = e.target.closest('.connection-card');
            try {
                await waitForConnectionCardExit(card, del);
                await api(`/api/connections/${del}`, { method: 'DELETE' });
                await loadConnections();
                toast('连接已删除');
            } catch (err) {
                card?.classList.remove('deleting');
                card?.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
                console.debug('[connection-card]', 'delete failed, animation reverted', { connectionId: del, message: err.message });
                toast(err.message);
            }
        }
        if (connect) openConnection(connect).catch((err) => toast(err.message));
    });
    $('#sessionTabs').addEventListener('click', (e) => {
        if (suppressSmartbarClick) { suppressSmartbarClick = false; return; }
        const toggle = e.target.closest('[data-smartbar-toggle]');
        if (toggle) { setTerminalSmartbarOpen(!terminalSmartbarOpen); return; }
        if (e.target.closest('[data-smartbar-add]')) {
            terminalSmartbarPickerOpen = !terminalSmartbarPickerOpen;
            setTerminalSmartbarOpen(true);
            requestAnimationFrame(positionSmartbarPicker);
            return;
        }
        if (e.target.closest('[data-smartbar-picker-close]')) { terminalSmartbarPickerOpen = false; renderTerminalSmartbar(); return; }
        const connect = e.target.closest('[data-smartbar-connect]')?.dataset.smartbarConnect;
        if (connect) { terminalSmartbarPickerOpen = false; setTerminalSmartbarOpen(false); openConnection(connect).catch((err) => toast(err.message)); return; }
        const tabButton = e.target.closest('[data-smartbar-tab]');
        const tab = tabButton?.dataset.smartbarTab;
        if (tab) activateTerminalFromDock(tab, tabButton);
    });
    $('#sessionTabs').addEventListener('pointerdown', (e) => {
        const tabBtn = e.target.closest('[data-smartbar-tab]');
        if (tabBtn) startSmartbarIconDrag(e, tabBtn.dataset.smartbarTab);
    });
    $('#sessionTabs').addEventListener('pointermove', (e) => {
        const dock = e.target.closest('.smartbar-dock');
        if (dock) updateDockMagnification(e.clientX, dock);
    });
    $('#sessionTabs').addEventListener('pointerleave', (e) => {
        resetDockMagnification(e.currentTarget.querySelector('.smartbar-dock'));
    });
    document.addEventListener('pointerdown', (e) => {
        if (!terminalSmartbarOpen) return;
        if (e.target.closest?.('#sessionTabs')) return;
        setTerminalSmartbarOpen(false);
    }, true);
    $('#terminalWorkspace').addEventListener('click', (e) => {
        noteTerminalWorkspaceActivity();
        const menuBtn = e.target.closest('[data-window-control]');
        closeOtherTerminalWindowMenus(menuBtn);
        if (menuBtn) {
            e.stopPropagation();
            if (terminalControlLongPress) {
                terminalControlLongPress = false;
                return;
            }
            const titlebar = menuBtn.closest('.terminal-window-titlebar');
            if (titlebar?.classList.contains('menu-open')) {
                closeTerminalWindowMenu(titlebar);
            } else {
                openTerminalWindowMenu(titlebar);
            }
            console.info('[DynamicIslandDiagnostics]', {
                event: 'terminal-window-menu-toggle',
                tabId: menuBtn.dataset.windowControl || '',
                open: titlebar?.classList.contains('menu-open') || false,
                longPressSuppressed: false,
            });
            return;
        }
        const action = e.target.closest('[data-window-action]');
        if (action) {
            e.stopPropagation();
            const actionTitlebar = action.closest('.terminal-window-titlebar');
            closeTerminalWindowMenu(actionTitlebar);
            applyTerminalWindowPreset(action.dataset.window, action.dataset.windowAction);
            return;
        }
        const win = e.target.closest('[data-window]');
        if (win) { activeTerminalTab = win.dataset.window; touchTerminalSession(activeTerminalTab); renderTerminalTabs({ rebuildWorkspace: false }); }
    });
    $('#terminalWorkspace').addEventListener('pointerdown', (e) => {
        const splitter = e.target.closest('[data-splitter]');
        if (splitter) { startWorkspaceSplitterDrag(e, splitter.dataset.splitter); return; }
        const control = e.target.closest('[data-window-control]');
        if (control) {
            const tabId = control.dataset.windowControl;
            terminalControlLongPress = false;
            control.classList.add('island-pressing');
            const releaseIslandPress = () => control.classList.remove('island-pressing');
            const timer = window.setTimeout(() => {
                terminalControlLongPress = true;
                control.closest('.terminal-window-titlebar')?.classList.remove('menu-open');
                releaseIslandPress();
                startTerminalWindowDrag(e, tabId);
            }, 360);
            const cleanup = () => {
                window.clearTimeout(timer);
                releaseIslandPress();
                window.removeEventListener('pointerup', cleanup);
                window.removeEventListener('pointercancel', cleanup);
            };
            window.addEventListener('pointerup', cleanup, { once: true });
            window.addEventListener('pointercancel', cleanup, { once: true });
        }
    });
    document.addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('[data-window-control], .terminal-window-menu')) return;
        closeOtherTerminalWindowMenus();
    }, true);
    ['keydown', 'pointerdown'].forEach((eventName) => document.addEventListener(eventName, (e) => { if (e.target.closest?.('#terminalWorkspace')) noteTerminalWorkspaceActivity(); }, true));
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((eventName) => document.addEventListener(eventName, () => {
        const workspace = $('#terminalWorkspace');
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
        const isTerminalFullscreen = fullscreenElement === workspace || fullscreenElement?.classList?.contains('terminal-window');
        if (isTerminalFullscreen) {
            appKeyboardBaseline = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, window.visualViewport?.height || 0);
            hideFullscreenLoading({ delay: 620 });
        } else {
            resetTerminalWorkspaceKeyboard();
            workspace?.classList.remove('custom-fullscreen');
            document.body.classList.remove('terminal-custom-fullscreen-open');
            showFullscreenLoading('正在退出全屏...'), hideFullscreenLoading({ delay: 680 });
        }
    }));
    systemThemeQuery.addEventListener('change', () => {
        if (isAutoThemeEnabled()) {
            const theme = getSystemTheme();
            console.debug('[appearance-client]', 'system theme changed', { theme });
            applyTheme(theme);
        }
    });
    window.addEventListener('message', (e) => {
        if (e.data?.source !== 'zephyr-terminal') return;
        if (e.data.type === 'keyboard-metrics') {
            applyTerminalWorkspaceKeyboard(e.data);
            return;
        }
        if (e.data.type === 'activity') {
            noteTerminalWorkspaceActivity();
            return;
        }
        if (e.data.type === 'close-request') {
            console.info('[terminal-layout]', 'close request from terminal iframe', {
                tabId: e.data.tabId,
                reason: e.data.reason,
                tabCount: terminalTabs.length,
                compact: isCompactTerminalWorkspace(),
            });
            closeTerminalTab(e.data.tabId, { reason: e.data.reason || 'iframe-close-request' });
            return;
        }
        const t = terminalTabs.find((x) => x.id === e.data.tabId);
        if (t) {
            t.status = e.data.status || t.status;
            renderTerminalTabs({ rebuildWorkspace: false });
        }
    });
    window.visualViewport?.addEventListener('resize', updateFullscreenKeyboardFromViewport, { passive: true });
    window.addEventListener('resize', () => {
        document.querySelectorAll('.terminal-window-titlebar.menu-open').forEach(positionTerminalWindowMenu);
    }, { passive: true });
    window.visualViewport?.addEventListener('scroll', updateFullscreenKeyboardFromViewport, { passive: true });
    window.addEventListener('resize', () => {
        if (!terminalTabs.length) return;
        if (isCompactTerminalWorkspace()) {
            renderTerminalSmartbar();
            renderTerminalTabs({ rebuildWorkspace: false });
            return;
        }
        enforceTerminalWorkspaceLimit(activeTerminalTab);
        renderTerminalTabs();
    });
    $('#remoteExecForm').addEventListener('submit', remoteExecute); $('#beianForm').addEventListener('submit', saveBeian); $('#proxyForm').addEventListener('submit', saveProxy); $('#sshKeyForm').addEventListener('submit', saveSshKey); $('#resetSshKeyForm').addEventListener('click', resetSshKeyForm);
    $('#brandIconFile').addEventListener('change', async (e) => { try { const dataUrl = await readImageAsDataUrl(e.target.files?.[0]); if (!dataUrl) return; pendingBrandIcon = dataUrl; $('#brandIconPreview').innerHTML = iconHtml(dataUrl); console.debug('[appearance-client]', 'brand icon file loaded', { size: e.target.files?.[0]?.size || 0, type: e.target.files?.[0]?.type || '' }); } catch (err) { e.target.value = ''; toast(err.message); } });
    $('#resetAppearanceBtn').addEventListener('click', () => resetAppearance().catch((err) => toast(err.message)));
    $('#proxyList').addEventListener('click', async (e) => { const id = e.target.dataset.editProxy || e.target.dataset.openProxy || e.target.dataset.delProxy; if (!id) return; const p = proxies.find((x) => x.id === id); if (e.target.dataset.editProxy) { $('#proxyId').value = p.id; $('#proxyName').value = p.name; $('#proxyType').value = p.type || 'socks5'; $('#proxyHost').value = p.host; $('#proxyPort').value = p.port; $('#proxyUsername').value = p.username || ''; $('#proxyPassword').value = p.hasPassword ? '******' : ''; } else if (e.target.dataset.openProxy) { await openProxySecret(id); } else if (confirm('删除代理？')) { await api(`/api/proxies/${id}`, { method: 'DELETE' }); await loadNetwork(); } });
    $('#sshKeyList').addEventListener('click', async (e) => { const editId = e.target.dataset.editSshKey, openId = e.target.dataset.openSshKey, delId = e.target.dataset.delSshKey; if (editId) { const k = sshKeys.find((x) => x.id === editId); if (!k) return; $('#sshKeyId').value = k.id; $('#sshKeyName').value = k.name || ''; $('#sshKeyPrivateKey').value = k.hasPrivateKey ? '******' : ''; $('#sshKeyPassphrase').value = k.hasPassphrase ? '******' : ''; $('#sshKeyRemark').value = k.remark || ''; return; } if (openId) { await openSshKeySecret(openId); return; } if (delId && confirm('删除该 SSH 密钥？已选择它的连接将无法再使用该密钥。')) { await api(`/api/ssh-keys/${delId}`, { method: 'DELETE' }); await loadNetwork(); toast('SSH 密钥已删除'); } });
    $('#passwordForm').addEventListener('submit', async (e) => { e.preventDefault(); const currentPassword = $('#settingsCurrentPassword').value, newPassword = $('#settingsNewPassword').value, confirmPassword = $('#settingsConfirmPassword').value; if (newPassword !== confirmPassword) return toast('两次输入的新密码不一致'); await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); e.target.reset(); toast('密码已更新'); });
    $('#profileForm').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/profile', { method: 'PUT', body: JSON.stringify({ username: $('#profileUsername').value.trim(), email: $('#profileEmail').value }) }); toast('资料已保存'); await loadSecurityStatus(); });
    $('#securityPolicyForm').addEventListener('submit', saveSecurityPolicy); $('#captchaForm').addEventListener('submit', saveCaptcha); $('#mailForm').addEventListener('submit', saveMail); $('#appearanceForm').addEventListener('submit', saveAppearance); $('#terminalLayoutForm').addEventListener('submit', saveTerminalLayout);
    $('#totpBox').addEventListener('click', (e) => { if (e.target.id === 'setupTotpBtn') setupTotp().catch((err) => toast(err.message)); });
    $('#totpEnableForm').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/totp/enable', { method: 'POST', body: JSON.stringify({ code: $('#totpEnableCode').value }) }); toast('TOTP 已开启'); $('#totpEnableForm').classList.add('force-hidden'); await loadSecurityStatus(); });
    $('#totpDisableForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm('确定关闭 TOTP？')) return; await api('/api/security/totp/disable', { method: 'POST', body: JSON.stringify({ currentPassword: $('#totpDisablePassword').value, code: $('#totpDisableCode').value }) }); e.target.reset(); toast('TOTP 已关闭'); await loadSecurityStatus(); });
    $('#addPasskeyBtn').addEventListener('click', () => registerPasskey().catch((err) => toast(err.message)));
    $('#passkeyList').addEventListener('click', async (e) => { const id = e.target.dataset.delPasskey; if (id && confirm('删除该 Passkey？')) { await api(`/api/passkeys/${id}`, { method: 'DELETE' }); await loadSecurityStatus(); } });
    $('#ipBanList').addEventListener('click', async (e) => { const ip = e.target.dataset.unban; if (ip) { await api(`/api/security/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' }); await loadSecurityLists(); toast('已解除封禁'); } });
    $('#toggleCaptchaSecret').addEventListener('click', () => { const el = $('#captchaSecretKey'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleCaptchaSecret').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#revealCaptchaSecret').addEventListener('click', () => revealCaptchaSecret().catch((err) => toast(err.message || '读取 CAPTCHA 密钥失败')));
    $('#toggleMailPassword').addEventListener('click', () => { const el = $('#mailPass'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleMailPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#revealMailPass').addEventListener('click', () => revealMailPass().catch((err) => toast(err.message || '读取 SMTP 密码失败')));
    $('#testMailBtn').addEventListener('click', () => testMail());
    $('#exportDataBtn').addEventListener('click', () => { location.href = '/api/data/export'; });
    $('#clearActivityBtn').addEventListener('click', async () => { if (!confirm('确定清理最近活动日志？')) return; await api('/api/activities', { method: 'DELETE' }); await loadConnections(); toast('活动日志已清理'); });
    $('#clearLoginEventsBtn').addEventListener('click', async () => { if (!confirm('确定清理登录事件日志？')) return; await api('/api/security/login-events', { method: 'DELETE' }); await loadSecurityLists(); toast('登录事件已清理'); });
    $('#importDataForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm('导入会覆盖当前数据库，系统会先生成本地备份。继续？')) return; const fd = new FormData(); fd.append('backup', $('#backupFile').files[0]); fd.append('loginPassword', $('#importLoginPassword').value); fd.append('backupPassword', $('#backupPassword').value); const res = await fetch('/api/data/import', { method: 'POST', body: fd, credentials: 'same-origin' }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || '导入失败'); toast(data.message || '导入完成'); });
}
async function init() { applyTheme(getPreferredTheme()); try { const me = await api('/api/auth/me'); if (me.mustChangePassword) location.href = '/'; bindEvents(); await loadSettings(); await loadConnections(); await loadNetwork(); } catch { location.href = '/'; } }
init();
