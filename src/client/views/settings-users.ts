/**
 * ============================================================
 * views/settings-users.ts — 设置页用户管理分区（用户体系改造 U2）
 * ============================================================
 * 职责：admin 管理用户（创建 / 禁用 / 重置密码 / 软删除 / 访问令牌）
 * 与所有用户的自助改密入口。
 *
 * 设计立场：
 *  - 文件模式（单用户）整块隐藏，不渲染无意义的 404 交互；
 *  - 临时密码 / 新令牌只在本页展示一次，不做持久化；
 *  - 所有用户可控文本走 textContent，不拼 HTML。
 */
import { api, postJson } from "../core/api.js";
import { $ } from "../core/dom.js";
import { uiConfirm, uiAlert } from "../ui/dialog.js";
import { button } from "../ui/button.js";
import { h } from "../ui/h.js";

interface ManagedUser {
  userId: string;
  username: string | null;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UserTokenRow {
  id: string;
  label: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("users-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
}

function passStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("users-pass-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
}

function selectedUser(): ManagedUser | null {
  const list = $("users-list");
  const id = list?.dataset.selectedId ?? "";
  if (!id) return null;
  return stateUsers.find((user) => user.userId === id) ?? null;
}

let stateUsers: ManagedUser[] = [];

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

function renderUserRow(user: ManagedUser): HTMLElement {
  const badges: string[] = [user.role === "admin" ? "管理员" : "成员"];
  if (user.status === "disabled") badges.push("已禁用");
  if (user.mustChangePassword) badges.push("待改密");
  if (!user.hasPassword) badges.push("仅令牌");
  const row = h("div", { class: "users-row", role: "row" });
  row.dataset.userId = user.userId;
  row.appendChild(h("div", { class: "users-row-main" },
    h("strong", {}, `${user.displayName}${user.username ? `（${user.username}）` : ""}`),
    h("small", {}, `${badges.join(" · ")} · 创建 ${formatDate(user.createdAt)} · 最近登录 ${formatDate(user.lastLoginAt)}`),
  ));
  const actions = h("div", { class: "users-row-actions" });
  const toggle = button({
    variant: "ghost", size: "sm", title: user.status === "active" ? "禁用该用户" : "启用该用户",
    label: user.status === "active" ? "禁用" : "启用",
  });
  toggle.addEventListener("click", () => {
    void toggleUser(user).catch((err) => status(`✗ ${(err as Error).message}`, "err"));
  });
  const reset = button({ variant: "ghost", size: "sm", title: "生成一次性临时密码", label: "重置密码" });
  reset.addEventListener("click", () => {
    void resetPassword(user).catch((err) => status(`✗ ${(err as Error).message}`, "err"));
  });
  const remove = button({
    variant: "danger", size: "sm", title: "软删除（数据保留）", label: "删除",
  });
  remove.addEventListener("click", () => {
    void deleteUser(user).catch((err) => status(`✗ ${(err as Error).message}`, "err"));
  });
  actions.append(toggle, reset, remove);
  row.appendChild(actions);
  if (selectedUser()?.userId === user.userId) row.classList.add("active");
  row.addEventListener("click", () => {
    document.querySelectorAll<HTMLElement>(".users-row").forEach((el) => el.classList.remove("active"));
    row.classList.add("active");
    const list = $("users-list");
    if (list) list.dataset.selectedId = user.userId;
    syncTokenUserPicker();
  });
  return row;
}

function renderUsers(users: ManagedUser[]): void {
  const list = $("users-list");
  if (!list) return;
  list.replaceChildren(...users.map(renderUserRow));
  if (!list.dataset.selectedId && users[0]) list.dataset.selectedId = users[0].userId;
  syncTokenUserPicker();
}

function syncTokenUserPicker(): void {
  const picker = $("users-token-user") as HTMLSelectElement | null;
  if (!picker) return;
  const previous = picker.value;
  picker.replaceChildren(...stateUsers.map((user) => {
    const option = h("option", { value: user.userId }, `${user.displayName}${user.username ? `（${user.username}）` : ""}`);
    return option;
  }));
  if (stateUsers.some((user) => user.userId === previous)) {
    picker.value = previous;
  } else if (stateUsers[0]) {
    picker.value = stateUsers[0].userId;
  }
  void refreshTokenList();
}

async function loadMe(): Promise<{ role?: string; backend?: string } | null> {
  return api<{ role?: string; backend?: string }>("/api/auth/me").catch(() => null);
}

/**
 * 按后端形态渲染分区：pg 多用户 → 管理面四卡；file 单用户 → 本地密码锁卡。
 * 分区入口对「pg 且非 admin」隐藏；file 模式始终可用（密码锁属于安全设置）。
 */
export async function refreshUsers(): Promise<boolean> {
  const me = await loadMe();
  const isPg = me?.backend === "postgres";
  const isAdmin = isPg && me?.role === "admin";
  const navItem = document.querySelector<HTMLElement>(".settings-nav-item[data-settings-view='users']");
  navItem?.classList.toggle("hidden", isPg && !isAdmin);
  document.querySelectorAll<HTMLElement>("[data-pg-only]").forEach((el) => {
    el.classList.toggle("hidden", !isPg);
  });
  document.querySelectorAll<HTMLElement>("[data-file-only]").forEach((el) => {
    el.classList.toggle("hidden", isPg);
  });
  const note = $("users-mode-note");
  if (note) note.textContent = isPg ? "PostgreSQL 多用户模式" : "单用户（文件）模式";
  if (isPg) {
    if (!isAdmin) return false;
    const data = await api<{ users: ManagedUser[] }>("/api/users");
    stateUsers = data.users;
    renderUsers(stateUsers);
    if (note) note.textContent = `PostgreSQL 多用户模式 · 共 ${stateUsers.length} 个用户`;
    return true;
  }
  await refreshLocalLock();
  return true;
}

// ---------------------------------------------------------------------------
// 文件模式：本地访问密码锁（U3）
// ---------------------------------------------------------------------------

function lockStatus(message: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("users-lock-status");
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status${kind ? ` ${kind}` : ""}`;
}

async function refreshLocalLock(): Promise<void> {
  const state = await api<{ enabled: boolean }>("/api/auth/local-lock");
  const out = $("users-lock-state");
  if (out) out.textContent = state.enabled ? "当前已启用访问密码锁" : "当前未设置密码锁（新设备配对只看 AUTH_TOKEN）";
}

async function setLocalLockFromUi(): Promise<void> {
  const current = ($("users-lock-current") as HTMLInputElement | null)?.value ?? "";
  const next = ($("users-lock-new") as HTMLInputElement | null)?.value ?? "";
  if (next.length < 10) {
    lockStatus("✗ 新访问密码至少 10 位", "err");
    return;
  }
  try {
    await postJson("/api/auth/local-lock", { currentPassword: current, newPassword: next });
    lockStatus("✓ 密码锁已设置；新设备配对时需要输入访问密码", "ok");
    if ($("users-lock-current")) ($("users-lock-current") as HTMLInputElement).value = "";
    if ($("users-lock-new")) ($("users-lock-new") as HTMLInputElement).value = "";
    await refreshLocalLock();
  } catch (err) {
    lockStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function clearLocalLockFromUi(): Promise<void> {
  const current = ($("users-lock-current") as HTMLInputElement | null)?.value ?? "";
  const confirmed = await uiConfirm("清除后新设备配对不再需要访问密码，确定清除？", {
    title: "清除密码锁", okText: "清除", danger: true,
  });
  if (!confirmed) return;
  try {
    await api("/api/auth/local-lock", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current }),
    });
    lockStatus("✓ 密码锁已清除", "ok");
    await refreshLocalLock();
  } catch (err) {
    lockStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function toggleUser(user: ManagedUser): Promise<void> {
  const disabling = user.status === "active";
  if (disabling) {
    const confirmed = await uiConfirm(
      `禁用「${user.displayName}」后其登录与访问令牌会立即失效，确定禁用？`,
      { title: "禁用用户", okText: "禁用", danger: true },
    );
    if (!confirmed) return;
  }
  await api(`/api/users/${user.userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: disabling ? "disabled" : "active" }),
  });
  status(disabling ? "已禁用" : "已启用", "ok");
  await refreshUsers();
}

