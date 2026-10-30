/** subagents.spec.ts — 子代理设置页真实浏览器回归 */
import { expect, test } from "@playwright/test";
import { login } from "./helpers.js";

test("子代理：搜索筛选、样式产物、继承模型创建、固定模型、启停、编辑与删除", async ({ page }) => {
  await login(page);
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-page")).toBeVisible();
  await page.locator('[data-settings-view="subagents"]').click();
  await expect(page.locator("#settings-view-subagents")).toBeVisible();
  await expect(page.locator("#subagents-list")).toContainText("通用子代理");
  await expect(page.locator("#subagents-list")).toContainText("房产找房子代理");
  await expect(page.locator("#subagent-stat-total")).toHaveText("2");
  await expect(page.locator("#subagent-stat-enabled")).toHaveText("2");

  // 守住样式产物：历史上 subagents.css 未进入 public/，页面会退化成裸文本。
  const firstCard = page.locator(".subagent-card").first();
  await expect(firstCard).toHaveCSS("display", "grid");
  await expect(firstCard.locator(".ui-icon svg").first()).toBeVisible();
  const layout = await page.locator("#subagents-panel").evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    cardBorder: getComputedStyle(element.querySelector(".subagent-card")!).borderLeftWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
  expect(layout.cardBorder).not.toBe("0px");

  await page.locator("#subagent-search").fill("房产");
  await expect(page.locator(".subagent-card")).toHaveCount(1);
  await expect(page.locator(".subagent-card")).toContainText("房产找房子代理");
  await page.locator("#subagent-search").fill("");
  await page.locator('[data-subagent-filter="disabled"]').click();
  await expect(page.locator(".subagent-card")).toHaveCount(0);
  await expect(page.locator("#subagents-empty-title")).toHaveText("没有匹配的子代理");
  await page.locator('[data-subagent-filter="all"]').click();

  await page.locator("#subagent-add-btn").click();
  await expect(page.locator("#subagent-editor")).toBeVisible();
  await page.locator("#subagent-name").fill("E2E 研究代理");
  await page.locator("#subagent-description").fill("用于 E2E 验证的独立研究任务");
  await expect(page.locator("#subagent-model-mode")).toHaveValue("inherit");
  await page.locator("#subagent-model-mode").selectOption("fixed");
  await expect(page.locator("#subagent-model-picker")).toBeVisible();
  await expect(page.locator("#subagent-provider option")).not.toHaveCount(0);
  await expect(page.locator("#subagent-model option")).not.toHaveCount(0);
  await page.locator("#subagent-save-btn").click();
  await expect(page.locator("#subagent-editor")).toBeHidden();

  const card = page.locator(".subagent-card").filter({ hasText: "E2E 研究代理" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("固定 ·");
  await expect(card).toContainText("运行时授权工具");
  await card.locator(".subagent-switch input").uncheck();
  await expect(card).toContainText("已停用");
  await card.locator(".subagent-switch input").check();
  await expect(card).toContainText("已启用");

  await card.locator("button", { hasText: "配置" }).click();
  await expect(page.locator("#subagent-editor")).toBeVisible();
  await page.locator("#subagent-name").fill("E2E 研究代理-已编辑");
  await page.locator("#subagent-save-btn").click();
  await expect(page.locator("#subagent-editor")).toBeHidden();
  const edited = page.locator(".subagent-card").filter({ hasText: "E2E 研究代理-已编辑" });
  await expect(edited).toBeVisible();

  await edited.locator("button", { hasText: "配置" }).click();
  await page.locator("#subagent-delete-btn").click();
  await expect(page.locator("#ui-dialog")).toBeVisible();
  await page.locator("#ui-dialog-ok").click();
  await expect(page.locator("#subagent-editor")).toBeHidden();
  await expect(page.locator(".subagent-card").filter({ hasText: "E2E 研究代理-已编辑" })).toHaveCount(0);
});
