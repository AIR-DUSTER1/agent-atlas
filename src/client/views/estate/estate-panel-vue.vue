<!--
  estate-panel-vue.vue — 房产数据源弹窗（框架迁移 M4 批次 4.4）
  ============================================================
  职责：贝壳 CLI 检测 / 安装 / 授权 Key 保存 / 官方登录页跳转。
  DOM 契约与静态版逐 id 一致（estate-*），主入口绑定与 e2e 依赖这些锚点。
  立场：Key 只写不读不落盘回显；外链过 safeHref 白名单。
-->
<script setup lang="ts">
import { Button, Input } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { computed, ref, watch } from "vue";
import { useEstateStore } from "../../stores/estate/estate.js";
import { setEstateStatus } from "./estate.js";
import { safeHref } from "../../modules/format.js";
import { refreshPluginCards } from "../settings/plugins/settings-plugins.js";

const store = useEstateStore();

const keyValue = ref("");
const keyVisible = ref(false);
const installing = ref(false);
const checkingLogin = ref(false);
const status1Text = ref("");
const status1Kind = ref("");
const status2Text = ref("");
const status2Color = ref("");

const st = computed(() => store.estate);
const keyHref = computed(() => safeHref(st.value.keyUrl || ""));

/** 打开弹窗时回填（watch estateOpen）。 */
watch(() => store.estateOpen, (open) => {
  document.getElementById("estate-mask")?.classList.toggle("hidden", !open);
  if (!open) return;
  keyValue.value = "";
  keyVisible.value = false;
  void store.load().then(() => renderPanel());
  requestAnimationFrame(() => document.getElementById("estate-check")?.focus());
});

function renderPanel(): void {
  const s = st.value;
  if (s.installed) {
    status1Text.value = `✓ 已安装贝壳 CLI${s.version ? " " + s.version : ""}${s.viaPATH ? "（来自系统 PATH）" : s.path ? "：" + s.path : ""}`;
    status1Kind.value = "ok";
  } else {
    status1Text.value = s.error ? `✗ ${s.error}` : "未检测到贝壳 CLI：点下方按钮下载当前平台的官方二进制（约 32MB）";
    status1Kind.value = "err";
  }
  status2Text.value = s.loginRequired
    ? "登录已失效：打开官方登录页，重新获取并保存 Key 后才能继续找房"
    : s.installed ? "CLI 就绪后即可登录并保存 Key 开始找房" : "请先安装 CLI";
  status2Color.value = s.installed && !s.loginRequired ? "" : "var(--amber)";
}

async function reload(): Promise<void> {
  await store.load();
  renderPanel();
}

async function install(): Promise<void> {
  installing.value = true;
  status2Text.value = "正在下载安装（约 30MB，视网络可能需要 1-2 分钟）…";
  status2Color.value = "var(--amber)";
  try {
    await store.install();
    refreshPluginCards();
    renderPanel();
  } catch (err) {
    setEstateStatus(`✗ 安装失败：${(err as Error).message}`, "err");
    status2Text.value = "安装失败，请检查安装目录写入权限，或设置 BEIKE_CLI_PATH 指向已安装的官方二进制";
    status2Color.value = "var(--red)";
  } finally {
    installing.value = false;
  }
}

function toggleKeyVisible(): void {
  keyVisible.value = !keyVisible.value;
  const input = document.getElementById("estate-key") as HTMLInputElement | null;
  if (input) input.type = keyVisible.value ? "text" : "password";
  const button = document.getElementById("estate-key-toggle");
  if (button) {
    button.setAttribute("aria-label", keyVisible.value ? "隐藏授权 Key" : "显示或隐藏授权 Key");
    button.querySelector("i.ui-icon")?.setAttribute("data-icon", keyVisible.value ? "EyeOff" : "Eye");
  }
}

async function pasteKeyFromClipboard(): Promise<void> {
  if (!navigator.clipboard?.readText) {
    status2Text.value = "✗ 当前环境不允许读取剪贴板，请手动粘贴完整 Key";
    status2Color.value = "var(--red)";
    return;
  }
  checkingLogin.value = true;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      status2Text.value = "✗ 剪贴板为空：请先在官方页面点击 Key 右侧的「复制」";
      status2Color.value = "var(--red)";
      return;
    }
    keyValue.value = text;
    await saveKey();
  } catch (err) {
    status2Text.value = `✗ 无法读取剪贴板：${(err as Error).message}；请手动粘贴完整 Key`;
    status2Color.value = "var(--red)";
  } finally {
    checkingLogin.value = false;
  }
}

async function saveKey(): Promise<void> {
  const value = keyValue.value.trim();
  if (!value) {
    status2Text.value = "✗ 请先粘贴贝壳 Key（building.ke.com 登录后显示）";
    status2Color.value = "var(--red)";
    return;
  }
  if (!st.value.installed) {
    status2Text.value = "✗ 请先安装 CLI 再保存 Key";
    status2Color.value = "var(--red)";
    return;
  }
  status2Text.value = "校验中…";
  status2Color.value = "";
  try {
    const res = await store.saveKey(value);
    status2Text.value = res.ok
      ? "✓ 校验通过，贝壳找房已可用（回到找房对话直接提需求）"
      : `✗ 校验未通过：${res.message || res.error || "未知错误"}`;
    status2Color.value = res.ok ? "" : "var(--red)";
    if (res.ok) keyValue.value = "";
  } catch (err) {
    status2Text.value = `✗ ${(err as Error).message}`;
    status2Color.value = "var(--red)";
  }
}

