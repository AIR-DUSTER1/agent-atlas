/**
 * job-selectors.ts — 招聘站点 DOM 选择器的单一真源与本地覆盖层
 * ============================================================
 * 默认候选链在 job-selectors.json；真实页面验证过的候选只写入求职数据目录的
 * selectors.json，不修改源码。字段命中统计用于区分“后备选择器命中”与“结构变更”。
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_PLATFORMS, type JobPlatform } from "./job-model.js";

const REGISTRY_FILE = "selectors.json";
const REGISTRY_VERSION = 1;
const DEFAULT_REGISTRY_PATH = fileURLToPath(new URL("./job-selectors.json", import.meta.url));

type SelectorMap = Record<string, string[]>;

export interface LearnedJobSelector {
  at: string;
  platform: JobPlatform;
  key: string;
  old: string[];
  new: string[];
  evidence: Record<string, unknown>;
}

export interface JobSelectorRegistryData {
  version: number;
  platforms: Record<JobPlatform, SelectorMap>;
  unsupported_fields: Partial<Record<JobPlatform, string[]>>;
  learned: LearnedJobSelector[];
}

export interface JobSelectorHitStats {
  hit: number;
  miss: number;
  fallback: number;
  fallbackBy: string;
}

export interface JobSelectorFallback {
  platform: JobPlatform;
  key: string;
  primary: string;
  used: string;
  count: number;
}

export interface JobSelectorRuntime {
  readonly data: JobSelectorRegistryData;
  readonly source: "default" | "override";
  readonly warning: string;
  candidates(platform: JobPlatform, key: string): string[];
  primary(platform: JobPlatform, key: string): string;
  unsupportedFields(platform: JobPlatform): Set<string>;
  describe(platform: JobPlatform): Record<string, string>;
  recordHit(platform: JobPlatform, key: string, hit: boolean, used?: string): void;
  fallbacks(): JobSelectorFallback[];
  overrideInMemory(platform: JobPlatform, key: string, chain: readonly string[]): void;
}

function cloneRegistry(data: JobSelectorRegistryData): JobSelectorRegistryData {
  return {
    version: data.version,
    platforms: Object.fromEntries(JOB_PLATFORMS.map((platform) => [
      platform,
      Object.fromEntries(Object.entries(data.platforms[platform] ?? {}).map(([key, chain]) => [key, [...chain]])),
    ])) as Record<JobPlatform, SelectorMap>,
    unsupported_fields: Object.fromEntries(Object.entries(data.unsupported_fields).map(([platform, fields]) => [platform, [...fields]])),
    learned: data.learned.map((entry) => ({ ...entry, old: [...entry.old], new: [...entry.new], evidence: { ...entry.evidence } })),
  };
}

function normalizeChain(value: unknown): string[] | null {
  if (typeof value === "string") return value.trim() ? [value.trim()] : null;
  if (!Array.isArray(value)) return null;
  const chain = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  return chain.length ? chain : null;
}

function parseRegistry(raw: unknown): JobSelectorRegistryData | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const platformInput = value.platforms;
  if (!platformInput || typeof platformInput !== "object") return null;
  const platforms = {} as Record<JobPlatform, SelectorMap>;
  for (const platform of JOB_PLATFORMS) {
    const fieldsValue = (platformInput as Record<string, unknown>)[platform];
    if (!fieldsValue || typeof fieldsValue !== "object") continue;
    const fields: SelectorMap = {};
    for (const [key, chainValue] of Object.entries(fieldsValue as Record<string, unknown>)) {
      const chain = normalizeChain(chainValue);
      if (chain) fields[key] = chain;
    }
    if (Object.keys(fields).length) platforms[platform] = fields;
  }
  const unsupported: Partial<Record<JobPlatform, string[]>> = {};
  if (value.unsupported_fields && typeof value.unsupported_fields === "object") {
    for (const platform of JOB_PLATFORMS) {
      const fields = (value.unsupported_fields as Record<string, unknown>)[platform];
      if (Array.isArray(fields)) unsupported[platform] = fields.filter((item): item is string => typeof item === "string");
    }
  }
  const learned = Array.isArray(value.learned)
    ? value.learned.filter((entry): entry is LearnedJobSelector => Boolean(entry) && typeof entry === "object" && typeof (entry as LearnedJobSelector).platform === "string")
    : [];
  return { version: REGISTRY_VERSION, platforms, unsupported_fields: unsupported, learned };
}

function mergeRegistry(base: JobSelectorRegistryData, extra: JobSelectorRegistryData): JobSelectorRegistryData {
  const merged = cloneRegistry(base);
  for (const platform of JOB_PLATFORMS) {
    if (extra.platforms[platform]) merged.platforms[platform] = { ...merged.platforms[platform], ...extra.platforms[platform] };
    if (extra.unsupported_fields[platform]) merged.unsupported_fields[platform] = [...extra.unsupported_fields[platform]!];
  }
  merged.learned.push(...extra.learned);
  return merged;
}

async function readRegistryFile(path: string): Promise<JobSelectorRegistryData> {
  const parsed = parseRegistry(JSON.parse(await fsp.readFile(path, "utf8")) as unknown);
  if (!parsed) throw new Error(`选择器注册表缺少有效 platforms 段：${path}`);
  return parsed;
}

function candidatesFrom(data: JobSelectorRegistryData, platform: JobPlatform, key: string): string[] {
  return data.platforms[platform]?.[key] ?? [];
}

/** 创建一次任务使用的注册表快照；临时自愈只改快照，不污染长期配置。 */
export function createJobSelectorRuntime(
  data: JobSelectorRegistryData,
  source: "default" | "override" = "default",
  warning = "",
): JobSelectorRuntime {
  const mutable = cloneRegistry(data);
  const stats = new Map<JobPlatform, Map<string, JobSelectorHitStats>>();
  const recordHit = (platform: JobPlatform, key: string, hit: boolean, used = ""): void => {
    const platformStats = stats.get(platform) ?? new Map<string, JobSelectorHitStats>();
    stats.set(platform, platformStats);
    const slot = platformStats.get(key) ?? { hit: 0, miss: 0, fallback: 0, fallbackBy: "" };
    platformStats.set(key, slot);
    if (!hit) {
      slot.miss += 1;
      return;
    }
    slot.hit += 1;
    if (used && used !== candidatesFrom(mutable, platform, key)[0]) {
      slot.fallback += 1;
      slot.fallbackBy = used;
    }
  };
  return {
    data: mutable,
    source,
    warning,
    candidates: (platform, key) => [...candidatesFrom(mutable, platform, key)],
    primary: (platform, key) => candidatesFrom(mutable, platform, key)[0] ?? "",
    unsupportedFields: (platform) => new Set(mutable.unsupported_fields[platform] ?? []),
    describe: (platform) => Object.fromEntries(Object.entries(mutable.platforms[platform] ?? {}).map(([key, chain]) => [key, chain[0] ?? ""])),
    recordHit,
    fallbacks: () => {
      const output: JobSelectorFallback[] = [];
      for (const [platform, fields] of stats) {
        for (const [key, value] of fields) {
          if (!value.fallback) continue;
          output.push({
            platform,
            key,
            primary: candidatesFrom(mutable, platform, key)[0] ?? "",
            used: value.fallbackBy,
            count: value.fallback,
          });
        }
      }
      return output;
    },
    overrideInMemory: (platform, key, chain) => {
      const normalized = chain.map((item) => item.trim()).filter(Boolean);
      if (!normalized.length) return;
      mutable.platforms[platform][key] = normalized;
      if (platform === "zhilian" && key === "card") {
        mutable.platforms.zhilian.vue_host = normalized.map((item) => item.startsWith("css:") ? item.slice(4) : item);
      }
    },
  };
}

