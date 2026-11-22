<!--
  job-panel-vue.vue — 求职数据源弹窗（框架迁移 M4 批次 4.4）
  ============================================================
  职责：环境检查 / 数据目录 / 平台登录 / 自检诊断。DOM 契约与静态版逐 id
  一致（job-*，html-compose 守门断言 job-fix-hint 依赖此锚点）。
  立场：面板只管理浏览器、数据目录和平台登录；采集流程由求职 Agent 内部执行。
-->
<script setup lang="ts">
import { Input } from "antdv-next";
import AntdvProvider from "../../ui/antdv-provider.vue";
import { computed, onMounted, onUnmounted, watch } from "vue";
import { JOB_PLATFORMS, useJobStore } from "../../stores/job.js";
import { registerJobOpenHook, registerJobCloseHook } from "./job.js";

const store = useJobStore();

const status = computed(() => store.job);
const browserLine = computed(() => {
  const s = status.value;
  if (!s) return { label: "浏览器", value: "探测中…", kind: "" };
  return {
    label: "浏览器",
    value: s.browserOK ? `可用 · ${s.browserName}` : (s.browserError || "未找到 Chrome / Edge"),
    kind: s.browserOK ? "ok" : "err",
  };
});
const profileLine = computed(() => {
  const s = status.value;
  if (!s) return { value: "—" };
  return { value: s.profilePresent ? "已初始化（是否登录以采集结果为准）" : "首次登录时初始化" };
});
const lastRunLine = computed(() => {
  const s = status.value;
  if (!s) return { value: "—", kind: "" };
  return {
    value: s.lastRunJobs ? `${s.lastRunJobs} 条${s.lastRunAt ? ` · ${s.lastRunAt}` : ""}` : "还没有采集记录",
    kind: s.lastRunJobs ? "ok" : "",
  };
});

const fixHintText = computed(() => {
  const s = status.value;
  if (!s) return "";
  if (!s.browserOK) return s.browserError || "请安装 Chrome / Edge，或设置 BROWSER_USE_EXECUTABLE_PATH。";
  if (s.lastRunJobs === 0) return "首次使用请先登录 BOSS直聘；未登录时列表页通常会被安全校验拦截。";
  return "";
});
const fixHintVisible = computed(() => Boolean(status.value) && fixHintText.value !== "");

/** 弹窗打开时探测环境（watch jobOpen）。 */
watch(() => store.jobOpen, async (open) => {
  document.getElementById("job-mask")?.classList.toggle("hidden", !open);
  document.body.classList.toggle("job-open", open);
  if (!open) return;
  store.setStatus("正在探测环境…");
  try {
    await store.load();
    store.setStatus("");
  } catch (err) {
    store.setStatus(`✗ ${(err as Error).message}`, "err");
  }
  requestAnimationFrame(() => document.getElementById("job-data-dir")?.focus());
});

