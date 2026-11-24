/**
 * ============================================================
 * shared/estate-listing-url.ts — 贝壳房源详情页链接构造（前后端共用）
 * ============================================================
 * 为什么需要：贝壳租房详情页的真实路径参数是 **rent_code**（如
 * `QD2232327398555123712`），不是 CLI 的 houseId（纯数字实体 ID）。
 * 用 houseId 拼出来的 `https://{city}.zu.ke.com/zufang/{houseId}.html`
 * 会 302 到登录页，登录后回不了房源路径，最终显示「访问资源不存在」。
 *
 * 实测（2026-11，青岛租房）：
 *  - 正确链接（移动端，登录 service 带完整回跳路径）：
 *    https://m.ke.com/chuzu/qd/zufang/{rentCode}.html
 *  - houseId → rentCode 无法从 CLI houseId 推导；必须从搜索结果携带的
 *    metadata.rent_codes / entity_ids 里按顺序映射。
 *  - 没有合法 rentCode 时不生成链接（宁可没有入口，也不跳错城市/资源）。
 *  - 二手房仍保留 `{sub}.ke.com/ershoufang/{houseId}.html`（该站路径
 *    参数就是 houseId，沿用现有约定）。
 *  - `src/client/modules/estate-listing-url.ts` 只作 re-export 兼容，不重复实现。
 */
export const CITY_SUBDOMAIN: Readonly<Record<string, string>> = {
  北京: "bj", 上海: "sh", 广州: "gz", 深圳: "sz",
  成都: "cd", 杭州: "hz", 天津: "tj", 南京: "nj", 武汉: "wh", 西安: "xa",
  重庆: "cq", 苏州: "su", 长沙: "cs", 郑州: "zz", 东莞: "dg", 青岛: "qd",
  沈阳: "sy", 宁波: "nb", 昆明: "km", 合肥: "hf", 佛山: "fs", 无锡: "wx",
  济南: "jn", 大连: "dl", 厦门: "xm", 福州: "fz", 哈尔滨: "hrb", 长春: "cc",
  石家庄: "sjz", 太原: "ty", 南昌: "nc", 贵阳: "gy", 南宁: "nn", 兰州: "lz",
  海口: "hk", 珠海: "zh", 中山: "zs", 惠州: "huizhou", 常州: "cz", 徐州: "xz",
  烟台: "yt", 潍坊: "wf", 温州: "wz", 嘉兴: "jx", 绍兴: "sx", 台州: "tz",
  泉州: "qz", 金华: "jh", 保定: "bd", 廊坊: "lf", 洛阳: "ly", 唐山: "ts",
};

/** 贝壳租房 rent code：城市短码 + 超长数字（如 QD2232327398555123712）。 */
export const RENT_CODE_RE = /^[A-Z]{1,4}\d{10,}$/i;

function normalizeCity(raw: string): string {
  return raw.trim().replace(/\s+/g, "").replace(/市$/, "");
}

function normalizeRentCode(value: string | undefined): string {
  const code = (value ?? "").trim();
  return RENT_CODE_RE.test(code) ? code.toUpperCase() : "";
}

/**
 * 构造房源详情页 URL。
 * 二手房用 houseId；租房优先用 rentCode（移动端真实路径），没有 rentCode
 * 绝不回退到 houseId 数字路径 —— 数字路径会导致登录后找不到资源。
 * @returns 合法 https 链接；缺少必要字段时返回 null。
 */
export function buildListingUrl(
  city: string | undefined,
  houseId: string | undefined,
  kind: "rent" | "buy" = "rent",
  rentCode?: string,
): string | null {
  const sub = CITY_SUBDOMAIN[normalizeCity(city ?? "")];
  if (!sub) return null;
  if (kind === "rent") {
    const code = normalizeRentCode(rentCode);
    return code ? `https://m.ke.com/chuzu/${sub}/zufang/${code}.html` : null;
  }
  const id = (houseId ?? "").trim();
  if (!/^\d{6,20}$/.test(id)) return null;
  return `https://${sub}.ke.com/ershoufang/${id}.html`;
}

/** 校验路径参数是否为合法贝壳租房编码（供服务端归一/Excel 复用）。 */
export function isRentCode(value: string | undefined): boolean {
  return Boolean(normalizeRentCode(value));
}
