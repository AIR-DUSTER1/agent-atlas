import { expect, type Page } from "@playwright/test";

export const E2E_TOKEN = "e2e-login-token-123456";

export async function login(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator("#ui-dialog-input");
  await expect(input).toBeVisible();
  await input.fill(E2E_TOKEN);
  await page.locator("#ui-dialog-ok").click();
  await expect(page.locator("#ui-dialog-input")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page.locator("#new-chat-btn")).toBeVisible();
}

export async function createChat(page: Page): Promise<void> {
  await page.locator("#new-chat-btn").click();
  await expect(page.locator("#modal-cards .demo-card").first()).toBeVisible();
  await page.locator("#modal-cards .demo-card").first().click();
  await expect(page.locator("#modal-mask")).toBeHidden();
  await expect(page.locator("#input")).toBeVisible();
  await expect(page.locator("#input")).toBeEnabled();
}

export async function sendMessage(page: Page, message: string): Promise<void> {
  await page.locator("#input").fill(message);
  await page.locator("#send-btn").click();
}
