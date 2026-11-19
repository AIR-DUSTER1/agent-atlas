# syntax=docker/dockerfile:1
# ============================================================
# Dockerfile — Web 生产镜像（单实例自托管）
# ============================================================
# builder 保留完整开发依赖执行类型检查与前端构建；production-deps 只装运行依赖；
# browser 阶段下载与 playwright-core 同版本的 Chrome Headless Shell；runtime 仅复制
# 浏览器二进制并安装最小运行库。minimal target 不包含浏览器，适合关闭 Browser Use。

ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM ${NODE_IMAGE} AS builder
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG RELEASE_CHANNEL=dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.client.json tsconfig.desktop.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY desktop ./desktop
RUN npm run typecheck \
 && RELEASE_CHANNEL="${RELEASE_CHANNEL}" GIT_COMMIT="${GIT_COMMIT}" BUILD_TIME="${BUILD_TIME}" npm run build:client \
 && node -e "const fs=require('fs');const files=['src/server/public/index.html','src/server/public/main.js','src/server/public/build-info.json','src/server/public/vendor/chart-lib.js','src/server/public/styles/ui.css'];for(const f of files)if(!fs.existsSync(f))throw new Error('missing build asset: '+f)"

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 浏览器版本从 playwright-core/browsers.json 读取；升级 Playwright 后若校验和不匹配，
# 构建会失败并提示更新 CHROME_HEADLESS_SHELL_SHA256，避免静默漂移。
FROM ${NODE_IMAGE} AS browser
ARG CHROME_HEADLESS_SHELL_BASE_URL=https://cdn.npmmirror.com/binaries/chrome-for-testing
ARG CHROME_HEADLESS_SHELL_FALLBACK_URL=https://storage.googleapis.com/chrome-for-testing-public
ARG CHROME_HEADLESS_SHELL_SHA256=c3e50596aef52c58f8fda3c6b3411c33d34c88b177b3ed1c2243359fd3b8ba20
WORKDIR /tmp/browser
COPY --from=production-deps /app/node_modules/playwright-core/browsers.json ./browsers.json
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
RUN set -eu; \
    test "$(dpkg --print-architecture)" = "amd64" || { echo "Chrome Headless Shell 当前只支持 linux/amd64" >&2; exit 1; }; \
    version="$(node -e "const b=require('./browsers.json').browsers.find(v=>v.name==='chromium-headless-shell');process.stdout.write(b.browserVersion)")"; \
    path="${version}/linux64/chrome-headless-shell-linux64.zip"; \
    download_ok=0; \
    for base in "$CHROME_HEADLESS_SHELL_BASE_URL" "$CHROME_HEADLESS_SHELL_FALLBACK_URL"; do \
      test -n "$base" || continue; \
      for attempt in 1 2 3; do \
        if curl -fL --continue-at - --connect-timeout 20 --max-time 300 "$base/$path" -o chrome-headless-shell.zip; then download_ok=1; break 2; fi; \
        sleep 3; \
      done; \
    done; \
    test "$download_ok" = "1"; \
    test -s chrome-headless-shell.zip; \
    echo "${CHROME_HEADLESS_SHELL_SHA256}  /tmp/browser/chrome-headless-shell.zip" | sha256sum -c -; \
    unzip -q chrome-headless-shell.zip -d extracted; \
    mkdir -p /opt/chrome-headless-shell; \
    cp -a extracted/chrome-headless-shell-linux64/. /opt/chrome-headless-shell/; \
    find /opt/chrome-headless-shell/locales -type f ! -name 'en-US.pak' ! -name 'zh-CN.pak' -delete; \
    test -x /opt/chrome-headless-shell/chrome-headless-shell

FROM ${NODE_IMAGE} AS runtime-base
ARG IMAGE_VERSION=
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="agentatlas" \
      org.opencontainers.image.description="Production self-hosted agentatlas workspace" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
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
    MEMORY_STORE_DIR=/data/memory-store \
    SKILLS_DIR=/data/skills \
    AUDIT_FILE=/data/audit.ndjson \
    BACKUP_DIR=/data/backups

COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/src/*.ts ./src/
COPY --from=builder --chown=node:node /app/src/agent ./src/agent
COPY --from=builder --chown=node:node /app/src/memory ./src/memory
COPY --from=builder --chown=node:node /app/src/routing ./src/routing
COPY --from=builder --chown=node:node /app/src/server ./src/server
COPY --from=builder --chown=node:node /app/scripts/data-cli.ts ./scripts/data-cli.ts
COPY --from=builder --chown=node:node /app/scripts/db-migrate.ts ./scripts/db-migrate.ts
COPY --from=builder --chown=node:node /app/scripts/create-user.ts ./scripts/create-user.ts
COPY --from=builder --chown=node:node /app/scripts/browser-smoke.ts ./scripts/browser-smoke.ts
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接以 node 为 PID 1；应用自身注册 SIGTERM 并通过 lifecycle 完成排空。
CMD ["node", "--import", "tsx", "src/server/index.ts"]

# 无浏览器瘦镜像：docker build --target minimal -t agentatlas:minimal .
FROM runtime-base AS minimal

# 默认生产镜像：只安装 Headless Shell 所需库，不引入完整 Chromium、Xvfb、X 字体栈和 Mesa DRI。
FROM runtime-base AS runtime
USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fonts-wqy-microhei \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /tmp/*
COPY --from=browser /opt/chrome-headless-shell /opt/chrome-headless-shell
RUN set -eu; \
    /opt/chrome-headless-shell/chrome-headless-shell --version; \
    ln -s /opt/chrome-headless-shell/chrome-headless-shell /usr/local/bin/chromium
ENV BROWSER_USE_EXECUTABLE_PATH=/opt/chrome-headless-shell/chrome-headless-shell \
    BROWSER_USE_CONTAINER=1 \
    JOB_BROWSER_HEADLESS=1
USER node
