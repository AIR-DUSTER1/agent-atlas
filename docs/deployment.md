# 部署与运维

> 面向自托管用户。当前形态是 **单实例 Web 服务**：一个 Node 进程 + 一个数据目录。
> 多副本/水平扩容不在支持范围内（会话与 journal 是进程内状态，详见文末）。

## 1. Docker Compose 快速启动

前置：Docker 24+（含 Compose v2）。

```bash
# 1) 设置认证令牌（compose 会读取同目录 .env 做变量替换）
#    Windows PowerShell: "AUTH_TOKEN=change-me" | Out-File -Encoding utf8 .env
echo "AUTH_TOKEN=change-me-to-a-long-random-string" >> .env

# 2) 构建并启动（宿主机只映射 127.0.0.1:3000）
docker compose up -d --build

# 3) 看状态 / 日志 / 探针
docker compose ps
docker compose logs -f --tail=100
curl http://127.0.0.1:3000/healthz
```

浏览器打开 `http://127.0.0.1:3000`，首次访问会要求输入 `AUTH_TOKEN`。
容器内监听 `0.0.0.0:3000`，但 compose 只把端口映射到宿主机 loopback；
公网访问请走反向代理（§6），不要直接把端口改成 `0.0.0.0:3000`。

数据全部落在 `./data`（gitignored）：

| 文件 | 内容 |
|---|---|
| `data/web-config.json` | 供应商/模型/项目/外部 Agent/RAG 配置（含 Key，权限自行收紧） |
| `data/sessions.ndjson` | 会话 journal（对话内容、审批状态） |
| `data/audit.ndjson` | 安全动作审计（append-only） |

备份 = 停服后复制整个 `./data`；恢复 = 放回后 `docker compose up -d`。

已在 Docker 28.5.1 / Compose v2.40 验证：镜像可构建（非 root `node`）、容器
healthcheck 变 `healthy`、`/healthz` 200、`docker stop` 约 0.7–0.8s 退出码 0，
`docker logs` 为纯 NDJSON（无人类横幅）。3 天连续运行与真实反向代理链路仍需
按部署环境自行验证。

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1`（本地）/ `0.0.0.0`（镜像） | 监听地址；对外开放必须同时设置 `AUTH_TOKEN` |
| `PORT` | `3000` | HTTP 端口 |
| `AUTH_TOKEN` | 空 | Bearer 令牌；空 = 不认证。非 loopback 且为空时写请求会被拒绝 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `WEB_CONFIG_FILE` | 仓库根 `.web-config.json` | 镜像内为 `/data/web-config.json` |
| `SESSIONS_FILE` | `.setting/sessions.ndjson` | 镜像内为 `/data/sessions.ndjson` |
| `AUDIT_FILE` | `.setting/audit.ndjson` | 镜像内为 `/data/audit.ndjson` |
| `TZ` | 容器默认 UTC | compose 默认 `Asia/Shanghai` |

`.env` 只用于本地/进程环境变量；镜像不包含 `.env`，容器配置用 compose 的
`environment` 或 `docker compose --env-file` 注入。

## 3. 健康检查

两个端点都**免认证**，供编排器/负载均衡探测；响应不含路径、供应商或 Key。

`GET /healthz`（liveness）：只证明进程与事件循环活着，永不 503。

```json
{ "ok": true, "version": "1.0.0", "uptimeSeconds": 42 }
```

`GET /readyz`（readiness）：检查配置目录与 session journal 目录可写、且未在关闭中。
不可用时返回 **503**。

```json
{
  "ok": true,
  "version": "1.0.0",
  "uptimeSeconds": 42,
  "shuttingDown": false,
  "checks": { "configStore": true, "sessionStore": true }
}
```

Docker 镜像内置 healthcheck（`node -e fetch(...)`，不依赖 curl）。Nginx/K8s 建议
liveness 用 `/healthz`、readiness 用 `/readyz`，并将失败阈值放宽到 ≥3 次，
避免模型长调用期间把正常进程判死。

## 4. 优雅退出

服务收到 `SIGINT` / `SIGTERM`（Windows 额外支持 `SIGBREAK`）后：

1. `/readyz` 立即转 503，新业务请求回 `503 {"error":"服务正在关闭，请稍后重试"}`；
2. 向所有进行中的 SSE 连接补一帧 `{"type":"shutdown",...}` 再断开
   （前端顶部显示「服务正在关闭，请稍后刷新页面重连」，与网络故障区分）；
3. 等待在途请求自然结束，最多 `10s`；
4. 超时则强制销毁剩余连接；
5. 等待 journal / audit 待写队列落盘；
6. 退出码：正常排空 `0`，超时强杀 `1`。

compose 已设 `stop_grace_period: 15s`（大于 10s 内部超时），`docker stop`
不会把进程直接 SIGKILL。**第二次** `Ctrl+C` / 重复信号会立即退出（退出码 1），
这是给「等不及」的场景留的逃生门。

Windows 注意：`taskkill /F` 是强制终止，不会触发上述流程；开发时用终端
`Ctrl+C`，桌面端目前退出走 `taskkill /F`（打包评估见 §7）。

## 5. 日志与审计

### 5.1 结构化日志（stdout）

每个请求一行 JSON，容器日志直接可采集：

```json
{"requestId":"7f3c…","method":"POST","path":"/api/chat","status":200,
 "durationMs":8231,"time":"2026-10-21T08:00:00.000Z","level":"info","event":"http_request"}
