/** subagents.spec.ts — 子代理设置页真实浏览器回归 */
import { expect, test } from "@playwright/test";
import { login, selectAntdvOption, antdvSelectText } from "./helpers.js";

test("子代理：搜索筛选、样式产物、继承模型创建、固定模型、启停、编辑与删除", async ({ page }) => {
  await login(page);
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-page")).toBeVisible();
  await page.locator('[data-settings-view="subagents"]').click();
  await expect(page.locator("#settings-view-subagents")).toBeVisible();
  await expect(page.locator("#subagents-list")).toContainText("通用子代理");
  await expect(page.locator("#subagents-list")).toContainText("房产找房子代理");
  // 求职子代理也是内置项：它与会话形态的「求职岗位 Agent」是两套机制，缺了会静默半残
  await expect(page.locator("#subagents-list")).toContainText("求职岗位子代理");
  await expect(page.locator("#subagent-stat-total")).toHaveText("3");
  await expect(page.locator("#subagent-stat-enabled")).toHaveText("3");

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
  const descriptionLayout = await page.locator("#subagent-description").evaluate((element) => {
    const field = element.parentElement!;
    const style = getComputedStyle(element);
    return {
      textareaWidth: element.getBoundingClientRect().width,
      fieldWidth: field.getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      resize: style.resize,
    };
  });
  // 原生 textarea 约 20 列宽会把表单切出一条窄框；宽度必须跟随字段容器，只允许纵向缩放。
  expect(Math.abs(descriptionLayout.textareaWidth - descriptionLayout.fieldWidth)).toBeLessThan(1.5);
  expect(descriptionLayout.scrollWidth).toBeLessThanOrEqual(descriptionLayout.clientWidth + 1);
  expect(descriptionLayout.resize).toBe("vertical");
  await page.locator("#subagent-name").fill("E2E 研究代理");
  await page.locator("#subagent-description").fill("用于 E2E 验证的独立研究任务");
  expect(await antdvSelectText(page, "#subagent-model-mode")).toBe("继承当前主对话模型（推荐）");
  await selectAntdvOption(page, "#subagent-model-mode", "固定供应商与模型");
  await expect(page.locator("#subagent-model-picker")).toBeVisible();
  // antdv Select 的选项在浮层里（点开才渲染），断言「已有可用选中值」
  // —— 与原 not.toHaveCount(0) 的意图一致：下拉不是空的。
  expect(await antdvSelectText(page, "#subagent-provider")).not.toBe("");
  expect(await antdvSelectText(page, "#subagent-model")).not.toBe("");
  await page.locator("#subagent-save-btn").click();
  await expect(page.locator("#subagent-editor")).toBeHidden();

  const card = page.locator(".subagent-card").filter({ hasText: "E2E 研究代理" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("固定 ·");
  await expect(card).toContainText("运行时授权工具");
  // 子代理启停改 antdv Switch（<button role="switch">），用 click 而不是 uncheck/check。
  // Switch 是受控组件：点击后要等 PATCH 回来、store 更新，aria-checked 才翻转。
  const agentSwitch = card.locator('.subagent-switch [role="switch"]');
  await agentSwitch.click();
  await expect(agentSwitch).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
  await expect(card).toContainText("已停用");
  await agentSwitch.click();
  await expect(agentSwitch).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
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
