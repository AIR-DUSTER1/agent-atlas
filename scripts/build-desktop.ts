/**
 * scripts/build-desktop.ts — 桌面端构建：main.ts / preload.ts → desktop/build/
 * ============================================================
 * 为什么需要：桌面端已 TypeScript 化，而 Electron 只能执行 JS。
 * 两个特殊约束：
 *  - 主进程编译成 ESM（.js，package.json 是 "type":"module"）；
 *  - preload 在 sandbox 下只支持 CommonJS，必须单独编译成 .cjs ——
 *    所以分两次 tsc，第二次用 module=CommonJS 并把扩展名改回 .cjs。
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

async function runTsc(args: string[]): Promise<void> {
  try {
    await execFileAsync(process.execPath, [TSC, ...args], { cwd: ROOT });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    throw new Error("桌面端 TypeScript 编译失败");
  }
}

async function main(): Promise<void> {
  await rm(join(ROOT, "desktop", "build"), { recursive: true, force: true });
  await mkdir(join(ROOT, "desktop", "build"), { recursive: true });

  // ① 主进程（ESM）
  await runTsc(["-p", join(ROOT, "tsconfig.desktop.json")]);

  // ② preload 必须 CJS：单独的配置（含 ambient 声明），编译后改扩展名
  const cjsConfig = join(ROOT, "desktop", "tsconfig.preload.json");
  await writeFile(cjsConfig, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "CommonJS",
      lib: ["ES2022"],
      types: ["node"],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      rootDir: ".",
      outDir: "build",
      noEmit: false,
    },
    include: ["preload.ts", "electron-ambient.d.ts"],
  }, null, 2), "utf8");
  try {
    await runTsc(["-p", cjsConfig]);
  } finally {
    await rm(cjsConfig, { force: true });
  }
  const built = await readdir(join(ROOT, "desktop", "build"));
  if (built.includes("preload.js")) {
    await rename(join(ROOT, "desktop", "build", "preload.js"), join(ROOT, "desktop", "build", "preload.cjs"));
  }

  // 产物自检：缺任何一个都会让桌面端白屏或 preload 失效
  const files = await readdir(join(ROOT, "desktop", "build"));
  for (const required of ["main.js", "preload.cjs"]) {
    if (!files.includes(required)) {
      console.error(`✗ 桌面端构建产物缺少 ${required}`);
      process.exit(1);
    }
  }
  console.log("✓ 桌面端构建完成 → desktop/build/");
}

void main();
