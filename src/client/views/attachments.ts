/**
 * ============================================================
 * views/attachments.ts — 文件上下文：附件 chips / 文件选择器 / 本地上传
 * ============================================================
 * 职责：待发送附件的增删与展示、服务端目录浏览、本地上传（含图片 dataURL）、
 * 拖拽 / 粘贴附加。
 * 设计立场：
 *  - 单条消息最多 5 个附件（后端也校验），超限给中文提示而不是静默丢弃；
 *  - 图片走 dataURL（多模态模型可直接消费），文本走服务端上传接口换 uploadId；
 *  - 拖拽通道独立于 <input type=file>：自动化浏览器会屏蔽系统选择框，拖拽不受影响。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { uiAlert, uiPrompt } from "../modules/ui-dialog.js";
import { fmtSize } from "../modules/format.js";
import type { FsEntry, FsListResult, PendingFile } from "../modules/types.js";

export const MAX_PENDING_FILES = 5;
const MAX_IMAGE_BYTES = 4_500_000;
const MAX_TEXT_BYTES = 800_000;

let fsCwd: string | null = null;   // 当前浏览目录（null = 默认项目根）
let fsParent: string | null = null; // 上一级目录（根目录时为 null）

export function refKey(f: PendingFile): string {
  return f.kind === "upload" ? `up:${f.uploadId}` : `fs:${f.path}`;
}

export function renderAttachChips(): void {
  const wrap = $("attach-chips");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.pendingFiles.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const f of state.pendingFiles) {
    const preview = f.kind === "upload" ? f.preview : null;
    const chip = document.createElement("span");
    chip.className = "attach-chip" + (preview ? " has-thumb" : "");
    chip.innerHTML = `
      ${preview ? `<img class="thumb" alt="">` : "📎"}
      <span class="c-name"></span>
      <span class="c-src"></span>
      <button class="c-del" title="移除">✕</button>`;
    const nameEl = chip.querySelector(".c-name");
    if (nameEl) nameEl.textContent = f.name;
    const srcEl = chip.querySelector(".c-src");
    if (srcEl) srcEl.textContent = preview ? "图片" : (f.source || "项目文件");
    const thumb = chip.querySelector<HTMLImageElement>(".thumb");
    if (thumb && preview) thumb.src = preview;
    chip.querySelector(".c-del")?.addEventListener("click", () => {
      state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== refKey(f));
      renderAttachChips();
      renderFsSelection();
    });
    wrap.appendChild(chip);
  }
}

export function addPendingFile(f: PendingFile): boolean {
  if (state.pendingFiles.length >= MAX_PENDING_FILES) {
    uiAlert(`单条消息最多附加 ${MAX_PENDING_FILES} 个文件`, "附件数量超限");
    return false;
  }
  if (state.pendingFiles.some((x) => refKey(x) === refKey(f))) return true; // 已选
  state.pendingFiles.push(f);
  renderAttachChips();
  renderFsSelection();
  return true;
}

export function removePendingFile(key: string): void {
  state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== key);
  renderAttachChips();
  renderFsSelection();
}

/* ---------------------------------------------------------------------------
 * 文件选择器弹窗
 * ------------------------------------------------------------------------- */
export async function openFsModal(): Promise<void> {
  if (!state.currentId) { uiAlert("请先选择或新建会话", "提示"); return; }
  $("fs-mask")?.classList.remove("hidden");
  await browseFs(null); // 回到默认项目根
}

export function closeFsModal(): void {
  $("fs-mask")?.classList.add("hidden");
}