/** 载入默认注册表与数据目录覆盖；覆盖损坏时降级默认值并给出警告。 */
export async function loadJobSelectorRuntime(dataDir: string): Promise<JobSelectorRuntime> {
  const defaults = await readRegistryFile(DEFAULT_REGISTRY_PATH);
  const localPath = join(dataDir, REGISTRY_FILE);
  try {
    const override = await readRegistryFile(localPath);
    return createJobSelectorRuntime(mergeRegistry(defaults, override), "override");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return createJobSelectorRuntime(defaults);
    return createJobSelectorRuntime(
      defaults,
      "default",
      `本地选择器覆盖读取失败，已使用内置默认值：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readLocalOverride(dataDir: string): Promise<JobSelectorRegistryData> {
  try {
    return await readRegistryFile(join(dataDir, REGISTRY_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: REGISTRY_VERSION, platforms: {} as Record<JobPlatform, SelectorMap>, unsupported_fields: {}, learned: [] };
    }
    throw new Error(`本地选择器覆盖文件损坏：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 把真实页面验证通过的候选固化到本地覆盖层，旧候选保留为回退链。 */
export async function applyJobSelector(
  dataDir: string,
  platform: JobPlatform,
  key: string,
  selector: string,
  evidence: Record<string, unknown> = {},
): Promise<{ path: string; old: string[]; next: string[] }> {
  const defaults = await readRegistryFile(DEFAULT_REGISTRY_PATH);
  const existing = await readLocalOverride(dataDir);
  const current = mergeRegistry(defaults, existing);
  const old = [...candidatesFrom(current, platform, key)];
  const next = [selector, ...old.filter((item) => item !== selector)];
  const payload: JobSelectorRegistryData = {
    version: REGISTRY_VERSION,
    platforms: { ...existing.platforms, [platform]: { ...(existing.platforms[platform] ?? {}), [key]: next } },
    unsupported_fields: existing.unsupported_fields,
    learned: [...existing.learned, {
      at: new Date().toISOString(),
      platform,
      key,
      old,
      new: next,
      evidence,
    }],
  };
  if (platform === "zhilian" && key === "card") {
    payload.platforms.zhilian = {
      ...(payload.platforms.zhilian ?? {}),
      vue_host: next.map((item) => item.startsWith("css:") ? item.slice(4) : item),
    };
  }
  await fsp.mkdir(dataDir, { recursive: true });
  const path = join(dataDir, REGISTRY_FILE);
  try { await fsp.copyFile(path, `${path}.bak`); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const temp = join(dataDir, `.selectors-${process.pid}-${Date.now()}.tmp`);
  await fsp.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.rename(temp, path);
  return { path, old, next };
}

export { REGISTRY_FILE as JOB_SELECTOR_FILE };
