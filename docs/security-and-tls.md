# 安全与 TLS

## 1. 安全默认

| 边界 | 实现 |
|---|---|
| 登录入口 | 文件模式用 `AUTH_TOKEN` 首次配对；**数据库模式一律用户名密码登录**（与 `AUTH_TOKEN` 是否为空无关） |
| 设备配对 | `AUTH_TOKEN` 只用于新公网设备首次配对（文件模式）与运维救援；浏览器不保存引导密钥 |
| 静默恢复 | 文件模式本机直连自动建立 `local` 身份；数据库模式不因本机直连免登。已配对设备用长期设备 Cookie 静默换短期会话 |
| Cookie | 会话与设备 Cookie 均为 `HttpOnly`、`SameSite=Strict`；生产强制 `Secure` |
| 会话 | HMAC-SHA256、进程 boot nonce、可注销、过期失效；会话按设备归属隔离 |
| 失败限流 | IP 5 次 / 15 分钟，全局 100 次 / 15 分钟 |
| 密钥落盘 | 供应商 API Key、MCP env 等使用 AES-256-GCM |
| CSRF | 变更请求校验 Origin / `Sec-Fetch-Site` |
| CSP | 禁止任意 inline script，内联脚本使用 SHA-256 allowlist |
| 路径 | 文件接口先 resolve，再做授权根与真实路径边界校验 |
| 外部请求 | SSRF 防护、协议白名单、超时、熔断与资源队列 |
| 审批 | 高风险工具必须经过审批或显式权限模式 |

## 2. 设备身份与会话隔离

浏览器和 HTTP 服务都无法可靠读取物理 MAC：公网请求经过路由、代理和容器后只剩 IP，
浏览器也没有相应 Web API；即使服务端运行在本机，网卡地址也可能变化且可被伪造。
因此产品使用服务端签名的设备 Cookie 作为稳定设备身份：

- 设备 Cookie 默认 180 天，使用 `SESSION_SECRET` HMAC 签名，跨服务重启保持有效；
- 短期会话默认 12 小时；过期后前端自动用设备 Cookie 换取新会话，不弹令牌框；
- 文件模式本机直连自动建立 `local` 设备身份，适用于个人桌面环境；
- 数据库模式不提供本机免登：任何请求都要有效会话，登录走用户名密码，
  初始密码由首次启动自动生成（见 [PostgreSQL 多用户与 RLS](postgres-multitenant.md)）；
- 文件模式新公网设备仍需用 `AUTH_TOKEN` 配对一次；清除站点数据或更换浏览器视为新设备；
- 每个会话 journal 记录设备归属，列表、聊天、审批、导出、统计、Browser Use 和清理
  均校验设备归属，拿到他人的 `sessionId` 也不能读取或操作。

设备 Cookie 是长期刷新凭据，不等同于物理硬件认证。若业务需要账号级权限、跨设备同步
或审计到自然人，应在反向代理接入 OIDC / SSO，并把代理断言再映射为用户身份。

## 3. 反向代理要求

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

本机静默会话只在「TCP 对端是 loopback 且没有任何转发头」时启用。反向代理必须发送
`X-Forwarded-For`（并覆盖客户端伪造值）；否则同机代理会把公网请求伪装成本机请求。

## 4. Nginx

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

## 5. Caddy

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Caddy 自动管理 TLS。若需要对 `/metrics` 限制来源，在站点内增加 `@metrics` matcher 与 `remote_ip` 规则。

## 6. Prometheus 指标认证

生产环境浏览器会话是 HttpOnly Cookie，不适合作为 Prometheus 凭据。设置独立的 `METRICS_TOKEN`：

```yaml
scrape_configs:
  - job_name: agentatlas
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/agent-metrics-token
    static_configs:
      - targets: ["agent.example.com"]
    metrics_path: /metrics
```

该 token 只授权 `/metrics`，访问 `/api/*` 仍返回 401。轮换时先更新 Prometheus secret，再重启 Agent。

## 7. 数据边界

- `.env`、`production.env`、`.web-config.json`、`.setting/`、`data/` 不得进入 Git 或镜像。
- 生产数据卷权限建议 `0700` 目录、`0600` 敏感文件（以宿主操作系统能力为准）。
- 备份文件仍含加密后的供应商 Key；备份本身仍按敏感文件管理。
- `DATA_KEY` 不属于备份目录，需单独保存在密码管理器或 KMS。
- 浏览器只通过 HTTPS；在纯 HTTP 下生产 Cookie 不会被发送，登录表现为“成功后仍回到登录框”。

## 8. 安全变更规则

- 不关闭认证、CSP、同源检查和审批来“临时绕过”。
- 新增执行命令、写文件、发送消息或控制电脑的工具，必须在 `hitl.ts` 登记为高风险。
- 新增外部 URL 能力必须走统一 SSRF 校验。
- 新增日志字段必须经过脱敏 allowlist，不记录 prompt、工具正文、Cookie 或 Key。
