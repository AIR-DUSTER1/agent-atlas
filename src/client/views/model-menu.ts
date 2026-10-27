/**
 * views/model-menu.ts — 顶栏模型菜单
 * ============================================================
 * 供应商 × 模型使用统一的浮动菜单原语：点外关闭、Esc、方向键与焦点恢复
 * 都由 ui/menu.ts 负责；本文件只组装业务内容，不再维护第二套定位逻辑。
 */
import { $ } from "../core/dom.js";
import { h } from "../ui/h.js";
import { openFloatingMenu, type MenuController } from "../ui/menu.js";
import { PROTOCOL_LABEL } from "./composer-bar.js";
import { activateModel, setReasoningLevel } from "./model-actions.js";
import type { AppConfig } from "../modules/types.js";

let controller: MenuController | null = null;

export function showProviderMenu(show: boolean): void {
  const menu = $("provider-menu");
  const anchor = $("provider-btn");
  if (!menu || !anchor) return;
  if (!show) {
    menu.classList.add("hidden");
    controller?.close(false);
    controller = null;
    anchor.setAttribute("aria-expanded", "false");
    return;
  }
  menu.classList.remove("hidden");
  anchor.setAttribute("aria-expanded", "true");
  controller = openFloatingMenu({
    anchor,
    menu,
    align: "start",
    onClose: () => {
      controller = null;
      menu.classList.add("hidden");
      anchor.setAttribute("aria-expanded", "false");
    },
  });
}

export function renderProviderMenu(cfg: AppConfig | null): void {
  const menu = $("provider-menu");
  if (!menu) return;
  menu.replaceChildren();
  menu.setAttribute("role", "menu");
  const providers = cfg?.providers ?? [];
  const activeProvider = providers.find((provider) => provider.active);
  const activeModel = activeProvider?.models.find((model) => model.active);
  const reasoning = cfg?.reasoning;

  if (reasoning && activeModel) {
    const chips = h("div", { class: "pm-chips" });
    for (const level of reasoning.levels ?? []) {
      chips.appendChild(h("button", {
        type: "button",
        class: "pm-chip" + (level.id === reasoning.level ? " active" : ""),
        title: level.desc,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          void setReasoningLevel(level.id);
        },
      }, level.label));
    }
    menu.appendChild(h("div", { class: "pm-reason-box" },
      h("div", { class: "pm-reason-head" },
        h("span", null, `⚡ ${activeModel.displayName} · 思考等级`),
        h("em", { class: "pm-reason-now", title: reasoning.scheme ?? "" }, reasoning.label || ""),
      ),
      chips,
      h("div", { class: "pm-scheme" },
        (reasoning.auto ? `自动识别为「${reasoning.dialectLabel}」（${reasoning.vendor}）· ` : "") + (reasoning.scheme || ""),
      ),
      reasoning.error ? h("div", { class: "pm-scheme err" }, `⚠ ${reasoning.error}`) : null,
    ));
  }

  for (const provider of providers) {
    const head = h("div", { class: "pm-group-head" },
      h("span", { class: "pm-g-name", title: provider.baseURL }, provider.name),
      provider.protocol && provider.protocol !== "openai"
        ? h("span", { class: "pm-g-badge" }, PROTOCOL_LABEL[provider.protocol] || provider.protocol)
        : null,
      h("button", {
        type: "button",
        class: "pm-g-edit",
        title: "在设置里编辑这个供应商与它的模型",
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          showProviderMenu(false);
          void import("./settings.js").then((mod) => mod.openSettings("models", provider.id));
        },
      }, "编辑"),
    );
    const group = h("div", { class: "pm-group" }, head);
    if (!provider.models?.length) {
      group.appendChild(h("div", { class: "pm-empty" }, "还没有模型 —— 点「编辑」添加"));
    }
    for (const model of provider.models ?? []) {
      const current = Boolean(provider.active) && Boolean(model.active);
      const tag = model.reasoningLevel && model.reasoningLevel !== "default" ? model.reasoningLabel : "";
      group.appendChild(h("button", {
        type: "button",
        role: "menuitem",
        class: "pm-item" + (current ? " active" : ""),
        title: `${model.name} · ${provider.baseURL}\n思考等级：${model.reasoningLabel}（${model.reasoningDialect || ""}）`,
        onclick: async () => {
          showProviderMenu(false);
          if (!current) await activateModel(provider.id, model.id);
        },
      },
      h("span", { class: "pm-check" }, current ? "✓" : ""),
      h("span", { class: "pm-name" }, `${model.modality === "vision" ? "🖼 " : ""}${model.displayName}`),
      h("span", { class: "pm-model" + (tag ? " hot" : "") }, tag || (model.displayName === model.name ? "" : model.name)),
      ));
    }
    menu.appendChild(group);
  }

  menu.appendChild(h("div", { class: "pm-divider" }));
  menu.appendChild(h("button", {
    type: "button",
    role: "menuitem",
    class: "pm-item pm-manage",
    onclick: () => {
      showProviderMenu(false);
      void import("./settings.js").then((mod) => mod.openSettings());
    },
  }, "⚙ 管理供应商与模型（添加 / 编辑 / 删除）"));
}
