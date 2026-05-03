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
- 🗂️ **连接管理**：支持 SSH / VNC 连接打开与 SSH / RDP / VNC 连接卡片管理；VNC 基于 Apache Guacamole/guacd，RDP 将在后续接入。
- 🏷️ **标签与备注**：支持连接标签、搜索、排序、Markdown 备注展示。
- 🧭 **代理与跳板机**：支持代理池、跳板机配置以及连接路由方式选择。
- ⚡ **远程批量执行**：可对多个 SSH 连接批量执行命令并查看结果。
- 💾 **SQLite 数据存储**：使用 `better-sqlite3` 持久化用户、连接、设置、安全事件等数据。
- 📦 **数据治理**：支持加密备份导出、备份导入，并在导入前生成本地数据库备份。
- 🧾 **备案信息**：支持 ICP / 公安备案信息配置与登录页展示。
- 🐳 **Docker 部署**：提供 Dockerfile，可构建镜像部署。

## 🚀 快速开始

### 方式一：Docker 镜像运行

> **重要：生产部署请先写 `.env`，并持久化 `/app/data`。**
> Zephyr 的 SQLite 数据库、运行配置和备份文件都在容器内 `/app/data`。如果启动容器时没有挂载这个目录，删除/重建容器后数据会丢失。

推荐使用宿主机目录挂载，`.env` 写在宿主机上，然后通过 `--env-file` 显式引用：

```bash
# 1. 创建部署目录和持久化数据目录
mkdir -p ./zephyr-data

# 2. 先写生产环境配置
cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
EOF

# 3. 拉取并运行镜像
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

如果只是本机测试，也可以使用 Docker 命名卷，但仍建议先准备 `.env`：

```bash
mkdir -p ./zephyr-data
cat > ./zephyr-data/.env <<'EOF'
ENCRYPTION_KEY=please-change-this-key
PUBLIC_ORIGIN=http://localhost:3000
PORT=3000
EOF

docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v zephyr-ssh-data:/app/data \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

> 使用命名卷时，`./zephyr-data/.env` 只负责给 Docker 注入环境变量；容器首次启动还会在命名卷内生成 `/app/data/.env`。生产环境更推荐上面的宿主机目录挂载方式，方便直接备份和检查 `zephyr.db`、`.env`。

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

生产环境请手动准备 `.env`，不要依赖默认占位值：

```env
ENCRYPTION_KEY=请替换为足够长的随机密钥
PUBLIC_ORIGIN=https://ssh.example.com
PORT=3000
```

Docker 部署时推荐同时做到两点：

1. 用 `--env-file ./zephyr-data/.env` 让 Docker 启动时显式读取配置。
2. 用 `-v "$(pwd)/zephyr-data:/app/data"` 将同一个目录挂载到容器 `/app/data`，让 `.env`、`zephyr.db`、WAL 文件和备份文件都持久化。

程序启动时也会读取 `data/.env`；如果文件不存在，会自动生成默认占位文件，方便本地测试。但生产环境必须在首次启动前或首次启动后立即修改，并重启容器使配置生效。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | Web 服务监听端口；Docker 中通常保持 `3000`，通过 `-p 宿主机端口:3000` 对外暴露 | `3000` |
| `ENCRYPTION_KEY` | 数据导出/导入备份加密密钥；生产环境务必改成强随机字符串，并妥善保存 | `please-change-this-key` |
| `PUBLIC_ORIGIN` | Passkey / WebAuthn 使用的站点来源，需要和浏览器访问地址一致 | `http://localhost:3000` |
| `GUACD_HOST` | 内置/外部 guacd 地址；Docker 镜像默认内置 guacd，通常无需修改 | `127.0.0.1` |
| `GUACD_PORT` | guacd 监听端口；内置 guacd 会自动使用该端口启动 | `4822` |
| `GUACD_EMBEDDED` | 是否由 Zephyr 自动启动内置 guacd；如需改用外部 guacd 可设为 `false` 并配置 `GUACD_HOST` | `true` |
| `GUACD_BIN` | guacd 可执行文件路径；Docker 镜像已内置 | `guacd` |

