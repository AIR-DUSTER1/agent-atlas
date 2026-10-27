/**
 * ============================================================
 * data-cli.ts — 数据备份 / 恢复 / 健康检查命令
 * ============================================================
 * 用法：
 *   npm run backup -- --output <backup-root>
 *   npm run restore -- --backup <backup-name|manifest.json>
 *   npm run data:check
 * 不启动 HTTP、不调用模型；restore 后必须重启服务才能刷新内存态。
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { CONFIG_SCHEMA_VERSION, SETTINGS_FILE } from "../src/server/config-store.js";
import { checkpointFilePath, CHECKPOINT_SCHEMA_VERSION } from "../src/checkpoint.js";
import { JOURNAL_SCHEMA_VERSION, journalPath } from "../src/server/session-store.js";
import { inspectNdjson } from "../src/server/persistence/ndjson-health.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function backupName(raw: string): string {
  const path = resolve(raw);
  if (raw.endsWith("manifest.json")) return basename(dirname(path));
  if (raw.includes("/") || raw.includes("\\")) return basename(path);
  return raw;
}

async function create(): Promise<void> {
  const output = argValue("--output");
  if (output) process.env.BACKUP_DIR = resolve(output);
  const keepLatest = argValue("--keep-latest");
  const keepDays = argValue("--keep-days");
  if (keepLatest) process.env.BACKUP_KEEP_LATEST = keepLatest;
  if (keepDays) process.env.BACKUP_KEEP_DAYS = keepDays;
  const { createBackup, backupRoot } = await import("../src/server/backup.js");
  const info = await createBackup();
  console.log(`备份完成：${info.name}`);
  console.log(`目录：${resolve(backupRoot(), info.name)}`);
  console.log(`文件：${info.files.join(", ") || "无"}`);
  console.log(`密钥状态：${info.secrets}`);
}

async function restore(): Promise<void> {
  const raw = argValue("--backup");
  if (!raw) throw new Error("缺少 --backup <备份名或 manifest.json 路径>");
  if (raw.includes("/") || raw.includes("\\")) {
    const absolute = resolve(raw);
    process.env.BACKUP_DIR = raw.endsWith("manifest.json") ? dirname(dirname(absolute)) : dirname(absolute);
  }
  const { restoreBackup } = await import("../src/server/backup.js");
  const result = await restoreBackup(backupName(raw));
  console.log(`恢复完成：${result.restored.join(", ")}`);
  console.log(`恢复前自动快照：${result.autoSnapshot}`);
  console.log("请重启服务，让配置 / journal / checkpoint 内存态重新加载。");
}

async function check(): Promise<void> {
  const failures: string[] = [];
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as { schemaVersion?: unknown };
    const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 2;
    if (version > CONFIG_SCHEMA_VERSION) failures.push(`配置版本 ${version} 高于当前 ${CONFIG_SCHEMA_VERSION}`);
    else console.log(`PASS 配置文件 schemaVersion=${version}`);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (missing) console.log("PASS 配置文件尚未创建（将使用 .env 默认值）");
    else failures.push(`配置 JSON 无法读取：${(err as Error).message}`);
  }

  const journal = await inspectNdjson(journalPath(), {
    currentVersion: JOURNAL_SCHEMA_VERSION,
    markerKey: "ev",
    repair: false,
  });
  console.log(`${journal.report.badLines ? "FAIL" : "PASS"} journal：${journal.report.validLines}/${journal.report.totalLines} 行有效，版本 ${journal.report.schemaVersion}`);
  if (journal.report.badLines) failures.push(`journal 有 ${journal.report.badLines} 行损坏（启动时会隔离到 .corrupt）`);

  const checkpoint = await inspectNdjson(checkpointFilePath(), {
    currentVersion: CHECKPOINT_SCHEMA_VERSION,
    markerKey: "type",
    repair: false,
  });
  console.log(`${checkpoint.report.badLines ? "FAIL" : "PASS"} checkpoint：${checkpoint.report.validLines}/${checkpoint.report.totalLines} 行有效，版本 ${checkpoint.report.schemaVersion}`);
  if (checkpoint.report.badLines) failures.push(`checkpoint 有 ${checkpoint.report.badLines} 行损坏`);

  const { auditBackups } = await import("../src/server/backup.js");
  const backups = await auditBackups();
  console.log(`${backups.invalid ? "FAIL" : "PASS"} 备份：${backups.valid}/${backups.total} 份通过校验`);
  for (const issue of backups.issues) failures.push(`${issue.name}：${issue.reason}`);

  if (failures.length) {
    console.error("\n数据检查未通过：");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("\n数据检查通过");
  }
}

const command = process.argv[2];
const run = command === "backup" ? create : command === "restore" ? restore : command === "check" ? check : null;
if (!run) {
  console.error("用法：data-cli.ts <backup|restore|check> [选项]");
  process.exitCode = 2;
} else {
  void run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
