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
  // 前端必须同时展示「当前请求上下文」与「任务累计消耗」，避免把 26.9k
  // 误认为整个任务只消耗了 26.9k；工具次数也应可见。
  await expect(page.locator("#ctx-text")).toContainText("任务累计");

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
