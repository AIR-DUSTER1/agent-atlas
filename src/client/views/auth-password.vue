<!--
  auth-password.vue — 强制改密页表单（框架迁移 M4 批次 4.0）
  ============================================================
  哑表单：只渲染当前/新/确认三段密码并上报提交；POST /api/auth/password
  与改密后的重登在 apps/auth-gate.ts 根组件编排。本地校验（≥10 位、两次
  一致）与服务端 validatePasswordPolicy 语义一致。
-->
<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  busy: boolean;
  error: string;
  notice: string;
  /** 预填当前密码：登录刚成功编排带入，避免用户重复输入临时密码 */
  currentValue?: string;
}>();

const emit = defineEmits<{
  submit: [payload: { currentPassword: string; newPassword: string }];
}>();

const current = ref(props.currentValue ?? "");
const next = ref("");
const confirm = ref("");
const nextError = ref("");
const confirmError = ref("");

function submit(): void {
  nextError.value = next.value.length >= 10 ? "" : "新密码至少 10 个字符";
  confirmError.value = next.value === confirm.value ? "" : "两次输入的新密码不一致";
  if (nextError.value || confirmError.value) return;
  emit("submit", { currentPassword: current.value, newPassword: next.value });
}
</script>

<template>
  <form class="auth-form" novalidate @submit.prevent="submit">
    <p v-if="notice" class="auth-notice" role="status">{{ notice }}</p>

    <div class="auth-field">
      <label for="auth-pass-current">当前密码（未设过密码可留空）</label>
      <input
        id="auth-pass-current"
        v-model="current"
        type="password"
        autocomplete="current-password"
      />
    </div>

    <div class="auth-field">
      <label for="auth-pass-next">新密码（至少 10 位）</label>
      <input
        id="auth-pass-next"
        v-model="next"
        type="password"
        autocomplete="new-password"
        :aria-invalid="Boolean(nextError)"
      />
      <p v-if="nextError" class="auth-field-error" role="alert">{{ nextError }}</p>
    </div>

    <div class="auth-field">
      <label for="auth-pass-confirm">确认新密码</label>
      <input
        id="auth-pass-confirm"
        v-model="confirm"
        type="password"
        autocomplete="new-password"
        :aria-invalid="Boolean(confirmError)"
      />
      <p v-if="confirmError" class="auth-field-error" role="alert">{{ confirmError }}</p>
    </div>

    <p v-if="error" class="auth-error" role="alert">{{ error }}</p>

    <button type="submit" class="auth-submit" :disabled="busy">
      {{ busy ? "提交中…" : "修改密码" }}
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
