/**
 * ============================================================
 * views/estate.ts — 房产 Agent（贝壳）：数据源面板 + 工具卡专属渲染
 * ============================================================
 * 职责：贝壳 CLI 的检测 / 安装 / Key 保存，以及 house_* 工具结果的富卡片
 * （房源列表 / 区位地图 / 户型图 / 经纪人二维码 / 安装引导）。
 * 设计立场：
 *  - 所有外链与图片都过 safeHref / safeImageSrc 白名单（工具结果来自外部服务，不可信）；
 *  - 地图 iframe 只允许 openstreetmap.org 的 https 地址；
 *  - 安装动作只对 Windows 开放（CLI 是 win32-x64 二进制），其它平台按钮禁用。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { safeHref, safeImageSrc } from "../modules/format.js";
import { renderPluginCards } from "./settings.js";
import type { EstateState, ToolPart } from "../modules/types.js";

export function setEstateStatus(msg: string, cls = ""): void {
  const el = $("estate-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "estate-status" + (cls ? " " + cls : "");
}

export async function loadEstate(): Promise<void> {
  try {
    state.estate = await api<EstateState>("/api/estate");
  } catch {
    state.estate = null; // 旧服务进程没有该接口 → 静默降级
  }
  renderPluginCards();
}

export async function openEstate(): Promise<void> {
  $("estate-mask")?.classList.remove("hidden");
  await loadEstate();
  renderEstatePanel();
}

export function closeEstate(): void {
  $("estate-mask")?.classList.add("hidden");
}

function renderEstatePanel(): void {
  const st = state.estate || { installed: false };
  if (st.installed) {
    setEstateStatus(`✓ 已安装贝壳 CLI${st.version ? " " + st.version : ""}${st.viaPATH ? "（来自系统 PATH）" : st.path ? "：" + st.path : ""}`, "ok");
  } else {
    setEstateStatus(st.error ? `✗ ${st.error}` : "未检测到贝壳 CLI：点下方按钮自动安装（仅支持 Windows，约 32MB）", "err");
  }
  const keyEl = $("estate-key") as HTMLInputElement | null;
  if (keyEl) keyEl.value = "";
  const s2 = $("estate-status2");
  if (s2) {
    s2.textContent = st.installed ? "CLI 就绪后即可保存 Key 开始找房" : "请先安装 CLI";
    s2.style.color = st.installed ? "" : "var(--amber)";
  }
}

export async function installBeikeCli(): Promise<void> {
  const btn = $("estate-install") as HTMLButtonElement | null;
  const s2 = $("estate-status2");
  if (btn) btn.disabled = true;
  if (s2) {
    s2.textContent = "正在下载安装（约 30MB，视网络可能需要 1-2 分钟）…";
    s2.style.color = "var(--amber)";
  }
  try {
    const res = await api<EstateState>("/api/estate/install", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    state.estate = { ...(state.estate || { installed: false }), ...res };
    renderPluginCards();
    renderEstatePanel();
  } catch (err) {
    setEstateStatus(`✗ 安装失败：${(err as Error).message}`, "err");
    if (s2) s2.textContent = "安装失败，可按官方文档手动安装后重试";
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function saveEstateKey(): Promise<void> {
  const value = (($("estate-key") as HTMLInputElement | null)?.value || "").trim();
  const s2 = $("estate-status2");
  if (!s2) return;
  if (!value) { s2.textContent = "✗ 请先粘贴贝壳 Key（building.ke.com 登录后显示）"; s2.style.color = "var(--red)"; return; }
  if (!state.estate?.installed) {
    s2.textContent = "✗ 请先安装 CLI 再保存 Key"; s2.style.color = "var(--red)"; return;
  }
  s2.textContent = "校验中…";
  try {
    const res = await api<{ ok: boolean; error?: string }>("/api/estate/key", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: value }),
    });
    s2.textContent = res.ok ? "✓ 校验通过，贝壳找房已可用（回到找房对话直接提需求）" : `✗ 校验未通过：${res.error || "未知错误"}`;
    s2.style.color = res.ok ? "" : "var(--red)";
    if (res.ok) {
      const keyEl = $("estate-key") as HTMLInputElement | null;
      if (keyEl) keyEl.value = "";
    }
  } catch (err) {
    s2.textContent = `✗ ${(err as Error).message}`;
    s2.style.color = "var(--red)";
  }
}

/* ---------------------------------------------------------------------------
 * 房产 JSON 结果 → 卡片渲染
 * ------------------------------------------------------------------------- */
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
  address?: string;
  links?: Record<string, string>;
}

interface EstatePayload {
  error?: string;
  setup?: string;
  keyUrl?: string;
  platform?: string;
  action?: string;
  city?: string;
  mode?: string;
  listings?: EstateListing[];
  points?: EstatePoint[];
  embedUrl?: string;
  note?: string;
  images?: string[];
  vr?: string;
  detailUrl?: string;
  url?: string;
  qrcode?: string;
  image?: string;
}

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
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

