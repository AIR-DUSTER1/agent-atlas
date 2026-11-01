/**
 * ============================================================
 * views/job.ts — 求职岗位数据源管理（job-hunter 技能）
 * ============================================================
 * 职责：显示环境状态（技能目录 / Python / 依赖 / 最近清单），配置路径，
 * 触发平台登录与自检。
 *
 * 设计立场：
 *  - 登录是**交互步骤**：点按钮后会一直挂着等扫码（最长 5 分钟），
 *    所以按钮进入 disabled + 明确提示，避免用户重复点击拉起多个浏览器；
 *  - 状态优先展示「哪里没就绪 + 怎么修」，而不是只给一个红点；
 *  - 所有文本走 textContent / h()，不拼用户可控 HTML。
 */
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import type { JobState } from "../modules/types.js";

const PLATFORM_BUTTONS: Array<{ id: string; label: string }> = [
  { id: "boss", label: "BOSS直聘" },
  { id: "zhilian", label: "智联招聘" },
  { id: "job51", label: "前程无忧" },
  { id: "liepin", label: "猎聘" },
];

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("job-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
  clearTimeout(statusTimer);
  if (message && kind === "ok") {
    statusTimer = setTimeout(() => {
      if (el.textContent === message) setStatus("");
    }, 8000);
  }
}

function line(label: string, value: string, ok?: boolean): HTMLElement {
  return h("div", { class: "job-check-row" },
    h("span", { class: "job-check-label" }, label),
    h("span", { class: `job-check-value${ok === true ? " ok" : ok === false ? " err" : ""}` }, value),
  );
}

function renderStatus(status: JobState): void {
  const list = $("job-check-list");
  if (list) {
    list.replaceChildren(
      line("技能目录", status.installed ? status.skillDir : "未找到（请在下方填写 job-hunter 技能根目录）", status.installed),
      line(
        "Python",
        status.pythonOK ? `可用 ${status.pythonVersion}` : "不可用：需要 3.10+ 并在 PATH 中",
        status.pythonOK,
      ),
      line("依赖（DrissionPage / openpyxl）", status.depsOK ? "已安装" : (status.depsError || "未就绪"), status.depsOK),
      line("数据目录", status.dataDir || "—", undefined),
      line("登录态", status.profilePresent ? "已存在（至少登录过一个平台）" : "未登录", undefined),
      line(
        "最近清单",
        status.lastRunJobs ? `${status.lastRunJobs} 条${status.lastRunAt ? ` · ${status.lastRunAt}` : ""}` : "还没有采集记录",
        undefined,
      ),
    );
  }

  const skillInput = $("job-skill-dir") as HTMLInputElement | null;
  if (skillInput && !skillInput.value) skillInput.value = status.skillDir;
  const pythonInput = $("job-python-bin") as HTMLInputElement | null;
  if (pythonInput && !pythonInput.value) pythonInput.value = status.pythonVersion ? "" : "";
  const dataInput = $("job-data-dir") as HTMLInputElement | null;
  if (dataInput && !dataInput.value) dataInput.value = status.dataDir;

  // 依赖不齐时把「怎么修」写成显式提示，别让用户猜
  const hint = $("job-fix-hint");
  if (hint) {
    hint.replaceChildren();
    if (!status.installed) {
      hint.appendChild(h("span", null,
        "未找到技能：请在下方填写 job-hunter 技能的根目录（该目录下应有 scripts/main.py）。"));
    } else if (!status.pythonOK) {
      hint.appendChild(h("span", null,
        "需要 Python 3.10+：技能里用了 `X | None` 联合类型，3.9 运行时会报 TypeError。"));
    } else if (!status.depsOK) {
      hint.appendChild(h("span", null,
        status.depsError || "依赖未装齐，请在技能根目录执行 pip install -r requirements.txt"));
    }
  }
  hint?.classList.toggle("hidden", status.installed && status.pythonOK && status.depsOK);
}

async function load(): Promise<void> {
  const status = await api<JobState>("/api/job");
  state.job = status;
  renderStatus(status);
}

async function save(): Promise<void> {
  const button = $("job-save-btn") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  setStatus("正在保存并重新探测…");
  try {
    const status = await api<JobState>("/api/job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillDir: ($("job-skill-dir") as HTMLInputElement | null)?.value ?? "",
        pythonBin: ($("job-python-bin") as HTMLInputElement | null)?.value ?? "",
        dataDir: ($("job-data-dir") as HTMLInputElement | null)?.value ?? "",
      }),
    });
    state.job = status;
    renderStatus(status);
    setStatus("✓ 已保存，下一条消息生效", "ok");
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

async function login(platform: string, label: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${label} 等待扫码…`;
  setStatus(`正在打开 ${label} 登录页：请在浏览器里扫码，最长等待 5 分钟…`);
  try {
    const result = await api<{ ok: boolean; summary: string; output?: string }>("/api/job/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform }),
    });
    setStatus(result.summary, result.ok ? "ok" : "err");
    await load();
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function doctor(): Promise<void> {
  const button = $("job-doctor-btn") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  setStatus("正在自检…");
  try {
    const result = await api<{ ok: boolean; text: string }>("/api/job/doctor", { method: "POST" });
    const box = $("job-doctor-output");
    if (box) box.textContent = result.text || "（自检没有输出）";
    setStatus(result.ok ? "✓ 自检通过" : "自检发现问题，详见下方输出", result.ok ? "ok" : "err");
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

export function renderJobManage(): void {
  const platforms = $("job-platforms");
  if (!platforms) return;
  platforms.replaceChildren();
  for (const item of PLATFORM_BUTTONS) {
    const button = h("button", {
      type: "button",
      class: "ui-button job-login-btn",
      "aria-label": `登录 ${item.label}`,
    }, icon("ExternalLink", { size: 13 }), `登录 ${item.label}`) as HTMLButtonElement;
    button.addEventListener("click", () => { void login(item.id, item.label, button); });
    platforms.appendChild(button);
  }
}

/** 打开求职数据源管理弹窗。 */
export async function openJob(): Promise<void> {
  $("job-mask")?.classList.remove("hidden");
  document.body.classList.add("job-open");
  renderJobManage();
  setStatus("正在探测环境…");
  try {
    await load();
    setStatus("");
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, "err");
  }
  requestAnimationFrame(() => ($("job-skill-dir") as HTMLInputElement | null)?.focus());
}

export function closeJob(): void {
  $("job-mask")?.classList.add("hidden");
  document.body.classList.remove("job-open");
}

export function isJobOpen(): boolean {
  const mask = $("job-mask");
  return Boolean(mask) && !mask?.classList.contains("hidden");
}

/** 只绑定一次。 */
export function bindJob(): void {
  $("job-close")?.addEventListener("click", () => closeJob());
  $("job-save-btn")?.addEventListener("click", () => { void save(); });
  $("job-doctor-btn")?.addEventListener("click", () => { void doctor(); });
  const mask = $("job-mask");
  mask?.addEventListener("click", (event) => {
    if (event.target === mask) closeJob();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isJobOpen()) {
      event.preventDefault();
      closeJob();
    }
  });
}
