/**
 * mcp.spec.ts — MCP Servers 页面真实浏览器回归
 * ============================================================
 * 覆盖列表状态、单服务器启停、全局暂停、编辑弹窗、添加与 .mcp.json 导入，
 * 以及「测试连接」按钮的即时反馈（测试中 → 就地结果）。
 * 测试服务使用临时配置，除 fixture 的 stdio MCP server 外不触网、不启常驻进程。
 */
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { login } from "./helpers.js";

const ECHO_FIXTURE = fileURLToPath(new URL("./fixtures/echo-mcp.mjs", import.meta.url));

test("MCP 页面：列表、全局暂停、编辑弹窗、添加与导入", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);

  const seeds = [
    { id: "mysql", name: "MySQL", command: "node", args: ["--version"], enabled: false },
    { id: "postgresql", name: "PostgreSQL", command: "node", args: ["--version"], enabled: false },
    { id: "knowledge", name: "Knowledge Graph Memory", command: "node", args: ["--version"], enabled: false },
  ];
  for (const seed of seeds) {
    const response = await page.evaluate(async (body) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status;
    }, seed);
    expect(response).toBe(200);
  }

  await page.locator("#settings-btn").click();
  await page.locator('[data-settings-view="mcp"]').click();
  await expect(page.locator("#settings-view-mcp")).toBeVisible();
  await expect(page.locator(".mcp-server-row")).toHaveCount(3);
  await expect(page.locator("#mcp-summary")).toContainText("共 3 个服务器");
  await expect(page.locator("#mcp-global-enabled")).toBeChecked();

  const mysqlToggle = page.getByRole("checkbox", { name: "启用 MCP 服务器 MySQL" });
  await expect(mysqlToggle).not.toBeChecked();
  await mysqlToggle.click();
  await expect(page.getByRole("checkbox", { name: "启用 MCP 服务器 MySQL" })).toBeChecked();

  await page.getByRole("button", { name: "编辑 MCP 服务器 PostgreSQL" }).click();
  await expect(page.locator("#mcp-editor")).toBeVisible();
  await expect(page.locator("#mcp-id")).toHaveValue("postgresql");
  await expect(page.locator("#mcp-id")).toHaveAttribute("readonly", "");
  await page.locator("#mcp-editor-close").click();
  await expect(page.locator("#mcp-editor")).toBeHidden();

  await page.locator("#mcp-add-btn").click();
  await page.locator("#mcp-command-line").fill("$ node --version");
  await page.locator("#mcp-command-parse").click();
  await expect(page.locator("#mcp-id")).toHaveValue("node");
  await expect(page.locator("#mcp-command")).toHaveValue("node");
  await expect(page.locator("#mcp-args")).toHaveValue("--version");
  await expect(page.locator("#mcp-command-preview")).toContainText("$ node --version");
  await page.locator("#mcp-id").fill("chrome-devtools");
  await page.locator("#mcp-name").fill("Chrome DevTools MCP");
  await page.locator("#mcp-editor-save").click();
  await expect(page.locator(".mcp-server-row").filter({ hasText: "Chrome DevTools MCP" })).toBeVisible();

  const chromeRow = page.locator(".mcp-server-row").filter({ hasText: "Chrome DevTools MCP" });
  await chromeRow.getByRole("checkbox", { name: "启用 MCP 服务器 Chrome DevTools MCP" }).click();
  await expect(chromeRow.getByRole("checkbox", { name: "启用 MCP 服务器 Chrome DevTools MCP" })).not.toBeChecked();

  await page.locator("#mcp-import-file").setInputFiles({
    name: "mcp.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      mcpServers: {
        imported: { command: "node", args: ["--version"], enabled: false, name: "Imported MCP" },
      },
    })),
  });
  await expect(page.locator(".mcp-server-row").filter({ hasText: "Imported MCP" })).toBeVisible();

  await page.locator("#mcp-global-enabled").click();
  await expect(page.locator("#mcp-global-state")).toHaveText("已暂停");
  await page.locator("#mcp-global-enabled").click();
  await expect(page.locator("#mcp-global-state")).toHaveText("已启用");

  await page.getByRole("button", { name: "展开 MCP 服务器 PostgreSQL" }).click();
  await expect(page.locator(".mcp-server-row").filter({ hasText: "PostgreSQL" }).locator(".mcp-server-details")).toBeVisible();

  await page.getByRole("button", { name: "编辑 MCP 服务器 PostgreSQL" }).click();
  await expect(page.locator("#mcp-editor")).toBeVisible();
  expect(errors).toEqual([]);
});

test("MCP 测试连接：点击后立即显示测试中，成功与失败结果就地展示", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);

  const created = await page.evaluate(async (body) => {
    const res = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  }, { id: "echo_test", name: "Echo Test", command: process.execPath, args: [ECHO_FIXTURE], enabled: true });
  expect(created).toBe(200);

  await page.locator("#settings-btn").click();
  await page.locator('[data-settings-view="mcp"]').click();
  const row = page.locator(".mcp-server-row").filter({ hasText: "Echo Test" });
  await expect(row).toBeVisible();
  await row.locator(".mcp-expand-btn").click();
  await expect(row.locator(".mcp-server-details")).toBeVisible();

  // 人为拖慢测试请求，模拟 npx 冷启动；否则「测试中」状态快到无法断言。
  await page.route("**/api/mcp/*/test", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.continue();
  });
  const testButton = row.getByRole("button", { name: "测试 MCP 服务器 Echo Test" });
  await testButton.click();
  await expect(testButton).toBeDisabled();
  await expect(testButton).toContainText("测试中");
  await expect(row.locator(".mcp-test-result")).toContainText("正在测试连接");

  await expect(row.locator(".mcp-test-result")).toContainText("测试通过", { timeout: 20_000 });
  await expect(row.locator(".mcp-test-result")).toHaveClass(/ok/);
  await expect(row.locator(".mcp-tool-chip").filter({ hasText: "echo" })).toBeVisible();

  // 失败路径：命令不存在时也不能「点了没反应」，错误要显示在按钮旁。
  const broken = await page.evaluate(async () => {
    const res = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "echo_broken", name: "Broken Test", command: "not-an-mcp-command-xyz", args: [], enabled: true }),
    });
    return res.status;
  });
  expect(broken).toBe(200);
  // 设置页列表只在切分区/点刷新时重拉；新增服务器后手动刷新一次。
  await page.locator("#mcp-refresh-btn").click();
  const brokenRow = page.locator(".mcp-server-row").filter({ hasText: "Broken Test" });
  await expect(brokenRow).toBeVisible();
  await brokenRow.locator(".mcp-expand-btn").click();
  await brokenRow.getByRole("button", { name: "测试 MCP 服务器 Broken Test" }).click();
  await expect(brokenRow.locator(".mcp-test-result")).toContainText("测试失败", { timeout: 20_000 });
  await expect(brokenRow.locator(".mcp-test-result")).toHaveClass(/err/);

  // 删除临时 server 会断开连接，避免 MCP 子进程活到整轮 e2e 结束。
  for (const id of ["echo_test", "echo_broken"]) {
    await page.evaluate(async (serverId) => {
      await fetch(`/api/mcp/${serverId}`, { method: "DELETE" });
    }, id);
  }
  expect(errors).toEqual([]);
});
