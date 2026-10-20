/**
 * tests/unit/files.test.ts — 文件上下文授权与读取防线
 * ============================================================
 * 守 AGENTS §5.2：路径必须先 resolve 再按授权前缀校验；目录浏览跳过
 * SKIPPED_DIRS；读取拒绝二进制与超长（截断而非拒绝）。
 * 测试全部落在系统临时目录，不碰仓库真实文件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  assertAuthorized,
  authorizeRoot,
  listDir,
  readFileAuthorized,
  unauthorizeRoot,
} from "../../src/server/files.js";

let root = "";
let outside = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "lg-agent-files-"));
  outside = mkdtempSync(join(tmpdir(), "lg-agent-outside-"));
  writeFileSync(join(root, "note.txt"), "你好，世界", "utf8");
  writeFileSync(join(root, "bin.dat"), "abc\u0000def", "utf8");
  writeFileSync(join(outside, "secret.txt"), "不该被读到", "utf8");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "x.js"), "x", "utf8");
  authorizeRoot(root, "测试根");
});

after(() => {
  unauthorizeRoot(root);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("assertAuthorized：授权根内放行，根外拒绝", () => {
  assert.doesNotThrow(() => assertAuthorized(join(root, "note.txt")));
  assert.throws(() => assertAuthorized(join(outside, "secret.txt")), /路径未授权/);
});

test("assertAuthorized：前缀相似但不属于根的路径被拒绝", () => {
  assert.throws(() => assertAuthorized(root + "-sibling"), /路径未授权/);
});

test("listDir：列目录并跳过 SKIPPED_DIRS（node_modules 不出现）", async () => {
  const result = await listDir(root);
  const names = result.entries.map((e) => e.name);
  assert.ok(names.includes("note.txt"));
  assert.ok(!names.includes("node_modules"));
  assert.ok(result.roots.some((r) => r.path === root));
});

test("listDir：未授权目录抛中文错误", async () => {
  await assert.rejects(listDir(outside), /路径未授权/);
});

test("readFileAuthorized：正常文本可读", async () => {
  const file = await readFileAuthorized(join(root, "note.txt"));
  assert.equal(file.content, "你好，世界");
  assert.equal(file.truncated, false);
});

test("readFileAuthorized：二进制（含 \\0）标记 binary 且不返回内容", async () => {
  const file = await readFileAuthorized(join(root, "bin.dat"));
  assert.equal(file.binary, true);
  assert.equal(file.content, "");
});

test("readFileAuthorized：未授权路径拒绝", async () => {
  await assert.rejects(readFileAuthorized(join(outside, "secret.txt")), /路径未授权/);
});
