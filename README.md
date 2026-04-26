# zephyr-ssh
A webssh tool
Project Structure
```
zephyr-ssh/
│
├── .github/
│   └── workflows/
│       └── docker-build.yml          # GitHub Action 自动构建镜像
│
├── public/
│   ├── index.html                    # 登录界面（主机/端口/用户名/密码/私钥）
│   ├── terminal.html                 # 终端界面（wterm 渲染）
│   ├── style.css                     # 登录界面样式
│   ├── client.js                     # 登录界面交互（收集配置、跳转）
│   └── terminal.js                   # 终端核心（wterm + socket.io）
│
├── server.js                         # Express 后端 + Socket.IO + SSH2
├── package.json                      # 依赖声明
├── Dockerfile                        # 多阶段构建
├── .gitignore                        # 忽略 node_modules 等
└── README.md                         # 项目说明
```