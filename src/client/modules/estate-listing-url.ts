/**
 * ============================================================
 * modules/estate-listing-url.ts — 贝壳房源详情页链接（城市子域映射）
 * ============================================================
 * 为什么需要：结论表里「有 VR 标记 · 专属入口未返回」是一条死文案 —— 用户
 * 看到"有 VR"却点不动。改为「在贝壳查看该房源」后可跳转到真实房源页。
 *
 * 关键约束（实测 2026-11）：
 *  - 贝壳详情页必须带**城市子域**：`{拼音}.zu.ke.com/zufang/{houseId}.html`（租房）
 *    或 `{拼音}.ke.com/ershoufang/{houseId}.html`（二手房）。
 *    `www.ke.com/zufang/{id}.html` 是 404，不能当通用地址。
 *  - 网页端强制登录：真房源与伪造 ID 都 302 到 clogin.ke.com，服务端无法验证
 *    链接真伪。因此这里只保证**格式与城市正确**，跳过去是否需登录由贝壳决定。
 *  - 城市拼音不能从接口数据推导（MCP 只回中文 city 名与国标 city_id），所以维护
 *    一份「城市中文名 → 子域拼音」表；未收录的城市一律不生成链接（降级为纯文字），
 *    宁可没有链接，也不给一个跳错城市的地址。
 */
/**
 * 贝壳有站点的城市 → 子域拼音。只收录已确认存在站点的城市；
 * 未收录城市的房源不会生成链接（见 buildListingUrl 的降级）。
 * 增补时请确认真实站点存在：`curl -I https://{拼音}.zu.ke.com/` 不应连接失败。
 */
export const CITY_SUBDOMAIN: Readonly<Record<string, string>> = {
  // 一线
  北京: "bj", 上海: "sh", 广州: "gz", 深圳: "sz",
  // 新一线 / 强二线
  成都: "cd", 杭州: "hz", 天津: "tj", 南京: "nj", 武汉: "wh", 西安: "xa",
  重庆: "cq", 苏州: "su", 长沙: "cs", 郑州: "zz", 东莞: "dg", 青岛: "qd",
  沈阳: "sy", 宁波: "nb", 昆明: "km", 合肥: "hf", 佛山: "fs", 无锡: "wx",
  // 其他常见
  济南: "jn", 大连: "dl", 厦门: "xm", 福州: "fz", 哈尔滨: "hrb", 长春: "cc",
  石家庄: "sjz", 太原: "ty", 南昌: "nc", 贵阳: "gy", 南宁: "nn", 兰州: "lz",
  海口: "hk", 珠海: "zh", 中山: "zs", 惠州: "huizhou", 常州: "cz", 徐州: "xz",
  烟台: "yt", 潍坊: "wf", 温州: "wz", 嘉兴: "jx", 绍兴: "sx", 台州: "tz",
  泉州: "qz", 金华: "jh", 保定: "bd", 廊坊: "lf", 洛阳: "ly", 唐山: "ts",
};

/** 城市名归一：去掉「市」后缀与空白，便于「青岛市」→「青岛」。 */
function normalizeCity(raw: string): string {
  return raw.trim().replace(/\s+/g, "").replace(/市$/, "");
}

/**
 * 构造房源详情页 URL。
 * @returns 合法 https 链接；城市未知或 houseId 非法时返回 null（调用方降级为纯文字）。
 */
export function buildListingUrl(
  city: string | undefined,
  houseId: string | undefined,
  kind: "rent" | "buy" = "rent",
): string | null {
  const id = (houseId ?? "").trim();
  // 贝壳房源 ID 是纯数字（实测 12 位，放宽到 6–20 位）；带其他字符一律拒绝，
  // 避免把模型编造的内容拼进 URL。
  if (!/^\d{6,20}$/.test(id)) return null;
  const sub = CITY_SUBDOMAIN[normalizeCity(city ?? "")];
  if (!sub) return null;
  // 租房走 zu 子域 + /zufang/；二手房走主站 + /ershoufang/。
  return kind === "rent"
    ? `https://${sub}.zu.ke.com/zufang/${id}.html`
    : `https://${sub}.ke.com/ershoufang/${id}.html`;
}
