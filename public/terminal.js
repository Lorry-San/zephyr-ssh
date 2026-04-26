import { Terminal } from '@wterm/core';
import { DomRenderer } from '@wterm/dom';

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: false
});

const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const copyToast = document.getElementById('copyToast');

let term = null;
let renderer = null;
let reconnectAttempts = 0;

function showToast(message, isError = false) {
    copyToast.textContent = message || '✓ 已复制';
    copyToast.style.background = isError ? '#da3633' : '#238636';
    copyToast.style.opacity = '1';
    setTimeout(() => {
        copyToast.style.opacity = '0';
    }, 2000);
}

function updateStatus(connected, message) {
    statusText.textContent = message || (connected ? '已连接' : '连接中...');
    if (connected) {
        statusIndicator.classList.add('connected');
    } else {
        statusIndicator.classList.remove('connected');
    }
}

async function initTerminal() {
    const container = document.getElementById('terminal-container');
    
    // 获取存储的配置
    const configStr = sessionStorage.getItem('zephyrConfig');
    if (!configStr) {
        container.innerHTML = '<div style="color: #f85149; padding: 20px;">❌ 配置丢失，3秒后返回登录页</div>';
        setTimeout(() => {
            window.location.href = '/';
        }, 3000);
        return;
    }
    
    const config = JSON.parse(configStr);
    
    // 创建 wterm 终端（DOM 渲染，原生支持文字选择）
    term = new Terminal({
        cols: 80,
        rows: 24,
        theme: {
            background: '#0a0e12',
            foreground: '#c9d1d9',
            cursor: '#f0f0f0',
            selection: '#264f78'
        }
    });
    
    renderer = new DomRenderer(term, container, {
        fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 13,
        lineHeight: 1.2,
        letterSpacing: 0
    });
    
    renderer.attach();
    
    // 监听终端输入
    term.onData((data) => {
        socket.emit('ssh-input', data);
    });
    
    // 监听终端大小变化
    const resizeObserver = new ResizeObserver(() => {
        if (term && container) {
            const cols = Math.floor(container.clientWidth / 7.8);
            const rows = Math.floor(container.clientHeight / 15.6);
            if (cols > 10 && rows > 5) {
                term.resize(cols, rows);
                socket.emit('ssh-resize', { cols: term.cols, rows: term.rows });
            }
        }
    });
    resizeObserver.observe(container);
    
    // 监听复制事件，显示提示
    document.addEventListener('copy', () => {
        showToast('✓ 已复制到剪贴板');
    });
    
    // 连接 SSH
    updateStatus(false, '正在连接...');
    socket.emit('ssh-connect', config);
    
    // 清除配置（安全）
    sessionStorage.removeItem('zephyrConfig');
}

// Socket 事件
socket.on('ssh-ready', (msg) => {
    updateStatus(true, msg || '已连接');
    if (term) term.write(`\x1b[32m✨ ${msg || '连接成功'}\x1b[0m\r\n`);
});

socket.on('ssh-data', (data) => {
    if (term) term.write(data);
});

socket.on('ssh-error', (err) => {
    updateStatus(false, '连接失败');
    if (term) {
        term.write(`\x1b[31m❌ 错误: ${err}\x1b[0m\r\n`);
    } else {
        showToast(err, true);
    }
});

socket.on('ssh-closed', (msg) => {
    updateStatus(false, '已断开');
    if (term) term.write(`\x1b[33m⚠️ ${msg || '连接已关闭'}\x1b[0m\r\n`);
});

socket.on('disconnect', () => {
    updateStatus(false, 'WebSocket 断开');
    if (term) term.write('\x1b[33m⚠️ 连接已断开，请刷新页面重试\x1b[0m\r\n');
});

// 启动
initTerminal();