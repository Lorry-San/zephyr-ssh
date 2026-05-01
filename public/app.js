const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let connections = [], activities = [], proxies = [], jumpHosts = [], settings = {};
let editingId = null;
let editingSecretLoaded = false;
let terminalTabs = [], activeTerminalTab = null;
let fullscreenLoadingTimer = 0;
let securityStatus = { user: {}, passkeys: [] }, ipBans = [], loginEvents = [];

function api(path, options = {}) {
    return fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || data.message || '请求失败'); return data; });
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function getPreferredTheme() { const saved = localStorage.getItem('zephyr-theme'); return saved === 'light' || saved === 'dark' ? saved : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); }
function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('zephyr-theme', theme); $('#appThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙'; }
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
function escapeHtml(str) { return String(str || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function renderMarkdown(md) { let s = escapeHtml(md); s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); return s.replace(/\n/g, '<br>'); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '从未连接'; }
function switchView(name) { $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`)); }
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
    const list = mode === 'proxy' ? proxies.map((p) => ({ id: p.id, name: `代理：${p.name}` })) : mode === 'jump' ? jumpHosts.map((j) => ({ id: j.id, name: `跳板：${j.name}` })) : [];
    $('#connRoute').innerHTML = '<option value="">无</option>' + list.map((x) => `<option value="${x.id}" ${selected === x.id ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
}
function openModal(conn = null) {
    editingId = conn?.id || null; editingSecretLoaded = false; $('#modalTitle').textContent = editingId ? '编辑服务器' : '添加服务器'; $('#connectionId').value = editingId || '';
    $('#connName').value = conn?.name || ''; $('#connProtocol').value = conn?.protocol || 'SSH'; $('#connHost').value = conn?.host || ''; $('#connPort').value = conn?.port || 22; $('#connUsername').value = conn?.username || '';
    $('#connTags').value = (conn?.tags || []).join(', '); $('#connMode').value = conn?.connectionMode || 'direct'; updateRouteOptions($('#connMode').value, conn?.proxyId || conn?.jumpHostId || '');
    $('#connPassword').type = 'password'; $('#toggleConnPassword').textContent = '👁️'; $('#connPassword').value = conn?.hasPassword ? '******' : ''; $('#connPrivateKey').value = conn?.hasPrivateKey ? '******' : ''; $('#revealConnSecrets').classList.toggle('force-hidden', !editingId || (!conn?.hasPassword && !conn?.hasPrivateKey)); $('#connRemark').value = conn?.remark || ''; $('#connectionModal').classList.add('show');
}
function closeModal() { $('#connectionModal').classList.remove('show'); }
function connectionPayload({ forTest = false } = {}) { const mode = $('#connMode').value, route = $('#connRoute').value; const payload = { name: $('#connName').value.trim(), protocol: $('#connProtocol').value, host: $('#connHost').value.trim(), port: Number($('#connPort').value) || 22, username: $('#connUsername').value.trim(), password: $('#connPassword').value, privateKey: $('#connPrivateKey').value, remark: $('#connRemark').value, tags: parseTags($('#connTags').value), connectionMode: mode, proxyId: mode === 'proxy' ? route : '', jumpHostId: mode === 'jump' ? route : '' }; if (!forTest && editingId) { if (payload.password === '******') delete payload.password; if (payload.privateKey === '******') delete payload.privateKey; } return payload; }
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
    sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify({ host: c.host, port: c.port, username: c.username, password: c.password || '', privateKey: c.privateKey || '', init: '', tabId, embedded: true, timestamp: Date.now() }));
    terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: 'connecting', iframe: true }); activeTerminalTab = tabId; renderTerminalTabs(); switchView('terminal'); await loadConnections();
}
function openPlaceholderTab(c) { const tabId = `tab_${Date.now()}`; terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: '占位', iframe: false }); activeTerminalTab = tabId; renderTerminalTabs(); switchView('terminal'); }
function renderTerminalTabs({ rebuildWorkspace = true } = {}) {
    $('#sessionTabs').innerHTML = terminalTabs.length ? terminalTabs.map((t) => `<button class="session-tab ${t.id === activeTerminalTab ? 'active' : ''}" data-tab="${t.id}"><span>${escapeHtml(t.protocol)} · ${escapeHtml(t.name)}</span><em>${escapeHtml(t.status)}</em><i title="全屏" data-fullscreen-tab="${t.id}">⛶</i><b data-close-tab="${t.id}">×</b></button>`).join('') : '<div class="empty-state">从仪表盘点击“连接”打开 SSH 会话。</div>';
    if (rebuildWorkspace) $('#terminalWorkspace').innerHTML = terminalTabs.length ? terminalTabs.map((t) => t.iframe ? `<iframe class="terminal-frame ${t.id === activeTerminalTab ? 'active' : ''}" data-frame="${t.id}" src="/terminal.html?embed=1&tabId=${encodeURIComponent(t.id)}"></iframe>` : `<div class="terminal-placeholder ${t.id === activeTerminalTab ? 'active' : ''}" data-frame="${t.id}">${escapeHtml(t.protocol)} 协议将在后续版本接入。</div>`).join('') : '<div class="terminal-placeholder">暂无会话。</div>';
    else $$('#terminalWorkspace [data-frame]').forEach((el) => el.classList.toggle('active', el.dataset.frame === activeTerminalTab));
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
    workspace.classList.add('fullscreen-loading');
    window.clearTimeout(fullscreenLoadingTimer);
    fullscreenLoadingTimer = window.setTimeout(() => hideFullscreenLoading(), 1800);
}

