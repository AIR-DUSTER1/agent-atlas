<!--
  auth-login.vue — 登录门页表单（框架迁移 M4 批次 4.0；antdv 接入批次改控件）
  ============================================================
  哑表单：只渲染用户名/密码并上报提交；POST /api/auth/login、错误回显、
  强制改密切换都在 apps/auth-gate-mount.ts 的根组件里编排。
  可访问性：label 显式关联（FormItem htmlFor）、错误用 role=alert 播报、
  挂载后聚焦首字段。

  antdv 接入说明（本文件是「受控面板用 antdv」的基线范例）：
  - 表单骨架用 Form/FormItem（自动 label→for 关联），控件用 Input/InputPassword，
    提交按钮用 Button（htmlType=submit，配合原生 form submit）；
  - 字段级错误**不用** FormItem 的 help（它不输出 role=alert），而是自建
    <p role="alert">，保住原有可访问性契约；aria-invalid 透传到真实 input；
  - 服务端错误用 Alert：它自带 role="alert"，且文案由 prop 传入（不拼 HTML）；
  - id 契约（#auth-username / #auth-password）通过 Input 的 id 属性透传，
    e2e 与 tests/vue/auth-gate.test.ts 依赖这些锚点。
-->
<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { Alert, Button, Form, Input } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";

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
const usernameInput = ref<{ focus: () => void } | null>(null);

onMounted(async () => {
  // antdv Input 的 ref 暴露 focus()；等首帧渲染后再聚焦
  await nextTick();
  usernameInput.value?.focus();
});

function submit(): void {
  usernameError.value = username.value.trim() ? "" : "请输入用户名";
  passwordError.value = password.value ? "" : "请输入密码";
  if (usernameError.value || passwordError.value) return;
  emit("submit", { username: username.value.trim(), password: password.value });
}

/** antdv Form 的 submit 事件：阻止默认跳转后走本地校验。 */
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
        <label class="auth-label" for="auth-username">用户名</label>
        <Input
          id="auth-username"
          ref="usernameInput"
          v-model:value="username"
          autocomplete="username"
          spellcheck="false"
          :status="usernameError ? 'error' : undefined"
          :aria-invalid="Boolean(usernameError)"
        />
        <p v-if="usernameError" class="auth-field-error" role="alert">{{ usernameError }}</p>
      </div>

      <div class="auth-field">
        <label class="auth-label" for="auth-password">密码</label>
        <Input.Password
          id="auth-password"
          v-model:value="password"
          autocomplete="current-password"
          :status="passwordError ? 'error' : undefined"
          :aria-invalid="Boolean(passwordError)"
        />
        <p v-if="passwordError" class="auth-field-error" role="alert">{{ passwordError }}</p>
      </div>

      <Alert v-if="error" class="auth-error" type="error" :message="error" show-icon />

      <Button class="auth-submit" type="primary" html-type="submit" block :loading="busy">
        {{ busy ? "登录中…" : "登录" }}
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