> 使用 Passkey / WebAuthn 时，生产环境建议配置 HTTPS，并将 `PUBLIC_ORIGIN` 设置为真实访问地址，例如 `https://ssh.example.com`。
>
> 如果更换了 `ENCRYPTION_KEY`，旧备份文件需要使用导出时的旧密钥才能解密导入。

### VNC / 内置 Guacamole 配置

VNC 连接基于 Apache Guacamole 的 `guacd` 网关实现。项目 Docker 镜像已内置 `guacd`、VNC/RDP 客户端插件，并由 `server.js` 在启动时自动拉起本机 `guacd`，因此 Docker 部署无需再单独启动 `guacamole/guacd` 容器。

本地开发运行 `npm start` 时，如果系统中已安装 `guacd`，Zephyr 会自动复用或启动本机 `guacd`。如果你的本地系统没有 `guacd`，可以安装系统包，或临时使用外部 guacd 并设置：

```env
GUACD_EMBEDDED=false
GUACD_HOST=外部-guacd-地址
GUACD_PORT=4822
```

VNC 连接由 guacd 访问目标主机，因此目标 VNC 主机和端口必须对 Zephyr 容器/内置 guacd 可达。

## 关于依赖文件

- `node_modules/`：**可以删除**。这是本地安装目录，不建议提交到 Git。删除后执行 `npm install` 即可重新生成。
- `package-lock.json`：**不建议删除**。它锁定依赖版本，能保证本地、CI、Docker 构建环境安装出一致依赖；建议提交到 Git。

如果只是想清理仓库，应删除/忽略 `node_modules/`，保留 `package-lock.json`。

## 自行构建 Docker 镜像

构建镜像前建议确认本地运行数据不会被打进镜像。项目已提供 `.dockerignore`，默认排除 `data/`、`node_modules/` 等本地文件；镜像首次启动时会自动创建默认管理员：`admin / admin`。

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

## 更新 Docker 容器时保留数据

更新镜像或重建容器时，必须复用原来的 `./zephyr-data:/app/data` 挂载目录，不能换目录，也不要删除该目录。

```bash
# 拉取新镜像
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

# 删除旧容器；这里只删除容器，不删除 ./zephyr-data
docker rm -f zephyr-ssh

# 使用同一个 .env 和同一个数据目录重新启动
docker run -d \
  --name zephyr-ssh \
  --env-file ./zephyr-data/.env \
  -p 3000:3000 \
  -v "$(pwd)/zephyr-data:/app/data" \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

如果之前使用的是命名卷，更新时必须继续挂载同一个卷名：

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

排查数据是否已经正确持久化：

```bash
# 查看容器是否挂载了 /app/data
docker inspect zephyr-ssh --format '{{json .Mounts}}'

# 宿主机目录挂载时，确认数据库和 .env 在宿主机目录中
ls -la ./zephyr-data

# 命名卷挂载时，查看卷信息
docker volume inspect zephyr-ssh-data
```

## 项目结构

```text
zephyr-ssh/
├── public/
│   ├── index.html       # 登录页
│   ├── client.js        # 登录页逻辑
│   ├── app.html         # 管理后台页面
│   ├── app.js           # 管理后台逻辑
│   ├── terminal.html    # SSH 终端页面
│   ├── terminal.js      # SSH 终端核心逻辑
│   ├── guacamole.html   # VNC 远程桌面页面
│   ├── guacamole.js     # VNC / Guacamole 前端逻辑
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

注意：阿里云验证码后端校验需要 AccessKey。当前实现支持在后台 Secret Key 中填写 `AccessKeyId:AccessKeySecret`，或通过环境变量 `ALIYUN_ACCESS_KEY_ID` 提供 AccessKeyId、后台 Secret Key 填 AccessKeySecret

## 🙏 致谢

- 🖥️ [wterm](https://github.com/vercel-labs/wterm)
- 🔐 [ssh2](https://github.com/mscdex/ssh2)
- 🔑 [SimpleWebAuthn](https://simplewebauthn.dev/)
- 🗄️ [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
