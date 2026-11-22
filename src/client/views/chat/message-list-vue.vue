<!--
  message-list-vue.vue — 消息流的块级骨架（框架迁移 M4 批次 4.6）
  ============================================================
  职责：#messages 内 user / notice / error / assistant 四类块的**骨架**渲染，
  以及助手回合的 footer（复制总结 + 用量小字）。
  DOM 契约与 h() 版逐类名一致：
    .msg-user / .msg-user-content / .bubble / .f-chips / .f-chip / .fname / .fsrc
    .user-message-footer / .message-actions.user-actions
    .notice-block(.loading) / .notice-title / .notice-text / .notice-details
    .error-block
    .msg-assistant / .avatar / .assistant-content / .assistant-body
    .assistant-footer(.is-empty) / .assistant-actions / .assistant-footer-meta
    .usage-caption
  e2e 与 message-copy / chat-flow 单测依赖这些锚点。

  立场（重要）：
  - **只渲染骨架**：助手块内的具体 parts（text / thinking / tool / approval /
    clarification / route）仍由 render/parts.ts 命令式增量渲染 —— 流式热路径
    依赖 partEls 引用表与 55ms 节流，v-for 全量重渲染会在 token 级别变得很贵。
  - 每次渲染后扫描 #messages 的 [data-block-key] 容器，把 .assistant-body
    放进注册表交给 parts.ts；块被移除时随扫描自动清空。
  - 复制按钮的图标切换与「已复制」反馈留在本组件；剪贴板写入复用
    modules/clipboard 的 writeClipboardText（含降级路径）。
-->
<script setup lang="ts">
import { Button } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useMessagesStore } from "../../stores/messages.js";
import type { MessageBlockView } from "../../stores/messages.js";
import { writeClipboardText } from "../../modules/clipboard.js";
import { toast } from "../../ui/toast.js";
import { assistantSummaryText } from "../../modules/message-copy.js";
import { state, transcript } from "../../core/state.js";
import type { ChatBlock } from "../../modules/types.js";

const COPY_FEEDBACK_MS = 1_800;

const store = useMessagesStore();
const blocks = computed<MessageBlockView[]>(() => store.blocks);

/** 复制按钮的临时反馈态：key → 已复制。 */
const copied = ref<Record<string, boolean>>({});
const timers = new Map<string, number>();

/** 块容器注册表：key → 元素（供 parts.ts 取 .assistant-body）。 */
const bodyRefs = new Map<string, HTMLElement>();
const wrapRefs = new Map<string, HTMLElement>();

/** 渲染完成后由容器自身扫描注册（函数式 ref 在 v-for 里会踩 Vue 内部
 *  vnode 引用，这里改用 DOM 查询，代价是每次 patch 一次 querySelectorAll）。 */
function collectRefs(): void {
  bodyRefs.clear();
  wrapRefs.clear();
  const root = document.getElementById("messages");
  if (!root) return;
  // ⚠ 不能用 root.children：Vue 挂载会在容器内生成 <div data-v-app> 包装层，
  // 块是它的子节点而不是 #messages 的直接子节点。用 querySelectorAll 跨层取。
  const els = [...root.querySelectorAll<HTMLElement>("[data-block-key]")];
  for (const el of els) {
    const key = el.dataset.blockKey;
    if (!key) continue;
    wrapRefs.set(key, el);
    const body = el.querySelector<HTMLElement>(".assistant-body");
    if (body) bodyRefs.set(key, body);
  }
}

/** 取块对象（编译视图时按同序号对齐 core state）。 */
function blockAt(key: string): ChatBlock | undefined {
  const index = Number(key.slice(key.lastIndexOf("-") + 1));
  const sid = state.currentId;
  if (!sid || Number.isNaN(index)) return undefined;
  return transcript(sid)[index];
}

function copyTextFor(block: MessageBlockView): string {
  if (block.t === "user") return block.text ?? "";
  if (block.t === "notice") return block.summary ?? "";
  const raw = blockAt(block.key);
  return raw && raw.t === "assistant" ? assistantSummaryText(raw) : "";
}

function copyLabelFor(block: MessageBlockView): { label: string; copiedLabel: string; empty: string } {
  if (block.t === "user") return { label: "复制", copiedLabel: "已复制", empty: "这条消息没有可复制的文字" };
  if (block.t === "notice") return { label: "复制摘要", copiedLabel: "摘要已复制", empty: "当前没有可复制的摘要" };
  return { label: "复制总结", copiedLabel: "总结已复制", empty: "当前回合还没有可复制的总结" };
}

async function copy(block: MessageBlockView): Promise<void> {
  const { copiedLabel, empty } = copyLabelFor(block);
  const text = copyTextFor(block);
  if (!text.trim()) {
    toast(empty);
    return;
  }
  const ok = await writeClipboardText(text);
  if (!ok) {
    toast("复制失败，请手动选择文本", "error");
    return;
  }
  copied.value = { ...copied.value, [block.key]: true };
  const previous = timers.get(block.key);
  if (previous !== undefined) window.clearTimeout(previous);
  timers.set(block.key, window.setTimeout(() => {
    copied.value = { ...copied.value, [block.key]: false };
    timers.delete(block.key);
  }, COPY_FEEDBACK_MS));
  void copiedLabel;
}

/** 外部状态变化（流式 / 切会话 / 回放）后重新编译块清单。 */
const listener = (): void => {
  store.refresh();
  void nextTick(() => {
    collectRefs();
    window.__agentatlasBlockBodyRegistry = {
      body: (key) => bodyRefs.get(key) ?? null,
      wrap: (key) => wrapRefs.get(key) ?? null,
    };
  });
};

