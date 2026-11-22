/**
 * ============================================================
 * architecture.test.ts — 服务端分层与 Agent 域隔离守门
 * ============================================================
 * 计划中的原则必须能被 CI 自动拒绝，而不是只写在文档里：
 *  - agent 层不依赖 server/client，保证 CLI 可独立运行；
 *  - general 不 import 房产工具，estate 不 import 开发 / RAG 工具；
 *  - routes 不直接操作 node:fs，持久化必须经过 service/store；
 *  - 现有例外清单为空，新增例外必须在这里显式评审。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");

async function listTs(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listTs(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function importsOf(source: string): string[] {
  const result: string[] = [];
  const staticImport = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const regex of [staticImport, dynamicImport]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source))) result.push(match[1] ?? match[2] ?? "");
  }
  return result;
}

async function violations(dir: string, forbidden: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const file of await listTs(dir)) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    for (const spec of importsOf(await readFile(file, "utf8"))) {
      // 只检查本地模块边界；`langsmith/client` 等第三方子路径不应被误判为 src/client。
      if (spec.startsWith(".") && forbidden.test(spec)) found.push(`${rel} -> ${spec}`);
    }
  }
  return found;
}

async function readWorkflowSources(): Promise<string> {
  const facade = await readFile(join(SRC, "agent", "workflow.ts"), "utf8");
  const modules = await Promise.all((await listTs(join(SRC, "agent", "workflow"))).map((file) => readFile(file, "utf8")));
  return [facade, ...modules].join("\n");
}


test("agent 层禁止依赖 server / client，保持 CLI 可独立运行", async () => {
  assert.deepEqual(await violations(join(SRC, "agent"), /(^|\/)(server|client)(\/|$)/), []);
});

test("memory 领域层禁止依赖 server / client，Provider 契约保持纯本地", async () => {
  assert.deepEqual(await violations(join(SRC, "memory"), /(^|\/)(server|client)(\/|$)/), []);
});

test("通用与房产 Agent 的领域工具导入物理隔离", async () => {
  const general = await readFile(join(SRC, "agent", "general.ts"), "utf8");
  const estate = await readFile(join(SRC, "agent", "estate.ts"), "utf8");
  assert.doesNotMatch(general, /tools-estate|house_(search|lookup|appoint|contact|market)/);
  assert.doesNotMatch(estate, /tools-dev|tools-rag|terminal|write_file|retrieve_docs/);
});

test("求职 Agent 与通用 / 房产 Agent 的工具集互不越界", async () => {
  const job = await readFile(join(SRC, "agent", "job.ts"), "utf8");
  const general = await readFile(join(SRC, "agent", "general.ts"), "utf8");
  const estate = await readFile(join(SRC, "agent", "estate.ts"), "utf8");
  // 求职只用 job_* 工具集，不带开发 / 知识库 / 找房能力
  assert.match(job, /tools-job/);
  assert.doesNotMatch(job, /tools-dev|tools-rag|tools-estate|terminal|retrieve_docs/);
  assert.doesNotMatch(job, /house_(search|lookup|appoint|contact|market)/);
  // 其它 Agent 不得反向引入求职工具
  assert.doesNotMatch(general, /tools-job|job_(collect|query|enrich|summary|diagnose)/);
  assert.doesNotMatch(estate, /tools-job|job_(collect|query|enrich|summary|diagnose)/);
});

test("路由层不依赖 server：RAG 与熔断等跨层能力由 server 注入", async () => {
  assert.deepEqual(await violations(join(SRC, "routing"), /(^|\/)(server|client)(\/|$)/), []);
});

test("routes 不直接操作文件系统，统一走持久化服务", async () => {
  assert.deepEqual(
    await violations(join(SRC, "server", "routes"), /^node:(fs|fs\/promises)$|^fs(\/promises)?$/),
    []
  );
});

test("聊天 SSE 不按墙钟中断静默等待，模型请求超时仍由供应商调用层负责", async () => {
  const chat = await readFile(join(SRC, "server", "routes", "chat.ts"), "utf8");
  const workflow = await readWorkflowSources();
  assert.doesNotMatch(chat, /taskLimit|agentIdleTimeoutMs|TaskLimitError/);
  assert.match(workflow, /modelRequestTimeoutMs/);
});

test("架构例外清单为空；新增例外必须先修改本测试并完成评审", () => {
  const exceptions: Array<{ file: string; reason: string }> = [];
  assert.deepEqual(exceptions, []);
});

test("docs 目录只发布用户/运维文档，开发文档必须进入 .plans/development-docs", async () => {
  const developmentDocs = new Set([
    "agent-orchestration-vs-zcode.md",
    "agent-orchestration.md",
    "agent-wiki.md",
    "agentatlas-roadmap.md",
    "engineering-standards.md",
    "evaluation-baseline.md",
    "readiness-snapshot.md",
    "versioning.md",
  ]);
  const docs = await readdir(join(ROOT, "docs"), { withFileTypes: true });
  const leaked = docs
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && developmentDocs.has(entry.name))
    .map((entry) => entry.name);
  assert.deepEqual(leaked, []);
});
test("Agent 与工具只依赖 Memory Slot，不直接触碰具体 Provider/旧存储", async () => {
  const workflow = await readWorkflowSources();
  const tools = await readFile(join(SRC, "tools-memory.ts"), "utf8");
  assert.doesNotMatch(workflow, /memory-store|memory\/providers\//);
  assert.doesNotMatch(tools, /memory-store|memory\/providers\//);
  assert.match(workflow, /memory\/slot\.js/);
  assert.match(tools, /memory\/slot\.js/);
});

// ---------------------------------------------------------------------------
// 用户体系术语守门（用户体系改造 U0）：租户/owner 心智只允许存在于
// persistence/sql/ 迁移脚本与两条历史磁盘序列化边界里。
// ---------------------------------------------------------------------------

/** 允许出现历史磁盘键 `ownerId` 的白名单：文件路径 → 允许出现的最大次数。 */
const OWNER_DISK_BOUNDARIES: Array<{ file: string; max: number; reason: string }> = [
  {
    file: "src/server/session-store.ts",
    // 17 = session 记录与 journal 行两处各读一次旧键（`diskSession.ownerId` /
    // `diskLine.ownerId`，每处出现 2 次）+ 写回时把 userId 落到历史键名。
    max: 17,
    reason: "journal 是 append-only 历史，磁盘行键 ownerId 必须永久可读（见该文件头序列化边界说明）",
  },
  {
    file: "src/server/projects.ts",
    // 5 = 类型声明 + `legacy.ownerId` 判空与取值各一次 + 注释里的历史键名。
    max: 5,
    reason: ".web-config.json 的项目项读旧 ownerId 键做兼容，写出统一 userId",
  },
  {
    file: "src/server/security/session.ts",
    // 4 = 类型声明 + 注释 + `legacy.ownerId` 判空与赋值各一次。
    max: 4,
    reason: "旧会话 Cookie 载荷键 ownerId 的平滑兼容读；新签发一律写 userId",
  },
];

