<!--
  model-selection-picker.vue — 通用模型多选弹窗
  ============================================================
  职责：供应商模型管理和新增供应商的初始模型都复用同一套搜索、分组、
  全选/全不选、只看已选与批量应用交互。
  立场：
  - 勾选只改本地草稿，点“应用”后才提交，取消不会产生半成品；
  - 供应商返回的模型与已保存但本次未返回的模型分组展示；
  - 至少保留一个模型，避免生成无法使用的空供应商配置。
-->
<script setup lang="ts">
import { Button, Checkbox, Input } from "antdv-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AntdvProvider from "../../../ui/antdv-provider.vue";
import { fmtTokens } from "../../../modules/format.js";
import type { GatewayModel } from "../../../modules/types.js";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  models: GatewayModel[];
  extraModels?: GatewayModel[];
  selectedNames?: string[];
  applying?: boolean;
  modalId?: string;
  inputId?: string;
  listId?: string;
  description?: string;
}>(), {
  extraModels: () => [],
  selectedNames: () => [],
  applying: false,
  modalId: "model-selection-picker",
  inputId: "model-selection-search",
  listId: "model-selection-list",
  description: "勾选的模型会加入列表，取消勾选会从列表中移除。",
});

const emit = defineEmits<{
  cancel: [];
  apply: [models: GatewayModel[]];
}>();

const query = ref("");
const onlySelected = ref(false);
const draft = ref<string[]>([]);
const dialogEl = ref<HTMLElement | null>(null);

const titleId = computed(() => `${props.modalId}-title`);
const descriptionId = computed(() => `${props.modalId}-description`);

let previousFocus: HTMLElement | null = null;
let previousBodyOverflow = "";
let listening = false;
let sessionActive = false;

function requestCancel(): void {
  if (!props.applying) emit("cancel");
}

