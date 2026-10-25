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
    assert.ok(created.files.includes("memories.json"), "记忆必须进备份");
    assert.ok(!created.files.includes("checkpoints.ndjson"), "不存在的文件不进备份");

    const list = await backup.listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, created.name);

    // 破坏：把记忆与 journal 改坏（模拟误删/损坏）
    await writeFile(env.MEMORIES_FILE, "[]", "utf8");
    await writeFile(env.SESSIONS_FILE, "", "utf8");

    // 恢复：内容回来，且自动生成恢复前快照
    const restored = await backup.restoreBackup(created.name);
    assert.ok(restored.restored.includes("memories.json"));
    assert.ok(restored.restored.includes("sessions.ndjson"));
    assert.ok(restored.autoSnapshot);
    assert.match(await readFile(env.MEMORIES_FILE, "utf8"), /结论先行/);
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
