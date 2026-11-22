/**
 * ============================================================
 * views/external.ts — 外部 Agent 分发桥（M4 批次 4.4 起）
 * ============================================================
 * 卡片渲染已迁往 Vue（external-cards-vue.vue + stores/external.ts）；
 * 本文件保留 legacy 侧职责：
 *  1. 启动装载 loadExternalAgents（挂载 + store.load，main.ts 调用）；
 *  2. 接入流程 addExternalFlow（#add-external-btn，clone + 自动识别）；
 *  3. 补全启动命令 completeExternalAgent（卡片与接入流程共用）；
 *  4. 会话创建注入 bindCreateSession（turn 层注入，避免 external → stream 的环）。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上）。
 */
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import { uiAlert, uiPrompt } from "../../ui/dialog.js";
import type { ExternalAgent, SessionKind } from "../../modules/types.js";

/** 新建会话（由 turn 层注入） */
let createSessionFn: (
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
) => Promise<void> = async () => {};

export function bindCreateSession(fn: typeof createSessionFn): void {
  createSessionFn = fn;
}

/** Vue 卡片组件调用会话创建（经注入的 turn 层函数）。 */
export function getCreateSessionFn(): typeof createSessionFn {
  return createSessionFn;
}

/** 启动装载：挂载卡片组件并拉取目录（镜像 core state）。 */
export async function loadExternalAgents(): Promise<void> {
  void import("./external-cards-vue.js")
    .then((m) => m.mountExternalCardsVue())
    .catch(() => {});
  try {
    const { useExternalStore } = await import("../../stores/external/external.js");
    await useExternalStore().load();
  } catch {
    state.externalAgents = []; // 旧服务进程没有该接口 → 静默降级
  }
}

/** 接入流程：Git 地址 → clone + 自动发现 → 必要时补启动命令。 */
export async function addExternalFlow(): Promise<void> {
  const url = await uiPrompt(
    "输入第三方 Agent 的 Git 仓库地址：\n服务端会 clone 到本地并自动识别启动方式（agent.json > package.json > 常见入口）",
    { title: "接入外部 Agent", placeholder: "https://github.com/user/agent-repo" },
  );
  if (typeof url !== "string" || !url.trim()) return;
  try {
    const { useExternalStore } = await import("../../stores/external/external.js");
    const store = useExternalStore();
    const { agent, hint } = await store.add(url.trim());
    if (agent.command) {
      await uiAlert(
        `已接入「${agent.name}」
启动命令：${agent.command} ${agent.args.join(" ")}${hint ? `

${hint}` : ""}`,
        "接入成功",
      );
    } else {
      await uiAlert(`仓库已 clone，但没有识别出启动方式。
${hint || ""}`, "需要补全启动命令");
      await completeExternalAgent(agent);
    }
  } catch (err) {
    uiAlert(`接入失败：${(err as Error).message}`, "外部 Agent");
  }
}

/** 为「待补全」的外部 Agent 询问并保存启动命令（如 node cli.js）。 */
export async function completeExternalAgent(agent: ExternalAgent): Promise<void> {
  const cmdLine = await uiPrompt(
    `为「${agent.name}」输入启动命令（在仓库目录内执行）：
用户消息会替换 args 里的 {{prompt}} 占位符；没有占位符时通过 stdin 传入`,
    { title: "补全启动命令", placeholder: "例如 node cli.js --prompt {{prompt}}" },
  );
  if (typeof cmdLine !== "string" || !cmdLine.trim()) return;
  const parts = cmdLine.trim().split(/\s+/);
  try {
    const { useExternalStore } = await import("../../stores/external/external.js");
    await useExternalStore().saveCommand(agent.id, parts[0] ?? "", parts.slice(1));
    await createSessionFn("external", null, null, agent.id);
  } catch (err) {
    uiAlert(`保存失败：${(err as Error).message}`, "外部 Agent");
  }
}
