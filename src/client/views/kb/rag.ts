/**
 * ============================================================
 * views/rag.ts — 知识库面板分发桥与工具卡渲染（M4 批次 4.4 起）
 * ============================================================
 * 配置 / 入库 / 检索测试的表单已迁往 Vue（kb-panel-vue.vue + stores/rag.ts）；
 * 本文件保留 legacy 侧职责：
 *  1. 状态条写入（#kb-status，Vue 组件与壳共用）；
 *  2. 弹窗开合入口 openKb / closeKb（插件面板「配置 RAG」与全局 Esc 链调用）；
 *  3. 启动装载 loadRag（main.ts 调用，镜像 core state）；
 *  4. renderRagHit / renderRagHitsInToolCard —— 聊天工具卡渲染（4.6 对话
 *     核心批次迁移，当前仍走 DOM 组装）。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上：settings-plugins →
 * 本模块 → store 会把 pinia 带进静态图）。
 */
import { $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import { escapeHtml } from "../../modules/format.js";
import type { RagHit, RagState, ToolPart } from "../../modules/types.js";

export function setKbStatus(text: string, kind: string): void {
  const el = $("kb-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

/** 启动装载：镜像 core state（插件 readiness / 欢迎语读取）。 */
export async function loadRag(): Promise<void> {
  try {
    state.rag = await api<RagState>("/api/rag");
  } catch {
    state.rag = null; // 旧服务进程没有该接口 → 静默降级
  }
  void import("../settings/plugins/settings-plugins.js").then((m) => m.refreshPluginCards()).catch(() => {});
}

/** 打开知识库弹窗：挂载组件（幂等）并置开合态。 */
export async function openKb(): Promise<void> {
  void import("./kb-panel-vue.js")
    .then((m) => m.mountKbPanelVue())
    .catch(() => {});
  const { useRagStore } = await import("../../stores/rag.js");
  const store = useRagStore();
  await store.load();
  store.kbOpen = true;
}

export function closeKb(): void {
  void import("../../stores/rag.js")
    .then(({ useRagStore }) => { useRagStore().kbOpen = false; })
    .catch(() => {});
}

/** RAG 命中片段（聊天工具卡片用，compact 模式限制高度）——4.6 随对话核心迁移。 */
export function renderRagHit(hit: RagHit, compact: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "rag-hit";
  const score = typeof hit.score === "number" ? hit.score.toFixed(3) : String(hit.score ?? "–");
  el.innerHTML = `
    <div class="rag-hit-head">
      <span class="rag-hit-name"></span>
      <span class="rag-hit-src"></span>
      <span class="rag-hit-score">score ${escapeHtml(score)}</span>
    </div>
    <div class="rag-hit-text"></div>`;
  const nameEl = el.querySelector(".rag-hit-name");
  if (nameEl) nameEl.textContent = hit.name || "未命名片段";
  const srcEl = el.querySelector(".rag-hit-src");
  if (srcEl) srcEl.textContent = hit.source || "";
  const textEl = el.querySelector<HTMLElement>(".rag-hit-text");
  if (textEl) {
    textEl.textContent = hit.text || "（无文本内容）";
    if (compact) textEl.style.maxHeight = "84px";
  }
  return el;
}

/** retrieve_docs 专属结果渲染：从 JSON 结果里解析出「命中来源」卡片列表 */
export function renderRagHitsInToolCard(part: ToolPart, card: HTMLElement): void {
  let wrap = card.querySelector(".rag-hits-wrap");
  if (!part.result || typeof part.result.content !== "string") return;
  let data: { hits?: RagHit[]; error?: string } | null;
  try { data = JSON.parse(part.result.content) as { hits?: RagHit[]; error?: string }; } catch { return; }
  if (!data || typeof data !== "object") return;
  wrap?.remove();
  const hits = Array.isArray(data.hits) ? data.hits : [];
  if (!hits.length && !data.error) return;
  wrap = document.createElement("div");
  wrap.className = "rag-hits-wrap";
  const title = document.createElement("div");
  title.className = "rag-hits-title";
  title.textContent = data.error
    ? "📚 检索失败：" + data.error
    : `📚 命中 ${hits.length} 条外部知识库片段（按相关度排序）`;
  wrap.appendChild(title);
  for (const h of hits.slice(0, 6)) wrap.appendChild(renderRagHit(h, true));
  card.querySelector(".tool-body")?.appendChild(wrap);
}
