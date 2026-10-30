/**
 * ============================================================
 * views/shell.ts — 新建对话弹窗 / 欢迎页卡片与示例 chips
 * ============================================================
 * 卡片只通过 h() 生成，Agent 文案来自 AGENT_PROFILES 单一来源；点击立即创建
 * 对应会话，创建失败用阻塞式对话框说明原因。
 */
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { h } from "../ui/h.js";
import { AGENT_PROFILES } from "../modules/agent-profile.js";
import { refreshWelcomePluginCopy } from "./navigation.js";
import type { SessionKind } from "../modules/types.js";

let createSessionFn: (
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
) => Promise<void> = async () => {};

export function bindCreateSession(fn: typeof createSessionFn): void { createSessionFn = fn; }

export const GENERAL_EXAMPLES = [
  "帮我算一下 (128+512)*3，再看看现在几点了",
  "查一下北京的天气，适合穿什么",
  "给 boss@example.com 发一封邮件，主题是周报",
  "附加一个文件，帮我总结它的要点（用附件按钮选择）",
];

function agentCard(options: {
  icon: string;
  name: string;
  description: string;
  example: string;
  badge?: string;
  onClick: () => Promise<void>;
}): HTMLButtonElement {
  return h("button", {
    type: "button",
    class: "demo-card",
    onclick: async () => {
      try {
        await options.onClick();
      } catch (err) {
        uiAlert("创建对话失败：" + (err as Error).message, "创建对话");
      }
    },
  },
  h("div", { class: "d-head" },
    h("span", { class: "d-num" }, options.icon),
    h("span", { class: "d-name" }, options.name, options.badge ? h("span", { class: "d-default" }, options.badge) : null),
  ),
  h("div", { class: "d-desc" }, options.description),
  h("div", { class: "d-eg" }, "示例：" + options.example),
  );
}

export function buildDemoCards(container: HTMLElement | null): void {
  if (!container) return;
  container.replaceChildren();
  const general = AGENT_PROFILES.general;
  container.appendChild(agentCard({
    icon: general.icon,
    name: general.label,
    badge: "默认",
    description: general.description,
    example: general.example,
    onClick: () => createSessionFn("agent", null, null),
  }));

  // 找房 Agent 是贝壳插件的入口；插件停用时隐藏，避免创建空能力会话。
  const estate = AGENT_PROFILES.estate;
  if (state.plugins?.enabled.estate !== false) {
    container.appendChild(agentCard({
      icon: estate.icon,
      name: estate.label,
      description: estate.description,
      example: estate.example,
      onClick: () => createSessionFn("estate"),
    }));
  }

  for (const demo of state.config?.demos || []) {
    container.appendChild(agentCard({
      icon: String(demo.id),
      name: demo.name,
      description: demo.desc,
      example: demo.example,
      onClick: () => createSessionFn("demo", demo.id, demo.example),
    }));
  }
}

/** 插件启停后重建欢迎页与新会话弹窗中的 Agent 卡片。 */
export function refreshAgentCards(): void {
  buildDemoCards($("demo-cards"));
  buildDemoCards($("modal-cards"));
  refreshWelcomePluginCopy();
}

export function buildExampleChips(): void {
  const wrap = $("example-chips");
  if (!wrap) return;
  wrap.replaceChildren();
  for (const text of GENERAL_EXAMPLES) {
    wrap.appendChild(h("button", {
      type: "button",
      class: "ex-chip",
      onclick: async () => {
        try {
          await createSessionFn("agent", null, text);
        } catch (err) {
          uiAlert("创建对话失败：" + (err as Error).message, "创建对话");
        }
      },
    }, text));
  }
}

export function openModal(): void { $("modal-mask")?.classList.remove("hidden"); }
export function closeModal(): void { $("modal-mask")?.classList.add("hidden"); }
