/**
 * skills.test.ts — 技能库回归（F4）
 * ============================================================
 * 守五条：
 *   1. frontmatter 解析：name/description/triggers（含中文顿号分隔）；
 *   2. 坏数据降级：没有 frontmatter / 格式坏 → 整份当正文，不报错；
 *   3. 关键词匹配：命中才返回、按具体度排序、每轮最多 2 个；
 *   4. 注入文本：命中带关键词说明，未命中返回 null（零开销）；
 *   5. 写操作：校验标识白名单、同名覆盖、删除。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "agent-skills-"));
const skillsDir = join(dir, "skills");
process.env.SKILLS_DIR = skillsDir;
await mkdir(skillsDir, { recursive: true });

const {
  listSkills, matchSkills, skillsNoteForPrompt, skillNoteForMessage,
  saveSkill, deleteSkill, resetSkillsCache, SKILLS_DIR,
} = await import("../../src/skills.js");

test.after(async () => {
  delete process.env.SKILLS_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** 写一个技能文件并清缓存 */
async function writeSkill(filename: string, content: string): Promise<void> {
  await writeFile(join(skillsDir, filename), content, "utf8");
  resetSkillsCache();
}

test("技能目录可被环境变量覆盖（测试隔离）；默认路径从 src/ 回退一层到仓库根", async () => {
  // 本测试全程用 SKILLS_DIR 指向临时目录（避免碰开发者真实技能）：
  assert.equal(SKILLS_DIR, skillsDir, "测试期间必须用隔离目录");
  // 默认路径的正确性由源码断言守护 —— 层数写错会让技能文件写到 src/.setting/
  // 这类「服务照常工作但文件悄悄换位置」的坑（checkpoint.ts 踩过，见 wiki §7.3）
  const src = await readFile(new URL("../../src/skills.ts", import.meta.url), "utf8");
  assert.match(src, /join\(MODULE_DIR, "\.\.", "\.setting", "skills"\)/);
});

test("frontmatter 解析：name / description / triggers", async () => {
  await writeSkill("git-commit.md", `---
name: 写提交信息
description: 本仓库的提交信息风格
triggers: 提交信息, commit, 提交
---

# 写提交信息
- 一行中文短句
`);
  const skills = await listSkills();
  const s = skills.find((x) => x.id === "git-commit");
  assert.ok(s, "技能应被发现");
  assert.equal(s.name, "写提交信息");
  assert.equal(s.description, "本仓库的提交信息风格");
  assert.deepEqual(s.triggers.sort(), ["commit", "提交", "提交信息"].sort());
  assert.match(s.body, /一行中文短句/);
});

test("没有 frontmatter 的文件也能当技能用（整份是正文，无触发词）", async () => {
  await writeSkill("plain.md", "只是正文，没有元数据");
  const skills = await listSkills();
  const s = skills.find((x) => x.id === "plain");
  assert.ok(s);
  assert.equal(s.name, "plain", "没有 name 时用文件基名");
  assert.deepEqual(s.triggers, []);
  assert.equal(s.body, "只是正文，没有元数据");
});

test("关键词匹配：命中才返回，按具体度排序，最多 2 个", async () => {
  resetSkillsCache();
  const skills = await listSkills();
  const matched = matchSkills(skills, "帮我写个提交信息");
  assert.equal(matched.length, 1, "只有 git-commit 命中");
  assert.equal(matched[0].skill.id, "git-commit");
  assert.ok(matched[0].hits.includes("提交信息"));

  // 未命中 → 空数组
  assert.equal(matchSkills(skills, "今天天气如何").length, 0);
  // 空输入 → 空数组
  assert.equal(matchSkills(skills, "").length, 0);

  // 造 3 个都能命中的技能，验证上限 2
  resetSkillsCache();
  for (const n of [1, 2, 3]) {
    await writeSkill(`multi-${n}.md`, `---\ntriggers: 关键词\n---\n正文 ${n}`);
  }
  const all = await listSkills();
  const many = matchSkills(all, "关键词 关键词");
  assert.ok(many.length <= 2, `每轮最多 2 个，实际 ${many.length}`);
});

test("注入文本：命中带关键词说明，未命中返回 null（零开销）", async () => {
  resetSkillsCache();
  const skills = await listSkills();
  assert.equal(skillsNoteForPrompt(matchSkills(skills, "无关内容")), null, "未命中必须返回 null");

  const note = skillsNoteForPrompt(matchSkills(skills, "写提交信息"));
  assert.ok(note);
  assert.match(String(note), /【已加载技能】/);
  assert.match(String(note), /命中关键词/);
  assert.match(String(note), /一行中文短句/);
});

test("skillNoteForMessage：一步到位，无技能时返回 null", async () => {
  resetSkillsCache();
  assert.match(String(await skillNoteForMessage("写提交信息")), /【已加载技能】/);

  // 清空目录 → 返回 null（不报错）
  for (const s of await listSkills()) {
    await deleteSkill(s.id);
  }
  resetSkillsCache();
  assert.equal(await skillNoteForMessage("写提交信息"), null);
});

test("保存技能：校验标识、写 frontmatter、同名覆盖", async () => {
  const created = await saveSkill({
    id: "deploy",
    name: "部署流程",
    description: "发布到生产",
    triggers: "部署, deploy",
    body: "# 部署\n1. 跑测试\n2. 打 tag",
  });
  assert.equal(created.created, true);
  const raw = await readFile(join(skillsDir, "deploy.md"), "utf8");
  assert.match(raw, /^---/);
  assert.match(raw, /name: 部署流程/);
  assert.match(raw, /triggers: 部署, deploy/);
  assert.match(raw, /跑测试/);

  const updated = await saveSkill({ id: "deploy", body: "改过的正文" });
  assert.equal(updated.created, false, "同名应覆盖");
  const all = await listSkills();
  assert.equal(all.filter((s) => s.id === "deploy").length, 1);
});

test("保存技能：非法标识与空正文给中文错误", async () => {
  await assert.rejects(() => saveSkill({ id: "", body: "x" }), /标识/);
  await assert.rejects(() => saveSkill({ id: "带/斜杠", body: "x" }), /只能包含/);
  await assert.rejects(() => saveSkill({ id: "ok", body: "   " }), /正文不能为空/);
});

test("删除技能：存在则删，不存在返回 removed=false", async () => {
  await saveSkill({ id: "temp", body: "临时" });
  assert.equal((await deleteSkill("temp")).removed, true);
  assert.equal((await deleteSkill("temp")).removed, false);
});
