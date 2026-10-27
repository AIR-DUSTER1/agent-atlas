/**
 * ============================================================
 * persistence/ndjson-health.ts — NDJSON 版本守门与坏行隔离
 * ============================================================
 * 启动回放前扫描行级格式：合法行保留，坏行复制到 `.corrupt` 后从主文件剔除；
 * 发现高于当前版本的数据直接拒绝启动，避免旧程序写坏新格式。
 */
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";

export class PersistenceVersionError extends Error {
  constructor(file: string, found: number, current: number) {
    super(`${file} 的数据版本为 ${found}，当前程序只支持到 ${current}；请回滚到匹配版本，禁止继续写入`);
    this.name = "PersistenceVersionError";
  }
}

export interface NdjsonHealthReport {
  file: string;
  exists: boolean;
  schemaVersion: number;
  schemaHeaderFound: boolean;
  totalLines: number;
  validLines: number;
  badLines: number;
  sizeBytes: number;
  quarantined: number;
  checkedAt: number;
}

interface InspectOptions {
  currentVersion: number;
  markerKey: "ev" | "type";
  repair?: boolean;
}

const reports = new Map<string, NdjsonHealthReport>();

export function latestNdjsonHealth(file: string): NdjsonHealthReport | null {
  return reports.get(file) ?? null;
}

function schemaVersionOf(value: Record<string, unknown>, markerKey: "ev" | "type"): number | null {
  if (value[markerKey] !== "schema") return null;
  return typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion)
    ? value.schemaVersion
    : -1;
}

/**
 * 扫描并（可选）修复一个 NDJSON 文件。坏行先追加进 `.corrupt`，再用临时文件
 * 原子替换主文件；任一步失败时保留原文件，不把错误静默吞掉。
 */
export async function inspectNdjson(file: string, options: InspectOptions): Promise<{ report: NdjsonHealthReport; lines: string[] }> {
  const st = await stat(file).catch(() => null);
  if (!st) {
    const report: NdjsonHealthReport = {
      file, exists: false, schemaVersion: options.currentVersion, schemaHeaderFound: false,
      totalLines: 0, validLines: 0, badLines: 0, sizeBytes: 0, quarantined: 0, checkedAt: Date.now(),
    };
    reports.set(file, report);
    return { report, lines: [] };
  }

  const raw = await readFile(file, "utf8");
  const good: string[] = [];
  const bad: Array<{ lineNumber: number; raw: string }> = [];
  let schemaVersion = 1;
  let schemaHeaderFound = false;
  let totalLines = 0;

  for (const [index, rawLine] of raw.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    totalLines += 1;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const found = schemaVersionOf(parsed, options.markerKey);
      if (found !== null) {
        if (found < 1) throw new Error("schemaVersion 非法");
        if (!schemaHeaderFound) schemaVersion = found;
        schemaHeaderFound = true;
      }
      good.push(line);
    } catch {
      bad.push({ lineNumber: index + 1, raw: rawLine });
    }
  }

  if (schemaVersion > options.currentVersion) {
    throw new PersistenceVersionError(file, schemaVersion, options.currentVersion);
  }

  let quarantined = 0;
  if (bad.length && options.repair !== false) {
    const corruptFile = `${file}.corrupt`;
    const payload = bad.map((item) => JSON.stringify({
      ts: new Date().toISOString(), source: file, lineNumber: item.lineNumber, raw: item.raw,
    })).join("\n") + "\n";
    await appendFile(corruptFile, payload, "utf8");
    const tmp = `${file}.health.tmp`;
    await writeFile(tmp, good.length ? good.join("\n") + "\n" : "", "utf8");
    await rename(tmp, file);
    quarantined = bad.length;
  }

  const report: NdjsonHealthReport = {
    file,
    exists: true,
    schemaVersion,
    schemaHeaderFound,
    totalLines,
    validLines: good.length,
    badLines: bad.length,
    sizeBytes: st.size,
    quarantined,
    checkedAt: Date.now(),
  };
  reports.set(file, report);
  return { report, lines: good };
}

/** 新文件或旧文件补一行 schema 头；已有头时 no-op。 */
export async function ensureNdjsonSchemaHeader(
  file: string,
  report: NdjsonHealthReport,
  markerKey: "ev" | "type",
  currentVersion: number,
): Promise<void> {
  if (report.schemaHeaderFound) return;
  const header = markerKey === "ev"
    ? { ts: Date.now(), ev: "schema", schemaVersion: currentVersion }
    : { ts: Date.now(), type: "schema", schemaVersion: currentVersion };
  await appendFile(file, JSON.stringify(header) + "\n", "utf8");
  report.schemaHeaderFound = true;
  report.schemaVersion = currentVersion;
  report.exists = true;
  report.sizeBytes = (await stat(file)).size;
}
