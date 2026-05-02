const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let connections = [], activities = [], proxies = [], jumpHosts = [], settings = {};
let editingId = null;
let editingSecretLoaded = false;
let terminalTabs = [], activeTerminalTab = null;
let openOrderStack = [], visualLayout = [], recentUseStack = [];
let terminalSmartbarOpen = false;
let terminalSmartbarTimer = 0;
let terminalDragState = null;
let fullscreenLoadingTimer = 0;
let appKeyboardBaseline = 0;
let appKeyboardOpen = false;
let closingTerminalTabs = new Set();
let minimizingTerminalTabs = new Set();
let securityStatus = { user: {}, passkeys: [] }, ipBans = [], loginEvents = [];

const SMARTBAR_AUTO_HIDE_MS = 30000;
const TERMINAL_EDGE_SNAP_PX = 56;

function api(path, options = {}) {
    return fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || data.message || '请求失败'); return data; });
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
const systemThemeQuery = matchMedia('(prefers-color-scheme: dark)');
function getSystemTheme() { return systemThemeQuery.matches ? 'dark' : 'light'; }
function getPreferredTheme() { const saved = localStorage.getItem('zephyr-theme'); return saved === 'light' || saved === 'dark' ? saved : getSystemTheme(); }
function broadcastThemeToTerminals(theme) { $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'theme-change', theme }, '*')); }
function applyTheme(theme, { persist = false } = {}) { document.documentElement.classList.add('theme-transitioning'); window.clearTimeout(applyTheme._timer); applyTheme._timer = window.setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 360); document.documentElement.setAttribute('data-theme', theme); if (persist) localStorage.setItem('zephyr-theme', theme); $('#appThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙'; $('#settingsThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙'; broadcastThemeToTerminals(theme); }
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', { persist: true }); }
function escapeHtml(str) { return String(str || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function renderMarkdown(md) { let s = escapeHtml(md); s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); return s.replace(/\n/g, '<br>'); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '从未连接'; }
function switchView(name) {
    $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.body.classList.toggle('terminal-mode', name === 'terminal');
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

function updateRouteOptions(mode = $('#connMode').value, selected = '') {
    const selectedIds = Array.isArray(selected) ? selected.map(String) : String(selected || '').split(',').map((v) => v.trim()).filter(Boolean);
    const list = mode === 'proxy' ? proxies.map((p) => ({ id: p.id, name: `代理：${p.name}` })) : mode === 'jump' ? jumpHosts.map((j) => ({ id: j.id, name: `跳板：${j.name}` })) : [];
    const route = $('#connRoute');
    route.multiple = mode === 'jump';
    route.size = mode === 'jump' ? Math.min(Math.max(list.length, 3), 8) : 1;
    route.title = mode === 'jump' ? '按 Ctrl/⌘ 多选跳板机，选中顺序即为多跳顺序' : '';
    route.innerHTML = (mode === 'jump' ? '' : '<option value="">无</option>') + list.map((x) => `<option value="${x.id}" ${selectedIds.includes(String(x.id)) ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
    $('#routeOrderActions')?.classList.toggle('force-hidden', mode !== 'jump');
}
function moveSelectedRouteOption(direction) { const route = $('#connRoute'); if (!route || $('#connMode').value !== 'jump') return; const options = Array.from(route.options), selected = direction < 0 ? options.find((o) => o.selected) : options.reverse().find((o) => o.selected); if (!selected) return; const sibling = direction < 0 ? selected.previousElementSibling : selected.nextElementSibling; if (!sibling) return; if (direction < 0) route.insertBefore(selected, sibling); else route.insertBefore(sibling, selected); selected.selected = true; route.focus(); }
function openModal(conn = null) {
    editingId = conn?.id || null; editingSecretLoaded = false; $('#modalTitle').textContent = editingId ? '编辑服务器' : '添加服务器'; $('#connectionId').value = editingId || '';
    $('#connName').value = conn?.name || ''; $('#connProtocol').value = conn?.protocol || 'SSH'; $('#connHost').value = conn?.host || ''; $('#connPort').value = conn?.port || 22; $('#connUsername').value = conn?.username || '';
    $('#connTags').value = (conn?.tags || []).join(', '); $('#connMode').value = conn?.connectionMode || 'direct'; updateRouteOptions($('#connMode').value, conn?.connectionMode === 'jump' ? (conn?.jumpHostIds || (conn?.jumpHostId ? [conn.jumpHostId] : [])) : (conn?.proxyId || ''));
    $('#connPassword').type = 'password'; $('#toggleConnPassword').textContent = '👁️'; $('#connPassword').value = conn?.hasPassword ? '******' : ''; $('#connPrivateKey').value = conn?.hasPrivateKey ? '******' : ''; $('#revealConnSecrets').classList.toggle('force-hidden', !editingId || (!conn?.hasPassword && !conn?.hasPrivateKey)); $('#connRemark').value = conn?.remark || ''; $('#connectionModal').classList.add('show');
}
function closeModal() { $('#connectionModal').classList.remove('show'); }
function connectionPayload({ forTest = false } = {}) { const mode = $('#connMode').value, route = $('#connRoute').value, jumpHostIds = mode === 'jump' ? Array.from($('#connRoute').selectedOptions).map((o) => o.value).filter(Boolean) : []; const payload = { name: $('#connName').value.trim(), protocol: $('#connProtocol').value, host: $('#connHost').value.trim(), port: Number($('#connPort').value) || 22, username: $('#connUsername').value.trim(), password: $('#connPassword').value, privateKey: $('#connPrivateKey').value, remark: $('#connRemark').value, tags: parseTags($('#connTags').value), connectionMode: mode, proxyId: mode === 'proxy' ? route : '', jumpHostId: mode === 'jump' ? (jumpHostIds[0] || '') : '', jumpHostIds }; if (!forTest && editingId) { if (payload.password === '******') delete payload.password; if (payload.privateKey === '******') delete payload.privateKey; } return payload; }
async function saveConnection(e) { e.preventDefault(); const payload = connectionPayload(); if (payload.protocol !== 'SSH') toast('RDP/VNC 当前仅保存占位'); if (editingId) await api(`/api/connections/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) }); else await api('/api/connections', { method: 'POST', body: JSON.stringify(payload) }); closeModal(); toast('连接已保存'); await loadConnections(); }
async function testConnection() { try { const result = await api('/api/connections/test', { method: 'POST', body: JSON.stringify({ ...connectionPayload({ forTest: true }), connectionId: editingId || '', timeoutSeconds: 10 }) }); toast(`${result.message}，耗时 ${result.durationMs}ms`); } catch (err) { toast(err.message); } }

async function revealConnectionSecrets() {
    if (!editingId || editingSecretLoaded) return;
    const data = await api(`/api/connections/${editingId}/open`, { method: 'POST' });
    $('#connPassword').value = data.connection?.password || '';
    $('#connPrivateKey').value = data.connection?.privateKey || '';
    editingSecretLoaded = true;
    toast('已载入保存的密码/私钥');
}

async function openConnection(id) {
    const data = await api(`/api/connections/${id}/open`, { method: 'POST' }); const c = data.connection;
    if (c.protocol !== 'SSH') { openPlaceholderTab(c); return; }
    const tabId = `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify({ connectionId: c.id, host: c.host, port: c.port, username: c.username, password: c.password || '', privateKey: c.privateKey || '', init: '', tabId, embedded: true, timestamp: Date.now() }));
    terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: 'connecting', iframe: true, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
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

function isCompactTerminalWorkspace() { return matchMedia('(hover: none) and (pointer: coarse)').matches || innerWidth <= 760; }
function getTerminalSession(id) { return terminalTabs.find((t) => t.id === id); }
function visibleTerminalTabs() { return terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id)); }
function terminalShortName(name = '') { const s = String(name || 'Terminal'); return s.length > 6 ? `${s.slice(0, 6)}…` : s; }
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
    if (isCompactTerminalWorkspace()) {
        terminalTabs.forEach((t) => { if (t.id !== newId) t.minimized = true; });
    } else {
        while (visibleTerminalTabs().length > 3) {
            const oldestVisible = openOrderStack.find((id) => id !== newId && getTerminalSession(id) && !getTerminalSession(id).minimized);
            if (!oldestVisible) break;
            minimizeTerminalSession(oldestVisible, { activateNext: false, animated: false });
        }
    }
    syncVisualLayout({ preserve: false });
}
function terminalProtocolClass(protocol) { return String(protocol || 'SSH').toLowerCase(); }
function renderTerminalSmartbar() {
    const left = openOrderStack.map(getTerminalSession).filter(Boolean);
    const right = recentUseStack.map(getTerminalSession).filter(Boolean);
    const icon = (t, side) => `<button class="smartbar-session ${t.id === activeTerminalTab ? 'active' : ''} ${t.minimized ? 'minimized' : ''}" data-smartbar-tab="${t.id}" title="${escapeHtml(t.protocol)} · ${escapeHtml(t.name)} · ${escapeHtml(t.status)}"><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span><strong>${escapeHtml(terminalShortName(t.name))}</strong><em>${escapeHtml(t.status || '')}</em></button>`;
    $('#sessionTabs').className = `terminal-smartbar ${terminalSmartbarOpen ? 'open' : ''}`;
    $('#sessionTabs').innerHTML = `
        <button class="smartbar-handle left" data-smartbar-toggle title="展开/收回终端栏"></button>
        <div class="smartbar-panel">
            <div class="smartbar-group left" aria-label="按开启顺序排列">${left.map((t) => icon(t, 'left')).join('') || '<span class="smartbar-empty">暂无会话</span>'}<button class="smartbar-add" data-smartbar-add title="回到仪表盘新建连接">＋</button></div>
            <button class="smartbar-collapse" data-smartbar-toggle title="收回">⌃</button>
            <div class="smartbar-group right" aria-label="最近使用">${right.map((t) => icon(t, 'right')).join('')}</div>
        </div>
        <button class="smartbar-handle right" data-smartbar-toggle title="展开/收回终端栏"></button>`;
}
function terminalWindowMenu(t) {
    const mobile = isCompactTerminalWorkspace();
    const items = mobile
        ? [['fullscreen', '全屏'], ['minimize', '最小化'], ['close', '关闭']]
        : [['fullscreen', '全屏'], ['left-half', '左半屏'], ['right-half', '右半屏'], ['right-top', '右侧 1/3 上半部'], ['right-bottom', '右侧 1/3 下半部'], ['left-two-thirds', '左侧 2/3'], ['right-two-thirds', '右侧 2/3'], ['minimize', '最小化'], ['close', '关闭']];
    return `<div class="terminal-window-menu" role="menu">${items.map(([action, label]) => `<button data-window-action="${action}" data-window="${t.id}">${label}</button>`).join('')}</div>`;
}
function terminalWindowTitlebarHtml(t) {
    return `<span class="terminal-grip">::</span><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span><strong>${escapeHtml(terminalShortName(t.name))}</strong><em data-window-status="${t.id}">${escapeHtml(t.status || '')}</em><button class="terminal-window-more" data-window-menu="${t.id}" title="窗口操作">…</button>${terminalWindowMenu(t)}`;
}
function createTerminalWindowElement(t) {
    const article = document.createElement('article');
    article.className = 'terminal-window';
    article.dataset.window = t.id;
    article.draggable = false;
    const titlebar = document.createElement('div');
    titlebar.className = 'terminal-window-titlebar';
    titlebar.dataset.windowDrag = t.id;
    titlebar.innerHTML = terminalWindowTitlebarHtml(t);
    const body = document.createElement('div');
    body.className = 'terminal-window-body';
    if (t.iframe) {
        const frame = document.createElement('iframe');
        frame.className = 'terminal-frame active';
        frame.dataset.frame = t.id;
        frame.src = `/terminal.html?embed=1&tabId=${encodeURIComponent(t.id)}`;
        frame.allow = 'fullscreen; virtual-keyboard';
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
    const visible = visualLayout.map(getTerminalSession).filter(Boolean).filter((t) => !t.minimized && !closingTerminalTabs.has(t.id));
    const count = visible.length;
    const workspace = $('#terminalWorkspace');
    workspace.className = `terminal-workspace terminal-workspace-grid layout-${Math.min(count, 3)} ${isCompactTerminalWorkspace() ? 'compact' : ''}`;
    if (!count) {
        workspace.innerHTML = '<div class="terminal-placeholder">暂无会话。点击仪表盘中的“连接”打开 SSH 会话。</div>';
        return;
    }
    workspace.querySelectorAll(':scope > .terminal-placeholder, :scope > .workspace-splitter').forEach((el) => el.remove());
    const visibleIds = new Set(visible.map((t) => t.id));
    workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => { if (!visibleIds.has(el.dataset.window)) el.remove(); });
    visible.forEach((t, index) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) win = createTerminalWindowElement(t);
        const titlebar = win.querySelector('.terminal-window-titlebar');
        if (titlebar) {
            titlebar.dataset.windowDrag = t.id;
            titlebar.innerHTML = terminalWindowTitlebarHtml(t);
        }
        win.className = `terminal-window slot-${index + 1} ${t.id === activeTerminalTab ? 'active' : 'background'} ${closingTerminalTabs.has(t.id) ? 'closing' : ''} ${minimizingTerminalTabs.has(t.id) ? 'minimizing' : ''}`;
        workspace.appendChild(win);
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

function closeTerminalTab(tabId) {
    if (!terminalTabs.some((t) => t.id === tabId) || closingTerminalTabs.has(tabId)) return;
    closingTerminalTabs.add(tabId);
    renderTerminalTabs({ rebuildWorkspace: false });
    window.setTimeout(() => {
        terminalTabs = terminalTabs.filter((t) => t.id !== tabId);
        openOrderStack = openOrderStack.filter((id) => id !== tabId);
        visualLayout = visualLayout.filter((id) => id !== tabId);
        recentUseStack = recentUseStack.filter((id) => id !== tabId);
        closingTerminalTabs.delete(tabId);
        sessionStorage.removeItem(`zephyr_ssh_params_${tabId}`);
        if (activeTerminalTab === tabId) activeTerminalTab = visualLayout[0] || terminalTabs.find((t) => !t.minimized)?.id || terminalTabs[0]?.id || null;
        renderTerminalTabs();
    }, 260);
}

function applyTerminalWindowPreset(tabId, action) {
    const t = getTerminalSession(tabId); if (!t) return;
    if (action === 'minimize') { minimizeTerminalSession(tabId); renderTerminalTabs(); return; }
    if (action === 'close') { closeTerminalTab(tabId); return; }
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
}

function applyTerminalWorkspaceKeyboard(metrics = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const isWorkspaceFullscreen = fullscreenElement === workspace;
    const inset = Math.round(Number(metrics.keyboardInset) || 0);
    const viewportHeight = Math.round(Number(metrics.viewportHeight) || window.visualViewport?.height || window.innerHeight || 0);
    const offsetTop = Math.round(Number(metrics.offsetTop) || window.visualViewport?.offsetTop || 0);
    const keyboardOpen = !!metrics.keyboardOpen && inset >= 100;

    if (!keyboardOpen || !isWorkspaceFullscreen) {
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
}

function updateFullscreenKeyboardFromViewport() {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (!workspace || fullscreenElement !== workspace || !window.visualViewport) return;
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
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    renderTerminalTabs({ rebuildWorkspace: false });
    const target = $('#terminalWorkspace');
    if (!target) return;
    showFullscreenLoading('正在进入全屏...');
    try {
        if (isCompactTerminalWorkspace()) {
            target.classList.toggle('custom-fullscreen');
            hideFullscreenLoading({ delay: 360 });
        } else if (target.requestFullscreen) await target.requestFullscreen();
        else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
        else {
            hideFullscreenLoading({ delay: 0 });
            toast('当前浏览器不支持全屏 API');
        }
    } catch (err) {
        hideFullscreenLoading({ delay: 0 });
        throw err;
    }
}

function setTerminalSmartbarOpen(open) {
    terminalSmartbarOpen = open;
    window.clearTimeout(terminalSmartbarTimer);
    $('#sessionTabs')?.classList.toggle('open', open);
    if (open) terminalSmartbarTimer = window.setTimeout(() => setTerminalSmartbarOpen(false), SMARTBAR_AUTO_HIDE_MS);
}
function noteTerminalWorkspaceActivity() {
    if (terminalSmartbarOpen) setTerminalSmartbarOpen(true);
}
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
function startTerminalWindowDrag(e, tabId) {
    if (isCompactTerminalWorkspace() || e.target.closest('button')) return;
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
    let dragging = false;
    let startX = e.clientX;
    let startY = e.clientY;
    let holdTimer = 0;

    const cleanup = () => {
        window.clearTimeout(holdTimer);
        splitter?.classList.remove('arming', 'dragging');
        workspace.classList.remove('splitting');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
    };

    const onMove = (ev) => {
        if (!dragging) {
            const moved = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY);
            if (moved > 10) cleanup();
            return;
        }
        if (axis === 'x') {
            const pct = Math.min(78, Math.max(35, ((ev.clientX - rect.left) / rect.width) * 100));
            workspace.style.setProperty('--workspace-split-x', `${pct}%`);
        } else {
            const pct = Math.min(72, Math.max(28, ((ev.clientY - rect.top) / rect.height) * 100));
            workspace.style.setProperty('--workspace-split-y', `${pct}%`);
        }
    };

    holdTimer = window.setTimeout(() => {
        dragging = true;
        splitter?.classList.remove('arming');
        splitter?.classList.add('dragging');
        workspace.classList.add('splitting');
    }, 320);
    splitter?.classList.add('arming');

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
}

function renderRemoteServers() { const ssh = connections.filter((c) => c.protocol === 'SSH'); $('#remoteServerList').innerHTML = ssh.length ? ssh.map((c) => `<label class="server-check"><input type="checkbox" value="${c.id}"> <span>${escapeHtml(c.name)}</span><em>${escapeHtml(c.host)}</em></label>`).join('') : '<div class="empty-card">暂无 SSH 连接</div>'; }
async function remoteExecute(e) { e.preventDefault(); const ids = $$('#remoteServerList input:checked').map((i) => i.value); try { $('#remoteResults').innerHTML = '<div class="empty-card">执行中...</div>'; const data = await api('/api/remote-execute', { method: 'POST', body: JSON.stringify({ connectionIds: ids, command: $('#remoteCommand').value, timeoutSeconds: Number($('#remoteTimeout').value) || 30 }) }); $('#remoteResults').innerHTML = data.results.map((r) => `<article class="result-card ${r.success ? 'ok' : 'fail'}"><h3>${escapeHtml(r.name)} <span>${escapeHtml(r.status)} · ${r.durationMs}ms</span></h3>${r.error ? `<p class="error-text">${escapeHtml(r.error)}</p>` : ''}<pre>${escapeHtml(r.stdout || '')}</pre>${r.stderr ? `<pre class="stderr">${escapeHtml(r.stderr)}</pre>` : ''}</article>`).join(''); await loadConnections(); } catch (err) { toast(err.message); } }

async function loadSettings() {
    settings = await api('/api/settings').catch(() => ({})); const sec = settings.security || {}, cap = settings.captcha || {}, mail = settings.mail || {}, beian = settings.beian || {};
    $('#versionText').textContent = settings.version || '3.0.0'; $('#icpInput').value = beian.icp ?? settings.icp ?? ''; $('#policeInput').value = beian.policeBeian ?? settings.policeBeian ?? ''; $('#policeUrlInput').value = beian.policeBeianUrl ?? settings.policeBeianUrl ?? ''; $('#showBeianInput').checked = (beian.show ?? settings.showBeian) !== false;
    $('#ipWhitelistEnabled').checked = !!sec.ipWhitelistEnabled; $('#ipWhitelist').value = sec.ipWhitelist || ''; $('#bruteForceEnabled').checked = sec.bruteForceEnabled !== false; $('#bruteForceMaxFailures').value = sec.bruteForceMaxFailures || 5; $('#bruteForceBanMinutes').value = sec.bruteForceBanMinutes || 15;
    $('#captchaEnabled').checked = !!cap.enabled; $('#captchaProvider').value = cap.provider || 'turnstile'; $('#captchaSiteKey').value = cap.siteKey || cap.tencentCaptchaAppId || ''; $('#captchaSecretKey').value = cap.secretKey || '';
    $('#mailEnabled').checked = !!mail.enabled; $('#mailHost').value = mail.host || ''; $('#mailPort').value = mail.port || 465; $('#mailSecure').checked = mail.secure !== false; $('#mailUser').value = mail.user || ''; $('#mailPass').value = mail.pass || ''; $('#mailFrom').value = mail.from || ''; $('#mailAdminEmail').value = mail.adminEmail || ''; $('#notifyLoginSuccess').checked = mail.notifyLoginSuccess !== false; $('#notifyLoginFailure').checked = mail.notifyLoginFailure !== false; $('#geoLookupEnabled').checked = mail.geoLookupEnabled !== false;
    await loadSecurityStatus(); await loadSecurityLists();
}
async function saveBeian(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ beian: { icp: $('#icpInput').value, policeBeian: $('#policeInput').value, policeBeianUrl: $('#policeUrlInput').value, show: $('#showBeianInput').checked } }) }); toast('备案信息已保存'); }
async function loadSecurityStatus() { securityStatus = await api('/api/security/status').catch(() => ({ user: {}, passkeys: [] })); $('#profileUsername').value = securityStatus.user.username || ''; $('#profileEmail').value = securityStatus.user.email || ''; renderTotp(); renderPasskeys(); }
async function loadSecurityLists() { ipBans = (await api('/api/security/ip-bans').catch(() => ({ bans: [] }))).bans || []; loginEvents = (await api('/api/security/login-events').catch(() => ({ events: [] }))).events || []; renderSecurityLists(); }
function renderTotp() { $('#totpBox').innerHTML = `<div class="mini-item"><b>TOTP 状态</b><span>${securityStatus.user.totpEnabled ? '已开启' : '未开启'}</span><button id="setupTotpBtn">${securityStatus.user.totpEnabled ? '重新绑定' : '开启 TOTP'}</button></div>`; $('#totpDisableForm').classList.toggle('force-hidden', !securityStatus.user.totpEnabled); }
function renderPasskeys() { $('#passkeyList').innerHTML = (securityStatus.passkeys || []).map((p) => `<div class="mini-item"><b>Passkey</b><span>${fmtTime(p.createdAt)}</span><button data-del-passkey="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无 Passkey</p>'; }
function renderSecurityLists() { $('#ipBanList').innerHTML = ipBans.map((b) => `<div class="mini-item"><b>${escapeHtml(b.ip)}</b><span>失败 ${b.failedCount} · 解封 ${fmtTime(b.bannedUntil)}</span><button data-unban="${escapeHtml(b.ip)}">解除</button></div>`).join('') || '<p class="muted">暂无封禁 IP</p>'; $('#loginEventList').innerHTML = loginEvents.slice(0, 20).map((e) => `<div class="mini-item"><b>${e.success ? '成功' : '失败'} · ${escapeHtml(e.username || '-')}</b><span>${escapeHtml(e.ip || '')} · ${escapeHtml(e.reason || '')} · ${fmtTime(e.time)}</span></div>`).join('') || '<p class="muted">暂无登录事件</p>'; }
async function saveSecurityPolicy(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ security: { ipWhitelistEnabled: $('#ipWhitelistEnabled').checked, ipWhitelist: $('#ipWhitelist').value, bruteForceEnabled: $('#bruteForceEnabled').checked, bruteForceMaxFailures: Number($('#bruteForceMaxFailures').value) || 5, bruteForceBanMinutes: Number($('#bruteForceBanMinutes').value) || 15 } }) }); toast('安全策略已保存'); }
async function saveCaptcha(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ captcha: { enabled: $('#captchaEnabled').checked, provider: $('#captchaProvider').value, siteKey: $('#captchaSiteKey').value, secretKey: $('#captchaSecretKey').value, tencentCaptchaAppId: $('#captchaProvider').value === 'tencent' ? $('#captchaSiteKey').value : '' } }) }); toast('CAPTCHA 已保存'); }
async function saveMail(e) { e.preventDefault(); settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ mail: { enabled: $('#mailEnabled').checked, host: $('#mailHost').value, port: Number($('#mailPort').value) || 465, secure: $('#mailSecure').checked, user: $('#mailUser').value, pass: $('#mailPass').value, from: $('#mailFrom').value, adminEmail: $('#mailAdminEmail').value, notifyLoginSuccess: $('#notifyLoginSuccess').checked, notifyLoginFailure: $('#notifyLoginFailure').checked, geoLookupEnabled: $('#geoLookupEnabled').checked } }) }); toast('邮件设置已保存'); }
async function setupTotp() { const r = await api('/api/security/totp/setup', { method: 'POST', body: '{}' }); $('#totpEnableForm').classList.remove('force-hidden'); $('#totpQrBox').innerHTML = `<img class="qr-img" src="${r.qr}"><p class="muted">密钥：${escapeHtml(r.secret)}</p>`; }
async function registerPasskey() { try { if (!window.PublicKeyCredential) return toast('当前浏览器不支持 Passkey'); const options = await api('/api/passkeys/register/options', { method: 'POST', body: '{}' }); options.challenge = base64urlToBuffer(options.challenge); options.user.id = base64urlToBuffer(options.user.id); (options.excludeCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); }); const cred = await navigator.credentials.create({ publicKey: options }); if (!cred) return toast('Passkey 创建被取消'); const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), attestationObject: bufferToBase64url(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] } }; await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(payload) }); toast('Passkey 已绑定'); await loadSecurityStatus(); } catch (err) { toast('Passkey 注册失败：' + err.message); } }
async function loadNetwork() { proxies = (await api('/api/proxies')).proxies || []; jumpHosts = (await api('/api/jump-hosts')).jumpHosts || []; renderNetwork(); updateRouteOptions(); }
function renderNetwork() { $('#proxyList').innerHTML = proxies.map((p) => `<div class="mini-item"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.host)}:${p.port}</span><button data-edit-proxy="${p.id}">编辑</button><button data-del-proxy="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无代理</p>'; $('#jumpList').innerHTML = jumpHosts.map((j) => `<div class="mini-item"><b>${escapeHtml(j.name)}</b><span>${escapeHtml(connections.find((c) => c.id === j.connectionId)?.name || j.connectionId)}</span><button data-edit-jump="${j.id}">编辑</button><button data-del-jump="${j.id}">删除</button></div>`).join('') || '<p class="muted">暂无跳板机</p>'; renderJumpOptions(); }
function renderJumpOptions() { $('#jumpConnection').innerHTML = connections.filter((c) => c.protocol === 'SSH').map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.host)})</option>`).join(''); }
async function saveProxy(e) { e.preventDefault(); const id = $('#proxyId').value, payload = { name: $('#proxyName').value, host: $('#proxyHost').value, port: Number($('#proxyPort').value), username: $('#proxyUsername').value, password: $('#proxyPassword').value }; await api(id ? `/api/proxies/${id}` : '/api/proxies', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); e.target.reset(); $('#proxyId').value = ''; await loadNetwork(); toast('代理已保存'); }
async function saveJump(e) { e.preventDefault(); const id = $('#jumpId').value, payload = { name: $('#jumpName').value, connectionId: $('#jumpConnection').value }; await api(id ? `/api/jump-hosts/${id}` : '/api/jump-hosts', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); e.target.reset(); $('#jumpId').value = ''; await loadNetwork(); toast('跳板机已保存'); }

