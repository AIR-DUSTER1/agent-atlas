/**
 * skills.test.ts — 技能库回归（F4）
 * ============================================================
 * 守五条：
 *   1. frontmatter 解析：name/description/triggers（含中文顿号分隔）；
 *   2. 坏数据降级：没有 frontmatter / 格式坏 → 整份当正文，不报错；
 *   3. 触发词、技能名称或 ID 命中即返回，按具体度排序，每轮最多 2 个；
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
  listSkills, matchSkills, skillsNoteForPrompt, skillNoteForMessage, getSkillBodyById,
  saveSkill, deleteSkill, resetSkillsCache, SKILLS_DIR, importSkillFiles, setSkillEnabled,
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

  await writeSkill("yaml-list.md", `---
name: YAML 列表
triggers:
  - 列表命中
  - list-hit
---
列表式触发词正文`);
  const yamlSkill = (await listSkills()).find((item) => item.id === "yaml-list");
  assert.ok(yamlSkill);
  assert.deepEqual(yamlSkill.triggers.sort(), ["list-hit", "列表命中"].sort());
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

test("触发词、名称与 ID 命中：按具体度排序，每轮最多 2 个且不限制技能总数", async () => {
  resetSkillsCache();
  const skills = await listSkills();
  const matched = matchSkills(skills, "帮我写个提交信息");
  assert.equal(matched.length, 1, "只有 git-commit 命中");
  assert.equal(matched[0].skill.id, "git-commit");
  assert.ok(matched[0].hits.includes("提交信息"));

  assert.equal(matchSkills(skills, "今天天气如何").length, 0);
  assert.equal(matchSkills(skills, "").length, 0);

  // 名称和 ID 始终参与匹配，即使技能已经配置了其他 triggers。
  await writeSkill("name-fallback.md", `---\nname: 名称始终触发\ntriggers: 仅关键词触发\n---\n名称匹配正文`);
  const withFallback = await listSkills();
  assert.equal(matchSkills(withFallback, "请使用名称始终触发技能").length, 1);
  assert.equal(matchSkills(withFallback, "请使用name-fallback技能").length, 1);

  // 用户消息不再只扫描尾部 2000 字：长消息开头的触发词也必须生效。
  await writeSkill("long-message.md", `---\ntriggers: 长消息开头触发\n---\n长消息匹配正文`);
  const longMessage = `长消息开头触发${"x".repeat(2_500)}`;
  assert.equal(matchSkills(await listSkills(), longMessage)[0]?.skill.id, "long-message");

  // 单个技能的触发词不再被任意截断为 20 个。
  const triggers = Array.from({ length: 25 }, (_, index) => `批量触发词${index + 1}`);
  await writeSkill("many-triggers.md", `---\ntriggers: ${triggers.join(", ")}\n---\n多触发词正文`);
  assert.equal(matchSkills(await listSkills(), "请匹配批量触发词25")[0]?.skill.id, "many-triggers");

  // 造 3 个都能命中的技能，验证每轮上限仍为 2。
  resetSkillsCache();
  for (const n of [1, 2, 3]) {
    await writeSkill(`multi-${n}.md`, `---\ntriggers: 每轮上限关键词\n---\n正文 ${n}`);
  }
  const many = matchSkills(await listSkills(), "每轮上限关键词");
  assert.equal(many.length, 2, `每轮最多 2 个，实际 ${many.length}`);

  // 技能目录总数不再被 100 个的硬上限截断。
  const beforeBulk = (await listSkills()).length;
  for (let index = 0; index < 101; index += 1) {
    await writeSkill(`bulk-${index}.md`, `---\nname: 批量技能 ${index}\ntriggers: never-hit-${index}\n---\n批量正文 ${index}`);
  }
  resetSkillsCache();
  assert.ok((await listSkills()).length >= beforeBulk + 101);
});
test("注入文本：命中带关键词说明，未命中返回 null（零开销）", async () => {
  resetSkillsCache();
  const skills = await listSkills();
  assert.equal(skillsNoteForPrompt(matchSkills(skills, "无关内容")), null, "未命中必须返回 null");

  const note = skillsNoteForPrompt(matchSkills(skills, "写提交信息"));
  assert.ok(note);
  assert.match(String(note), /【已加载技能】/);
  assert.match(String(note), /命中：/);
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

test("保存技能：只更新已有技能，新建必须交给 skill-creator", async () => {
  await assert.rejects(
    () => saveSkill({
      id: "deploy",
      name: "部署流程",
      description: "发布到生产",
      triggers: "部署, deploy",
      body: "# 部署\n1. 跑测试\n2. 打 tag",
    }),
    /skill-creator/
  );
  await writeSkill("deploy.md", `---
name: 部署流程
description: 发布到生产
triggers: 部署, deploy
---
# 部署
1. 跑测试
2. 打 tag
`);
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
  await assert.rejects(() => saveSkill({ id: "ok", body: "   " }), /skill-creator/);
});

test("启用 / 禁用：状态写入 frontmatter，禁用技能不参与匹配与注入", async () => {
  await writeSkill("toggle-me.md", `---
name: 启停测试
triggers: 开关测试
---
启用时应该加载`);
  let skills = await listSkills();
  let skill = skills.find((item) => item.id === "toggle-me");
  assert.equal(skill?.enabled, true, "新建技能默认启用");
  assert.equal(matchSkills(skills, "执行开关测试").length, 1);

  const disabled = await setSkillEnabled("toggle-me", false);
  assert.equal(disabled.enabled, false);
  const raw = await readFile(join(skillsDir, "toggle-me.md"), "utf8");
  assert.match(raw, /enabled: false/);
  skills = await listSkills();
  assert.equal(matchSkills(skills, "执行开关测试").length, 0, "禁用后不得自动匹配");
  const noteAfterDisable = await skillNoteForMessage("执行开关测试");
  assert.ok(noteAfterDisable, "目录仍会列出其它技能（渐进式披露第一层）");
  assert.doesNotMatch(String(noteAfterDisable), /启停测试|启停时应该加载/, "禁用技能不得出现在目录或正文");

  const edited = await saveSkill({ id: "toggle-me", body: "禁用状态下编辑正文" });
  assert.equal(edited.skill.enabled, false, "编辑禁用技能不得意外重新启用");
  assert.equal(edited.skill.name, "启停测试", "部分更新应保留原显示名");

  skill = await setSkillEnabled("toggle-me", true);
  assert.equal(skill.enabled, true);
  assert.equal(matchSkills(await listSkills(), "执行开关测试").length, 1);
});

test("上传技能：支持 md / markdown、冲突确认与标准 SKILL.md 标识", async () => {
  const result = await importSkillFiles([{
    name: "uploaded-skill.md",
    content: `---
name: 上传技能
description: 来自文件上传
triggers: 上传测试
---
# 上传技能
按上传内容执行。`,
  }], false);
  assert.deepEqual(result.imported, ["uploaded-skill"]);
  const uploaded = result.skills.find((skill) => skill.id === "uploaded-skill");
  assert.equal(uploaded?.name, "上传技能");
  assert.equal(uploaded?.enabled, true);

  await assert.rejects(
    () => importSkillFiles([{ name: "uploaded-skill.md", content: "新正文" }], false),
    /已存在/
  );
  const overwritten = await importSkillFiles([{
    name: "uploaded-skill.markdown",
    content: "覆盖后的正文",
  }], true);
  assert.deepEqual(overwritten.overwritten, ["uploaded-skill"]);

  const standard = await importSkillFiles([{
    name: "SKILL.md",
    content: `---
name: standard-upload
description: 标准目录下的 SKILL.md
triggers: 标准上传
enabled: false
---
标准技能正文`,
  }], false);
  assert.deepEqual(standard.imported, ["standard-upload"]);
  assert.equal(standard.skills.find((skill) => skill.id === "standard-upload")?.enabled, false);
});

test("上传技能：拒绝非 markdown、空正文和非法文件名", async () => {
  await assert.rejects(
    () => importSkillFiles([{ name: "skill.txt", content: "正文" }], false),
    /必须.*\.md/
  );
  await assert.rejects(
    () => importSkillFiles([{ name: "empty.md", content: "   " }], false),
    /内容为空/
  );
  await assert.rejects(
    () => importSkillFiles([{ name: "bad name.md", content: "正文" }], false),
    /标识不合法/
  );
});

test("删除技能：存在则删，不存在返回 removed=false", async () => {
  await writeSkill("temp.md", "临时");
  assert.equal((await deleteSkill("temp")).removed, true);
  assert.equal((await deleteSkill("temp")).removed, false);
});

/* ---------------------------------------------------------------------------
 * 渐进式披露（目录常驻 + 命中自动注入 + use_skill 按需取用）
 * ------------------------------------------------------------------------- */

