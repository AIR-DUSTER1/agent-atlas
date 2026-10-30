# 快速自托管

## 1. 前置条件

- Docker 24+（Compose v2）；已在 Docker 28.5.1 / Compose v2.40 验收。
- 一个可用的模型网关（OpenAI 兼容、OpenAI Responses、Anthropic 或 Gemini 协议）。
- 一个域名和 TLS 证书，或先在本机 loopback 验证。
- 至少 1GB 可用内存；建议 2GB 以上并配置磁盘告警。

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
| `AUTH_TOKEN` | 浏览器登录引导密钥，至少 16 位 |
| `SESSION_SECRET` | HttpOnly 会话签名密钥，至少 32 位 |
| `DATA_KEY` | 32 字节 base64，用于 AES-256-GCM |
| `METRICS_TOKEN` | Prometheus 只读令牌，至少 16 位 |
| `BASE_URL` / `API_KEY` / `MODEL` | 首次启动至少一套可用模型 |
| `AI_PROTOCOL` | `openai` / `openai-responses` / `anthropic` / `gemini` |

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

生产发布应在 CI / 发布机完成：

```bash
docker build \
  --build-arg APP_VERSION=0.9.0-beta.1 \
  --build-arg GIT_COMMIT=<commit> \
  --build-arg BUILD_TIME=<ISO-8601> \
  -t registry.example.com/agentatlas:0.9.0-beta.1 .
docker push registry.example.com/agentatlas:0.9.0-beta.1
docker image inspect registry.example.com/agentatlas:0.9.0-beta.1 \
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

经 TLS 反代访问页面，输入 `AUTH_TOKEN` 登录。首次登录会把旧版明文敏感字段迁移为 AES-256-GCM 密文。

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

它会验证：生产环境变量、tsx 运行时、前端产物、`/data` 可写、非 root，以及运行层没有 Electron、TypeScript、tests、docs 或本地密钥。

## 6. 数据目录与权限

生产 compose 使用：

```text
宿主目录（默认 ./data）  →  容器 /data
```

根文件系统为只读，只有 `/data` 和临时 `/tmp` 可写。必须保证宿主机目录仅由受信任管理员与服务用户访问。

## 7. 首次验收

- [ ] `/healthz`、`/readyz` 返回 200。
- [ ] 登录、退出、会话续期正常。
- [ ] 设置页能读取真实供应商与模型。
- [ ] `data:check` 通过（见备份文档）。
- [ ] 创建一轮 mock 或受控真实对话，刷新页面后历史恢复。
- [ ] 备份成功，manifest 校验通过。
- [ ] 反向代理下 SSE 不缓冲，停止按钮可中断。
