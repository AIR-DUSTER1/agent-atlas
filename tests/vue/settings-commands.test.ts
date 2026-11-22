/**
 * settings-commands.test.ts — 自定义命令双栏管理页 Vue 组件（M4 批次 4.1）
 * 覆盖：创建（含模板变量插入）、搜索过滤、改名保存（PUT）、删除（确认对话）、
 * 未保存修改的放弃确认、Esc 关闭与 Ctrl+Enter 保存。fetch 与确认对话全部打桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import SettingsCommandsVue from "../../src/client/views/settings/commands/settings-commands-vue.vue";
import { useCommandsStore } from "../../src/client/stores/settings/commands/commands.js";
import { uiConfirm } from "../../src/client/ui/dialog.js";
import type { UserCommandItem } from "../../src/client/composer/menu.js";

vi.mock("../../src/client/ui/dialog.js", () => ({ uiConfirm: vi.fn() }));

type FetchResponse = { status: number; ok: boolean; json: () => Promise<unknown> };
type Call = { path: string; method: string; body: unknown };

const seedCommands: UserCommandItem[] = [
  { name: "review", title: "审查改动", description: "审查当前改动", template: "请审查：{{selection}}" },
  { name: "daily", title: "日报", description: "生成日报", template: "生成 {{date}} 日报" },
];

let calls: Call[] = [];

/** 按 REST 契约打桩 /api/commands；写回成功后返回全量列表（服务端为准）。 */
function stubCommandsApi(initial: UserCommandItem[]): void {
  calls = [];
  let current = initial;
  const impl = (input: string, init?: RequestInit): Promise<FetchResponse> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/commands" && method === "GET") {
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ commands: current }) });
    }
    if (path === "/api/commands" && method === "POST") {
      const created = body as UserCommandItem;
      current = [...current, created];
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ command: created, created: true, commands: current }) });
    }
    const match = path.match(/^\/api\/commands\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[1] ?? "");
      if (method === "PUT") {
        const updated = body as UserCommandItem;
        current = current.map((command) => command.name === name ? updated : command);
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ command: updated, commands: current }) });
      }
      if (method === "DELETE") {
        current = current.filter((command) => command.name !== name);
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ commands: current }) });
      }
    }
    return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ error: "not found" }) });
  };
  vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
}

function setInput(selector: string, value: string): void {
  const input = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  input.value = value;
  // Playwright fill 会把光标放到末尾；happy-dom 需要显式模拟（变量插入依赖光标位置）
  const end = value.length;
  if ("setSelectionRange" in input) input.setSelectionRange(end, end);
  input.dispatchEvent(new Event("input"));
}

function submitForm(): void {
  document.getElementById("command-form")?.dispatchEvent(new Event("submit", { cancelable: true }));
}

let pinia: Pinia;

beforeEach(() => {
  document.body.innerHTML = '<div id="commands-status" class="settings-status" role="status"></div>';
  pinia = createPinia();
  setActivePinia(pinia);
  vi.unstubAllGlobals();
  vi.mocked(uiConfirm).mockReset();
  vi.mocked(uiConfirm).mockResolvedValue(true);
  stubCommandsApi(seedCommands);
});

async function mountPanel(): Promise<void> {
  const store = useCommandsStore();
  await store.refresh();
  // attachTo：断言走 document.querySelector（e2e 同视角），必须挂进真实 DOM
  mount(SettingsCommandsVue, { attachTo: document.body, global: { plugins: [pinia] } });
  await vi.waitFor(() => expect(document.getElementById("commands-list")).toBeTruthy());
}

