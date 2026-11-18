/**
 * ============================================================
 * versioning.test.ts — 产品版本与构建身份规范守门
 * ============================================================
 * 覆盖 SemVer 规则、自动构建标识、HTML 注入以及仓库版本引用一致性。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collectMainMergeVersionIssues,
  collectVersioningIssues,
  compareReleaseVersions,
  createBuildInfo,
  injectBuildInfoHtml,
  parseReleaseVersion,
  readBuildInfoFile,
  readPackageVersion,
  validateBuildInfo,
} from "../../src/versioning.js";

test("版本规范：只接受 SemVer 与受控预发布渠道", () => {
  assert.deepEqual(parseReleaseVersion("0.7.0-beta.1"), {
    version: "0.7.0-beta.1",
    major: 0,
    minor: 7,
    patch: 0,
    prerelease: { stage: "beta", sequence: 1 },
    releaseStage: "beta",
  });
  assert.equal(parseReleaseVersion("0.7.0-rc.2").releaseStage, "rc");
  assert.equal(parseReleaseVersion("1.0.0").releaseStage, "stable");
  assert.throws(() => parseReleaseVersion("v0.7.0"), /SemVer/);
  assert.throws(() => parseReleaseVersion("0.7"), /SemVer/);
  assert.throws(() => parseReleaseVersion("0.7.0-preview.1"), /alpha/);
  assert.throws(() => parseReleaseVersion("0.7.0-beta.01"), /前导零/);
  assert.throws(() => parseReleaseVersion("0.7.0-beta.0"), /正整数/);
});

test("版本排序：预发布阶段、核心版本段与稳定版按 SemVer 排序", () => {
  assert.ok(compareReleaseVersions("0.7.0-beta.2", "0.7.0-beta.1") > 0);
  assert.ok(compareReleaseVersions("0.7.0-rc.1", "0.7.0-beta.9") > 0);
  assert.ok(compareReleaseVersions("0.7.0", "0.7.0-rc.9") > 0);
  assert.ok(compareReleaseVersions("0.7.1-beta.1", "0.7.0") > 0);
  assert.ok(compareReleaseVersions("0.8.0-alpha.1", "0.7.9") > 0);
  assert.ok(compareReleaseVersions("1.0.0", "0.99.0") > 0);
  assert.equal(compareReleaseVersions("0.7.0-beta.1+sha.one", "0.7.0-beta.1+sha.two"), 0);
});

test("main 合并门禁：beta 小步递增、alpha 隔离与新功能线晋级", () => {
  assert.deepEqual(collectMainMergeVersionIssues("0.7.0-beta.1", "0.7.0-beta.2"), []);
  assert.deepEqual(collectMainMergeVersionIssues("0.7.0-beta.1", "0.7.0-rc.1"), []);
  assert.deepEqual(collectMainMergeVersionIssues("0.7.0-beta.1", "0.7.1-beta.1"), []);
  assert.deepEqual(collectMainMergeVersionIssues("0.7.0-beta.1", "0.8.0-beta.1"), []);
  assert.deepEqual(collectMainMergeVersionIssues("0.7.0-rc.1", "0.7.0"), []);
  assert.match(collectMainMergeVersionIssues("0.7.0-beta.1", "0.7.0-beta.1").join("\n"), /必须提升/);
  assert.match(collectMainMergeVersionIssues("0.7.0-beta.1", "0.7.0-beta.3").join("\n"), /只能递增 1/);
  assert.match(collectMainMergeVersionIssues("0.7.0-beta.1", "0.7.0-alpha.2").join("\n"), /不接受 alpha/);
  assert.match(collectMainMergeVersionIssues("0.8.0", "0.7.9-beta.1").join("\n"), /必须提升/);
});

test("构建标识：版本、渠道、提交、时间与 buildId 自动派生", async () => {
  const info = await createBuildInfo({
    env: {
      RELEASE_CHANNEL: "beta",
      GIT_COMMIT: "12345678abcdef",
      BUILD_TIME: "2026-11-18T12:00:00.000Z",
    },
  });
  assert.equal(info.version, await readPackageVersion());
  assert.equal(info.channel, "beta");
  assert.equal(info.releaseStage, "beta");
  assert.equal(info.commit, "12345678abcdef");
  assert.equal(info.builtAt, "2026-11-18T12:00:00.000Z");
  assert.equal(info.buildId, "beta.20261118T120000Z.12345678");
});

test("构建身份：拒绝 buildId 与提交/时间不一致的伪造对象", () => {
  assert.throws(() => validateBuildInfo({
    version: "0.7.0-beta.1",
    channel: "dev",
    releaseStage: "beta",
    commit: "12345678",
    builtAt: "2026-11-18T12:00:00.000Z",
    buildId: "dev.20261118T120000Z.deadbeef",
  }), /buildId/);
});

test("HTML 构建身份：必须替换注入点且禁止遗留占位符", () => {
  const html = injectBuildInfoHtml("<head>\n  <!-- @build-info -->\n</head>", {
    version: "0.7.0-beta.1",
    channel: "dev",
    releaseStage: "beta",
    commit: "12345678",
    builtAt: "2026-11-18T12:00:00.000Z",
    buildId: "dev.20261118T120000Z.12345678",
  });
  assert.match(html, /name="agentatlas-version" content="0\.7\.0-beta\.1"/);
  assert.match(html, /name="agentatlas-build-id" content="dev\./);
  assert.doesNotMatch(html, /@build-info/);
});

test("仓库版本链：package、lock、文档与构建产物一致", async () => {
  assert.deepEqual(await collectVersioningIssues(), []);
  const info = await readBuildInfoFile();
  const html = await readFile("src/server/public/index.html", "utf8");
  assert.equal(info.version, await readPackageVersion());
  assert.match(html, new RegExp(`name="agentatlas-version" content="${info.version.replace(/\./g, "\\.")}"`));
  assert.match(html, new RegExp(`name="agentatlas-build-id" content="${info.buildId.replace(/\./g, "\\.")}"`));
});
