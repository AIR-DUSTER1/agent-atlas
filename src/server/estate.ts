/**
 * ============================================================
 * estate.ts — 贝壳找房能力接入（官方 beike CLI 客户端）+ 区位 geocode
 * ============================================================
 * 设计定位：房源检索 / 详情 / 户型图 / 板块评测 / 行情等 C 端找房数据
 * 全部委托给贝壳官方的 `beike` CLI（LianjiaTech/beike-ai-platform，
 * 输出单行 JSON，支持 win32-x64）。本模块是 CLI 的子进程客户端：
 *   - 检测（PATH / .setting/beike 自装目录）— version 探测
 *   - 安装（GitHub release 下载 tar.gz → Windows 自带 tar.exe 解压 →
 *     定位 beike.exe → 校验 sha256 → 写入 .web-config.json 的 estate 键）
 *   - 鉴权（beike auth <KEY> --save；Key 由 CLI 保存到 ~/.beike，
 *     本工作台**不落盘不回显**——遵循贝壳官方技能的凭证规范）
 *   - 每轮「用户需求分析」上报（beike analyze，贝壳官方契约；
 *     fire-and-forget，失败绝不阻塞回答）
 *
 * 地图：地址 → 坐标用 Nominatim（OSM 免费无 key，限 1 req/s → 串行队列 +
 * 内存缓存）；坐标 + 无 key 的 OSM embed / 高德·腾讯·百度 marker 直链
 * 一起交给前端渲染（前端零依赖：iframe + 链接，无 npm 包无构建）。
 *
 * ⚠ 58 房产开放平台经调研只提供 B 端管理 API（发房 / 房源管理），
 *   无 C 端找房检索接口且授权需企业渠道，本期不接入（用户已确认）。
 */
import { runControlled } from "./subprocess.js";
import { promises as fsp, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readConfig, mergeConfig } from "./config-store.js";
import { writeAudit } from "./audit.js";
import { runWithLimit } from "./limits.js";
import { log } from "./logging.js";

/** 贝壳 CLI 资源桶（T2-5）：查询 + 后台 analyze 共用，2 并发上限 */
const BEIKE_CLI_BUCKET = "beike-cli";
const BEIKE_CLI_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// 常量（限量即上限）
// ---------------------------------------------------------------------------
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** CLI 自装目录：项目根/.setting/beike（与 external.ts 的 .setting 惯例一致） */
export const BEIKE_DIR = join(MODULE_DIR, "..", "..", ".setting", "beike");
const BEIKE_MANIFEST_URL =
  "https://raw.githubusercontent.com/LianjiaTech/beike-ai-platform/master/cli/releases/manifest.json";
const BEIKE_KEY_URL = "https://building.ke.com/?action=get-key&source=beike_skill";

const BEIKE_RUN_TIMEOUT_MS = 90_000;      // 单条 beike 子进程最长执行时间
const BEIKE_ANALYZE_TIMEOUT_MS = 20_000;  // 每轮需求上报的兜底退出时间
const BEIKE_INSTALL_TIMEOUT_MS = 600_000; // 整个安装流程（下载 ~32MB + 解压）
const MANIFEST_TIMEOUT_MS = 30_000;
const KEY_AUTH_TIMEOUT_MS = 30_000;

/**
 * 安装链路可信来源 host 白名单（T1-6）：manifest 与二进制都必须是 HTTPS 且
 * host 命中列表 —— manifest 被 MITM/篡改后给出的任意 host 不再下载执行。
 */
const INSTALL_URL_HOST_ALLOW = new Set([
  "raw.githubusercontent.com", "objects.githubusercontent.com", "github.com", "codeload.github.com",
]);

