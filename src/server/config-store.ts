/**
 * ============================================================
 * config-store.ts — .web-config.json 的共享读写（原子 + 合并-写）
 * ============================================================
 * providers（settings.ts）、projects（projects.ts）、externalAgents
 * （external.ts）、rag 等共存于同一个文件。各方只走 mergeConfig({键:值})
 * 做局部合并，禁止整文件覆写。
 *
 * Phase 2（T2-1 可靠性）要点：
 * - 写入 = tmp 文件 + fsync + rename 原子替换（读端永远读到旧版或新版，
 *   不会读到半截 JSON）；
 * - 每次写入前把上一个完整版本滚动到 .web-config.json.bak，主文件损坏时
 *   自动从 .bak 抢救并回写；
 * - 跨进程顺从单写者：写前抢 .web-config.lock（O_EXCL 独占创建，PID+时间戳），
 *   孤儿锁按时间戳判定后接管 —— Web 与 Desktop 两个 server 进程并发写不互抹；
 * - schemaVersion 由本模块负责注入。
 *
 * 坑（1）：Windows rename 目标存在时 fs.rename 会 EPERM/ENOENT 抖动 ——
 *   统一「先 rollback 上一个 bak → rename」，失败重试一次。
 * 坑（2）：进程被硬杀后 lock 文件残留会卡死所有写入方 —— 必须按
 *   LOCK_STALE_MS 时间戳判定接管，不能只依赖 unlink。
 */
import { open, readFile, rename, writeFile, unlink, stat, copyFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 测试钩子：e2e 用临时配置文件（tests/helpers 注入 WEB_CONFIG_FILE），
// 避免测试读写开发者真实的 .web-config.json（含真实供应商 Key）。
export const SETTINGS_FILE = process.env.WEB_CONFIG_FILE
  || join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".web-config.json");

const BAK_FILE = SETTINGS_FILE + ".bak";
const TMP_FILE = SETTINGS_FILE + ".tmp";
const LOCK_FILE = SETTINGS_FILE + ".lock";
/** 当前配置 schema 版本：读取处一律兼容字段缺失，旧文件打开时注入 */
const SCHEMA_VERSION = 2;
/** lock 文件时间戳超过该时长视为孤儿锁（进程 crash 没释放），直接接管 */
const LOCK_STALE_MS = 15_000;
/** 抢不到锁时的轮询间隔 */
const LOCK_RETRY_MS = 25;

/** 读当前配置；损坏时自动尝试 .bak 抢救（回写主文件后返回备份内容） */
export async function readConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(SETTINGS_FILE, "utf8").catch(() => null);
  if (raw !== null) {
    try {
      return normalize(JSON.parse(raw));
    } catch {
      console.error(`[config] .web-config.json 损坏（JSON 解析失败），尝试从 .bak 恢复`);
    }
  }
  // 主文件缺失或损坏：尝试 .bak
  try {
    const bakRaw = await readFile(BAK_FILE, "utf8");
    const parsed = JSON.parse(bakRaw);
    if (parsed && typeof parsed === "object") {
      // 把抢救出来的内容原子回写为主文件（下次读直接命中）
      await atomicWrite(SETTINGS_FILE, JSON.stringify(parsed, null, 2));
      console.error(`[config] 已从 .web-config.json.bak 恢复配置；请核对管理页数据后重新登记缺失项`);
      return normalize(parsed);
    }
  } catch {
    // .bak 也没有 / 也坏：返回空配置，让各模块按缺省播种（与「删除文件回退 .env」一致）
    if (raw !== null) console.error(`[config] 主文件与 .bak 均不可解析，回退空配置（.env 播种仍生效）`);
  }
  return {};
}

function normalize(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const config = value as Record<string, unknown>;
  if (typeof config.schemaVersion !== "number") config.schemaVersion = SCHEMA_VERSION;
  return config;
}

// 进程内互斥：把所有写操作串成一个 promise 链（跨进程再靠文件锁）
let writeQueue: Promise<void> = Promise.resolve();

/** 只合并写入 patch 中给出的键，文件里其他键原样保留（原子 + 跨进程锁 + .bak 滚动） */
export async function mergeConfig(patch: Record<string, unknown>): Promise<void> {
  const run = writeQueue.then(runMerge);
  writeQueue = run.catch(() => {}); // 链上不允许出现未处理的 rejection
  await run;

  async function runMerge() {
    const config = await readConfig();
    Object.assign(config, patch);
    config.schemaVersion = SCHEMA_VERSION;
    const body = JSON.stringify(config, null, 2);
    await withConfigLock(async () => {
      // 滚动备份：写前保留上一份完整版本
      await copyFile(SETTINGS_FILE, BAK_FILE).catch(() => {
        /* 首次写入还没有主文件，无备份可滚动 */
      });
      await atomicWrite(SETTINGS_FILE, body);
    });
  }
}

/** tmp → fsync → rename 原子落盘；Windows 上 rename 抖动多试一次 */
async function atomicWrite(target: string, body: string): Promise<void> {
  const tmp = target + ".tmp";
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync(); // fsync：掉电也不留半截
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    await rename(tmp, target).catch(() => {
      throw err;
    });
  }
}

/**
 * 跨进程单写者：O_EXCL 独占创建 lock 文件（原子）；内容为 `pid|atMs`。
 * 简化决策：不给 pid 探活 —— Windows 上 process.kill(pid,0) 对「存在/不存在/没权限」
 * 一律 EPERM，语义不可靠。统一以 LOCK_STALE_MS 时间戳判定（正常 writer 的临界区
 * 里只有「读配置+写盘」毫秒级操作，15s 远超实际持锁时长；crah/断电后的孤儿锁 15s 内自愈）。
 */
async function withConfigLock(work: () => Promise<void>): Promise<void> {
  const release = await acquireLock();
  try {
    await work();
  } finally {
    await release();
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  const maxWaits = Math.ceil(LOCK_STALE_MS / LOCK_RETRY_MS); // 轮询到 stale 上限才强制接管
  let waits = 0;
  for (;;) {
    try {
      const handle = await open(LOCK_FILE, "wx");
      await handle.writeFile(`${process.pid}|${Date.now()}`, "utf8");
      await handle.close();
      return () => unlink(LOCK_FILE).catch(() => {});
    } catch (err) {
      const isExists = err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "EEXIST";
      if (!isExists) throw err;
      const raw = await readFile(LOCK_FILE, "utf8").catch(() => "");
      const atMs = Number(raw.split("|")[1]);
      const aged = !Number.isFinite(atMs) || Date.now() - atMs > LOCK_STALE_MS;
      if (aged || ++waits > maxWaits) {
        await unlink(LOCK_FILE).catch(() => {});
        continue; // 重抢
      }
      await new Promise((res) => setTimeout(res, LOCK_RETRY_MS));
    }
  }
}

/** 事件级审计兜底：audit.ts 之外，配置级变更可自行 append（可选，现阶段无调用方） */
export async function appendConfigLog(line: string): Promise<void> {
  await appendFile(SETTINGS_FILE + ".log", line + "\n", "utf8").catch(() => {});
}

/** 主文件最后修改时间（供健康检查/调试用） */
export async function configMtime(): Promise<number | null> {
  try {
    const s = await stat(SETTINGS_FILE);
    return s.mtimeMs;
  } catch {
    return null;
  }
}