describe("命令列表", () => {
  it("渲染命令卡片与计数，卡片主按钮可打开编辑器", async () => {
    await mountPanel();
    expect(document.getElementById("commands-count")?.textContent).toBe("2 个命令");
    const card = document.querySelector(".command-card");
    expect(card?.textContent).toContain("/review");
    expect(card?.textContent).toContain("审查改动");
    (document.querySelector('[aria-label="打开命令 /review"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("command-form")).toBeTruthy());
    expect((document.getElementById("cmd-name") as HTMLInputElement).value).toBe("review");
    expect(document.getElementById("cmd-editor-mode")?.textContent).toBe("编辑命令");
  });

  it("搜索过滤并显示匹配计数；无结果时显示空态", async () => {
    await mountPanel();
    setInput("#commands-search", "不存在");
    await vi.waitFor(() => {
      expect(document.getElementById("commands-count")?.textContent).toBe("0 / 2 个命令");
      expect(document.getElementById("commands-list")?.textContent).toContain("没有匹配的命令");
    });
    setInput("#commands-search", "review");
    await vi.waitFor(() => expect(document.querySelectorAll(".command-card").length).toBe(1));
  });
});

describe("命令创建与编辑", () => {
  it("创建命令：模板变量插入 + POST 写回 + 状态提示", async () => {
    await mountPanel();
    (document.getElementById("cmd-new-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("command-form")).toBeTruthy());
    setInput("#cmd-name", "e2e-command");
    setInput("#cmd-title", "E2E 命令标题");
    setInput("#cmd-template", "请检查以下内容：");
    (document.querySelector('[data-command-token="selection"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("cmd-template") as HTMLTextAreaElement).value).toBe("请检查以下内容：{{selection}}");
    });
    submitForm();
    await vi.waitFor(() => {
      expect(document.getElementById("commands-status")?.textContent).toContain("已创建 /e2e-command");
      expect(document.querySelector('[aria-label="打开命令 /e2e-command"]')).toBeTruthy();
    });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ name: "e2e-command", template: "请检查以下内容：{{selection}}" });
    expect(document.getElementById("commands-count")?.textContent).toBe("3 个命令");
  });

  it("校验失败本地拦截：保留必填错误不发请求", async () => {
    await mountPanel();
    (document.getElementById("cmd-new-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("command-form")).toBeTruthy());
    setInput("#cmd-name", "BAD NAME!");
    setInput("#cmd-template", "模板内容");
    submitForm();
    await vi.waitFor(() => {
      expect(document.getElementById("cmd-name-vue-error")?.textContent).toContain("只能用字母、数字");
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect((document.getElementById("cmd-name") as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");
  });

  it("改名保存走 PUT，成功后卡片以新名字呈现", async () => {
    await mountPanel();
    (document.querySelector('[aria-label="编辑命令 /review"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("command-form")).toBeTruthy());
    setInput("#cmd-name", "review-renamed");
    setInput("#cmd-title", "改名后的标题");
    submitForm();
    await vi.waitFor(() => {
      expect(document.getElementById("commands-status")?.textContent).toContain("已保存 /review-renamed");
      expect(document.querySelector('[aria-label="打开命令 /review-renamed"]')).toBeTruthy();
    });
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe("/api/commands/review");
    expect(put?.body).toMatchObject({ name: "review-renamed" });
  });

  it("有未保存修改时切换需确认；取消则保留表单内容，确认后清空", async () => {
    await mountPanel();
    (document.querySelector('[aria-label="编辑命令 /review"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("command-form")).toBeTruthy());
    setInput("#cmd-title", "尚未保存的标题");
    // 第一次点击：用户取消放弃 → 表单内容保留
    vi.mocked(uiConfirm).mockResolvedValue(false);
    (document.getElementById("cmd-new-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(uiConfirm).toHaveBeenCalled());
    expect(document.getElementById("command-form")).toBeTruthy();
    expect((document.getElementById("cmd-title") as HTMLInputElement).value).toBe("尚未保存的标题");
    // 第二次点击：用户确认放弃 → 表单清空进入创建态
    vi.mocked(uiConfirm).mockResolvedValue(true);
    (document.getElementById("cmd-new-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("cmd-name") as HTMLInputElement).value).toBe("");
      expect(document.getElementById("cmd-editor-mode")?.textContent).toBe("新建命令");
    });
  });

  it("Esc 关闭编辑器回到空态；Ctrl+Enter 直接保存", async () => {
    await mountPanel();
    (document.getElementById("cmd-new-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("command-form")).toBeTruthy());
    setInput("#cmd-name", "kbd-cmd");
    setInput("#cmd-template", "模板");
    document.getElementById("command-form")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(document.getElementById("commands-status")?.textContent).toContain("已创建 /kbd-cmd"));
    // Esc：编辑器已处于编辑态（保存成功后停留在编辑），关闭回到空态
    document.getElementById("command-form")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    await vi.waitFor(() => expect(document.getElementById("commands-editor-empty")).toBeTruthy());
  });
});

describe("命令删除", () => {
  it("删除需确认；确认后 DELETE 写回并移除卡片", async () => {
    await mountPanel();
    (document.querySelector('[aria-label="删除命令 /daily"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(uiConfirm).toHaveBeenCalled());
    expect(vi.mocked(uiConfirm).mock.calls[0]?.[0]).toContain("删除命令「/daily」");
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="打开命令 /daily"]')).toBeNull();
      expect(document.getElementById("commands-status")?.textContent).toContain("已删除 /daily");
    });
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe("/api/commands/daily");
    expect(document.getElementById("commands-count")?.textContent).toBe("1 个命令");
  });

  it("取消确认时不发删除请求", async () => {
    vi.mocked(uiConfirm).mockResolvedValue(false);
    await mountPanel();
    (document.querySelector('[aria-label="删除命令 /daily"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(uiConfirm).toHaveBeenCalled());
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(document.querySelector('[aria-label="打开命令 /daily"]')).toBeTruthy();
  });
});
