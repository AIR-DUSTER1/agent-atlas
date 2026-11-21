<!--
  kb-panel-vue.vue — 知识库（外部 RAG）弹窗（框架迁移 M4 批次 4.4）
  ============================================================
  职责：RAG 配置 / 入库 / 检索测试 / 登记文档列表。DOM 契约与静态版逐 id
  一致（kb-*），a11y 断言（kb-query/kb-key aria-label）与主入口绑定依赖这些锚点。
  立场：入库只允许授权路径（服务端 files.ts 校验），前端不做二次拼路径。
-->
<script setup lang="ts">
import { ref, watch } from "vue";
import { useRagStore } from "../stores/rag.js";
import { setKbStatus } from "./rag.js";
import { uiAlert, uiConfirm, uiPrompt } from "../ui/dialog.js";
import { refreshPluginCards } from "./settings-plugins.js";

const store = useRagStore();

const form = ref({ url: "", collection: "", topk: "", key: "" });
const saving = ref(false);
const testing = ref(false);
const ingesting = ref(false);
const keyVisible = ref(false);

const keyStateText = ref("");
const keyStateOk = ref(false);

/** 打开弹窗时回填（watch kbOpen，可反复开关）。 */
watch(() => store.kbOpen, (open) => {
  document.getElementById("kb-mask")?.classList.toggle("hidden", !open);
  if (!open) return;
  const rag = store.rag;
  form.value = {
    url: rag?.baseURL || "",
    collection: rag?.collection || "default",
    topk: String(rag?.topK ?? 5),
    key: "",
  };
  keyVisible.value = false;
  keyStateText.value = rag?.hasKey
    ? `已保存 ${rag.apiKeyMasked || ""}，留空则不修改`
    : (rag?.configured ? "未保存 Key（服务无鉴权可不填）" : "");
  keyStateOk.value = Boolean(rag?.hasKey);
  setKbStatus(rag?.configured ? "" : "尚未配置外部 RAG 服务", rag?.configured ? "" : "err");
  void store.loadRoots();
  void store.load();
  requestAnimationFrame(() => document.getElementById("kb-url")?.focus());
});

function toggleKeyVisible(): void {
  keyVisible.value = !keyVisible.value;
  const input = document.getElementById("kb-key") as HTMLInputElement | null;
  if (input) input.type = keyVisible.value ? "text" : "password";
  const button = document.getElementById("kb-key-toggle");
  if (button) {
    button.setAttribute("aria-label", keyVisible.value ? "隐藏 API Key" : "显示或隐藏 API Key");
    button.querySelector("i.ui-icon")?.setAttribute("data-icon", keyVisible.value ? "EyeOff" : "Eye");
  }
}

async function saveConfig(): Promise<void> {
  const baseURL = form.value.url.trim();
  const apiKeyRaw = form.value.key.trim();
  if (!baseURL) { setKbStatus("✗ 服务地址不能为空", "err"); return; }
  const body: Record<string, unknown> = {
    baseURL,
    collection: form.value.collection.trim() || "default",
    topK: form.value.topk || undefined,
  };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已存 Key
  saving.value = true;
  try {
    await store.saveConfig(body);
    refreshPluginCards();
    const rag = store.rag;
    keyStateText.value = rag?.hasKey ? `已保存 ${rag.apiKeyMasked || ""}，留空则不修改` : keyStateText.value;
    keyStateOk.value = Boolean(rag?.hasKey);
    setKbStatus(`✓ 配置已保存（集合 ${rag?.collection}）`, "ok");
  } catch (err) {
    setKbStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    saving.value = false;
  }
}

async function testConn(): Promise<void> {
  const baseURL = form.value.url.trim();
  const apiKeyRaw = form.value.key.trim();
  if (!baseURL) { setKbStatus("✗ 请先填写服务地址", "err"); return; }
  const body: Record<string, unknown> = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  testing.value = true;
  setKbStatus("正在连接 RAG 服务…", "");
  try {
    const { api } = await import("../core/api.js");
    const res = await api<{ ok: boolean; status?: number; error?: string }>("/api/rag/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setKbStatus(
      res.ok ? `✓ 服务可达（HTTP ${res.status}）—— 真实检索效果以入库后测试为准` : `✗ ${res.error}`,
      res.ok ? "ok" : "err",
    );
  } catch (err) {
    setKbStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    testing.value = false;
  }
}