async function save(): Promise<void> {
  store.setStatus("正在保存并重新探测…");
  try {
    await store.save();
    store.setStatus("✓ 已保存，下一条消息生效", "ok");
  } catch (err) {
    store.setStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function login(platform: { id: string; label: string }): Promise<void> {
  store.setStatus(`正在打开 ${platform.label} 登录页：请在浏览器里扫码，最长等待 5 分钟…`);
  try {
    const result = await store.login(platform.id);
    store.setStatus(result.summary, result.ok ? "ok" : "err");
  } catch (err) {
    store.setStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function runDoctor(): Promise<void> {
  store.setStatus("正在自检…");
  try {
    const result = await store.doctor();
    store.setStatus(result.ok ? "✓ 自检通过" : "自检发现问题，详见下方输出", result.ok ? "ok" : "err");
  } catch (err) {
    store.setStatus(`✗ ${(err as Error).message}`, "err");
  }
}

async function diagnose(apply: boolean): Promise<void> {
  store.setStatus(
    apply
      ? "正在逐平台诊断；只会固化本次在真实页面验证通过的候选，可能需要几分钟…"
      : "正在逐平台检查页面结构与字段命中率，可能需要几分钟…",
  );
  try {
    const result = await store.diagnose(apply);
    store.setStatus(result.ok ? `✓ ${result.summary}` : `诊断发现异常：${result.summary}`, result.ok ? "ok" : "err");
  } catch (err) {
    store.setStatus(`✗ ${(err as Error).message}`, "err");
  }
}

function close(): void {
  store.jobOpen = false;
}

function onMaskClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) close();
}

function onEsc(event: KeyboardEvent): void {
  if (event.key === "Escape" && store.jobOpen) {
    event.preventDefault();
    close();
  }
}

onMounted(() => {
  document.addEventListener("keydown", onEsc);
  // 遮罩点击空白关闭（mount 容器在组件模板之外，原生挂监听）
  document.getElementById("job-mask")?.addEventListener("click", onMaskClick);
});
onUnmounted(() => {
  document.removeEventListener("keydown", onEsc);
  registerJobOpenHook(null);
  registerJobCloseHook(null);
});
// 壳级 Esc 分流（main.ts）依赖弹窗开关状态与外部关闭
onMounted(() => {
  registerJobOpenHook(() => store.jobOpen);
  registerJobCloseHook(close);
});
</script>

<template>
  <AntdvProvider>
  <div id="job-modal" role="dialog" aria-modal="true" aria-labelledby="job-title">
    <h2 id="job-title"><i class="ui-icon" data-icon="Briefcase" aria-hidden="true"></i> 求职 Agent（内置采集）</h2>
    <p class="settings-sub">采集流程已经内化到求职 Agent：内置驱动 Chrome / Edge 访问 BOSS直聘、智联招聘、前程无忧与猎聘，完成搜索、打分、外包识别、清单合并和 Excel / HTML 交付，不需要安装外部 Skill 或 Python。</p>

    <div class="field-label">环境检查</div>
    <div id="job-check-list" class="job-check-list" role="status" aria-live="polite">
      <div class="job-check-row">
        <span class="job-check-label">{{ browserLine.label }}</span>
        <span class="job-check-value" :class="browserLine.kind">{{ browserLine.value }}</span>
      </div>
      <div class="job-check-row">
        <span class="job-check-label">内置执行流程</span>
        <span class="job-check-value ok">BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘（无需 Python / Skill）</span>
      </div>
      <div class="job-check-row">
        <span class="job-check-label">数据目录</span>
        <span class="job-check-value">{{ status?.dataDir || "—" }}</span>
      </div>
      <div class="job-check-row">
        <span class="job-check-label">浏览器 Profile</span>
        <span class="job-check-value">{{ profileLine.value }}</span>
      </div>
      <div class="job-check-row">
        <span class="job-check-label">最近清单</span>
        <span class="job-check-value" :class="lastRunLine.kind">{{ lastRunLine.value }}</span>
      </div>
    </div>
    <div id="job-fix-hint" class="job-fix-hint" :class="{ hidden: !fixHintVisible }" role="alert">
      <span>{{ fixHintText }}</span>
    </div>

    <div class="field-label">数据目录 <em class="key-state">留空使用应用默认目录</em></div>
    <label class="field">
      <span class="field-label">登录态、岗位清单与 Excel 产出</span>
      <Input id="job-data-dir" v-model:value="store.dataDirInput" type="text" spellcheck="false" placeholder="留空使用 .setting/job-data" />
    </label>
    <div class="kb-actions">
      <button id="job-save-btn" class="btn btn-approve" :disabled="store.saving" @click="save">保存并重新探测</button>
      <button id="job-doctor-btn" class="ghost-btn" :disabled="store.doctorRunning" @click="runDoctor">运行自检</button>
      <button id="job-diagnose-btn" class="ghost-btn" title="检查四个平台的页面结构，不写入选择器" :disabled="Boolean(store.diagnosing)" @click="diagnose(false)">
        {{ store.diagnosing === "plain" ? "正在诊断…" : "结构诊断" }}
      </button>
      <button id="job-diagnose-apply-btn" class="ghost-btn" title="诊断后仅固化本次真实验证通过的候选选择器" :disabled="Boolean(store.diagnosing)" @click="diagnose(true)">
        {{ store.diagnosing === "apply" ? "正在诊断并修复…" : "诊断并修复" }}
      </button>
      <span id="job-status" class="settings-status" :class="store.statusKind" role="status" aria-live="polite">{{ store.statusText }}</span>
    </div>
    <pre id="job-doctor-output" class="job-doctor-output">{{ store.doctorOutput }}</pre>

    <div class="field-label ext-head">平台登录 <em class="key-state">BOSS直聘必须登录，其余建议登录</em></div>
    <p class="settings-note" style="margin-top:0;">
      点按钮会拉起独立浏览器打开对应平台登录页，请扫码。登录态保存在数据目录的 <code>.profile/</code>，
      之后内置采集流程会复用，不用重复登录。采集时会出现独立浏览器窗口，遇到站点安全验证可在窗口中完成；未登录时 BOSS直聘列表页通常会被拦截。
    </p>
    <div id="job-platforms" class="job-platforms">
      <button
        v-for="platform in JOB_PLATFORMS"
        :key="platform.id"
        type="button"
        class="ui-button job-login-btn"
        :aria-label="`登录 ${platform.label}`"
        :disabled="store.loggingInPlatform === platform.id"
        @click="login(platform)"
      >
        <i class="ui-icon" data-icon="ExternalLink" aria-hidden="true" style="--icon-size: 13px"></i>
        {{ store.loggingInPlatform === platform.id ? `${platform.label} 等待扫码…` : `登录 ${platform.label}` }}
      </button>
    </div>

    <div class="kb-footer-actions">
      <span class="spacer"></span>
      <button id="job-close" class="ghost-btn" @click="close">关闭</button>
    </div>
    <p class="settings-note">会话里 Agent 会调用 <code>job_collect（人工审批）/ job_query / job_enrich（人工审批）/ job_summary / job_diagnose（人工审批）</code>；执行流程、评分规则、选择器自愈和平台适配均在应用内，Excel / HTML 交付物写入数据目录的 <code>out/</code>。</p>
  </div>
  </AntdvProvider>
</template>
