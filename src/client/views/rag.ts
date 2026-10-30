/**
 * ============================================================
 * views/rag.ts — 知识库（外部 RAG）：配置 / 入库 / 检索测试 / 命中渲染
 * ============================================================
 * 职责：RAG 面板的读写、入库位置下拉、文档登记列表、检索测试、命中片段卡片。
 * 设计立场：
 *  - 契约见 server/rag.ts：本地只存「送出去过什么」的登记，索引在外部服务；
 *  - 入库只允许授权路径（服务端 files.ts 校验），前端不做二次拼路径；
 *  - 命中片段渲染被聊天工具卡复用（compact 模式限制高度）。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { uiAlert, uiConfirm, uiPrompt } from "../ui/dialog.js";
import { escapeHtml } from "../modules/format.js";
import { renderPluginCards } from "./settings.js";
import type { FsListResult, RagHit, RagState, ToolPart } from "../modules/types.js";

export function setKbStatus(text: string, kind: string): void {
  const el = $("kb-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

export async function loadRag(): Promise<void> {
  try {
    state.rag = await api<RagState>("/api/rag");
  } catch {
    state.rag = null; // 旧服务进程没有该接口 → 静默降级
  }
  renderPluginCards();
}

export async function openKb(): Promise<void> {
  $("kb-mask")?.classList.remove("hidden");
  await loadRag();
  renderKb();
}

export function closeKb(): void {
  $("kb-mask")?.classList.add("hidden");
}

function renderKb(): void {
  const rag = state.rag || ({} as RagState);
  setInput("kb-url", rag.baseURL || "");
  setInput("kb-collection", rag.collection || "default");
  setInput("kb-topk", String(rag.topK ?? 5));
  setInput("kb-key", "");
  const keyState = $("kb-key-state");
  if (keyState) {
    keyState.textContent = rag.hasKey
      ? `已保存 ${rag.apiKeyMasked || ""}，留空则不修改`
      : (rag.configured ? "未保存 Key（服务无鉴权可不填）" : "");
    keyState.className = "key-state" + (rag.hasKey ? " ok" : "");
  }
  setKbStatus(rag.configured ? "" : "尚未配置外部 RAG 服务", rag.configured ? "" : "err");
  void renderKbRoots();
  renderKbDocs();
  const hits = $("kb-hits");
  if (hits) hits.innerHTML = "";
}

function setInput(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = value;
}

/** 入库位置下拉：与文件选择器同一批授权根（项目根 + 已添加文件夹，带 💻/☁️ 标记） */
async function renderKbRoots(): Promise<void> {
  const sel = $("kb-root") as HTMLSelectElement | null;
  if (!sel) return;
  let roots = [{ path: "", name: "项目根（当前 agentatlas 仓库）", type: "local" }];
  try {
    const data = await api<FsListResult>("/api/fs/list", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    roots = (data.roots || []).map((r) => ({ ...r, type: r.type || "local" }));
  } catch { /* 用默认项目根 */ }
  sel.innerHTML = "";
  for (const r of roots) {
    const opt = document.createElement("option");
    opt.value = r.path;
    opt.textContent = `${r.type === "cloud" ? "☁️" : "💻"} ${r.name}`;
    sel.appendChild(opt);
  }
}

export function renderKbDocs(): void {
  const wrap = $("kb-docs");
  if (!wrap) return;
  wrap.innerHTML = "";
  const docs = state.rag?.docs || [];
  if (!docs.length) {
    wrap.innerHTML = `<div class="fs-empty">还没有入库记录 —— 选择位置点「⬇ 全量入库」，或「✎ 粘贴文本」</div>`;
    return;
  }
  for (const d of docs) {
    const row = document.createElement("div");
    row.className = "fs-row kb-doc";
    row.innerHTML = `<span class="f-icon">📄</span><span class="f-name"></span><span class="f-size"></span><button class="pm-x kb-doc-del" title="从登记移除（并尝试删除外部对应文档）">✕</button>`;
    const nameEl = row.querySelector(".f-name");
    if (nameEl) nameEl.textContent = d.name;
    const sizeEl = row.querySelector(".f-size");
    if (sizeEl) {
      sizeEl.textContent = `${(d.bytes / 1000).toFixed(1)}k 字 · ${new Date(d.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${d.source || ""}`;
    }
    row.title = d.source || d.name;
    row.querySelector(".kb-doc-del")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const res = await api<{ rag: RagState }>(`/api/rag/docs/${d.id}`, { method: "DELETE" });
        state.rag = res.rag;
        renderKbDocs();
      } catch (err) { uiAlert(`移除失败：${(err as Error).message}`, "知识库文档"); }
    });
    wrap.appendChild(row);
  }
}