async function resetPassword(user: ManagedUser): Promise<void> {
  const confirmed = await uiConfirm(
    `为「${user.displayName}」生成一次性临时密码？该用户下次登录必须修改密码。`,
    { title: "重置密码", okText: "重置" },
  );
  if (!confirmed) return;
  const data = await postJson<{ tempPassword: string }>(`/api/users/${user.userId}/reset-password`, {});
  await uiAlert(`临时密码（只显示这一次）：\n${data.tempPassword}`, "密码已重置");
  status("密码已重置", "ok");
}

async function deleteUser(user: ManagedUser): Promise<void> {
  const confirmed = await uiConfirm(
    `软删除「${user.displayName}」？其会话数据保留（可审计回溯），登录与令牌立即失效。`,
    { title: "删除用户", okText: "删除", danger: true },
  );
  if (!confirmed) return;
  await api(`/api/users/${user.userId}`, { method: "DELETE" });
  status("已删除（数据保留）", "ok");
  await refreshUsers();
}

async function createUser(): Promise<void> {
  const username = ($("users-new-username") as HTMLInputElement | null)?.value.trim() ?? "";
  const displayName = ($("users-new-display") as HTMLInputElement | null)?.value.trim() ?? "";
  const password = ($("users-new-password") as HTMLInputElement | null)?.value ?? "";
  const role = ($("users-new-role") as HTMLSelectElement | null)?.value === "admin" ? "admin" : "member";
  if (!username || !password) {
    status("✗ 用户名和初始密码都必填", "err");
    return;
  }
  try {
    await postJson("/api/users", { username, displayName, password, role });
    status(`✓ 已创建 ${displayName || username}；请把用户名和初始密码交给本人`, "ok");
    if ($("users-new-username")) ($("users-new-username") as HTMLInputElement).value = "";
    if ($("users-new-display")) ($("users-new-display") as HTMLInputElement).value = "";
    if ($("users-new-password")) ($("users-new-password") as HTMLInputElement).value = "";
    await refreshUsers();
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  }
}

