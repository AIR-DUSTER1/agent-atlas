/**
 * ============================================================
 * persistence/migrations.ts — JSON 持久化版本迁移入口
 * ============================================================
 * 配置版本在启动加载前检查：旧版本原地迁移，未来版本拒绝启动。
 * NDJSON 的逐行版本由 ndjson-health 在回放阶段校验。
 */
import { readFile } from "node:fs/promises";
import { CONFIG_SCHEMA_VERSION, SETTINGS_FILE, mergeConfig } from "../config-store.js";
import { PersistenceVersionError } from "./ndjson-health.js";

export interface MigrationResult {
  config: { from: number; to: number; migrated: boolean };
}

/** 启动前调用；只迁移当前程序能理解的版本，任何未来版本 fail-closed。 */
export async function runPersistenceMigrations(): Promise<MigrationResult> {
  const raw = await readFile(SETTINGS_FILE, "utf8").catch(() => null);
  if (raw === null) {
    return { config: { from: CONFIG_SCHEMA_VERSION, to: CONFIG_SCHEMA_VERSION, migrated: false } };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 语法损坏交给 config-store 的 .bak 抢救；这里不覆盖任何原始字节。
    return { config: { from: 0, to: CONFIG_SCHEMA_VERSION, migrated: false } };
  }
  const version = typeof parsed.schemaVersion === "number" && Number.isInteger(parsed.schemaVersion)
    ? parsed.schemaVersion
    : 2;
  if (version > CONFIG_SCHEMA_VERSION) {
    throw new PersistenceVersionError(SETTINGS_FILE, version, CONFIG_SCHEMA_VERSION);
  }
  if (version < CONFIG_SCHEMA_VERSION) {
    await mergeConfig({});
    return { config: { from: version, to: CONFIG_SCHEMA_VERSION, migrated: true } };
  }
  return { config: { from: version, to: CONFIG_SCHEMA_VERSION, migrated: false } };
}
