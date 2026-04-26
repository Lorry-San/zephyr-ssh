FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

# 复制 @wterm/dom 的 dist 目录（包含所有核心逻辑和内联 WASM）
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist && \
    cp node_modules/@wterm/dom/src/terminal.css public/vendor/@wterm/dom/terminal.css

RUN mkdir -p public/vendor/@wterm/core && \
    cp -r node_modules/@wterm/core/dist public/vendor/@wterm/core/dist

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]