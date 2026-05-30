# ============================================================
# Stage 1: app-build — Node.js 应用依赖
# ============================================================
FROM node:20-alpine AS app-build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# better-sqlite3 是原生模块，最终运行镜像需要与构建阶段兼容的 libstdc++。
# 复制构建阶段的 C++ 运行库备用
RUN mkdir -p /tmp/native-runtime-libs && \
    cp -L /usr/lib/libstdc++.so.6 /tmp/native-runtime-libs/libstdc++.so.6 && \
    cp -L /usr/lib/libgcc_s.so.1 /tmp/native-runtime-libs/libgcc_s.so.1

# 复制 @wterm 前端依赖
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist && \
    cp node_modules/@wterm/dom/src/terminal.css public/vendor/@wterm/dom/terminal.css && \
    mkdir -p public/vendor/@wterm/core && \
    cp -r node_modules/@wterm/core/dist public/vendor/@wterm/core/dist

COPY . .

# 构建编辑器 bundle
RUN npm run build:editor 2>&1 || echo "[WARN] editor build skipped"

# ============================================================
# Stage 2: guacd-build — 编译补丁版 guacd
# ============================================================
FROM guacamole/guacd:1.5.5 AS guacd-build

USER root
WORKDIR /tmp/guacamole-server

# 安装构建依赖
RUN apk add --no-cache \
        autoconf automake build-base cairo-dev cmake cunit-dev git grep \
        libjpeg-turbo-dev libpng-dev libtool libwebp-dev openssl-dev pango-dev \
        pulseaudio-dev util-linux-dev wget freerdp-dev libssh2-dev libvncserver-dev \
        alsa-lib-dev cups-dev ffmpeg-dev openh264-dev pcsc-lite-dev

# 编译魔改 FreeRDP：在 RDPGFX AVC420/AVC444 SurfaceCommand 解码前导出原始 H.264 bitstream。
WORKDIR /tmp/FreeRDP
RUN git clone --depth 1 --branch 2.11.7 https://github.com/FreeRDP/FreeRDP.git . && \
    mkdir -p /tmp/zephyr-freerdp-patches
COPY patches/freerdp-2.11.7 /tmp/zephyr-freerdp-patches
RUN /bin/sh /tmp/zephyr-freerdp-patches/apply.sh && \
    cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/freerdp-zephyr \
      -DWITH_SERVER=OFF \
      -DWITH_CLIENT=ON \
      -DWITH_X11=ON \
      -DWITH_WAYLAND=OFF \
      -DWITH_OPENH264=ON \
      -DWITH_FFMPEG=ON \
      -DWITH_PULSE=OFF \
      -DWITH_CUPS=OFF \
      -DWITH_PCSC=OFF && \
    cmake --build build -j$(nproc) && \
    cmake --install build

WORKDIR /tmp/guacamole-server
RUN git clone --depth 1 --branch 1.5.5 https://github.com/apache/guacamole-server.git . && \
    mkdir -p /tmp/zephyr-guacd-patches

COPY patches/guacamole-server-1.5.5 /tmp/zephyr-guacd-patches
RUN /bin/sh /tmp/zephyr-guacd-patches/apply.sh && \
    autoreconf -fi && \
    ./configure --prefix=/opt/guacamole --with-init-dir=/tmp --disable-dependency-tracking && \
    make -j$(nproc) && \
    make install

# 记录编译期 FreeRDP 版本，用于运行时对齐
RUN echo "BUILD_FREERDP_VERSION=$(apk list --installed 2>/dev/null | grep 'freerdp-dev' | head -1)" > /tmp/build-freerdp-version.txt

# ============================================================
# Stage 3: runtime — 精简运行镜像
# ============================================================
FROM guacamole/guacd:1.5.5

USER root
WORKDIR /app

# 1) 升级 FreeRDP 运行库到与编译阶段一致（避免插件加载失败）
#     guacd-build 编译时安装了最新 freerdp-dev，运行层必须同版本 freerdp-libs
# 2) 安装运行时额外工具
# 3) 用构建阶段的 C++ 运行库覆盖（保证 better-sqlite3 兼容性）
# 4) 从构建阶段复制补丁版 guacd 及插件
RUN apk update && \
    apk upgrade freerdp-libs && \
    apk add --no-cache \
        imagemagick \
        ffmpeg \
        freerdp \
        xvfb \
        xdotool \
    && \
    rm -rf /opt/guacamole/* 2>/dev/null; \
    echo "=== runtime deps installed ==="

COPY --from=guacd-build /opt/guacamole /opt/guacamole
COPY --from=guacd-build /opt/freerdp-zephyr /opt/freerdp-zephyr
COPY --from=guacd-build /tmp/build-freerdp-version.txt /tmp/

# 复制 Node.js 运行时和 C++ 库
COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=app-build /tmp/native-runtime-libs/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=app-build /tmp/native-runtime-libs/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=app-build /app /app

# 建立 npm 软链接
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ENV PATH="/opt/freerdp-zephyr/bin:/opt/guacamole/sbin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/freerdp-zephyr/lib:/opt/guacamole/lib:/usr/lib/freerdp2"

# 运行时诊断
RUN echo "=== runtime diagnostics ===" && \
    cat /etc/alpine-release && \
    echo "guacd=$(command -v guacd)" && \
    guacd -v && \
    xfreerdp /version || true && \
    ls -la /opt/guacamole/lib/ | head -20 && \
    find /usr/lib/freerdp2 -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | head -20 && \
    node --version && \
    npm --version && \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 loaded')"

ENV GUACD_EMBEDDED=true
ENV GUACD_HOST=127.0.0.1
ENV GUACD_PORT=4822
ENV GUACD_BIN=guacd

EXPOSE 3000

CMD ["node", "server.js"]
