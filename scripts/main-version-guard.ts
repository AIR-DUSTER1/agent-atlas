/**
 * scripts/main-version-guard.ts — main 合并版本递增门禁
 * ============================================================
 * PR/推送进入 main 时比较当前 package 与基线提交，阻止 beta.N 不递增、
 * 版本回退或把 alpha 直接合入 main。基线通过 VERSION_BASE_REF 传入。
 */
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT, collectMainMergeVersionIssues, parseReleaseVersion, readPackageVersion } from "../src/versioning.js";

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function versionFromGit(ref: string): string {
  if (!REF_PATTERN.test(ref)) throw new Error(`VERSION_BASE_REF 非法：${ref}`);
  const raw = execFileSync("git", ["show", `${ref}:package.json`], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error(`基线 ${ref} 的 package.json 缺少 version`);
  parseReleaseVersion(pkg.version);
  return pkg.version;
}

async function main(): Promise<void> {
  const baseRef = process.env.VERSION_BASE_REF?.trim();
  if (!baseRef) {
    console.log("未设置 VERSION_BASE_REF，跳过 main 合并版本门禁（本地普通检查）");
    return;
  }
  const [baseVersion, nextVersion] = [versionFromGit(baseRef), await readPackageVersion()];
  const issues = collectMainMergeVersionIssues(baseVersion, nextVersion);
  if (issues.length) {
    for (const issue of issues) console.error(`✗ ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ main 版本递增合规：${baseVersion} → ${nextVersion}`);
}

void main().catch((error) => {
  console.error(`main 版本门禁失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});