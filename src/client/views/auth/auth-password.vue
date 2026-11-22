<!--
  auth-password.vue — 强制改密页表单（框架迁移 M4 批次 4.0；antdv 接入批次改控件）
  ============================================================
  哑表单：只渲染当前/新/确认三段密码并上报提交；POST /api/auth/password
  与改密后的重登在 apps/auth-gate-mount.ts 根组件编排。本地校验（≥10 位、
  两次一致）与服务端 validatePasswordPolicy 语义一致。

  antdv 接入说明：三段密码都用 Input.Password（自带显示/隐藏切换与
  aria-pressed/aria-label），提交按钮 Button，服务端错误 Alert（role=alert）。
  字段级错误仍是自建 <p role="alert">：FormItem 的 help 不输出 alert 语义。
-->
<script setup lang="ts">
import { ref } from "vue";
import { Alert, Button, Form, Input } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";

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

function onSubmit(event: Event): void {
  event.preventDefault();
  submit();
}
</script>

<template>
  <AntdvProvider>
    <Form class="auth-form" layout="vertical" novalidate :disabled="busy" @submit="onSubmit">
      <p v-if="notice" class="auth-notice" role="status">{{ notice }}</p>

      <div class="auth-field">
        <label class="auth-label" for="auth-pass-current">当前密码（未设过密码可留空）</label>
        <Input.Password
          id="auth-pass-current"
          v-model:value="current"
          autocomplete="current-password"
        />
      </div>

      <div class="auth-field">
        <label class="auth-label" for="auth-pass-next">新密码（至少 10 位）</label>
        <Input.Password
          id="auth-pass-next"
          v-model:value="next"
          autocomplete="new-password"
          :status="nextError ? 'error' : undefined"
          :aria-invalid="Boolean(nextError)"
        />
        <p v-if="nextError" class="auth-field-error" role="alert">{{ nextError }}</p>
      </div>

      <div class="auth-field">
        <label class="auth-label" for="auth-pass-confirm">确认新密码</label>
        <Input.Password
          id="auth-pass-confirm"
          v-model:value="confirm"
          autocomplete="new-password"
          :status="confirmError ? 'error' : undefined"
          :aria-invalid="Boolean(confirmError)"
        />
        <p v-if="confirmError" class="auth-field-error" role="alert">{{ confirmError }}</p>
      </div>

      <Alert v-if="error" class="auth-error" type="error" :message="error" show-icon />

      <Button class="auth-submit" type="primary" html-type="submit" block :loading="busy">
        {{ busy ? "提交中…" : "修改密码" }}
      </Button>
    </Form>
  </AntdvProvider>
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
.auth-label {
  color: var(--text-2, #9b9ba4);
  font-size: var(--font-sm, 13px);
}
.auth-field-error {
  color: var(--danger, #f56c6c);
  font-size: var(--font-xs, 12px);
  margin: 0;
}
.auth-error {
  margin-bottom: 14px;
}
.auth-submit {
  min-height: 38px;
  width: 100%;
}
</style>
