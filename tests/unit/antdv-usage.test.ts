/**
 * tests/unit/antdv-usage.test.ts — antdv-next 使用规范守门（可证伪）
 * ============================================================
 * 为什么存在：`antdv lint` 在 @antdv-next/cli 0.0.0-beta.1 里是空壳
 * （只打印 `Parsed args` 后退出 0），把它当质量门等于制造假覆盖。
 * 本测试接管该职责，断言的都是「违反了必须红」的硬契约：
 *
 *  1. 组件库只在 .vue 里 import，.ts 里不得出现；
 *  2. 每个用 antdv 的 SFC 都必须包 AntdvProvider（主题/locale 唯一入口）；
 *  3. 业务组件不得自建 ConfigProvider、不得写私有 theme.token；
 *  4. 不得使用已废弃 API（实测 1.8.2 的 Input 已移除 bordered/addonBefore/addonAfter）；
 *  5. 主题种子色必须与 styles/tokens.css 同源（两边十六进制一致）；
 *  6. 不得用 !important 覆盖 .ant-* 组件内部样式；
 *  7. antdv 引入链不得进入首屏闭包（app.js 里不得出现组件库特征串）。
 *
 * 第 7 条依赖构建产物；产物不存在时跳过（CI 里 build:client 在 test 之前）。
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT = join(ROOT, "src", "client");
const VIEWS = join(CLIENT, "views");
const STYLES = join(CLIENT, "styles");
const PUBLIC = join(ROOT, "src", "server", "public", "assets");

/** antdv 引入的唯一合法入口（主题容器）。 */
const PROVIDER_FILE = "ui/antdv-provider.vue";
/** 主题种子表（与 tokens.css 同源的唯一来源）。 */
const THEME_FILE = "ui/antdv-theme.ts";

async function walk(dir: string, suffixes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path, suffixes));
    else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) out.push(path);
  }
  return out;
}

function rel(path: string): string {
  return relative(CLIENT, path).replaceAll("\\", "/");
}

/** 去掉注释，避免 banner 里的示例代码造成误判。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

/** 源码是否 import 了 antdv-next（含子路径，如 antdv-next/locale/zh_CN）。 */
function importsAntdv(source: string): boolean {
  return /\bfrom\s+["']antdv-next(\/[^"']*)?["']|\bimport\s*\(\s*["']antdv-next(\/[^"']*)?["']\s*\)/.test(source);
}

test("组件库只在 .vue 里 import，.ts 文件零引用", async () => {
  const violations: string[] = [];
  for (const file of await walk(CLIENT, [".ts"])) {
    const name = rel(file);
    if (name.startsWith("vendor/")) continue;
    if (importsAntdv(stripComments(await readFile(file, "utf8")))) violations.push(name);
  }
  assert.deepEqual(violations, [], `这些 .ts 文件 import 了 antdv-next（应改为经 .vue 组件）：\n${violations.join("\n")}`);
});

