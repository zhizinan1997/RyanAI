# syntax=docker/dockerfile:1.7
FROM node:22.22.3-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
RUN npm ci

COPY tsconfig.json openclaw.plugin.json ./
COPY src ./src
RUN npm run build

FROM node:22.22.3-bookworm-slim AS runtime

ENV NODE_ENV=production \
    BOT_GATEWAY_ENABLED=false \
    BOT_GATEWAY_INTERNAL_PORT=8787 \
    BOT_GATEWAY_DATA_DIR=/data \
    BOT_GATEWAY_OPENCLAW_STATE_DIR=/tmp/ryanai-openclaw/state \
    BOT_GATEWAY_OPENCLAW_HOME_DIR=/tmp/ryanai-openclaw/home \
    RYANAI_BASE_URL=http://ryanai:8080

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
RUN npm ci --omit=dev \
    && npm ls --omit=dev --depth=0 \
    && node -e "for (const id of ['openclaw','@tencent-weixin/openclaw-weixin/dist/index.js','@tencent-weixin/openclaw-weixin/dist/src/auth/login-qr.js','@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js','@tencent-connect/openclaw-qqbot','@tencent-connect/qqbot-connector']) require.resolve(id)" \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY openclaw.plugin.json README.md ./

RUN install -d -o node -g node -m 0700 \
      /data \
      /tmp/ryanai-openclaw \
      /tmp/ryanai-openclaw/state \
      /tmp/ryanai-openclaw/state/media \
      /tmp/ryanai-openclaw/home \
      /tmp/ryanai-openclaw/home/.openclaw \
      /tmp/ryanai-openclaw/home/.openclaw/media
USER node

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BOT_GATEWAY_INTERNAL_PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
