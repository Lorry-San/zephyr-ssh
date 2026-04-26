FROM node:18-alpine
WORKDIR /app

# copy package files first for caching
COPY package.json package-lock.json* ./

# install production dependencies
RUN npm install --production

# copy app files
COPY . .

# copy wterm static assets into public/vendor so express can serve them
# adjust paths if package structure differs
RUN mkdir -p public/vendor/@wterm/dom && \
    cp -r node_modules/@wterm/dom/dist public/vendor/@wterm/dom/dist 2>/dev/null || true && \
    cp -r node_modules/@wterm/dom/css.css public/vendor/@wterm/dom/css.css 2>/dev/null || true

EXPOSE 3000
CMD ["node", "server.js"]