/** 下载/解压 URL 的信任校验：HTTPS + host 白名单（导出供注入式测试使用） */
export function assertTrustedInstallUrl(u: string, what: string): void {
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new Error(`${what} 不是合法 URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${what} 必须是 HTTPS（当前 ${parsed.protocol}）`);
  if (!INSTALL_URL_HOST_ALLOW.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${what} 的来源不在官方白名单（${parsed.hostname}）`);
  }
}

const GEOCODE_TIMEOUT_MS = 8_000;         // 单次 Nominatim 请求
const GEOCODE_MIN_INTERVAL_MS = 1_100;    // 公开服务限约 1 req/s，排队串行
const GEOCODE_CACHE_MAX = 200;            // 地址 → 坐标缓存上限
const GEOCODE_MAX_ITEMS = 6;              // 单次地图对比最多同时定位几个点

const MAX_RESULT_CHARS = 26_000;          // 工具结果({"model 读)的字符上限，超出截断并标注
const NOMINATIM_UA = "langgraph-agent-workbench/1.0 (local learning project)";

// ---------------------------------------------------------------------------
// 配置（.web-config.json 的 estate 键；Key 归 CLI 自己管理，这里不存）
// ---------------------------------------------------------------------------
interface EstateSaved {
  beikeCliPath?: string; // 自装二进制的绝对路径；空 = 交给 PATH 探测
  beikeVersion?: string; // 上次安装探测到的版本（纯展示）
}

let saved: EstateSaved = {};
let loaded = false;

export async function loadEstate(): Promise<void> {
  const cfg = await readConfig();
  const e = (cfg.estate ?? {}) as Partial<EstateSaved>;
  saved = {
    beikeCliPath: typeof e.beikeCliPath === "string" && e.beikeCliPath.trim() ? e.beikeCliPath : "",
    beikeVersion: typeof e.beikeVersion === "string" ? e.beikeVersion : "",
  };
  loaded = true;
}

const ensureLoaded = (): Promise<void> => (loaded ? Promise.resolve() : loadEstate());

async function persistEstate(): Promise<void> {
  await mergeConfig({ estate: saved });
}

// ---------------------------------------------------------------------------
// CLI 探测与执行
// ---------------------------------------------------------------------------
export interface BeikeStatus {
  installed: boolean;
  version: string;   // 上次探测/安装得到的版本，未知则空串
  path: string;      // 当前解析到的二进制路径（探测失败为空）
  hasOverride: boolean;
  platform: string;
  keyUrl: string;    // 前端引导用户去获取授权 Key
}

/** spawn 一次 beike：返回退出码 + stdout/stderr（不解析 JSON）。
 * T1-4 迁移到 subprocess.ts 受控运行器：输出上限 + 超时 + Windows整树强杀 */
function runBeikeRaw(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runControlled(bin, {
    args,
    timeoutMs,
    // 贝壳官方技能要求固定来源标识；沿用用户环境变量其余部分
    env: { ...process.env, BEIKE_SOURCE: "beike_skill" },
  }).then((r) => {
    // 受控运行器的异常终止统一标 -1；把终止原因补进 stderr，便于调用方转述
    const stderr = r.killedBy
      ? (r.stderr + (r.stderr ? "\n" : "") +
        (r.killedBy === "timeout" ? `beike 执行超过 ${timeoutMs}ms 被终止` : "beike 输出超限被终止")).trim()
      : r.stderr;
    // 受控运行器的异常终止统一标 -1；旧约定 -1/-2/-3 的差异对调用方无实际意义
    return { code: r.code, stdout: r.stdout, stderr };
  });
}

/** beike CLI 的输出是单行 JSON；容错：剥掉前后非 JSON 日志后再 parse */
function parseBeikeJson(stdout: string): { ok: boolean; data: unknown; raw: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, data: null, raw: "" };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, data: parsed, raw: trimmed };
  } catch { /* 输出里混了日志 → 找最外层大括号再试 */ }
  const start = trimmed.indexOf("{") >= 0 ? trimmed.indexOf("{") : trimmed.indexOf("[");
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return { ok: true, data: parsed, raw: trimmed };
    } catch { /* fallthrough */ }
  }
  return { ok: false, data: null, raw: trimmed.slice(0, 4_000) };
}

/** 探测可用的 beike 二进制：配置路径优先，其次 PATH 里的 beike */
async function resolveBeikeBin(): Promise<{ path: string; version: string } | null> {
  const candidates: string[] = [];
  if (saved.beikeCliPath) candidates.push(saved.beikeCliPath);
  candidates.push("beike");
  for (const bin of candidates) {
    const r = await runBeikeRaw(bin, ["--version"], 15_000);
    if (r.code === 0 && r.stdout.trim()) {
      const version = r.stdout.trim().split(/\r?\n/)[0].replace(/^beike\s*/i, "").trim();
      return { path: bin, version };
    }
  }
  return null;
}

/** 当前状态（路由 /api/estate 用） */
export async function getEstatePublic(): Promise<BeikeStatus> {
  await ensureLoaded();
  const found = await resolveBeikeBin();
  return {
    installed: Boolean(found),
    version: found?.version || saved.beikeVersion || "",
    path: found
      ? (saved.beikeCliPath && found.path === saved.beikeCliPath ? "（自装目录）" : "PATH")
      : "",
    hasOverride: Boolean(saved.beikeCliPath),
    platform: process.platform,
    keyUrl: BEIKE_KEY_URL,
  };
}

/** beike 不可用时的统一报错 JSON（工具层直接原样返回给模型转述） */
export interface BeikeUnavailable {
  error: string;
  setup: "beike-install";
  keyUrl: string;
}

async function ensureBeike(): Promise<{ path: string; version: string }> {
  await ensureLoaded();
  const found = await resolveBeikeBin();
  if (!found) throw new Error("贝壳 CLI（beike）未安装或不可用");
  return found;
}

function unavailableJSON(err: unknown): BeikeUnavailable {
  return {
    error: err instanceof Error ? err.message : String(err),
    setup: "beike-install",
    keyUrl: BEIKE_KEY_URL,
  };
}

// ---------------------------------------------------------------------------
// 安装：GitHub release 下载 + sha256 校验 + Windows tar.exe 解压 + 写配置
// ---------------------------------------------------------------------------
interface ManifestBinaries {
  latest: string;
  releases: Array<{ version: string; binaries: Array<{ os: string; arch: string; url: string; sha256: string }> }>;
}

async function pickLatestBinary(os: string, arch: string): Promise<{ url: string; sha256: string; version: string } | null> {
  assertTrustedInstallUrl(BEIKE_MANIFEST_URL, "版本清单地址");
  const res = await fetch(BEIKE_MANIFEST_URL, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`获取贝壳 CLI 版本清单失败：HTTP ${res.status}`);
  const manifest = (await res.json()) as ManifestBinaries;
  const bins = manifest.releases.find((r) => r.version === manifest.latest)?.binaries ?? [];
  const hit = bins.find((b) => b.os === os && b.arch === arch);
  if (!hit) throw new Error(`贝壳 CLI 暂无 ${os}/${arch} 的官方二进制`);
  assertTrustedInstallUrl(hit.url, "二进制下载地址"); // manifest 内容也可能把 host 指到别处，同样过白名单
  return { url: hit.url, sha256: hit.sha256, version: manifest.latest };
}

/**
 * 安装互斥（T1-6）：并发点击只保留第一调用，后续调用复用同一个 Promise。
 * 否则两次 tar 解压/写配置会互相踩（.setting/beike 半拆状态）。
 */
let installInFlight: Promise<BeikeStatus> | null = null;

/** 下载安装 beike CLI（仅 win32 自动化；其它平台提示用官方 install.sh）。 */
export async function installBeike(): Promise<BeikeStatus> {
  if (installInFlight) return installInFlight;
  installInFlight = doInstallBeike().finally(() => { installInFlight = null; });
  return installInFlight;
}

async function doInstallBeike(): Promise<BeikeStatus> {
  await ensureLoaded();
  const os = process.platform;
  const arch = os === "win32" ? "x64" : process.arch;
  if (os !== "win32" && os !== "linux" && os !== "darwin") {
    throw new Error(`暂不支持平台 ${os}，请手动安装贝壳 CLI`);
  }
  // Windows 自动化依赖系统自带 tar.exe 解 .tar.gz；linux/mac 引导 install.sh（官方脚本）
  if (os === "win32") {
    const bin = await pickLatestBinary("win32", "x64");
    if (!bin) throw new Error("未找到可用的官方二进制");
    await fsp.mkdir(BEIKE_DIR, { recursive: true });
    // 先写 .part 临时名再 rename：防响应中断留下「看似可用」的半份压缩包
    const archive = join(BEIKE_DIR, "beike-cli.tar.gz.part");
    log("info", "estate_cli_download", { version: bin.version, url: bin.url });
    assertTrustedInstallUrl(bin.url, "二进制下载地址"); // 落到真实 request 前再度校验
    const res = await fetch(bin.url, { signal: AbortSignal.timeout(BEIKE_INSTALL_TIMEOUT_MS), redirect: "error" });
    // redirect: "error"：显式拒绝跟到非白名单 host（重定向即视为篡改）
    if (!res.ok) throw new Error(`下载贝壳 CLI 失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // sha256 校验：manifest 里给的是十六进制摘要，下载必须完全一致才落盘解压
    const digest = createHash("sha256").update(buf).digest("hex");
    if (digest.toLowerCase() !== bin.sha256.toLowerCase()) {
      throw new Error(`下载文件校验失败（sha256 不符），可能被网络劫持：${digest}`);
    }
    await fsp.writeFile(archive, buf);
    // Windows 10+ 自带 tar.exe（bsdtar），支持 .tar.gz；用绝对路径避免 PATH 被换
    const sysTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const tar = await runBeikeRaw(sysTar, ["-xzf", archive, "-C", BEIKE_DIR], 120_000);
    if (tar.code !== 0) throw new Error(`解压失败：${(tar.stderr || tar.stdout).slice(0, 300)}`);
    await fsp.rm(archive, { force: true });
    // 定位解压出来的 beike 可执行文件：优先 beike.exe，其次任意 beike*.exe
    const entries = await fsp.readdir(BEIKE_DIR, { recursive: true, withFileTypes: true });
    let exe = entries.find((e) => e.isFile() && /^beike\.exe$/i.test(e.name));
    if (!exe) exe = entries.find((e) => e.isFile() && /^beike.*\.(exe)$/i.test(e.name));
    if (!exe) throw new Error(`解压完成但没找到 beike 可执行文件（${BEIKE_DIR}）`);
    const exePath = join(BEIKE_DIR, relative(BEIKE_DIR, join(exe.parentPath, exe.name)));
    saved.beikeCliPath = exePath;
    saved.beikeVersion = bin.version;
    await persistEstate();
    // T1-6 审计：安装动作记录下载 URL / 版本 / 摘要，事后可追责与对账
    writeAudit("beike.install", { url: bin.url, version: bin.version, sha256: bin.sha256, explicit: true });
  } else {
    throw new Error(
      `本平台请用贝壳官方脚本安装：curl -fsSL ${BEIKE_MANIFEST_URL.replace(
        "/manifest.json",
        ""
      )} 未提供 install.sh 的直链，请参考贝壳官方文档安装；安装后无需再配置（PATH 会被自动探测）`
    );
  }
  const found = await resolveBeikeBin();
  if (!found) throw new Error("安装完成但 beike --version 探测失败，请检查后重试");
  saved.beikeVersion = found.version;
  await persistEstate();
  return getEstatePublic();
}

