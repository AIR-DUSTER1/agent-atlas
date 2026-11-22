import { expect, type Page } from "@playwright/test";

export const E2E_TOKEN = "e2e-login-token-123456";

export async function login(page: Page): Promise<void> {
  await page.goto("/");
  const input = page.locator("#ui-dialog-input");
  // 本机直连会静默建立设备会话；只有模拟公网新设备时才需要首次配对。
  await page.waitForFunction(() => {
    if (document.documentElement.dataset.appReady === "true") return true;
    const dialogInput = document.querySelector<HTMLElement>("#ui-dialog-input");
    return Boolean(dialogInput && dialogInput.offsetParent !== null);
  });
  if (await input.isVisible()) {
    await input.fill(E2E_TOKEN);
    await page.locator("#ui-dialog-ok").click();
    await expect(input).toBeHidden();
  }
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page.locator("#new-chat-btn")).toBeVisible();
}

export async function createChat(page: Page): Promise<void> {
  await page.locator("#new-chat-btn").click();
  const modal = page.locator("#modal-mask");
  const modalCard = page.locator("#modal-cards .demo-card").first();
  const pageCard = page.locator("#demo-cards .demo-card").first();
  if (await modal.isVisible()) {
    await expect(modalCard).toBeVisible();
    await modalCard.click();
  } else {
    // 没有项目时首屏直接显示 Agent 选择页；这不是错误降级，也无需再套一层弹窗。
    await expect(pageCard).toBeVisible();
    await pageCard.click();
  }
  await expect(modal).toBeHidden();
  await expect(page.locator("#input")).toBeVisible();
  await expect(page.locator("#input")).toBeEnabled();
}

export async function sendMessage(page: Page, message: string): Promise<void> {
  await page.locator("#input").fill(message);
  await page.locator("#send-btn").click();
}

/**
 * 选择 antdv Select 的选项。
 * 为什么需要 helper：antdv Select 渲染的是 `<input role="combobox">` + 浮层，
 * 不是原生 `<select>` —— Playwright 的 `selectOption()` 完全用不了。
 * `id` 落在内部 input 上，直接点它即可展开（真实浏览器实测可行）；
 * 选项是 `.ant-select-item-option`，用 `title` 文本定位最稳（含中文/括号）。
 */
export async function selectAntdvOption(page: Page, selectId: string, optionText: string): Promise<void> {
  const id = selectId.startsWith("#") ? selectId.slice(1) : selectId;
  await page.locator(`#${id}`).click();
  await page.locator(`.ant-select-item-option[title="${optionText}"]`).click();
}

/** 读取 antdv Select 当前显示文案（它没有原生 value 可读，只能读展示层）。 */
export async function antdvSelectText(page: Page, selectId: string): Promise<string> {
  const id = selectId.startsWith("#") ? selectId.slice(1) : selectId;
  return (await page.locator(`#${id}`).locator("xpath=..").getAttribute("title")) ?? "";
}
