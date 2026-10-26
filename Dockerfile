# syntax=docker/dockerfile:1
# ============================================================
# Dockerfile — Web 服务镜像（开发/自托管用，Phase 4）
# ============================================================
# 本项目用 tsx 直跑 TS（tsconfig noEmit），没有构建产物，所以运行镜像
# 必须保留 devDependencies（tsx/typescript）。--ignore-scripts 跳过 electron
# 的二进制下载（桌面端不参与 Web 镜像），node_modules 从 deps 阶段复制。
# 安全默认：非 root 运行；配置/journal/审计统一放 /data 卷。

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    WEB_CONFIG_FILE=/data/web-config.json \
    SESSIONS_FILE=/data/sessions.ndjson \
    AUDIT_FILE=/data/audit.ndjson

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# 前端是 TypeScript，必须先构建成浏览器可执行的 ESM（src/server/public/）
RUN npm run build:client && mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]

# 用 node fetch 打 /healthz（镜像内没有 curl）；PORT 允许被 compose 覆盖
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接以 node 为 PID 1：SIGTERM 才能进到 index.ts 的优雅退出处理器
CMD ["node", "--import", "tsx", "src/server/index.ts"]
