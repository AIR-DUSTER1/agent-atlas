/**
 * project-picker.test.ts — 本地项目目录系统选择器回归
 * ============================================================
 * 守：Electron 走原生 dialog、浏览器走本机服务端系统对话框、取消不报错，
 * 且前端不再默认弹出手输绝对路径的表单。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildWindowsPickerScript,
  isDirectoryPickerCancel,
} from "../../src/server/directory-picker.js";

const root = new URL("../../", import.meta.url);

test("Windows 目录选择脚本使用系统 FolderBrowserDialog，取消码单独处理", () => {
  const script = buildWindowsPickerScript();
  assert.match(script, /System\.Windows\.Forms/);
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /ShowDialog\(\)/);
  assert.match(script, /DialogResult\]::OK/);
  assert.match(script, /exit 2/);

  assert.equal(isDirectoryPickerCancel({ code: 2 }, "win32"), true);
  assert.equal(isDirectoryPickerCancel({ code: 1, message: "script failed" }, "win32"), false);
  assert.equal(isDirectoryPickerCancel({ code: 1 }, "linux"), true);
  assert.equal(isDirectoryPickerCancel(new Error("User canceled")), true);
});

test("Electron 与浏览器两条目录选择链路都已接线", async () => {
  const [main, preload, projects, route, index, serverProjects] = await Promise.all([
    readFile(new URL("desktop/main.ts", root), "utf8"),
    readFile(new URL("desktop/preload.ts", root), "utf8"),
    readFile(new URL("src/client/views/projects.ts", root), "utf8"),
    readFile(new URL("src/server/routes/projects.ts", root), "utf8"),
    readFile(new URL("src/server/index.ts", root), "utf8"),
    readFile(new URL("src/server/projects.ts", root), "utf8"),
  ]);
  assert.match(main, /ipcMain\.handle\("desktop:pick-directory"/);
  assert.match(main, /dialog\.showOpenDialog/);
  assert.match(main, /"openDirectory"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:pick-directory"\)/);
  assert.match(projects, /pickLocalProjectDirectory/);
  assert.match(projects, /\/api\/projects\/pick-directory/);
  assert.match(projects, /添加本地文件夹（系统选择）/);
  assert.match(projects, /是否改为手动输入服务器绝对路径/);
  assert.doesNotMatch(serverProjects, /name:\s*"agentatlas"/);
  assert.match(serverProjects, /projects = \[\];/);
  assert.match(projects, /其会话会归入「未归属」/);
  assert.match(route, /pickDirectory\(\)/);
  assert.match(index, /handlePickProjectDirectory/);
});