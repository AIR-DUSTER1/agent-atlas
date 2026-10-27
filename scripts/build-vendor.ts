/**
 * scripts/build-vendor.ts — 把前端 npm 依赖打成自包含浏览器 ESM
 * ============================================================
 * 设计立场：
 *  - wrapper 由 tsc 正常输出，npm 库由本脚本输出为 *-lib.js，两者绝不共用文件名；
 *  - 每个产物必须自包含（不能残留裸导入 / require / source map）；
 *  - 清单、产物集合与 wrapper 集合强校验，缺一个就让 build:client 非 0 退出。
 */
import { build } from "esbuild";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VENDOR_ENTRIES, VENDOR_WRAPPER_FILES } from "./vendor-entries.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = join(ROOT, "src", "server", "public", "vendor");

const BARE_IMPORT = /\bfrom\s*["'][^./@][^"']*["']|\bimport\s*\(\s*["'][^./@][^"']*["']/;
const REQUIRE_CALL = /\brequire\s*\(/;
const SOURCE_MAP = /sourceMappingURL=/;

async function assertFileExists(path: string, hint: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("不是文件");
  } catch {
    throw new Error(`缺少前端产物 ${path}：${hint}`);
  }
}

/** 删除上一轮 *-lib.js，避免已移除依赖的旧产物继续被静态服务；wrapper 不在这里删。 */
async function removeStaleLibs(expected: Set<string>): Promise<void> {
  await mkdir(VENDOR_DIR, { recursive: true });
  const entries = await readdir(VENDOR_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith("-lib.js") && !expected.has(entry.name)) {
      await rm(join(VENDOR_DIR, entry.name), { force: true });
    }
  }
}

export async function buildVendors(): Promise<void> {
  for (const filename of VENDOR_WRAPPER_FILES) {
    await assertFileExists(
      join(VENDOR_DIR, filename),
      "tsc 必须先编译 src/client/vendor/*.ts",
    );
  }

  await removeStaleLibs(new Set(VENDOR_ENTRIES.map((entry) => entry.outputFile)));

  for (const entry of VENDOR_ENTRIES) {
    const outfile = join(VENDOR_DIR, entry.outputFile);
    const result = await build({
      stdin: {
        contents: entry.source,
        loader: "ts",
        resolveDir: ROOT,
        sourcefile: `vendor-entry/${entry.name}.ts`,
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "inline",
      sourcemap: false,
      charset: "utf8",
      logLevel: "silent",
      metafile: true,
    });

    const outputMeta = Object.values(result.metafile?.outputs ?? {}).find((item) => item.entryPoint);
    if (!outputMeta || outputMeta.imports.length > 0) {
      const imports = outputMeta?.imports.map((item) => `${item.path}${item.external ? " (external)" : ""}`).join(", ");
      throw new Error(`${entry.outputFile} 不是自包含产物：${imports || "缺少 metafile output"}`);
    }
    const body = await readFile(outfile, "utf8");
    if (SOURCE_MAP.test(body)) throw new Error(`${entry.outputFile} 不应生成 source map`);
    console.log(`  ✓ ${entry.outputFile} (${Math.round((await stat(outfile)).size / 1024)} KB, ${entry.license})`);
  }

  const files = (await readdir(VENDOR_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const allowed = new Set<string>([
    ...VENDOR_WRAPPER_FILES,
    ...VENDOR_ENTRIES.map((entry) => entry.outputFile),
  ]);
  const unexpected = files.filter((name) => !allowed.has(name));
  if (unexpected.length) {
    throw new Error(`vendor 目录存在未登记文件：${unexpected.join(", ")}`);
  }

  console.log(`✓ vendor 构建完成：${VENDOR_ENTRIES.length} 个自包含库 + ${VENDOR_WRAPPER_FILES.length} 个 wrapper`);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  void buildVendors().catch((err: unknown) => {
    console.error(`✗ vendor 构建失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
