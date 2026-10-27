/** persistence-migrations.test.ts — schema 迁移、坏行隔离与未来版本拒绝 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  inspectNdjson, PersistenceVersionError,
} from "../../src/server/persistence/ndjson-health.js";

test("NDJSON：坏行进入 .corrupt，合法行保留且健康报告准确", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ndjson-"));
  const file = join(dir, "journal.ndjson");
  try {
    await writeFile(file, [
      JSON.stringify({ ev: "schema", schemaVersion: 1 }),
      JSON.stringify({ ev: "session", session: { id: "ok-1" } }),
      "{ broken json",
      JSON.stringify({ ev: "session", session: { id: "ok-2" } }),
    ].join("\n") + "\n", "utf8");

    const result = await inspectNdjson(file, { currentVersion: 1, markerKey: "ev", repair: true });
    assert.equal(result.report.badLines, 1);
    assert.equal(result.report.quarantined, 1);
    assert.equal(result.report.schemaHeaderFound, true);
    assert.equal(result.lines.length, 3);
    assert.match(await readFile(file, "utf8"), /ok-1/);
    assert.match(await readFile(file + ".corrupt", "utf8"), /broken json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NDJSON：未来 schemaVersion 拒绝启动且不重写文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ndjson-future-"));
  const file = join(dir, "checkpoints.ndjson");
  try {
    const body = JSON.stringify({ type: "schema", schemaVersion: 99 }) + "\n";
    await writeFile(file, body, "utf8");
    await assert.rejects(
      () => inspectNdjson(file, { currentVersion: 1, markerKey: "type", repair: true }),
      (err) => err instanceof PersistenceVersionError && /回滚/.test(err.message)
    );
    assert.equal(await readFile(file, "utf8"), body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧配置在启动迁移中升级 schema 并保持敏感字段可用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-migrate-"));
  const file = join(dir, "web-config.json");
  process.env.WEB_CONFIG_FILE = file;
  process.env.DATA_KEY = Buffer.alloc(32, 5).toString("base64");
  try {
    await writeFile(file, JSON.stringify({
      schemaVersion: 2,
      providers: [{ id: "p1", name: "旧供应商", baseURL: "https://api.example.com", apiKey: "old-key", models: [] }],
    }), "utf8");
    const migrations = await import("../../src/server/persistence/migrations.js");
    const result = await migrations.runPersistenceMigrations();
    assert.deepEqual(result.config, { from: 2, to: 3, migrated: true });
    const store = await import("../../src/server/config-store.js");
    const loaded = await store.readConfig();
    assert.equal(loaded.schemaVersion, 3);
    assert.equal((loaded.providers as Array<{ apiKey?: string }>)[0].apiKey, "old-key");
    assert.doesNotMatch(await readFile(file, "utf8"), /old-key/);
  } finally {
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.DATA_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});