function focusableElements(): HTMLElement[] {
  const root = dialogEl.value;
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    requestCancel();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements();
  if (!focusable.length) {
    event.preventDefault();
    dialogEl.value?.focus();
    return;
  }
  const first = focusable[0] as HTMLElement;
  const last = focusable[focusable.length - 1] as HTMLElement;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogEl.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function startDialogSession(): void {
  if (sessionActive) return;
  sessionActive = true;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  if (!listening) {
    document.addEventListener("keydown", onDocumentKeydown);
    listening = true;
  }
}

function endDialogSession(): void {
  if (!sessionActive) return;
  sessionActive = false;
  if (listening) {
    document.removeEventListener("keydown", onDocumentKeydown);
    listening = false;
  }
  document.body.style.overflow = previousBodyOverflow;
  previousBodyOverflow = "";
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
}

watch(() => props.open, async (open) => {
  if (!open) {
    endDialogSession();
    return;
  }
  draft.value = [...new Set(props.selectedNames)];
  query.value = "";
  onlySelected.value = false;
  startDialogSession();
  await nextTick();
  document.getElementById(props.inputId)?.focus();
}, { immediate: true });

onBeforeUnmount(endDialogSession);

const returnedModels = computed(() => {
  const seen = new Set<string>();
  return props.models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
});
const allKnownModels = computed(() => {
  const map = new Map<string, GatewayModel>();
  for (const model of [...props.extraModels, ...props.models]) map.set(model.id, model);
  for (const name of draft.value) if (!map.has(name)) map.set(name, { id: name });
  return map;
});

const missingModels = computed(() => {
  const returnedIds = new Set(props.models.map((model) => model.id));
  const out: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const model of allKnownModels.value.values()) {
    if (returnedIds.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
});

const totalCount = computed(() => allKnownModels.value.size);
const selectedSet = computed(() => new Set(draft.value));

function matches(model: GatewayModel): boolean {
  const keyword = query.value.trim().toLowerCase();
  if (onlySelected.value && !selectedSet.value.has(model.id)) return false;
  return !keyword || model.id.toLowerCase().includes(keyword);
}

const visibleMissing = computed(() => missingModels.value.filter(matches));
const visibleReturned = computed(() => returnedModels.value.filter(matches));
const visibleModels = computed(() => [...visibleMissing.value, ...visibleReturned.value]);

function selectVisible(): void {
  if (props.applying) return;
  draft.value = [...new Set([...draft.value, ...visibleModels.value.map((model) => model.id)])];
}

function clearVisible(): void {
  if (props.applying) return;
  const visible = new Set(visibleModels.value.map((model) => model.id));
  draft.value = draft.value.filter((name) => !visible.has(name));
}

function toggleModel(id: string): void {
  if (props.applying) return;
  draft.value = selectedSet.value.has(id)
    ? draft.value.filter((name) => name !== id)
    : [...draft.value, id];
}

function modelMeta(model: GatewayModel): string {
  return [
    model.contextWindow ? fmtTokens(model.contextWindow).toUpperCase() : "",
    model.supportsReasoning ? "推理" : "",
    model.supportsVision ? "图片" : "",
  ].filter(Boolean).join(" · ") || "—";
}

function applySelection(): void {
  if (!draft.value.length || props.applying) return;
  const selected = draft.value
    .map((name) => allKnownModels.value.get(name))
    .filter((model): model is GatewayModel => Boolean(model));
  emit("apply", selected);
}
</script>

<template>
  <AntdvProvider>
    <Teleport to="body">
      <div v-if="open" class="model-picker-mask" @click.self="requestCancel">
        <section
          :id="modalId"
          ref="dialogEl"
          class="model-picker-shell"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="descriptionId"
          tabindex="-1"
        >
          <header class="model-picker-head">
            <div class="model-picker-heading">
              <h2 :id="titleId" class="model-picker-title">{{ title }}</h2>
              <p :id="descriptionId" class="model-picker-desc">{{ description }}</p>
            </div>
            <Button class="model-picker-close" type="text" aria-label="关闭模型选择" title="关闭" :disabled="applying" @click="requestCancel">
              <i class="ui-icon" data-icon="X" aria-hidden="true"></i>
            </Button>
          </header>

          <div class="model-picker-toolbar">
            <Input
              :id="inputId"
              v-model:value="query"
              aria-label="搜索模型"
              allow-clear
              :disabled="applying"
              spellcheck="false"
              placeholder="搜索模型..."
            >
              <template #prefix><i class="ui-icon" data-icon="Search" aria-hidden="true"></i></template>
            </Input>
            <div class="model-picker-bulk">
              <Button class="model-picker-select-all" type="text" size="small" :disabled="applying || !visibleModels.length" @click="selectVisible">全选</Button>
              <Button class="model-picker-clear-all" type="text" size="small" :disabled="applying || !visibleModels.some((model) => selectedSet.has(model.id))" @click="clearVisible">全不选</Button>
            </div>
          </div>

          <div class="model-picker-summary">
            <span>已选 {{ draft.length }} / 共 {{ totalCount }}</span>
            <Checkbox v-model:checked="onlySelected" class="model-picker-only-selected" :disabled="applying">只看已选</Checkbox>
          </div>

          <div :id="listId" class="model-picker-list">
            <section v-if="visibleMissing.length" class="model-picker-group is-missing" role="group" aria-label="不在供应商列表中">
              <div class="model-picker-group-title" aria-hidden="true">不在供应商列表中</div>
              <div v-for="model in visibleMissing" :key="model.id" class="model-picker-row" :data-model-id="model.id" @click="toggleModel(model.id)">
                <Checkbox
                  :checked="selectedSet.has(model.id)"
                  :aria-label="`${selectedSet.has(model.id) ? '取消选择' : '选择'} ${model.id}`"
                  :disabled="applying"
                  @click.stop
                  @change="toggleModel(model.id)"
                />
                <span class="model-picker-name">{{ model.id }}</span>
                <span class="model-picker-meta">{{ modelMeta(model) }}</span>
              </div>
            </section>

            <section v-if="visibleReturned.length" class="model-picker-group" role="group" aria-label="供应商返回的模型">
              <div class="model-picker-group-title" aria-hidden="true">供应商返回的模型</div>
              <div v-for="model in visibleReturned" :key="model.id" class="model-picker-row" :data-model-id="model.id" @click="toggleModel(model.id)">
                <Checkbox
                  :checked="selectedSet.has(model.id)"
                  :aria-label="`${selectedSet.has(model.id) ? '取消选择' : '选择'} ${model.id}`"
                  :disabled="applying"
                  @click.stop
                  @change="toggleModel(model.id)"
                />
                <span class="model-picker-name">{{ model.id }}</span>
                <span class="model-picker-meta">{{ modelMeta(model) }}</span>
              </div>
            </section>

            <div v-if="!visibleModels.length" class="model-picker-empty">
              {{ totalCount ? "没有匹配的模型，换个关键词试试" : "网关没有返回模型" }}
            </div>
          </div>

          <div class="model-picker-footer">
            <span v-if="!draft.length" class="model-picker-warning" role="status" aria-live="polite">至少保留一个模型</span>
            <span class="model-picker-spacer"></span>
            <Button class="model-picker-cancel" :disabled="applying" @click="requestCancel">取消</Button>
            <Button class="model-picker-apply" type="primary" :loading="applying" :disabled="!draft.length || applying" @click="applySelection">
              应用
            </Button>
          </div>
        </section>
      </div>
    </Teleport>
  </AntdvProvider>
</template>
