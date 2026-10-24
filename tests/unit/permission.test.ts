/**
 * tests/unit/permission.test.ts — 会话权限模式判定回归
 * ============================================================
 * 守语义：审批登记项 = 改世界操作 = 只读模式禁用项；
 * 三种模式对「登记 / 未登记」工具的裁决矩阵正确；
 * 不传模式时保持引入权限模式之前的默认（审批）行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveToolPermission,
  isPermissionMode,
  readonlyDenyText,
  permissionModeNote,
  PERMISSION_MODES,
} from "../../src/agent/permission.js";
import { generalApprovals } from "../../src/agent/approvals.js";
import type { ApprovalDescriptions } from "../../src/agent/profile.js";

const approvals: ApprovalDescriptions = {
  terminal: (a) => `执行 ${String(a.command)}`,
  write_file: (a) => `写入 ${String(a.path)}`,
  computer_click: (a) => `点击 ${String(a.x)},${String(a.y)}`,
  ...generalApprovals,
};

test("裁决矩阵：登记工具 readonly 拒 / approve 审批 / auto 直通", () => {
  for (const name of ["terminal", "write_file", "computer_click"]) {
    assert.equal(resolveToolPermission("readonly", name, approvals), "deny");
    assert.equal(resolveToolPermission("approve", name, approvals), "interrupt");
    assert.equal(resolveToolPermission("auto", name, approvals), "run");
  }
});

test("裁决矩阵：只读工具（未登记审批）三种模式都直接执行", () => {
  for (const mode of PERMISSION_MODES) {
    assert.equal(resolveToolPermission(mode, "read_file", approvals), "run");
    assert.equal(resolveToolPermission(mode, "computer_screenshot", approvals), "run");
    assert.equal(resolveToolPermission(mode, "calculator", approvals), "run");
  }
});

test("不传模式 = 默认审批行为（与引入权限模式之前完全一致）", () => {
  assert.equal(resolveToolPermission(undefined, "terminal", approvals), "interrupt");
  assert.equal(resolveToolPermission(undefined, "read_file", approvals), "run");
});

test("isPermissionMode 只接受三个合法值", () => {
  for (const ok of ["readonly", "approve", "auto"]) assert.equal(isPermissionMode(ok), true);
  for (const bad of ["yolo", "", null, undefined, 1, "READONLY"]) assert.equal(isPermissionMode(bad), false);
});

test("拒绝文案与权限注记面向模型可读", () => {
  assert.match(readonlyDenyText("terminal"), /只读/);
  assert.match(readonlyDenyText("terminal"), /terminal/);
  assert.match(readonlyDenyText("terminal"), /切回/);

  assert.match(permissionModeNote("readonly"), /只读/);
  assert.match(permissionModeNote("auto"), /自动执行/);
  // approve 是默认行为，不额外注入提示词
  assert.equal(permissionModeNote("approve"), "");
  assert.equal(permissionModeNote(undefined), "");
});