// ---------------------------------------------------------------------------
// 鉴权：Key 不再进 argv（T1-3），直接写官方凭证文件 + doctor 免费校验
// ---------------------------------------------------------------------------
/** 贝壳 CLI 的凭证存储文件（`beike auth <KEY> --save` 的本质就是写它，权限 600） */
const BEIKE_CRED_FILE = join(homedir(), ".beike", "BEIKE_MCP_API_KEY");
/** 文案回显时的密钥遮蔽：首尾各保留多少明文 */
const REDACT_KEEP = 4;

/** 把文案里的密钥片段替换为掩码（错误信息可能回显用户输入，统一过这层再返回） */
function redactSecret(sample: string, secret: string): string {
  const s = secret.trim();
  if (!s) return sample;
  if (s.length <= REDACT_KEEP * 2) return sample.split(s).join("****");
  return sample.split(s).join(`${s.slice(0, REDACT_KEEP)}****${s.slice(-REDACT_KEEP)}`);
}

export async function saveBeikeKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  await ensureLoaded();
  const key = apiKey.trim();
  if (!key) throw new Error("Key 不能为空：登录贝壳获取后完整复制粘贴");
  let bin: string;
  try {
    bin = (await ensureBeike()).path;
  } catch {
    return { ok: false, message: "贝壳 CLI 尚未安装，请先点「安装 CLI」再保存 Key" };
  }
  // T1-3：官方 CLI 的 auth 只收位置参数 KEY（无 stdin/env 支持），argv 直接进
  // 进程命令行会被任意本机进程读取（Get-CimInstance Win32_Process 实测可见）。
  // 但 `auth --save` 的实际动作就是「把 Key 落盘到 ~/.beike/BEIKE_MCP_API_KEY」，
  // 所以这里由服务端直接写该文件（mode 600），再用 doctor 做校验：
  // doctor 只探测 /mcp 的工具清单（免费、不耗网关配额），判定 Key 是否被 CLI 认可。
  await fsp.mkdir(dirname(BEIKE_CRED_FILE), { recursive: true });
  await fsp.writeFile(BEIKE_CRED_FILE, key, { mode: 0o600 });
  const doctor = await runBeikeRaw(bin, ["doctor"], KEY_AUTH_TIMEOUT_MS);
  const out = `${doctor.stdout}\n${doctor.stderr}`;
  if (/Key 有效/.test(out)) {
    return { ok: true, message: "Key 已保存并通过 CLI 校验，可以开始找房了" };
  }
  const tail = out.trim().slice(-300);
  return {
    ok: false,
    message: tail
      ? `凭证校验未通过：${redactSecret(tail, key)}`
      : "凭证校验未通过，请确认复制的是页面上的完整字符",
  };
}

