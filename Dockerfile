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
# npm 缓存指向 /tmp 并在层内清理，避免残留在镜像层的 $HOME/.npm
ENV npm_config_cache=/tmp/npm-cache
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && rm -rf /tmp/npm-cache
COPY tsconfig.json tsconfig.client.json tsconfig.desktop.json vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY desktop ./desktop
RUN npm run typecheck \
 && RELEASE_CHANNEL="${RELEASE_CHANNEL}" GIT_COMMIT="${GIT_COMMIT}" BUILD_TIME="${BUILD_TIME}" npm run build:client \
 && node -e "const fs=require('fs');const files=['src/server/public/index.html','src/server/public/assets/app.js','src/server/public/build-info.json','src/server/public/styles/base/tokens.css','src/server/public/styles/base/ui.css'];for(const f of files)if(!fs.existsSync(f))throw new Error('missing build asset: '+f)"

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
# 同 builder：npm 缓存指向 /tmp 并在层内清理，node_modules 是层内唯一保留物
ENV npm_config_cache=/tmp/npm-cache
COPY package.json package-lock.json ./
# LangGraph SDK 将 Vue 声明为可选 peer；显式省略 optional，避免 devOptional 的 Vue/TypeScript
# 被 npm 自动补进完全不需要前端运行时的服务端镜像。
RUN npm ci --omit=dev --omit=optional --ignore-scripts && rm -rf /tmp/npm-cache
# omit=optional 会移除 esbuild 的平台二进制，但运行期 tsx 仍需要它；只从完整 builder
# 回填当前构建平台包，避免重新安装 Vue/TypeScript 这类仅前端使用的 optional peer。
COPY --from=builder --chown=node:node /app/node_modules/@esbuild/linux-x64 ./node_modules/@esbuild/linux-x64

# 浏览器版本从 playwright-core/browsers.json 读取；升级 Playwright 后若校验和不匹配，
# 构建会失败并提示更新 CHROME_HEADLESS_SHELL_SHA256，避免静默漂移。
FROM ${NODE_IMAGE} AS browser
ARG CHROME_HEADLESS_SHELL_BASE_URL=https://cdn.npmmirror.com/binaries/chrome-for-testing
ARG CHROME_HEADLESS_SHELL_FALLBACK_URL=https://storage.googleapis.com/chrome-for-testing-public
ARG CHROME_HEADLESS_SHELL_SHA256=c3e50596aef52c58f8fda3c6b3411c33d34c88b177b3ed1c2243359fd3b8ba20
# BuildKit 自动注入的目标镜像平台；下载路径 linux64 只对应 linux/amd64。dpkg 校验
# 保留双保险：防 TARGETPLATFORM 为空的非 BuildKit 环境绕过平台检查。
ARG TARGETPLATFORM
WORKDIR /tmp/browser
COPY --from=production-deps /app/node_modules/playwright-core/browsers.json ./browsers.json
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
# 不用断点续传：部分 CDN 对 302 跳转后的 Range 请求行为不一致，续传易得到损坏的
# zip；每次重试都先删除旧文件全新下载，SHA256 校验兜底防篡改与截断。
RUN set -eu; \
    if [ -n "${TARGETPLATFORM:-}" ] && [ "$TARGETPLATFORM" != "linux/amd64" ]; then \
      echo "Chrome Headless Shell 仅支持 linux/amd64，当前目标平台：$TARGETPLATFORM" >&2; exit 1; \
    fi; \
    test "$(dpkg --print-architecture)" = "amd64" || { echo "构建容器架构为 $(dpkg --print-architecture)，无法产出 linux/amd64 的 Chrome Headless Shell" >&2; exit 1; }; \
    version="$(node -e "const b=require('./browsers.json').browsers.find(v=>v.name==='chromium-headless-shell');process.stdout.write(b.browserVersion)")"; \
    path="${version}/linux64/chrome-headless-shell-linux64.zip"; \
    download_ok=0; \
    for base in "$CHROME_HEADLESS_SHELL_BASE_URL" "$CHROME_HEADLESS_SHELL_FALLBACK_URL"; do \
      test -n "$base" || continue; \
      for attempt in 1 2 3; do \
        rm -f chrome-headless-shell.zip; \
        if curl -fL --connect-timeout 20 --max-time 300 "$base/$path" -o chrome-headless-shell.zip; then download_ok=1; break 2; fi; \
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

