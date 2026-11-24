# PostgreSQL 多用户与 RLS

> 适用版本：`0.9.0-beta.20` 开发预览
> 状态：单实例应用 + PostgreSQL 多用户数据面。默认文件后端仍保留，桌面端和本地开发不需要数据库。

## 1. 能力边界

启用 `STATE_BACKEND=postgres` 后：

- 每个真实用户有独立 `userId`（`users.id`）
- 会话 journal、LangGraph checkpoint、项目目录和用户设置都带 `user_id`（历史磁盘 journal 行沿用 `ownerId` 键，见 `session-store.ts` 序列化边界说明）
- 业务查询在事务内设置 `app.user_id`，由 PostgreSQL RLS 做第二道隔离
- 普通用户只能访问自己的会话、项目、checkpoint 和记忆 scope
- 全局供应商、插件、MCP、技能、备份与诊断接口只允许管理员操作

当前仍**不是多实例高可用**：SSE 连接、限流、内存会话缓存和同会话流锁仍在单个进程内。数据库已经为后续多实例提供持久化基础，但滚动多副本之前还需要共享会话查询、分布式锁和对象存储迁移。

## 2. 角色模型

生产必须使用两个数据库连接：

| 连接 | 角色 | 用途 |
|---|---|---|
| `DATABASE_ADMIN_URL` | 表 owner / migration 角色 | 建表、迁移、bootstrap、用户令牌查询 |
| `DATABASE_URL` | `agent_app` | 业务运行；必须 `NOSUPERUSER NOBYPASSRLS`，不能拥有业务表 |

如果 `DATABASE_URL` 使用表 owner 或 superuser，PostgreSQL 会绕过 RLS。
`/readyz` 能证明数据库可连接，但不能替代角色权限审计；上线前必须人工确认：

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'agent_app';
-- rolsuper=false, rolbypassrls=false
```

## 3. 环境变量

```env
STATE_BACKEND=postgres
DATABASE_URL=postgresql://agent_app:APP_PASSWORD@postgres:5432/agentatlas
DATABASE_ADMIN_URL=postgresql://agent:ADMIN_PASSWORD@postgres:5432/agentatlas
DATABASE_POOL_MAX=10
DATABASE_SSL=disable
BOOTSTRAP_ADMIN_NAME=管理员

AUTH_TOKEN=至少16位随机管理员引导密钥
SESSION_SECRET=至少32位随机会话/设备签名密钥
DATA_KEY=32字节base64密钥
```

托管 PostgreSQL 使用 `DATABASE_SSL=require`。密码包含 `@`、`:`、`/` 等字符时必须做 URL 编码。

## 4. 启动方式

### 4.1 使用同机 PostgreSQL

准备 `production.env` 后，叠加 PostgreSQL compose：

```bash
docker compose \
  --env-file production.env \
  -f docker-compose.production.yml \
  -f docker-compose.postgres.yml \
  up -d
```

叠加层会启动 `postgres` 服务，并在首次建库时执行 `scripts/postgres-init.sh` 创建 `agent_app` 低权限角色和默认权限。

还需要在 `production.env` 中提供：

```env
POSTGRES_IMAGE=postgres:16-alpine@sha256:<固定digest>
POSTGRES_DB=agentatlas
POSTGRES_ADMIN_USER=agent
POSTGRES_ADMIN_PASSWORD=至少32位随机密码
POSTGRES_APP_PASSWORD=至少32位随机密码
```

### 4.2 使用外部 PostgreSQL

1. 准备一个独立数据库。
2. 用管理员角色执行 `npm run db:migrate`。
3. 创建 `agent_app` 角色，授予 schema/table/sequence 权限，并确保 `NOBYPASSRLS`。
4. 在生产 env 中填写两个 URL 后启动应用。

应用启动时也会幂等执行 migration；生产仍建议在发布流水线显式执行并记录结果。

## 5. 创建和管理用户

管理员引导完成后，普通用户使用独立访问令牌。创建用户：

```bash
STATE_BACKEND=postgres \
DATABASE_URL=... \
DATABASE_ADMIN_URL=... \
npm run user:create -- --name "Alice" --email alice@example.com
```

命令只输出一次 `accessToken`。请通过安全渠道交给用户；不要写入日志、README 或提交记录。

日常用户管理在 Web「设置 → 账号与安全」（仅管理员可见）：创建用户（用户名 + 初始密码）、禁用/启用、重置密码、软删除、访问令牌管理。用户用「用户名 + 密码」登录，首登或密码被重置后强制修改；修改密码会使该用户全部会话与设备免登失效。连续 10 次登录失败锁定 15 分钟。`AUTH_TOKEN` 只用于管理员 bootstrap 与运维通道，不能作为普通用户令牌分发。

## 6. 数据模型与 RLS

| 表 | 内容 | RLS |
|---|---|---|
| `session_journal_events` | 会话、轮次、审批、压缩事件 | 是 |
| `checkpoint_rows` / `checkpoint_writes` | LangGraph 持久检查点 | 是 |
| `projects` | 用户项目路径和云端仓库 | 是 |
| `user_settings` | 当前用户设置（如 active project） | 是 |
| `memories` | 预留的 PostgreSQL 记忆投影 | 是 |
| `users` / `auth_tokens` / `devices` | 账号与设备绑定 | 由认证层保护 |
| `audit_events` | 审计事件 | 是 |

## 7. 备份与恢复

数据库备份和 `/data` 文件备份必须同时做：

```bash
docker compose --env-file production.env \
  -f docker-compose.production.yml \
  -f docker-compose.postgres.yml \
  exec -T postgres pg_dump -U agent -d agentatlas -Fc -f /tmp/agentatlas.dump
```

将 dump 复制到应用容器/宿主机安全目录，并与 `DATA_KEY` 分开保存。备份恢复前必须停止应用写请求：

```bash
docker compose ... stop agent
pg_restore -U agent -d agentatlas --clean --if-exists -Fc agentatlas.dump
docker compose ... up -d
docker compose ... exec -T agent npm run data:check
```

生产建议使用 PostgreSQL PITR 或托管数据库自动备份，而不是只依赖应用内 `npm run backup`；应用内备份只覆盖 `/data` 文件。

## 8. 升级与回滚

1. 升级前执行数据库 dump 和应用数据备份（迁移 002 会把 `owner_id` 列改名为 `user_id` 并重建 RLS 策略，同时为 `users` 表增补登录列 `username` / `password_hash` / `must_change_password` / `credential_epoch`）。
2. 固定新镜像 digest，执行 `db:migrate`（启动时也会自动执行）。
3. 检查 `/healthz`、`/readyz`、`/api/version`、旧会话读取和跨用户 404。
4. 运行 `npm run test:postgres` 和质量门。

如果新版本已经写入新 schema，不能只把镜像换回旧版；必须恢复升级前数据库 dump，再启动旧 digest。

## 9. 验收清单

- [ ] `agent_app` 是 `NOSUPERUSER NOBYPASSRLS`
- [ ] `STATE_BACKEND=postgres` 且 `/readyz` 包含 `database: true`
- [ ] 用户 A 的 sessionId 在用户 B 下返回 404
- [ ] 用户 A 不能修改全局供应商、插件、MCP、技能或备份
- [ ] 项目目录在用户之间不可见
- [ ] checkpoint 跨重启可恢复
- [ ] 数据库备份与应用 `/data` 备份都通过恢复演练