// ---------------------------------------------------------------------------
// 每轮「用户需求分析」上报（贝壳官方契约；fire-and-forget 自吞异常）
// ---------------------------------------------------------------------------
export function analyzeEstateTurn(rawQuery: string, contextIntent: string): void {
  void (async () => {
    try {
      await ensureLoaded();
      const bin = await resolveBeikeBin();
      if (!bin) return;
      // 首轮不传 --session-id：CLI 自行签发并缓存；context-intent 截 200 字
      await runBeikeRaw(
        bin.path,
        ["analyze", "--raw-query", rawQuery.slice(0, 2_000), "--context-intent", contextIntent.slice(0, 200)],
        BEIKE_ANALYZE_TIMEOUT_MS
      );
    } catch { /* 上报失败静默：绝不影响找房回答 */ }
  })();
}

// ---------------------------------------------------------------------------
// 业务查询包装（每个都返回 JSON 可序列化对象，绝不 throw 穿透到图）
// ---------------------------------------------------------------------------
export interface BeikeOutcome {
  ok: boolean;
  action: string;
  data?: unknown;   // CLI 解析出的原始 JSON（调用方按需取）
  raw?: string;     // 解析失败时的原文本兜底（已截断）
  error?: string;   // 正常语料转述给模型的中文错误
  truncated?: boolean;
}

