/** audit-rotation.test.ts — 审计归档、哈希清单与健康报告 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("审计超过阈值后轮转为归档并记录 SHA-256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-audit-"));
  process.env.AUDIT_FILE = join(dir, "audit.ndjson");
  process.env.AUDIT_MAX_BYTES = "64000";
  process.env.AUDIT_KEEP_DAYS = "30";
  process.env.AUDIT_KEEP_ARCHIVES = "5";
  try {
    const audit = await import("../../src/server/audit.js");
    audit.resetAuditStateForTests();
    audit.writeAudit("test.large", { payload: "x".repeat(70_000) });
    await audit.flushAudit();
    const files = await readdir(dir);
    const archives = files.filter((name) => /^audit-.*\.ndjson$/.test(name));
    assert.equal(archives.length, 1);
    assert.ok(await readFile(join(dir, "audit.ndjson"), "utf8").then((text) => text.length === 0));
    const archive = await readFile(join(dir, archives[0]));
    const manifest = JSON.parse(await readFile(join(dir, "audit-archives.json"), "utf8")) as Array<{ name: string; size: number; sha256: string }>;
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].size, archive.byteLength);
    assert.equal(manifest[0].sha256, createHash("sha256").update(archive).digest("hex"));
    const health = await audit.auditHealthReport();
    assert.equal(health.archives, 1);
    assert.equal(health.lastError, null);
    assert.equal((await audit.auditArchivePaths()).length, 1);
  } finally {
    delete process.env.AUDIT_FILE;
    delete process.env.AUDIT_MAX_BYTES;
    delete process.env.AUDIT_KEEP_DAYS;
    delete process.env.AUDIT_KEEP_ARCHIVES;
    await rm(dir, { recursive: true, force: true });
  }
});
