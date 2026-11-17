/**
 * scripts/compose-html.ts — 构建期 HTML 片段组装
 * ============================================================
 * 只使用 Node 标准库，不把页面结构塞进 JS 字符串。include 路径限制在
 * `src/client/pages/`，并拒绝越界、符号链接、循环引用与过深递归。
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const INCLUDE_RE = /<!--\s*@include\s+([^\s]+)\s*-->/g;
const MAX_INCLUDE_DEPTH = 8;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 递归组装一个 HTML 入口及其片段；片段只能来自 client/pages。 */
export async function composeHtml(entryPath: string, clientRoot: string): Promise<string> {
  const pagesRoot = await realpath(resolve(clientRoot, "pages"));
  const entry = resolve(entryPath);
  const cache = new Map<string, string>();

  async function render(file: string, chain: readonly string[], depth: number, isEntry = false): Promise<string> {
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new Error(`HTML include 递归过深（>${MAX_INCLUDE_DEPTH}）：${chain.join(" -> ")}`);
    }
    const candidate = resolve(file);
    let info;
    try {
      info = await lstat(candidate);
    } catch {
      throw new Error(`HTML include 文件不存在：${candidate}`);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`HTML include 必须是普通文件，不能是符号链接：${candidate}`);
    }
    const realFile = await realpath(candidate);
    if (!isEntry && !isInside(pagesRoot, realFile)) {
      throw new Error(`HTML include 越出 pages/ 目录：${candidate}`);
    }
    if (chain.includes(realFile)) {
      throw new Error(`HTML include 检测到循环引用：${[...chain, realFile].join(" -> ")}`);
    }
    const cached = cache.get(realFile);
    if (cached !== undefined) return cached;

    const raw = await readFile(realFile, "utf8");
    const matches = [...raw.matchAll(INCLUDE_RE)];
    let output = "";
    let cursor = 0;
    for (const match of matches) {
      const marker = match[0] ?? "";
      const includePath = match[1] ?? "";
      const index = match.index ?? cursor;
      output += raw.slice(cursor, index);
      output += await render(
        resolve(dirname(realFile), includePath),
        [...chain, realFile],
        depth + 1,
      );
      cursor = index + marker.length;
    }
    output += raw.slice(cursor);
    cache.set(realFile, output);
    return output;
  }

  return render(entry, [], 0, true);
}