function bindEvents() {
    $$('.nav-tab').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('.settings-tab').forEach((btn) => btn.addEventListener('click', () => { $$('.settings-tab').forEach((b) => b.classList.remove('active')); btn.classList.add('active'); $$('.settings-panel').forEach((p) => p.classList.remove('active')); $(`#settings-${btn.dataset.settings}`).classList.add('active'); }));
    $('#appThemeToggle').addEventListener('click', toggleTheme); $('#settingsThemeToggle').addEventListener('click', toggleTheme); $('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
    $('#addConnectionBtn').addEventListener('click', () => openModal()); $('#closeModalBtn').addEventListener('click', closeModal); $('#cancelModalBtn').addEventListener('click', closeModal); $('#toggleConnPassword').addEventListener('click', () => { const el = $('#connPassword'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleConnPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; }); $('#revealConnSecrets').addEventListener('click', () => revealConnectionSecrets().catch((err) => toast(err.message))); $('#connMode').addEventListener('change', () => updateRouteOptions()); $('#routeUpBtn')?.addEventListener('click', () => moveSelectedRouteOption(-1)); $('#routeDownBtn')?.addEventListener('click', () => moveSelectedRouteOption(1)); $('#testConnectionBtn').addEventListener('click', testConnection);
    $('#connectionForm').addEventListener('submit', saveConnection); ['searchInput', 'protocolFilter', 'tagFilter', 'sortSelect'].forEach((id) => $(`#${id}`).addEventListener('input', renderConnections));
    $('#connectionGrid').addEventListener('click', async (e) => { const edit = e.target.closest('[data-edit]')?.dataset.edit, del = e.target.closest('[data-delete]')?.dataset.delete, connect = e.target.closest('[data-connect]')?.dataset.connect; if (edit) openModal(connections.find((c) => c.id === edit)); if (del && confirm('确定删除该连接？')) { await api(`/api/connections/${del}`, { method: 'DELETE' }); await loadConnections(); toast('连接已删除'); } if (connect) openConnection(connect).catch((err) => toast(err.message)); });
    $('#sessionTabs').addEventListener('click', (e) => {
        if (e.target.closest('[data-smartbar-toggle]')) { setTerminalSmartbarOpen(!terminalSmartbarOpen); return; }
        if (e.target.closest('[data-smartbar-add]')) { switchView('dashboard'); setTerminalSmartbarOpen(false); toast('请从仪表盘选择或新建连接'); return; }
        const tab = e.target.closest('[data-smartbar-tab]')?.dataset.smartbarTab;
        if (tab) { restoreTerminalSession(tab); activeTerminalTab = tab; touchTerminalSession(tab); setTerminalSmartbarOpen(false); renderTerminalTabs(); }
    });
    $('#terminalWorkspace').addEventListener('click', (e) => {
        noteTerminalWorkspaceActivity();
        const menuBtn = e.target.closest('[data-window-menu]');
        $$('.terminal-window-titlebar.menu-open').forEach((el) => { if (!menuBtn || !el.contains(menuBtn)) el.classList.remove('menu-open'); });
        if (menuBtn) { e.stopPropagation(); menuBtn.closest('.terminal-window-titlebar')?.classList.toggle('menu-open'); return; }
        const action = e.target.closest('[data-window-action]');
        if (action) { e.stopPropagation(); applyTerminalWindowPreset(action.dataset.window, action.dataset.windowAction); return; }
        const win = e.target.closest('[data-window]');
        if (win) { activeTerminalTab = win.dataset.window; touchTerminalSession(activeTerminalTab); renderTerminalTabs({ rebuildWorkspace: false }); }
    });
    $('#terminalWorkspace').addEventListener('pointerdown', (e) => {
        const splitter = e.target.closest('[data-splitter]');
        if (splitter) { startWorkspaceSplitterDrag(e, splitter.dataset.splitter); return; }
        const drag = e.target.closest('[data-window-drag]');
        if (drag) startTerminalWindowDrag(e, drag.dataset.windowDrag);
    });
    ['keydown', 'pointerdown'].forEach((eventName) => document.addEventListener(eventName, (e) => { if (e.target.closest?.('#terminalWorkspace')) noteTerminalWorkspaceActivity(); }, true));
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((eventName) => document.addEventListener(eventName, () => {
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
        if (fullscreenElement === $('#terminalWorkspace')) {
            appKeyboardBaseline = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, window.visualViewport?.height || 0);
            hideFullscreenLoading({ delay: 620 });
        } else {
            resetTerminalWorkspaceKeyboard();
            showFullscreenLoading('正在退出全屏...'), hideFullscreenLoading({ delay: 680 });
        }
    }));
    systemThemeQuery.addEventListener('change', () => { if (!localStorage.getItem('zephyr-theme')) applyTheme(getSystemTheme()); });
    window.addEventListener('message', (e) => { if (e.data?.source !== 'zephyr-terminal') return; if (e.data.type === 'keyboard-metrics') { applyTerminalWorkspaceKeyboard(e.data); return; } if (e.data.type === 'activity') { noteTerminalWorkspaceActivity(); return; } const t = terminalTabs.find((x) => x.id === e.data.tabId); if (t) { t.status = e.data.status || t.status; renderTerminalTabs({ rebuildWorkspace: false }); } });
    window.visualViewport?.addEventListener('resize', updateFullscreenKeyboardFromViewport, { passive: true });
    window.visualViewport?.addEventListener('scroll', updateFullscreenKeyboardFromViewport, { passive: true });
    window.addEventListener('resize', () => { if (terminalTabs.length) { enforceTerminalWorkspaceLimit(activeTerminalTab); renderTerminalTabs(); } });
    $('#remoteExecForm').addEventListener('submit', remoteExecute); $('#beianForm').addEventListener('submit', saveBeian); $('#proxyForm').addEventListener('submit', saveProxy); $('#jumpForm').addEventListener('submit', saveJump);
    $('#proxyList').addEventListener('click', async (e) => { const id = e.target.dataset.editProxy || e.target.dataset.delProxy; if (!id) return; const p = proxies.find((x) => x.id === id); if (e.target.dataset.editProxy) { $('#proxyId').value = p.id; $('#proxyName').value = p.name; $('#proxyHost').value = p.host; $('#proxyPort').value = p.port; $('#proxyUsername').value = p.username || ''; $('#proxyPassword').value = p.hasPassword ? '******' : ''; } else if (confirm('删除代理？')) { await api(`/api/proxies/${id}`, { method: 'DELETE' }); await loadNetwork(); } });
    $('#jumpList').addEventListener('click', async (e) => { const id = e.target.dataset.editJump || e.target.dataset.delJump; if (!id) return; const j = jumpHosts.find((x) => x.id === id); if (e.target.dataset.editJump) { $('#jumpId').value = j.id; $('#jumpName').value = j.name; $('#jumpConnection').value = j.connectionId; } else if (confirm('删除跳板机？')) { await api(`/api/jump-hosts/${id}`, { method: 'DELETE' }); await loadNetwork(); } });
    $('#passwordForm').addEventListener('submit', async (e) => { e.preventDefault(); const currentPassword = $('#settingsCurrentPassword').value, newPassword = $('#settingsNewPassword').value, confirmPassword = $('#settingsConfirmPassword').value; if (newPassword !== confirmPassword) return toast('两次输入的新密码不一致'); await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); e.target.reset(); toast('密码已更新'); });
    $('#profileForm').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/profile', { method: 'PUT', body: JSON.stringify({ username: $('#profileUsername').value.trim(), email: $('#profileEmail').value }) }); toast('资料已保存'); await loadSecurityStatus(); });
    $('#securityPolicyForm').addEventListener('submit', saveSecurityPolicy); $('#captchaForm').addEventListener('submit', saveCaptcha); $('#mailForm').addEventListener('submit', saveMail);
    $('#totpBox').addEventListener('click', (e) => { if (e.target.id === 'setupTotpBtn') setupTotp().catch((err) => toast(err.message)); });
    $('#totpEnableForm').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/totp/enable', { method: 'POST', body: JSON.stringify({ code: $('#totpEnableCode').value }) }); toast('TOTP 已开启'); $('#totpEnableForm').classList.add('force-hidden'); await loadSecurityStatus(); });
    $('#totpDisableForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm('确定关闭 TOTP？')) return; await api('/api/security/totp/disable', { method: 'POST', body: JSON.stringify({ currentPassword: $('#totpDisablePassword').value, code: $('#totpDisableCode').value }) }); e.target.reset(); toast('TOTP 已关闭'); await loadSecurityStatus(); });
    $('#addPasskeyBtn').addEventListener('click', () => registerPasskey().catch((err) => toast(err.message)));
    $('#passkeyList').addEventListener('click', async (e) => { const id = e.target.dataset.delPasskey; if (id && confirm('删除该 Passkey？')) { await api(`/api/passkeys/${id}`, { method: 'DELETE' }); await loadSecurityStatus(); } });
    $('#ipBanList').addEventListener('click', async (e) => { const ip = e.target.dataset.unban; if (ip) { await api(`/api/security/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' }); await loadSecurityLists(); toast('已解除封禁'); } });
    $('#testMailBtn').addEventListener('click', async () => { await api('/api/settings/test-mail', { method: 'POST', body: JSON.stringify({ to: $('#mailAdminEmail').value }) }); toast('测试邮件已发送'); });
    $('#exportDataBtn').addEventListener('click', () => { location.href = '/api/data/export'; });
    $('#clearActivityBtn').addEventListener('click', async () => { if (!confirm('确定清理最近活动日志？')) return; await api('/api/activities', { method: 'DELETE' }); await loadConnections(); toast('活动日志已清理'); });
    $('#clearLoginEventsBtn').addEventListener('click', async () => { if (!confirm('确定清理登录事件日志？')) return; await api('/api/security/login-events', { method: 'DELETE' }); await loadSecurityLists(); toast('登录事件已清理'); });
    $('#importDataForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm('导入会覆盖当前数据库，系统会先生成本地备份。继续？')) return; const fd = new FormData(); fd.append('backup', $('#backupFile').files[0]); fd.append('loginPassword', $('#importLoginPassword').value); fd.append('backupPassword', $('#backupPassword').value); const res = await fetch('/api/data/import', { method: 'POST', body: fd, credentials: 'same-origin' }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || '导入失败'); toast(data.message || '导入完成'); });
}
async function init() { applyTheme(getPreferredTheme()); try { const me = await api('/api/auth/me'); if (me.mustChangePassword) location.href = '/'; bindEvents(); await loadSettings(); await loadConnections(); await loadNetwork(); } catch { location.href = '/'; } }
init();
