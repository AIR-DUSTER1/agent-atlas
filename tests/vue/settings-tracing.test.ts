/**
 * settings-tracing.test.ts — 链路追踪面板 Vue 组件（M4 批次 4.2）
 * 覆盖：DOM 契约（tracing-* 锚点与 aria-label）、开关与后端下拉双向同步、
 * 出网警示文案、Key 掩码占位与「清除」语义、保存载荷（留空保持 / 空串清除）。
 * fetch 全部打桩，不触网。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import SettingsTracingVue from "../../src/client/views/settings/tracing/settings-tracing-vue.vue";
import { useTracingStore } from "../../src/client/stores/tracing.js";
import type { TraceSettingsSnapshot } from "../../src/client/modules/types-api.js";

const SNAPSHOT: TraceSettingsSnapshot = {
  backend: "off",
  project: "agentatlas",
  endpoint: "https://api.smith.langchain.com",
  anonymize: true,
  agentId: "agentatlas",
  agentEnvironment: "local",
  hasApiKey: false,
  keyMasked: "",
  effective: false,
  warning: null,
};

let pinia: Pinia;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = "";
  pinia = createPinia();
  setActivePinia(pinia);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...SNAPSHOT }) }));
  vi.stubGlobal("fetch", fetchMock);
});

/** 预置快照后挂载（onMounted 的 store.load 会拉同一份快照，保持幂等）。 */
async function mountPanel(snapshot: TraceSettingsSnapshot = SNAPSHOT): Promise<VueWrapper> {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...snapshot }) });
  const store = useTracingStore();
  store.snapshot = snapshot;
  const wrapper = mount(SettingsTracingVue, { attachTo: document.body, global: { plugins: [pinia] } });
  await flushPromises();
  return wrapper;
}

/**
 * 驱动 antdv Select：渲染 input[role=combobox] + 浮层，不是原生 select。
 * 实测 happy-dom 下「点 input 打开 → 点 .ant-select-item-option」可以完整走通
 * （含 @change 触发），所以测试走真实交互路径而不是直接 emit。
 */
async function pickSelect(selectId: string, optionText: string): Promise<void> {
  const input = document.getElementById(selectId) as HTMLElement;
  expect(input, `#${selectId} 不存在`).toBeTruthy();
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const option = [...document.querySelectorAll<HTMLElement>(".ant-select-item-option")]
    .find((node) => node.textContent?.trim() === optionText);
  expect(option, `选项「${optionText}」未渲染`).toBeTruthy();
  option!.click();
  await flushPromises();
}

describe("链路追踪面板", () => {
  it("渲染全部 tracing-* 锚点与可访问名称", async () => {
    await mountPanel();
    for (const id of [
      "tracing-enabled", "tracing-backend", "tracing-project", "tracing-endpoint",
      "tracing-agent-id", "tracing-agent-environment", "tracing-api-key",
      "tracing-clear-key", "tracing-anonymize", "tracing-warning",
      "tracing-status", "tracing-save-btn",
    ]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    // antdv Select 把 aria-label 落在最外层 .ant-select 容器上（内部 input 是 combobox 角色）
    expect(document.getElementById("tracing-backend")?.closest(".ant-select")?.getAttribute("aria-label")).toBe("追踪后端");
    // antdv Switch 渲染 <button role="switch">，状态看 aria-checked
    expect(document.getElementById("tracing-enabled")?.getAttribute("role")).toBe("switch");
    expect(document.getElementById("tracing-enabled")?.getAttribute("aria-checked")).toBe("false");
    expect(document.getElementById("tracing-enabled-label")?.textContent).toBe("已停用");
  });

  it("后端下拉切到 langsmith 时开关同步勾选并给出出网警示", async () => {
    await mountPanel();
    await pickSelect("tracing-backend", "LangSmith 云端");
    expect(document.getElementById("tracing-enabled")?.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById("tracing-enabled-label")?.textContent).toBe("已启用");
    expect(document.getElementById("tracing-warning")?.textContent).toContain("保存后开始向 LangSmith 上报");
  });

  it("开关本身也能反向驱动后端值", async () => {
    const wrapper = await mountPanel();
    (document.getElementById("tracing-enabled") as HTMLElement).click();
    await flushPromises();
    // 开关 → backend 的联动看 Select 是否变成 langsmith
    const select = wrapper.findAllComponents({ name: "ASelect" })[0];
    expect((select?.props() as { value?: string }).value).toBe("langsmith");
    expect(document.getElementById("tracing-enabled-label")?.textContent).toBe("已启用");
  });

  it("已配置 Key 时占位显示掩码且输入框为空", async () => {
    await mountPanel({ ...SNAPSHOT, hasApiKey: true, keyMasked: "lsv2…abcd" });
    const key = document.getElementById("tracing-api-key") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toContain("lsv2…abcd");
    expect(document.getElementById("tracing-key-state")?.textContent).toBe("已配置");
  });

  it("勾选清除 Key 时禁用输入框并提交空串", async () => {
    await mountPanel({ ...SNAPSHOT, hasApiKey: true, keyMasked: "lsv2…abcd" });
    const key = document.getElementById("tracing-api-key") as HTMLInputElement;
    const clear = document.getElementById("tracing-clear-key") as HTMLInputElement;
    key.value = "should-be-dropped";
    // antdv Checkbox 渲染真实 <input type="checkbox">，原生 click 可驱动 v-model
    clear.click();
    await flushPromises();
    expect(key.disabled).toBe(true);
    expect(key.value).toBe("");

    document.getElementById("tracing-save-btn")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).apiKey).toBe("");
  });

  it("Key 留空时不把 apiKey 放进载荷（表示保持）", async () => {
    await mountPanel({ ...SNAPSHOT, hasApiKey: true, keyMasked: "lsv2…abcd" });
    document.getElementById("tracing-save-btn")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).not.toHaveProperty("apiKey");
  });

  it("保存成功后回填服务端快照并提示下一条消息生效", async () => {
    await mountPanel();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...SNAPSHOT, backend: "langsmith", effective: true }),
    });
    document.getElementById("tracing-save-btn")!.dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    expect(document.getElementById("tracing-enabled")?.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById("tracing-status")?.textContent).toContain("追踪配置已保存");
    expect(document.getElementById("tracing-status")?.className).toContain("ok");
  });

  it("读取失败时状态行与警示同时给出可操作提示", async () => {
    fetchMock.mockRejectedValueOnce(new Error("503 服务不可用"));
    mount(SettingsTracingVue, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    expect(document.getElementById("tracing-status")?.textContent).toContain("503 服务不可用");
    expect(document.getElementById("tracing-warning")?.textContent).toContain("追踪配置读取失败");
  });
});
