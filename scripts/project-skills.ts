/**
 * ============================================================
 * scripts/project-skills.ts — 项目级 Codex Skill 结构校验
 * ============================================================
 * 只校验可稳定判断的契约：命名、frontmatter、UI 元数据、大小、权威链接和 AGENTS 常驻红线。
 * 语义路由质量仍由真实任务评测和人工评审负责，不能仅靠关键词测试证明。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const SKILLS_DIR = join(PROJECT_ROOT, ".agents", "skills");
export const AGENTS_MAX_BYTES = 18_000;
export const SKILL_MAX_BYTES = 8_000;
export const SKILL_MAX_LINES = 120;
/** 渐进式披露：references/ 深表的单文件预算。超过说明该拆第二层或回流 SKILL 精选。 */
export const REFERENCE_MAX_BYTES = 20_000;
export const REFERENCE_MAX_LINES = 300;

export const EXPECTED_SKILLS = {
  "agentatlas-agent-runtime": ".plans/development-docs/agent-orchestration.md",
  "agentatlas-service-contract": "docs/security-and-tls.md",
  "agentatlas-frontend": ".plans/development-docs/engineering-standards.md",
  "agentatlas-release-ops": ".plans/development-docs/versioning.md",
  // 组件库使用规范由 AGENTS 的 Skill 路由与自身 Skill 共同约束。
  // `.plans/` 是本地开发资料，不进入 Git；不能作为公开仓库的强制文件依赖。
  antdv: "AGENTS.md",
} as const;

export interface SkillStat {
  name: string;
  bytes: number;
  lines: number;
  descriptionChars: number;
}

export interface ProjectSkillReport {
  agentsBytes: number;
  agentsLines: number;
  skills: SkillStat[];
  totalSkillBytes: number;
}

export interface ProjectSkillValidation {
  issues: string[];
  report: ProjectSkillReport;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed) as string;
  return trimmed;
}

function field(frontmatter: string, name: string): string {
  const line = frontmatter.split(/\r?\n/).find((item) => item.startsWith(`${name}:`));
  return line ? unquote(line.slice(name.length + 1)) : "";
}

async function readRequired(path: string, issues: string[]): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    issues.push(`缺少文件：${path}`);
    return null;
  }
}