/** 前面的测试在共享目录里留了大量 bulk/multi 噪声技能（101 个 bulk 会按字母序
 *  吃光目录预算）——渐进式披露测试必须用受控夹具，先清场再写已知技能。 */
async function resetCatalogFixture(): Promise<void> {
  for (const skill of await listSkills()) await deleteSkill(skill.id);
  await writeSkill("git-commit.md", `---
name: 写提交信息
description: 本仓库的提交信息风格
triggers: 提交信息, commit, 提交
---

# 写提交信息
- 一行中文短句
`);
  await writeSkill("estate-help.md", `---
name: 房产查询指南
description: 用 house_search 与 house_lookup 查询房源并生成结论表
---
房产正文`);
  resetSkillsCache();
}

test("渐进式披露：目录常驻，未命中也有目录且无正文段", async () => {
  await resetCatalogFixture();
  const note = await skillNoteForMessage("完全无关的消息内容");
  assert.ok(note, "有技能时目录恒在（第一层固定小开销，取代旧机制的纯零开销）");
  assert.match(String(note), /【技能目录】/);
  assert.match(String(note), /use_skill/);
  assert.match(String(note), /标识 git-commit/, "目录行必须带标识供 use_skill 取用");
  assert.match(String(note), /本仓库的提交信息风格/, "description 是目录行的摘要来源");
  assert.doesNotMatch(String(note), /【已加载技能】/, "未命中不得注入正文");
});

