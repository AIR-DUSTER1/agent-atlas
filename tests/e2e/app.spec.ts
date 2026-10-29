/**
 * app.spec.ts — 真实浏览器主流程
 * ============================================================
 * 覆盖登录、设置导航、供应商弹窗关闭、新建会话、消息发送、刷新恢复、
 * 人工审批折叠且只保留一个头像、停止流与退出登录。
 */
import { expect, test } from "@playwright/test";
import { createChat, login, sendMessage } from "./helpers.js";

test("登录、设置分区、供应商弹窗与退出", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);

  const beforeTheme = await page.locator("html").getAttribute("data-theme");
  await page.locator("#theme-btn").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", beforeTheme ?? "dark");

  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-page")).toBeVisible();
  await page.locator('[data-settings-view="models"]').click();
  await expect(page.locator("#provider-list")).toBeVisible();
  await page.locator("#add-provider-btn").click();
  await expect(page.locator("#provider-modal")).toBeVisible();
  await page.locator("#provider-modal-close").click();
  await expect(page.locator("#provider-modal")).toBeHidden();

  await page.locator('[data-settings-view="plugins"]').click();
  await expect(page.locator("#plugins-panel")).toBeVisible();
  await expect(page.locator("#plugin-list")).toContainText(/RAG|MCP/);
  await page.locator("#settings-back-btn").click();
  await expect(page.locator("#settings-page")).toBeHidden();

  await page.locator("#settings-btn").click();
  await page.locator("#settings-logout-btn").click();
  await expect(page.locator("#ui-dialog-ok")).toBeVisible();
  await page.locator("#ui-dialog-ok").click();
  await expect(page.locator("#ui-dialog-input")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("会话发送、刷新恢复、人工审批折叠且只出现一个助手头像", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  await createChat(page);
  await sendMessage(page, "你好");
  await expect(page.locator(".msg-assistant").last()).toContainText("模拟模式", { timeout: 20_000 });
  await expect(page.locator("#stop-btn")).toBeHidden();

  await page.reload();
  await expect(page.locator("#ui-dialog-input")).toBeHidden();
  await expect(page.locator(".msg-assistant").last()).toContainText("模拟模式", { timeout: 20_000 });

  await createChat(page);
  await sendMessage(page, "给 boss@example.com 发一封邮件，主题是项目进度");
  await expect(page.getByRole("button", { name: "✓ 批准并执行" }).last()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "✓ 批准并执行" }).last().click();
  await expect(page.locator(".msg-assistant").last()).toContainText("邮件已按你的批准发送完成", { timeout: 20_000 });
  await expect(page.locator(".approval-card.collapsed")).toHaveCount(1);
  await expect(page.locator(".msg-assistant").last().locator(".avatar")).toHaveCount(1);
  await page.locator(".approval-card .approval-summary").click();
  await expect(page.locator(".approval-card")).not.toHaveClass(/collapsed/);
  expect(pageErrors).toEqual([]);
});

test("新建会话不继承上一会话的上下文用量显示", async ({ page }) => {
  await login(page);
  await createChat(page);
  await sendMessage(page, "你好");
  await expect(page.locator("#context-bar")).toBeVisible({ timeout: 20_000 });
  // 容量条显示该会话落盘的当前上下文与最近一次请求量，不能混用任务累计消耗。
  await expect(page.locator("#ctx-text")).toContainText("当前会话上下文");
  await expect(page.locator("#ctx-text")).toContainText("请求 ↑");
  await expect(page.locator("#ctx-text")).toContainText("模型窗口");
  await expect(page.locator("#ctx-text")).toContainText("输出预留");

  await createChat(page);
  await expect(page.locator("#context-bar")).toBeHidden();
});

test("流式停止按钮可中断生成并恢复输入", async ({ page }) => {
  await login(page);
  await createChat(page);
  await sendMessage(page, "帮我查北京天气，然后写一首关于春夏秋冬的长诗");
  await expect(page.locator("#stop-btn")).toBeVisible({ timeout: 10_000 });
  await page.locator("#stop-btn").click();
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#send-btn")).toBeVisible();
  await expect(page.locator("#composer-hint")).toBeVisible();
});

test("多个会话可并行生成，切换会话不弹等待框", async ({ page }) => {
  await login(page);
  await page.route("**/api/chat", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  await createChat(page); // 会话 A
  await createChat(page); // 会话 B（最新项，索引 0）

  const items = page.locator("#session-list .session-item");
  await items.nth(1).click(); // 切回 A
  await sendMessage(page, "并发任务一：请写一段较长的自我介绍");
  await expect(page.locator("#stop-btn")).toBeVisible();

  await items.nth(0).click(); // A 仍生成时切到 B
  await expect(items.nth(0)).toHaveClass(/active/);
  await expect(page.locator("#ui-dialog-mask")).toBeHidden();
  await expect(page.locator("#send-btn")).toBeVisible();
  await expect(page.locator("#stop-btn")).toBeHidden();

  await sendMessage(page, "并发任务二：请写一首短诗");
  await expect(page.locator("#stop-btn")).toBeVisible();
  await expect(page.locator("#session-list .s-running")).toHaveCount(2);

  await items.nth(1).click(); // 回到仍在生成的 A
  await expect(page.locator("#stop-btn")).toBeVisible();
  await page.locator("#stop-btn").click();
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 10_000 });

  await items.nth(0).click();
  await expect(page.locator("#stop-btn")).toBeVisible();
  await page.locator("#stop-btn").click();
  await expect(page.locator("#stop-btn")).toBeHidden({ timeout: 10_000 });
});

