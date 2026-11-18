# 版本规范

> 当前开发版本：`0.9.0-beta.17`
> 状态：pre-1.0 开发预览
> 最后更新：2026-11-18

本规范采用 SemVer 2.0，并结合当前项目 pre-1.0 的发布节奏定义 alpha / beta / rc 阶段。
产品版本、构建标识、API 版本和数据 schema 版本必须分开管理。

## 1. 四类版本

| 类型 | 格式 | 当前示例 | 用途 |
|---|---|---|---|
| 产品版本 | `MAJOR.MINOR.PATCH[-alpha.N\|beta.N\|rc.N]` | `0.9.0-beta.17` | 功能、兼容性与测试阶段 |
| 构建标识 | `channel.timestamp.commit` | `dev.20261118T120000Z.816ba5c` | 定位精确产物 |
| API 版本 | `/api/v1` | 当前仍为 `/api` | 外部 HTTP 契约 |
| 数据 schema | 整数版本 | config `3`、memory `3`、PostgreSQL `1` | 存储迁移 |

产品版本不得代替构建号、缓存刷新号或数据库 schema 版本。

## 2. 版本号决策矩阵

### 2.1 pre-1.0（当前阶段）

| 变更性质 | 版本动作 | 示例 |
|---|---|---|
| 在 beta 阶段合入 main 的小步更新 | 保持 core 不变，递增 `beta.N` | `0.7.0-beta.1` → `0.7.0-beta.2` |
| 同一功能线的小功能点或兼容修复 | 递增 `0.7.PATCH`，需要对外测试时从 `beta.1` 开始 | `0.7.0` → `0.7.1-beta.1` |
| 新增一组大功能，或可能产生破坏性变化 | 递增 `0.MINOR.0`，重新开始预发布序列 | `0.7.0` → `0.8.0-alpha.1` |
| 1.0 之后的主版本更新 | 递增 `X.0.0` | `1.4.2` → `2.0.0` |

因此：

- `0.7.x` 表示 **0.7 功能线内的小功能点/修复迭代**；
- `0.x.0` 表示 **新的大功能组，可能包含破坏性调整**；
- `1.0.0` 及之后的 `x.0.0` 才表示正式主版本升级；
- `0.x` 阶段仍属于开发预览，不提供 1.0 的稳定兼容承诺。

### 2.2 1.0 之后

| 变更性质 | 版本动作 | 示例 |
|---|---|---|
| 向后兼容的缺陷修复 | `PATCH + 1` | `1.4.2` → `1.4.3` |
| 向后兼容的新功能 | `MINOR + 1`，`PATCH` 归零 | `1.4.2` → `1.5.0` |
| 不兼容的 API、行为或数据结构变化 | `MAJOR + 1`，`MINOR/PATCH` 归零 | `1.5.0` → `2.0.0` |

## 3. 测试阶段

alpha、beta、rc 是**测试成熟度**，不是功能大小的替代名称。

| 阶段 | 使用范围 | 合并策略 | 允许内容 |
|---|---|---|---|
| `alpha.N` | `dev` 分支、内部构建、开发自测 | 不直接合入 `main` | 功能开发、接口调整、探索性修复 |
| `beta.N` | `main`、外部试用、集成验证 | 每次 `main` 小步合并递增 N | 已通过基本质量门、仍需外部验证的功能 |
| `rc.N` | 发布候选、功能冻结 | 每次 `main` 只接受阻断发布的问题修复 | 不再新增功能，只修复阻断项 |
| 无后缀 | 稳定版本 | 只在 rc 验收通过后发布 | 对外承诺兼容性 |

推荐流转：

```text
0.8.0-alpha.1
      ↓ 内部功能收敛
0.8.0-beta.1
      ↓ 每次合入 main 递增
0.8.0-beta.2 → 0.8.0-beta.3
      ↓ 功能冻结
0.8.0-rc.1
      ↓ 阻断项修复
0.8.0

同一 0.7 功能线的小功能点可以：

0.7.0
  ↓
0.7.1-beta.1
  ↓
0.7.1
```

`main` 不接受 `alpha.N`。alpha 版本留在 `dev` 或内部测试环境，进入 `main` 前必须先推进到
`beta.N`（或更高的 `rc.N` / 稳定版）。

## 4. main 合并规则

