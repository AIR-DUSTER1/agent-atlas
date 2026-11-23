/**
 * ============================================================
 * tests/helpers/client-source.ts — 读取前端源码全文（供结构断言用）
 * ============================================================
 * 为什么需要：一批单测用「正则匹配源码」守护 UI 结构约定（例如思考卡必须
 * 默认折叠、审批卡必须有 collapsed 状态）。前端从单个 app.js 拆成
 * src/client/ 下多模块后，这些测试需要一次性拿到全部源码。
 *
/*
 * 立场：
 *  - 只读 .ts 源码，不读构建产物（产物是 tsconfig 输出，断言产物等于断言编译器）；
 *  - 列出的文件就是「前端全部实现」，新增模块要加进 CLIENT_SOURCES，
 *    否则结构断言会漏掉它（有意为之：清单可见、可审）；
 *  - **路径按「目录前缀 + basename」解析**：`views/*` 已按页面重组进
 *    `views/<page>/`，若让 30+ 个调用点都写死新路径，每次搬页面都要改一片测试。
 *    解析规则见 resolveClientPath()：先直连，未命中则在同名顶层目录下按
 *    basename 查找；0 命中或 >1 命中都报错（歧义必须显式消歧，不允许静默选一个）。
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientIndexHtml } from "./client-html.js";

const CLIENT_ROOT = fileURLToPath(new URL("../../src/client/", import.meta.url));

/** 目录索引缓存：只在首次解析未命中时构建一次。 */
let indexCache: Map<string, string[]> | undefined;

/** 递归列出 client 下全部 .ts/.vue，建「basename → 相对路径数组」索引。 */
async function basenameIndex(): Promise<Map<string, string[]>> {
  if (indexCache) return indexCache;
  const index = new Map<string, string[]>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (/\.(ts|vue)$/.test(entry.name)) {
        const base = basename(entry.name);
        index.set(base, [...(index.get(base) ?? []), rel]);
      }
    }
  };
  await walk(CLIENT_ROOT, "");
  indexCache = index;
  return index;
}

/**
 * 把测试里写的名字解析成实际相对路径。
 *  - `views/settings-tracing-vue.vue` → `views/settings/tracing/settings-tracing-vue.vue`
 *  - `stores/messages.ts`（未移动）→ 原样命中
 * 规则：先直连；未命中时取名字的**第一段目录**（views/stores/ui/...）作约束，
 * 在该目录下按 basename 匹配。这样 `views/messages.ts` 不会误取 `stores/messages.ts`。
 */
export async function resolveClientPath(name: string): Promise<string> {
  const direct = await readFile(join(CLIENT_ROOT, name), "utf8").then(() => true).catch(() => false);
  if (direct) return name;
  const slash = name.indexOf("/");
  const scope = slash > 0 ? name.slice(0, slash) : "";
  const base = basename(name);
  const candidates = (await basenameIndex()).get(base) ?? [];
  const scoped = scope ? candidates.filter((path) => path.startsWith(`${scope}/`)) : candidates;
  if (scoped.length === 1) return scoped[0] as string;
  if (scoped.length === 0) {
    throw new Error(`找不到前端文件：${name}（basename=${base}，作用域=${scope || "全目录"}）`);
  }
  throw new Error(`前端文件名有歧义，请写更具体的路径：${name} → ${scoped.join(" | ")}`);
}

/** 前端源码清单（相对 src/client/；路径可写移动前的旧名，由 resolveClientPath 解析） */
export const CLIENT_SOURCES = [
  // 入口与核心
  "main.ts",
  "core/state.ts",
  "core/dom.ts",
  "core/api.ts",
  // 无业务 UI 原语
  "ui/safe-url.ts",
  "ui/dom.ts",
  "ui/icon.ts",
  "ui/button.ts",
  "ui/input.ts",
  "ui/field.ts",
  "ui/config-control.ts",
  "ui/card.ts",
  "ui/empty.ts",
  "ui/dialog.ts",
  "ui/media-preview.ts",
  "ui/menu.ts",
  "ui/toast.ts",
  "ui/scroll-to-bottom.ts",
  // 协议与纯函数模块
  "modules/format.ts",
  "modules/tool-presentation.ts",
  "modules/chat-flow.ts",
  "modules/clarify.ts",
  "modules/clipboard.ts",
  "modules/message-copy.ts",
  "modules/agent-profile.ts",
  "modules/project-view.ts",
  "modules/session-tree.ts",
  "modules/plugin-registry.ts",
  "modules/types.ts",
  "modules/types-api.ts",
  "modules/types-ui.ts",
  // 渲染层
  "render/parts.ts",
  "render/clarify-card.ts",
  "render/messages.ts",
  "render/code-enhance.ts",
  "render/tool-enhancers.ts",
  // 流与动作
  "stream/events.ts",
  "stream/turn.ts",
  "observability/client-errors.ts",
  "actions/approvals.ts",
  "actions/compact.ts",
  // 视图层
  "views/navigation.ts",
  "views/sessions.ts",
  "views/projects.ts",
  "views/shell.ts",
  "views/external.ts",
  "views/composer-bar.ts",
  "views/attachments.ts",
  "views/rag.ts",
  "views/estate.ts",
  "views/settings.ts",
  "views/settings-plugins.ts",
  "views/settings-backup.ts",
  "views/settings-memories.ts",
  "views/model-store.ts",
  "views/model-panel.ts",
  "views/model-form.ts",
  "views/model-actions.ts",
  // 输入框菜单
  "composer/menu.ts",
  // 图标白名单（Vite 直接打包 npm 依赖）
  "ui/icons.ts",
];

/** 读取全部前端源码并拼成一段文本（保留文件边界注释，便于定位断言来源） */
export async function readClientSource(): Promise<string> {
  const parts = await Promise.all(
    CLIENT_SOURCES.map(async (name) => {
      const resolved = await resolveClientPath(name);
      const text = await readFile(join(CLIENT_ROOT, resolved), "utf8");
      return `\n/* ==== src/client/${resolved} ==== */\n${text}`;
    })
  );
  return parts.join("\n");
}

/** 只读某几个前端文件（断言范围更精确时用）；名字可写旧路径，自动解析到新位置。 */
export async function readClientFiles(names: string[]): Promise<string> {
  const parts = await Promise.all(
    names.map(async (name) => {
      const resolved = await resolveClientPath(name);
      const text = await readFile(join(CLIENT_ROOT, resolved), "utf8");
      return `\n/* ==== src/client/${resolved} ==== */\n${text}`;
    })
  );
  return parts.join("\n");
}
/** 读取 src/client/styles/*.css，按 index 中的加载顺序拼接（供结构断言）。 */
export async function readClientCss(): Promise<string> {
  const html = await readClientIndexHtml();
  const names = [...html.matchAll(/href=["']\/styles\/([^"'?#]+\.css)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1] ?? "");
  const parts = await Promise.all(names.map(async (name) =>
    `\n/* ==== src/client/styles/${name} ==== */\n${await readFile(join(CLIENT_ROOT, "styles", name), "utf8")}`
  ));
  return parts.join("\n");
}
