/** continuous.spec.ts — /goal 命令与 Goal 徽标的真实浏览器回归 */
import { expect, test } from "@playwright/test";
import { createChat, login } from "./helpers.js";

test("goal 命令：菜单选中转徽标、手打前缀自动转换、裸命令提示、发送携带 continuous", async ({ page }) => {
  await login(page);
  await createChat(page);
  const input = page.locator("#input");
  const chip = page.locator("#goal-chip");
  await expect(input).toBeEnabled();
  await expect(chip).toBeHidden();

  // 菜单路径：输入部分前缀 /go 唤出命令菜单，选中「连续任务」→ Goal 徽标出现，
  // 正文为空（前缀语义由徽标承载，不再是纯文本）
  await input.fill("/go");
  await expect(page.locator("#composer-menu")).toBeVisible();
  await page.locator(".composer-item", { hasText: "连续任务" }).first().click();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Goal");
  await expect(chip.locator("svg")).toBeVisible(); // Target 图标
  await expect(input).toHaveValue("");

  // 徽标模式下空文本发送 → 用法提示，不产生消息
  await input.press("Enter");
  await expect(page.locator(".ui-toast").first()).toContainText("先描述");

  // 手打完整 /goal 前缀 → 输入事件直接转徽标（不再走菜单），正文剥掉前缀
  await input.fill("/goal 把 README 里的错别字清一遍");
  await expect(chip).toBeVisible();
  await expect(input).toHaveValue("把 README 里的错别字清一遍");

  // 发送：请求体 continuous:true、message 为纯任务文本；发送后徽标退出
  const bodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/chat", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.continue();
  });
  await input.press("Enter");
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(bodies[0]?.continuous).toBe(true);
  expect(bodies[0]?.message).toBe("把 README 里的错别字清一遍");
  await expect(page.locator(".msg-user").first()).toContainText("把 README 里的错别字清一遍");
  await expect(chip).toBeHidden();
  await expect(input).toHaveValue("");

  // 点徽标可退出：再进一次 → 点击 → 徽标消失
  await input.fill("/goal 再来一个任务");
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toBeHidden();
  await expect(input).toHaveValue("再来一个任务");
});