test("100KB Markdown 用户消息换行正常且不撑破容器", async ({ page }) => {
  await login(page);
  const message = "# 负载测试标题\n".repeat(18_000);
  const result = await page.evaluate(async (text) => {
    const created = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "agent" }),
    });
    const session = await created.json() as { id: string };
    const chat = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, message: text }),
    });
    const body = await chat.text();
    return { created: created.status, chat: chat.status, done: body.includes('"type":"done"') };
  }, message);
  expect(result).toEqual({ created: 200, chat: 200, done: true });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await page.locator("#session-list .session-item").first().click();
  const userBlock = page.locator(".msg-user").last();
  await expect(userBlock).toBeVisible();
  expect((await userBlock.textContent())?.length).toBeGreaterThan(100_000);
  const metrics = await userBlock.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    scrollWidth: element.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(Math.ceil(metrics.width) + 2);
});
test("记忆插槽设置：local 状态、scope 隔离、导出导入与 HTTP 失败提示", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  await page.locator("#settings-btn").click();
  await page.locator('[data-settings-view="memories"]').click();
  await expect(page.locator("#memories-modal")).toBeVisible();
  await expect(page.locator("#mem-health-badge")).toHaveText("可用", { timeout: 15_000 });
  await expect(page.locator("#mem-active-provider")).toHaveValue("local");

  await page.locator("#mem-key").fill("E2E 记忆偏好");
  await page.locator("#mem-content").fill("回答先给结论，再给依据");
  await page.locator("#mem-add-btn").click();
  await expect(page.locator("#memories-list")).toContainText("E2E 记忆偏好", { timeout: 10_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#mem-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^memories-general-\d{4}-\d{2}-\d{2}\.json$/);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  await page.locator("#mem-profile-filter").selectOption("estate");
  await expect(page.locator("#memories-list")).not.toContainText("E2E 记忆偏好");
  await page.locator("#mem-import-mode").selectOption("replace");
  await page.locator("#mem-import-file").setInputFiles(downloadPath!);
  await expect(page.locator("#ui-dialog-ok")).toBeVisible();
  await page.locator("#ui-dialog-ok").click();
  await expect(page.locator("#memories-list")).toContainText("E2E 记忆偏好", { timeout: 10_000 });

  await page.locator("#mem-http-enabled").check();
  await page.locator("#mem-http-base-url").fill("http://127.0.0.1:1");
  await page.locator("#mem-http-timeout").fill("500");
  await page.locator("#mem-test-http-btn").click();
  await expect(page.locator("#mem-http-status")).toContainText(/连接失败|无法连接|超时/, { timeout: 10_000 });
  expect(pageErrors).toEqual([]);
});
test("技能文件可上传、禁用并在刷新后保持状态", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i += 1) {
      await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{
            name: `seed-skill-${i}.md`,
            content: `---\nname: Z 技能 ${i}\ndescription: 用于验证技能分页\ntriggers: 分页${i}\n---\n分页验证正文 ${i}`,
          }],
          overwrite: false,
        }),
      });
    }
  });
  await page.locator("#settings-btn").click();
  await page.locator('[data-settings-view="skills"]').click();
  await expect(page.locator("#skills-modal")).toBeVisible();
  await expect(page.locator("#skill-create-btn")).toHaveCount(0);
  await expect(page.locator("#skill-editor-details summary")).toContainText("编辑现有技能");
  await page.locator("#skills-search").fill("不存在的技能");
  await expect(page.locator("#skills-list")).toContainText("没有匹配的技能");
  await page.locator("#skills-search").fill("");

  const file = {
    name: "e2e-upload-skill.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(`---\nname: E2E 上传技能\ndescription: 浏览器上传回归\ntriggers: e2e技能\n---\n# 执行规则\n上传后应出现在技能列表。\n`),
  };
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#skill-upload-btn").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
  const row = page.locator(".skill-card").filter({ hasText: "E2E 上传技能" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#skills-pagination")).toBeVisible();
  const toggle = page.getByRole("checkbox", { name: "启用技能 E2E 上传技能" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await page.locator('[data-skill-filter="disabled"]').click();
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/disabled/);
  await expect(row).toContainText("已禁用");
  await page.locator("#skills-refresh-btn").click();
  await expect(row).toBeVisible();

  const persisted = await page.evaluate(async () => {
    const response = await fetch("/api/skills");
    return await response.json() as { skills?: Array<{ id: string; enabled: boolean }> };
  });
  expect(persisted.skills?.find((skill) => skill.id === "e2e-upload-skill")?.enabled).toBe(false);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await page.locator("#settings-btn").click();
  await page.locator('[data-settings-view="skills"]').click();
  await page.locator('[data-skill-filter="disabled"]').click();
  const reloadedRow = page.locator(".skill-card").filter({ hasText: "E2E 上传技能" });
  await expect(reloadedRow).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("checkbox", { name: "启用技能 E2E 上传技能" })).not.toBeChecked();
  expect(pageErrors).toEqual([]);
});