function renderTokenRows(userId: string, tokens: UserTokenRow[]): void {
  const list = $("users-token-list");
  if (!list) return;
  if (!tokens.length) {
    list.textContent = "该用户暂无令牌";
    return;
  }
  list.replaceChildren(...tokens.map((token) => {
    const row = h("div", { class: "users-row", role: "row" });
    const state = token.revokedAt ? "已吊销" : "有效";
    row.appendChild(h("div", { class: "users-row-main" },
      h("strong", {}, token.label || "（无备注）"),
      h("small", {}, `${state} · 创建 ${formatDate(token.createdAt)} · 过期 ${formatDate(token.expiresAt)}`),
    ));
    if (!token.revokedAt) {
      const revoke = button({ variant: "danger", size: "sm", label: "吊销", title: "吊销该令牌" });
      revoke.addEventListener("click", () => {
        void (async () => {
          await api(`/api/users/${userId}/tokens/${token.id}`, { method: "DELETE" });
          await refreshTokenList();
        })().catch((err) => {
          const out = $("users-token-out");
          if (out) out.textContent = `✗ ${(err as Error).message}`;
        });
      });
      row.appendChild(revoke);
    }
    return row;
  }));
}

async function refreshTokenList(): Promise<void> {
  const user = ($("users-token-user") as HTMLSelectElement | null)?.value;
  const list = $("users-token-list");
  if (!user || !list) return;
  const data = await api<{ tokens: UserTokenRow[] }>(`/api/users/${user}/tokens`);
  renderTokenRows(user, data.tokens);
}

async function createToken(): Promise<void> {
  const user = ($("users-token-user") as HTMLSelectElement | null)?.value;
  const label = ($("users-token-label") as HTMLInputElement | null)?.value.trim() ?? "";
  const daysRaw = ($("users-token-days") as HTMLInputElement | null)?.value ?? "";
  const days = daysRaw ? Number(daysRaw) : null;
  if (!user) {
    status("✗ 请先选择目标用户", "err");
    return;
  }
  try {
    const data = await postJson<{ token: string }>(`/api/users/${user}/tokens`, {
      label,
      ...(days ? { expiresInDays: days } : {}),
    });
    const out = $("users-token-out");
    if (out) out.textContent = `新令牌（只显示这一次）：${data.token}`;
    await refreshTokenList();
  } catch (err) {
    const out = $("users-token-out");
    if (out) out.textContent = `✗ ${(err as Error).message}`;
  }
}

async function changeOwnPassword(): Promise<void> {
  const current = ($("users-pass-current") as HTMLInputElement | null)?.value ?? "";
  const next = ($("users-pass-new") as HTMLInputElement | null)?.value ?? "";
  const confirm = ($("users-pass-confirm") as HTMLInputElement | null)?.value ?? "";
  if (next.length < 10) {
    passStatus("✗ 新密码至少 10 位", "err");
    return;
  }
  if (next !== confirm) {
    passStatus("✗ 两次输入的新密码不一致", "err");
    return;
  }
  try {
    await postJson("/api/auth/password", { currentPassword: current, newPassword: next });
    passStatus("✓ 密码已修改；所有会话已失效，即将重新登录", "ok");
    window.setTimeout(() => window.location.reload(), 1_500);
  } catch (err) {
    passStatus(`✗ ${(err as Error).message}`, "err");
  }
}

/** 绑定按钮事件；只执行一次（settings 打开时调用）。 */
export function bindUsersSettings(): void {
  $("users-create-btn")?.addEventListener("click", () => {
    void createUser();
  });
  $("users-token-create-btn")?.addEventListener("click", () => {
    void createToken();
  });
  $("users-token-refresh-btn")?.addEventListener("click", () => {
    void refreshTokenList().catch((err) => {
      const out = $("users-token-out");
      if (out) out.textContent = `✗ ${(err as Error).message}`;
    });
  });
  $("users-pass-save-btn")?.addEventListener("click", () => {
    void changeOwnPassword();
  });
  $("users-lock-set-btn")?.addEventListener("click", () => {
    void setLocalLockFromUi();
  });
  $("users-lock-clear-btn")?.addEventListener("click", () => {
    void clearLocalLockFromUi();
  });
}
