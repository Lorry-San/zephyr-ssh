FROM node:18-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

# 拷贝 @wterm 静态资源到 public/vendor，确保 Express 可静态服务
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist 2>/dev/null || true && \
    ( cp node_modules/@wterm/dom/css.css public/vendor/@wterm/dom/css.css 2>/dev/null || echo "/* minimal wterm css */" > public/vendor/@wterm/dom/css.css )

EXPOSE 3000
CMD ["node", "server.js"]