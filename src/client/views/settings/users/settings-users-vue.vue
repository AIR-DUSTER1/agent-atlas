<!--
  settings-users-vue.vue — 账号与安全面板（框架迁移 M4 批次 4.2）
  ============================================================
  职责：admin 管理用户（创建 / 禁用 / 重置密码 / 软删除 / 访问令牌）
  与所有用户的自助改密、file 模式本地密码锁。DOM 契约与 h() 版一致
  （users-* id、.users-row 结构、aria-label 文案）。
  立场：
  - 文件模式整块隐藏管理面，不渲染无意义的 404 交互；
  - 临时密码 / 新令牌只展示一次，组件不留存；
  - 行选中态由组件内 selectedId 管理（不再是 list.dataset）。

  antdv 接入说明：文本/数字/密码输入用 Input 与 Input.Password，动作按钮用 Button。
  两个下拉（角色 / 令牌目标用户）已改 antdv Select；e2e 用 #id 点击 + 选项文本定位。
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { Button, Input, Select } from "antdv-next";
import { postJson } from "../../../core/api.js";
import { useUsersStore, type ManagedUser } from "../../../stores/settings/users/users.js";
import { uiConfirm, uiAlert } from "../../../ui/dialog.js";
import AntdvProvider from "../../../ui/antdv-provider.vue";

const store = useUsersStore();

const statusText = ref("");
const statusKind = ref<"ok" | "err" | "">("");
const passStatusText = ref("");
const passStatusKind = ref<"ok" | "err" | "">("");
const lockStatusText = ref("");
const lockStatusKind = ref<"ok" | "err" | "">("");
const tokenOut = ref("");

/** 下拉选项：antdv Select 用 options 数组。 */
const ROLE_OPTIONS = [
  { value: "member", label: "成员（member）" },
  { value: "admin", label: "管理员（admin）" },
];
const selectedId = ref("");
const selectedUser = computed(() => store.users.find((user) => user.userId === selectedId.value) ?? null);
const tokenPickerModel = ref("");
/** 令牌目标用户选项：随 store.users 变化。 */
const tokenUserOptions = computed(() => store.users.map((user) => ({ value: user.userId, label: userLabel(user) })));

// 创建用户表单
const newUsername = ref("");
const newDisplay = ref("");
const newPassword = ref("");
const newRole = ref("member");
// 令牌表单
const tokenLabel = ref("");
const tokenDays = ref("");
// 自助改密
const passCurrent = ref("");
const passNew = ref("");
const passConfirm = ref("");
// 本地密码锁
const lockCurrent = ref("");
const lockNew = ref("");

