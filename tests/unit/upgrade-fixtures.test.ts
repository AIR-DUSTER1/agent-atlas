/**
 * ============================================================
 * upgrade-fixtures.test.ts — 上一版本真实形状 fixture 升级回归
 * ============================================================
 * 不构造“只符合当前代码”的对象，而是从 tests/fixtures/legacy 复制上一版
 * 配置与 journal 形状，验证升级后可读、schema 被补写、旧会话仍能回放。
 */
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();

test("上一版本配置 fixture 可迁移且敏感字段仍可读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-upgrade-config-"));
  const target = join(dir, "web-config.json");
  process.env.WEB_CONFIG_FILE = target;
  process.env.DATA_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    await copyFile(join(ROOT, "tests", "fixtures", "legacy", "v2-config.json"), target);
    const migrations = await import("../../src/server/persistence/migrations.js");
    const result = await migrations.runPersistenceMigrations();
    assert.deepEqual(result.config, { from: 2, to: 3, migrated: true });

    const store = await import("../../src/server/config-store.js");
    const config = await store.readConfig();
    const providers = config.providers as Array<{ apiKey?: string; baseURL?: string }>;
    assert.equal(providers[0]?.apiKey, "legacy-fixture-key");
    assert.match(providers[0]?.baseURL ?? "", /legacy\.example\.invalid/);
    const disk = await readFile(target, "utf8");
    assert.doesNotMatch(disk, /legacy-fixture-key/);
    assert.match(disk, /"schemaVersion":\s*3/);
  } finally {
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.DATA_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("上一版本 journal fixture 可回放并自动补 schema 头", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-upgrade-journal-"));
  const target = join(dir, "sessions.ndjson");
  process.env.SESSIONS_FILE = target;
  try {
    await copyFile(join(ROOT, "tests", "fixtures", "legacy", "v1-sessions.ndjson"), target);
    const store = await import("../../src/server/session-store.js");
    store.resetJournalStore();
    await store.replaySessions();
    const snapshot = store.journalSnapshot();
    const legacy = snapshot.find((item) => item.id === "legacy-session");
    assert.ok(legacy);
    assert.equal(legacy.title, "旧版会话");
    assert.equal(legacy.turns, 1);
    assert.equal(legacy.turnHistory[0]?.user, "旧版消息回放");
    assert.match(JSON.stringify(legacy.turnHistory[0]?.events), /旧版回答仍可读取/);
    const upgraded = await readFile(target, "utf8");
    assert.ok(upgraded.split("\n").some((line) => /"ev":"schema","schemaVersion":1/.test(line)));
  } finally {
    delete process.env.SESSIONS_FILE;
    storeCleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

function storeCleanup(): void {
  // 动态导入模块持有旧路径；进程退出前清空内存，避免污染同进程后续测试。
  void import("../../src/server/session-store.js").then((store) => store.resetJournalStore());
}
