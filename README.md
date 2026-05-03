# 🌬️ Zephyr-SSH

> Zephyr-SSH 是一个基于 Node.js 的浏览器服务器管理平台，提供 WebSSH 终端、SSH / RDP / VNC 连接管理、SSH 跳板与代理路由、安全登录、多因素认证、远程批量执行、数据备份导入导出等能力。

当前版本：**3.0.0**

---

## 目录

- [功能特性](#功能特性)
- [协议与路由能力](#协议与路由能力)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [RDP / VNC / Guacamole](#rdp--vnc--guacamole)
- [Docker 自行构建](#docker-自行构建)
- [更新容器并保留数据](#更新容器并保留数据)
- [项目结构](#项目结构)
- [安全建议](#安全建议)
- [依赖与数据说明](#依赖与数据说明)
- [致谢](#致谢)

---

## 功能特性

### 连接与终端

- 🖥️ **WebSSH 终端**：基于 `ssh2` + WebSocket，在浏览器中打开 SSH Shell。
- 🌊 **DOM 终端渲染**：基于 `@wterm/dom`，终端文本可像普通网页一样拖选复制。
- 📱 **移动端友好**：支持移动端长按、拖拽选择和系统复制菜单。
- 🗂️ **连接资产管理**：支持 SSH / RDP / VNC 连接管理、搜索、排序、标签和备注。
- 🖥️ **RDP / VNC 远程桌面**：基于 Apache Guacamole / `guacd`，在浏览器内打开远程桌面。
- 🧭 **代理与跳板路由**：支持 SOCKS5 / HTTP CONNECT 代理、SSH 跳板机和多级 SSH 跳板链路。
- ⚡ **远程批量执行**：可对多个 SSH 连接批量执行命令并查看结果。
- 🧰 **远程运维能力**：支持远程状态监控、Docker 容器/镜像查看、日志查看、镜像拉取等 SSH 运维操作。

### 安全与账号

- 🔐 **安全登录体系**：默认管理员、首次登录强制改密、登录会话、密码修改。
- 🧩 **MFA 多因素认证**：支持 TOTP 动态验证码与 Passkey / WebAuthn。
- 🛡️ **登录防护**：支持 CAPTCHA、人机验证、登录失败记录、IP 防爆破封禁、IP 白名单。
- ✉️ **邮件通知**：支持 SMTP 测试邮件、登录成功/失败通知、忘记密码邮箱验证码重置。
- 🧾 **备案信息**：支持 ICP / 公安备案信息配置与登录页展示。

### 数据与部署

- 💾 **SQLite 数据存储**：使用 `better-sqlite3` 持久化用户、连接、设置、安全事件等数据。
- 📦 **数据备份**：支持加密备份导出、备份导入，并在导入前自动生成本地数据库备份。
- 🐳 **Docker 部署**：Docker 镜像内置 Node.js 运行时与 `guacd`，可直接部署使用。

---

## 协议与路由能力

| 协议 | 作为目标连接 | 可通过代理访问 | 可通过 SSH 跳板访问 | 可作为跳板机 |
| --- | --- | --- | --- | --- |
| `SSH` | ✅ | ✅ | ✅ | ✅ |
| `RDP` | ✅ | ✅ | ✅ | ❌ |
| `VNC` | ✅ | ✅ | ✅ | ❌ |

说明：

- **SSH** 既可以作为目标连接，也可以作为跳板机。
- **RDP / VNC** 可以作为目标连接，并且可以通过 SSH 跳板链路访问。
- **RDP / VNC 不能作为跳板机**。跳板机只能选择 SSH 连接。
- RDP / VNC 通过跳板访问时，Zephyr 会在服务端建立临时 TCP 转发，让 `guacd` 连接本地临时端口，再经由 SSH 跳板链路访问目标 RDP/VNC 主机端口。

RDP/VNC 经 SSH 跳板访问链路：

```text
浏览器
  -> Zephyr /guacamole WebSocket
  -> guacd
  -> 127.0.0.1:临时端口
  -> SSH 跳板链路
  -> 目标 RDP/VNC 主机
```

---

## 快速开始

### 方式一：Docker 镜像运行

> 生产部署请务必持久化 `/app/data`，并提前准备 `.env`。

Zephyr 的 SQLite 数据库、运行配置和备份文件都在容器内 `/app/data`。如果没有挂载该目录，删除或重建容器会导致数据丢失。

推荐使用宿主机目录挂载：

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
EOF

docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

访问：

```text
http://your-server-ip:3000
```

默认账号：

```text
用户名：admin
密码：admin
```

首次登录后系统会要求修改默认密码。

### 方式二：本地开发运行

```bash
npm install
npm start
```

浏览器访问：

```text
http://localhost:3000
```

本地开发运行 RDP/VNC 时，需要本机可用的 `guacd`，或配置外部 `guacd`。Docker 镜像部署时已内置 `guacd`，通常无需额外配置。

---

## 配置说明

Zephyr 会读取 `data/.env`，也可以通过 Docker `--env-file` 注入环境变量。

生产环境建议提前准备：

```env
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
```

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | Web 服务监听端口；Docker 内通常保持 `3000` | `3000` |
| `ENCRYPTION_KEY` | 备份导出/导入加密密钥，生产环境必须改为强随机字符串 | `please-change-this-key` |
| `PUBLIC_ORIGIN` | Passkey / WebAuthn 使用的站点来源，应与浏览器访问地址一致 | `http://localhost:3000` |
| `GUACD_HOST` | guacd 地址；Docker 镜像默认使用内置本机 guacd | `127.0.0.1` |
| `GUACD_PORT` | guacd 监听端口 | `4822` |
| `GUACD_EMBEDDED` | 是否由 Zephyr 自动启动内置 guacd | `true` |
| `GUACD_BIN` | guacd 可执行文件路径 | `guacd` |
| `GUACD_LOG_LEVEL` | guacd 日志级别 | `info` |

注意：

- 使用 Passkey / WebAuthn 时，生产环境建议启用 HTTPS。
- `PUBLIC_ORIGIN` 必须与实际访问地址一致，例如 `https://ssh.example.com`。
- `ENCRYPTION_KEY` 用于加密备份文件。旧备份需要使用导出时的旧密钥才能解密导入。
- 程序首次启动如果发现 `data/.env` 不存在，会生成默认占位文件；生产环境不要长期使用默认密钥。

---

## RDP / VNC / Guacamole

RDP 和 VNC 连接基于 Apache Guacamole 的 `guacd` 网关实现。浏览器端通过 Zephyr 的 `/guacamole` WebSocket 隧道接入，无需直接把目标 RDP/VNC 端口暴露到公网。

### Docker 镜像内置 guacd

项目 Docker 镜像运行层基于官方 `guacamole/guacd:1.5.5`，已包含：

- `guacd`
- RDP 客户端插件
- VNC 客户端插件
- 相关运行依赖

Zephyr 启动时会自动检测并启动本机 `guacd`，Docker 部署通常不需要额外启动 `guacamole/guacd` 容器。

### 默认端口

| 协议 | 默认端口 | 说明 |
| --- | --- | --- |
| `SSH` | `22` | WebSSH 终端，不经过 guacd |
| `RDP` | `3389` | Windows 远程桌面，经 guacd RDP 插件 |
| `VNC` | `5900` | VNC Server，经 guacd VNC 插件 |

### RDP/VNC 使用跳板

RDP/VNC 本身不是 SSH 协议，也不能作为 SSH 跳板机；但 Zephyr 支持通过 SSH 跳板链路访问 RDP/VNC 目标端口。

配置方式：

1. 先创建一个 SSH 连接，作为跳板机。
2. 在“网络 / 跳板机”中创建跳板机配置，并选择该 SSH 连接。
3. 创建或编辑 RDP/VNC 连接。
4. 在高级路由中选择“跳板机”，选择刚才创建的 SSH 跳板机。
5. 保存并测试连接。

限制说明：

- 跳板机候选项只会显示 SSH 连接。
- RDP/VNC 不能被选为跳板机。
- RDP/VNC 可以作为最终目标，通过 SSH 跳板访问。
- 多级跳板中的每一级都必须是 SSH 连接。

### 外部 guacd

本地开发或特殊部署时，也可以使用外部 guacd：

```bash
docker run -d \
  --name zephyr-guacd \
  -p 4822:4822 \
  --restart unless-stopped \
  guacamole/guacd:1.5.5
```

然后在 Zephyr `.env` 中配置：

```env
GUACD_EMBEDDED=false
GUACD_HOST=127.0.0.1
GUACD_PORT=4822
```

### 常见排查

RDP：

- Windows 是否已开启“远程桌面”。
- Windows 防火墙或云安全组是否允许访问 `3389`。
- 账号是否允许远程桌面登录。
- 如果使用自签名证书，Zephyr 默认设置 `ignore-cert=true`。

VNC：

- 目标主机是否已启动 VNC Server。
- VNC 端口是否为 `5900` 或配置中的自定义端口。
- VNC 密码是否正确。
- 防火墙或安全组是否允许访问对应端口。

服务端日志关键字：

```text
[guacd]
[guacamole]
[guacamole-ws]
[guacamole-test]
[tcp-forward]
[route-plan]
```

---

## Docker 自行构建

```bash
mkdir -p ./zephyr-data

cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
EOF

docker build -t zephyr-ssh:local .

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  zephyr-ssh:local
```

Dockerfile 说明：

- 构建阶段使用 `node:20-alpine`。
- 运行阶段基于 `guacamole/guacd:1.5.5`。
- 镜像内复制 Node.js 运行时和生产依赖。
- 镜像内置 guacd、RDP/VNC 插件和运行依赖。
- 构建时会验证 `guacd`、`node`、`npm` 是否可执行。

---

## 更新容器并保留数据

更新时必须复用原来的数据目录或命名卷。

宿主机目录挂载方式：

```bash
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker rm -f zephyr-ssh

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

命名卷方式：

```bash
docker rm -f zephyr-ssh

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v zephyr-ssh-data:/app/data \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

检查持久化是否正确：

```bash
docker inspect zephyr-ssh --format '{{json .Mounts}}'
ls -la ./zephyr-data
docker volume inspect zephyr-ssh-data
```

---

## 项目结构

```text
zephyr-ssh/
├── public/
│   ├── index.html       # 登录页
│   ├── client.js        # 登录页逻辑
│   ├── app.html         # 管理后台页面
│   ├── app.js           # 管理后台逻辑
│   ├── terminal.html    # SSH 终端页面
│   ├── terminal.js      # SSH 终端逻辑
│   ├── guacamole.html   # RDP/VNC 远程桌面页面
│   ├── guacamole.js     # Guacamole 前端逻辑
│   └── style.css        # 全局样式
├── data/                # 运行数据目录
│   ├── .env             # 环境变量配置
│   └── zephyr.db        # SQLite 数据库
├── server.js            # 后端服务、API、WebSocket、协议路由
├── storage.js           # SQLite 存储层
├── stats.js             # 远程状态采集
├── package.json         # 项目依赖与脚本
├── package-lock.json    # 锁定依赖版本
├── Dockerfile           # Docker 构建文件
└── README.md            # 项目说明
```

---

## 安全建议

1. 首次登录后立即修改默认管理员密码。
2. 生产环境必须修改 `ENCRYPTION_KEY`。
3. 启用 Passkey / TOTP 前，确认服务器系统时间准确。
4. Passkey / WebAuthn 推荐在 HTTPS 环境下使用。
5. 开启 IP 白名单前，确认当前访问 IP 已包含在白名单内，避免误锁。
6. 不要提交 `data/.env`、数据库文件、备份文件和真实连接凭据。
7. 不要把 Zephyr 直接暴露在不可信网络中，建议放在 HTTPS 反向代理之后。
8. 定期导出加密备份，并妥善保存备份密钥。
9. 删除或重建 Docker 容器前，确认 `/app/data` 已正确持久化。

---

## 依赖与数据说明

### 可以删除的文件

- `node_modules/`：本地依赖目录，可以删除；重新执行 `npm install` 即可恢复。

### 不建议删除的文件

- `package-lock.json`：锁定依赖版本，保证本地、CI、Docker 构建环境一致，建议提交到 Git。

### 推荐 Git 忽略项

```gitignore
node_modules/
data/.env
data/*.db
data/*.db-shm
data/*.db-wal
data/*.enc
```

---

## 备注

阿里云验证码后端校验需要 AccessKey。当前实现支持两种方式：

1. 在后台 Secret Key 中填写：

```text
AccessKeyId:AccessKeySecret
```

2. 通过环境变量提供 `ALIYUN_ACCESS_KEY_ID`，后台 Secret Key 填写 `AccessKeySecret`。

如果仅需要最简单的webssh，使用v1.0.75即可
```bash
docker run -d \
  --name zephyr-ssh \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:v1.0.75
```

---

## 致谢

- [wterm](https://github.com/vercel-labs/wterm)
- [ssh2](https://github.com/mscdex/ssh2)
- [SimpleWebAuthn](https://simplewebauthn.dev/)
- [Apache Guacamole](https://guacamole.apache.org/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
