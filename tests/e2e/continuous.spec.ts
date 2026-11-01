/** continuous.spec.ts — 连续工作模式开关的真实浏览器回归 */
import { expect, test } from "@playwright/test";
import { login } from "./helpers.js";

test("连续模式：chip 开关、aria 状态与刷新后保持", async ({ page }) => {
  await login(page);
  const chip = page.locator("#cm-continuous");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip).toHaveClass(/cm-chip on/);
  await expect(page.locator(".ui-toast").first()).toContainText("连续工作模式已开启");

  // 用户级偏好：刷新后不丢（saveLocal 是 300ms 防抖写，先等 localStorage 落盘再刷）
  await page.waitForFunction(() => localStorage.getItem("lg-agent-continuous") === "1");
  await page.reload();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(chip).not.toHaveClass(/on/);
});
