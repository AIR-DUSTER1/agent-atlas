/**
 * mcp.test.ts — MCP 客户端回归（F6）
 * ============================================================
 * 守五条：
 *   1. initialize / tools/list 握手后能发现工具；
 *   2. tools/call 结果能正确文本化（content 数组拼接）；
 *   3. 工具名加 mcp__<server>__<tool> 前缀，与内置工具不撞车；
 *   4. 远端报错（JSON-RPC error / isError）转成模型可读文本，不抛穿透；
 *   5. 配置校验与增删；工具默认登记审批（宁严勿松）。
 *
 * 用一个自写的「最小 MCP server」子进程当测试对端，不联外网、不装 MCP SDK。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "agent-mcp-"));
const configFile = join(dir, "web-config.json");
const serverScript = join(dir, "echo-mcp.mjs");
process.env.WEB_CONFIG_FILE = configFile;

/**
 * 最小 MCP server 源码。刻意用普通字符串数组 join 而不是模板字符串 ——
 * fixture 里再嵌模板字符串会让转义层层叠加，极易写出语法错误。
 */
const FIXTURE_LINES = [
  'let buf = "";',
  'process.stdin.setEncoding("utf8");',
  "const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  '  let idx;',
  '  while ((idx = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, idx).trim();",
  "    buf = buf.slice(idx + 1);",
  "    if (!line) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch { continue; }",
  "    if (msg.id == null) continue;",
  "    const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });",
  "    const fail = (message) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message } });",
  "    if (msg.method === 'initialize') {",
  "      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } });",
  "    } else if (msg.method === 'tools/list') {",
  "      reply({ tools: [",
  "        { name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要回显的文本' } } } },",
  "        { name: 'boom', description: '总是失败', inputSchema: { type: 'object', properties: {} } },",
  "        { name: 'fail_result', description: '返回 isError', inputSchema: { type: 'object', properties: {} } },",
  "      ] });",
  "    } else if (msg.method === 'tools/call') {",
  "      const name = msg.params && msg.params.name;",
  "      const args = (msg.params && msg.params.arguments) || {};",
  "      if (name === 'echo') reply({ content: [{ type: 'text', text: 'echo: ' + String(args.text || '') }] });",
  "      else if (name === 'boom') fail('这是远端故意返回的协议错误');",
  "      else if (name === 'fail_result') reply({ content: [{ type: 'text', text: '业务失败原因' }], isError: true });",
  "      else fail('未知工具');",
  "    } else {",
  "      fail('未实现的方法 ' + msg.method);",
  "    }",
  "  }",
  "});",
];
await writeFile(serverScript, FIXTURE_LINES.join("\n") + "\n", "utf8");

const { saveMcpServer, deleteMcpServer, listMcpServers, listMcpStatus, testMcpServer, disconnectAll } =
  await import("../../src/server/mcp.js");
const { loadMcpTools, mcpApprovalDescriptions, mcpToolName } =
  await import("../../src/server/mcp-tools.js");

test.after(async () => {
  await disconnectAll();
  delete process.env.WEB_CONFIG_FILE;
  await rm(dir, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tools = await loadMcpTools();
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `工具 ${name} 应存在，实际：${tools.map((t) => t.name).join(", ")}`);
  return String(await (found as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke(args));
}

test("配置校验：缺 id / 缺 command / 非法 id 都被拒", async () => {
  await assert.rejects(() => saveMcpServer({ command: "node" }), /配置不完整/);
  await assert.rejects(() => saveMcpServer({ id: "x" }), /配置不完整/);
  await assert.rejects(() => saveMcpServer({ id: "带中文", command: "node" }), /配置不完整/);
});

test("initialize + tools/list：能发现远端工具", async () => {
  await saveMcpServer({
    id: "echo_srv",
    name: "回显服务",
    command: process.execPath,
    args: [serverScript],
  });
  const status = await testMcpServer("echo_srv");
  assert.equal(status.connected, true, `连接应成功：${status.error ?? ""}`);
  assert.deepEqual([...status.tools.map((t) => t.name)].sort(), ["boom", "echo", "fail_result"]);
});

test("工具名带 mcp__<server>__ 前缀", () => {
  assert.equal(mcpToolName("echo_srv", "echo"), "mcp__echo_srv__echo");
});

test("tools/call 成功：结果正确文本化", async () => {
  const out = await callTool("mcp__echo_srv__echo", { text: "你好" });
  assert.equal(out, "echo: 你好");
});

test("远端协议错误与 isError 都转成模型可读文本，不抛穿透", async () => {
  const boom = await callTool("mcp__echo_srv__boom", {});
  assert.match(boom, /error/);
  assert.match(boom, /这是远端故意返回的协议错误/);

  const failed = await callTool("mcp__echo_srv__fail_result", {});
  assert.match(failed, /error/);
  assert.match(failed, /业务失败原因/);
});

test("MCP 工具默认全部登记审批，且文案带 server 与工具名", async () => {
  await testMcpServer("echo_srv"); // 确保有活跃连接与工具列表
  const approvals = await mcpApprovalDescriptions();
  const name = mcpToolName("echo_srv", "echo");
  assert.ok(approvals[name], "MCP 工具必须默认登记审批");
  const text = approvals[name]({ text: "abc" });
  assert.match(text, /回显服务/);
  assert.match(text, /echo/);
});

test("requireApproval:false 的 server 不登记审批（按需放开）", async () => {
  await saveMcpServer({
    id: "loose_srv",
    command: process.execPath,
    args: [serverScript],
    requireApproval: false,
  });
  await testMcpServer("loose_srv");
  const approvals = await mcpApprovalDescriptions();
  assert.equal(approvals[mcpToolName("loose_srv", "echo")], undefined, "关掉审批的 server 不应登记");
});

test("删除 server：从配置移除并断开连接", async () => {
  const del = await deleteMcpServer("loose_srv");
  assert.equal(del.removed, true);
  assert.ok(!del.servers.some((s) => s.id === "loose_srv"));

  const after = await listMcpStatus();
  assert.equal(after.find((s) => s.id === "loose_srv"), undefined, "删除后不应再出现在状态里");
  assert.equal((await listMcpServers()).some((s) => s.id === "loose_srv"), false);
});