test("渐进式披露：命中时目录标注〔已自动加载〕并带正文段", async () => {
  await resetCatalogFixture();
  const note = await skillNoteForMessage("帮我写个提交信息");
  assert.ok(note);
  assert.match(String(note), /【技能目录】/);
  assert.match(String(note), /〔已自动加载〕/, "已注入正文的技能必须在目录标注，模型不要重复取");
  assert.match(String(note), /【已加载技能】/);
  assert.match(String(note), /一行中文短句/);
});

test("getSkillBodyById：存在取全文、大小写不敏感、穿越标识与禁用返回 null、超长截断", async () => {
  await resetCatalogFixture();
  const found = await getSkillBodyById("git-commit");
  assert.ok(found);
  assert.equal(found.name, "写提交信息");
  assert.match(found.body, /一行中文短句/);
  assert.ok((await getSkillBodyById("GIT-COMMIT")) !== null, "标识大小写不敏感");
  assert.equal(await getSkillBodyById("no-such-skill"), null);
  assert.equal(await getSkillBodyById("../escape"), null, "路径穿越式标识直接拒绝");
  assert.equal(await getSkillBodyById(123), null, "非字符串标识拒绝");

  await writeSkill("body-clamp.md", `---\nname: 截断测试\n---\n${"x".repeat(5_000)}`);
  const clamped = await getSkillBodyById("body-clamp");
  assert.ok(clamped);
  assert.match(clamped.body, /技能正文过长已截断/, "工具层取用也必须受单技能字符上限约束");
});

test("目录封顶：技能过多时截断并提示整理，注记总长有硬上限", async () => {
  await resetCatalogFixture();
  for (let index = 0; index < 40; index += 1) {
    await writeSkill(`catalog-fill-${index}.md`, `---\nname: 目录填充 ${index}\ndescription: ${"描".repeat(100)}\n---\n正文`);
  }
  resetSkillsCache();
  const note = await skillNoteForMessage("无关消息");
  assert.ok(note);
  assert.match(String(note), /因目录超长未列出/);
  assert.ok(String(note).length < 5_000, "目录注记必须有硬上限，不随技能数无限膨胀");
});

test("use_skill 工具：按标识取全文；不存在时给中文引导而不是编造", async () => {
  await resetCatalogFixture();
  const { useSkillTool } = await import("../../src/tools-skill.js");
  const hit = await useSkillTool.invoke({ id: "git-commit" });
  const data = JSON.parse(String(hit)) as { ok: boolean; name: string; body: string };
  assert.equal(data.ok, true);
  assert.equal(data.name, "写提交信息");
  assert.match(data.body, /一行中文短句/);

  const miss = await useSkillTool.invoke({ id: "no-such" });
  const missData = JSON.parse(String(miss)) as { ok: boolean; error: string };
  assert.equal(missData.ok, false);
  assert.match(missData.error, /技能目录/);
});

test("use_skill 由运行时注入（平台级能力），profile 自带同名工具时去重", async () => {
  // 与 update_workflow_plan 同模式：平台级只读工具由 runtime 补进模型工具集，
  // 不进各 Profile 的 allowlist —— 子代理继承 profile.tools 缩小集，不会多拿到。
  const src = await readFile(new URL("../../src/agent/workflow/runtime.ts", import.meta.url), "utf8");
  assert.match(src, /USE_SKILL_TOOL_NAME, useSkillTool/);
  assert.match(src, /hasUseSkillTool/);
  assert.match(src, /\[\.\.\.baseTools, useSkillTool\]/);
});

test("skill-creator 标准目录：发现、编辑、启停、删除都写回 SKILL.md", async () => {
  const dirPath = join(skillsDir, "created-by-skill-creator");
  await mkdir(dirPath, { recursive: true });
  await writeFile(join(dirPath, "SKILL.md"), `---
name: 标准创建技能
description: 由 skill-creator 生成
triggers: 标准创建
---
标准技能正文`, "utf8");
  resetSkillsCache();
  const created = (await listSkills()).find((skill) => skill.id === "created-by-skill-creator");
  assert.ok(created);
  assert.equal(created.name, "标准创建技能");
  assert.equal(created.path, join(dirPath, "SKILL.md"));

  const updated = await saveSkill({ id: "created-by-skill-creator", body: "更新后的标准正文" });
  assert.equal(updated.skill.name, "标准创建技能");
  assert.match(await readFile(join(dirPath, "SKILL.md"), "utf8"), /更新后的标准正文/);
  assert.doesNotMatch(await readFile(join(skillsDir, "created-by-skill-creator.md"), "utf8").catch(() => ""), /更新后的标准正文/);

  const disabled = await setSkillEnabled("created-by-skill-creator", false);
  assert.equal(disabled.enabled, false);
  assert.match(await readFile(join(dirPath, "SKILL.md"), "utf8"), /enabled: false/);
  assert.equal(matchSkills(await listSkills(), "标准创建").length, 0);

  assert.equal((await deleteSkill("created-by-skill-creator")).removed, true);
  await assert.rejects(() => readFile(join(dirPath, "SKILL.md"), "utf8"));
});
