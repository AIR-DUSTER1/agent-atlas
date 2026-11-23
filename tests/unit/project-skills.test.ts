/**
 * ============================================================
 * project-skills.test.ts — 工程规范分层与项目 Skill 守门
 * ============================================================
 * 验证常驻规范不膨胀、领域 Skill 可发现、权威链接存在且 UI 元数据合法。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENTS_MAX_BYTES,
  EXPECTED_SKILLS,
  SKILL_MAX_BYTES,
  SKILL_MAX_LINES,
  validateProjectSkills,
} from "../../scripts/project-skills.js";

test("项目规范分层：常驻 AGENTS 与领域 Skill 结构完整", async () => {
  const { issues, report } = await validateProjectSkills();
  assert.deepEqual(issues, []);
  assert.ok(report.agentsBytes <= AGENTS_MAX_BYTES, `AGENTS.md ${report.agentsBytes} bytes`);
  assert.equal(report.skills.length, Object.keys(EXPECTED_SKILLS).length);
  assert.deepEqual(report.skills.map((item) => item.name).sort(), Object.keys(EXPECTED_SKILLS).sort());
  for (const skill of report.skills) {
    assert.ok(skill.bytes <= SKILL_MAX_BYTES, `${skill.name} bytes=${skill.bytes}`);
    assert.ok(skill.lines <= SKILL_MAX_LINES, `${skill.name} lines=${skill.lines}`);
    assert.ok(skill.descriptionChars >= 40, `${skill.name} description 过短`);
  }
});

test("项目规范分层：每个 Skill 都有单一领域边界", async () => {
  const { issues } = await validateProjectSkills();
  assert.deepEqual(issues, []);
  assert.ok(EXPECTED_SKILLS["agentatlas-agent-runtime"].includes("agent-orchestration"));
  assert.ok(EXPECTED_SKILLS["agentatlas-service-contract"].includes("security-and-tls"));
  assert.ok(EXPECTED_SKILLS["agentatlas-frontend"].includes("engineering-standards"));
  assert.ok(EXPECTED_SKILLS["agentatlas-release-ops"].includes("versioning"));
  assert.equal(EXPECTED_SKILLS.antdv, "AGENTS.md");
});