async function ingestFolder(): Promise<void> {
  if (!store.rag?.configured) { setKbStatus("✗ 请先保存外部 RAG 服务配置", "err"); return; }
  ingesting.value = true;
  try {
    const s = await store.ingest((document.getElementById("kb-root") as HTMLSelectElement | null)?.value || "");
    setKbStatus(`✓ 已入库 ${s.ingested ?? "?"} 个文本文件${s.chunks != null ? `，外部服务返回 ${s.chunks} 个切块` : ""}`, "ok");
  } catch (err) {
    setKbStatus(`✗ ${(err as Error).message}`, "err");
    void uiAlert(`入库失败：${(err as Error).message}\n\n检查：① RAG 服务是否实现 /ingest；② 选择的文件夹是否包含文本文件`, "知识库入库");
  } finally {
    ingesting.value = false;
  }
}

async function pasteText(): Promise<void> {
  const text = await uiPrompt("粘贴要入库的文本（切块与 embedding 由外部 RAG 服务完成）：", {
    title: "知识库 · 文本入库",
    placeholder: "任意说明文档 / 会议纪要 / 规范片段…",
  });
  if (typeof text !== "string" || !text.trim()) return;
  try {
    await store.ingestText(
      `手动文本 ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
      text,
    );
    setKbStatus("✓ 文本已入库", "ok");
  } catch (err) {
    setKbStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function removeDoc(id: string): Promise<void> {
  try {
    await store.removeDoc(id);
  } catch (err) {
    void uiAlert(`移除失败：${(err as Error).message}`, "知识库文档");
  }
}

async function searchTest(): Promise<void> {
  const q = (document.getElementById("kb-query") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!q) { setKbStatus("✗ 请输入检索词", "err"); return; }
  store.hitsState = "loading";
  try {
    const count = await store.search(q);
    setKbStatus(`✓ 命中 ${count} 条`, "ok");
  } catch (err) {
    store.hitsState = "empty";
    store.hits = [];
    setKbStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function clearAll(): Promise<void> {
  const ok = await uiConfirm("清空集合会调用外部 RAG 服务的 /reset，并清空本地登记。\n确定继续？", {
    title: "清空知识库集合", okText: "清空", danger: true,
  });
  if (!ok) return;
  try {
    await store.clear();
    setKbStatus("✓ 集合已清空", "ok");
  } catch (err) {
    setKbStatus(`✗ ${(err as Error).message}`, "err");
  }
}

function close(): void {
  store.kbOpen = false;
}
</script>

<template>
  <div id="kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-title">
    <h2 id="kb-title"><i class="ui-icon" data-icon="BookOpen" aria-hidden="true"></i> 知识库（外部 RAG）</h2>
    <p class="settings-sub">向量存储 / 切块 / embedding 全部由外部 RAG 服务完成，agentatlas 按通用 HTTP 契约调用 ingest / search</p>

    <div class="field-label">RAG 服务配置</div>
    <label class="field">
      <span class="field-label">服务地址（实现 ingest / search 契约）</span>
      <input id="kb-url" v-model="form.url" type="text" spellcheck="false" placeholder="http://127.0.0.1:8000" />
    </label>
    <label class="field">
      <span class="field-label">API Key <em id="kb-key-state" class="key-state" :class="{ ok: keyStateOk }">{{ keyStateText }}</em></span>
      <div class="key-row">
        <input id="kb-key" v-model="form.key" type="password" spellcheck="false" placeholder="留空 = 保持不变 / 服务无鉴权" />
        <button id="kb-key-toggle" type="button" class="ghost-btn small" title="显示/隐藏" aria-label="显示或隐藏 API Key" @click="toggleKeyVisible">
          <i class="ui-icon" data-icon="Eye" aria-hidden="true"></i>
        </button>
      </div>
    </label>
    <div class="kb-row2">
      <label class="field">
        <span class="field-label">集合 collection</span>
        <input id="kb-collection" v-model="form.collection" type="text" spellcheck="false" placeholder="default" />
      </label>
      <label class="field">
        <span class="field-label">检索条数 topK（1-20）</span>
        <input id="kb-topk" v-model="form.topk" type="number" min="1" max="20" step="1" placeholder="5" />
      </label>
    </div>
    <div class="kb-actions">
      <button id="kb-save" class="btn btn-approve" :disabled="saving" @click="saveConfig">保存配置</button>
      <button id="kb-test" class="ghost-btn" :disabled="testing" @click="testConn">测试连接</button>
      <span id="kb-status" class="settings-status"></span>
    </div>

    <div class="field-label ext-head"><i class="ui-icon" data-icon="Download" aria-hidden="true"></i> 文档入库 <em class="key-state">扫描授权文件夹内的文本文件（跳过 node_modules / .git / 密钥 / 锁文件）</em></div>
    <div class="fs-toolbar kb-toolbar">
      <select id="kb-root" class="fs-root-select" title="选择入库位置">
        <option v-for="root in store.roots" :key="root.path" :value="root.path">{{ root.type === "cloud" ? "☁️" : "💻" }} {{ root.name }}</option>
      </select>
      <button id="kb-ingest" class="ghost-btn small" :disabled="ingesting" @click="ingestFolder">
        <i class="ui-icon" data-icon="Download" aria-hidden="true"></i> {{ ingesting ? "⏳ 扫描入库中…（最长 90s）" : "全量入库" }}
      </button>
      <button id="kb-paste" class="ghost-btn small" style="min-width: 60px;" @click="pasteText">
        <i class="ui-icon" data-icon="Pencil" aria-hidden="true"></i> 粘贴文本
      </button>
    </div>

    <div class="field-label">已入库文档（本地登记，真实索引在外部服务）</div>
    <div id="kb-docs" class="fs-list kb-docs-list">
      <div v-if="!store.docs.length" class="fs-empty">还没有入库记录 —— 选择位置点「⬇ 全量入库」，或「✎ 粘贴文本」</div>
      <template v-else>
        <div
          v-for="d in store.docs"
          :key="d.id"
          class="fs-row kb-doc"
          :title="d.source || d.name"
        >
          <span class="f-icon">📄</span>
          <span class="f-name">{{ d.name }}</span>
          <span class="f-size">{{ (d.bytes / 1000).toFixed(1) }}k 字 · {{ new Date(d.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) }} · {{ d.source || "" }}</span>
          <button class="pm-x kb-doc-del" title="从登记移除（并尝试删除外部对应文档）" @click.stop="removeDoc(d.id)">✕</button>
        </div>
      </template>
    </div>

    <div class="field-label ext-head"><i class="ui-icon" data-icon="Search" aria-hidden="true"></i> 检索测试</div>
    <div class="kb-search-row">
      <input id="kb-query" aria-label="知识库检索问题" type="text" spellcheck="false" placeholder="输入检索词，Enter 或点击按钮（会话里由 retrieve_docs 工具自动调用）" @keydown.enter.prevent="searchTest" />
      <button id="kb-search-btn" class="btn btn-approve" @click="searchTest">检索</button>
    </div>
    <div id="kb-hits" class="kb-hits">
      <div v-if="store.hitsState === 'loading'" class="fs-empty">检索中…</div>
      <div v-else-if="store.hitsState === 'done' && !store.hits.length" class="fs-empty">没有命中 —— 确认相关文档已入库</div>
      <template v-else-if="store.hitsState === 'done'">
        <div v-for="(hit, index) in store.hits" :key="index" class="rag-hit">
          <div class="rag-hit-head">
            <span class="rag-hit-name">{{ hit.name || "未命名片段" }}</span>
            <span class="rag-hit-src">{{ hit.source || "" }}</span>
            <span class="rag-hit-score">score {{ typeof hit.score === "number" ? hit.score.toFixed(3) : String(hit.score ?? "–") }}</span>
          </div>
          <div class="rag-hit-text">{{ hit.text || "（无文本内容）" }}</div>
        </div>
      </template>
    </div>

    <div class="kb-footer-actions">
      <button id="kb-clear" class="ghost-btn" title="调用外部服务的 /reset 清空集合，并清掉本地登记" @click="clearAll">
        <i class="ui-icon" data-icon="Trash2" aria-hidden="true"></i> 清空集合
      </button>
      <span class="spacer"></span>
      <button id="kb-close" class="ghost-btn" @click="close">关闭</button>
    </div>
    <p class="settings-note">契约：POST <code>{RAG_URL}/ingest</code>（{collection, documents}）、<code>/search</code>（{query, topK} → {hits:[{text, score, name?}]}）、<code>/reset</code>；鉴权头 <code>Authorization: Bearer</code>。聊天中通用 Agent 会自动调用 <code>retrieve_docs</code> 工具检索。</p>
  </div>
</template>
