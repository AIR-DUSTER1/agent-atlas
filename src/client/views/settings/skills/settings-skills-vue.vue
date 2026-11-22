<!--
  settings-skills-vue.vue — 技能面板（框架迁移 M4 批次 4.2）
  ============================================================
  职责：搜索、筛选、分页、上传、启停与删除技能；DOM 契约与 h() 版一致
  （skills-* / skill-* id、.skill-card 结构、aria-label 文案、分页 aria）。
  立场：
  - 技能新建/修改统一走 skill-creator，页面不做手写 frontmatter 表单；
  - 上传走 filechooser（#skill-upload-btn 触发隐藏 file input）；
  - 启停开关是 antdv Switch（受控组件）：状态只看 store，失败时不会残留在半途状态。
-->
<script setup lang="ts">
import { Button, Input, Switch, Upload } from "antdv-next";
import { computed, onMounted, ref } from "vue";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { useSkillsStore, type SkillFilter, type SkillItem } from "../../../stores/settings/skills/skills.js";
import { showSkillStatus } from "./settings-skills.js";
import { uiConfirm } from "../../../ui/dialog.js";

const MAX_SKILL_FILE_BYTES = 200_000;
const SKILLS_PER_PAGE = 5;

const store = useSkillsStore();
const searchQuery = ref("");
const currentFilter = ref<SkillFilter>("all");
const currentPage = ref(1);
const refreshing = ref(false);
const togglingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);

// 进入分区时拉取技能目录（与 h() 版 refreshSkills 同语义）
onMounted(() => { void refresh(); });

const counts = computed(() => {
  const enabled = store.skills.filter((skill) => skill.enabled).length;
  return { all: store.skills.length, enabled, disabled: store.skills.length - enabled };
});

const filteredSkills = computed(() => {
  const term = searchQuery.value.trim().toLowerCase();
  return store.skills
    .filter((skill) => currentFilter.value === "all"
      || (currentFilter.value === "enabled" ? skill.enabled : !skill.enabled))
    .filter((skill) => !term || [skill.id, skill.name, skill.description, ...skill.triggers]
      .some((value) => value.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "zh-CN"));
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredSkills.value.length / SKILLS_PER_PAGE)));
const pageItems = computed(() => {
  const start = (currentPage.value - 1) * SKILLS_PER_PAGE;
  return filteredSkills.value.slice(start, start + SKILLS_PER_PAGE);
});
const summaryText = computed(() => filteredSkills.value.length === store.skills.length
  ? `共 ${store.skills.length} 个技能`
  : `共 ${store.skills.length} 个技能 · 当前显示 ${filteredSkills.value.length} 个`);
const emptyFiltered = computed(() => Boolean(searchQuery.value.trim()) || currentFilter.value !== "all");

/** 分页 token：1 / 末页 / 当前±1，间隙用省略号（与 h() 版一致）。 */
const paginationTokens = computed<Array<number | "ellipsis">>(() => {
  const pages = new Set([1, totalPages.value, currentPage.value - 1, currentPage.value, currentPage.value + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= totalPages.value).sort((a, b) => a - b);
  const tokens: Array<number | "ellipsis"> = [];
  for (const page of sorted) {
    const previous = tokens.at(-1);
    if (typeof previous === "number" && page - previous > 1) tokens.push("ellipsis");
    tokens.push(page);
  }
  return tokens;
});

function setFilter(filter: string): void {
  if (filter !== "all" && filter !== "enabled" && filter !== "disabled") return;
  currentFilter.value = filter;
  currentPage.value = 1;
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await store.refresh();
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    refreshing.value = false;
  }
}

async function toggleEnabled(skill: SkillItem, next: boolean): Promise<void> {
  togglingId.value = skill.id;
  try {
    await store.setEnabled(skill.id, next);
    showSkillStatus(`${next ? "已启用" : "已禁用"}技能「${skill.name}」`, "ok");
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    togglingId.value = null;
  }
}

async function removeSkill(skill: SkillItem): Promise<void> {
  const target = skill.path || `.setting/skills/${skill.id}/SKILL.md`;
  const ok = await uiConfirm(`删除技能「${skill.name}」？这会删掉 ${target}`, {
    title: "删除技能", okText: "删除", danger: true,
  });
  if (!ok) return;
  deletingId.value = skill.id;
  try {
    await store.remove(skill.id);
    showSkillStatus(`已删除技能「${skill.name}」`, "ok");
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  } finally {
    deletingId.value = null;
  }
}

function skillDescription(skill: SkillItem): string {
  return skill.description || skill.body.slice(0, 180).replace(/\n/g, " ");
}