export async function saveKbConfig(): Promise<void> {
  const baseURL = (($("kb-url") as HTMLInputElement | null)?.value || "").trim();
  const apiKeyRaw = (($("kb-key") as HTMLInputElement | null)?.value || "").trim();
  if (!baseURL) { setKbStatus("✗ 服务地址不能为空", "err"); return; }
  const body: Record<string, unknown> = {
    baseURL,
    collection: (($("kb-collection") as HTMLInputElement | null)?.value || "").trim() || "default",
    topK: ($("kb-topk") as HTMLInputElement | null)?.value || undefined,
  };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已存 Key
  try {
    const res = await api<{ rag: RagState }>("/api/rag/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    state.rag = res.rag;
    renderPluginCards();
    renderKbDocs();
    setKbStatus(`✓ 配置已保存（集合 ${state.rag.collection}）`, "ok");
  } catch (err) { setKbStatus(`✗ ${(err as Error).message}`, "err"); }
}

export async function testKb(): Promise<void> {
  const baseURL = (($("kb-url") as HTMLInputElement | null)?.value || "").trim();
  const apiKeyRaw = (($("kb-key") as HTMLInputElement | null)?.value || "").trim();
  if (!baseURL) { setKbStatus("✗ 请先填写服务地址", "err"); return; }
  const body: Record<string, unknown> = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  setKbStatus("正在连接 RAG 服务…", "");
  try {
    const res = await api<{ ok: boolean; status?: number; error?: string }>("/api/rag/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    setKbStatus(
      res.ok ? `✓ 服务可达（HTTP ${res.status}）—— 真实检索效果以入库后测试为准` : `✗ ${res.error}`,
      res.ok ? "ok" : "err"
    );
  } catch (err) { setKbStatus(`✗ ${(err as Error).message}`, "err"); }
}

export async function ingestKbFolder(): Promise<void> {
  if (!state.rag?.configured) { setKbStatus("✗ 请先保存外部 RAG 服务配置", "err"); return; }
  const path = ($("kb-root") as HTMLSelectElement | null)?.value || "";
  const btn = $("kb-ingest") as HTMLButtonElement | null;
  const prev = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 扫描入库中…（最长 90s）"; }
  try {
    const res = await api<{ rag: RagState; summary?: { ingested?: number; chunks?: number } }>(
      "/api/rag/ingest",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }
    );
    state.rag = res.rag;
    renderKbDocs();
    const s = res.summary || {};
    setKbStatus(`✓ 已入库 ${s.ingested ?? "?"} 个文本文件${s.chunks != null ? `，外部服务返回 ${s.chunks} 个切块` : ""}`, "ok");
  } catch (err) {
    setKbStatus(`✗ ${(err as Error).message}`, "err");
    uiAlert(`入库失败：${(err as Error).message}\n\n检查：① RAG 服务是否实现 /ingest；② 选择的文件夹是否包含文本文件`, "知识库入库");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev ?? "⬇ 全量入库"; }
  }
}

export async function pasteKbText(): Promise<void> {
  const text = await uiPrompt("粘贴要入库的文本（切块与 embedding 由外部 RAG 服务完成）：", {
    title: "知识库 · 文本入库",
    placeholder: "任意说明文档 / 会议纪要 / 规范片段…",
  });
  if (typeof text !== "string" || !text.trim()) return;
  try {
    const res = await api<{ rag: RagState }>("/api/rag/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `手动文本 ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
        content: text,
      }),
    });
    state.rag = res.rag;
    renderKbDocs();
    setKbStatus("✓ 文本已入库", "ok");
  } catch (err) { setKbStatus(`✗ ${(err as Error).message}`, "err"); }
}

export async function searchKbTest(): Promise<void> {
  const q = (($("kb-query") as HTMLInputElement | null)?.value || "").trim();
  const wrap = $("kb-hits");
  if (!wrap) return;
  if (!q) { setKbStatus("✗ 请输入检索词", "err"); return; }
  wrap.innerHTML = `<div class="fs-empty">检索中…</div>`;
  try {
    const res = await api<{ hits?: RagHit[] }>("/api/rag/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
    });
    const hits = Array.isArray(res.hits) ? res.hits : [];
    setKbStatus(`✓ 命中 ${hits.length} 条`, "ok");
    wrap.innerHTML = "";
    if (!hits.length) wrap.innerHTML = `<div class="fs-empty">没有命中 —— 确认相关文档已入库</div>`;
    for (const h of hits) wrap.appendChild(renderRagHit(h, false));
  } catch (err) {
    wrap.innerHTML = "";
    setKbStatus(`✗ ${(err as Error).message}`, "err");
  }
}

export async function clearKb(): Promise<void> {
  if (!(await uiConfirm("清空集合会调用外部 RAG 服务的 /reset，并清空本地登记。\n确定继续？", { title: "清空知识库集合", okText: "清空", danger: true }))) return;
  try {
    const res = await api<{ rag: RagState }>("/api/rag/clear", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    state.rag = res.rag;
    renderKbDocs();
    const hits = $("kb-hits");
    if (hits) hits.innerHTML = "";
    setKbStatus("✓ 集合已清空", "ok");
  } catch (err) { setKbStatus(`✗ ${(err as Error).message}`, "err"); }
}

/** RAG 命中片段（面板检索 + 聊天工具卡片共用） */
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