async function beikeCommand(action: string, args: string[]): Promise<BeikeOutcome> {
  try {
    const { path: bin } = await ensureBeike();
    // T2-5：贝壳 CLI 全局并发上限 2（用户查询 + analyze 后台上报不会互相挤爆）
    const r = await runWithLimit(BEIKE_CLI_BUCKET, BEIKE_CLI_CONCURRENCY, () =>
      runBeikeRaw(bin, args, BEIKE_RUN_TIMEOUT_MS));
    if (r.code === 0) {
      const parsed = parseBeikeJson(r.stdout);
      if (parsed.ok) return { ok: true, action, data: parsed.data };
      // 纯文本输出（非 JSON）：对模型来说文本本身就是可读结果
      return { ok: true, action, data: { text: parsed.raw.slice(0, 6_000) } };
    }
    // CLI 版本过低（-32001）：T1-6 后不再静默自动重装 —— 下载执行代码必须由
    // 用户显式确认。这里明确告知版本差并指引用户到面板点「安装/升级 CLI」。
    if (/CLI_UPGRADE_REQUIRED|版本过低|-32001/i.test(r.stderr + r.stdout)) {
      writeAudit("beike.upgradeDeclined", { action, current: saved.beikeVersion ?? "" });
      const cur = saved.beikeVersion || "未知";
      return {
        ok: false,
        action,
        error: `贝壳 CLI 版本过低（当前 v${cur}，官方要求升级后使用）。` +
          `请到「找房工具」面板手动点击「安装 CLI」完成升级后再重试；` +
          `工作台不会在后台自动下载并执行新版本程序。`,
      };
    }
    const detail = (r.stderr || r.stdout || "无输出").trim().slice(-500);
    return {
      ok: false,
      action,
      error: `贝壳查询失败（beike ${args[0]} ${args[1]}）：${detail}`,
    };
  } catch (err) {
    return { ...unavailableJSON(err), ok: false, action, error: err instanceof Error ? err.message : String(err) } as BeikeOutcome;
  }
}

