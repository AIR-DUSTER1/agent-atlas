/**
 * tests/unit/tools-computer.test.ts — 电脑控制工具纯函数回归
 * ============================================================
 * 不做真实 PowerShell 执行（无桌面 CI 会话必挂），只守两件事：
 *   1. SendKeys 转义 / 组合键解析的语法正确性（错了会打到错误按键）；
 *   2. 工具集约定：截图只读不登记审批，动作类四个 computer_ 前缀且都登记审批。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeSendKeys, parseKeyCombo, COMPUTER_TOOL_NAMES } from "../../src/tools-computer.js";
import { generalProfile } from "../../src/agent/general.js";
import { generalApprovals } from "../../src/agent/approvals.js";
import { resolveToolPermission } from "../../src/agent/permission.js";

test("escapeSendKeys：特殊字符加大括号，换行/制表转键名", () => {
  assert.equal(escapeSendKeys("hello"), "hello");
  assert.equal(escapeSendKeys("a+b"), "a{+}b");
  assert.equal(escapeSendKeys("(x)^y%z~"), "{(}x{)}{^}y{%}z{~}");
  assert.equal(escapeSendKeys("a[b]{c}"), "a{[}b{]}{{}c{}}");
  assert.equal(escapeSendKeys("line1\nline2"), "line1{ENTER}line2");
  assert.equal(escapeSendKeys("col1\tcol2"), "col1{TAB}col2");
  assert.equal(escapeSendKeys("cr\r\n"), "cr{ENTER}");
});

test("parseKeyCombo：修饰键 + 单主键的合法组合", () => {
  assert.equal(parseKeyCombo("ctrl+s"), "^s");
  assert.equal(parseKeyCombo("ctrl+shift+t"), "^+t");
  assert.equal(parseKeyCombo("alt+f4"), "%{F4}");
  assert.equal(parseKeyCombo("enter"), "{ENTER}");
  assert.equal(parseKeyCombo("ESC"), "{ESC}");
  assert.equal(parseKeyCombo("f5"), "{F5}");
  assert.equal(parseKeyCombo("ctrl+PGDN"), "^{PGDN}");
  assert.equal(parseKeyCombo("shift+right"), "+{RIGHT}");
});

test("parseKeyCombo：非法组合返回 null（不给模型猜的机会）", () => {
  assert.equal(parseKeyCombo(""), null);
  assert.equal(parseKeyCombo("win+e"), null);          // 不支持徽标键
  assert.equal(parseKeyCombo("ctrl"), null);           // 只有修饰键
  assert.equal(parseKeyCombo("ctrl+s+t"), null);       // 两个主键
  assert.equal(parseKeyCombo("s+ctrl"), null);         // 修饰键在主键之后
  assert.equal(parseKeyCombo("ctrl+foo"), null);       // 未知键名
});

test("工具集约定：截图只读不登记审批，动作类四个都登记", () => {
  assert.ok(COMPUTER_TOOL_NAMES.every((name) => name.startsWith("computer_")));
  assert.ok(COMPUTER_TOOL_NAMES.includes("computer_screenshot"));

  // general profile 绑定了全部电脑工具
  for (const name of COMPUTER_TOOL_NAMES) {
    assert.ok(generalProfile.tools.some((t) => t.name === name), `general 缺工具：${name}`);
  }
  // 截图只读 → 不登记审批；点击/输入/按键/滚动 → 登记审批且受权限模式管控
  assert.equal("computer_screenshot" in generalApprovals, false);
  for (const name of ["computer_click", "computer_type", "computer_key", "computer_scroll"]) {
    assert.ok(name in generalApprovals, `审批文案缺：${name}`);
    assert.equal(resolveToolPermission("readonly", name, generalApprovals), "deny");
    assert.equal(resolveToolPermission("approve", name, generalApprovals), "interrupt");
  }
});
