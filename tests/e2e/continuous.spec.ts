/** continuous.spec.ts — /goal 命令与 Goal 徽标的真实浏览器回归（真实键盘路径） */
import { expect, test } from "@playwright/test";
import { createChat, login } from "./helpers.js";

test("goal 命令：键盘导航选中、徽标转换、裸命令提示、发送携带 continuous、退格退出", async ({ page }) => {
  await login(page);
  await createChat(page);
  const input = page.locator("#input");
  const chip = page.locator("#goal-chip");
  await expect(input).toBeEnabled();
  await expect(chip).toBeHidden();

  // 键盘路径：/go 唤出菜单 → ↓ 选中「连续任务」→ Enter 转徽标。
  // 回归：焦点若被菜单的文档级导航搬走，Enter 会落在无 click 处理的按钮上失灵
  await input.click();
  await page.keyboard.type("/go", { delay: 30 });
  await expect(page.locator("#composer-menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".composer-item.active")).toContainText("连续任务");
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Goal");
  await expect(chip.locator("svg")).toBeVisible(); // Target 图标
  await expect(input).toHaveValue("");

  // 徽标模式下空文本发送 → 用法提示，不产生消息
  await input.press("Enter");
  await expect(page.locator(".ui-toast").first()).toContainText("先描述");

  // 逐字手打 /goal 前缀 → 空格那一刻转徽标、前缀剥掉、打字节奏不被打断
  // （回归：前缀剥掉后输入框瞬时为空，「清空即退出」曾让徽标中途蒸发）。
  // 徽标已激活时再打一遍前缀，随后的空格会留在输入框 —— 仅显示层瞬时形态，send 首行 trim
  await input.click();
  await page.keyboard.type("/goal 把 README 里的错别字清一遍", { delay: 20 });
  await expect(chip).toBeVisible();
  await expect(input).toHaveValue(/\s*把 README 里的错别字清一遍/);

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

  // 退格回归：徽标 + 空输入按退格必须退出（空 textarea 不触发 input 事件，只能拦 keydown）
  await input.click();
  await page.keyboard.type("/goal ", { delay: 20 });
  await expect(chip).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(chip).toBeHidden();
});