async function openLogin(): Promise<void> {
  checkingLogin.value = true;
  status2Text.value = "正在打开贝壳官方登录页…";
  status2Color.value = "var(--amber)";
  try {
    const result = await store.openLogin();
    status2Text.value = result.ok
      ? "✓ 登录页已在系统浏览器打开。请扫码，成功后点页面 Key 右侧的「复制」，再回到这里点「从剪贴板读取」"
      : `✗ ${result.message || result.error || "浏览器未能自动打开"}${result.url ? `；可手动访问：${result.url}` : ""}`;
    status2Color.value = result.ok ? "" : "var(--red)";
  } catch (err) {
    status2Text.value = `✗ 打开登录页失败：${(err as Error).message}`;
    status2Color.value = "var(--red)";
  } finally {
    checkingLogin.value = false;
  }
}

function close(): void {
  store.estateOpen = false;
}
</script>

<template>
  <AntdvProvider>
  <div id="estate-modal" role="dialog" aria-modal="true" aria-labelledby="estate-title">
    <h2 id="estate-title"><i class="ui-icon" data-icon="House" aria-hidden="true"></i> 房产数据源（贝壳官方 AI）</h2>
    <p class="settings-sub">房源检索 / 板块评测 / 户型图 / 行情来自贝壳官方 <code>beike</code> 命令行工具（本地子进程，无 npm 依赖）。首次使用：安装 CLI → 浏览器登录 → 保存页面显示的 Key</p>

    <div class="field-label">第一步 · 安装贝壳 CLI</div>
    <div id="estate-status" class="estate-status" :class="status1Kind">{{ status1Text || "探测中…" }}</div>
    <div class="kb-actions">
      <Button id="estate-check" class="ghost-btn" @click="reload">重新检测</Button>
      <Button id="estate-install" :disabled="installing" @click="install" type="primary">
        <i class="ui-icon" data-icon="Download" aria-hidden="true"></i> 安装 CLI（自动下载官方二进制）
      </Button>
    </div>
    <p class="settings-note">安装会按官方 manifest 选择当前平台的二进制并做 sha256 校验：Windows 为 <code>beike.exe</code>，Linux / macOS 为 <code>beike</code>。默认写入 <code>.setting/beike/</code>；容器使用持久化目录。也可通过 <code>BEIKE_CLI_PATH</code> 或系统 PATH 使用已授权版本。</p>

    <div class="field-label ext-head">第二步 · 保存授权 Key <em class="key-state">贝壳本地凭证，agentatlas 不落盘不回显</em></div>
    <p class="settings-note" style="margin-top:0;">
      1. 在浏览器登录贝壳账号：<a id="estate-key-link" :href="keyHref || 'https://building.ke.com/?action=get-key&source=workbuddy'" target="_blank" rel="noopener">building.ke.com · 获取 Key</a><br>
      2. 登录成功后点击页面里 Key 右侧的「复制」按钮（页面显示的是掩码，不要手动选中掩码文本）<br>
      3. 官方协议：<a href="https://m.ke.com/user/commonProtocol?id=beike_AI_open_Platform_private_protocol" target="_blank" rel="noopener">服务协议</a> · <a href="https://m.ke.com/user/commonProtocol?id=beike_agent_privacy_protocol" target="_blank" rel="noopener">隐私协议</a>
    </p>
    <label class="field">
      <span class="field-label">贝壳 Key（粘贴后保存）</span>
      <div class="key-row">
        <Input.Password id="estate-key" v-model:value="keyValue" spellcheck="false" placeholder="粘贴 building.ke.com 显示的完整凭证" @keydown.enter.prevent="saveKey" />
        <Button id="estate-key-toggle" class="ghost-btn small" title="显示/隐藏" aria-label="显示或隐藏授权 Key" @click="toggleKeyVisible">
          <i class="ui-icon" data-icon="Eye" aria-hidden="true"></i>
        </Button>
      </div>
    </label>
    <div class="kb-actions">
      <Button id="estate-login-open" class="ghost-btn" :disabled="checkingLogin" @click="openLogin">
        <i class="ui-icon" data-icon="ExternalLink" aria-hidden="true"></i> 打开官方登录页
      </Button>
      <Button id="estate-key-paste" class="ghost-btn" :disabled="checkingLogin" @click="pasteKeyFromClipboard">从剪贴板读取</Button>
      <Button id="estate-key-save" @click="saveKey" type="primary">保存 Key</Button>
      <span id="estate-status2" class="settings-status" :style="{ color: status2Color }">{{ status2Text }}</span>
    </div>
    <p class="settings-note">使用系统默认浏览器打开官方登录页，只打开一次；页面显示的是掩码，请点 Key 右侧的「复制」，再回到这里点「从剪贴板读取」并保存。不要在短时间内反复扫码或连续重试。</p>

    <div class="kb-footer-actions">
      <span class="spacer"></span>
      <Button id="estate-close" class="ghost-btn" @click="close">关闭</Button>
    </div>
    <p class="settings-note">会话里 Agent 自动调用 <code>house_search / house_map（对比区位地图）/ house_lookup（户型图）/ house_agents / house_appoint（人工审批）/ house_contact（人工审批）</code> 等工具；每轮会把用户原话上报给贝壳 <code>beike analyze</code>（官方契约，静默执行）。</p>
  </div>
  </AntdvProvider>
</template>
