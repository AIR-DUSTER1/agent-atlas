# CI 门禁命令块与交付证据清单

> 本文件是 `$agentatlas-release-ops` 的按需深入层：排查单个门禁失败或准备交付
> 证据时再读。`main` 合并的准入条件见 SKILL.md 发布红线，以 `AGENTS.md` §7.2 为权威。

## 门禁命令块（排查局部失败用，不能替代 ci:verify）

```bash
# main 合并前：单一入口复刻 GitHub CI
git fetch origin main
npm run ci:verify

# 仅排查局部失败时可单独运行
npm run skills:check
npm run version:check
VERSION_BASE_REF=origin/main npm run version:main-guard
npm run typecheck
npm run test:vue
npm test
npm run e2e
npm run image:smoke
```

CI 的三个 job（quality / e2e / image）与 `dependency-review` 是受保护分支的
required checks；PR 有合并冲突时 GitHub 不会创建 merge ref，pull_request workflow
完全静默——「CI 没动静」先查 mergeable 状态。

## 交付证据清单

- [ ] 版本号（package.json.version）与 buildId、commit SHA 三者对应。
- [ ] 镜像标签与 digest（固定 digest，禁止 `latest`）。
- [ ] 真实执行过的命令与结果（本地门禁输出或 CI run 链接），不只引用文档。
- [ ] 按发布影响补充：SBOM、覆盖率、备份恢复演练、镜像 smoke 记录。
- [ ] 版本或部署行为变化已同步 `.plans/development-docs/versioning.md`、部署文档
      与 `.plans/development-docs/readiness-snapshot.md`。
- [ ] 只完成代码改动而未发布时，明确说明「未 push、未 tag、未部署」。
