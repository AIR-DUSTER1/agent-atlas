/**
 * ============================================================
 * playwright.config.ts — 浏览器 E2E 配置
 * ============================================================
 * 本地优先使用已安装 Chrome；CI 用 Playwright Chromium。webServer 只启动
 * tests/e2e/start-server.ts 的临时 mock 服务，不读取真实密钥。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number(process.env.E2E_PORT || 3467);
const localChrome = process.env.PLAYWRIGHT_CHROME_PATH || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "");
const executablePath = localChrome && existsSync(localChrome) ? localChrome : undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 35_000,
  expect: { timeout: 12_000 },
  retries: process.env.CI ? 1 : 0,
  outputDir: join(ROOT, "test-results"),
  reporter: [
    ["list"],
    ["html", { outputFolder: join(ROOT, "playwright-report"), open: "never" }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",

    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node --import tsx tests/e2e/start-server.ts",
    cwd: ROOT,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_PORT: String(PORT) },
  },
});
