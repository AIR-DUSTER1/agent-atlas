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
import { join, basename, dirname, extname } from "node:path";
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
/** 一次上传最多处理的文件数；前端同样限制，服务端仍做最终校验。 */
const MAX_IMPORT_FILES = 20;
/** 一次上传的 JSON 请求体上限，给聊天和附件请求留出共享 2MB 限额的余量。 */
const MAX_IMPORT_BATCH_BYTES = 1_500_000;

export interface Skill {
  /** 文件基名（不含 .md），也是技能标识 */
  id: string;
  name: string;
  description: string;
  /** 触发关键词（小写比较）；为空时按技能名称与标识兜底匹配 */
  triggers: string[];
  /** 是否参与自动匹配；禁用后仍保留文件并可在设置页重新启用 */
  enabled: boolean;
  /** markdown 正文 */
  body: string;
}

interface ParsedFrontmatter {
  meta: Record<string, string>;
  body: string;
}

/**
 * 解析极简 frontmatter：支持 `key: value` 与 `key:\n  - item` 两种常见写法。
 * 没有 frontmatter / 格式坏 → meta = {}，整份内容当正文（降级不报错）。
 */
function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, ""); // 去 BOM（Windows 编辑器常见）
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && listKey) {
      const value = listItem[1].trim().replace(/^["']|["']$/g, "");
      meta[listKey] = meta[listKey] ? `${meta[listKey]}, ${value}` : value;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      listKey = null; // 空行/注释/坏行结束列表上下文
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      meta[key] = value;
      listKey = value ? null : key;
    }
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

function isValidSkillId(id: string): boolean {
  return Boolean(id) && id.length <= MAX_NAME_CHARS && /^[\w\u4e00-\u9fa5-]+$/.test(id);
}

/** 只有明确的否定值才禁用；缺省保持向后兼容，旧技能默认启用。 */
function parseEnabled(value: string | undefined): boolean {
  if (!value) return true;
  return !["false", "0", "off", "no", "disabled", "禁用"].includes(value.trim().toLowerCase());
}

function toSkill(filename: string, raw: string): Skill | null {
  const id = basename(filename, ".md");
  if (!isValidSkillId(id)) return null;
  const { meta, body } = parseFrontmatter(raw);
  if (!body) return null; // 空正文的技能没有意义
  return {
    id,
    name: meta.name?.trim() || id,
    description: meta.description?.trim() || "",
    triggers: splitTriggers(meta.triggers ?? meta.trigger),
    enabled: parseEnabled(meta.enabled),
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
    if (!skill.enabled) continue;
    // 上传的标准 Skill 常常没有 triggers：用名称/标识兜底，避免装上却永远无法命中。
    const triggers = skill.triggers.length
      ? skill.triggers
      : [skill.name.toLowerCase(), skill.id.toLowerCase()].filter(Boolean);
    const hits = triggers.filter((t) => haystack.includes(t));
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
const RESERVED_SKILL_KEYS = new Set(["name", "description", "triggers", "trigger", "enabled"]);

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** 保留用户手写的未知 frontmatter 键；已知字段统一由设置页序列化。 */
function extraSkillKeys(raw: string | null): Record<string, string> {
  const extra: Record<string, string> = {};
  if (!raw) return extra;
  const { meta } = parseFrontmatter(raw);
  for (const [key, value] of Object.entries(meta)) {
    if (!RESERVED_SKILL_KEYS.has(key)) extra[key] = singleLine(value);
  }
  return extra;
}

function buildSkillFile(input: {
  name: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  body: string;
  extraKeys?: Record<string, string>;
}): string {
  const lines = ["---", `name: ${singleLine(input.name)}`];
  if (input.description) lines.push(`description: ${singleLine(input.description)}`);
  if (input.triggers.length) lines.push(`triggers: ${input.triggers.map(singleLine).join(", ")}`);
  lines.push(`enabled: ${input.enabled}`);
  for (const [key, value] of Object.entries(input.extraKeys ?? {})) lines.push(`${key}: ${singleLine(value)}`);
  lines.push("---", "", input.body, "");
  return lines.join("\n");
}

function normalizeTriggers(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[,，、;；]/)
      : [];
  return [...new Set(raw.map((item) => singleLine(item).toLowerCase()).filter(Boolean))].slice(0, 20);
}

export async function saveSkill(input: {
  id?: unknown; name?: unknown; description?: unknown; triggers?: unknown; body?: unknown; enabled?: unknown;
}): Promise<{ skill: Skill; created: boolean }> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) throw new Error("技能标识（文件名）不能为空");
  if (!isValidSkillId(id)) {
    throw new Error(`技能标识只能包含字母、数字、下划线、短横线或中文，且不能超过 ${MAX_NAME_CHARS} 个字符`);
  }
  const existing = await readSkillFileRaw(id);
  const existingSkill = existing ? toSkill(`${id}.md`, existing) : null;
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new Error("技能正文不能为空");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_FILE_BYTES) throw new Error("技能正文过长");

  const triggers = input.triggers === undefined ? existingSkill?.triggers ?? [] : normalizeTriggers(input.triggers);
  const name = singleLine(typeof input.name === "string" && input.name.trim()
    ? input.name
    : existingSkill?.name ?? id);
  if (name.length > MAX_NAME_CHARS) throw new Error(`技能名称不能超过 ${MAX_NAME_CHARS} 个字符`);
  const description = singleLine(typeof input.description === "string"
    ? input.description
    : existingSkill?.description ?? "");
  const enabled = typeof input.enabled === "boolean" ? input.enabled : existingSkill?.enabled ?? true;
  const content = buildSkillFile({
    name,
    description,
    triggers,
    enabled,
    body,
    extraKeys: extraSkillKeys(existing),
  });
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) throw new Error("技能文件过长");

  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  await fsp.writeFile(join(SKILLS_DIR, `${id}.md`), content, "utf8");
  resetSkillsCache();
  return {
    skill: { id, name, description, triggers, enabled, body },
    created: !existing,
  };
}

