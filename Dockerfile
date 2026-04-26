# Zephyr‑SSH Dockerfile
FROM node:18-alpine

# 工作目录
WORKDIR /app

# 复制依赖文件
COPY package.json package-lock.json* ./

# 安装生产依赖
RUN npm install --production

# 复制项目全部文件
COPY . .

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["node", "server.js"]