// terminal.js — WTerm + WebSocketTransport + SSH bridge
// Import from vendor path that will be copied into public/vendor/@wterm/dom
import { WTerm, WebSocketTransport } from '/vendor/@wterm/dom/dist/index.js';
import '/vendor/@wterm/dom/css.css';

const opts = JSON.parse(sessionStorage.getItem('zephyr-ssh-opts') || '{}');
if (!opts.host || !opts.username) {
  alert('缺少连接参数，请重新登录');
  window.location.href = '/';
}

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ssh`;

const termEl = document.getElementById('terminal');
const term = new WTerm(termEl, {
  autoResize: true,
  cursorBlink: true,
  onData(data) {
    try {
      transport.send(JSON.stringify({ type: 'input', data }));
    } catch (e) {
      // ignore if transport not ready
    }
  }
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
      init: opts.init
    }));
  },
  onMessage(msg) {
    // msg is string
    try {
      const data = JSON.parse(msg);
      if (data.type === 'ready') {
        term.write('\r\n*** SSH Connected ***\r\n');
      } else if (data.type === 'data') {
        term.write(data.data);
      } else if (data.type === 'error') {
        term.write(`\r\n[ERROR] ${data.message}\r\n`);
      }
    } catch (e) {
      // If not JSON, write raw
      term.write(msg);
    }
  },
  onClose() {
    term.write('\r\n*** Connection closed ***\r\n');
  }
});

transport.connect();