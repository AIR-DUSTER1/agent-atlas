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
      if (forbidden.test(spec)) found.push(`${rel} -> ${spec}`);
    }
  }
  return found;
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

test("routes 不直接操作文件系统，统一走持久化服务", async () => {
  assert.deepEqual(
    await violations(join(SRC, "server", "routes"), /^node:(fs|fs\/promises)$|^fs(\/promises)?$/),
    []
  );
});

test("聊天 SSE 不按墙钟中断静默等待，模型请求超时仍由供应商调用层负责", async () => {
  const chat = await readFile(join(SRC, "server", "routes", "chat.ts"), "utf8");
  const workflow = await readFile(join(SRC, "agent", "workflow.ts"), "utf8");
  assert.doesNotMatch(chat, /taskLimit|agentIdleTimeoutMs|TaskLimitError/);
  assert.match(workflow, /modelRequestTimeoutMs/);
});

test("架构例外清单为空；新增例外必须先修改本测试并完成评审", () => {
  const exceptions: Array<{ file: string; reason: string }> = [];
  assert.deepEqual(exceptions, []);
});
test("Agent 与工具只依赖 Memory Slot，不直接触碰具体 Provider/旧存储", async () => {
  const workflow = await readFile(join(SRC, "agent", "workflow.ts"), "utf8");
  const tools = await readFile(join(SRC, "tools-memory.ts"), "utf8");
  assert.doesNotMatch(workflow, /memory-store|memory\/providers\//);
  assert.doesNotMatch(tools, /memory-store|memory\/providers\//);
  assert.match(workflow, /memory\/slot\.js/);
  assert.match(tools, /memory\/slot\.js/);
});
