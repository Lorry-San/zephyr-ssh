import { WTerm, WebSocketTransport } from '/vendor/@wterm/dom/dist/index.js';
// 注意：不再 import CSS，样式已由 terminal.html 的 <link> 提供

(async () => {
  try {
    const opts = JSON.parse(sessionStorage.getItem('zephyr-ssh-opts') || '{}');
    if (!opts.host || !opts.username) {
      alert('缺少连接参数，请返回登录页');
      window.location.href = '/';
      return;
    }

    const termEl = document.getElementById('terminal');
    if (!termEl) throw new Error('终端容器 #terminal 未找到');

    const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ssh`;

    const term = new WTerm(termEl, {
      autoResize: true,
      cursorBlink: true,
    });

    await term.init();

    const transport = new WebSocketTransport({
      url: WS_URL,
      reconnect: true,
      onOpen() {
        transport.send(JSON.stringify({
          type: 'connect',
          host: opts.host,
          port: opts.port,
          username: opts.username,
          password: opts.password,
          privateKey: opts.privateKey,
          passphrase: opts.passphrase,
          init: opts.init,
        }));
      },
      onMessage(msg) {
        try {
          const data = JSON.parse(msg);
          if (data.type === 'ready') {
            term.write('\r\n*** SSH Connected ***\r\n');
          } else if (data.type === 'data') {
            term.write(data.data);
          } else if (data.type === 'error') {
            term.write(`\r\n[ERROR] ${data.message}\r\n`);
          }
        } catch (_) {
          term.write(msg);
        }
      },
      onClose() {
        term.write('\r\n*** Connection closed ***\r\n');
      },
    });

    transport.connect();

    // 可选：将终端输入桥接到 WebSocket
    term.onData((data) => {
      try { transport.send(JSON.stringify({ type: 'input', data })); } catch (_) {}
    });

  } catch (err) {
    console.error('终端初始化失败:', err);
    alert('终端初始化失败，请刷新重试');
  }
})();