export async function browseFs(path: string | null): Promise<void> {
  const list = $("fs-list");
  if (!list) return;
  list.innerHTML = `<div class="fs-empty">加载中…</div>`;
  try {
    const data = await api<FsListResult>("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    fsCwd = data.path;
    fsParent = data.parent;
    const pathEl = $("fs-path");
    if (pathEl) pathEl.textContent = data.path;
    const upEl = $("fs-up") as HTMLButtonElement | null;
    if (upEl) upEl.disabled = !data.parent;
    const rootSel = $("fs-root") as HTMLSelectElement | null;
    if (rootSel) {
      rootSel.innerHTML = "";
      for (const r of data.roots) {
        const opt = document.createElement("option");
        opt.value = r.path;
        opt.textContent = `${r.type === "cloud" ? "☁️" : "💻"} ${r.name}`;
        rootSel.appendChild(opt);
      }
      // 位置下拉显示「最长匹配」的授权根（项目根是 work 的子目录，应优先显示项目根）
      const best = data.roots
        .filter((r) => data.path === r.path || data.path.startsWith(r.path.replace(/[\\/]+$/, "") + "/") || data.path.startsWith(r.path.replace(/[\\/]+$/, "") + "\\"))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (best) rootSel.value = best.path;
    }
    renderFsRows(data.entries);
  } catch (err) {
    list.innerHTML = `<div class="fs-empty">✗ ${(err as Error).message}</div>`;
  }
}

function isFileSelected(ref: PendingFile): boolean {
  return state.pendingFiles.some((x) => refKey(x) === refKey(ref));
}

export function renderFsSelection(): void {
  const el = $("fs-selected");
  if (!el) return;
  el.textContent = state.pendingFiles.length
    ? `已选 ${state.pendingFiles.length} 个：${state.pendingFiles.map((f) => f.name).join("、")}`
    : "未选择文件（点击文件名勾选，再点「完成」加到输入框）";
  // 同步列表勾选标记
  document.querySelectorAll<HTMLElement>(".fs-row[data-key]").forEach((row) => {
    const selected = state.pendingFiles.some((x) => refKey(x) === (row.dataset.key || ""));
    row.classList.toggle("selected", selected);
    const check = row.querySelector(".f-check");
    if (check) check.textContent = selected ? "✓" : "";
  });
}

function renderFsRows(entries: FsEntry[]): void {
  const list = $("fs-list");
  if (!list) return;
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="fs-empty">（空文件夹）</div>`;
    return;
  }
  for (const e of entries) {
    const row = document.createElement("button");
    const ref: PendingFile = { kind: "fs", path: (fsCwd ? fsCwd.replace(/[\\/]+$/, "") + "/" : "") + e.name, name: e.name };
    row.className = "fs-row" + (e.type === "dir" ? " dir" : "");
    if (e.type === "file") {
      row.dataset.key = refKey(ref);
      if (isFileSelected(ref)) row.classList.add("selected");
    }
    row.innerHTML = `<span class="f-icon">${e.type === "dir" ? "📁" : "📄"}</span><span class="f-name"></span><span class="f-check"></span><span class="f-size"></span>`;
    const nameEl = row.querySelector(".f-name");
    if (nameEl) nameEl.textContent = e.name;
    const sizeEl = row.querySelector(".f-size");
    if (sizeEl) sizeEl.textContent = e.type === "file" ? fmtSize(e.size) : "";
    row.addEventListener("click", () => {
      if (e.type === "dir") void browseFs(ref.path);
      else if (isFileSelected(ref)) removePendingFile(refKey(ref));
      else addPendingFile(ref);
    });
    list.appendChild(row);
  }
}

export async function openRemoteFolder(): Promise<void> {
  const p = await uiPrompt(
    "输入服务器上的文件夹绝对路径（例如 E:\\study 或 /home/user/project）：\n⚠ 这会把该目录暴露给网页端浏览，仅建议在本地/可信环境使用",
    { title: "打开远程文件夹", placeholder: "E:\\study 或 /home/user/project" }
  );
  if (typeof p !== "string" || !p.trim()) return;
  try {
    const res = await api<{ path: string }>("/api/fs/open-remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    await browseFs(res.path);
  } catch (err) {
    uiAlert("打开失败：" + (err as Error).message, "打开远程文件夹");
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

export async function uploadLocalFiles(fileList: FileList | File[]): Promise<void> {
  for (const file of Array.from(fileList)) {
    const isImage = file.type.startsWith("image/");
    if (isImage && file.size > MAX_IMAGE_BYTES) { uiAlert(`「${file.name}」图片过大（>4.5MB）`, "文件过大"); continue; }
    if (!isImage && file.size > MAX_TEXT_BYTES) { uiAlert(`「${file.name}」过大（>800KB），请压缩或拆分`, "文件过大"); continue; }
    try {
      let content: string;
      let image = false;
      let preview: string | null = null;
      if (isImage) {
        content = await readAsDataURL(file); // dataURL：多模态模型可直接消费
        image = true;
        preview = content;
      } else {
        content = await file.text();
      }
      const res = await api<{ id: string; name: string }>("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, content, image }),
      });
      addPendingFile({
        kind: "upload", uploadId: res.id, name: res.name,
        source: isImage ? "图片" : "本地上传", preview,
      });
    } catch (err) {
      uiAlert(`「${file.name}」上传失败：${(err as Error).message}`, "上传失败");
    }
  }
}

/* ---------------------------------------------------------------------------
 * 拖拽上传 —— 不依赖系统文件选择框。
 * 场景：以自动化参数启动的浏览器（如 --disable-blink-features=AutomationControlled）
 * 会静默屏蔽 <input type=file> 的系统选择框，但 drop 事件通道不受影响。
 * ------------------------------------------------------------------------- */
let dragDepth = 0;

export function setupDragDrop(): void {
  // 全页拖放浮层
  const overlay = document.createElement("div");
  overlay.id = "drop-overlay";
  overlay.className = "hidden";
  overlay.innerHTML = `<div class="drop-box">📎 松开鼠标，把文件附加到当前对话</div>`;
  document.body.appendChild(overlay);

  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types || []).includes("Files");
  const finish = (): void => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.add("hidden"); };

  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth += 1;
    overlay.classList.remove("hidden");
  });
  document.addEventListener("dragleave", () => { if (dragDepth) finish(); });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    e.preventDefault(); // 阻止浏览器直接打开文件
    dragDepth = 0;
    overlay.classList.add("hidden");
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    if (!state.currentId) { uiAlert("请先选择或新建会话，再附加文件", "提示"); return; }
    void uploadLocalFiles(files);
  });

  // 文件选择器弹窗内拖拽高亮
  const modal = $("fs-modal");
  if (modal) {
    modal.addEventListener("dragover", (e) => { e.preventDefault(); modal.classList.add("dragover"); });
    modal.addEventListener("dragleave", () => modal.classList.remove("dragover"));
    modal.addEventListener("drop", () => modal.classList.remove("dragover"));
  }
}

/** 供 main.ts 的「上一级」按钮调用 */
export function goParent(): void {
  if (fsParent) void browseFs(fsParent);
}
