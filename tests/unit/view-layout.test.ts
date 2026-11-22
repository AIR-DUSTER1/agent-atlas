/**
 * tests/unit/view-layout.test.ts — 前端按页面组织守门
 * ============================================================
 * 背景：`src/client/views/` 曾平铺 61 个文件（Vue 组件 + legacy 桥 + 挂载模块
 * 混在两级目录里），新增功能时无法一眼看出「谁属于哪个页面」。
 * 现在前端按「一个页面一个目录」组织：
 *
 *   src/client/views/<page>/          页面组件 + 该页面专属的 .ts 逻辑
 *   src/client/views/settings/<view>/ 设置页的每个分区各占一个子目录
 *
 * 本测试守的是**结构本身**，不是文件内容：
 *  1. views/ 根目录不得再有文件（全部进页面目录）；
 *  2. 每个页面目录必须有页面级 SFC（.vue），否则说明目录只是随手建的；
 *  3. apps/ 目录不得回流（挂载模块已并入各页面目录）；
 *  4. pages/ 目录仍不得存在（M4 4.5 退役，勿与 views/<page>/ 混淆）；
 *  5. 页面目录内不得直接 import 其它页面目录的实现
 *     （跨页共享必须上移到 core/modules/ui/stores）。
 *
 * 注释：目录名用 kebab-case（AGENTS.md §5.2）。本文件只读取目录结构，不读构建产物。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT = join(ROOT, "src", "client");
const VIEWS = join(CLIENT, "views");

/** 设置页的分区目录：允许「只有 .ts 没有 .vue」，因为组件在各自目录内仍需 SFC。 */
const SETTINGS_DIR = join(VIEWS, "settings");

async function entries(dir: string): Promise<import("node:fs").Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await entries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** 页面目录 = views/ 下一层目录，或 views/settings/ 下再一层。 */
async function pageDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const entry of await entries(VIEWS)) {
    if (!entry.isDirectory()) continue;
    const path = join(VIEWS, entry.name);
    if (entry.name === "settings") {
      for (const sub of await entries(path)) {
        if (sub.isDirectory()) dirs.push(join(path, sub.name));
      }
    } else {
      dirs.push(path);
    }
  }
  return dirs;
}

/** 相对 views/ 的目录名，用于报错定位。 */
function relViews(dir: string): string {
  return relative(VIEWS, dir).replaceAll("\\", "/");
}

test("views 根目录不得平铺文件，全部按页面归入子目录", async () => {
  const stray: string[] = [];
  for (const entry of await entries(VIEWS)) {
    if (entry.isFile()) stray.push(entry.name);
  }
  assert.deepEqual(
    stray,
    [],
    `views/ 根目录不应再有文件，请放进对应页面目录（views/<page>/）：\n${stray.join("\n")}`,
  );
});

test("每个页面目录至少有一个页面级 Vue 组件", async () => {
  const missing: string[] = [];
  for (const dir of await pageDirs()) {
    const files = await walk(dir);
    if (!files.some((file) => file.endsWith(".vue"))) missing.push(relViews(dir));
  }
  assert.deepEqual(
    missing,
    [],
    `这些页面目录没有 .vue 组件（要么补组件，要么目录建错了）：\n${missing.join("\n")}`,
  );
});

test("apps/ 目录已退役，挂载模块随页面放置", async () => {
  const list = await readdir(join(CLIENT, "apps"), { withFileTypes: true }).catch(() => []);
  assert.deepEqual(
    list.map((entry) => entry.name),
    [],
    "src/client/apps 已并入各页面目录，不允许回流",
  );
});

test("pages/ 目录仍不得存在（与 views/<page>/ 区分）", async () => {
  const exists = await readdir(join(CLIENT, "pages")).then(() => true).catch(() => false);
  assert.equal(exists, false, "src/client/pages 已随 M4 4.5 退役；页面请放 views/<page>/");
});

/**
 * 跨页依赖只允许「壳 → 页面」单向：
 *  - 壳（app / welcome / settings 及其分区）负责编排，可以引用页面模块，
 *    例如 settings/plugins 需要调 estate / job / kb 的弹窗入口；
 *  - **叶子页面之间不得互相 import**（chat / estate / job / kb / browser / external / auth）。
 *    真实业务共享必须上移到 core / modules / ui / stores。
 */
const SHELL_PAGES = new Set(["app", "welcome"]);
const LEAF_PAGES = new Set(["auth", "chat", "estate", "job", "kb", "browser", "external"]);

/** 把 views/ 相对目录归一到「页面名」：settings/<view> 归为 settings。 */
function pageOf(dir: string): string {
  const [head] = dir.split("/");
  return head ?? dir;
}

function isShellPage(page: string): boolean {
  return SHELL_PAGES.has(page) || page === "settings";
}

test("叶子页面之间不得互相 import，跨页共享须上移到 core/modules/ui/stores", async () => {
  const dirs = new Map((await pageDirs()).map((dir) => [relViews(dir), pageOf(relViews(dir))]));
  const violations: string[] = [];
  for (const dir of await pageDirs()) {
    const ownerDir = relViews(dir);
    const ownerPage = pageOf(ownerDir);
    if (isShellPage(ownerPage)) continue; // 壳可以编排页面，见上方注释
    for (const file of await walk(dir)) {
      if (!/\.(ts|vue)$/.test(file)) continue;
      const source = (await readFile(file, "utf8"))
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ");
      const specs = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)]
        .map((match) => match[1] ?? match[2] ?? "");
      for (const spec of specs) {
        if (!spec.startsWith(".")) continue;
        const target = relative(VIEWS, join(dir, spec)).replaceAll("\\", "/");
        for (const [otherDir, otherPage] of dirs) {
          if (otherDir === ownerDir || !target.startsWith(`${otherDir}/`)) continue;
          if (otherPage === ownerPage || isShellPage(otherPage)) continue;
          violations.push(`${ownerDir} → ${spec}（属于叶子页面 ${otherPage}）`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `叶子页面之间不得直接互相 import，请把共享部分上移：\n${violations.join("\n")}`,
  );
});

test("设置页分区的目录名与 settings store 的分区 key 一一对应", async () => {
  const settingsSource = await readFile(join(CLIENT, "stores", "settings.ts"), "utf8");
  const keys = [...settingsSource.matchAll(/view:\s*"([a-z-]+)"/g)].map((match) => match[1] as string);
  assert.ok(keys.length >= 10, `settings store 的分区 key 数量异常：${keys.length}`);
  const dirNames = (await entries(SETTINGS_DIR))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    dirNames,
    [...new Set(keys)].sort(),
    "views/settings/ 下的目录必须与 settings store 的分区一一对应（新增分区要同时建目录）",
  );
});
