/**
 * ============================================================
 * modules/mcp-command.ts — MCP 完整启动命令的纯解析工具
 * ============================================================
 * 职责：把用户粘贴的 `$ npx -y ...`、`node server.js` 或带引号路径拆成
 * command + args，并推导稳定的 server id。
 * 设计立场：
 *  - 只做词法拆分，不执行 shell、不做变量展开；
 *  - 引号内容保留空格，反斜杠路径不被误当转义；
 *  - 所有错误返回中文，设置页可直接展示。
 */

export interface ParsedMcpCommand {
  command: string;
  args: string[];
}

function commandTokens(raw: string): string[] {
  let text = raw.replace(/^\uFEFF/, "").trim();
  // 兼容从终端复制时带上的提示符 / PowerShell 调用运算符。
  text = text.replace(/^[$>]\s*/, "").replace(/^&\s*/, "");
  if (!text) throw new Error("请粘贴完整的启动命令");

  const tokens: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) {
        quote = "";
        continue;
      }
      if (quote === '"' && char === "\\" && index + 1 < text.length) {
        const next = text[index + 1]!;
        if (next === '"' || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("完整启动命令中的引号没有闭合");
  if (current) tokens.push(current);
  return tokens;
}

export function parseMcpCommandLine(raw: string): ParsedMcpCommand {
  const tokens = commandTokens(raw);
  const command = tokens.shift()?.trim() ?? "";
  if (!command) throw new Error("启动命令不能为空");
  return { command, args: tokens };
}

/** 从包名或脚本路径推导 id；返回值始终满足 MCP server id 白名单。 */
export function inferMcpServerId(command: string, args: readonly string[]): string {
  const candidate = args.find((arg) =>
    !arg.startsWith("-")
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)
  ) ?? command;
  const withoutScope = candidate.replace(/^@[^/]+\//, "");
  const basename = withoutScope.split(/[\\/]/).pop() ?? withoutScope;
  const stem = basename.replace(/\.(?:[cm]?[jt]sx?|exe|cmd|bat|ps1)$/i, "");
  const id = stem
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return id || "mcp-server";
}

export function quoteMcpArg(value: string): string {
  if (!/[\s"']/u.test(value)) return value;
  const escaped = value
    .replace(/\\+$/g, (slashes) => `${slashes}${slashes}`)
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function formatMcpCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteMcpArg).filter(Boolean).join(" ");
}
