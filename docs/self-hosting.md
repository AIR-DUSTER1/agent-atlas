# 快速自托管

## 1. 前置条件

- Docker 24+（Compose v2）；已在 Docker 28.5.1 / Compose v2.40 验收。
- 一个可用的模型网关（OpenAI 兼容、OpenAI Responses、Anthropic 或 Gemini 协议）。
- 一个域名和 TLS 证书，或先在本机 loopback 验证。
- 至少 2GB 可用内存；启用多并发 Browser Use 时建议 3GB 以上，并配置磁盘告警。

## 2. 准备生产环境文件

```powershell
Copy-Item production.env.example production.env
```

Linux/macOS：

```bash
cp production.env.example production.env
```

编辑 `production.env`，至少填写：

| 变量 | 要求 |
|---|---|
| `AGENT_IMAGE` | `registry/仓库@sha256:...`，生产禁止 `latest` |
| `AUTH_TOKEN` | 首次设备配对密钥，至少 16 位 |
| `SESSION_SECRET` | 设备/HttpOnly 会话签名密钥，至少 32 位 |
| `DEVICE_TTL_DAYS` | 已配对设备凭据有效期，默认 180 天（1–365） |
| `DATA_KEY` | 32 字节 base64，用于 AES-256-GCM |
| `METRICS_TOKEN` | Prometheus 只读令牌，至少 16 位 |
| `BASE_URL` / `API_KEY` / `MODEL` | 首次启动至少一套可用模型 |
| `AI_PROTOCOL` | `openai` / `openai-responses` / `anthropic` / `gemini` |
| `BROWSER_USE_EXECUTABLE_PATH` | 默认镜像已内置 Chrome Headless Shell，通常无需填写；仅在自定义镜像时覆盖 |

生成随机值（Windows PowerShell、Linux bash 均可）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

分别用于 `AUTH_TOKEN`、`SESSION_SECRET`、`DATA_KEY`。`METRICS_TOKEN` 可再生成一个 24–48 字节随机值。

> `DATA_KEY` 丢失后，已加密的配置文件无法恢复。它必须放入密码管理器或独立密钥系统，不能只保存在同一数据盘。

## 3. 发布或获取镜像

本地开发构建：

```bash
docker compose build
```

默认镜像内置与 `playwright-core` 对应的 Chrome Headless Shell。构建阶段从镜像源下载并由固定 SHA-256 校验，官方地址作为兜底；可用 `CHROME_HEADLESS_SHELL_BASE_URL` 指定可信镜像。本次验收镜像显示大小 906 MB、rootfs 631.2 MiB，`image:smoke` 默认要求 rootfs 不超过 700 MiB。当前内置浏览器只支持 `linux/amd64`；明确不使用 Browser Use 时可构建 `--target minimal` 瘦镜像。

生产发布应在 CI / 发布机完成：

```bash
docker build \
  --build-arg IMAGE_VERSION=0.9.0-beta.24 \
  --build-arg GIT_COMMIT=<commit> \
  --build-arg BUILD_TIME=<ISO-8601> \
  --build-arg RELEASE_CHANNEL=beta \
  -t registry.example.com/agentatlas:0.9.0-beta.24 .
docker push registry.example.com/agentatlas:0.9.0-beta.24
docker image inspect registry.example.com/agentatlas:0.9.0-beta.24 \
  --format '{{index .RepoDigests 0}}'
```

把输出的 `registry.example.com/agentatlas@sha256:...` 写入 `AGENT_IMAGE`。生产 compose 不执行 build，只按 digest 拉取。

## 4. 启动

```bash
docker compose --env-file production.env -f docker-compose.production.yml pull
docker compose --env-file production.env -f docker-compose.production.yml up -d
```

检查：

```bash
docker compose --env-file production.env -f docker-compose.production.yml ps
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
docker compose --env-file production.env -f docker-compose.production.yml logs --tail=100
```

经 TLS 反代访问页面；新设备首次输入一次 `AUTH_TOKEN` 完成配对，之后短期会话过期会由 HttpOnly 设备 Cookie 静默续期。每个设备只能看到自己的会话、审批、统计与 Browser Use。首次配对会把旧版明文敏感字段迁移为 AES-256-GCM 密文。

反向代理必须覆盖 `X-Forwarded-For`；否则同机代理可能被误判为 loopback 直连。

## 5. 发布自检

镜像内置结构化自检：

```bash
docker run --rm \
  -e PRODUCTION=1 \
  -e NODE_ENV=production \
  -e AUTH_TOKEN="$AUTH_TOKEN" \
  -e SESSION_SECRET="$SESSION_SECRET" \
  -e DATA_KEY="$DATA_KEY" \
  -e METRICS_TOKEN="$METRICS_TOKEN" \
  "$AGENT_IMAGE" \
  node --import tsx src/server/index.ts --check-production
```

它会验证：生产环境变量、tsx 运行时、前端产物、内置浏览器路径、`/data` 可写、非 root，以及运行层没有 Electron、TypeScript、tests、docs 或本地密钥。完整镜像验收运行 `npm run image:smoke`。

## 6. 数据目录与权限

生产 compose 使用：

```text
宿主目录（默认 ./data）  →  容器 /data
```

根文件系统为只读，只有 `/data` 和 256 MiB 临时 `/tmp` 可写。必须保证宿主机目录仅由受信任管理员与服务用户访问。

贝壳 CLI 默认安装到 `/data/tools/beike`，凭证 HOME 为 `/data/beike-home`，因此容器升级或重启后仍保留。生产环境也可挂载用户已授权的官方 Linux 二进制，并设置 `BEIKE_CLI_PATH`；不要将商业授权的 CLI 二进制打进公共镜像。

## 6.1 PostgreSQL 多用户模式

默认 `STATE_BACKEND=file`。生产多用户请启用：

```env
STATE_BACKEND=postgres
DATABASE_URL=postgresql://agent_app:APP_PASSWORD@postgres:5432/agentatlas
DATABASE_ADMIN_URL=postgresql://agent:ADMIN_PASSWORD@postgres:5432/agentatlas
```

如使用同机 PostgreSQL：

```bash
docker compose --env-file production.env \
  -f docker-compose.production.yml \
  -f docker-compose.postgres.yml up -d
```

`DATABASE_URL` 必须是 `NOSUPERUSER NOBYPASSRLS` 的 `agent_app` 角色；不要用表 owner 运行应用。创建普通用户：

```bash
docker compose ... exec -T agent \
  npm run user:create -- --name "Alice" --email alice@example.com
```

完整的角色、RLS、备份和回滚说明见 [PostgreSQL 多用户与 RLS](postgres-multitenant.md)。
## 7. 首次验收

- [ ] `/healthz`、`/readyz` 返回 200。
- [ ] 登录、退出、会话续期正常。
- [ ] 设置页能读取真实供应商与模型。
- [ ] `data:check` 通过（见备份文档）。
- [ ] 创建一轮 mock 或受控真实对话，刷新页面后历史恢复。
- [ ] 备份成功，manifest 校验通过。
- [ ] 反向代理下 SSE 不缓冲，停止按钮可中断。
- [ ] Browser Use 能打开公网页面并返回截图；求职采集在容器内使用内置无头浏览器。招聘平台扫码登录仍需先在可见浏览器完成并持久化 profile，或后续通过 Browser Use 登录桥接。
