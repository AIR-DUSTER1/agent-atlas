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
  collectVersioningIssues,
  createBuildInfo,
  injectBuildInfoHtml,
  parseReleaseVersion,
  readBuildInfoFile,
  validateBuildInfo,
} from "../../src/versioning.js";

test("版本规范：只接受 SemVer 与受控预发布渠道", () => {
  assert.deepEqual(parseReleaseVersion("0.7.0-beta.1"), { version: "0.7.0-beta.1", releaseStage: "beta" });
  assert.equal(parseReleaseVersion("0.7.0-rc.2").releaseStage, "rc");
  assert.equal(parseReleaseVersion("1.0.0").releaseStage, "stable");
  assert.throws(() => parseReleaseVersion("v0.7.0"), /SemVer/);
  assert.throws(() => parseReleaseVersion("0.7"), /SemVer/);
  assert.throws(() => parseReleaseVersion("0.7.0-preview.1"), /alpha/);
  assert.throws(() => parseReleaseVersion("0.7.0-beta.01"), /前导零/);
});

test("构建标识：版本、渠道、提交、时间与 buildId 自动派生", async () => {
  const info = await createBuildInfo({
    env: {
      RELEASE_CHANNEL: "beta",
      GIT_COMMIT: "12345678abcdef",
      BUILD_TIME: "2026-11-18T12:00:00.000Z",
    },
  });
  assert.equal(info.version, "0.7.0-beta.1");
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
  assert.equal(info.version, "0.7.0-beta.1");
  assert.match(html, new RegExp(`name="agentatlas-version" content="${info.version.replace(/\./g, "\\.")}"`));
  assert.match(html, new RegExp(`name="agentatlas-build-id" content="${info.buildId.replace(/\./g, "\\.")}"`));
});
