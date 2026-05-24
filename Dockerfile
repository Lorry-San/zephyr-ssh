FROM node:20-alpine AS app-build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# better-sqlite3 是原生模块，最终运行镜像必须使用与构建阶段兼容的 C++ 运行库。
# guacamole/guacd:1.5.5 的 Alpine/libstdc++ 可能偏旧，直接运行会触发 better_sqlite3.node 符号缺失。
RUN mkdir -p /tmp/native-runtime-libs && \
    cp -L /usr/lib/libstdc++.so.6 /tmp/native-runtime-libs/libstdc++.so.6 && \
    cp -L /usr/lib/libgcc_s.so.1 /tmp/native-runtime-libs/libgcc_s.so.1 && \
    echo "=== app-build diagnostics ===" && \
    cat /etc/alpine-release && \
    node --version && \
    npm --version && \
    test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node && \
    if command -v strings >/dev/null 2>&1; then strings /tmp/native-runtime-libs/libstdc++.so.6 | grep -E 'GLIBCXX_|CXXABI_' | sort -V | tail -20; else echo "strings command not available; skip libstdc++ symbol dump"; fi && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 native module loaded in app-build')"

# 复制 @wterm/dom 的 dist 目录（包含所有核心逻辑和内联 WASM）
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist && \
    cp node_modules/@wterm/dom/src/terminal.css public/vendor/@wterm/dom/terminal.css

RUN mkdir -p public/vendor/@wterm/core && \
    cp -r node_modules/@wterm/core/dist public/vendor/@wterm/core/dist

COPY . .

FROM guacamole/guacd:1.5.5 AS guacd-build

USER root
WORKDIR /tmp/guacamole-server

RUN apk add --no-cache \
        autoconf automake build-base cairo-dev cmake cunit-dev git grep \
        libjpeg-turbo-dev libpng-dev libtool libwebp-dev openssl-dev pango-dev \
        pulseaudio-dev util-linux-dev wget freerdp-dev libssh2-dev libvncserver-dev
RUN git clone --depth 1 --branch 1.5.5 https://github.com/apache/guacamole-server.git .
COPY patches/guacamole-server-1.5.5 /tmp/zephyr-guacd-patches
RUN /bin/sh /tmp/zephyr-guacd-patches/apply.sh && \
    autoreconf -fi && \
    ./configure --prefix=/opt/guacamole --with-init-dir=/tmp --disable-dependency-tracking && \
    make -j$(nproc) && \
    make install

FROM guacamole/guacd:1.5.5

USER root
WORKDIR /app

# 复用官方 guacd 镜像提供的 guacd、RDP/VNC 插件和运行依赖；
# guacamole/guacd:1.5.5 基于 Alpine，guacd 位于 /opt/guacamole/sbin。
# 从 Alpine 版 Node 官方镜像复制 Node.js 运行时，避免 glibc/musl 不兼容。
# 同步复制构建阶段的 C++ 运行库，避免 guacd 镜像内旧 libstdc++ 导致 better-sqlite3 符号缺失。
ENV PATH="/opt/guacamole/sbin:${PATH}"
COPY --from=guacd-build /opt/guacamole /opt/guacamole
COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=app-build /tmp/native-runtime-libs/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=app-build /tmp/native-runtime-libs/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=app-build /app /app
RUN apk add --no-cache imagemagick && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    echo "PATH=${PATH}" && \
    echo "guacd=$(command -v guacd)" && \
    guacd -v && \
    node --version && \
    npm --version && \
    test -f /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node && \
    if command -v strings >/dev/null 2>&1; then strings /usr/lib/libstdc++.so.6 | grep -E 'GLIBCXX_|CXXABI_' | sort -V | tail -20; else echo "strings command not available; skip libstdc++ symbol dump"; fi && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 native module loaded in runtime image')"

ENV GUACD_EMBEDDED=true
ENV GUACD_HOST=127.0.0.1
ENV GUACD_PORT=4822
ENV GUACD_BIN=guacd

EXPOSE 3000

CMD ["node", "server.js"]