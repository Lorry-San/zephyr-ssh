FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

# 复制 @wterm/dom 静态资源到 public/vendor
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist 2>/dev/null || true && \
    cp node_modules/@wterm/dom/css.css public/vendor/@wterm/dom/css.css 2>/dev/null || true

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]