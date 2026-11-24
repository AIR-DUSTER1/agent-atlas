/**
 * ============================================================
 * modules/estate-listing-url.ts — 兼容 re-export（共用实现在 src/shared）
 * ============================================================
 * 贝壳租房详情页必须用 rent code、不能用 houseId 数字路径（否则登录后回不到
 * 房源页面，见 src/shared/estate-listing-url.ts 的实测说明）。这里只转发
 * 共用实现，避免前后端各维护两套 URL 逻辑。
 */
export {
  CITY_SUBDOMAIN,
  buildListingUrl,
  isRentCode,
} from "../../shared/estate-listing-url.js";
