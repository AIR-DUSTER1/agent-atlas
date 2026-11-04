/**
 * views/job.ts — 求职 Agent 的内置数据源与登录管理
 * ============================================================
 * 面板只管理浏览器、数据目录和平台登录；采集流程由求职 Agent 内部执行。
 */
import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import type { JobDiagnosisResponse, JobState } from "../modules/types.js";

const PLATFORM_BUTTONS = [
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
  $("job-check-list")?.replaceChildren(
    line("浏览器", status.browserOK ? `可用 · ${status.browserName}` : (status.browserError || "未找到 Chrome / Edge"), status.browserOK),
    line("内置执行流程", "BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘（无需 Python / Skill）", true),
    line("数据目录", status.dataDir || "—"),
    line("浏览器 Profile", status.profilePresent ? "已初始化（是否登录以采集结果为准）" : "首次登录时初始化"),
    line("最近清单", status.lastRunJobs ? `${status.lastRunJobs} 条${status.lastRunAt ? ` · ${status.lastRunAt}` : ""}` : "还没有采集记录"),
  );
  const dataInput = $("job-data-dir") as HTMLInputElement | null;
  if (dataInput && !dataInput.value) dataInput.value = status.dataDir;
  const hint = $("job-fix-hint");
  if (hint) {
    hint.replaceChildren();
    if (!status.browserOK) hint.appendChild(h("span", null, status.browserError || "请安装 Chrome / Edge，或设置 BROWSER_USE_EXECUTABLE_PATH。"));
    else if (status.lastRunJobs === 0) hint.appendChild(h("span", null, "首次使用请先登录 BOSS直聘；未登录时列表页通常会被安全校验拦截。"));
  }
  hint?.classList.toggle("hidden", status.browserOK && status.lastRunJobs > 0);
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
      body: JSON.stringify({ dataDir: ($("job-data-dir") as HTMLInputElement | null)?.value ?? "" }),
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

async function diagnose(apply: boolean, button: HTMLButtonElement): Promise<void> {
  const diagnoseButton = $("job-diagnose-btn") as HTMLButtonElement | null;
  const applyButton = $("job-diagnose-apply-btn") as HTMLButtonElement | null;
  if (diagnoseButton) diagnoseButton.disabled = true;
  if (applyButton) applyButton.disabled = true;
  button.textContent = apply ? "正在诊断并修复…" : "正在诊断…";
  setStatus(
    apply
      ? "正在逐平台诊断；只会固化本次在真实页面验证通过的候选，可能需要几分钟…"
      : "正在逐平台检查页面结构与字段命中率，可能需要几分钟…",
  );
  try {
    const result = await api<JobDiagnosisResponse>("/api/job/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply }),
    });
    const box = $("job-doctor-output");
    if (box) box.textContent = result.output || result.summary || "（诊断没有输出）";
    setStatus(result.ok ? `✓ ${result.summary}` : `诊断发现异常：${result.summary}`, result.ok ? "ok" : "err");
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    if (diagnoseButton) diagnoseButton.disabled = false;
    if (applyButton) applyButton.disabled = false;
    button.textContent = apply ? "诊断并修复" : "结构诊断";
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
  requestAnimationFrame(() => ($("job-data-dir") as HTMLInputElement | null)?.focus());
}

export function closeJob(): void {
  $("job-mask")?.classList.add("hidden");
  document.body.classList.remove("job-open");
}

export function isJobOpen(): boolean {
  const mask = $("job-mask");
  return Boolean(mask) && !mask?.classList.contains("hidden");
}

export function bindJob(): void {
  $("job-close")?.addEventListener("click", () => closeJob());
  $("job-save-btn")?.addEventListener("click", () => { void save(); });
  $("job-doctor-btn")?.addEventListener("click", () => { void doctor(); });
  const diagnoseButton = $("job-diagnose-btn") as HTMLButtonElement | null;
  const applyButton = $("job-diagnose-apply-btn") as HTMLButtonElement | null;
  diagnoseButton?.addEventListener("click", () => { void diagnose(false, diagnoseButton); });
  applyButton?.addEventListener("click", () => { void diagnose(true, applyButton); });
  const mask = $("job-mask");
  mask?.addEventListener("click", (event) => { if (event.target === mask) closeJob(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isJobOpen()) {
      event.preventDefault();
      closeJob();
    }
  });
}
