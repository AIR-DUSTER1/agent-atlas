/**
 * modules/product.ts — 前端产品标识与版本文案
 * ============================================================
 * 浏览器端单独保留最小品牌常量；client 构建的 rootDir 限定在 src/client，
 * 因此不能反向引用 src/product.ts。服务端与前端的一致性由品牌守门测试校验。
 */
export const PRODUCT_NAME = "agentatlas";