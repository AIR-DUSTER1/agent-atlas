# 备份与恢复

## 1. 备份包含什么

生产数据默认位于容器 `/data`：

| 文件/目录 | 是否备份 | 说明 |
|---|---|---|
| `web-config.json` | 是 | 供应商、模型、插件配置；敏感字段为密文 |
| `sessions.ndjson` | 是 | 会话与逐轮 usage / 审批记录 |
| `checkpoints.ndjson` | 是 | LangGraph 多轮记忆 |
| `memories.json` | 是 | 跨会话长期记忆（schema v2，含 `general` / `estate` scope 与历史版本） |
| `skills/` | 是 | 用户技能 markdown |
| `audit.ndjson` + 归档 | 是 | 安全审计与 SHA-256 清单 |
| `backups/` | 否（本身） | 备份根，不应递归备份自己 |

备份 v2 manifest 记录：

- 文件相对路径、字节数与 SHA-256；
- schemaVersion（其中 `memories.json` 当前为 2）；
- 创建时间；
- 是否包含密文；
- 保留策略执行结果。

## 2. 创建备份

容器内：

```bash
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent npm run backup
```

等价底层命令：

```bash
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent node --import tsx scripts/data-cli.ts backup
```

自定义输出目录只在需要挂载额外卷时使用；默认写入 `/data/backups`。

保留策略：

```env
BACKUP_KEEP_LATEST=7
BACKUP_KEEP_DAYS=7
```

含义是保留最近 7 份，并保留最近 7 个自然日每天最后一份。策略不会替代异机副本。

## 3. 异机与离线副本

至少每天把新备份复制到不同故障域：

```powershell
robocopy .\data\backups \\backup-host\agent-backups /MIR /R:2 /W:2
```

Linux：

```bash
rsync -a --delete data/backups/ backup-host:/srv/backups/agent/
```

要求：

- 备份目标有独立访问控制；
- 传输链路加密；
- 定期从离线副本实际恢复，而不是只检查“文件存在”；
- 备份保留期与合规要求一致。

## 4. 校验

```bash
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent npm run data:check
```

它会检查配置 schema、journal、checkpoint、备份 manifest 与哈希。任何失败返回非 0。

## 5. 恢复

恢复会覆盖运行数据，必须先停机：

```bash
docker compose --env-file production.env -f docker-compose.production.yml stop agent
```

执行恢复：

```bash
docker compose --env-file production.env -f docker-compose.production.yml \
  run --rm --no-deps agent npm run restore -- --backup <备份名>
```

恢复逻辑会先创建当前状态自动快照；manifest、SHA-256 或 schema 校验失败时拒绝覆盖。

重新启动：

```bash
docker compose --env-file production.env -f docker-compose.production.yml up -d
docker compose --env-file production.env -f docker-compose.production.yml \
  exec agent npm run data:check
```

验证：

- `/readyz` 为 200；
- 旧会话列表和 transcript 可读；
- 多轮记忆可继续；长期记忆设置页能看到正确的 scope、active 与历史条数；v1 备份首次加载会自动升级；
- 配置供应商与模型正确；
- 审计追加没有断档；
- 新写入后再创建一份备份。

## 6. 灾难恢复顺序

1. 准备同版本镜像和正确 `DATA_KEY`。
2. 恢复最近一份通过校验的备份。
3. 启动服务并运行 `data:check`。
4. 检查会话、记忆、配置与审计。
5. 在安全位置创建恢复后的新基线备份。
6. 记录恢复耗时、备份名、镜像 digest 和异常。

> 记忆导入 / 导出的 JSON 快照不是整机备份；它只覆盖当前 scope，整机灾难恢复仍应使用 `npm run backup`。\n>\n> 如果 `DATA_KEY` 丢失，密文配置无法解密。此时只能恢复旧的未加密备份，或在开发模式重建配置；不要把丢失的 Key 替换成新 Key 后直接覆盖生产数据卷。
