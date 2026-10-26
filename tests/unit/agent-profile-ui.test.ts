/**
 * agent-profile-ui.test.ts — 前端 Agent profile 元数据回归
 * ============================================================
 * UI 只依赖 agentProfileId 的展示契约；legacy kind 仍可回退，未知值不能伪装成通用 Agent。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientFiles, readClientSource } from "../helpers/client-source.js";
import {
  AGENT_PROFILES,
  agentProfileMeta,
  profileMetaForSession,
} from "../../src/client/modules/agent-profile.js";

test("前端 profile 元数据区分通用与租房/房产 Agent", () => {
  assert.equal(AGENT_PROFILES.general.shortLabel, "通用");
  assert.equal(AGENT_PROFILES.estate.shortLabel, "找房");
  assert.match(AGENT_PROFILES.estate.label, /租房/);
  assert.match(AGENT_PROFILES.estate.description, /贝壳/);
});

test("agentProfileId 优先，旧 kind 可兼容，未知身份不默认成通用 Agent", () => {
  assert.equal(profileMetaForSession({ agentProfileId: "estate", kind: "agent" })?.id, "estate");
  assert.equal(profileMetaForSession({ kind: "agent" })?.id, "general");
  assert.equal(profileMetaForSession({ kind: "estate" })?.id, "estate");
  assert.equal(profileMetaForSession({ agentProfileId: "evil", kind: "agent" })?.id, "general");
  assert.equal(agentProfileMeta("evil"), null);
  assert.equal(profileMetaForSession({ kind: "unknown" }), null);
});


test("全局 Esc 使用 ui-dialog 导出函数，不引用模块私有实现", async () => {
  const main = await readClientFiles(["main.ts"]);
  const dialog = await readFile(new URL("../../src/client/modules/ui-dialog.ts", import.meta.url), "utf8");
  // 前端已 TypeScript 化：Esc 兜底走具名导入（模块路径带 .js 后缀，浏览器原生 ESM）
  assert.match(main, /import \{[^}]*cancelActiveDialog[^}]*\} from "\.\/modules\/ui-dialog\.js"/);
  assert.match(main, /cancelActiveDialog\(\);/);
  // 消费方不得直接调模块私有实现（uiDialogFinish 不导出）
  assert.doesNotMatch(main, /uiDialogFinish\(/);
  assert.match(dialog, /export function cancelActiveDialog\(/);
});