export async function validateProjectSkills(root = PROJECT_ROOT): Promise<ProjectSkillValidation> {
  const issues: string[] = [];
  const agentsPath = join(root, "AGENTS.md");
  const agents = (await readRequired(agentsPath, issues)) ?? "";
  const agentsInfo = await stat(agentsPath).catch(() => null);
  const agentsBytes = agentsInfo?.size ?? Buffer.byteLength(agents, "utf8");
  const agentsLines = agents ? agents.split(/\r?\n/).length - (agents.endsWith("\n") ? 1 : 0) : 0;

  if (agentsBytes > AGENTS_MAX_BYTES) issues.push(`AGENTS.md 超过常驻预算：${agentsBytes} > ${AGENTS_MAX_BYTES} bytes`);
  for (const marker of [
    "mergeConfig",
    "assertAuthorized",
    "task_usage",
    "hitl.ts",
    "src/client/ui/icons.ts",
    "src/agent/workflow.ts",
    "package.json.version",
    ".plans/development-docs/engineering-standards.md",
  ]) {
    if (!agents.includes(marker)) issues.push(`AGENTS.md 缺少常驻红线标记：${marker}`);
  }

  // 开发规范是本地 `.plans/` 文档，不要求随公开仓库分发；存在时再校验 Skill 登记。
  const standardsPath = join(root, ".plans", "development-docs", "engineering-standards.md");
  const standards = await readFile(standardsPath, "utf8").catch(() => "");
  // `.plans/` 文件只在本地存在；antdv 的权威入口是 tracked AGENTS.md，
  // 其余四个常驻领域 Skill 仍要求在工程规范中有一行登记。
  const standardsRegisteredSkills = new Set([
    "agentatlas-agent-runtime",
    "agentatlas-service-contract",
    "agentatlas-frontend",
    "agentatlas-release-ops",
  ]);
  for (const name of Object.keys(EXPECTED_SKILLS)) {
    if (!agents.includes(name)) issues.push(`AGENTS.md 未路由 Skill：${name}`);
    if (standards && standardsRegisteredSkills.has(name) && !standards.includes(name)) {
      issues.push(`engineering-standards.md 未登记 Skill：${name}`);
    }
  }

  const entries = await readdir(join(root, ".agents", "skills"), { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const expected = Object.keys(EXPECTED_SKILLS).sort();
  if (JSON.stringify(dirs) !== JSON.stringify(expected)) {
    issues.push(`项目 Skill 集合不一致：expected=${expected.join(",")} actual=${dirs.join(",")}`);
  }

  const skills: SkillStat[] = [];
  for (const name of expected) {
    const skillDir = join(root, ".agents", "skills", name);
    const skillPath = join(skillDir, "SKILL.md");
    const text = await readRequired(skillPath, issues);
    if (!text) continue;
    const info = await stat(skillPath).catch(() => null);
    const bytes = info?.size ?? Buffer.byteLength(text, "utf8");
    const lines = text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!match) {
      issues.push(`${name}/SKILL.md frontmatter 格式错误`);
      continue;
    }
    const declaredName = field(match[1] ?? "", "name");
    const description = field(match[1] ?? "", "description");
    if (declaredName !== name) issues.push(`${name}/SKILL.md name 必须是 ${name}`);
    if (description.length < 40 || description.length > 260) issues.push(`${name} description 长度不适合路由：${description.length}`);
    if (!description.includes("时使用") || (!description.includes("不用于") && !description.includes("不应"))) {
      issues.push(`${name} description 必须说明适用时机和排除边界`);
    }
    if (text.includes("[TODO") || /TODO:|placeholder/i.test(text)) issues.push(`${name}/SKILL.md 仍有占位内容`);
    if (text.includes("\uFFFD")) issues.push(`${name}/SKILL.md 含乱码替换字符`);
    if (!text.includes("AGENTS.md")) issues.push(`${name}/SKILL.md 未声明读取 AGENTS.md`);
    if (!text.includes(EXPECTED_SKILLS[name as keyof typeof EXPECTED_SKILLS])) {
      issues.push(`${name}/SKILL.md 缺少权威文档链接：${EXPECTED_SKILLS[name as keyof typeof EXPECTED_SKILLS]}`);
    }
    if (bytes > SKILL_MAX_BYTES) issues.push(`${name}/SKILL.md 过大：${bytes} > ${SKILL_MAX_BYTES}`);
    if (lines > SKILL_MAX_LINES) issues.push(`${name}/SKILL.md 行数过多：${lines} > ${SKILL_MAX_LINES}`);

    // 渐进式披露契约：SKILL.md 只留路由与红线，深表进 references/；
    // SKILL.md 必须声明按需深入段并显式引用每个 references 文件（防孤儿），
    // 被引用的文件必须存在（防死链），references 文件自身有大小预算（防转移膨胀）。
    if (!text.includes("按需深入")) issues.push(`${name}/SKILL.md 缺少「按需深入」渐进式披露段`);
    const refsDir = join(skillDir, "references");
    const refEntries = await readdir(refsDir, { withFileTypes: true }).catch(() => []);
    const refFiles = refEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
    for (const refName of refFiles) {
      if (!text.includes(refName)) {
        issues.push(`${name}/references/${refName} 未被 SKILL.md 引用（孤儿深表，路由不到等于死内容）`);
      }
      const refPath = join(refsDir, refName);
      const refText = await readRequired(refPath, issues);
      if (refText === null) continue;
      const refInfo = await stat(refPath).catch(() => null);
      const refBytes = refInfo?.size ?? Buffer.byteLength(refText, "utf8");
      const refLines = refText.split(/\r?\n/).length - (refText.endsWith("\n") ? 1 : 0);
      if (refBytes > REFERENCE_MAX_BYTES) issues.push(`${name}/references/${refName} 过大：${refBytes} > ${REFERENCE_MAX_BYTES} bytes`);
      if (refLines > REFERENCE_MAX_LINES) issues.push(`${name}/references/${refName} 行数过多：${refLines} > ${REFERENCE_MAX_LINES}`);
    }
    for (const refMatch of text.matchAll(/references\/([\w.-]+\.md)/g)) {
      const refName = refMatch[1] ?? "";
      if (!refFiles.includes(refName)) issues.push(`${name}/SKILL.md 引用了不存在的 references/${refName}`);
    }

    const yamlPath = join(skillDir, "agents", "openai.yaml");
    const yaml = await readRequired(yamlPath, issues);
    if (yaml) {
      if (yaml.includes("\uFFFD")) issues.push(`${name}/agents/openai.yaml 含乱码替换字符`);
      const shortLine = yaml.split(/\r?\n/).find((line) => line.trim().startsWith("short_description:"));
      const promptLine = yaml.split(/\r?\n/).find((line) => line.trim().startsWith("default_prompt:"));
      const shortDescription = shortLine ? unquote(shortLine.slice(shortLine.indexOf(":") + 1)) : "";
      const defaultPrompt = promptLine ? unquote(promptLine.slice(promptLine.indexOf(":") + 1)) : "";
      if (shortDescription.length < 25 || shortDescription.length > 64) {
        issues.push(`${name} openai.yaml short_description 必须为 25–64 字符`);
      }
      if (!defaultPrompt.includes(`$${name}`)) issues.push(`${name} openai.yaml default_prompt 必须显式引用 $${name}`);
    }
    skills.push({ name, bytes, lines, descriptionChars: description.length });
  }

  return {
    issues,
    report: {
      agentsBytes,
      agentsLines,
      skills,
      totalSkillBytes: skills.reduce((sum, item) => sum + item.bytes, 0),
    },
  };
}
