// terminal.js — WTerm + WebSocketTransport + SSH bridge

import { WTerm, WebSocketTransport } from "/node_modules/@wterm/dom/dist/index.js";
import "/node_modules/@wterm/dom/css.css";

// 读取登录页传来的参数
const opts = JSON.parse(sessionStorage.getItem("zephyr-ssh-opts") || "{}");

if (!opts.host || !opts.username) {
  alert("缺少连接参数，请重新登录");
  window.location.href = "/";
}

// WebSocket 地址
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ssh`;

// 初始化终端
const termEl = document.getElementById("terminal");
const term = new WTerm(termEl, {
  autoResize: true,
  cursorBlink: true,
  onData(data) {
    // 用户输入 → WebSocket
    transport.send(JSON.stringify({ type: "input", data }));
  }
});

// 初始化 WTerm（必须 await）
await term.init();

// 创建 WebSocketTransport
const transport = new WebSocketTransport({
  url: WS_URL,
  reconnect: true,

  onOpen() {
    // 建立 SSH 连接
    transport.send(
      JSON.stringify({
        type: "connect",
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase,
        init: opts.init
      })
    );
  },

  onMessage(msg) {
    try {
      const data = JSON.parse(msg);

      if (data.type === "ready") {
        term.write("\r\n*** SSH Connected ***\r\n");
      }

      if (data.type === "data") {
        term.write(data.data);
      }

      if (data.type === "error") {
        term.write(`\r\n[ERROR] ${data.message}\r\n`);
      }
    } catch (e) {
      term.write(`\r\n[PARSE ERROR] ${e.message}\r\n`);
    }
  },

  onClose() {
    term.write("\r\n*** Connection closed ***\r\n");
  }
});

// 开始连接
transport.connect();