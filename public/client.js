const $ = (sel) => document.querySelector(sel);
const errorBanner = $('#errorBanner');
const loginForm = $('#loginForm');
const toggleKeyBtn = $('#toggleKeyBtn');
const keySection = $('#keySection');
const privateKeyTA = $('#privateKey');
const themeToggleLogin = $('#themeToggleLogin');

// ===== 主题管理 (登录页) =====
function getPreferredTheme() {
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('zephyr-theme', theme);
    if (themeToggleLogin) {
        themeToggleLogin.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
}

applyTheme(getPreferredTheme());

themeToggleLogin.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zephyr-theme')) {
        applyTheme(e.matches ? 'light' : 'dark');
    }
});

// ===== 原有登录逻辑 =====
let keyVisible = false;
toggleKeyBtn.addEventListener('click', () => {
    keyVisible = !keyVisible;
    keySection.classList.toggle('show', keyVisible);
    toggleKeyBtn.textContent = keyVisible ? '🔒 使用密码认证' : '🔑 使用私钥认证';
    if (!keyVisible) privateKeyTA.value = '';
    if (keyVisible) privateKeyTA.focus();
});

function hideError() {
    errorBanner.classList.remove('show');
    errorBanner.textContent = '';
}

function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.add('show');
    setTimeout(hideError, 6000);
}

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    hideError();

    const host = $('#host').value.trim();
    const port = parseInt($('#port').value, 10);
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const privateKey = privateKeyTA.value.trim();
    const initCmd = $('#initCmd').value.trim();

    if (!host) { showError('请输入主机地址'); $('#host').focus(); return; }
    if (!port || port < 1 || port > 65535) { showError('端口号需要在 1-65535 之间'); $('#port').focus(); return; }
    if (!username) { showError('请输入用户名'); $('#username').focus(); return; }
    if (!password && !privateKey) { showError('请提供密码或私钥'); $('#password').focus(); return; }
    if (privateKey && !privateKey.includes('-----BEGIN')) {
        showError('私钥格式不正确，需要 PEM 格式（以 -----BEGIN 开头）'); return;
    }

    const connParams = {
        host,
        port,
        username,
        password: password || '',
        privateKey: privateKey || '',
        init: initCmd || '',
        timestamp: Date.now(),
    };
    sessionStorage.setItem('zephyr_ssh_params', JSON.stringify(connParams));
    window.location.href = '/terminal.html';
});