test("用 antdv 的 SFC 必须包 AntdvProvider，且不得自建 ConfigProvider", async () => {
  const unthemed: string[] = [];
  const selfProvider: string[] = [];
  for (const file of await walk(CLIENT, [".vue"])) {
    const name = rel(file);
    const source = stripComments(await readFile(file, "utf8"));
    if (!importsAntdv(source)) continue;
    // AntdvProvider 自身就是那个容器，不要求它包自己
    if (name === PROVIDER_FILE) continue;
    if (!/<AntdvProvider[\s>]/.test(source)) unthemed.push(name);
    if (/\bConfigProvider\b/.test(source.replace(/import\s*\{[^}]*\}\s*from\s*["']antdv-next["'];?/g, ""))) {
      // 允许 import 语句里出现，但模板/渲染里不得直接用
      if (/<ConfigProvider[\s>]|h\(ConfigProvider/.test(source)) selfProvider.push(name);
    }
  }
  assert.deepEqual(unthemed, [], `这些 SFC 用了 antdv 但没包 <AntdvProvider>：\n${unthemed.join("\n")}`);
  assert.deepEqual(selfProvider, [], `这些 SFC 自建了 ConfigProvider（主题必须走 AntdvProvider）：\n${selfProvider.join("\n")}`);
});

test("不得使用 antdv-next 已废弃的 Input API", async () => {
  // 实测 1.8.2：Input 的 addonBefore/addonAfter/bordered 已从 API 与类型定义中移除，
  // 写上去 tsc 可能放过（attrs 兜底）但运行时静默无效 —— 只有静态断言能拦住。
  // ⚠ 裸 v-model 只对 antdv 组件非法：原生 <input v-model> 是正确的项目写法，
  //   所以这条按「antdv 组件标签」范围匹配，不做全文件模糊匹配。
  const deprecated: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /\baddon-before=/i, hint: "addon-before 已废弃，改用 variant + 外层布局" },
    { pattern: /\baddon-after=/i, hint: "addon-after 已废弃，改用 variant + 外层布局" },
    { pattern: /:bordered=/, hint: "bordered 已废弃，改用 :variant" },
  ];
  /** antdv 组件标签上的裸 v-model（非 :value / :checked / :open 等显式绑定）。 */
  const BARE_VMODEL_ON_ANTDV = /<(Input|Input\.Password|Input\.TextArea|Select|Switch|Checkbox|Segmented|Radio|RadioGroup|DatePicker|Slider|Rate|InputNumber|AutoComplete|Cascader|TreeSelect|Upload)\b[^>]*\sv-model=(?!:)/;
  const violations: string[] = [];
  for (const file of await walk(CLIENT, [".vue"])) {
    const source = stripComments(await readFile(file, "utf8"));
    if (!importsAntdv(source)) continue;
    for (const { pattern, hint } of deprecated) {
      if (pattern.test(source)) violations.push(`${rel(file)}: ${hint}`);
    }
    if (BARE_VMODEL_ON_ANTDV.test(source)) {
      violations.push(`${rel(file)}: antdv 控件用 v-model:value / v-model:checked，裸 v-model 不生效`);
    }
  }
  assert.deepEqual(violations, [], `组件库废弃 API：\n${violations.join("\n")}`);
});

test("antdv 组件的模板标签必须能在 script setup 里解析到", async () => {
  // ⚠ 实测踩过的坑：
  //  (1) 小写标签名（<switch> / <select> 之类）被 Vue 视为原生 HTML 元素，
  //      组件完全不生效，DOM 里出现 <switch class="..."> 这种幽灵节点；
  //  (2) `import { Switch as ASwitch }` 后模板写 <ASwitch> 也解析不到 ——
  //      <script setup> 只把导入的**原始名**暴露给模板，别名不参与 resolveComponent。
  // 所以规则是：组件必须按**原具名导入**，模板里用首字母大写的同名标签。
  // 只有「与 antdv 组件同名、但小写会退化成原生元素」的标签才要管。
  // <input> / <button> / <textarea> / <select> 本身都是合法原生标签，不在此列。
  const SINGLE_WORD = ["Switch", "Select", "Checkbox", "Alert", "Empty", "Tag", "Segmented", "Modal", "Drawer", "Tooltip"];
  const violations: string[] = [];
  for (const file of await walk(CLIENT, [".vue"])) {
    const source = stripComments(await readFile(file, "utf8"));
    if (!importsAntdv(source)) continue;
    // 1) 别名字面：import { X as Y } —— Y 在模板里解析不到
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']antdv-next["']/g)) {
      const body = match[1] ?? "";
      for (const part of body.split(",")) {
        const alias = /\b(\w+)\s+as\s+(\w+)/.exec(part.trim());
        if (alias) violations.push(`${rel(file)}: import 别名 ${alias[1]} as ${alias[2]} 在模板里解析不到，用原名`);
      }
    }
    // 2) 小写单标签：<switch / <select / <checkbox …（含自闭合与带属性两种）
    for (const name of SINGLE_WORD) {
      const lower = name.toLowerCase();
      if (name === "Input") continue; // <input> 是原生控件，允许
      const re = new RegExp(`<${lower}(\\s|/|>)`, "g");
      if (re.test(source)) {
        violations.push(`${rel(file)}: <${lower}> 会被当成原生元素，请写 <${name}>`);
      }
    }
  }
  assert.deepEqual(violations, [], `组件标签解析问题：\n${violations.join("\n")}`);
});

