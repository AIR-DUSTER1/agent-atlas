/**
 * scripts/check-file-size.ts — 单文件行数上限门（500 行）
 * ============================================================
 * 为什么需要：项目要求「单文件不超过 500 行、单一职责」，靠人自觉守不住；
 * 用脚本放进 npm test 前置与 CI，超限就红。
 * 检查范围：前端源码 src/client/**.ts + 后端 src/**.ts + scripts/**.ts
 * （构建产物 src/server/public/ 是生成的，不参与检查）。
 * 跳过：注释空行照常计入（行数是维护成本的近似，别为凑数把代码压成一行）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_LINES = 500;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".setting", "data", "public"]);

async function collect(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collect(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const files = await collect(join(ROOT, "src"));
  files.push(...await collect(join(ROOT, "scripts")));
  const offenders: Array<{ file: string; lines: number }> = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (lines > MAX_LINES) offenders.push({ file: relative(ROOT, file), lines });
  }
  if (offenders.length) {
    console.error(`✗ 以下文件超过 ${MAX_LINES} 行（请按职责拆分）：`);
    for (const o of offenders.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${o.lines.toString().padStart(5)}  ${o.file}`);
    }
    process.exit(1);
  }
  const max = Math.max(...files.map((f) => 0));
  void max;
  console.log(`✓ 单文件行数门通过（${files.length} 个文件，上限 ${MAX_LINES} 行）`);
}

void main();
