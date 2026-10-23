/**
 * agent-profile-ui.test.ts — 前端 Agent profile 元数据回归
 * ============================================================
 * UI 只依赖 agentProfileId 的展示契约；legacy kind 仍可回退，未知值不能伪装成通用 Agent。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_PROFILES,
  agentProfileMeta,
  profileMetaForSession,
} from "../../src/server/public/modules/agent-profile.js";

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
