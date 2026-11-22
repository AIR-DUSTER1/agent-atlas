/**
 * ============================================================
 * views/estate.ts — 房产面板分发桥与工具卡渲染（M4 批次 4.4 起）
 * ============================================================
 * 贝壳面板（检测 / 安装 / Key）已迁往 Vue（estate-panel-vue.vue +
 * stores/estate.ts）；本文件保留 legacy 侧职责：
 *  1. 状态条写入（#estate-status，Vue 组件与壳共用）；
 *  2. 弹窗开合入口 openEstate / closeEstate（插件面板与全局 Esc 链调用）；
 *  3. 启动装载 loadEstate（main.ts 调用，镜像 core state）；
 *  4. house_* 工具结果富卡片渲染（renderEstateInToolCard，4.6 随对话核心迁移）。
 * store 经动态 import 进入（本模块在 1:1 过渡树链上）。
 */
import { $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import { safeHref, safeImageSrc } from "../../modules/format.js";
import type { EstateState, ToolPart } from "../../modules/types.js";
import { uiAlert } from "../../ui/dialog.js";
import { refreshPluginCards } from "../settings/plugins/settings-plugins.js";

export { uiAlert };

interface EstateListing {
  title?: string; community?: string; name?: string; id?: string;
  cover?: string; coverImage?: string; image?: string;
  price?: string | { unit?: string };
  area?: string; areaSize?: string;
  addressText?: string; address?: string; region?: string;
  links?: Record<string, string>;
  url?: string; detailUrl?: string;
}
interface EstatePoint {
  name?: string;
  label?: string;
  address?: string;
  lat?: number;
  lng?: number;
  source?: string;
  links?: Record<string, string>;
}
interface EstateLocation {
  label?: string;
  address?: string;
  lat?: number;
  lng?: number;
  source?: string;
  precision?: "building" | "community";
  embedUrl?: string;
  links?: Record<string, string>;
}
interface EstatePayload {
  error?: string;
  setup?: string;
  keyUrl?: string;
  authRequired?: boolean;
  loginUrl?: string;
  loginOpened?: boolean;
  platform?: string;
  action?: string;
  city?: string;
  mode?: string;
  houseId?: string;
  listings?: EstateListing[];
  points?: EstatePoint[];
  location?: EstateLocation;
  embedUrl?: string;
  note?: string;
  images?: string[];
  vr?: string;
  detailUrl?: string;
  url?: string;
  qrcode?: string;
  image?: string;
  recommendationLimit?: number;
  excel?: { fileName?: string; downloadUrl?: string; count?: number };
  excelError?: string;
}

export function setEstateStatus(msg: string, cls = ""): void {
  const el = $("estate-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "estate-status" + (cls ? " " + cls : "");
}

/** 启动装载：镜像 core state（插件 readiness / 欢迎语读取）。 */
export async function loadEstate(): Promise<void> {
  try {
    state.estate = await api<EstateState>("/api/estate");
  } catch {
    state.estate = null; // 旧服务进程没有该接口 → 静默降级
  }
  void import("../settings/plugins/settings-plugins.js").then((m) => m.refreshPluginCards()).catch(() => {});
}

/** 打开贝壳弹窗：挂载组件（幂等）并置开合态。 */
export async function openEstate(): Promise<void> {
  void import("./estate-panel-vue.js")
    .then((m) => m.mountEstatePanelVue())
    .catch(() => {});
  const { useEstateStore } = await import("../../stores/estate/estate.js");
  const store = useEstateStore();
  await store.load();
  store.estateOpen = true;
}

export function closeEstate(): void {
  void import("../../stores/estate/estate.js")
    .then(({ useEstateStore }) => { useEstateStore().estateOpen = false; })
    .catch(() => {});
}

/** 供 main.ts 的「检测」按钮复用面板刷新（面板数据经 store 响应式更新）。 */
export async function renderEstatePanelForUi(): Promise<void> {
  const { useEstateStore } = await import("../../stores/estate/estate.js");
  await useEstateStore().load();
}

/* ---------------------------------------------------------------------------
 * 房产 JSON 结果 → 卡片渲染（4.6 随对话核心迁移）
 * ------------------------------------------------------------------------- */
function estateExtra(card: HTMLElement): HTMLElement {
  card.querySelector(".estate-extra")?.remove();
  const extra = document.createElement("div");
  extra.className = "estate-extra";
  card.querySelector(".tool-body")?.appendChild(extra);
  return extra;
}

function linkButton(label: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "estate-link";
  a.textContent = label;
  const safe = safeHref(href);
  if (safe) {
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.setAttribute("aria-disabled", "true");
  }
  return a;
}

export function renderEstateInToolCard(part: ToolPart, card: HTMLElement): void {
  let data: EstatePayload | null;
  try { data = JSON.parse(part.result?.content || "") as EstatePayload; } catch { return; }
  if (!data || typeof data !== "object") return;

  // 登录失效 → 系统浏览器手动登录；不自动点击或代填，降低风控误判。
  if (data.authRequired) {
    // 失败态要明确表达“需要登录”，并把登录 CTA 直接展开，避免用户只看到红色停止。
    card.classList.remove("err", "running", "awaiting");
    card.classList.add("needs-action", "open", "estate-auth-required");
    const status = card.querySelector<HTMLElement>(".tool-status");
    if (status) {
      status.className = "tool-status awaiting";
      status.textContent = "🔐 需要登录";
    }
    const extra = estateExtra(card);
    const box = document.createElement("div");
    box.className = "estate-setup";
    const copy = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = "🔐 需要登录贝壳账号";
    const message = document.createElement("div");
    message.className = "err-line";
    message.textContent = data.error || "点击下方按钮打开官方登录页，扫码后把页面显示的 Key 粘贴到设置中";
    copy.append(title, message);

    const actions = document.createElement("div");
    actions.className = "kb-actions";
    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.className = "btn btn-approve";
    reopen.textContent = "打开官方登录页";
    reopen.addEventListener("click", async () => {
      // 与设置面板共用登录页打开契约（系统默认浏览器打开一次）
      const requestEstateLogin = async (): Promise<{ ok: boolean; url: string; opened: boolean; message?: string; error?: string }> =>
        api("/api/estate/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      reopen.disabled = true;
      reopen.textContent = "正在打开…";
      try {
        const result = await requestEstateLogin();
        reopen.textContent = result.ok ? "✓ 登录页已打开，请扫码后点「复制」，再回设置页读取剪贴板" : `✗ ${result.message || result.error || "打开失败"}`;
      } catch (err) {
        reopen.textContent = `打开失败：${(err as Error).message}`;
      } finally {
        reopen.disabled = false;
      }
    });
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "btn btn-approve";
    settingsButton.textContent = "打开找房数据源设置";
    settingsButton.addEventListener("click", () => { void openEstate(); });
    actions.append(reopen, settingsButton);
    box.append(copy, actions);
    extra.appendChild(box);
    return;
  }

  // CLI 未安装 / 未授权 一类引导性错误 → 渲染一键安装卡
  if (data.error && data.setup === "beike-install") {
    const extra = estateExtra(card);
    const box = document.createElement("div");
    box.className = "estate-setup";
    box.innerHTML = `<div><b>🏠 贝壳 CLI 未就绪</b><div class="err-line"></div><a class="key-link" target="_blank" rel="noopener"></a></div>`;
    const errLine = box.querySelector(".err-line");
    if (errLine) errLine.textContent = data.error;
    const keyA = box.querySelector<HTMLAnchorElement>(".key-link");
    if (keyA) {
      keyA.textContent = "获取贝壳 Key（building.ke.com）";
      keyA.href = data.keyUrl || "https://building.ke.com/?action=get-key";
    }
    const fix = document.createElement("button");
    fix.className = "btn btn-approve";
    fix.textContent = "⬇ 一键安装贝壳 CLI";
    if (!/^win/i.test(data.platform || "win")) fix.disabled = true;
    fix.addEventListener("click", async () => {
      fix.disabled = true;
      fix.textContent = "安装中…（约 1-2 分钟）";
      try {
        const res = await api<EstateState>("/api/estate/install", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        state.estate = { ...(state.estate || { installed: false }), ...res };
        refreshPluginCards();
        fix.textContent = `✓ 安装完成${res.version ? " " + res.version : ""}，请重新发送刚才的问题`;
      } catch (err) {
        fix.textContent = "安装失败：" + (err as Error).message;
      }
    });
    box.appendChild(fix);
    extra.appendChild(box);
    return;
  }

  if (data.action === "export" && data.excel?.downloadUrl) {
    const extra = estateExtra(card);
    const hint = document.createElement("div");
    hint.className = "estate-conclusion-hint";
    hint.textContent = `完整候选已写入 Excel（${data.excel.count || 0} 套），下载入口也已放进本轮结论。`;
    const link = linkButton(`下载 ${data.excel.fileName || "房源对比清单.xlsx"}`, data.excel.downloadUrl);
    if (data.excel.fileName) link.download = data.excel.fileName;
    extra.append(hint, link);
    return;
  }

  // 房产交付物统一放到最终结论附件区；工具卡只保留可折叠的执行轨迹。
  if (data.action === "detail" || data.action === "map" || data.action === "material") {
    const hasMedia = data.action === "material"
      ? (Array.isArray(data.images) && data.images.length > 0) || Boolean(data.vr)
      : data.action === "map"
        ? Array.isArray(data.points) && data.points.length > 0
        : Boolean(data.location) || Boolean(data.vr);
    if (hasMedia) {
      const extra = estateExtra(card);
      const hint = document.createElement("div");
      hint.className = "estate-conclusion-hint";
      if (data.action === "material") {
        const delivered = [
          Array.isArray(data.images) && data.images.length > 0 ? "户型图" : "",
          data.vr ? "VR" : "",
        ].filter(Boolean);
        hint.textContent = `${delivered.join("与")}已放入本轮结论下方。`;
      } else if (data.action === "map") {
        hint.textContent = "房源位置与地图已放入本轮结论下方。";
      } else {
        const delivered = [
          data.location ? "房源位置" : "",
          data.location ? "地图" : "",
          data.vr ? "VR" : "",
        ].filter(Boolean);
        hint.textContent = `${delivered.join("、").replace("、VR", "与 VR")}已放入本轮结论下方。`;
      }
      extra.appendChild(hint);
    }
    return;
  }

  const listings = Array.isArray(data.listings) ? data.listings : [];
  if (data.action === "search" || listings.length) {
    const extra = estateExtra(card);
    if (listings.length) {
      const title = document.createElement("div");
      title.className = "estate-extra-title";
      title.textContent = `🏙 ${data.city || ""} ${data.mode === "rent" ? "租房" : "买房"}结果 · ${listings.length} 套`;
      extra.appendChild(title);
      const recommendationLimit = Math.max(1, Math.min(12, Math.floor(data.recommendationLimit || 12)));
      for (const h of listings.slice(0, recommendationLimit)) {
        const row = document.createElement("div");
        row.className = "estate-house";
        row.innerHTML = `
          <div class="estate-house-main">
            <div class="estate-house-title"></div>
            <div class="estate-house-meta"><span class="estate-house-price"></span><span class="m-area"></span><span class="m-addr"></span></div>
            <div class="estate-house-links"></div>
          </div>`;
        const titleEl = row.querySelector(".estate-house-title");
        if (titleEl) titleEl.textContent = h.title || h.community || h.name || h.id || "（无标题）";
        const priceEl = row.querySelector(".estate-house-price");
        if (priceEl) priceEl.textContent = typeof h.price === "object" ? (h.price.unit || "") : (h.price || "");
        const areaEl = row.querySelector(".m-area");
        if (areaEl) areaEl.textContent = h.area || h.areaSize || "";
        const addrEl = row.querySelector(".m-addr");
        if (addrEl) addrEl.textContent = h.addressText || h.address || h.region || "";
        const links = row.querySelector(".estate-house-links");
        let linkAdded = false;
        const linkMap: Record<string, string | undefined> = h.links || { detail: h.url || h.detailUrl };
        for (const [label, value] of Object.entries(linkMap)) {
          const href = safeHref(value);
          if (!href || !links) continue;
          links.appendChild(linkButton(label === "detail" ? "贝壳页面" : label, href));
          linkAdded = true;
        }
        if (!linkAdded) links?.remove();
        extra.appendChild(row);
      }
      if (listings.length > recommendationLimit) {
        const overflow = document.createElement("div");
        overflow.className = "estate-missed";
        overflow.textContent = data.excel?.downloadUrl
          ? `另有 ${listings.length - recommendationLimit} 套已写入 Excel，完整对比请看下载入口。`
          : `另有 ${listings.length - recommendationLimit} 套未在结论表展开，可继续筛选或导出 Excel。`;
        extra.appendChild(overflow);
      }
      if (data.excel?.downloadUrl) {
        const excelLink = linkButton(`下载 Excel 对比清单（${data.excel.count || listings.length} 套）`, data.excel.downloadUrl);
        if (data.excel.fileName) excelLink.download = data.excel.fileName;
        extra.appendChild(excelLink);
      }
      if (data.excelError) {
        const error = document.createElement("div");
        error.className = "estate-missed";
        error.textContent = data.excelError;
        extra.appendChild(error);
      }
    } else if (data.error) {
      const miss = document.createElement("div");
      miss.className = "estate-missed";
      miss.textContent = "🔍 " + data.error;
      extra.appendChild(miss);
    }
    return;
  }

  if (data.action === "qrcode") {
    const extra = estateExtra(card);
    const src = safeImageSrc(data.qrcode || data.image);
    if (src) {
      const img = document.createElement("img");
      img.src = src; img.alt = "经纪人微信二维码";
      img.style.cssText = "width:180px;border-radius:8px;border:1px solid var(--line)";
      extra.appendChild(img);
    }
    if (data.note) {
      const note = document.createElement("div");
      note.className = "estate-material-link";
      note.textContent = data.note;
      extra.appendChild(note);
    }
    if (!extra.childElementCount) extra.remove();
  }
}

/** 供 main.ts 的「检测」按钮复用面板刷新 */
