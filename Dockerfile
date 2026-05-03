FROM node:20-alpine AS app-build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 复制 @wterm/dom 的 dist 目录（包含所有核心逻辑和内联 WASM）
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist && \
    cp node_modules/@wterm/dom/src/terminal.css public/vendor/@wterm/dom/terminal.css

RUN mkdir -p public/vendor/@wterm/core && \
    cp -r node_modules/@wterm/core/dist public/vendor/@wterm/core/dist

COPY . .

FROM guacamole/guacd:1.5.5

USER root
WORKDIR /app

# 复用官方 guacd 镜像提供的 guacd、RDP/VNC 插件和运行依赖；
# guacamole/guacd:1.5.5 基于 Alpine，guacd 位于 /opt/guacamole/sbin。
# 从 Alpine 版 Node 官方镜像复制 Node.js 运行时，避免 glibc/musl 不兼容。
ENV PATH="/opt/guacamole/sbin:${PATH}"
COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    echo "PATH=${PATH}" && \
    echo "guacd=$(command -v guacd)" && \
    guacd -v && \
    node --version && \
    npm --version

COPY --from=app-build /app /app

ENV GUACD_EMBEDDED=true
ENV GUACD_HOST=127.0.0.1
ENV GUACD_PORT=4822
ENV GUACD_BIN=guacd

EXPOSE 3000

CMD ["node", "server.js"]