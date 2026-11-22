<!--
  external-cards-vue.vue — 外部 Agent 卡片（框架迁移 M4 批次 4.4）
  ============================================================
  职责：外部 Agent 卡片渲染、接入流程（clone + 自动识别）、补全启动命令、
  凭证注入开关。DOM 契约与 h() 版一致（.demo-card.ext-card / .d-head / .d-name /
  .d-desc / .d-eg / .ext-del），Agent 选择页 e2e 依赖这些锚点。
  立场：接入 = 在服务器上运行第三方代码；凭证注入默认关闭且二次确认（右键）。
-->
<script setup lang="ts">
import { Button } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { useExternalStore } from "../../stores/external.js";
import { uiAlert, uiConfirm } from "../../ui/dialog.js";
import { completeExternalAgent, getCreateSessionFn } from "./external.js";

const store = useExternalStore();

async function removeAgent(agent: { id: string; name: string }): Promise<void> {
  const ok = await uiConfirm(
    `移除外部 Agent「${agent.name}」？
其 clone 缓存会一并删除；已创建的会话将无法继续发送。`,
    { title: "移除外部 Agent", okText: "移除", danger: true },
  );
  if (!ok) return;
  try {
    await store.remove(agent.id);
  } catch (err) {
    void uiAlert(`移除失败：${(err as Error).message}`, "外部 Agent");
  }
}

async function toggleCredentials(agent: { id: string; name: string; passCredentials?: boolean }): Promise<void> {
  const next = !agent.passCredentials;
  const ok = await uiConfirm(
    next
      ? `开启凭证注入？
当前网关 API Key / 地址将进入「${agent.name}」子进程的环境变量。
只对可信、开源且看过代码的仓库开启！`
      : `关闭「${agent.name}」的凭证注入？其后子进程将拿不到网关 Key。`,
    { title: "凭证注入", okText: next ? "开启" : "关闭", danger: next },
  );
  if (!ok) return;
  try {
    await store.setPassCredentials(agent.id, next);
  } catch (err) {
    void uiAlert(`设置失败：${(err as Error).message}`, "凭证注入");
  }
}

async function openAgent(agent: { id: string; name: string; command?: string }): Promise<void> {
  try {
    if (!agent.command) {
      await completeExternalAgent(agent);
      return;
    }
    await getCreateSessionFn()("external", null, null, agent.id);
  } catch (err) {
    void uiAlert("创建外部 Agent 会话失败：" + (err as Error).message, "外部 Agent");
  }
}

</script>

<template>
  <AntdvProvider>
  <div v-if="!store.agents.length" class="ext-empty">还没有接入外部 Agent —— 粘贴一个 Git 仓库地址即可（仓库里放一份 agent.json 说明如何启动效果最佳）</div>
  <template v-else>
    <Button v-for="a in store.agents" :key="a.id" class="demo-card ext-card" :class="{ 'ext-incomplete': !a.command }" @click="openAgent(a)" @contextmenu.prevent.stop="toggleCredentials(a)">
      <div class="d-head">
        <span class="d-num">🔌</span>
        <span class="d-name">{{ a.name }}</span>
        <Button class="ext-del" title="移除该外部 Agent" @click.stop="removeAgent(a)">✕</Button>
      </div>
      <div class="d-desc">{{ a.description || a.url }}</div>
      <div class="d-eg">{{ a.command ? `$ ${a.command} ${a.args.join(" ")}` : "⚠ 待补全启动命令" }}</div>
    </Button>
  </template>
  </AntdvProvider>
</template>