export type HouseMode = "buy" | "rent";

/** 找房搜索：beike buy|rent search -c 城市 -q 查询 [--house-type second|new] */
export function houseSearch(mode: HouseMode, city: string, query: string, houseType?: "second" | "new"): Promise<BeikeOutcome> {
  const args = [mode === "rent" ? "rent" : "buy", "search", "-c", city || "北京", "-q", query];
  if (houseType && mode !== "rent") args.push("--house-type", houseType);
  return beikeCommand("search", args);
}

/** 详情 / 户型图物料：beike buy|rent detail|material -c 城市 --id 房源ID [-t house|newhouse] */
export function houseInfo(
  mode: HouseMode,
  info: "detail" | "material",
  city: string,
  id: string,
  houseType?: "house" | "newhouse"
): Promise<BeikeOutcome> {
  const args = [mode, info === "detail" ? "detail" : "material", "-c", city, "--id", id];
  if (houseType && mode === "buy") args.push("-t", houseType);
  return beikeCommand(info, args);
}

/** 小区评测 / 板块评测：beike buy|rent resblock|plate -c 城市 -q 名称 */
export function houseArea(mode: HouseMode, area: "resblock" | "plate", city: string, query: string): Promise<BeikeOutcome> {
  return beikeCommand(area, [mode, area, "-c", city, "-q", query]);
}

/** 地名消歧：beike buy resolve -q 待消歧文本 [-c 城市] */
export function houseResolve(query: string, city?: string): Promise<BeikeOutcome> {
  const args = ["buy", "resolve", "-q", query];
  if (city) args.push("-c", city);
  return beikeCommand("resolve", args);
}

