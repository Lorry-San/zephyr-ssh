const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: false
});

let isConnecting = false;

// DOM 元素
const hostname = document.getElementById('hostname');
const port = document.getElementById('port');
const username = document.getElementById('username');
const password = document.getElementById('password');
const privateKey = document.getElementById('privateKey');
const passphrase = document.getElementById('passphrase');
const initialCommand = document.getElementById('initialCommand');
const connectBtn = document.getElementById('connectBtn');
const resetBtn = document.getElementById('resetBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileName = document.getElementById('fileName');

// 连接按钮
connectBtn.addEventListener('click', () => {
    if (isConnecting) return;
    
    const host = hostname.value.trim();
    const user = username.value.trim();
    
    if (!host) {
        alert('请输入主机地址');
        return;
    }
    if (!user) {
        alert('请输入用户名');
        return;
    }
    
    const config = {
        host,
        port: port.value || '22',
        username: user,
        password: password.value,
        privateKey: privateKey.value,
        passphrase: passphrase.value,
        initialCommand: initialCommand.value
    };
    
    // 存储配置，跳转到终端页面
    sessionStorage.setItem('zephyrConfig', JSON.stringify(config));
    window.location.href = '/terminal.html';
});

// 重置按钮
resetBtn.addEventListener('click', () => {
    hostname.value = '';
    port.value = '22';
    username.value = '';
    password.value = '';
    privateKey.value = '';
    passphrase.value = '';
    initialCommand.value = '';
    fileName.textContent = '未上传文件';
});

// 上传私钥
uploadBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pem,.key,.txt';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            fileName.textContent = file.name;
            const reader = new FileReader();
            reader.onload = (event) => {
                privateKey.value = event.target.result;
            };
            reader.readAsText(file);
        }
    };
    input.click();
});

// 回车快捷连接
const inputs = [hostname, port, username, password, passphrase, initialCommand];
inputs.forEach(input => {
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            connectBtn.click();
        }
    });
});