/**
 * mcp.spec.ts — MCP Servers 页面真实浏览器回归
 * ============================================================
 * 覆盖列表状态、单服务器启停、全局暂停、编辑弹窗、添加与 .mcp.json 导入。
 * 测试服务使用临时配置，所有命令仅为 `node --version`，不触网也不启动常驻进程。
 */
import { expect, test } from "@playwright/test";
import { login } from "./helpers.js";

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
  await page.locator("#mcp-id").fill("chrome-devtools");
  await page.locator("#mcp-name").fill("Chrome DevTools MCP");
  await page.locator("#mcp-command").fill("node");
  await page.locator("#mcp-args").fill("--version");
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