test("引用 antdv 组件标签的 SFC 必须真的 import 了它", async () => {
  // ⚠ 真实事故：settings-skills-vue.vue 的模板写了 <Switch> 但忘了 import，
  // Vue 把它当原生 <switch> 元素渲染，面板整块白屏。
  // 上面几条规则都靠 `if (!importsAntdv(source)) continue` 过滤，
  // 恰好会跳过这种「有标签无 import」的文件 —— 必须单独守一条。
  const KNOWN_COMPONENTS = [
    "Alert", "Button", "Checkbox", "Empty", "Form", "FormItem", "Input", "Select",
    "Space", "Switch", "Table", "Tag", "Segmented", "Modal", "Tooltip", "TextArea",
  ];
  const violations: string[] = [];
  for (const file of await walk(CLIENT, [".vue"])) {
    if (rel(file) === PROVIDER_FILE) continue;
    const source = stripComments(await readFile(file, "utf8"));
    for (const component of KNOWN_COMPONENTS) {
      // <Switch ...> 或 <Switch>（首字母大写才算组件；小写是原生标签，由另一条规则管）
      const used = new RegExp(`<${component}(\\s|/|>)`).test(source);
      if (!used) continue;
      // Input.Password / Input.TextArea 只要求 import 了 Input
      const importName = component === "TextArea" ? "Input" : component;
      const imported = new RegExp(`\\b${importName}\\b[^}]*\\}\\s*from\\s*["']antdv-next["']`).test(source)
        || new RegExp(`import\\s+${importName}\\s+from`).test(source);
      if (!imported) violations.push(`${rel(file)}: 模板用了 <${component}> 但没从 antdv-next import`);
    }
  }
  assert.deepEqual(violations, [], `组件标签缺少 import（会被当原生元素渲染）：\n${violations.join("\n")}`);
});

test("主题种子色必须与 styles/tokens.css 同源", async () => {
  const themeSource = await readFile(join(CLIENT, THEME_FILE), "utf8");
  const tokens = await readFile(join(STYLES, "tokens.css"), "utf8");
  /** 取 tokens.css 里某个 CSS 变量的第一个十六进制值。 */
  const tokenValue = (name: string): string => {
    const match = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
    assert.ok(match?.[1], `tokens.css 缺少 --${name}`);
    return (match[1] as string).toLowerCase();
  };
  // 深色种子（tokens.css :root 段）
  const darkPairs: Array<[string, string]> = [
    ["colorPrimary", "accent"],
    ["colorBgBase", "bg"],
    ["colorBgContainer", "bg-elev"],
    ["colorBorder", "border"],
    ["colorText", "text"],
    ["colorTextSecondary", "text-2"],
    ["colorSuccess", "green"],
    ["colorError", "red"],
    ["colorWarning", "amber"],
  ];
  for (const [seedKey, cssVar] of darkPairs) {
    const expected = tokenValue(cssVar);
    const actual = new RegExp(`${seedKey}\\s*:\\s*"(#[0-9a-fA-F]{6})"`).exec(themeSource)?.[1]?.toLowerCase();
    assert.ok(actual, `antdv-theme.ts 缺少种子 ${seedKey}`);
    assert.equal(actual, expected, `${seedKey} 与 tokens.css --${cssVar} 不一致（主题会与页面割裂）`);
  }
});

test("不得用 !important 覆盖 .ant-* 组件内部样式", async () => {
  const violations: string[] = [];
  for (const file of await walk(CLIENT, [".css", ".vue"])) {
    const source = await readFile(file, "utf8");
    // 只看样式块/样式文件里的 .ant- 选择器 + !important 组合
    for (const line of source.split(/\r?\n/)) {
      if (/\.ant-[\w-]+[^{]*\{[^}]*!important/.test(line) || (/\.ant-[\w-]/.test(line) && /!important/.test(line))) {
        violations.push(`${rel(file)}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(violations, [], `禁止 !important 覆盖 .ant-*（改用组件 classes/styles）：\n${violations.join("\n")}`);
});

test("antdv 引入链不得进入首屏闭包", async () => {
  const appJs = join(PUBLIC, "app.js");
  const exists = await stat(appJs).then(() => true).catch(() => false);
  if (!exists) return; // 构建产物不存在时跳过（构建前的局部测试）
  const bundle = await readFile(appJs, "utf8");
  for (const marker of ["ant-btn", "ant-input", "css-var-v-"]) {
    assert.equal(bundle.includes(marker), false, `首屏 app.js 含 antdv 特征串 "${marker}"：组件库被静态 import 进启动闭包`);
  }
});
