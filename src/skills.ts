/**
 * ============================================================
 * skills.ts — 技能库（按需加载的领域指南）
 * ============================================================
 * 职责：扫描 `.setting/skills/*.md`，按当前用户消息的关键词命中挑选技能，
 * 输出可拼进 system 注记的文本。
 * 设计立场：
 *  - **技能是文档，不是代码**：只有 markdown 正文 + 少量 frontmatter 元数据，
 *    永不执行 —— 这是它敢做成「用户可自由编辑」的前提；
 *  - **按需注入**：命中 trigger 才进上下文，未命中零开销（不占 token）。
 *    这与「把全部指南写进系统提示词」的本质区别就在这里；
 *  - **每轮最多 2 个、每个有字符上限**：技能正文再长也不能挤爆上下文预算；
 *  - 关键词匹配宁少勿多（宁可漏命中让人手动点，也不要每轮都误命中）；
 *  - frontmatter 解析只支持极小子集（name / description / triggers），
 *    不引 YAML 库 —— 坏格式按「无 frontmatter 的纯正文」降级，不报错。
 */

import { promises as fsp } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./server/logging.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/**
 * 技能目录：项目根/.setting/skills（与 memories / checkpoints 同一处，已 gitignore）。
 * 注意层数：本文件在 src/ 顶层，所以回退**两层**到仓库根
 * （checkpoint.ts 踩过「多退/少退一层」的坑，见 wiki §7.3）。
 */
export const SKILLS_DIR = process.env.SKILLS_DIR || join(MODULE_DIR, "..", ".setting", "skills");

/** 每轮最多注入几个技能（超出按命中分数截断） */
const MAX_SKILLS_PER_TURN = 2;
/** 单技能正文进上下文的字符上限（超出截断并标注） */
const MAX_SKILL_CHARS = 4_000;
/** 单个技能文件读取上限（防止误放大文件进来） */
const MAX_SKILL_FILE_BYTES = 200_000;
/** 技能总数上限 */
const MAX_SKILLS = 100;
/** 技能名长度上限 */
const MAX_NAME_CHARS = 60;
/** 搜索时扫描的用户消息尾部长度：只看最近这条，不看整段历史 */
const TRIGGER_SCAN_CHARS = 2_000;

export interface Skill {
  /** 文件基名（不含 .md），也是技能标识 */
  id: string;
  name: string;
  description: string;
  /** 触发关键词（小写比较）；为空则只能通过显式指定应用 */
  triggers: string[];
  /** markdown 正文 */
  body: string;
}

interface ParsedFrontmatter {
  meta: Record<string, string>;
  body: string;
}

/**
 * 解析极简 frontmatter：只认 `---` 包起来的 `key: value` 行。
 * value 可以是逗号分隔的多值（triggers: a, b, c）。
 * 没有 frontmatter / 格式坏 → meta = {}，整份内容当正文（降级不报错）。
 */
function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, ""); // 去 BOM（Windows 编辑器常见）
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // 不是 key: value 的行（空行/注释/坏行）跳过
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  return { meta, body: m[2].trim() };
}

/** 把 meta 里的 triggers 拆成数组（支持逗号/顿号/空格分隔，兼容中文写法） */
function splitTriggers(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,，、;；]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20); // 单技能最多 20 个关键词，防误命中面过大
}

function toSkill(filename: string, raw: string): Skill | null {
  const id = basename(filename, ".md");
  if (!id || id.length > MAX_NAME_CHARS) return null;
  const { meta, body } = parseFrontmatter(raw);
  if (!body) return null; // 空正文的技能没有意义
  return {
    id,
    name: meta.name?.trim() || id,
    description: meta.description?.trim() || "",
    triggers: splitTriggers(meta.triggers ?? meta.trigger),
    body,
  };
}

/* ---------------------------------------------------------------------------
 * 缓存：技能文件不多，但每轮对话都要匹配 —— 缓存目录 mtime，避免每轮扫盘
 * ------------------------------------------------------------------------- */
let cachedSkills: Skill[] | null = null;
let cacheStamp = 0;

