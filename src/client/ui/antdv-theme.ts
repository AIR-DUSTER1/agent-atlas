/**
 * ============================================================
 * ui/antdv-theme.ts — antdv-next 主题种子表（antdv 接入基线）
 * ============================================================
 * 职责：把 antdv 的 design token 值定义成与本项目语义 token 同源的常量。
 *
 * 为什么必须是**纯数据模块、零 import**：
 *  - 组件库的 `theme.darkAlgorithm` 是值（函数），一旦在这里 import 就会
 *    把 antdv 运行时拖进这个模块；虽然当前它只被 .vue 懒加载链引用，
 *    但「主题数据」和「组件库运行时」混在一个文件里，早晚会有人从 .ts
 *    首屏模块 import 了种子表、顺手把整包组件库拖进启动闭包；
 *  - 拆开后可以立一条零例外的规则：**所有 .ts 文件都不得 import antdv-next**，
 *    组件库的 import 全部集中在 .vue（由 tests/unit/antdv-usage.test.ts 断言）。
 *
 * 立场：
 *  - 这里的十六进制必须与 styles/tokens.css 一致，改一处要同步另一处；
 *    tests/unit/antdv-usage.test.ts 会逐键比对，漂移即红；
 *  - 只定义「值」，不定义 algorithm —— 深/浅算法选择在
 *    ui/antdv-provider.vue 里根据当前主题决定。
 */

/** 与 styles/tokens.css 深色主题保持一致的种子色（改这里必须同步 CSS）。 */
export const ANTDV_DARK_SEEDS = {
  /** tokens.css --accent */
  colorPrimary: "#5b8cff",
  /** tokens.css --bg */
  colorBgBase: "#1b1c1f",
  /** tokens.css --bg-elev */
  colorBgContainer: "#232428",
  /** tokens.css --border */
  colorBorder: "#2e2f35",
  /** tokens.css --text */
  colorText: "#e6e6ea",
  /** tokens.css --text-2 */
  colorTextSecondary: "#9b9ba4",
  /** tokens.css --green */
  colorSuccess: "#3fb96f",
  /** tokens.css --red */
  colorError: "#e5604f",
  /** tokens.css --amber */
  colorWarning: "#e2a13c",
} as const;

/** 与 styles/tokens.css 浅色主题保持一致的种子色（改这里必须同步 CSS）。 */
export const ANTDV_LIGHT_SEEDS = {
  /** tokens.css 浅色 --accent */
  colorPrimary: "#3c5fd9",
  /** tokens.css 浅色 --bg */
  colorBgBase: "#f7f8fa",
  /** tokens.css 浅色 --bg-elev */
  colorBgContainer: "#ffffff",
  /** tokens.css 浅色 --border */
  colorBorder: "#d9dce3",
  /** tokens.css 浅色 --text */
  colorText: "#242830",
  /** tokens.css 浅色 --text-2 */
  colorTextSecondary: "#575e6c",
  colorSuccess: "#1d9e5e",
  colorError: "#d64a3a",
  colorWarning: "#b07a17",
} as const;

/**
 * 主题无关的共享约束：圆角与项目 token 对齐（--radius-md 9px / --radius-sm 6px），
 * 字号继承项目阶梯（--font-sm 12px / --font-md 13px），避免组件自带 14px 正文
 * 在设置页里比周围文字大一号；焦点环由项目 tokens.css 提供，故线宽置 0。
 */
export const ANTDV_SHARED_TOKEN = {
  borderRadius: 9,
  borderRadiusSM: 6,
  borderRadiusLG: 14,
  fontSize: 13,
  fontSizeSM: 12,
  fontSizeLG: 15,
  /**
   * 组件内部字号单独钉死为 13px：antdv 的 Button / Select 等在 default 尺寸下
   * 用的是派生值（实测渲染出 12.5px），与项目 `.ghost-btn` 的 13px 相差半像素，
   * 混排时能看出粗细不一。这里显式对齐项目字号阶梯 --font-md。
   */
  fontSizeIcon: 12,
  fontFamily: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  controlHeight: 34,
  controlHeightSM: 28,
  controlHeightLG: 38,
  lineWidthFocus: 0,
} as const;
