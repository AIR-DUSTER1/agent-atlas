/**
 * ============================================================
 * commands.ts — 用户自定义斜杠命令（提示词模板）
 * ============================================================
 * 职责：管理 `.setting/commands.json` 里的命令清单（CRUD），供前端 `/` 菜单
 * 与设置页使用。
 * 设计立场：
 *  - 命令只是「提示词模板」，**不执行任何代码** —— 这是它和 MCP/技能的根本区别，
 *    也是它敢做成用户可编辑的原因（最大风险面仅限「用户自己写的提示词」）；
 *  - 选中后只把模板填入输入框，由用户确认再发送（不自动发送）：
 *    用户能看见将要发给模型的确切内容；
 *  - 模板支持 `{{selection}}`（当前输入框已有文字）与 `{{date}}` 占位符；
 *  - 存储走 config-store 的 mergeConfig 语义（只写 commands 键），
 *    不影响同文件的 providers / projects / externalAgents；
 *  - 名字必须能当斜杠标识：只允许字母数字与 -_，避免与内置 /compact 冲突。
 */

import { readConfig, mergeConfig } from "./config-store.js";

/** 命令条数上限：菜单里太多会淹没内置命令 */
const MAX_COMMANDS = 50;
/** 单条命令模板字符上限：模板会进上下文，防止误贴整篇文档 */
const MAX_TEMPLATE_CHARS = 8_000;
/** 命令名长度上限 */
const MAX_NAME_CHARS = 40;

export interface UserCommand {
  name: string;
  /** 菜单里显示的短标题（留空 = 用 name） */
  title?: string;
  /** 一句话说明：菜单副标题 */
  description?: string;
  /** 提示词模板；支持 {{selection}} 与 {{date}} */
  template: string;
}

/** 命令名合法性：斜杠后面能直接敲的标识符，且不能占用内置命令名 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const RESERVED = new Set(["compact"]);

function normalize(raw: unknown): UserCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: UserCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const template = typeof r.template === "string" ? r.template : "";
    if (!name || !template) continue;
    if (!NAME_RE.test(name) || RESERVED.has(name.toLowerCase())) continue;
    if (seen.has(name)) continue; // 旧文件手工改坏时的去重
    seen.add(name);
    out.push({
      name,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : undefined,
      description: typeof r.description === "string" ? r.description.slice(0, 200) : undefined,
      template: template.slice(0, MAX_TEMPLATE_CHARS),
    });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

/** 读取全部用户命令（坏数据静默丢弃，不让设置页炸在旧文件上） */
export async function listCommands(): Promise<UserCommand[]> {
  const config = await readConfig();
  return normalize(config.commands);
}

async function persist(next: UserCommand[]): Promise<void> {
  await mergeConfig({ commands: next });
}

/** 校验并规范化一条待写入的命令；不合法抛中文错误 */
function validate(input: unknown): UserCommand {
  if (!input || typeof input !== "object") throw new Error("命令格式不正确");
  const r = input as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const template = typeof r.template === "string" ? r.template : "";
  if (!name) throw new Error("命令名不能为空（斜杠后面敲的那串，例如 review）");
  if (name.length > MAX_NAME_CHARS) throw new Error(`命令名不能超过 ${MAX_NAME_CHARS} 个字符`);
  if (!NAME_RE.test(name)) throw new Error("命令名只能用字母、数字、下划线和短横线，且以字母或数字开头");
  if (RESERVED.has(name.toLowerCase())) throw new Error(`「${name}」是内置命令名，请换一个`);
  if (!template.trim()) throw new Error("提示词模板不能为空");
  if (template.length > MAX_TEMPLATE_CHARS) {
    throw new Error(`提示词模板不能超过 ${MAX_TEMPLATE_CHARS} 个字符`);
  }
  return {
    name,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : undefined,
    description: typeof r.description === "string" ? r.description.trim().slice(0, 200) : undefined,
    template: template.slice(0, MAX_TEMPLATE_CHARS),
  };
}

/** 兼容旧调用方的新增或更新（同名覆盖）；HTTP 创建接口改用 createCommand。 */
export async function saveCommand(input: unknown): Promise<{ command: UserCommand; created: boolean }> {
  const command = validate(input);
  const all = await listCommands();
  const idx = all.findIndex((c) => c.name === command.name);
  let created = false;
  if (idx >= 0) {
    all[idx] = command;
  } else {
    if (all.length >= MAX_COMMANDS) throw new Error(`命令数量已达上限 ${MAX_COMMANDS} 条，请先删除一些`);
    all.push(command);
    created = true;
  }
  await persist(all);
  return { command, created };
}

/** 显式创建：重名必须报错，避免管理页在列表过期时静默覆盖已有命令。 */
export async function createCommand(input: unknown): Promise<UserCommand> {
  const command = validate(input);
  const all = await listCommands();
  if (all.some((item) => item.name === command.name)) {
    throw new Error(`命令「${command.name}」已存在，请直接编辑现有命令或换一个名字`);
  }
  if (all.length >= MAX_COMMANDS) throw new Error(`命令数量已达上限 ${MAX_COMMANDS} 条，请先删除一些`);
  all.push(command);
  await persist(all);
  return command;
}

/**
 * 按原命令名更新一条命令；允许改名，但不允许与另一条已有命令重名。
 * 找不到原命令时返回 null，让 HTTP 层返回 404，而不是把旧客户端误判成保存成功。
 */
export async function updateCommand(originalName: string, input: unknown): Promise<UserCommand | null> {
  const command = validate(input);
  const all = await listCommands();
  const idx = all.findIndex((item) => item.name === originalName);
  if (idx < 0) return null;
  if (all.some((item, itemIndex) => itemIndex !== idx && item.name === command.name)) {
    throw new Error(`命令「${command.name}」已存在，请换一个命令名`);
  }
  all[idx] = command;
  await persist(all);
  return command;
}

export async function deleteCommand(name: string): Promise<{ removed: boolean; commands: UserCommand[] }> {
  const all = await listCommands();
  const next = all.filter((c) => c.name !== name);
  const removed = next.length !== all.length;
  if (removed) await persist(next);
  return { removed, commands: next };
}

/**
 * 把命令模板展开成可放进输入框的文本。
 * `{{selection}}` ← 调用时输入框里已有的内容（没有就替换成空串）；
 * `{{date}}`      ← 当前本地日期（YYYY-MM-DD）。
 */
export function expandTemplate(template: string, selection = ""): string {
  const today = new Date().toLocaleDateString("sv-SE"); // sv-SE 恰好是 YYYY-MM-DD
  return template
    .replace(/\{\{selection\}\}/g, selection)
    .replace(/\{\{date\}\}/g, today);
}