onMounted(() => {
  store.refresh();
  void nextTick(() => {
    collectRefs();
    window.__agentatlasBlockBodyRegistry = {
      body: (key) => bodyRefs.get(key) ?? null,
      wrap: (key) => wrapRefs.get(key) ?? null,
    };
  });
  (window.__agentatlasMessageListeners ??= new Set()).add(listener);
});
onUnmounted(() => {
  window.__agentatlasMessageListeners?.delete(listener);
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
});

/** 块被移除时（重放 / 切会话）清掉注册，避免 parts.ts 拿到分离节点。 */
/**
 * 每次块清单变化后：重新扫描容器并刷新注册表。
 * 这是 parts.ts 拿 .assistant-body 的唯一入口 —— 必须在每个 patch 之后执行，
 * 否则 mountBlock 里的 waitForWrap 永远等不到容器。
 */
watch(() => store.revision, () => {
  void nextTick(() => {
    collectRefs();
    window.__agentatlasBlockBodyRegistry = {
      body: (key) => bodyRefs.get(key) ?? null,
      wrap: (key) => wrapRefs.get(key) ?? null,
    };
  });
});
</script>

<template>
  <AntdvProvider>
  <!--
    ⚠ key 必须落在**实际渲染的根元素**上，不能挂在 <template v-for> 上：
    template + v-if/v-else-if/v-else 组合时 Vue 无法把 key 应用到分支根节点，
    会在 patch 阶段拿到已分离的 DOM 元素并抛 "Cannot read properties of null"。
    这里的四类块各自带 :key，v-for 用单根 <template> 不加 key。
  -->
  <template v-for="block in blocks">
    <!-- 用户消息 -->
    <div v-if="block.t === 'user'" :key="block.key" class="msg-user" :data-block-key="block.key">
      <div class="msg-user-content">
        <div class="bubble">
          <div v-if="block.files?.length" class="f-chips">
            <span v-for="file in block.files" :key="`${block.key}:${file.name}`" class="f-chip">
              <i class="ui-icon" :data-icon="file.image ? 'Image' : 'Paperclip'" aria-hidden="true"></i>
              <span class="fname">{{ file.name }}</span>
              <span class="fsrc">{{ file.source }}</span>
            </span>
          </div>
          <div>{{ block.text }}</div>
        </div>
        <div class="user-message-footer">
          <div class="message-actions user-actions">
            <Button class="message-action" :class="{ copied: copied[block.key] }" :title="copied[block.key] ? '已复制' : '复制'" :aria-label="copied[block.key] ? '已复制' : '复制'" @click="copy(block)">
              <i class="ui-icon" :data-icon="copied[block.key] ? 'Check' : 'Copy'" aria-hidden="true"></i>
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 提示块（压缩摘要等） -->
    <div v-else-if="block.t === 'notice'" :key="block.key" class="notice-block" :class="{ loading: block.loading }" :data-block-key="block.key">
      <div class="notice-title">{{ block.noticeTitle || "提示" }}</div>
      <div class="notice-text">{{ block.noticeText || "" }}</div>
      <details v-if="block.summary" class="notice-details">
        <summary>查看压缩摘要</summary>
        <div class="notice-details-body">
          <pre>{{ block.summary }}</pre>
          <div class="notice-details-actions">
            <Button class="message-action" :class="{ copied: copied[block.key] }" :title="copied[block.key] ? '摘要已复制' : '复制摘要'" :aria-label="copied[block.key] ? '摘要已复制' : '复制摘要'" @click="copy(block)">
              <i class="ui-icon" :data-icon="copied[block.key] ? 'Check' : 'Copy'" aria-hidden="true"></i>
            </Button>
          </div>
        </div>
      </details>
    </div>

    <!-- 错误块 -->
    <div v-else-if="block.t === 'error'" :key="block.key" class="error-block" :data-block-key="block.key">
      <i class="ui-icon" data-icon="TriangleAlert" aria-hidden="true"></i>
      <span>{{ block.text }}</span>
    </div>

    <!-- 助手回合骨架：parts 由 render/parts.ts 挂进 .assistant-body -->
    <div v-else :key="block.key" class="msg-assistant" :data-block-key="block.key">
      <div class="avatar" aria-hidden="true"><i class="ui-icon" data-icon="Zap" aria-hidden="true"></i></div>
      <div class="assistant-content">
        <!--
          v-once：render/parts.ts 会往这里 appendChild 命令式节点。若让 Vue
          参与这块子树的 patch，它会把外来节点当成 DOM 遗漏处理，进而在已分离的
          元素上挂事件/类，抛 "Cannot read properties of null (reading 'Symbol(_vei)')"。
          v-once 让 Vue 渲染一次后完全跳过该子树 —— 这是「声明式骨架 + 命令式
          内容」共存的最小侵入做法。
        -->
        <div class="assistant-body" v-once></div>
        <div class="assistant-footer" :class="{ 'is-empty': !block.usageCaption && !block.copyVisible }">
          <div class="message-actions assistant-actions" :class="{ hidden: !block.copyVisible }">
            <Button class="message-action" :class="{ copied: copied[block.key] }" :title="copied[block.key] ? '总结已复制' : '复制总结'" :aria-label="copied[block.key] ? '总结已复制' : '复制总结'" @click="copy(block)">
              <i class="ui-icon" :data-icon="copied[block.key] ? 'Check' : 'Copy'" aria-hidden="true"></i>
            </Button>
          </div>
          <div class="assistant-footer-meta">
            <div v-if="block.usageCaption" class="usage-caption">{{ block.usageCaption }}</div>
          </div>
        </div>
      </div>
    </div>
  </template>
  </AntdvProvider>
</template>
