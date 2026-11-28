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

test("渐进式披露：SKILL.md 声明按需深入段，references 引用双向成立", async () => {
  // Skill 深表放 references/ 并在 SKILL.md 显式路由；孤儿深表（没被引用）等于
  // 死内容，死链（引用不存在文件）会误导执行者——双向都必须由守门抓出来。
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname ?? ".", "..", "..");
  for (const name of Object.keys(EXPECTED_SKILLS)) {
    const skillDir = join(root, ".agents", "skills", name);
    const text = await readFile(join(skillDir, "SKILL.md"), "utf8");
    assert.match(text, /按需深入/, `${name}/SKILL.md 缺少按需深入段`);

    const refs = (await readdir(join(skillDir, "references"), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name);
    for (const refName of refs) {
      assert.match(text, new RegExp(refName.replaceAll(".", "\\.")), `${name} 的 references/${refName} 未被 SKILL.md 引用`);
    }
    for (const match of text.matchAll(/references\/([\w.-]+\.md)/g)) {
      const refName = match[1] ?? "";
      await assert.doesNotReject(
        () => readFile(join(skillDir, "references", refName), "utf8"),
        `${name} 引用了不存在的 references/${refName}`,
      );
    }
  }
});

test("渐进式披露预算：references 深表受独立大小上限约束", async () => {
  const { REFERENCE_MAX_BYTES, REFERENCE_MAX_LINES } = await import("../../scripts/project-skills.js");
  assert.ok(REFERENCE_MAX_BYTES > SKILL_MAX_BYTES, "深表预算必须比 SKILL.md 宽，否则等于没分层");
  assert.ok(REFERENCE_MAX_LINES > SKILL_MAX_LINES);
});
