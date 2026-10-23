/**
 * ============================================================
 * tools-estate.ts — 房产 Agent 的工具集（贝壳 CLI 能力的模型接口）
 * ============================================================
 * 所有数据来自 server/estate.ts 包装的贝壳官方 beike CLI（搜索/详情/
 * 户型图/板块/行情/经纪人），地图对比来自 Nominatim geocode。
 * 约定（与仓库其它工具一致）：
 *   - zod schema + describe 全中文；description 写清「何时用/何时不用」
 *   - 失败不 throw 穿透图：返回中文错误 JSON，让模型转述
 *   - house_appoint（预约带看）/ house_contact（加微经纪人）是「对外动作」，
 *     在 agent/approvals.ts 的 estate profile 策略登记，执行前必须人工审批
 *   - 运行结果统一 JSON 字符串：模型读全文，前端按工具名渲染专属卡片
 *     （房源列表卡 / 地图卡 / 户型图卡 —— 见 public/app.js updateToolCard）
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  houseSearch, houseInfo, houseArea, houseResolve, houseMarket, houseAgents,
  houseContact, houseAppoint, buildCompareMap, GEOCODE_LIMITS,
} from "./server/estate.js";

/** 通用收尾：把 estate.ts 的 BeikeOutcome 压成模型的最终工具结果字符串 */
function finalize(outcome: { ok: boolean; action: string; data?: unknown; error?: string }): string {
  if (outcome.ok) {
    const text = JSON.stringify({ action: outcome.action, ...((outcome.data ?? {}) as object) });
    if (text.length <= 26_000) return text;
    // 超长兜底：截断 + 标注，避免把模型上下文撑爆
    return JSON.stringify({
      action: outcome.action,
      truncated: true,
      note: "返回内容过长已截断，请缩小查询范围或分批查询",
      text: text.slice(0, 26_000),
    });
  }
  return JSON.stringify({ error: outcome.error });
}

function badArgs(message: string): string {
  return JSON.stringify({ error: message });
}

/** 把 CLI 返回里的候选数组抽出来，映射成前端友好字段（宽松键名匹配）：
 *  贝壳 CLI 输出形状未公开文档化，按 list/houses 等常见键名取数组；取不到
 *  就整体原样返回（模型仍可总结，前端降级只显示原始 JSON）。 */
function extractListings(data: unknown): Array<{ id?: string; title?: string; price?: string; area?: string; url?: string; cover?: string; addressText?: string }> {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const buckets: Array<Record<string, unknown>> = [];
  for (const key of ["list", "houses", "listings", "items", "records", "rooms"]) {
    const v = root[key];
    if (Array.isArray(v)) {
      buckets.push(...(v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]));
      break; // 命中第一个数组键就不再混入其它键的数组
    }
  }
  if (Array.isArray(data)) buckets.push(...(data.filter((x) => x && typeof x === "object") as Record<string, unknown>[]));
  if (!buckets.length) return [];
  const pick = (o: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k] ?? o[k.toLowerCase()] ?? o[k.toUpperCase()];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };
  return buckets.slice(0, 8).map((o) => ({
    id: pick(o, ["id", "houseId", "house_id", "houseid", "hsId"]),
    title: pick(o, ["title", "name", "houseName"]),
    price: pick(o, ["price", "totalPrice", "total_price", "zongjia", "priceDesc", "rent"]),
    area: pick(o, ["area", "surface", "square", "mianji", "areaDesc"]),
    url: pick(o, ["url", "link", "detailUrl", "detail_url", "pageUrl"]),
    cover: pick(o, ["cover", "img", "image", "pic", "coverPic", "thumb"]),
    addressText: pick(o, ["addressText", "address", "position", "communityName", "xiaoqu"]),
  }));
}

