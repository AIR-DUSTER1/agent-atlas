/** subagents.spec.ts — 子代理设置页真实浏览器回归 */
import { expect, test } from "@playwright/test";
import { login } from "./helpers.js";

test("子代理：继承模型创建、固定模型、启停、编辑与删除", async ({ page }) => {
  await login(page);
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-page")).toBeVisible();
  await page.locator('[data-settings-view="subagents"]').click();
  await expect(page.locator("#settings-view-subagents")).toBeVisible();
  await expect(page.locator("#subagents-list")).toContainText("通用子代理");
  await expect(page.locator("#subagents-list")).toContainText("房产找房子代理");

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
  await card.locator(".subagent-switch input").uncheck();
  await expect(card).toContainText("已停用");
  await card.locator(".subagent-switch input").check();
  await expect(card).toContainText("已启用");

  await card.locator("button", { hasText: "编辑" }).click();
  await expect(page.locator("#subagent-editor")).toBeVisible();
  await page.locator("#subagent-name").fill("E2E 研究代理-已编辑");
  await page.locator("#subagent-save-btn").click();
  await expect(page.locator("#subagent-editor")).toBeHidden();
  const edited = page.locator(".subagent-card").filter({ hasText: "E2E 研究代理-已编辑" });
  await expect(edited).toBeVisible();

  await edited.locator("button", { hasText: "编辑" }).click();
  await page.locator("#subagent-delete-btn").click();
  await expect(page.locator("#ui-dialog")).toBeVisible();
  await page.locator("#ui-dialog-ok").click();
  await expect(page.locator("#subagent-editor")).toBeHidden();
  await expect(page.locator(".subagent-card").filter({ hasText: "E2E 研究代理-已编辑" })).toHaveCount(0);
});