function hideFullscreenLoading({ delay = 260 } = {}) {
    window.clearTimeout(fullscreenLoadingTimer);
    fullscreenLoadingTimer = window.setTimeout(() => {
        $('#terminalWorkspace')?.classList.remove('fullscreen-loading');
    }, delay);
}

async function fullscreenTerminalTab(tabId) {
    activeTerminalTab = tabId;
    renderTerminalTabs({ rebuildWorkspace: false });
    const target = $('#terminalWorkspace');
    if (!target) return;
    showFullscreenLoading('正在进入全屏...');
    try {
        if (target.requestFullscreen) await target.requestFullscreen();
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
async function registerPasskey() { if (!window.PublicKeyCredential) return toast('当前浏览器不支持 Passkey'); const options = await api('/api/passkeys/register/options', { method: 'POST', body: '{}' }); options.challenge = base64urlToBuffer(options.challenge); options.user.id = base64urlToBuffer(options.user.id); (options.excludeCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); }); const cred = await navigator.credentials.create({ publicKey: options }); const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), attestationObject: bufferToBase64url(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] } }; await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(payload) }); toast('Passkey 已绑定'); await loadSecurityStatus(); }
async function loadNetwork() { proxies = (await api('/api/proxies')).proxies || []; jumpHosts = (await api('/api/jump-hosts')).jumpHosts || []; renderNetwork(); updateRouteOptions(); }
function renderNetwork() { $('#proxyList').innerHTML = proxies.map((p) => `<div class="mini-item"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.host)}:${p.port}</span><button data-edit-proxy="${p.id}">编辑</button><button data-del-proxy="${p.id}">删除</button></div>`).join('') || '<p class="muted">暂无代理</p>'; $('#jumpList').innerHTML = jumpHosts.map((j) => `<div class="mini-item"><b>${escapeHtml(j.name)}</b><span>${escapeHtml(connections.find((c) => c.id === j.connectionId)?.name || j.connectionId)}</span><button data-edit-jump="${j.id}">编辑</button><button data-del-jump="${j.id}">删除</button></div>`).join('') || '<p class="muted">暂无跳板机</p>'; renderJumpOptions(); }
function renderJumpOptions() { $('#jumpConnection').innerHTML = connections.filter((c) => c.protocol === 'SSH').map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.host)})</option>`).join(''); }
async function saveProxy(e) { e.preventDefault(); const id = $('#proxyId').value, payload = { name: $('#proxyName').value, host: $('#proxyHost').value, port: Number($('#proxyPort').value), username: $('#proxyUsername').value, password: $('#proxyPassword').value }; await api(id ? `/api/proxies/${id}` : '/api/proxies', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); e.target.reset(); $('#proxyId').value = ''; await loadNetwork(); toast('代理已保存'); }
async function saveJump(e) { e.preventDefault(); const id = $('#jumpId').value, payload = { name: $('#jumpName').value, connectionId: $('#jumpConnection').value }; await api(id ? `/api/jump-hosts/${id}` : '/api/jump-hosts', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); e.target.reset(); $('#jumpId').value = ''; await loadNetwork(); toast('跳板机已保存'); }

function bindEvents() {
    $$('.nav-tab').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('.settings-tab').forEach((btn) => btn.addEventListener('click', () => { $$('.settings-tab').forEach((b) => b.classList.remove('active')); btn.classList.add('active'); $$('.settings-panel').forEach((p) => p.classList.remove('active')); $(`#settings-${btn.dataset.settings}`).classList.add('active'); }));
    $('#appThemeToggle').addEventListener('click', toggleTheme); $('#settingsThemeToggle').addEventListener('click', toggleTheme); $('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
    $('#addConnectionBtn').addEventListener('click', () => openModal()); $('#closeModalBtn').addEventListener('click', closeModal); $('#cancelModalBtn').addEventListener('click', closeModal); $('#toggleConnPassword').addEventListener('click', () => { const el = $('#connPassword'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleConnPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; }); $('#revealConnSecrets').addEventListener('click', () => revealConnectionSecrets().catch((err) => toast(err.message))); $('#connMode').addEventListener('change', () => updateRouteOptions()); $('#testConnectionBtn').addEventListener('click', testConnection);
    $('#connectionForm').addEventListener('submit', saveConnection); ['searchInput', 'protocolFilter', 'tagFilter', 'sortSelect'].forEach((id) => $(`#${id}`).addEventListener('input', renderConnections));
    $('#connectionGrid').addEventListener('click', async (e) => { const edit = e.target.closest('[data-edit]')?.dataset.edit, del = e.target.closest('[data-delete]')?.dataset.delete, connect = e.target.closest('[data-connect]')?.dataset.connect; if (edit) openModal(connections.find((c) => c.id === edit)); if (del && confirm('确定删除该连接？')) { await api(`/api/connections/${del}`, { method: 'DELETE' }); await loadConnections(); toast('连接已删除'); } if (connect) openConnection(connect).catch((err) => toast(err.message)); });
    $('#sessionTabs').addEventListener('click', (e) => { const full = e.target.closest('[data-fullscreen-tab]')?.dataset.fullscreenTab; const close = e.target.closest('[data-close-tab]')?.dataset.closeTab; const tab = e.target.closest('[data-tab]')?.dataset.tab; if (full) { e.stopPropagation(); fullscreenTerminalTab(full).catch((err) => toast(err.message)); return; } if (close) { terminalTabs = terminalTabs.filter((t) => t.id !== close); sessionStorage.removeItem(`zephyr_ssh_params_${close}`); if (activeTerminalTab === close) activeTerminalTab = terminalTabs[0]?.id || null; renderTerminalTabs(); return; } if (tab) { activeTerminalTab = tab; renderTerminalTabs(); } });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((eventName) => document.addEventListener(eventName, () => {
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
        if (fullscreenElement === $('#terminalWorkspace')) hideFullscreenLoading({ delay: 360 });
        else showFullscreenLoading('正在退出全屏...'), hideFullscreenLoading({ delay: 420 });
    }));
    window.addEventListener('message', (e) => { if (e.data?.source !== 'zephyr-terminal') return; const t = terminalTabs.find((x) => x.id === e.data.tabId); if (t) { t.status = e.data.status || t.status; renderTerminalTabs({ rebuildWorkspace: false }); } });
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
