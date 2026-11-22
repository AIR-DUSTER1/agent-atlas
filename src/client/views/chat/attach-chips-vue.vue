<!--
  attach-chips-vue.vue — 待发送附件 chips（框架迁移 M4 批次 4.6）
  ============================================================
  职责：渲染待发送附件 chip（缩略图 / 名称 / 来源 / 删除）。
  DOM 契约与 h() 版一致（#attach-chips / .attach-chip / .thumb / .c-name / .c-src / .c-del）。
  立场：附件本体在 core state（发送流程读它），本组件只负责展示与移除。
-->
<script setup lang="ts">
import { Button } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { useAttachmentsStore, refKey } from "../../stores/chat/attachments.js";
import { renderFsSelection } from "./attachments.js";

const store = useAttachmentsStore();

function remove(key: string): void {
  store.remove(key);
  renderFsSelection();
}
</script>

<template>
  <AntdvProvider>
  <div id="attach-chips" class="attach-chips" :class="{ hidden: !store.visible }">
    <span
      v-for="file in store.files"
      :key="refKey(file)"
      class="attach-chip"
      :class="{ 'has-thumb': file.kind === 'upload' && Boolean(file.preview) }"
    >
      <img v-if="file.kind === 'upload' && file.preview" class="thumb" alt="" :src="file.preview" />
      <template v-else>📎</template>
      <span class="c-name">{{ file.name }}</span>
      <span class="c-src">{{ store.sourceLabel(file) }}</span>
      <Button class="c-del" title="移除" @click="remove(refKey(file))">✕</Button>
    </span>
  </div>
  </AntdvProvider>
</template>