function status(message: string, kind: "ok" | "err" | "" = ""): void {
  statusText.value = message;
  statusKind.value = kind;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

function badgesOf(user: ManagedUser): string {
  const badges: string[] = [user.role === "admin" ? "管理员" : "成员"];
  if (user.status === "disabled") badges.push("已禁用");
  if (user.mustChangePassword) badges.push("待改密");
  if (!user.hasPassword) badges.push("仅令牌");
  return badges.join(" · ");
}

function userLabel(user: ManagedUser): string {
  return `${user.displayName}${user.username ? `（${user.username}）` : ""}`;
}

function selectUser(user: ManagedUser): void {
  selectedId.value = user.userId;
  void store.loadTokens(user.userId)
    .then(() => { tokenPickerModel.value = user.userId; })
    .catch((err) => { tokenOut.value = `✗ ${(err as Error).message}`; });
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
  try {
    await store.setUserStatus(user, disabling ? "disabled" : "active");
    status(disabling ? "已禁用" : "已启用", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  }
}

async function resetPassword(user: ManagedUser): Promise<void> {
  const confirmed = await uiConfirm(
    `为「${user.displayName}」生成一次性临时密码？该用户下次登录必须修改密码。`,
    { title: "重置密码", okText: "重置" },
  );
  if (!confirmed) return;
  try {
    const tempPassword = await store.resetPassword(user);
    void uiAlert(`临时密码（只显示这一次）：\n${tempPassword}`, "密码已重置");
    status("密码已重置", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  }
}

async function deleteUser(user: ManagedUser): Promise<void> {
  const confirmed = await uiConfirm(
    `软删除「${user.displayName}」？其会话数据保留（可审计回溯），登录与令牌立即失效。`,
    { title: "删除用户", okText: "删除", danger: true },
  );
  if (!confirmed) return;
  try {
    await store.deleteUser(user);
    if (selectedId.value === user.userId) selectedId.value = "";
    status("已删除（数据保留）", "ok");
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  }
}

async function createUser(): Promise<void> {
  const username = newUsername.value.trim();
  const displayName = newDisplay.value.trim();
  const password = newPassword.value;
  if (!username || !password) {
    status("✗ 用户名和初始密码都必填", "err");
    return;
  }
  try {
    await store.createUser({ username, displayName, password, role: newRole.value });
    status(`✓ 已创建 ${displayName || username}；请把用户名和初始密码交给本人`, "ok");
    newUsername.value = "";
    newDisplay.value = "";
    newPassword.value = "";
  } catch (err) {
    status(`✗ ${(err as Error).message}`, "err");
  }
}

function onTokenUserChange(): void {
  const userId = tokenPickerModel.value;
  if (!userId) return;
  store.loadTokens(userId).catch((err) => { tokenOut.value = `✗ ${(err as Error).message}`; });
}

async function createToken(): Promise<void> {
  if (!tokenPickerModel.value) {
    status("✗ 请先选择目标用户", "err");
    return;
  }
  if (tokenPickerModel.value !== store.tokenUserId) {
    try { await store.loadTokens(tokenPickerModel.value); } catch { /* 下面创建时再报错 */ }
  }
  const days = tokenDays.value ? Number(tokenDays.value) : undefined;
  try {
    const token = await store.createToken({ label: tokenLabel.value.trim(), ...(days ? { expiresInDays: days } : {}) });
    tokenOut.value = `新令牌（只显示这一次）：${token}`;
  } catch (err) {
    tokenOut.value = `✗ ${(err as Error).message}`;
  }
}

async function revokeToken(tokenId: string): Promise<void> {
  try {
    await store.revokeToken(tokenId);
  } catch (err) {
    tokenOut.value = `✗ ${(err as Error).message}`;
  }
}

async function changeOwnPassword(): Promise<void> {
  if (passNew.value.length < 10) {
    passStatusText.value = "✗ 新密码至少 10 位";
    passStatusKind.value = "err";
    return;
  }
  if (passNew.value !== passConfirm.value) {
    passStatusText.value = "✗ 两次输入的新密码不一致";
    passStatusKind.value = "err";
    return;
  }
  try {
    await postJson("/api/auth/password", {
      currentPassword: passCurrent.value,
      newPassword: passNew.value,
    });
    passStatusText.value = "✓ 密码已修改；所有会话已失效，即将重新登录";
    passStatusKind.value = "ok";
    window.setTimeout(() => window.location.reload(), 1_500);
  } catch (err) {
    passStatusText.value = `✗ ${(err as Error).message}`;
    passStatusKind.value = "err";
  }
}

async function setLocalLock(): Promise<void> {
  if (lockNew.value.length < 10) {
    lockStatusText.value = "✗ 新访问密码至少 10 位";
    lockStatusKind.value = "err";
    return;
  }
  try {
    await store.setLock(lockCurrent.value, lockNew.value);
    lockStatusText.value = "✓ 密码锁已设置；新设备配对时需要输入访问密码";
    lockStatusKind.value = "ok";
    lockCurrent.value = "";
    lockNew.value = "";
  } catch (err) {
    lockStatusText.value = `✗ ${(err as Error).message}`;
    lockStatusKind.value = "err";
  }
}

async function clearLocalLock(): Promise<void> {
  const confirmed = await uiConfirm("清除后新设备配对不再需要访问密码，确定清除？", {
    title: "清除密码锁", okText: "清除", danger: true,
  });
  if (!confirmed) return;
  try {
    await store.clearLock(lockCurrent.value);
    lockStatusText.value = "✓ 密码锁已清除";
    lockStatusKind.value = "ok";
    lockCurrent.value = "";
  } catch (err) {
    lockStatusText.value = `✗ ${(err as Error).message}`;
    lockStatusKind.value = "err";
  }
}
</script>

<template>
  <AntdvProvider>
  <div class="routing-head">
    <div>
      <span class="routing-kicker"><i class="ui-icon" data-icon="User" aria-hidden="true"></i> Access</span>
      <h2 id="users-title"><i class="ui-icon" data-icon="User" aria-hidden="true"></i> 账号与安全</h2>
    </div>
    <span class="settings-note" id="users-mode-note">
      {{ store.mode === "postgres" ? `PostgreSQL 多用户模式 · 共 ${store.users.length} 个用户` : store.mode === "file" ? "单用户（文件）模式" : "" }}
    </span>
  </div>

  <div class="routing-grid">
    <section v-if="store.mode === 'postgres' && store.isAdmin" class="routing-card" data-pg-only="true">
      <h3>用户列表</h3>
      <p class="routing-card-sub">创建后的用户用「用户名 + 密码」登录；重置密码会生成一次性临时密码并要求首登修改。</p>
      <div id="users-list" role="table" aria-label="用户列表">
        <div
          v-for="user in store.users"
          :key="user.userId"
          class="users-row"
          :class="{ active: selectedId === user.userId }"
          role="row"
          :data-user-id="user.userId"
          @click="selectUser(user)"
        >
          <div class="users-row-main">
            <strong>{{ userLabel(user) }}</strong>
            <small>{{ badgesOf(user) }} · 创建 {{ formatDate(user.createdAt) }} · 最近登录 {{ formatDate(user.lastLoginAt) }}</small>
          </div>
          <div class="users-row-actions">
            <Button class="ui-button ui-button-ghost ui-button-sm" :title="user.status === 'active' ? '禁用该用户' : '启用该用户'" @click.stop="toggleUser(user)">{{ user.status === "active" ? "禁用" : "启用" }}</Button>
            <Button class="ui-button ui-button-ghost ui-button-sm" title="生成一次性临时密码" @click.stop="resetPassword(user)">重置密码</Button>
            <Button title="软删除（数据保留）" @click.stop="deleteUser(user)" danger size="small">删除</Button>
          </div>
        </div>
      </div>
      <div id="users-status" class="settings-status" :class="statusKind" role="status" aria-live="polite">{{ statusText }}</div>
    </section>

    <section v-if="store.mode === 'postgres' && store.isAdmin" class="routing-card" data-pg-only="true">
      <h3>创建用户</h3>
      <p class="routing-card-sub">用户名 3-32 位字母数字；初始密码至少 10 位，用户首登时会被强制修改。</p>
      <label class="routing-field">
        <span>用户名</span>
        <Input id="users-new-username" v-model:value="newUsername" type="text" :maxlength="32" spellcheck="false" autocomplete="off" placeholder="alice" aria-label="新用户用户名" />
      </label>
      <label class="routing-field">
        <span>显示名</span>
        <Input id="users-new-display" v-model:value="newDisplay" type="text" :maxlength="60" spellcheck="false" placeholder="张三" aria-label="新用户显示名" />
      </label>
      <label class="routing-field">
        <span>初始密码</span>
        <Input.Password id="users-new-password" v-model:value="newPassword" autocomplete="new-password" placeholder="至少 10 位" aria-label="新用户初始密码" />
      </label>
      <label class="routing-field">
        <span>角色</span>
        <Select id="users-new-role" v-model:value="newRole" :options="ROLE_OPTIONS" aria-label="新用户角色" />
      </label>
      <div class="routing-actions">
        <Button id="users-create-btn" type="primary" @click="createUser">创建用户</Button>
      </div>
    </section>

    <section v-if="store.mode === 'postgres' && store.isAdmin" class="routing-card" data-pg-only="true">
      <h3>访问令牌</h3>
      <p class="routing-card-sub">给脚本 / 自动化用的一次性展示令牌；对应所选用户的 <code>auth_tokens</code>。</p>
      <label class="routing-field">
        <span>目标用户</span>
        <Select id="users-token-user" v-model:value="tokenPickerModel" :options="tokenUserOptions" aria-label="令牌目标用户" @change="onTokenUserChange" />
      </label>
      <label class="routing-field">
        <span>备注</span>
        <Input id="users-token-label" v-model:value="tokenLabel" type="text" :maxlength="60" placeholder="agent-bench" aria-label="令牌备注" />
      </label>
      <label class="routing-field">
        <span>有效期（天，留空 = 永久）</span>
        <Input id="users-token-days" v-model:value="tokenDays" type="number" :min="1" :max="3650" placeholder="90" aria-label="令牌有效天数" />
      </label>
      <div class="routing-actions">
        <Button id="users-token-create-btn" type="primary" @click="createToken">生成令牌</Button>
        <Button
          id="users-token-refresh-btn"
          @click="store.loadTokens(tokenPickerModel).catch((err) => { tokenOut = `✗ ${(err as Error).message}`; })"
        >刷新列表</Button>
      </div>
      <div id="users-token-out" class="settings-note" role="status" aria-live="polite">{{ tokenOut }}</div>
      <div id="users-token-list" role="table" aria-label="令牌列表">
        <span v-if="!store.tokens.length">该用户暂无令牌</span>
        <div v-for="token in store.tokens" :key="token.id" class="users-row" role="row">
          <div class="users-row-main">
            <strong>{{ token.label || "（无备注）" }}</strong>
            <small>{{ token.revokedAt ? "已吊销" : "有效" }} · 创建 {{ formatDate(token.createdAt) }} · 过期 {{ formatDate(token.expiresAt) }}</small>
          </div>
          <div v-if="!token.revokedAt" class="users-row-actions">
            <Button title="吊销该令牌" @click="revokeToken(token.id)" danger size="small">吊销</Button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="store.mode === 'postgres'" class="routing-card" data-pg-only="true">
      <h3>我的密码</h3>
      <p class="routing-card-sub">修改密码后所有会话与设备免登都会失效，需要重新登录。</p>
      <label class="routing-field">
        <span>当前密码（未设过密码可留空）</span>
        <Input.Password id="users-pass-current" v-model:value="passCurrent" autocomplete="current-password" aria-label="当前密码" />
      </label>
      <label class="routing-field">
        <span>新密码（至少 10 位）</span>
        <Input.Password id="users-pass-new" v-model:value="passNew" autocomplete="new-password" aria-label="新密码" />
      </label>
      <label class="routing-field">
        <span>确认新密码</span>
        <Input.Password id="users-pass-confirm" v-model:value="passConfirm" autocomplete="new-password" aria-label="确认新密码" />
      </label>
      <div class="routing-actions">
        <Button id="users-pass-save-btn" type="primary" @click="changeOwnPassword">修改密码</Button>
      </div>
      <div id="users-pass-status" class="settings-status" :class="passStatusKind" role="status" aria-live="polite">{{ passStatusText }}</div>
    </section>

    <section v-if="store.mode === 'file'" class="routing-card" data-file-only="true">
      <h3>本地访问密码锁</h3>
      <p class="routing-card-sub">单用户模式的访问锁：设置后，新设备配对需要输入访问密码（AUTH_TOKEN 仍是救援通道）。忘记密码可在本机运行 <code>npm run lock:clear</code> 解锁。</p>
      <div id="users-lock-state" class="settings-note" role="status" aria-live="polite">
        {{ store.lockEnabled ? "当前已启用访问密码锁" : "当前未设置密码锁（新设备配对只看 AUTH_TOKEN）" }}
      </div>
      <label class="routing-field">
        <span>当前密码（未设锁可留空）</span>
        <Input.Password id="users-lock-current" v-model:value="lockCurrent" autocomplete="current-password" aria-label="当前访问密码" />
      </label>
      <label class="routing-field">
        <span>新访问密码（至少 10 位）</span>
        <Input.Password id="users-lock-new" v-model:value="lockNew" autocomplete="new-password" aria-label="新访问密码" />
      </label>
      <div class="routing-actions">
        <Button id="users-lock-set-btn" type="primary" @click="setLocalLock">设置 / 更新密码锁</Button>
        <Button id="users-lock-clear-btn" danger @click="clearLocalLock">清除密码锁</Button>
      </div>
      <div id="users-lock-status" class="settings-status" :class="lockStatusKind" role="status" aria-live="polite">{{ lockStatusText }}</div>
    </section>
  </div>
  </AntdvProvider>
</template>
