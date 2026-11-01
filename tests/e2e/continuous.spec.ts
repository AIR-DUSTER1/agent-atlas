/** continuous.spec.ts — /goal 连续任务命令的真实浏览器回归 */
import { expect, test } from "@playwright/test";
import { createChat, login } from "./helpers.js";

test("goal 命令：菜单命中、选中填充、裸命令提示、发送携带 continuous 且消息干净", async ({ page }) => {
  await login(page);
  await createChat(page);
  const input = page.locator("#input");
  await expect(input).toBeEnabled();

  // 输入 / 触发命令菜单，goal 可被命中并选中
  await input.fill("/goal");
  const menu = page.locator("#composer-menu");
  await expect(menu).toBeVisible();
  const goalItem = page.locator(".composer-item", { hasText: "连续任务" }).first();
  await expect(goalItem).toBeVisible();
  await goalItem.click();
  await expect(input).toHaveValue("/goal ");

  // 裸 /goal：只提示用法，不产生新消息
  await input.press("Enter");
  await expect(page.locator(".ui-toast").first()).toContainText("用法");

  // 带任务发送：请求体 continuous:true，message 是去掉命令前缀的纯任务文本
  const bodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/chat", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.continue();
  });
  await input.fill("/goal 把 README 里的错别字清一遍");
  await input.press("Enter");
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(bodies[0]?.continuous).toBe(true);
  expect(bodies[0]?.message).toBe("把 README 里的错别字清一遍");
  // 对话里用户块显示的也是纯任务文本，不是带 /goal 前缀的原文
  await expect(page.locator(".msg-user").first()).toContainText("把 README 里的错别字清一遍");
});