async function dirSignature(): Promise<number> {
  try {
    const names = (await fsp.readdir(SKILLS_DIR)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
    const stats = await Promise.all(
      names.map(async (n) => {
        try { return (await fsp.stat(join(SKILLS_DIR, n))).mtimeMs; } catch { return 0; }
      })
    );
    // 目录签名 = 文件数 + 最新 mtime；改名/增删/编辑都会变
    return names.length * 1e13 + (stats.length ? Math.max(...stats) : 0);
  } catch {
    return 0; // 目录不存在 = 没有技能
  }
}

/** 列出全部技能（带 mtime 缓存，目录没变就不重读文件） */
export async function listSkills(): Promise<Skill[]> {
  const stamp = await dirSignature();
  if (cachedSkills && stamp === cacheStamp) return cachedSkills;

  let names: string[] = [];
  try {
    names = (await fsp.readdir(SKILLS_DIR)).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    cachedSkills = [];
    cacheStamp = stamp;
    return cachedSkills;
  }

  const skills: Skill[] = [];
  for (const filename of names.slice(0, MAX_SKILLS)) {
    try {
      const full = join(SKILLS_DIR, filename);
      const stat = await fsp.stat(full);
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        log("warn", "skill_too_large", { file: filename, bytes: stat.size });
        continue;
      }
      const skill = toSkill(filename, await fsp.readFile(full, "utf8"));
      if (skill) skills.push(skill);
    } catch (err) {
      log("warn", "skill_read_failed", {
        file: filename,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cachedSkills = skills;
  cacheStamp = stamp;
  return skills;
}

/** 测试钩子：改完技能文件后强制重扫 */
export function resetSkillsCache(): void {
  cachedSkills = null;
  cacheStamp = 0;
}

/* ---------------------------------------------------------------------------
 * 匹配与注入
 * ------------------------------------------------------------------------- */
export interface SkillMatch {
  skill: Skill;
  /** 命中的关键词（用于提示「为什么这条技能被加载」） */
  hits: string[];
}

/**
 * 按用户消息匹配技能。
 * 计分：命中关键词数优先，其次关键词越长越具体（「提交信息」比「提交」更准）。
 * 只返回前 MAX_SKILLS_PER_TURN 个，且必须至少命中一个关键词。
 */
export function matchSkills(skills: Skill[], userText: string): SkillMatch[] {
  const haystack = userText.slice(-TRIGGER_SCAN_CHARS).toLowerCase();
  if (!haystack) return [];
  const scored: Array<SkillMatch & { score: number }> = [];
  for (const skill of skills) {
    const hits = skill.triggers.filter((t) => haystack.includes(t));
    if (!hits.length) continue;
    // 关键词越长越具体，给更高权重；多个命中累加
    const score = hits.reduce((sum, t) => sum + t.length, 0) + hits.length * 5;
    scored.push({ skill, hits, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SKILLS_PER_TURN)
    .map(({ skill, hits }) => ({ skill, hits }));
}

/** 把命中的技能拼成 system 注记；未命中返回 null（零开销） */
export function skillsNoteForPrompt(matched: SkillMatch[]): string | null {
  if (!matched.length) return null;
  const blocks = matched.map(({ skill, hits }) => {
    const body = skill.body.length > MAX_SKILL_CHARS
      ? `${skill.body.slice(0, MAX_SKILL_CHARS)}\n…（技能正文过长已截断）`
      : skill.body;
    const why = hits.length ? `（命中关键词：${hits.join("、")}）` : "";
    return `### 技能：${skill.name}${why}\n${body}`;
  });
  return [
    "【已加载技能】以下是本项目为该类任务约定的流程与规范，请优先遵循；与系统默认习惯冲突时以技能为准。",
    ...blocks,
  ].join("\n\n");
}

/** 一步到位：按用户消息挑技能并生成注记（agent 节点每轮调用一次） */
export async function skillNoteForMessage(userText: string): Promise<string | null> {
  const skills = await listSkills();
  if (!skills.length) return null;
  return skillsNoteForPrompt(matchSkills(skills, userText));
}

/* ---------------------------------------------------------------------------
 * 写操作（设置页用）
 * ------------------------------------------------------------------------- */
export async function saveSkill(input: {
  id?: unknown; name?: unknown; description?: unknown; triggers?: unknown; body?: unknown;
}): Promise<{ skill: Skill; created: boolean }> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) throw new Error("技能标识（文件名）不能为空");
  if (!/^[\w\u4e00-\u9fa5-]+$/.test(id)) {
    throw new Error("技能标识只能包含字母、数字、下划线、短横线或中文");
  }
  if (id.length > MAX_NAME_CHARS) throw new Error(`技能标识不能超过 ${MAX_NAME_CHARS} 个字符`);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new Error("技能正文不能为空");
  if (body.length > MAX_SKILL_FILE_BYTES) throw new Error("技能正文过长");

  const triggers = Array.isArray(input.triggers)
    ? input.triggers.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)
    : typeof input.triggers === "string"
      ? input.triggers.split(/[,，、;；]/).map((t) => t.trim()).filter(Boolean)
      : [];
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
  const description = typeof input.description === "string" ? input.description.trim() : "";

  // 保留已有技能里本模块不认识的 frontmatter 键（用户可能手写了别的东西）
  const existing = await readSkillFileRaw(id);
  const extraKeys: Record<string, string> = {};
  if (existing) {
    const { meta } = parseFrontmatter(existing);
    for (const [k, v] of Object.entries(meta)) {
      if (!["name", "description", "triggers", "trigger"].includes(k)) extraKeys[k] = v;
    }
  }

  const lines = ["---", `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  if (triggers.length) lines.push(`triggers: ${triggers.join(", ")}`);
  for (const [k, v] of Object.entries(extraKeys)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body, "");

  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  await fsp.writeFile(join(SKILLS_DIR, `${id}.md`), lines.join("\n"), "utf8");
  resetSkillsCache();
  return {
    skill: { id, name, description, triggers: triggers.map((t) => t.toLowerCase()), body },
    created: !existing,
  };
}

async function readSkillFileRaw(id: string): Promise<string | null> {
  try {
    return await fsp.readFile(join(SKILLS_DIR, `${id}.md`), "utf8");
  } catch {
    return null;
  }
}

export async function deleteSkill(id: string): Promise<{ removed: boolean }> {
  if (!/^[\w\u4e00-\u9fa5-]+$/.test(id)) throw new Error("技能标识不合法");
  try {
    await fsp.unlink(join(SKILLS_DIR, `${id}.md`));
    resetSkillsCache();
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