/** 行情类：beike buy|rent market / buy sold|rank|school|district / beike policy search */
export function houseMarket(
  action: "market" | "sold" | "rank" | "school" | "district" | "policy",
  mode: HouseMode,
  city: string,
  query: string,
  rankType?: "house" | "resblock"
): Promise<BeikeOutcome> {
  if (action === "policy") return beikeCommand("policy", ["policy", "search", "-c", city, "-q", query || city]);
  if (action === "rank") {
    const args = ["buy", "rank", "-c", city];
    if (rankType) args.push("--rank-type", rankType);
    return beikeCommand("rank", args);
  }
  return beikeCommand(action, [mode, action, "-c", city, "-q", query]);
}

/** 经纪人检索 / 详情：beike buy|rent agent / rent agent-detail；contact 前置 reasons 模拟生成 */
export function houseAgents(
  mode: HouseMode,
  action: "search" | "detail",
  city: string,
  query: string,
  agentUcid?: string
): Promise<BeikeOutcome> {
  if (action === "detail") {
    // 只有租赁方向有 agent-detail；详情必须用真实经纪人 ID
    if (mode === "rent") return beikeCommand("agent-detail", ["rent", "agent-detail", "-c", city, "--id", String(agentUcid ?? "")]);
    return beikeCommand("agent-detail", ["buy", "agent-detail", "-c", city, "--id", String(agentUcid ?? "")]);
  }
  return beikeCommand("agent", [mode, "agent", "-c", city, "-q", query]);
}

/** 获取经纪人的企微加微二维码（对外动作 → hitl 审批后才会执行） */
export function houseContact(mode: HouseMode, city: string, agentUcid: string, reason: string, biz?: string): Promise<BeikeOutcome> {
  const args = [mode, "contact", "-c", city, "--agent-ucid", String(agentUcid), "--reason", reason];
  if (mode === "buy" && biz) args.push("--biz", biz);
  return beikeCommand("contact", args);
}

/** 预约带看（对外动作 → hitl 审批后才会执行）：beike rent appoint --house-id --date [--start --end] */
export function houseAppoint(houseId: string, date: string, start?: string, end?: string): Promise<BeikeOutcome> {
  const args = ["rent", "appoint", "--house-id", String(houseId), "--date", date];
  if (start) args.push("--start", start);
  if (end) args.push("--end", end);
  return beikeCommand("appoint", args);
}

// ---------------------------------------------------------------------------
// 区位 geocode：Nominatim（无 key）+ 串行限速 + 内存缓存
// 出口形状（tools-estate.ts 组装给前端专属渲染）：
//   { points:[{name,address,lat,lng,links}], geoMissing:[...], embedUrl, city }
// ---------------------------------------------------------------------------
export interface GeocodePoint {
  name: string;
  address?: string;
  lat: number;
  lng: number;
  source: string;
  links: { amap: string; qq: string; baidu: string; osm: string };
}

const geocodeCache = new Map<string, { lat: number; lng: number; address: string } | null>();
let geocodeQueue: Promise<void> = Promise.resolve();

function b64(input: string): string {
  return encodeURIComponent(input);
}

/** 三家国内地图 + OSM 的直达链接（无 key；uri 协议链接浏览器直接打开） */
export function buildMapLinks(name: string, lat: number, lng: number, city: string): GeocodePoint["links"] {
  const label = `${name}（${city}）`;
  return {
    amap: `https://uri.amap.com/marker?position=${lng},${lat}&name=${b64(name)}&src=langgraph-agent&callnative=0`,
    qq: `https://apis.map.qq.com/uri/v1/marker?marker=coord:${lat},${lng};title:${b64(name)};addr:${b64(city)}&referer=langgraph-agent`,
    baidu: `https://api.map.baidu.com/marker?location=${lat},${lng}&title=${b64(name)}&content=${b64(label)}&output=html&src=langgraph-agent`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`,
  };
}

/** 未定位的点也给出「名称搜索直链」（不需要坐标） */
export function searchLinks(name: string, city: string): GeocodePoint["links"] {
  return {
    amap: `https://uri.amap.com/search?keyword=${b64(name)}&city=${b64(city)}&src=langgraph-agent`,
    qq: `https://apis.map.qq.com/uri/v1/search?keyword=${b64(name)}&region=${b64(city)}&referer=langgraph-agent`,
    baidu: `https://api.map.baidu.com/place/search?query=${b64(name)}&region=${b64(city)}&output=html&src=langgraph-agent`,
    osm: `https://www.openstreetmap.org/search?query=${b64(city + " " + name)}`,
  };
}

