/**
 * product.ts — 产品级标识常量
 * ============================================================
 * 统一后端横幅、模型网关、网页抓取与 MCP 客户端身份；品牌只在这里
 * 维护一次，避免更名后不同出口仍残留旧标识。
 */
export const PRODUCT_NAME = "agentatlas";
export const PRODUCT_USER_AGENT = `${PRODUCT_NAME}/1.0`;
export const PRODUCT_MCP_CLIENT_VERSION = "1.0.0";