function skillMeta(skill: SkillItem): string {
  const triggerText = skill.triggers.length ? `触发：${skill.triggers.join("、")}` : "名称触发";
  return `${skill.enabled ? "已启用" : "已禁用"} · ${triggerText} · ${skill.body.length} 字符`;
}

let pendingUploads: Array<{ name: string; content: string }> = [];
/** Upload 包裹容器（用于点开系统文件选择框）。 */
const uploadHost = ref<HTMLElement | null>(null);

/** 点上传按钮 → 打开系统文件选择框（Upload 渲染的真实 input[type=file]）。 */
/**
 * 点上传按钮 → 打开系统文件选择框。
 * ⚠ antdv Upload 不把 id/class 透传到根元素或内部 input，所以不能用
 * getElementById；改从包裹容器的模板 ref 里找真实 input[type=file]。
 */
function triggerSkillUpload(): void {
  uploadHost.value?.querySelector<HTMLInputElement>('input[type="file"]')?.click();
}

/**
 * antdv Upload 的 beforeUpload：返回 false 表示「不上传」，只做本地读取。
 * multiple 模式下每个文件调用一次，用微任务把同批文件攒起来统一处理。
 */
function beforeSkillUpload(file: File): boolean {
  if (file.size > MAX_SKILL_FILE_BYTES) {
    showSkillStatus(`✗ 「${file.name}」超过 200KB`, "err");
    return false;
  }
  void file.text().then((content) => {
    pendingUploads.push({ name: file.name, content });
    // 同一批选中的文件会在同一轮事件循环内到达，nextTick 后统一提交
    void Promise.resolve().then(() => {
      if (!pendingUploads.length) return;
      const batch = pendingUploads;
      pendingUploads = [];
      void importFiles(batch);
    });
  });
  return false;
}

function uploadId(filename: string): string {
  const base = filename.replaceAll("\\", "/").split("/").pop() || filename;
  return base.replace(/\.(md|markdown)$/i, "").toLowerCase();
}

/**
 * 处理选中的技能文件；同名技能覆盖前确认一次。
 * 改接 antdv Upload：文件由 beforeUpload 逐个交过来（返回 false 阻止真实上传），
 * 这里只收已读好的 payload，不再从 DOM 读 input.files。
 */
async function importFiles(payloads: Array<{ name: string; content: string }>): Promise<void> {
  try {
    if (!payloads.length) return;
    const incomingIds = new Set(payloads.map((file) => uploadId(file.name)));
    const conflicts = store.skills.filter((skill) => incomingIds.has(skill.id.toLowerCase()));
    const overwrite = conflicts.length
      ? await uiConfirm(`以下技能已存在，是否覆盖？\n${conflicts.map((skill) => skill.name).join("、")}`, {
          title: "覆盖已有技能", okText: "覆盖", danger: true,
        })
      : false;
    if (conflicts.length && !overwrite) {
      showSkillStatus("已取消覆盖，现有技能未修改", "");
      return;
    }
    const { imported, overwritten } = await store.importFiles(payloads, overwrite);
    currentFilter.value = "all";
    searchQuery.value = "";
    currentPage.value = 1;
    showSkillStatus(`✓ 已导入 ${imported} 个，覆盖 ${overwritten} 个`, "ok");
  } catch (err) {
    showSkillStatus(`✗ ${(err as Error).message}`, "err");
  }
}
</script>