// ---------------------------------------------------------------------------
// 1. house_search：买房/租房搜索
// ---------------------------------------------------------------------------
export const houseSearchTool = tool(
  async ({ mode, city, query, houseType }) => {
    if (!city?.trim()) return badArgs("city 不能为空：先向用户确认城市再搜索");
    if (!query?.trim()) return badArgs("query 不能为空：请把用户的找房条件整理成一句话");
    if (houseType && mode === "rent") return badArgs("listing_type 只适用于买房（mode=buy）");
    const r = await houseSearch(mode, city.trim(), query.trim(), houseType ?? undefined);
    if (!r.ok) return JSON.stringify({ error: r.error });
    const listings = extractListings(r.data);
    // 抽不出结构化字段 → 原样给模型（前端降级显示原始 JSON）
    if (!listings.length) return finalize(r);
    return JSON.stringify({ action: "search", mode, city: city.trim(), query: query.trim(), count: listings.length, listings });
  },
  {
    name: "house_search",
    description:
      "找房搜索（贝壳官方数据）：搜索二手房/新房（mode=buy，可用 listing_type 区分 second/new）或在租房源（mode=rent）。" +
      "何时用：用户给出城市，且已有至少一个真实筛选条件（区域/通勤/预算/户型…）并确认需求摘要后调用。" +
      "何时不用：用户只有城市时先追问，不要搜索；对比几套房子的区位分布请改用 house_map。",
    schema: z.object({
      mode: z.enum(["buy", "rent"]).describe("buy=买房（二手+新房），rent=租房"),
      city: z.string().describe("城市名，如 北京"),
      query: z.string().describe("搜索条件一句话，如 「望京 两居 500-700万」"),
      houseType: z.enum(["second", "new"]).optional().describe("仅买房时可选：second=二手房，new=新房"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 2. house_lookup：详情 / 户型图 / 小区 / 板块 / 地名消歧
// ---------------------------------------------------------------------------
export const houseLookupTool = tool(
  async ({ action, mode, city, query, houseId }) => {
    if (action === "detail") {
      if (!city?.trim() || !houseId?.trim()) {
        return badArgs("房源详情需要 city 与 house_id（必须来自 house_search 的真实返回，禁止编造 ID）");
      }
      const r = await houseInfo(mode === "rent" ? "rent" : "buy", "detail", city, houseId);
      return finalize(r);
    }
    if (action === "resolve") {
      if (!query?.trim()) return badArgs("resolve 需要 query（待消歧文本）");
      const r = await houseResolve(query.trim(), city?.trim() || undefined);
      return finalize(r);
    }
    if (!city?.trim()) return badArgs("city 不能为空");
    if (action === "material") {
      if (!houseId?.trim()) return badArgs("户型图/图片需要 house_id（来自 house_search 真实返回）");
      const r = await houseInfo(mode === "rent" ? "rent" : "buy", "material", city, houseId);
      return finalize(r);
    }
    if (!query?.trim()) return badArgs("resblock / plate 需要 query（小区名或板块名）");
    const r = await houseArea(mode === "rent" ? "rent" : "buy", action === "resblock" ? "resblock" : "plate", city, query.trim());
    return finalize(r);
  },
  {
    name: "house_lookup",
    description:
      "房源/小区/板块的深度查询与消歧：action=detail（房源详情，需 house_id 禁止编造）、" +
      "material（**户型图/图片/VR**，需 house_id，用户要看户型图时必调，前端会渲染图片卡）、" +
      "resblock（小区评测）、plate（板块区位评测）、resolve（地名指代不清时先消歧，如「望京」是板块还是小区）。",
    schema: z.object({
      action: z.enum(["detail", "material", "resblock", "plate", "resolve"]).describe("查询类型"),
      mode: z.enum(["buy", "rent"]).default("buy").describe("detail / material 需要指定买租方向"),
      city: z.string().optional().describe("城市名；detail/material/resblock/plate 必填"),
      query: z.string().optional().describe("小区名 / 板块名 / 待消歧文本"),
      houseId: z.string().optional().describe("房源 ID，来自 house_search 返回，禁止编造"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 3. house_market：行情 / 成交 / 榜单 / 学区 / 政策
// ---------------------------------------------------------------------------
export const houseMarketTool = tool(
  async ({ action, mode, city, query }) => {
    if (!city?.trim()) {
      return badArgs("city 必填");
    }
    if (!query?.trim() && action !== "rank" && action !== "district" && action !== "policy") {
      return badArgs("除 rank/district/policy 外都需要 query");
    }
    const mode2: "buy" | "rent" = mode === "rent" ? "rent" : "buy";
    const r = await houseMarket(action, mode2, city.trim(), query?.trim() ?? "");
    return finalize(r);
  },
  {
    name: "house_market",
    description:
      "房产宏观信息：action=market（均价走势，买/租都支持）、sold（近期成交与挂牌差距，仅买）、rank（热门房源/小区榜单）、" +
      "school（学校查询）、district（学区划片覆盖的小区列表）、policy（限购/首付/公积金政策）。" +
      "何时用：用户问行情、成交、政策、学区方向时；这是宏观口径数据，具体房源实时价格以 house_search 为准，" +
      "别把宏观均价说成某套房的实际价格。",
    schema: z.object({
      action: z.enum(["market", "sold", "rank", "school", "district", "policy"]).describe("查询类型"),
      mode: z.enum(["buy", "rent"]).default("buy").describe("market/sold 的买租方向"),
      city: z.string().describe("城市名"),
      query: z.string().optional().describe("区域 / 板块 / 小区 / 学校 等关键词"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 4. house_map：对比区位 → 前端在聊天里渲染地图卡（iframe + 直达链接）
// ---------------------------------------------------------------------------
export const houseMapTool = tool(
  async ({ city, items }) => {
    if (!city?.trim()) return badArgs("city 不能为空：用于提高定位准确率");
    const list = (items ?? []).filter((i) => i?.name?.trim());
    if (!list.length) return badArgs("items 不能为空：每项给 name（小区/楼盘/板块名），可选 address（更精确的地址）");
    const map = await buildCompareMap(
      list.map((i) => ({ name: i.name.trim(), address: i.address?.trim() || undefined })),
      city.trim()
    );
    const rows = map.points.map((p) => `- ${p.name}：(${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}) ${p.address}`);
    const missed = map.geoMissing.map((m) => m.name).join("、");
    return JSON.stringify({
      action: "map",
      city: map.city,
      count: map.points.length,
      missing: missed || undefined,
      missedLinks: map.geoMissing,
      points: map.points,
      embedUrl: map.embedUrl,
      note: `已定位 ${map.points.length}/${list.length} 个地点（最多 ${GEOCODE_LIMITS.maxItems}）。` +
        (missed ? `未能自动定位的可点直达链接手动搜索：${missed}。` : "") +
        `坐标来源：Nominatim（OSM），国内小地名可能偏移，回答时请提醒用户核对。`,
      rows: rows.join("\n"),
    });
  },
  {
    name: "house_map",
    description:
      "把若干房源/小区的地址定位到地图（前端会渲染内嵌地图 + 每个点的直达链接）。" +
      "何时用：用户想对比几套房源的区位分布，或明确说「在地图上看」时必调；" +
      "何时不用：评估单个小房的板块区位请用 house_lookup(action=plate/resblock)。",
    schema: z.object({
      city: z.string().describe("坐标所属城市，如 北京"),
      items: z.array(z.object({
        name: z.string().describe("小区/楼盘名，如 望京 SOHO"),
        address: z.string().optional().describe("可选：更精确的地址（街道 + 门牌）"),
      })).max(8).describe("要对比的地点列表，其中最多 6 个会被定位"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 5. house_agents：经纪人检索 / 详情
// ---------------------------------------------------------------------------
export const houseAgentsTool = tool(
  async ({ mode, action, city, query, agentUcid }) => {
    if (!city?.trim()) return badArgs("city 不能为空");
    if (action === "detail" && !agentUcid?.trim()) {
      return badArgs("agent-detail 需要经纪人 ID（必须来自 house_agents 检索的真实返回，禁止传姓名）");
    }
    if (action === "search" && !query?.trim()) return badArgs("search 需要 query 检索词");
    const r = await houseAgents(mode === "rent" ? "rent" : "buy", action, city.trim(), query?.trim() ?? "", agentUcid);
    return finalize(r);
  },
  {
    name: "house_agents",
    description:
      "经纪人能力：action=search（按城市/需求搜经纪人）、detail（按 agentUcid 查详情，仅真实 ID）。" +
      "何时用：用户想找经纪人、或在筛选/加微流程里需要候选时；获取加微二维码请用 house_contact。",
    schema: z.object({
      mode: z.enum(["buy", "rent"]).default("buy").describe("业务方向"),
      action: z.enum(["search", "detail"]).describe("检索或详情"),
      city: z.string().describe("城市名"),
      query: z.string().optional().describe("检索词（板块 / 小区 / 需求描述）"),
      agentUcid: z.string().optional().describe("经纪人数字 ID（action=detail 必填）"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 6. house_appoint：预约带看（高风险 → 人工审批）
// ---------------------------------------------------------------------------
export const houseAppointTool = tool(
  async ({ houseId, date, start, end }) => {
    if (!houseId?.trim() || !date?.trim()) return badArgs("house_id 与 date 必填，且 house_id 必须来自 house_search 真实返回");
    const r = await houseAppoint(houseId.trim(), date.trim(), start?.trim() || undefined, end?.trim() || undefined);
    return finalize(r);
  },
  {
    name: "house_appoint",
    description:
      "提交带看预约（租房房源）。用户明确说「约看 / 预约 / 明天下午能看吗」且已有 house_search 返回的真实房源 ID 时调用；" +
      "调用前必须向用户复述预约日期与时间段获得确认，系统还会再人工审批一次。禁止对没有 ID 的房源预约。",
    schema: z.object({
      houseId: z.string().describe("房源 ID（beike rent search 真实返回）"),
      date: z.string().describe("预约日期 YYYY-MM-DD"),
      start: z.string().optional().describe("开始小时（24h 制，如 14）"),
      end: z.string().optional().describe("结束小时（24h 制，如 18）"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 7. house_contact：获取经纪人企微二维码（高风险 → 人工审批，对外发起联系）
// ---------------------------------------------------------------------------
export const houseContactTool = tool(
  async ({ mode, city, agentUcid, reason, biz }) => {
    if (!city?.trim() || !agentUcid?.trim() || !reason?.trim()) {
      return badArgs("city / agent_id / reason 都必填；agent_id 必须来自 house_agents 真实返回，禁止传姓名");
    }
    const r = await houseContact(mode === "rent" ? "rent" : "buy", city.trim(), agentUcid.trim(), reason.trim(), biz);
    return finalize(r);
  },
  {
    name: "house_contact",
    description:
      "获取「添加经纪人企微」的二维码（执行后对外发起联系）。仅当用户明确同意加微，或已完成房源推荐流程后主动提议且用户同意时调用；" +
      "reason 是加微成功后经纪人发给客户的欢迎语：≤60 字、面向用户的经纪人口吻（称客户为「您」，不用「我/我们」）、" +
      "从上下文提炼个性化内容（城市/区域/预算/房源），不得承诺房源在售或约看成功。系统会人工审批本次对外联系。",
    schema: z.object({
      mode: z.enum(["buy", "rent"]).default("buy").describe("业务方向"),
      city: z.string().describe("城市名"),
      agentUcid: z.string().describe("经纪人数字 ID（house_agents 真实返回）"),
      reason: z.string().describe("加微欢迎语，≤60 字"),
      biz: z.enum(["二手房", "新房"]).optional().describe("仅买房时：业务线"),
    }),
  }
);

export const estateTools = [
  houseSearchTool, houseLookupTool, houseMarketTool, houseMapTool,
  houseAgentsTool, houseAppointTool, houseContactTool,
];
