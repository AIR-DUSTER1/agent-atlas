# 升级与回滚

## 1. 发布约定

- 当前处于 `pre-1.0` 开发预览阶段，不创建正式 Git tag；镜像标签仅用于本地构建和演练。
- 正式发布时按不可变 digest 部署，不使用浮动 `latest`。
- 发布记录至少包含：app version、git commit、镜像 digest、SBOM SHA-256、备份名、操作者与时间。
- 发布记录至少包含：app version、git commit、镜像 digest、SBOM SHA-256、备份名、操作者与时间。

## 2. 升级前检查

```bash
npm run typecheck
npm test
npm run e2e
npm run coverage:security
npm run coverage:persistence
npm run coverage:routes
npm run audit:prod
npm run image:smoke
npm run sbom
```

发布机：

```bash
docker build \
  --build-arg APP_VERSION=0.9.0-beta.1 \
  --build-arg GIT_COMMIT=<commit> \
  --build-arg BUILD_TIME=<ISO-8601> \
  -t registry.example.com/agent-tools:0.9.0-beta.1 .
docker push registry.example.com/agent-tools:0.9.0-beta.1
```

记录 digest：

```bash
docker image inspect registry.example.com/agent-tools:0.9.0-beta.1 \
  --format '{{index .RepoDigests 0}}'
```

## 3. 升级步骤

1. 创建并校验备份。
2. 记录当前镜像 digest。
3. 更新 `production.env` 的 `AGENT_IMAGE` 为新 digest。
4. 拉取镜像。
5. 执行 `up -d`。
6. 检查健康、readiness、登录、历史会话和数据检查。

```bash
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent npm run backup
docker compose --env-file production.env -f docker-compose.production.yml pull
docker compose --env-file production.env -f docker-compose.production.yml up -d
docker compose --env-file production.env -f docker-compose.production.yml ps
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent npm run data:check
```

首次启动会自动执行 schema migration。未来版本数据会使旧程序 fail-closed，因此不能把“升级失败后直接换回旧镜像”当作无条件回滚。

## 4. 回滚决策

| 情况 | 操作 |
|---|---|
| 新镜像启动失败，尚未写新 schema | 换回上一 digest 即可 |
| 新镜像已迁移数据 schema | 停服，恢复升级前备份，再启动上一 digest |
| 新版本写入新 journal / checkpoint 后失败 | 必须恢复升级前完整备份，不能只换镜像 |
| 外部模型供应商故障 | 优先切换供应商，不执行版本回滚 |
| 只有前端资源异常但 API 正常 | 不进生产；在发布门修复后重新发版 |

## 5. 回滚步骤

```bash
docker compose --env-file production.env -f docker-compose.production.yml stop agent
```

把 `AGENT_IMAGE` 改回上一可用 digest，并恢复升级前备份：

```bash
docker compose --env-file production.env -f docker-compose.production.yml \
  run --rm --no-deps agent npm run restore -- --backup <升级前备份名>
docker compose --env-file production.env -f docker-compose.production.yml up -d
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent npm run data:check
```

回滚后确认：

- `/readyz` 200；
- 登录和旧会话可读；
- `schemaVersion` 与镜像支持范围一致；
- 审计、journal、checkpoint 均有新写入；
- 记录回滚原因并保留新版本日志。

## 6. 回滚演练要求

至少每季度演练一次：

1. 在隔离数据副本上启动新版本；
2. 写入一条测试会话；
3. 恢复升级前备份；
4. 启动上一 digest；
5. 校验旧会话、记忆、配置与备份清单。

没有演练证据的“可回滚”只能视为未验证假设。
