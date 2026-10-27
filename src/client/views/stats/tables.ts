/**
 * views/stats/tables.ts — 使用统计明细表
 * ============================================================
 * 图表不是唯一信息入口：Top 会话和工具调用始终以可复制表格展示，读取顺序固定，
 * 并允许在轮次 / token 之间切换排序。
 */
import { fmtTokens } from "../../modules/format.js";
import { h } from "../../ui/h.js";
import type { StatsRange } from "../../modules/types.js";

let sessionSort: "turns" | "tokens" = "turns";

function empty(text: string): HTMLElement {
  return h("p", { class: "memories-empty" }, text);
}

function card(title: string, subtitle: string, body: HTMLElement): HTMLElement {
  return h("section", { class: "stats-card stats-table-card" },
    h("div", { class: "stats-card-head" },
      h("div", null, h("h3", null, title), h("p", { class: "key-state" }, subtitle)),
    ),
    body,
  );
}

function sessionTable(range: StatsRange): HTMLElement {
  const rows = [...(range.topSessions ?? [])].sort((left, right) =>
    sessionSort === "tokens" ? right.tokens - left.tokens : right.turns - left.turns
  );
  if (!rows.length) return empty("当前区间暂无会话记录。");
  const body = h("tbody");
  for (const row of rows) {
    body.appendChild(h("tr", null,
      h("td", null, row.title),
      h("td", { class: "num" }, String(row.turns)),
      h("td", { class: "num" }, fmtTokens(row.tokens)),
    ));
  }
  const table = h("table", { class: "stats-table" },
    h("thead", null,
      h("tr", null,
        h("th", null, "会话"),
        h("th", { class: "num" }, h("button", {
          type: "button",
          class: "stats-sort" + (sessionSort === "turns" ? " active" : ""),
          onclick: () => {
            sessionSort = "turns";
            renderTables(document.getElementById("stats-tables"), range);
          },
        }, "轮次")),
        h("th", { class: "num" }, h("button", {
          type: "button",
          class: "stats-sort" + (sessionSort === "tokens" ? " active" : ""),
          onclick: () => {
            sessionSort = "tokens";
            renderTables(document.getElementById("stats-tables"), range);
          },
        }, "Tokens")),
      ),
    ),
    body,
  );
  return table;
}

function toolTable(range: StatsRange): HTMLElement {
  const rows = range.toolCalls ?? [];
  if (!rows.length) return empty("当前区间暂无工具调用。");
  const max = Math.max(...rows.map((row) => row.count), 1);
  const body = h("tbody");
  for (const row of rows) {
    body.appendChild(h("tr", null,
      h("td", null, row.name),
      h("td", { class: "tool-count-cell" },
        h("span", { class: "stats-inline-bar", style: { "--bar-width": `${Math.round((row.count / max) * 100)}%` } }),
        h("span", { class: "num" }, String(row.count)),
      ),
    ));
  }
  return h("table", { class: "stats-table" },
    h("thead", null, h("tr", null, h("th", null, "工具"), h("th", { class: "num" }, "调用次数"))),
    body,
  );
}

export function renderTables(container: HTMLElement | null, range: StatsRange): void {
  if (!container) return;
  container.replaceChildren(
    card("Top 会话", "点击列名切换排序", sessionTable(range)),
    card("工具调用", "流式分片按 call id 去重", toolTable(range)),
  );
}