interface ImportedSkillFile {
  id: string;
  content: string;
  previous: string | null;
}

export interface SkillImportResult {
  imported: string[];
  overwritten: string[];
  skills: Skill[];
}

/** 批量导入用户上传的 markdown；先全量校验，再写盘，失败时回滚已写文件。 */
export async function importSkillFiles(files: unknown, overwriteInput: unknown): Promise<SkillImportResult> {
  if (!Array.isArray(files) || files.length === 0) throw new Error("请选择至少一个技能文件");
  if (files.length > MAX_IMPORT_FILES) throw new Error(`一次最多上传 ${MAX_IMPORT_FILES} 个技能文件`);

  const prepared: ImportedSkillFile[] = [];
  const seenIds = new Set<string>();
  let totalBytes = 0;

  for (const item of files) {
    if (!item || typeof item !== "object") throw new Error("技能文件格式不正确");
    const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name.trim() : "";
    const content = typeof (item as { content?: unknown }).content === "string" ? (item as { content: string }).content : "";
    if (!name) throw new Error("技能文件名不能为空");
    if (!content.trim()) throw new Error(`技能「${name}」内容为空`);

    const filename = basename(name.replaceAll("\\", "/"));
    const extension = extname(filename).toLowerCase();
    if (extension !== ".md" && extension !== ".markdown") {
      throw new Error(`技能「${filename}」必须是 .md 或 .markdown 文件`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SKILL_FILE_BYTES) throw new Error(`技能「${filename}」超过 ${MAX_SKILL_FILE_BYTES} 字节`);
    totalBytes += bytes;
    if (totalBytes > MAX_IMPORT_BATCH_BYTES) throw new Error("本次上传总大小超过 1.5MB，请分批上传");

    const { meta } = parseFrontmatter(content);
    const stem = basename(filename, extension);
    // 兼容标准 skill 目录中统一命名为 SKILL.md 的文件：用 frontmatter.name 作为稳定标识。
    const frontmatterId = (meta.name ?? "").trim();
    const id = /^skill$/i.test(stem) && isValidSkillId(frontmatterId) ? frontmatterId : stem;
    if (!isValidSkillId(id)) {
      throw new Error(`技能「${filename}」的标识不合法：仅支持字母、数字、下划线、短横线或中文`);
    }
    const idKey = id.toLowerCase();
    if (seenIds.has(idKey)) throw new Error(`本次上传中存在重复技能标识「${id}」`);
    seenIds.add(idKey);
    if (!toSkill(`${id}.md`, content)) throw new Error(`技能「${filename}」没有可加载的正文`);
    prepared.push({ id, content, previous: await readSkillFileRaw(id) });
  }

  let currentFiles: string[] = [];
  try {
    currentFiles = (await fsp.readdir(SKILLS_DIR)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch { /* 目录尚不存在 */ }
  const newFileCount = prepared.filter((file) => file.previous === null).length;
  if (currentFiles.length + newFileCount > MAX_SKILLS) throw new Error(`技能总数不能超过 ${MAX_SKILLS} 个`);

  const conflicts = prepared.filter((file) => file.previous !== null).map((file) => file.id);
  if (conflicts.length && overwriteInput !== true) {
    throw new Error(`技能「${conflicts.join("、")}」已存在；确认覆盖后重试`);
  }

  const written: ImportedSkillFile[] = [];
  try {
    await fsp.mkdir(SKILLS_DIR, { recursive: true });
    for (const file of prepared) {
      await fsp.writeFile(join(SKILLS_DIR, `${file.id}.md`), file.content, "utf8");
      written.push(file);
    }
  } catch (err) {
    for (const file of written.reverse()) {
      try {
        if (file.previous === null) await fsp.unlink(join(SKILLS_DIR, `${file.id}.md`));
        else await fsp.writeFile(join(SKILLS_DIR, `${file.id}.md`), file.previous, "utf8");
      } catch { /* 回滚尽力而为，下面仍返回明确错误 */ }
    }
    resetSkillsCache();
    throw new Error(`技能导入失败，已回滚：${err instanceof Error ? err.message : String(err)}`);
  }

  resetSkillsCache();
  return {
    imported: prepared.filter((file) => file.previous === null).map((file) => file.id),
    overwritten: conflicts,
    skills: await listSkills(),
  };
}

/** 切换技能启停；状态写入 frontmatter，重启和外部编辑器都能保持一致。 */
export async function setSkillEnabled(idInput: unknown, enabledInput: unknown): Promise<Skill> {
  const id = typeof idInput === "string" ? idInput.trim() : "";
  if (!isValidSkillId(id)) throw new Error("技能标识不合法");
  if (typeof enabledInput !== "boolean") throw new Error("enabled 必须是布尔值");
  const raw = await readSkillFileRaw(id);
  if (raw === null) throw new Error(`技能「${id}」不存在`);
  const skill = toSkill(`${id}.md`, raw);
  if (!skill) throw new Error(`技能「${id}」无法解析`);

  const updated = { ...skill, enabled: enabledInput };
  const content = buildSkillFile({
    name: updated.name,
    description: updated.description,
    triggers: updated.triggers,
    enabled: updated.enabled,
    body: updated.body,
    extraKeys: extraSkillKeys(raw),
  });
  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  await fsp.writeFile(join(SKILLS_DIR, `${id}.md`), content, "utf8");
  resetSkillsCache();
  return updated;
}

async function readSkillFileRaw(id: string): Promise<string | null> {
  try {
    return await fsp.readFile(join(SKILLS_DIR, `${id}.md`), "utf8");
  } catch {
    return null;
  }
}

export async function deleteSkill(id: string): Promise<{ removed: boolean }> {
  if (!isValidSkillId(id)) throw new Error("技能标识不合法");
  try {
    await fsp.unlink(join(SKILLS_DIR, `${id}.md`));
    resetSkillsCache();
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