```

- `requestId` 同时写进响应头 `X-Request-Id`，用户报错时可据此定位；
- 静态资源日志只在 `LOG_LEVEL=debug` 输出；`/api/*` 在 `info` 输出；
- 密钥类字段（token/apiKey/authorization/cookie 等）统一打码为 `***`；
- **不记录请求体与用户消息**，错误只记截断后的 message；
- 生命周期事件：`server_start` / `server_shutdown` / `server_stopped` /
  `request_rejected` / `shutdown_forced` / `request_failed`。

### 5.2 审计（append-only）

`AUDIT_FILE` 记录安全边界动作（外部 Agent 注册/执行、贝壳 CLI 安装、认证失败等），
超 1MB 自动保留尾部 512KB。审计与普通日志分开：前者是合规痕迹，不随
`LOG_LEVEL` 关闭。

## 6. 反向代理

SSE 的关键是「禁用响应缓冲 + 足够长的读超时」，否则 token 会被代理攒着一起发。

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name agent.example.com;

    # 上传接口上限 2MB，留出 JSON/多文件余量
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # SSE：不缓冲、不缓存、长连接
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Caddy

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

代理层限流（可选，Nginx 放在 `http {}` 块）：

```nginx
limit_req_zone $binary_remote_addr zone=agent_api:10m rate=10r/s;

location /api/ {
    limit_req zone=agent_api burst=20 nodelay;
    proxy_pass http://127.0.0.1:3000;
}
```

建议在代理层开启 TLS 与 access log（Nginx 默认 `access_log` 即可，注意不要记录
`Authorization` 头）；应用内的 Bearer 认证保持不变（`Authorization` 头默认透传）。
如果只对外提供部分能力，可在代理层只放行 `/api/`、`/healthz`、`/readyz` 与
静态资源（`/`、`/app.js`、`/modules/`、`/style.css`）；不要把 `/api/*` 缓存到 CDN。

## 7. 桌面端打包评估（未实施）

现状：`desktop/main.ts` 是**开发壳** —— Electron 启动 `npx tsx src/server/index.ts`
子进程（默认 3123 端口），退出时 Windows 同步等待 `taskkill /T /F` 完成，
避免 npx→tsx→node 树残留。它没有安装包、签名、自动更新，也不经过 §4 的
优雅退出（`/F` 直接杀）。源码是 TypeScript，`npm run build:desktop` 编译到
`desktop/build/`（主进程 ESM `.js` + preload `.cjs`）。

要变成可分发的桌面产品，至少需要：

- **打包工具**：electron-builder 或 electron-forge（新增 devDependency，需单独评审）；
- **运行时**：把 Node/tsx 与 `node_modules` 一起装入，或构建服务端 bundle
  （前端仍保持零构建约束）；
- **数据目录**：从仓库根迁移到 `app.getPath("userData")`，首次启动迁移旧 `.setting`；
- **端口**：3123 被占用时自动挑选空闲端口，并通过环境变量传给服务；
- **退出链路**：Windows 改为向子进程发送可捕获的关闭信号（或本地 HTTP
  `POST /internal/shutdown`），确保 journal/audit flush；
- **签名与更新**：Windows/macOS 代码签名、公证、自动更新通道、CI 矩阵；
- **托盘/单实例**：已有单实例锁，可补托盘与「关闭窗口最小化到托盘」。

在上述工作完成前，桌面端只作为本机开发便利工具；生产交付用 Web + Docker。

## 8. 边界与后续

- **单实例**：会话、限流闸、SSE 连接表都在进程内；不要对同一 `data/` 目录起多个
  副本（配置写入虽有跨进程锁，会话 journal 没有多写者协调）。
- **水平扩容**：需要把会话/审批/限流外移到共享存储与消息层，属于 Phase 5。
- **试点**：Phase 5 的「连续运行 3 天 + 一次模型供应商故障」验收尚未执行，
  上线前建议按该清单跑一轮并观察 `/readyz`、`server_stopped` 与审计滚动。