async function nominatimFetch(query: string): Promise<{ lat: number; lng: number; address: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_UA, "Accept-Language": "zh" },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const hit = Array.isArray(rows) ? rows[0] : undefined;
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, address: String(hit?.display_name ?? "") };
}

/** 单点定位：缓存命中直接回，未命中则进串行队列（≥1.1s 间隔）。失败返回 null（不抛） */
export function geocodeAddress(name: string, city: string): Promise<{ lat: number; lng: number; address: string } | null> {
  const key = `${city}|${name}`;
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key) ?? null);
  const run = geocodeQueue.then(async () => {
    const started = Date.now();
    try {
      const r = await nominatimFetch(`${city} ${name}`);
      geocodeCache.set(key, r);
      if (geocodeCache.size > GEOCODE_CACHE_MAX) {
        geocodeCache.delete(geocodeCache.keys().next().value as string);
      }
      return r;
    } catch {
      geocodeCache.set(key, null); // 网络失败也别短时间内重试
      return null;
    } finally {
      // 无论成败都垫够节奏时间，保证上游 1 req/s 限速不被单点超时击穿
      const wait = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - started));
      await new Promise((sleepP) => setTimeout(sleepP, wait));
    }
  });
  geocodeQueue = run.then(() => undefined, () => undefined);
  return run;
}

export const GEOCODE_LIMITS = { maxItems: GEOCODE_MAX_ITEMS };

/** 多点对比结果组装（tools-estate.ts 的 house_map 调用） */
export async function buildCompareMap(
  items: Array<{ name: string; address?: string }>,
  city: string
): Promise<{
  points: GeocodePoint[];
  geoMissing: Array<{ name: string; links: GeocodePoint["links"] }>;
  embedUrl: string;
  city: string;
}> {
  const capped = items.slice(0, GEOCODE_MAX_ITEMS);
  const located: GeocodePoint[] = [];
  const missing: Array<{ name: string; links: GeocodePoint["links"] }> = [];
  for (const item of capped) {
    const target = item.address?.trim() || item.name;
    const hit = await geocodeAddress(target, city);
    if (hit) {
      located.push({
        name: item.name,
        address: hit.address,
        lat: hit.lat,
        lng: hit.lng,
        source: "nominatim",
        links: buildMapLinks(item.name, hit.lat, hit.lng, city),
      });
    } else {
      missing.push({ name: item.name, links: searchLinks(target, city) });
    }
  }
  // OSM embed iframe：bbox 覆盖全部已定位点（留 ~0.02° 边距）；单点附加 marker
  let embedUrl = "";
  if (located.length) {
    const lats = located.map((p) => p.lat);
    const lngs = located.map((p) => p.lng);
    const pad = 0.02;
    const minLat = Math.min(...lats) - pad;
    const maxLat = Math.max(...lats) + pad;
    const minLng = Math.min(...lngs) - pad;
    const maxLng = Math.max(...lngs) + pad;
    const one = located[0];
    embedUrl =
      `https://www.openstreetmap.org/export/embed.html?bbox=${minLng},${minLat},${maxLng},${maxLat}&layer=mapnik` +
      (located.length === 1 ? `&marker=${one.lat},${one.lng}` : "");
  }
  return { points: located, geoMissing: missing, embedUrl, city };
}
