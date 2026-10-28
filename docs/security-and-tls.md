# 安全与 TLS

## 1. 安全默认

| 边界 | 实现 |
|---|---|
| 登录 | `AUTH_TOKEN` 仅换取短期签名会话；浏览器不保存引导密钥 |
| Cookie | `HttpOnly`、`SameSite=Strict`；生产强制 `Secure` |
| 会话 | HMAC-SHA256、进程 boot nonce、可注销、过期失效 |
| 失败限流 | IP 5 次 / 15 分钟，全局 100 次 / 15 分钟 |
| 密钥落盘 | 供应商 API Key、MCP env 等使用 AES-256-GCM |
| CSRF | 变更请求校验 Origin / `Sec-Fetch-Site` |
| CSP | 禁止任意 inline script，内联脚本使用 SHA-256 allowlist |
| 路径 | 文件接口先 resolve，再做授权根与真实路径边界校验 |
| 外部请求 | SSRF 防护、协议白名单、超时、熔断与资源队列 |
| 审批 | 高风险工具必须经过审批或显式权限模式 |

## 2. 反向代理要求

Agent 必须只监听 loopback：

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

公网只开放 443。代理必须：

- 覆盖而不是盲目信任客户端传入的 `X-Forwarded-For` / `X-Forwarded-Proto`；
- 对 SSE 禁用缓冲和缓存；
- 不记录 `Authorization`、`Cookie` 或请求正文；
- 对 `/api/auth/session` 单独增加更严格的边缘限流；
- 不把 `/metrics` 与 `/api/diagnostics` 暴露到公开路径。

只有代理会正确覆盖转发头时，才设置 `TRUST_PROXY=1`。直连场景保持关闭，否则攻击者可伪造 IP 绕过认证限流。

## 3. Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name agent.example.com;

    ssl_certificate     /etc/letsencrypt/live/agent.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agent.example.com/privkey.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 只允许监控网络访问
    location = /metrics {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}

server {
    listen 80;
    server_name agent.example.com;
    return 301 https://$host$request_uri;
}
```

## 4. Caddy

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Caddy 自动管理 TLS。若需要对 `/metrics` 限制来源，在站点内增加 `@metrics` matcher 与 `remote_ip` 规则。

## 5. Prometheus 指标认证

生产环境浏览器会话是 HttpOnly Cookie，不适合作为 Prometheus 凭据。设置独立的 `METRICS_TOKEN`：

```yaml
scrape_configs:
  - job_name: langgraph-agent
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/agent-metrics-token
    static_configs:
      - targets: ["agent.example.com"]
    metrics_path: /metrics
```

该 token 只授权 `/metrics`，访问 `/api/*` 仍返回 401。轮换时先更新 Prometheus secret，再重启 Agent。

## 6. 数据边界

- `.env`、`production.env`、`.web-config.json`、`.setting/`、`data/` 不得进入 Git 或镜像。
- 生产数据卷权限建议 `0700` 目录、`0600` 敏感文件（以宿主操作系统能力为准）。
- 备份文件仍含加密后的供应商 Key；备份本身仍按敏感文件管理。
- `DATA_KEY` 不属于备份目录，需单独保存在密码管理器或 KMS。
- 浏览器只通过 HTTPS；在纯 HTTP 下生产 Cookie 不会被发送，登录表现为“成功后仍回到登录框”。

## 7. 安全变更规则

- 不关闭认证、CSP、同源检查和审批来“临时绕过”。
- 新增执行命令、写文件、发送消息或控制电脑的工具，必须在 `hitl.ts` 登记为高风险。
- 新增外部 URL 能力必须走统一 SSRF 校验。
- 新增日志字段必须经过脱敏 allowlist，不记录 prompt、工具正文、Cookie 或 Key。
