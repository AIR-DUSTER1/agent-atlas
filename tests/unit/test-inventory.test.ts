/**
 * test-inventory.test.ts — 测试文件清单完整性
 * ============================================================
 * 为什么存在：`npm test` 用显式文件清单跑 node:test，漏登记的文件既不执行
 * 也不报错 —— 守门测试会静默失效。本项目真实踩过两次：
 *  1. tests/unit/antdv-usage.test.ts 未被登记，重组 styles/ 后它内部写死的
 *     styles/tokens.css 已失效，但没人发现（因为没人跑它）；
 *  2. AGENTS.md 的质量门曾指向 tests/vue/antdv-usage.test.ts，该文件不存在，
 *     vitest 的 include 只收 tests/vue/**，于是那条命令等于什么都没跑。
 *
 * 断言：
 *  1. tests/unit/ 与 tests/integration/ 下每个 *.test.ts 都在 package.json 的
 *     test 脚本里出现过；
 *  2. 质量门文档（AGENTS.md）里提到的每个 tests/**\/*.test.ts 路径都真实存在；
 *  3. 反过来：脚本里列的每个测试文件也必须真实存在（防路径写错）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(path.replaceAll("\\", "/").slice(ROOT.replaceAll("\\", "/").length));
    }
  }
  return out;
}

async function allScripts(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return Object.values(pkg.scripts ?? {}).join(" ");
}

async function testScript(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts?.test ?? "";
}

test("tests/ 下每个 node:test 文件都被某个 npm script 引用", async () => {
  // 判据是「被任一 script 引用」而不是「在 test 里」：
  // tests/integration/postgres.test.ts 需要外部 PG，有意单独走 test:postgres。
  // 真正的漏洞是「哪个 script 都不引用」，那种文件永远不跑。
  const scripts = await allScripts();
  const onDisk = [
    ...await filesUnder(join(ROOT, "tests", "unit")),
    ...await filesUnder(join(ROOT, "tests", "integration")),
  ].sort();
  assert.ok(onDisk.length > 50, `测试文件数量异常：${onDisk.length}`);
  const unlisted = onDisk.filter((rel) => !scripts.includes(rel));
  assert.deepEqual(
    unlisted,
    [],
    `以下测试文件没被任何 npm script 引用，等于永远不跑：\n${unlisted.join("\n")}`,
  );
});

test("代码职守门（antdv / 目录布局 / 测试清单）本身在 npm test 里", async () => {
  // 这几个文件守护的是「其他守门是否有效」，漏跑它们等于整套护栏失效且无声。
  const script = await testScript();
  for (const rel of [
    "tests/unit/antdv-usage.test.ts",
    "tests/unit/view-layout.test.ts",
    "tests/unit/test-inventory.test.ts",
  ]) {
    assert.ok(script.includes(rel), `${rel} 必须登记在 npm test 里（它守护其他守门）`);
  }
});

test("npm test 清单里列的每个测试文件都真实存在", async () => {
  const script = await testScript();
  const listed = [...script.matchAll(/(tests\/[\w./-]+\.test\.ts)/g)].map((match) => match[1] as string);
  assert.ok(listed.length > 50, `清单解析异常：只解析出 ${listed.length} 个文件`);
  const missing: string[] = [];
  for (const rel of new Set(listed)) {
    const exists = await readFile(join(ROOT, rel), "utf8").then(() => true).catch(() => false);
    if (!exists) missing.push(rel);
  }
  assert.deepEqual(missing, [], `清单里有不存在的测试文件：\n${missing.join("\n")}`);
});

test("质量门文档引用的测试路径都真实存在", async () => {
  const agents = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  const referenced = [...new Set(
    [...agents.matchAll(/(tests\/[\w./-]+\.test\.ts)/g)].map((match) => match[1] as string),
  )];
  assert.ok(referenced.length > 0, "AGENTS.md 应至少引用一个测试文件");
  const missing: string[] = [];
  for (const rel of referenced) {
    const exists = await readFile(join(ROOT, rel), "utf8").then(() => true).catch(() => false);
    if (!exists) missing.push(rel);
  }
  assert.deepEqual(missing, [], `AGENTS.md 引用了不存在的测试文件：\n${missing.join("\n")}`);
});
