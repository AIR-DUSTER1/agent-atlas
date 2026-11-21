/**
 * project-switcher.test.ts — 项目切换器 Vue 组件（M4 批次 4.4）
 * 覆盖：按钮图标/文案派生（全部 / 不选择 / 具体项目）、菜单项契约
 * （role=menuitem、pm-check ✓、云端才有刷新、builtin 无删除）、
 * 命令面只发意图（副作用留在 legacy 桥）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import ProjectSwitcherVue from "../../src/client/views/project-switcher-vue.vue";
import { useProjectsStore } from "../../src/client/stores/projects.js";
import { state } from "../../src/client/core/state.js";
import type { ProjectEntry } from "../../src/client/modules/types.js";

const PROJECTS = [
  { id: "default", name: "未归属", type: "local", path: "/tmp", builtin: true },
  { id: "p-local", name: "本地项目", type: "local", path: "/tmp/local" },
  { id: "p-cloud", name: "云端仓库", type: "cloud", url: "https://example.invalid/repo.git" },
] as unknown as ProjectEntry[];

let pinia: Pinia;

beforeEach(() => {
  document.body.innerHTML = "";
  pinia = createPinia();
  setActivePinia(pinia);
  state.projects = PROJECTS;
  state.projectView = "all";
  window.__agentatlasProjectCommands = {};
});

function mountPanel(): void {
  mount(ProjectSwitcherVue, { attachTo: document.body, global: { plugins: [pinia] } });
}

/** onMounted 里的 store.sync 触发异步重渲染，断言前必须等一拍。 */
async function mountAndSettle(): Promise<void> {
  mountPanel();
  await flushPromises();
}

describe("项目切换器", () => {
  it("默认「全部项目」：按钮图标 FolderTree、文案全部项目、无选中项", async () => {
    await mountAndSettle();
    expect(document.getElementById("project-btn-text")?.textContent).toBe("全部项目");
    expect(document.querySelector("#project-btn-icon [data-icon]")?.getAttribute("data-icon")).toBe("FolderTree");
    const active = document.querySelectorAll("#project-menu .pm-item.active");
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toContain("全部项目");
  });

  it("视图为具体项目时按钮显示项目名与类型图标", async () => {
    state.projectView = "p-cloud";
    await mountAndSettle();
    expect(document.getElementById("project-btn-text")?.textContent).toBe("云端仓库");
    expect(document.querySelector("#project-btn-icon [data-icon]")?.getAttribute("data-icon")).toBe("Globe");
  });

  it("视图为不选择项目时按钮显示 Folder 与无项目文案", async () => {
    state.projectView = "__none__";
    await mountAndSettle();
    expect(document.getElementById("project-btn-text")?.textContent).toBe("不选择项目");
    expect(document.querySelector("#project-btn-icon [data-icon]")?.getAttribute("data-icon")).toBe("Folder");
  });

  it("菜单含两个固定项、每项目一项与两个管理项，且都是 menuitem", async () => {
    await mountAndSettle();
    const items = [...document.querySelectorAll("#project-menu [role='menuitem']")];
    expect(items.length).toBe(2 + PROJECTS.length + 2);
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim())).toEqual(
      expect.arrayContaining([
        expect.stringContaining("全部项目"),
        expect.stringContaining("不选择项目"),
        expect.stringContaining("添加本地文件夹（系统选择）"),
        expect.stringContaining("添加云端文件夹（Git 仓库）"),
      ]),
    );
  });

  it("云端项目有刷新按钮，builtin 项目没有删除按钮", async () => {
    await mountAndSettle();
    const labels = [...document.querySelectorAll("#project-menu button[aria-label]")]
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toContain("刷新 云端仓库");
    expect(labels).toContain("删除 云端仓库");
    expect(labels).toContain("删除 本地项目");
    expect(labels).not.toContain("删除 未归属");
  });

  it("点击菜单项只调用命令面，不直接改 core state", async () => {
    const choose = vi.fn();
    window.__agentatlasProjectCommands = { choose };
    await mountAndSettle();
    const noneItem = [...document.querySelectorAll<HTMLElement>("#project-menu [role='menuitem']")]
      .find((item) => item.textContent?.includes("不选择项目"));
    noneItem!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(choose).toHaveBeenCalledWith("__none__");
    expect(state.projectView).toBe("all");
  });

  it("外部通知后重新同步 core state（legacy 桥改完状态即刷新）", async () => {
    await mountAndSettle();
    state.projects = [...PROJECTS, { id: "p-new", name: "新加项目", type: "local", path: "/tmp/new" } as unknown as ProjectEntry];
    state.projectView = "p-new";
    for (const listener of window.__agentatlasProjectListeners ?? []) listener();
    await flushPromises();
    expect(document.getElementById("project-btn-text")?.textContent).toBe("新加项目");
    expect(useProjectsStore().items.some((item) => item.id === "p-new")).toBe(true);
  });
});