# 运行镜像不提供 Yarn 包管理流程；移除 Node 镜像自带 Yarn，缩小攻击面与镜像体积。
RUN rm -rf /opt/yarn-v1.22.22 /usr/local/bin/yarn /usr/local/bin/yarnpkg

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
    BACKUP_DIR=/data/backups \
    BEIKE_INSTALL_DIR=/data/tools/beike \
    BEIKE_USER_HOME=/data/beike-home

COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json /app/tsconfig.json ./
# 整体复制 src 与 scripts：新增顶层目录或脚本自动带入，杜绝硬编码清单漏 COPY
# 导致「构建成功、运行时模块找不到」；多带几 MB 源码换来零维护。
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/scripts ./scripts
# src/client 前端源码不进生产镜像（产物已构建到 src/server/public），构建期删除防误引用。
RUN mkdir -p /data && chown node:node /data && rm -rf src/client

USER node
EXPOSE 3000
VOLUME ["/data"]
# SIGTERM 由应用注册排空（见 lifecycle）；docker stop 的等待时长无法在镜像内设置，
# 由 compose 的 stop_grace_period: 15s 控制（开发与生产 compose 均已配置）。
STOPSIGNAL SIGTERM

# slim 基础镜像不带 curl，用 node 原生 fetch 探活（HOST 固定 0.0.0.0 为 IPv4 全接口，
# 127.0.0.1 必达，不依赖 tsx 运行环境）；失败时把 HTTP 状态码/异常写入 stderr，
# docker inspect 的健康日志可直接排障。
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok){console.error('healthz HTTP '+r.status);process.exit(1)}process.exit(0)}).catch(e=>{console.error('healthz '+e?.message);process.exit(1)})"

# 直接以 node 为 PID 1；应用自身注册 SIGTERM 并通过 lifecycle 完成排空。
CMD ["node", "--import", "tsx", "src/server/index.ts"]

# 无浏览器瘦镜像：docker build --target minimal -t agentatlas:minimal .
FROM runtime-base AS minimal

# 默认生产镜像：只安装 Headless Shell 所需库，不引入完整 Chromium、Xvfb、X 字体栈和 Mesa DRI。
# apt 刻意不锁包版本：Debian point release 后旧版本包会从镜像源下架，锁死版本反而会在
# 安全更新后构建失败；可复现性由基础镜像 digest 与浏览器 SHA256 兜底。
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
# 浏览器目录保持 root:root 只读（二进制 755 可执行）：Playwright 启动时以 --user-data-dir
# 指向 /tmp 下的临时 profile，运行不写安装目录；node 用户不可篡改浏览器二进制，降低进程
# 被入侵后替换二进制实现持久化的风险。
COPY --from=browser /opt/chrome-headless-shell /opt/chrome-headless-shell
RUN ln -s /opt/chrome-headless-shell/chrome-headless-shell /usr/local/bin/chromium
# 这些是 Browser Use / 求职采集的无头 Chromium 配置，不包含 Computer Use 二进制；
# BROWSER_USE_CONTAINER=1 同时作为容器标记，让 Computer Use 始终保持 fail-closed。
ENV BROWSER_USE_EXECUTABLE_PATH=/opt/chrome-headless-shell/chrome-headless-shell \
    BROWSER_USE_CONTAINER=1 \
    JOB_BROWSER_HEADLESS=1
USER node
# 以 node 用户做真实启动 smoke：root 能跑不代表 node 能跑（动态库、权限位差异必须在
# 构建期暴露），完整拉起一次 about:blank 验证二进制加载、临时目录写入与渲染链路。
RUN set -eu; \
    /opt/chrome-headless-shell/chrome-headless-shell --version; \
    profile="$(mktemp -d)"; \
    /opt/chrome-headless-shell/chrome-headless-shell \
      --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --user-data-dir="$profile" --dump-dom about:blank > /dev/null; \
    rm -rf "$profile"
