const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

// 静态文件服务
app.use(express.static('public'));
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'zephyr-ssh' });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let sshClient = null;
  let sshStream = null;

  socket.on('ssh-connect', (config) => {
    const { host, port, username, password, privateKey, passphrase, initialCommand } = config;

    if (!host || !username) {
      socket.emit('ssh-error', '主机地址和用户名不能为空');
      return;
    }

    if ((!password || password.trim() === '') && (!privateKey || privateKey.trim() === '')) {
      socket.emit('ssh-error', '需要密码或私钥');
      return;
    }

    sshClient = new Client();

    const connectConfig = {
      host: host.trim(),
      port: parseInt(port) || 22,
      username: username.trim(),
      readyTimeout: 30000,
    };

    if (privateKey && privateKey.trim() !== '') {
      connectConfig.privateKey = privateKey;
      if (passphrase && passphrase.trim()) {
        connectConfig.passphrase = passphrase;
      }
    } else if (password && password.trim() !== '') {
      connectConfig.password = password;
    }

    sshClient.on('ready', () => {
      console.log('SSH ready:', socket.id);
      socket.emit('ssh-ready', '连接成功');

      sshClient.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          socket.emit('ssh-error', `Shell 错误: ${err.message}`);
          return;
        }

        sshStream = stream;

        if (initialCommand && initialCommand.trim()) {
          setTimeout(() => {
            stream.write(`${initialCommand.trim()}\n`);
          }, 500);
        }

        stream.on('data', (data) => {
          socket.emit('ssh-data', data.toString('binary'));
        });

        stream.on('close', () => {
          socket.emit('ssh-closed', '连接已关闭');
          sshClient.end();
        });

        socket.on('ssh-input', (data) => {
          if (stream && !stream.destroyed) {
            stream.write(data);
          }
        });

        socket.on('ssh-resize', ({ cols, rows }) => {
          if (stream && !stream.destroyed) {
            stream.setWindow(rows, cols);
          }
        });
      });
    });

    sshClient.on('error', (err) => {
      console.error('SSH error:', err.message);
      socket.emit('ssh-error', `SSH 连接失败: ${err.message}`);
    });

    sshClient.on('close', () => {
      console.log('SSH closed:', socket.id);
      if (sshStream && !sshStream.destroyed) {
        sshStream.end();
      }
    });

    sshClient.connect(connectConfig);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (sshStream && !sshStream.destroyed) {
      sshStream.end();
    }
    if (sshClient) {
      sshClient.end();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✨ Zephyr-SSH 运行在 http://localhost:${PORT}`);
});