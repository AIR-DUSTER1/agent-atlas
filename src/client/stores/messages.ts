/**
 * ============================================================
 * stores/messages.ts — 消息流的块级视图（M4 批次 4.6）
 * ============================================================
 * 职责：把 core state 的 ChatBlock 数组镜像成 Vue 可渲染的块清单。
 *
 * 分层裁定（重要，勿轻易越界）：
 *  - **块骨架**（user / notice / error / assistant 外壳、头像、footer、复制按钮、
 *    用量小字）由 Vue 声明式渲染 —— 它们是「一个块一条」的低频结构；
 *  - **part 渲染**（text / thinking / tool / approval / clarification / route）
 *    继续由 render/parts.ts 命令式增量渲染。它的流式热路径依赖 partEls 引用表
 *    与 55ms 节流；改成 v-for 全量重渲染会在 token 级别产生可观开销。
 *    因此组件只负责渲染空容器，parts 通过 registerBlockBody 拿到 .assistant-body。
 *
 * 1:1 过渡树已退役（M4 4.6-B0），本 store 可以被静态 import —— 不再需要 window 通道。
 */
import { defineStore } from "pinia";
import { state, transcript } from "../core/state.js";
import { assistantSummaryText } from "../modules/message-copy.js";
import type { ChatBlock } from "../modules/types.js";
import "./pinia.js";

/** 一块在模板里需要的全部展示信息（不含 DOM 引用）。 */
export interface MessageBlockView {
  /** 稳定 key（块序号；块对象本身不参与 key，重放时整体重建）。 */
  key: string;
  t: ChatBlock["t"];
  /** user：正文；error：错误文案。 */
  text?: string;
  /** user：附件 chips。 */
  files?: Array<{ name: string; source: string; image?: boolean }>;
  /** notice：标题 / 正文 / 加载态 / 压缩摘要。 */
  noticeTitle?: string;
  noticeText?: string;
  loading?: boolean;
  summary?: string;
  /** assistant：用量小字（↑ 输入 · ↓ 输出 · 缓存 N%）。 */
  usageCaption?: string;
  /** assistant：是否有可复制的总结（决定复制按钮显隐）。 */
  copyVisible?: boolean;
}

/** 组件注册块容器的回调集合：parts.ts / messages.ts 通过它拿到 .assistant-body。 */
export interface BlockBodyRegistry {
  body?: (key: string) => HTMLElement | null;
  wrap?: (key: string) => HTMLElement | null;
}

declare global {
  interface Window {
    /** message-list-vue 在每次渲染后写入的块容器注册表。 */
    __agentatlasBlockBodyRegistry?: BlockBodyRegistry;
    /** 外部状态变更时唤醒消息列表重编译块清单。 */
    __agentatlasMessageListeners?: Set<() => void>;
  }
}

export const useMessagesStore = defineStore("messages", {
  state: () => ({
    blocks: [] as MessageBlockView[],
    /** 每次外部状态变更自增（core state 非响应式）。 */
    revision: 0,
  }),
  getters: {
    /** 是否需要显示「空会话」引导（无块时）。 */
    isEmpty(): boolean {
      return this.blocks.length === 0;
    },
  },
  actions: {
    /**
     * 从 core state 重新编译块清单。
     *
     * ⚠ 必须**原地复用已有的块视图对象**（按 key 匹配后 Object.assign）：
     * 助手块的 .assistant-body 里塞着 parts.ts 命令式挂上去的节点，
     * 如果每次 refresh 都换成全新对象，Vue 会把整块 vnode 重建 —— 外来节点
     * 与 vnode 树失配，patch 阶段会在已分离元素上挂事件并抛
     * "Cannot read properties of null (reading 'Symbol(_vei)')"。
     * 复用对象能让 Vue 只更新变化的文本/属性，body 里的 DOM 原样保留。
     */
    refresh(): void {
      const next = buildMessageBlocks();
      const existing = new Map(this.blocks.map((block) => [block.key, block]));
      this.blocks = next.map((block) => {
        const previous = existing.get(block.key);
        if (previous) {
          Object.assign(previous, block);
          return previous;
        }
        return block;
      });
      this.revision += 1;
    },
    clear(): void {
      this.blocks = [];
      this.revision += 1;
    },
  },
});

/** 从 core state 编译块清单（纯派生，可直接在测试里调用）。 */
export function buildMessageBlocks(): MessageBlockView[] {
  const sid = state.currentId;
  if (!sid) return [];
  const arr = transcript(sid);
  const views: MessageBlockView[] = [];
  for (let index = 0; index < arr.length; index += 1) {
    const block = arr[index]!;
    // key 必须带会话 id：message-list-vue 的 assistant-body 使用 v-once 保护
    // 命令式 parts。不同会话若都生成 `assistant-1`，切会话时 Vue 会复用旧
    // DOM，造成上下文、澄清卡和头像串到另一个会话。
    const key = messageBlockKey(sid, block.t, index);
    if (block.t === "user") {
      views.push({ key, t: "user", text: block.text, files: block.files });
      continue;
    }
    if (block.t === "notice") {
      views.push({
        key, t: "notice",
        noticeTitle: block.title, noticeText: block.text,
        loading: Boolean(block.loading), summary: block.summary,
      });
      continue;
    }
    if (block.t === "error") {
      views.push({ key, t: "error", text: block.text });
      continue;
    }
    const usage = block._usage;
    views.push({
      key, t: "assistant",
      usageCaption: usage ? usageCaptionOf(usage) : "",
      copyVisible: Boolean(assistantSummaryText(block)),
    });
  }
  return views;
}

/** 消息块稳定 key：同一会话内按序号稳定，跨会话绝不复用 DOM。 */
export function messageBlockKey(sid: string, type: ChatBlock["t"], index: number): string {
  return `${sid}:${type}-${index}`;
}

/** 用量小字：↑ 输入 · ↓ 输出 · 缓存 N%（与 h() 版逐字一致）。 */
export function usageCaptionOf(usage: { lastInput: number; lastOutput: number; lastCache: number }): string {
  const cache = usage.lastCache > 0 && usage.lastInput > 0
    ? ` · 缓存 ${Math.round((usage.lastCache / usage.lastInput) * 100)}%`
    : "";
  return `↑ ${usage.lastInput.toLocaleString("zh-CN")} · ↓ ${usage.lastOutput.toLocaleString("zh-CN")}${cache}`;
}
