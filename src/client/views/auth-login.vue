<!--
  auth-login.vue — 登录门页表单（框架迁移 M4 批次 4.0，首个 Vue SFC）
  ============================================================
  哑表单：只渲染用户名/密码并上报提交；POST /api/auth/login、错误回显、
  强制改密切换都在 apps/auth-gate.ts 的根组件里编排。
  可访问性：label 显式关联、错误用 role=alert 播报、挂载后聚焦首字段。
-->
<script setup lang="ts">
import { onMounted, ref } from "vue";

defineProps<{
  busy: boolean;
  error: string;
  notice: string;
}>();

const emit = defineEmits<{
  submit: [payload: { username: string; password: string }];
}>();

const username = ref("");
const password = ref("");
const usernameError = ref("");
const passwordError = ref("");
const usernameInput = ref<HTMLInputElement | null>(null);

onMounted(() => usernameInput.value?.focus());

function submit(): void {
  usernameError.value = username.value.trim() ? "" : "请输入用户名";
  passwordError.value = password.value ? "" : "请输入密码";
  if (usernameError.value || passwordError.value) return;
  emit("submit", { username: username.value.trim(), password: password.value });
}
</script>

<template>
  <form class="auth-form" novalidate @submit.prevent="submit">
    <p v-if="notice" class="auth-notice" role="status">{{ notice }}</p>

    <div class="auth-field">
      <label for="auth-username">用户名</label>
      <input
        id="auth-username"
        ref="usernameInput"
        v-model="username"
        type="text"
        autocomplete="username"
        spellcheck="false"
        :aria-invalid="Boolean(usernameError)"
      />
      <p v-if="usernameError" class="auth-field-error" role="alert">{{ usernameError }}</p>
    </div>

    <div class="auth-field">
      <label for="auth-password">密码</label>
      <input
        id="auth-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        :aria-invalid="Boolean(passwordError)"
      />
      <p v-if="passwordError" class="auth-field-error" role="alert">{{ passwordError }}</p>
    </div>

    <p v-if="error" class="auth-error" role="alert">{{ error }}</p>

    <button type="submit" class="auth-submit" :disabled="busy">
      {{ busy ? "登录中…" : "登录" }}
    </button>
  </form>
</template>

<style scoped>
.auth-form {
  display: flex;
  flex-direction: column;
}
.auth-notice {
  background: var(--accent-soft, rgba(79, 142, 247, 0.12));
  border-radius: 8px;
  color: var(--text, #e6e6ea);
  font-size: var(--font-sm, 13px);
  margin: 0 0 14px;
  padding: 8px 10px;
}
.auth-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.auth-field label {
  color: var(--text-2, #9b9ba4);
  font-size: var(--font-sm, 13px);
}
.auth-field input {
  background: var(--bg-elev, #232428);
  border: 1px solid var(--border, #2e2f35);
  border-radius: 8px;
  color: var(--text, #e6e6ea);
  min-height: 36px;
  padding: 0 12px;
}
.auth-field input:focus-visible {
  outline: 2px solid var(--accent, #4f8ef7);
  outline-offset: 1px;
}
.auth-field-error {
  color: var(--danger, #f56c6c);
  font-size: var(--font-xs, 12px);
  margin: 0;
}
.auth-error {
  background: var(--danger-bg, rgba(245, 108, 108, 0.12));
  border-radius: 8px;
  color: var(--danger, #f56c6c);
  font-size: var(--font-sm, 13px);
  margin: 0 0 14px;
  padding: 8px 10px;
}
.auth-submit {
  background: var(--accent, #4f8ef7);
  border: none;
  border-radius: 8px;
  color: #fff;
  font-size: var(--font-md, 14px);
  min-height: 38px;
  width: 100%;
}
.auth-submit:disabled {
  opacity: 0.6;
}
.auth-submit:focus-visible {
  outline: 2px solid var(--text, #e6e6ea);
  outline-offset: 1px;
}
</style>
