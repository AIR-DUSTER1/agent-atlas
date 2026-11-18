# 版本规范

> 当前开发版本：`0.7.0-beta.1`
> 状态：pre-1.0 开发预览
> 最后更新：2026-11-18

本规范采用 SemVer 2.0。产品版本与构建标识、API 版本、数据 schema 版本必须分开管理。

## 1. 四类版本

| 类型 | 格式 | 当前示例 | 用途 |
|---|---|---|---|
| 产品版本 | `MAJOR.MINOR.PATCH[-alpha.N\|beta.N\|rc.N]` | `0.7.0-beta.1` | 功能与兼容性 |
| 构建标识 | `channel.timestamp.commit` | `dev.20261118T120000Z.816ba5c` | 定位精确产物 |
| API 版本 | `/api/v1` | 当前仍为 `/api` | 外部 HTTP 契约 |
| 数据 schema | 整数版本 | config `3`、memory `3` | 存储迁移 |

产品版本不得代替构建号、缓存刷新号或数据库 schema 版本。

## 2. 产品版本

- `0.x`：开发预览阶段，接口和交互仍可能变化。
- `MINOR`：增加功能；进入 `1.0.0` 前允许包含不兼容调整。
- `PATCH`：只做向后兼容的 bug 和稳定性修复。
- `alpha.N`：内部实验版本。
- `beta.N`：可供外部试用的预览版本。
- `rc.N`：功能冻结，只允许阻断发布的问题修复。
- 无预发布后缀：稳定版本。

预发布段只接受：

```text
-alpha.N
-beta.N
-rc.N
```

N 必须是无前导零的正整数。禁止使用 `preview`、`nightly`、日期等自定义预发布渠道。

## 3. 构建标识

构建标识不参与产品版本排序，只用于定位产物：

```json
{
  "version": "0.7.0-beta.1",
  "channel": "dev",
  "releaseStage": "beta",
  "commit": "816ba5c3",
  "builtAt": "2026-11-18T06:25:00.000Z",
  "buildId": "dev.20261118T062500Z.816ba5c"
}
```

渠道允许：

```text
dev / alpha / beta / rc / stable
```

本地开发默认 `dev`。正式预发布或稳定构建通过 `RELEASE_CHANNEL` 指定。

## 4. 单一版本源

`package.json.version` 是唯一产品版本源。

禁止手工维护前端日期版本。构建过程会：

1. 读取 `package.json.version`；
2. 读取 `GIT_COMMIT`、`BUILD_TIME` 和 `RELEASE_CHANNEL`；
3. 生成 `src/server/public/build-info.json`；
4. 将同一份信息注入前端 HTML meta；
5. 供健康探针、诊断、日志和前端错误上报复用。

页面展示格式：

```text
0.7.0-beta.1 · 816ba5c
```

运行接口：

```text
GET /healthz        # 版本、渠道、提交、buildId、运行时长
GET /readyz         # 就绪状态与完整构建身份
GET /api/version    # 需要登录的完整构建信息
```

## 5. 版本更新流程

普通开发提交不修改产品版本。只在形成可发布基线时更新：

```bash
npm version 0.7.0-beta.2 --no-git-tag-version
npm run version:check
npm run build:client
```

发布前必须通过：

```bash
npm run typecheck
npm run build:client
npm run build:desktop
npm test
npm run e2e
npm run audit:prod
```

当前阶段不创建 Git tag。达到发布条件后，只对通过验收的发布提交创建注解 tag：

```text
v0.7.0-beta.1
```

规则：

- tag 必须等于 `v` + `package.json.version`；
- 不移动、不覆盖已发布 tag；
- 一个 tag 必须对应完整质量门与发布记录；
- 文档和镜像标签必须与 package 版本一致。

## 6. 容器镜像

镜像标签分为可读标签和不可变定位：

```text
registry.example.com/agentatlas:0.7.0-beta.1
registry.example.com/agentatlas:sha-816ba5c
registry.example.com/agentatlas:beta
```

生产部署必须固定 digest：

```text
registry.example.com/agentatlas@sha256:<digest>
```

禁止生产环境使用 `latest` 或浮动渠道标签。

## 7. 兼容性边界

- API 路径和请求/响应契约独立版本化。
- 配置、journal、checkpoint、memory schema 独立版本化。
- 数据迁移必须兼容旧字段，未来 schema 必须 fail-closed。
- 预发布版本可以改变 schema，但升级前必须备份并验证回滚。
- `1.0.0` 之后，产品版本才提供完整 SemVer 兼容承诺。

## 8. 自动检查

```bash
npm run version:check
```

检查范围：

- `package.json` 与 `package-lock.json` 一致；
- README 版本徽章一致；
- 路线图、readiness、部署和回滚文档标记当前版本；
- 已生成的 build-info 与 package 一致；
- 版本格式和预发布渠道合法。

构建、测试或发布流程若发现版本不一致，必须修复而不是绕过检查。
