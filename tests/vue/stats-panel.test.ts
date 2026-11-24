/**
 * stats-panel.test.ts — 使用统计面板 Vue 组件（M4 批次 4.2）
 * 覆盖：7/30 天区间卡契约（data-stats-range / aria-pressed）、KPI 六卡数值、
 * 区间切换不发新请求、会话表排序、工具调用条形宽度、错误降级区与重试。
 * Chart.js 走动态 import；这里把 charts 模块打桩，避免 happy-dom 无 canvas 上下文。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import StatsPanelVue from "../../src/client/views/settings/stats/stats-panel-vue.vue";
import { useStatsStore } from "../../src/client/stores/settings/stats/stats.js";
import type { StatsRange, StatsResult } from "../../src/client/modules/types-api.js";

vi.mock("chart.js", () => ({
  Chart: class {
    resize(): void {}
    destroy(): void {}
    toBase64Image(): string { return "data:image/png;base64,"; }
  },
}));

function makeRange(id: string, label: string, turns: number): StatsRange {
  return {
    id,
    label,
    startDate: "2026-11-15",
    endDate: "2026-11-21",
    totals: {
      turns,
      sessions: 2,
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 300,
      modelCalls: 7,
      delegateCalls: 1,
    },
    byDay: [{ date: "2026-11-21", turns, inputTokens: 1200, outputTokens: 800, cacheReadTokens: 300 }],
    byModel: [{ model: "deepseek-chat", calls: 7, inputTokens: 1200, outputTokens: 800 }],
    byModelShare: [{ model: "deepseek-chat", calls: 7, inputTokens: 1200, outputTokens: 800 }],
    byHour: [{ hour: 9, turns, tokens: 200 }],
    toolCalls: [{ name: "read_file", count: 4 }, { name: "web_search", count: 2 }],
    health: { avgTurnMs: 1500, cacheHitRate: 0.25, failedTurns: 0, interruptedTurns: 1 },
    topSessions: [
      { sessionId: "s1", title: "会话甲", turns: 3, tokens: 900 },
      { sessionId: "s2", title: "会话乙", turns: 5, tokens: 400 },
    ],
  } as unknown as StatsRange;
}

function makeResult(): StatsResult {
  return {
    generatedAt: Date.now(),
    ranges: [makeRange("7d", "近 7 天", 8), makeRange("30d", "近 30 天", 20)],
  } as unknown as StatsResult;
}

let pinia: Pinia;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = "";
  pinia = createPinia();
  setActivePinia(pinia);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => makeResult() }));
  vi.stubGlobal("fetch", fetchMock);
});

async function mountPanel(): Promise<void> {
  mount(StatsPanelVue, { attachTo: document.body, global: { plugins: [pinia] } });
  await flushPromises();
}

describe("使用统计面板", () => {
  it("渲染 7d/30d 区间卡并默认选中 7d", async () => {
    await mountPanel();
    const cards = document.querySelectorAll("#stats-window-overview .stats-window-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("data-stats-range")).toBe("7d");
    expect(cards[1]?.getAttribute("data-stats-range")).toBe("30d");
    expect(cards[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(cards[0]?.className).toContain("active");
    expect(document.getElementById("stats-selected-title")?.textContent).toBe("近 7 天明细");
  });

  it("渲染 KPI 六卡与说明文案", async () => {
    await mountPanel();
    const kpis = document.querySelectorAll("#stats-kpis .stats-kpi");
    expect(kpis).toHaveLength(6);
    const labels = [...kpis].map((item) => item.querySelector(".stats-kpi-label")?.textContent);
    expect(labels).toEqual(["对话轮次", "输入 Tokens", "输出 Tokens", "缓存命中", "平均轮次耗时", "子 Agent 委派"]);
    expect(kpis[0]?.querySelector(".stats-kpi-value")?.textContent).toBe("8");
    expect(kpis[4]?.querySelector(".stats-kpi-value")?.textContent).toBe("1.50s");
  });

  it("切换区间只重绘，不再发第二次请求", async () => {
    await mountPanel();
    const before = fetchMock.mock.calls.length;
    (document.querySelectorAll("#stats-window-overview .stats-window-card")[1] as HTMLElement)
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    expect(document.querySelector("#stats-window-overview .stats-window-card.active")?.getAttribute("data-stats-range")).toBe("30d");
    expect(document.getElementById("stats-selected-title")?.textContent).toBe("近 30 天明细");
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("会话表默认按轮次排序，点 Tokens 后改按 token 排序", async () => {
    await mountPanel();
    const rows = (): string[] => [...document.querySelectorAll("#stats-tables tbody tr")]
      .slice(0, 2)
      .map((row) => row.querySelector("td")?.textContent ?? "");
    expect(rows()).toEqual(["会话乙", "会话甲"]);
    const tokensButton = [...document.querySelectorAll<HTMLButtonElement>("#stats-tables .stats-sort")]
      .find((button) => button.textContent === "Tokens");
    tokensButton!.dispatchEvent(new Event("click", { bubbles: true }));
    await flushPromises();
    expect(rows()).toEqual(["会话甲", "会话乙"]);
  });

  it("工具调用条形宽度按最大值归一化", async () => {
    await mountPanel();
    const bars = [...document.querySelectorAll<HTMLElement>("#stats-tables .stats-inline-bar")];
    expect(bars[0]?.style.getPropertyValue("--bar-width")).toBe("100%");
    expect(bars[1]?.style.getPropertyValue("--bar-width")).toBe("50%");
  });

  it("接口失败时展示降级区与重试按钮", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "统计服务异常" }) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "统计服务异常" }) });
    await mountPanel();
    const degraded = document.querySelector("#stats-charts .stats-degraded");
    expect(degraded?.getAttribute("role")).toBe("alert");
    expect(degraded?.textContent).toContain("统计暂不可用");
    // antdv Button 的 autoInsertSpace 默认在两个汉字间插空格（"重 试"），
    // 断言文案时只关心词本身，不关心排版空格。
    expect(degraded?.querySelector("button")?.textContent?.replace(/\s+/g, "")).toBe("重试");
  });

  it("区间卡与表格在无数据时给出空态文案", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ generatedAt: Date.now(), ranges: [] }),
    });
    await mountPanel();
    expect(document.querySelector("#stats-charts .stats-degraded")?.textContent).toContain("统计暂不可用");
    expect(document.querySelectorAll("#stats-window-overview .stats-window-card")).toHaveLength(0);
  });

  it("图表无数据时只渲染一行文案，不留 canvas 与画布区", async () => {
    // 全空区间：六张图都没有可画数据
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: Date.now(),
        ranges: ["7d", "30d"].map((id) => {
          const range = makeRange(id, id === "7d" ? "近 7 天" : "近 30 天", 0);
          return {
            ...range,
            totals: { ...range.totals, turns: 0, inputTokens: 0, outputTokens: 0 },
            byDay: [{ date: "2026-11-21", turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }],
            byModel: [],
            byModelShare: [],
            byHour: [{ hour: 9, turns: 0, tokens: 0 }],
            toolCalls: [],
          };
        }),
      }),
    });
    await mountPanel();
    const cards = [...document.querySelectorAll<HTMLElement>("#stats-charts .stats-chart-card")];
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      // 空态是一行普通文本，不是撑满画布区的容器
      expect(card.querySelector(".stats-chart-empty")?.textContent).toContain("当前区间暂无数据");
      expect(card.querySelector("canvas")).toBeNull();
      expect(card.querySelector(".stats-chart-canvas-wrap")).toBeNull();
      // 没数据就没有可导出的图，别留一个永远点不动的按钮
      expect(card.querySelector(".stats-chart-export")).toBeNull();
    }
  });

  it("有数据的图渲染 canvas，无数据的图渲染文案（互不串场）", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        const range = makeRange("7d", "近 7 天", 8);
        return {
          generatedAt: Date.now(),
          ranges: [
            { ...range, toolCalls: [], byHour: [{ hour: 9, turns: 0, tokens: 0 }] },
            makeRange("30d", "近 30 天", 20),
          ],
        };
      },
    });
    await mountPanel();
    const card = (key: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`#stats-charts [data-chart-key="${key}"]`);
    // 有数据：canvas 在、空态不在
    expect(card("daily")?.querySelector("canvas")).not.toBeNull();
    expect(card("daily")?.querySelector(".stats-chart-empty")).toBeNull();
    // 无数据：空态在、canvas 与画布区都不在，导出按钮也不在
    expect(card("tools")?.querySelector(".stats-chart-empty")).not.toBeNull();
    expect(card("tools")?.querySelector("canvas")).toBeNull();
    expect(card("tools")?.querySelector(".stats-chart-canvas-wrap")).toBeNull();
    expect(card("tools")?.querySelector(".stats-chart-export")).toBeNull();
    expect(card("hour")?.querySelector("canvas")).toBeNull();
  });
});