export function renderEstateInToolCard(part: ToolPart, card: HTMLElement): void {
  let data: EstatePayload | null;
  try { data = JSON.parse(part.result?.content || "") as EstatePayload; } catch { return; }
  if (!data || typeof data !== "object") return;

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
      keyA.href = data.keyUrl || "https://building.ke.com/?action=get-key&source=beike_skill";
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
        renderPluginCards();
        fix.textContent = `✓ 安装完成${res.version ? " " + res.version : ""}，请重新发送刚才的问题`;
      } catch (err) {
        fix.textContent = "安装失败：" + (err as Error).message;
      }
    });
    box.appendChild(fix);
    extra.appendChild(box);
    return;
  }

  // 房源搜索 → 列表卡
  const listings = Array.isArray(data.listings) ? data.listings : [];
  if (data.action === "search" || listings.length) {
    const extra = estateExtra(card);
    if (listings.length) {
      const title = document.createElement("div");
      title.className = "estate-extra-title";
      title.textContent = `🏙 ${data.city || ""} ${data.mode === "rent" ? "租房" : "买房"}结果 · ${listings.length} 套`;
      extra.appendChild(title);
      for (const h of listings.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "estate-house";
        row.innerHTML = `
          <img class="estate-house-thumb" alt="">
          <div class="estate-house-main">
            <div class="estate-house-title"></div>
            <div class="estate-house-meta"><span class="estate-house-price"></span><span class="m-area"></span><span class="m-addr"></span></div>
            <div class="estate-house-links"></div>
          </div>`;
        const img = row.querySelector<HTMLImageElement>(".estate-house-thumb");
        const src = safeImageSrc(h.cover || h.coverImage || h.image);
        if (img) {
          if (src) img.src = src;
          else img.remove();
        }
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
    } else if (data.error) {
      const miss = document.createElement("div");
      miss.className = "estate-missed";
      miss.textContent = "🔍 " + data.error;
      extra.appendChild(miss);
    }
    return;
  }

  // 区位对比 → 内嵌 OSM 地图 + 各平台跳转链接
  if (data.action === "map") {
    const extra = estateExtra(card);
    const points = Array.isArray(data.points) ? data.points : [];
    const embed = String(data.embedUrl || "");
    if (points.length && /^https:\/\/www\.openstreetmap\.org\//i.test(embed)) {
      const mapBox = document.createElement("div");
      mapBox.className = "estate-map-embed";
      const iframe = document.createElement("iframe");
      iframe.src = embed;
      iframe.loading = "lazy";
      iframe.title = "候选房源分布地图";
      mapBox.appendChild(iframe);
      extra.appendChild(mapBox);
    }
    for (const p of points) {
      const row = document.createElement("div");
      row.className = "estate-point";
      row.innerHTML = `<div class="estate-point-main"><div class="estate-point-name"></div><div class="estate-point-addr"></div></div><div class="estate-point-links"></div>`;
      const nameEl = row.querySelector(".estate-point-name");
      if (nameEl) nameEl.textContent = p.name || "未知点位";
      const addrEl = row.querySelector(".estate-point-addr");
      if (addrEl) addrEl.textContent = p.address || "";
      const links = row.querySelector(".estate-point-links");
      for (const [label, value] of Object.entries(p.links || {})) {
        const href = safeHref(value);
        if (!href || !links) continue;
        links.appendChild(linkButton(label, href));
      }
      extra.appendChild(row);
    }
    if (data.note) {
      const note = document.createElement("div");
      note.className = "estate-missed";
      note.textContent = data.note;
      extra.appendChild(note);
    }
    return;
  }

  // 户型图 → 图片网格
  if (data.action === "material") {
    const images = Array.isArray(data.images) ? data.images : [];
    const extra = estateExtra(card);
    if (images.length) {
      const grid = document.createElement("div");
      grid.className = "estate-material-grid";
      for (const src of images) {
        const s = safeImageSrc(src);
        if (!s) continue;
        const img = document.createElement("img");
        img.src = s; img.alt = "户型图"; img.loading = "lazy";
        grid.appendChild(img);
      }
      extra.appendChild(grid);
    }
    const href = safeHref(data.vr || data.detailUrl || data.url);
    if (href) {
      const a = document.createElement("a");
      a.className = "estate-material-link";
      a.textContent = "▶ 打开贝壳 VR / 详情页";
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      extra.appendChild(a);
    }
    if (!extra.childElementCount) extra.remove();
    return;
  }

  // 经纪人加微 → 二维码
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

export { uiAlert };

/** 供 main.ts 的「检测」按钮复用面板刷新 */
export function renderEstatePanelForUi(): void {
  renderEstatePanel();
}
