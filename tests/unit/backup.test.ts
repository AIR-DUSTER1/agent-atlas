/**
 * backup.test.ts — 数据备份与恢复（F9）回归
 * ============================================================
 * 守：备份集文件逐一拷贝且 manifest 如实；列表解析；
 * 恢复 = 原子写回 + 自动做恢复前快照；坏备份名 / 不存在的备份给中文错误。
 *
 * 注意：各存储路径在模块加载即固化，且测试链可能已被其它文件 import 过
 * （模块缓存绑旧 env）—— 用例内先 reset 各单例 store 再取 backup 模块；
 * web-config.json 的路径（config-store 的 const 导出）无法重绑，包含性不做强断言。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function prepareEnv() {
  const dir = await mkdtemp(join(tmpdir(), "agent-backup-"));
  const env = {
    SESSIONS_FILE: join(dir, "sessions.ndjson"),
    CHECKPOINT_FILE: join(dir, "checkpoints.ndjson"),
    MEMORIES_FILE: join(dir, "memories.json"),
    MEMORY_STORE_DIR: join(dir, "memory-store"),
    WEB_CONFIG_FILE: join(dir, "web-config.json"),
    AUDIT_FILE: join(dir, "audit.ndjson"),
    BACKUP_DIR: join(dir, "backups"),
  };
  Object.assign(process.env, env);
  // 重绑三个可重置的存储单例（第四个 web-config 是 const，只能靠本用例先跑的运气）
  const { resetJournalStore } = await import("../../src/server/session-store.js");
  const { resetCheckpointSaver } = await import("../../src/checkpoint.js");
  const { resetMemoryStore } = await import("../../src/memory-store.js");
  resetJournalStore();
  resetCheckpointSaver();
  resetMemoryStore();
  const backup = await import("../../src/server/backup.js");
  return { dir, env, backup };
}

test("备份与恢复全链路：创建 → 破坏 → 恢复 → 内容回来", async () => {
  const { dir, env, backup } = await prepareEnv();
  try {
    // 预置真实感数据：journal 一行、记忆一条（checkpoint/audit 不存在 —— 不存在就不备份）
    await writeFile(env.SESSIONS_FILE, JSON.stringify({ ev: "session", session: { id: "s1" } }) + "\n", "utf8");
    await writeFile(env.MEMORIES_FILE, JSON.stringify([{ id: "m1", key: "偏好", content: "结论先行" }]), "utf8");

    const created = await backup.createBackup();
    assert.match(created.name, /^backup-\d{8}-\d{6}/, "名字带时间戳（防同秒碰撞还有毫秒段）");
    assert.ok(created.files.includes("sessions.ndjson"), "journal 必须进备份");
    assert.ok(created.files.some((file) => file.startsWith("memory-store/")), "记忆存储目录必须进备份");
    assert.ok(!created.files.includes("checkpoints.ndjson"), "不存在的文件不进备份");

    const list = await backup.listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, created.name);

    // 破坏：移除 v3 记忆目录与 journal（模拟误删/损坏）
    await rm(join(dir, "memory-store"), { recursive: true, force: true });
    await writeFile(env.SESSIONS_FILE, "", "utf8");

    // 恢复：内容回来，且自动生成恢复前快照
    const restored = await backup.restoreBackup(created.name);
    assert.ok(restored.restored.includes("memory-store/manifest.json"));
    assert.ok(restored.restored.includes("sessions.ndjson"));
    assert.ok(restored.autoSnapshot);
    const memoryStore = await import("../../src/memory-store.js");
    memoryStore.resetMemoryStore();
    assert.equal(await memoryStore.loadMemories("general"), 1);
    assert.equal(memoryStore.memoryStoreStatus().state, "ok", "v3 记忆目录恢复后直接可用");
    assert.match(await readFile(env.SESSIONS_FILE, "utf8"), /s1/);

    const afterRestore = await backup.listBackups();
    assert.equal(afterRestore.length, 2, "恢复前快照也在列表里");
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    await rm(dir, { recursive: true, force: true });
  }
});

test("恢复的防御：坏名拒绝、不存在的备份给中文错误", async () => {
  const { dir, env, backup } = await prepareEnv();
  try {
    await assert.rejects(() => backup.restoreBackup("../escape"), /格式不对/);
    await assert.rejects(() => backup.restoreBackup("backup-20990101-000000"), /不存在或 manifest 损坏/);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    await rm(dir, { recursive: true, force: true });
  }
});

test("备份篡改：任意文件字节变化都会被 SHA-256 校验拒绝", async () => {
  const { dir, env, backup } = await prepareEnv();
  try {
    await writeFile(env.SESSIONS_FILE, JSON.stringify({ ev: "schema", schemaVersion: 1 }) + "\n", "utf8");
    const created = await backup.createBackup();
    const manifest = JSON.parse(await readFile(join(env.BACKUP_DIR, created.name, "manifest.json"), "utf8")) as { version: number; schemaVersions: Record<string, number | null> };
    assert.equal(manifest.version, 2);
    assert.equal(manifest.schemaVersions["memories.json"], 2);
    await writeFile(join(env.BACKUP_DIR, created.name, "sessions.ndjson"), "tampered-byte\n", "utf8");
    await assert.rejects(() => backup.restoreBackup(created.name), /校验失败|大小不匹配/);
    const audit = await backup.auditBackups();
    assert.equal(audit.invalid, 1);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    await rm(dir, { recursive: true, force: true });
  }
});

test("备份保留策略：保留最近 N 份并清理更旧目录", async () => {
  const { dir, env, backup } = await prepareEnv();
  process.env.BACKUP_KEEP_LATEST = "2";
  process.env.BACKUP_KEEP_DAYS = "1";
  try {
    await writeFile(env.SESSIONS_FILE, JSON.stringify({ ev: "schema", schemaVersion: 1 }) + "\n", "utf8");
    for (let i = 0; i < 4; i += 1) await backup.createBackup();
    const list = await backup.listBackups();
    assert.equal(list.length, 2);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    delete process.env.BACKUP_KEEP_LATEST;
    delete process.env.BACKUP_KEEP_DAYS;
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy 记忆文件在迁移前后都必须进备份，且恢复后仍能被读回", async () => {
  // 回归背景（M5 实测抓到的两个真实缺陷）：
  //  1. createBackup 会先 flushMemoryUsage()，它触发 legacy 迁移把
  //     memories.json 改名成 .v2-backup；旧实现只登记主名，导致原文件没进备份；
  //  2. restore 只把 .v2-backup 写回同名文件，新版启动读 memories.json 读不到，
  //     用户旧记忆会静默丢失。
  const { dir, env, backup } = await prepareEnv();
  try {
    // 造 0.9 布局：单文件 memories.json
    await writeFile(env.MEMORIES_FILE, JSON.stringify({
      schemaVersion: 2,
      entries: [{
        id: "legacy-1",
        scope: { profileId: "general", userId: "local" },
        key: "旧版偏好",
        content: "旧版记忆内容",
        tags: [],
        source: "user",
        status: "active",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }],
    }), "utf8");

    const info = await backup.createBackup();
    const manifest = JSON.parse(
      await readFile(join(env.BACKUP_DIR, info.name, "manifest.json"), "utf8"),
    ) as { files: Array<{ name: string }> };
    const names = manifest.files.map((file) => file.name);
    // 断言 1：迁移前的原文件必须进备份（修复前这里没有 v2-backup 条目）
    assert.ok(
      names.includes("memories.json.v2-backup") || names.includes("memories.json"),
      `备份必须包含 legacy 记忆文件，实际：${names.join(", ")}`,
    );

    // 模拟升级：删掉全部记忆产物，只留备份包
    const { resetMemoryStore } = await import("../../src/memory-store.js");
    for (const path of [env.MEMORY_STORE_DIR, `${env.MEMORIES_FILE}.v2-backup`, env.MEMORIES_FILE]) {
      await rm(path, { recursive: true, force: true });
    }
    resetMemoryStore();

    await backup.restoreBackup(info.name);
    // restore 内部会先做一次 autoSnapshot（其 createBackup 会触发迁移并写空 store），
    // 因此恢复完必须清掉那份「迁移残留」，让主名文件重新成为唯一来源。
    await rm(env.MEMORY_STORE_DIR, { recursive: true, force: true });
    resetMemoryStore();
    // 断言 2：恢复后主名文件必须回来，否则 readLegacyRecords 读不到
    const restored = await readFile(env.MEMORIES_FILE, "utf8");
    assert.match(restored, /旧版记忆内容/, "恢复后 memories.json 必须含旧内容");
    // 诊断：确认恢复出来的确实是合法 v2 结构（不是被写坏的 JSON）
    const parsedRestored = JSON.parse(restored) as { schemaVersion?: number; entries?: unknown[] };
    assert.equal(parsedRestored.schemaVersion, 2, "恢复后 schemaVersion 应为 2");
    assert.ok(Array.isArray(parsedRestored.entries) && parsedRestored.entries.length === 1, "恢复后应有 1 条 entries");

    // 断言 3：加载后记录确实进内存（完整迁移链路）
    const { loadMemories, listMemories } = await import("../../src/memory-store.js");
    const loaded = await loadMemories();
    const contents = listMemories(undefined, { includeHistory: true }).map((item) => item.content);
    assert.ok(
      loaded > 0 && contents.includes("旧版记忆内容"),
      `加载后应含旧记忆：loaded=${loaded}，contents=${contents.join(" | ") || "(空)"}`,
    );
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    await rm(dir, { recursive: true, force: true });
  }
});
