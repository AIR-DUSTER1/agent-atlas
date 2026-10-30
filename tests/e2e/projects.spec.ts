/**
 * projects.spec.ts — 本地项目目录系统选择回归
 * ============================================================
 * 真实浏览器只验证前端选择链路：系统对话框接口被替换为固定目录，
 * 随后仍走真实 /api/projects 授权与项目切换，避免自动化测试卡在原生窗口。
 */
import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { login } from "./helpers.js";

test("添加本地文件夹先打开系统目录选择接口，不再弹出手输路径框", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);

  const selectedPath = resolve("tests/e2e");
  let pickerCalls = 0;
  await page.route("**/api/projects/pick-directory", async (route) => {
    pickerCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ canceled: false, path: selectedPath }),
    });
  });

  await page.locator("#project-btn").click();
  await expect(page.locator("#project-menu")).not.toContainText("learn-agent");
  await page.getByRole("menuitem", { name: /添加本地文件夹（系统选择）/ }).click();

  await expect(page.locator("#project-btn-text")).toHaveText("e2e");
  await expect(page.locator("#ui-dialog-input")).toBeHidden();
  expect(pickerCalls).toBe(1);
  expect(pageErrors).toEqual([]);
});
test("目录选择框已经打开时提示切回系统窗口，不降级成手动路径", async ({ page }) => {
  await login(page);

  let pickerCalls = 0;
  await page.route("**/api/projects/pick-directory", async (route) => {
    pickerCalls += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "DIRECTORY_PICKER_BUSY",
        error: "系统目录选择框已经在桌面上打开，请切换到「浏览文件夹」窗口完成选择",
      }),
    });
  });

  await page.locator("#project-btn").click();
  await page.getByRole("menuitem", { name: /添加本地文件夹（系统选择）/ }).click();

  await expect(page.getByText(/系统目录选择框已经在桌面上打开/)).toBeVisible();
  await expect(page.getByText(/是否改为手动输入服务器绝对路径/)).toBeHidden();
  await expect(page.locator("#ui-dialog-input")).toBeHidden();
  expect(pickerCalls).toBe(1);
});