从本规范开始，**每次合并到 main 都必须提升产品版本**，不能复用 main 上已有的版本号。

```text
main 基线:  0.9.0-beta.16
合并分支:   0.9.0-beta.17  ✓
合并分支:   0.9.0-beta.16  ✗ 版本未提升
合并分支:   0.9.0-beta.18  ✗ beta 序号跳号
合并分支:   0.9.0-alpha.2  ✗ alpha 不能直接进入 main
```

规则：

1. 同一 core 的 beta/rc 线路每次 `main` 合并只能递增 1；
2. 新功能线可以从 `0.7.1-beta.1`、`0.8.0-beta.1` 重新开始；
3. beta 可以晋级到同 core 的 rc 或稳定版；
4. 版本回退或复用会让 CI 失败，必须修复版本号而不是绕过门禁；
5. GitHub `main` 分支保护应把 `Main merge version advance` 设为必需检查。

## 5. 构建标识

构建标识不参与产品版本排序，只用于定位产物：

```json
{
  "version": "0.9.0-beta.17",
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

## 6. 单一版本源

`package.json.version` 是唯一产品版本源。禁止手工维护前端日期版本。

构建过程会：

1. 读取 `package.json.version`；
2. 读取 `GIT_COMMIT`、`BUILD_TIME` 和 `RELEASE_CHANNEL`；
3. 生成 `src/server/public/build-info.json`；
4. 将同一份信息注入前端 HTML meta；
5. 供健康探针、诊断、日志和前端错误上报复用。

页面展示格式：

```text
0.9.0-beta.17 · 816ba5c
```

运行接口：

```text
GET /healthz        # 版本、渠道、提交、buildId、运行时长
GET /readyz         # 就绪状态与完整构建身份
GET /api/version    # 需要登录的完整构建信息
```

## 7. 版本更新流程

普通开发提交不修改产品版本。准备合入 `main` 时，在 `dev` 先完成版本提升：

```bash
# beta 阶段的小步更新：0.9.0-beta.16 -> 0.9.0-beta.17
npm version 0.9.0-beta.17 --no-git-tag-version

# 同一 0.7 功能线的小功能点
npm version 0.7.1-beta.1 --no-git-tag-version

# 新的大功能组或可能破坏兼容性的变化
npm version 0.8.0-alpha.1 --no-git-tag-version
```

然后同步 README、部署文档中的当前版本引用并执行：

```bash
npm run version:check
VERSION_BASE_REF=origin/main npm run version:main-guard
```

PowerShell：

```powershell
$env:VERSION_BASE_REF = "origin/main"
npm run version:main-guard
Remove-Item Env:VERSION_BASE_REF
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

当前阶段不创建 Git tag。达到正式发布条件后，只对通过完整验收的提交创建注解 tag：

```text
v0.9.0-beta.17
```

规则：

- tag 必须等于 `v` + `package.json.version`；
- 不移动、不覆盖已发布 tag；
- 一个 tag 必须对应完整质量门与发布记录；
- 文档和镜像标签必须与 package 版本一致。

## 8. 容器镜像

镜像标签分为可读标签和不可变定位：

```text
registry.example.com/agentatlas:0.9.0-beta.17
registry.example.com/agentatlas:sha-816ba5c
registry.example.com/agentatlas:beta
```

生产部署必须固定 digest：

```text
registry.example.com/agentatlas@sha256:<digest>
```

禁止生产环境使用 `latest` 或浮动渠道标签。

## 9. 兼容性边界

- API 路径和请求/响应契约独立版本化。
- 配置、journal、checkpoint、memory schema 独立版本化。
- 数据迁移必须兼容旧字段，未来 schema 必须 fail-closed。
- 预发布版本可以改变 schema，但升级前必须备份并验证回滚。
- `1.0.0` 之后，产品版本才提供完整 SemVer 兼容承诺。

## 10. 自动检查

```bash
npm run version:check
npm run version:main-guard
```

检查范围：

- `package.json` 与 `package-lock.json` 一致；
- README 版本徽章一致；
- 路线图、readiness、部署和回滚文档标记当前版本；
- 已生成的 build-info 与 package 一致；
- 版本格式和预发布渠道合法；
- PR/推送进入 main 时版本严格递增；
- main 不接受 alpha，beta/rc 不跳号或复用。

构建、测试或发布流程若发现版本不一致，必须修复而不是绕过检查。
