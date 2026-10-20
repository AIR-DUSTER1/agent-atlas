/**
 * static.ts — 前端静态文件分发（白名单式防目录穿越）
 * ============================================================
 * 只服务 public/ 下的单层文件名（`\w - .` 白名单）与唯一的子目录
 * modules/（前端 ESM 拆分），其余一律 404 —— 杜绝 ../ 穿越；
 * 首字符必须是字面量/hyphen（禁止 dotfiles，顺带挡住 ".." 这类相对段）。
 * 全部 no-store：页面与脚本始终取最新（本地学习 demo，禁用浏览器缓存，
 * 避免「更新代码后浏览器还在跑旧 app.js → 按钮点了没反应」）。
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 命中并回包返回 true；未命中（含穿越尝试）返回 false，由入口统一 404 */
export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const raw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const m = raw.match(/^(?:modules\/)?(\w[\w.-]*)$/); // modules/xxx.js 与单层文件，名字不允许以 . 开头
  if (!m) return false;
  const file = m[1];
  // m[0] = 完整匹配（可能带字面量 modules/ 前缀）；m[1] = 纯文件名。
  // 前缀由正则限定为字面量 modules/，不含用户可控段，可直接用于拼路径。
  const rel = m[0].startsWith("modules/") ? join("modules", file) : file;
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, {
      "Content-Type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
