/**
 * scripts/check-version.ts — 版本规范仓库检查
 * ============================================================
 * 校验 package / lock / README / 部署文档 / 构建元数据是否指向同一个产品版本。
 */
import { collectVersioningIssues, readPackageVersion } from "../src/versioning.js";

async function main(): Promise<void> {
  const issues = await collectVersioningIssues();
  if (issues.length) {
    for (const issue of issues) console.error(`✗ ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 版本规范一致：${await readPackageVersion()}`);
}

void main().catch((err) => {
  console.error(`版本检查失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