test("用户术语守门：tenant/owner 语义零残留（磁盘边界白名单除外）", async () => {
  const files = await listTs(SRC);
  const tenantLeftovers: string[] = [];
  const ownerLeftovers: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    if (rel.includes("/public/")) continue;
    const source = await readFile(file, "utf8");
    // 租户术语一律禁止（user-context.ts 只允许在注释里说明历史命名）。
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    if (/TenantContext|TenantRole|tenantContext|tenant-context|withOwnerTransaction|AuthenticatedOwner|ownerIdentityForRequest|currentOwnerId/.test(withoutComments)) {
      tenantLeftovers.push(rel);
    }
    // owner_id / ownerId 只允许出现在 SQL 迁移目录与磁盘序列化边界。
    if (/owner_id/.test(withoutComments) && !rel.includes("persistence/sql/")) {
      ownerLeftovers.push(`${rel} (owner_id)`);
    }
    const boundary = OWNER_DISK_BOUNDARIES.find((entry) => entry.file === rel);
    const ownerIdCount = (withoutComments.match(/ownerId/g) ?? []).length;
    if (ownerIdCount > 0 && !boundary) ownerLeftovers.push(`${rel} (ownerId ×${ownerIdCount})`);
    if (boundary && ownerIdCount > boundary.max) {
      ownerLeftovers.push(`${rel} (ownerId ×${ownerIdCount} > 白名单 ${boundary.max}：${boundary.reason})`);
    }
  }
  assert.deepEqual(tenantLeftovers, [], `租户术语残留：${tenantLeftovers.join(", ")}`);
  assert.deepEqual(ownerLeftovers, [], `owner 术语越界：${ownerLeftovers.join("; ")}`);
});
