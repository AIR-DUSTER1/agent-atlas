/**
 * ============================================================
 * views/model-menu.ts — 顶栏 ▾ 菜单：所有供应商的所有模型 + 思考档位
 * ============================================================
 * 职责：顶栏模型下拉的渲染（供应商分组 × 组内全部模型）与开启关闭。
 * 设计立场：
 *  - 同一个网关往往提供多个模型，菜单必须把「供应商 × 模型」全部平铺，
 *    否则换模型只能靠新建供应商 —— 这是本菜单存在的核心理由；
 *  - 只给「当前正在用的那个」打勾，避免多个 ✓ 让人误解；
 *  - 菜单顶部顺带给出当前模型的思考等级档位（省一次进设置页）。
 */

import { $ } from "../core/dom.js";
import { PROTOCOL_LABEL } from "./composer-bar.js";
import { activateModel, setReasoningLevel } from "./model-actions.js";
import type { AppConfig } from "../modules/types.js";

export function showProviderMenu(show: boolean): void {
  $("provider-menu")?.classList.toggle("hidden", !show);
}

export function renderProviderMenu(cfg: AppConfig | null): void {
  const menu = $("provider-menu");
  if (!menu) return;
  menu.innerHTML = "";
  const all = cfg?.providers || [];
  const activeProvider = all.find((p) => p.active);
  const activeModel = (activeProvider?.models || []).find((m) => m.active);

  // ① 当前模型的思考等级：档位 chips（档位随供应商方言变化）
  const r = cfg?.reasoning;
  if (r && activeModel) {
    const box = document.createElement("div");
    box.className = "pm-reason-box";

    const head = document.createElement("div");
    head.className = "pm-reason-head";
    const title = document.createElement("span");
    title.textContent = `⚡ ${activeModel.displayName} · 思考等级`;
    const now = document.createElement("em");
    now.className = "pm-reason-now";
    now.textContent = r.label || "";
    now.title = r.scheme || "";
    head.append(title, now);
    box.appendChild(head);

    const chips = document.createElement("div");
    chips.className = "pm-chips";
    for (const lv of r.levels || []) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pm-chip" + (lv.id === r.level ? " active" : "");
      chip.textContent = lv.label;
      chip.title = lv.desc;
      chip.addEventListener("click", (e) => { e.stopPropagation(); void setReasoningLevel(lv.id); });
      chips.appendChild(chip);
    }
    box.appendChild(chips);

    const scheme = document.createElement("div");
    scheme.className = "pm-scheme";
    scheme.textContent = (r.auto ? `自动识别为「${r.dialectLabel}」（${r.vendor}）· ` : "") + (r.scheme || "");
    box.appendChild(scheme);
    if (r.error) {
      const err = document.createElement("div");
      err.className = "pm-scheme err";
      err.textContent = `⚠ ${r.error}`;
      box.appendChild(err);
    }
    menu.appendChild(box);
  }

  // ② 供应商分组 → 组内每个模型一行
  for (const p of all) {
    const group = document.createElement("div");
    group.className = "pm-group";

    const head = document.createElement("div");
    head.className = "pm-group-head";
    const gname = document.createElement("span");
    gname.className = "pm-g-name";
    gname.textContent = p.name;
    gname.title = p.baseURL;
    head.appendChild(gname);
    if (p.protocol && p.protocol !== "openai") {
      const proto = document.createElement("span");
      proto.className = "pm-g-badge";
      proto.textContent = PROTOCOL_LABEL[p.protocol] || p.protocol;
      head.appendChild(proto);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "pm-g-edit";
    edit.textContent = "编辑";
    edit.title = "在设置里编辑这个供应商与它的模型";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      showProviderMenu(false);
      void import("./settings.js").then((m) => m.openSettings("models", p.id));
    });
    head.appendChild(edit);
    group.appendChild(head);

    if (!p.models || !p.models.length) {
      const empty = document.createElement("div");
      empty.className = "pm-empty";
      empty.textContent = "还没有模型 —— 点「编辑」添加";
      group.appendChild(empty);
    }

    for (const m of p.models || []) {
      const current = Boolean(p.active) && Boolean(m.active);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pm-item" + (current ? " active" : "");
      row.title = `${m.name} · ${p.baseURL}\n思考等级：${m.reasoningLabel}（${m.reasoningDialect || ""}）`;
      row.innerHTML = `<span class="pm-check">${current ? "✓" : ""}</span>`
        + `<span class="pm-name"></span>`
        + `<span class="pm-model"></span>`;
      const nameEl = row.querySelector(".pm-name");
      if (nameEl) nameEl.textContent = `${m.modality === "vision" ? "🖼 " : ""}${m.displayName}`;
      const tag = m.reasoningLevel && m.reasoningLevel !== "default" ? m.reasoningLabel : "";
      const right = row.querySelector(".pm-model");
      if (right) {
        right.textContent = tag || (m.displayName === m.name ? "" : m.name);
        if (tag) right.classList.add("hot");
      }
      row.addEventListener("click", async () => {
        showProviderMenu(false);
        if (!current) await activateModel(p.id, m.id);
      });
      group.appendChild(row);
    }
    menu.appendChild(group);
  }

  const divider = document.createElement("div");
  divider.className = "pm-divider";
  menu.appendChild(divider);
  const manage = document.createElement("button");
  manage.className = "pm-item pm-manage";
  manage.textContent = "⚙ 管理供应商与模型（添加 / 编辑 / 删除）";
  manage.addEventListener("click", () => {
    showProviderMenu(false);
    void import("./settings.js").then((m) => m.openSettings());
  });
  menu.appendChild(manage);
}
