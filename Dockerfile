# syntax=docker/dockerfile:1
# ============================================================
# Dockerfile — Web 生产镜像（单实例自托管）
# ============================================================
# builder 保留完整开发依赖执行类型检查与前端构建；runtime 只复制运行源码、
# 已构建静态产物和 omit=dev 依赖。镜像标签记录版本/提交/构建时间，默认 USER node；
# 所有可变数据统一写 /data，根文件系统可由 compose 挂成只读。

ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.client.json tsconfig.desktop.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY desktop ./desktop
RUN npm run typecheck \
 && npm run build:client \
 && node -e "const fs=require('fs');const files=['src/server/public/index.html','src/server/public/main.js','src/server/public/vendor/chart-lib.js','src/server/public/styles/ui.css'];for(const f of files)if(!fs.existsSync(f))throw new Error('missing build asset: '+f)"

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=0.0.0
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="agentatlas" \
      org.opencontainers.image.description="Production self-hosted agentatlas workspace" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    WEB_CONFIG_FILE=/data/web-config.json \
    SESSIONS_FILE=/data/sessions.ndjson \
    CHECKPOINT_FILE=/data/checkpoints.ndjson \
    MEMORIES_FILE=/data/memories.json \
    SKILLS_DIR=/data/skills \
    AUDIT_FILE=/data/audit.ndjson \
    BACKUP_DIR=/data/backups

COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/src/*.ts ./src/
COPY --from=builder --chown=node:node /app/src/agent ./src/agent
COPY --from=builder --chown=node:node /app/src/server ./src/server
COPY --from=builder --chown=node:node /app/scripts/data-cli.ts ./scripts/data-cli.ts
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接以 node 为 PID 1；应用自身注册 SIGTERM 并通过 lifecycle 完成排空。
CMD ["node", "--import", "tsx", "src/server/index.ts"]
