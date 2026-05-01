# 🌬️ Zephyr-SSH

> Zephyr 是一个基于 Node.js 的 WebSSH 终端管理系统，提供浏览器 SSH 终端、连接资产管理、远程批量执行、安全登录、Passkey / TOTP、多因素认证、数据备份导入导出等能力。

当前项目版本：**3.0.0**

## ✨ 功能特性

- 🖥️ **WebSSH 终端**：基于 `ssh2` + WebSocket，支持浏览器内打开 SSH 会话。
- 🌊 **顺滑文本选择**：基于 `@wterm/dom` DOM 渲染，终端文本可像普通网页一样拖选复制。
- 📱 **移动端友好**：支持移动端长按、拖拽选择与系统复制菜单。
- 🔐 **安全登录体系**：默认管理员、首次登录强制改密、登录会话、密码修改。
- 🧩 **MFA 多因素认证**：支持 TOTP 动态验证码与 Passkey / WebAuthn。
- 🛡️ **登录防护**：支持 CAPTCHA、人机验证、登录失败记录、IP 防爆破封禁、IP 白名单。
- **邮件通知**：支持 SMTP 测试邮件、登录成功/失败通知、忘记密码邮箱验证码重置。
- 🗂️ **连接管理**：支持 SSH / RDP / VNC 连接卡片，其中 RDP/VNC 当前为占位管理能力。
- 🏷️ **标签与备注**：支持连接标签、搜索、排序、Markdown 备注展示。
- 🧭 **代理与跳板机**：支持代理池、跳板机配置以及连接路由方式选择。
- ⚡ **远程批量执行**：可对多个 SSH 连接批量执行命令并查看结果。
- 💾 **SQLite 数据存储**：使用 `better-sqlite3` 持久化用户、连接、设置、安全事件等数据。
- 📦 **数据治理**：支持加密备份导出、备份导入，并在导入前生成本地数据库备份。
- 🧾 **备案信息**：支持 ICP / 公安备案信息配置与登录页展示。
- 🐳 **Docker 部署**：提供 Dockerfile，可构建镜像部署。

## 🚀 快速开始

### 方式一：Docker 镜像运行

```bash
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker run -d \
  --name zephyr-ssh \
  -p 3000:3000 \
  -v zephyr-ssh-data:/app/data \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

访问：`http://your-server-ip:3000`

默认账号：

```text
用户名：admin
密码：admin
```

首次登录后系统会要求修改默认密码。

### 方式二：本地开发运行

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

浏览器访问：`http://localhost:3000`

## ⚙️ 配置说明

项目启动时会自动创建 `data/.env`，用于保存运行环境配置：

```env
ENCRYPTION_KEY=please-change-this-key
PUBLIC_ORIGIN=http://localhost:3000
PORT=3000
```

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | Web 服务监听端口 | `3000` |
| `ENCRYPTION_KEY` | 数据导出加密密钥；生产环境务必修改 | `please-change-this-key` |
| `PUBLIC_ORIGIN` | Passkey / WebAuthn 使用的站点来源 | `http://localhost:3000` |

> 使用 Passkey / WebAuthn 时，生产环境建议配置 HTTPS，并将 `PUBLIC_ORIGIN` 设置为真实访问地址，例如 `https://ssh.example.com`。

## 关于依赖文件

- `node_modules/`：**可以删除**。这是本地安装目录，不建议提交到 Git。删除后执行 `npm install` 即可重新生成。
- `package-lock.json`：**不建议删除**。它锁定依赖版本，能保证本地、CI、Docker 构建环境安装出一致依赖；建议提交到 Git。

如果只是想清理仓库，应删除/忽略 `node_modules/`，保留 `package-lock.json`。

## 自行构建 Docker 镜像

构建镜像前建议确认本地运行数据不会被打进镜像。项目已提供 `.dockerignore`，默认排除 `data/`、`node_modules/` 等本地文件；镜像首次启动时会自动创建默认管理员：`admin / admin`。

```bash
docker build -t zephyr-ssh:local .

docker run -d \
  --name zephyr-ssh \
  -p 3000:3000 \
  -v zephyr-ssh-data:/app/data \
  --restart unless-stopped \
  zephyr-ssh:local
```

## 项目结构

```text
zephyr-ssh/
├── public/
│   ├── index.html       # 登录页
│   ├── client.js        # 登录页逻辑
│   ├── app.html         # 管理后台页面
│   ├── app.js           # 管理后台逻辑
│   ├── terminal.html    # 终端页面
│   ├── terminal.js      # 终端核心逻辑
│   └── style.css        # 全局样式
├── data/                # 运行数据目录（数据库、配置、历史数据）
│   ├── .env             # 环境变量配置
│   └── zephyr.db        # SQLite 数据库
├── server.js            # 后端服务与 API
├── storage.js           # SQLite 存储层
├── stats.js             # 远程状态采集
├── package.json         # 项目依赖与脚本
├── package-lock.json    # 锁定依赖版本，建议保留并提交
├── Dockerfile           # Docker 构建文件
└── README.md            # 项目说明
```

## 安全建议

1. 首次登录后立即修改默认管理员密码。
2. 生产环境必须修改 `data/.env` 中的 `ENCRYPTION_KEY`。
3. 启用 Passkey / TOTP 前，确认系统时间准确。
4. Passkey / WebAuthn 推荐在 HTTPS 环境下使用。
5. 开启 IP 白名单前，请确认当前访问 IP 已包含在白名单内，避免误锁。
6. 不要提交 `data/.env`、`data/*.db`、备份文件和真实连接凭据。

## 🧹 推荐 Git 忽略项

建议忽略本地依赖和运行数据：

```gitignore
node_modules/
data/.env
data/*.db
data/*.db-shm
data/*.db-wal
data/*.enc
```

## 🙏 致谢

- 🖥️ [wterm](https://github.com/vercel-labs/wterm)
- 🔐 [ssh2](https://github.com/mscdex/ssh2)
- 🔑 [SimpleWebAuthn](https://simplewebauthn.dev/)
- 🗄️ [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
