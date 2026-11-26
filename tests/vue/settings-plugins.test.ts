/**
 * settings-plugins.test.ts — 插件面板 Vue 组件（M4 批次 4.1）
 * 覆盖：卡片 DOM 契约（data-plugin-id / role=switch / aria-label）、
 * 启停写回（PATCH 成功更新 store + legacy 镜像）、失败回滚开关、
 * 非 Windows 平台禁用 Computer Use、readiness 文案。fetch 全部打桩；
 * shell 的 Agent 卡刷新与 legacy 对话框 mock 掉（不属于本组件职责）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import SettingsPluginsVue from "../../src/client/views/settings/plugins/settings-plugins-vue.vue";
import { usePluginsStore } from "../../src/client/stores/settings/plugins/plugins.js";
import { state } from "../../src/client/core/state.js";
import type { PluginSettingsState } from "../../src/client/modules/types.js";
import type { RagState } from "../../src/client/modules/types.js";

vi.mock("../../src/client/views/shell.js", () => ({ refreshAgentCards: vi.fn() }));

type FetchResponse = { status: number; ok: boolean; json: () => Promise<unknown> };

function pluginsBody(platform = "win32", overrides: Record<string, boolean> = {}, container = false): Record<string, unknown> {
  return {
    enabled: { rag: true, estate: true, job: true, browser: false, computer: false, ...overrides },
    platform,
    container,
  };
}

let pinia: Pinia;

beforeEach(() => {
  document.body.innerHTML = '<div id="plugin-status" class="settings-status" role="status"></div>';
  pinia = createPinia();
  setActivePinia(pinia);
  vi.unstubAllGlobals();
});

/** 用预置 store 状态挂载面板（与 refreshAll 等价的最小数据准备）。 */
function mountPanel(overrides: Record<string, boolean> = {}, platform = "win32", container = false): void {
  const store = usePluginsStore();
  store.plugins = pluginsBody(platform, overrides, container) as unknown as PluginSettingsState;
  // attachTo：断言走 document.querySelector（e2e 同视角），必须挂进真实 DOM
  mount(SettingsPluginsVue, { attachTo: document.body, global: { plugins: [pinia] } });
}

describe("插件面板卡片契约", () => {
  it("按内置目录渲染卡片：data-plugin-id、名称与启停开关", () => {
    mountPanel();
    const rag = document.querySelector('[data-plugin-id="rag"]');
    expect(rag?.textContent).toContain("知识库（RAG）");
    const browser = document.querySelector('[data-plugin-id="browser"]');
    expect(browser?.textContent).toContain("Browser Use");
    // antdv Switch 渲染 <button role="switch" aria-checked>，状态读 aria-checked
    const browserSwitch = document.querySelector('[data-plugin-id="browser"] [role="switch"]');
    expect(browserSwitch?.getAttribute("aria-checked")).toBe("false");
    const ragSwitch = document.querySelector('[data-plugin-id="rag"] [role="switch"]');
    expect(ragSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(ragSwitch?.getAttribute("aria-label")).toBe("停用知识库（RAG）");
  });

  it("非 win32 平台禁用 Computer Use 并标注仅支持 Windows", () => {
    mountPanel({}, "linux");
    const computer = document.querySelector('[data-plugin-id="computer"]');
    expect(computer?.textContent).toContain("仅支持 Windows");
    const computerSwitch = document.querySelector<HTMLButtonElement>('[data-plugin-id="computer"] [role="switch"]');
    expect(computerSwitch?.disabled).toBe(true);
    expect(computerSwitch?.getAttribute("aria-label")).toBe("电脑控制（Computer Use）仅支持 Windows");
  });

  it("Docker / 容器部署中禁用 Computer Use 并标注不可用", () => {
    mountPanel({}, "win32", true);
    const computer = document.querySelector('[data-plugin-id="computer"]');
    expect(computer?.textContent).toContain("Docker 部署不可用");
    const computerSwitch = document.querySelector<HTMLButtonElement>('[data-plugin-id="computer"] [role="switch"]');
    expect(computerSwitch?.disabled).toBe(true);
    expect(computerSwitch?.getAttribute("aria-label")).toBe("电脑控制（Computer Use）在 Docker 部署中不可用");
  });

  it("readiness：RAG 未配置时显示未配置，rag 状态就绪后显示已配置", async () => {
    mountPanel();
    const rag = document.querySelector('[data-plugin-id="rag"]');
    expect(rag?.textContent).toContain("未配置");
    const store = usePluginsStore();
    store.rag = { configured: true } as RagState;
    await vi.waitFor(() => expect(rag?.textContent).toContain("已配置"));
  });
});

describe("插件启停写回", () => {
  it("切换开关提交 PATCH，成功后更新 store 与 legacy 镜像并提示生效", async () => {
    const patchBodies: Array<{ url: string; body: unknown }> = [];
    const impl = (input: string, init?: RequestInit): Promise<FetchResponse> => {
      if (String(input).startsWith("/api/plugins/browser") && init?.method === "PATCH") {
        patchBodies.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(pluginsBody("win32", { browser: true })) });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    };
    vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
    mountPanel();
    const store = usePluginsStore();
    const browserSwitch = document.querySelector<HTMLButtonElement>('[data-plugin-id="browser"] [role="switch"]')!;
    expect(browserSwitch.getAttribute("aria-checked")).toBe("false");
    browserSwitch.click();
    await vi.waitFor(() => expect(store.plugins?.enabled.browser).toBe(true));
    expect(patchBodies[0]?.body).toEqual({ enabled: true });
    // legacy 镜像同步（shell 欢迎语 / Agent 卡读取 core state）
    expect(state.plugins?.enabled.browser).toBe(true);
    expect(document.getElementById("plugin-status")?.textContent).toContain("浏览器操作（Browser Use）已启用");
  });

  it("PATCH 失败时开关回滚并提示错误", async () => {
    const impl = (input: string, init?: RequestInit): Promise<FetchResponse> => {
      if (String(input).startsWith("/api/plugins/browser") && init?.method === "PATCH") {
        return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({ error: "服务端拒绝" }) });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    };
    vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
    mountPanel();
    const browserSwitch = document.querySelector<HTMLButtonElement>('[data-plugin-id="browser"] [role="switch"]')!;
    browserSwitch.click();
    await vi.waitFor(() => {
      // 失败回滚后 aria-checked 回到 false（store 未变，受控渲染复位）
      expect(browserSwitch.getAttribute("aria-checked")).toBe("false");
      expect(document.getElementById("plugin-status")?.textContent).toContain("服务端拒绝");
    });
  });
});