<template>
  <AntdvProvider>
  <div class="skills-page-head">
    <h2 id="skills-title">技能</h2>
    <Button id="skills-refresh-btn" class="skills-icon-btn" aria-label="刷新技能列表" title="刷新技能列表" :disabled="refreshing" @click="refresh">
      <i class="ui-icon" data-icon="RefreshCw" aria-hidden="true"></i>
    </Button>
  </div>

  <label class="skills-search-box">
    <i class="ui-icon" data-icon="Search" aria-hidden="true"></i>
    <Input id="skills-search" v-model:value="searchQuery" type="search" aria-label="搜索技能" placeholder="搜索技能" autocomplete="off" @input="currentPage = 1" />
  </label>

  <section class="skills-overview-card" aria-labelledby="skills-overview-title">
    <div class="skills-overview-copy">
      <h3 id="skills-overview-title">技能</h3>
      <p>技能是一组基于上下文触发的指令集，用于稳定执行专业任务。启用后仅在消息命中触发词或技能名称时载入，每轮最多 2 个。</p>
    </div>
    <div class="skills-overview-actions">
      <Button id="skill-upload-btn" class="ghost-btn small skills-primary-btn" @click="triggerSkillUpload">
        <i class="ui-icon" data-icon="Upload" aria-hidden="true"></i> 上传技能
      </Button>
    </div>
  </section>
  <!-- antdv Upload 不透传 class：外层 div 承载 hidden，同时作为触发作用域 -->
  <div ref="uploadHost" class="hidden">
    <Upload
      id="skill-upload-file"
      accept=".md,.markdown,text/markdown"
      multiple
      :show-upload-list="false"
      :before-upload="beforeSkillUpload"
      aria-label="选择技能文件"
    />
  </div>
  <div id="skills-status" class="settings-status" role="status" aria-live="polite"></div>

  <div class="skills-list-toolbar">
    <div class="skills-filter-tabs" role="tablist" aria-label="技能状态筛选">
      <Button v-for="tab in (['all', 'enabled', 'disabled'] as const)" :key="tab" class="skills-filter-tab" :class="{ active: currentFilter === tab }" :data-skill-filter="tab" role="tab" :aria-selected="String(currentFilter === tab)" @click="setFilter(tab)">
        {{ tab === "all" ? "全部" : tab === "enabled" ? "已启用" : "已禁用" }}
        <span :id="`skills-count-${tab}`">{{ counts[tab] }}</span>
      </Button>
    </div>
    <div class="skills-list-summary">
      <span id="skills-count">{{ summaryText }}</span>
      <span id="skills-dir" class="skills-dir" :title="store.dir">{{ store.dir ? `目录 ${store.dir}` : "" }}</span>
    </div>
  </div>

  <div id="skills-list" class="skills-list">
    <div v-if="!pageItems.length" class="skills-empty-state">
      <i class="ui-icon" :data-icon="emptyFiltered ? 'Search' : 'BookOpen'" aria-hidden="true"></i>
      <h3>{{ emptyFiltered ? "没有匹配的技能" : "还没有技能" }}</h3>
      <p>{{ emptyFiltered
        ? "调整搜索词或切换到「全部」查看其他技能。"
        : "上传现成技能；新建技能请在 Codex 中使用 $skill-creator 完成。" }}</p>
    </div>
    <template v-else>
      <article
        v-for="skill in pageItems"
        :key="skill.id"
        class="skill-card"
        :class="{ disabled: !skill.enabled }"
        :data-skill-id="skill.id"
      >
      <div class="skill-card-icon"><i class="ui-icon" data-icon="BookOpen" aria-hidden="true"></i></div>
      <div class="skill-card-body">
        <div class="skill-card-title-row">
          <h3 class="skill-card-name">{{ skill.name }}</h3>
          <span class="skill-card-kind">Markdown</span>
        </div>
        <p class="skill-card-desc">{{ skillDescription(skill) }}</p>
        <div class="skill-card-meta">{{ skillMeta(skill) }}</div>
      </div>
      <div class="skill-card-actions">
        <Switch
          class="skill-enabled-toggle"
          :aria-label="`启用技能 ${skill.name}`"
          :checked="skill.enabled"
          :disabled="togglingId === skill.id"
          :loading="togglingId === skill.id"
          @update:checked="(next: boolean) => toggleEnabled(skill, next)"
        />
        <Button class="skill-delete-btn" title="删除技能" :aria-label="`删除技能 ${skill.name}`" :disabled="deletingId === skill.id" @click="removeSkill(skill)">
          <i class="ui-icon" data-icon="Trash2" aria-hidden="true"></i>
        </Button>
      </div>
      </article>
    </template>
  </div>
  <nav id="skills-pagination" class="skills-pagination" :class="{ hidden: totalPages <= 1 }" aria-label="技能分页">
    <template v-if="totalPages > 1">
      <Button class="skills-page-btn" :disabled="currentPage <= 1" :aria-label="`第 ${currentPage - 1} 页`" @click="currentPage--">‹</Button>
      <template v-for="(token, index) in paginationTokens" :key="`${token}-${index}`">
        <span v-if="token === 'ellipsis'" class="skills-page-ellipsis">…</span>
        <Button v-else class="skills-page-btn" :class="{ active: token === currentPage }" :aria-label="`第 ${token} 页`" :aria-current="token === currentPage ? 'page' : undefined" @click="currentPage = token">{{ token }}</Button>
      </template>
      <Button class="skills-page-btn" :disabled="currentPage>= totalPages"
        :aria-label="`第 ${currentPage + 1} 页`"
        @click="currentPage++"
      >›</Button>
    </template>
  </nav>
  </AntdvProvider>
</template>
