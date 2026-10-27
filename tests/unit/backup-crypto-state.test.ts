/** backup-crypto-state.test.ts — 备份 manifest 的密钥风险标记 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("备份 manifest 标记开发模式明文密钥风险", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-backup-secrets-"));
  const env = {
    SESSIONS_FILE: join(dir, "sessions.ndjson"),
    CHECKPOINT_FILE: join(dir, "checkpoints.ndjson"),
    MEMORIES_FILE: join(dir, "memories.json"),
    WEB_CONFIG_FILE: join(dir, "web-config.json"),
    AUDIT_FILE: join(dir, "audit.ndjson"),
    BACKUP_DIR: join(dir, "backups"),
  };
  Object.assign(process.env, env);
  try {
    await writeFile(env.SESSIONS_FILE, JSON.stringify({ ev: "schema", schemaVersion: 1 }) + "\n", "utf8");
    await writeFile(env.WEB_CONFIG_FILE, JSON.stringify({ schemaVersion: 3, providers: [{ apiKey: "plain-risk" }] }), "utf8");
    const backup = await import("../../src/server/backup.js");
    const created = await backup.createBackup();
    assert.equal(created.manifestVersion, 2);
    assert.equal(created.secrets, "plaintext-risk");
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    await rm(dir, { recursive: true, force: true });
  }
});
