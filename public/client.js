const $ = (sel) => document.querySelector(sel);
const errorBanner = $('#errorBanner');
const loginForm = $('#loginForm');
const themeToggleLogin = $('#themeToggleLogin');
const themeToggleChange = $('#themeToggleChange');
const themeToggleTotp = $('#themeToggleTotp');
const themeToggleForgot = $('#themeToggleForgot');
const loginCard = $('#loginCard');
const changePasswordCard = $('#changePasswordCard');
const totpCard = $('#totpCard');
const forgotCard = $('#forgotCard');
const changePasswordForm = $('#changePasswordForm');
const totpForm = $('#totpForm');
const forgotRequestForm = $('#forgotRequestForm');
const forgotResetForm = $('#forgotResetForm');
const changeErrorBanner = $('#changeErrorBanner');
const totpErrorBanner = $('#totpErrorBanner');
const forgotErrorBanner = $('#forgotErrorBanner');
const beianFooter = $('#beianFooter');
const REMEMBER_USERNAME_KEY = 'zephyr-remember-username';
let tempTotpToken = '';
let defaultUsername = 'admin';

function getPreferredTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme, { persist = false } = {}) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) localStorage.setItem('zephyr-theme', theme);
    [themeToggleLogin, themeToggleChange, themeToggleTotp, themeToggleForgot].filter(Boolean).forEach((btn) => { btn.textContent = theme === 'dark' ? '☀️' : '🌙'; });
}

applyTheme(getPreferredTheme());

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark', { persist: true });
}
themeToggleLogin?.addEventListener('click', toggleTheme);
themeToggleChange?.addEventListener('click', toggleTheme);
themeToggleTotp?.addEventListener('click', toggleTheme);
themeToggleForgot?.addEventListener('click', toggleTheme);

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zephyr-theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
    }
});

function api(path, options = {}) {
    return fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        credentials: 'same-origin',
        ...options,
    }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
    });
}

function showError(target, msg) {
    target.textContent = msg;
    target.classList.add('show');
    setTimeout(() => {
        target.classList.remove('show');
        target.textContent = '';
    }, 6000);
}

function showChangePassword() {
    loginCard.classList.add('force-hidden');
    totpCard.classList.add('force-hidden');
    forgotCard.classList.add('force-hidden');
    changePasswordCard.classList.remove('force-hidden');
    $('#newPassword').focus();
}
function showLogin() { [changePasswordCard, totpCard, forgotCard].forEach((el) => el.classList.add('force-hidden')); loginCard.classList.remove('force-hidden'); }
function showTotp(token) { tempTotpToken = token; loginCard.classList.add('force-hidden'); totpCard.classList.remove('force-hidden'); $('#totpCode').focus(); }
function showForgot() { loginCard.classList.add('force-hidden'); forgotCard.classList.remove('force-hidden'); }

function base64urlToBuffer(value) { const s = String(value).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)); }
function bufferToBase64url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

async function loadBeian() {
    try {
        const s = await api('/api/public/settings');
        defaultUsername = s.defaultUsername || 'admin';
        const usernameInput = $('#username');
        if (usernameInput) usernameInput.placeholder = defaultUsername;
        const hint = $('.auth-hint');
        if (hint) hint.textContent = `默认账号：${defaultUsername} / admin。首次登录需修改密码。`;
        initRememberMe();
        if (!s.showBeian || (!s.icp && !s.policeBeian)) { beianFooter.innerHTML = ''; return; }
        const parts = [];
        if (s.icp) parts.push(`<a href="https://beian.miit.gov.cn" target="_blank" rel="noreferrer">${s.icp}</a>`);
        if (s.policeBeian) parts.push(`<a href="${s.policeBeianUrl || 'https://www.beian.gov.cn/portal/registerSystemInfo'}" target="_blank" rel="noreferrer">🛡️ ${s.policeBeian}</a>`);
        beianFooter.innerHTML = parts.join('');
    } catch { beianFooter.innerHTML = ''; }
}

api('/api/auth/me').then((data) => {
    if (data.mustChangePassword) showChangePassword();
    else window.location.href = '/app.html';
}).catch(() => {});
loadBeian();

function initRememberMe() {
    const remembered = localStorage.getItem(REMEMBER_USERNAME_KEY) || '';
    const usernameInput = $('#username');
    if (!usernameInput) return;
    usernameInput.value = remembered || defaultUsername;
    $('#rememberMe').checked = !!remembered;
    (remembered ? $('#password') : usernameInput)?.focus();
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if ($('#rememberMe')?.checked) localStorage.setItem(REMEMBER_USERNAME_KEY, username);
    else localStorage.removeItem(REMEMBER_USERNAME_KEY);
    try {
        const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember: !!$('#rememberMe')?.checked }) });
        if (data.requireTotp) return showTotp(data.tempToken);
        if (data.mustChangePassword) showChangePassword();
        else window.location.href = '/app.html';
    } catch (err) {
        showError(errorBanner, err.message);
    }
});

totpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const data = await api('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ tempToken: tempTotpToken, code: $('#totpCode').value }) }); if (data.mustChangePassword) showChangePassword(); else location.href = '/app.html'; }
    catch (err) { showError(totpErrorBanner, err.message); }
});

$('#forgotLink').addEventListener('click', (e) => { e.preventDefault(); showForgot(); });
$('#backLoginLink').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
forgotRequestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/auth/forgot-password/request', { method: 'POST', body: JSON.stringify({ email: $('#forgotEmail').value }) }); forgotRequestForm.classList.add('force-hidden'); forgotResetForm.classList.remove('force-hidden'); showError(forgotErrorBanner, '如果邮箱匹配，验证码已发送'); }
    catch (err) { showError(forgotErrorBanner, err.message); }
});
forgotResetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/auth/forgot-password/reset', { method: 'POST', body: JSON.stringify({ email: $('#forgotEmail').value, code: $('#resetCode').value, newPassword: $('#resetPassword').value }) }); showLogin(); showError(errorBanner, '密码已重置，请重新登录'); }
    catch (err) { showError(forgotErrorBanner, err.message); }
});

$('#passkeyLoginBtn').addEventListener('click', async () => {
    try {
        if (!window.PublicKeyCredential) throw new Error('当前浏览器不支持 Passkey');
        const options = await api('/api/passkeys/login/options', { method: 'POST', body: '{}' });
        options.challenge = base64urlToBuffer(options.challenge);
        (options.allowCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); });
        const cred = await navigator.credentials.get({ publicKey: options });
        const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { authenticatorData: bufferToBase64url(cred.response.authenticatorData), clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), signature: bufferToBase64url(cred.response.signature), userHandle: cred.response.userHandle ? bufferToBase64url(cred.response.userHandle) : null } };
        const data = await api('/api/passkeys/login/verify', { method: 'POST', body: JSON.stringify(payload) });
        if (data.mustChangePassword) showChangePassword(); else location.href = '/app.html';
    } catch (err) { showError(errorBanner, err.message); }
});

changePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = $('#currentPassword').value;
    const newPassword = $('#newPassword').value;
    const confirmPassword = $('#confirmPassword').value;
    if (newPassword !== confirmPassword) return showError(changeErrorBanner, '两次输入的新密码不一致');
    try {
        await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
        window.location.href = '/app.html';
    } catch (err) {
        showError(changeErrorBanner, err.message);
    }
});