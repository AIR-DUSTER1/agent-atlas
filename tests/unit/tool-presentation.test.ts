/** tool-presentation.test.ts — 工具分类、路径/命令摘要与未知工具回落 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_CATEGORIES, describeTool } from "../../src/client/modules/tool-presentation.js";

function describe(name: string, args: Record<string, unknown> | string = {}) {
  return describeTool({
    name,
    argsText: typeof args === "string" ? args : JSON.stringify(args),
    result: null,
  });
}

test("文件读取、写入、编辑、图片与命令分别归类并提取摘要", () => {
  const read = describe("read_file", { path: "src/client/main.ts" });
  assert.equal(read.category, TOOL_CATEGORIES["file-read"]);
  assert.equal(read.summary, "src/client/main.ts");

  const list = describe("list_dir", { path: "src/client" });
  assert.equal(list.category.id, "file-read");
  assert.equal(list.summary, "src/client");

  const write = describe("write_file", { path: "src/a.ts", content: "0123456789" });
  assert.equal(write.category.id, "file-write");
  assert.equal(write.summary, "src/a.ts · 10 字符");

  const edit = describe("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" });
  assert.equal(edit.category.id, "file-edit");
  assert.equal(edit.summary, "src/a.ts");

  const image = describe("read_image", { path: "assets/screen.png" });
  assert.equal(image.category.id, "image-read");
  assert.equal(image.summary, "assets/screen.png");

  const screenshot = describe("computer_screenshot");
  assert.equal(screenshot.category.id, "image-read");
  assert.equal(screenshot.summary, "截取当前屏幕");

  const command = describe("terminal", { command: "npm run typecheck" });
  assert.equal(command.category.id, "command");
  assert.equal(command.summary, "npm run typecheck");
});

test("检索、浏览器、知识、记忆、子代理、电脑与业务工具分类稳定", () => {
  assert.equal(describe("grep_search", { pattern: "createChatModel", path: "src" }).category.id, "file-search");
  assert.equal(describe("browser_fetch", { url: "https://example.com" }).category.id, "web");
  assert.equal(describe("browser_open", { url: "https://example.com" }).category.id, "browser");
  assert.equal(describe("retrieve_docs", { query: "部署说明" }).category.id, "knowledge");
  assert.equal(describe("memory_save", { key: "部署", content: "使用 Docker" }).category.id, "memory");
  assert.equal(describe("delegate_agent", { agentId: "reviewer", task: "审查代码" }).category.id, "agent");
  assert.equal(describe("computer_click", { action: "click", x: 10, y: 20 }).category.id, "computer");
  assert.equal(describe("house_search", { city: "北京" }).category.id, "estate");
  assert.equal(describe("job_query", { keyword: "Agent" }).category.id, "job");
});

test("MCP 工具先按叶子名识别，未知或坏参数安全回落到通用类别", () => {
  const known = describe("mcp__filesystem__read_file", { path: "README.md" });
  assert.equal(known.category.id, "file-read");
  assert.equal(known.rawName, "mcp__filesystem__read_file");
  assert.equal(known.summary, "README.md");

  const unknown = describe("mcp__server__custom_tool", { query: "hello" });
  assert.equal(unknown.category.id, "mcp");
  assert.equal(unknown.summary, "hello");

  const fallback = describe("new_tool", '{"partial"');
  assert.equal(fallback.category.id, "other");
  assert.match(fallback.summary, /partial/);

  const calculator = describe("calculator", { expression: "1+2" });
  assert.equal(calculator.category.id, "other");
  assert.equal(calculator.summary, "1+2");
});