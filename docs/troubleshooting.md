# 故障排查

## 启动类

### `EADDRINUSE`

原因：3000/3123/测试端口被旧进程占用。

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
Get-Process -Id <PID>
```

确认进程归属后再停止；不要盲目杀掉其他项目。容器部署用 `docker compose ps` 查看端口冲突。

### 生产启动立即退出

检查结构化日志中的 `startup_check_failed`：

- `AUTH_TOKEN` 少于 16 位或为占位值；
- `SESSION_SECRET` 少于 32 位；
- `DATA_KEY` 不是 32 字节 base64；
- `COOKIE_SECURE=false`；
- 没有可用供应商 / API Key，生产禁止 mock；
- `/data` 不可写或只读；
- 配置密文与 `DATA_KEY` 不匹配。

### `readyz` 503

看 `checks.configStore`、`checks.sessionStore` 与 `shuttingDown`。常见原因是只读挂载、磁盘满、目录权限错误或进程正在优雅关闭。

## 登录与代理

### 登录成功后又弹登录框

- 生产必须 HTTPS + `COOKIE_SECURE=true`；HTTP 下 Secure Cookie 不会回传。
- 反代是否覆盖 `X-Forwarded-Proto`。
- 是否在不同主机名先登录、再跳到另一个域名。
- 系统时间偏差过大会影响会话时间判断。

### 401 / 429

- 401：会话失效、过期或伪造；重新登录。
- 429：认证失败限流；等待 `Retry-After`，检查来源 IP 和反代转发头。
- `METRICS_TOKEN` 只能访问 `/metrics`，访问控制面 API 仍是 401。

## 对话与 SSE

### 页面一直“加载中”

- 浏览器 Network 是否出现静态模块 404；
- 运行 `npm run build:client` 或重新发布镜像；
- 检查服务端是否使用旧代码、静态目录白名单是否包含新构建目录；
- 看 `/api/config` 是否 401/500。

### SSE 卡住或逐字输出变成整段

反向代理必须关闭 buffering/cache，并延长 read timeout。确认 `Connection` 头被正确清空，不要把 `/api/chat` 放到 CDN 缓存。

### 停止后仍残留闪烁光标

前端在工具、节点、审批、错误边界必须立刻封口流式文本；升级到包含流式 cursor 修复的版本。若只在旧镜像出现，按升级流程发布。

## 配置与数据

### 配置解密失败

`startup_fail_closed` 表示 `DATA_KEY` 与配置文件不匹配。不要直接删除生产配置；恢复正确 Key 或从匹配备份恢复。

### journal / checkpoint 坏行

启动会将坏行移动到 `.corrupt`，其余合法行继续回放。运行：

```bash
npm run data:check
```

若发现未来 schemaVersion，回滚到匹配镜像，禁止旧程序继续写入。

### 恢复后没有旧会话

确认恢复的是正确备份，且 checkpoint / journal 都在 manifest 中；重启服务让内存态重新加载；检查恢复后的 transcript 与 checkpoint 文件权限。

## 外部依赖

### 模型网关不可用

- 看 `/api/diagnostics` 与模型错误指标；
- 检查供应商 Key、BASE_URL、协议与模型名；
- 切换已配置 fallback 供应商；
- 不要让自动重试无限消耗真实配额；熔断 open 时等待冷却或人工切换。

### MCP 子进程退出

单个 MCP server 死亡会转成模型可读错误，不应拖垮主服务。检查 MCP 命令路径、环境变量、stderr；必要时重启容器。不要手工保留泄漏的旧子进程，重启后验证状态。

### 磁盘满

先停止产生新写入的业务流量，保留现场；把审计/备份复制到异机；清理可再生成缓存前先确认不删数据卷；恢复空间后启动并运行 `data:check`。`docker system prune` 只清理无引用镜像/缓存，执行前必须确认不会删除仍在使用的镜像层。
