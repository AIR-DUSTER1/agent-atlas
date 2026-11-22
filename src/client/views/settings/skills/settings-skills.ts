/**
 * ============================================================
 * views/settings-skills.ts — 技能分区装载入口与状态行（M4 批次 4.2 起）
 * ============================================================
 * 列表/筛选/分页/上传/启停/删除已迁往 Vue（settings-skills-vue.vue +
 * stores/skills.ts）；本文件只保留 legacy 侧职责：
 *  1. #skills-status 状态行写入（Vue 组件与设置壳错误路径共用）；
 *  2. 分区懒加载入口 refreshSkills（供 settings.ts 调用）。
 * 立场：
 *  - 技能新建/修改统一走 skill-creator，页面不做手写 frontmatter 表单；
 *  - Vue 面板与 store 都经动态 import 进入（1:1 过渡树静态图不得出现
 *    .vue 与裸包名 vue/pinia），本模块静态依赖图保持纯 .ts。
 */
import { $ } from "../../../core/dom.js";

let skillStatusTimer: ReturnType<typeof setTimeout> | undefined;

/** 状态行写入（#skills-status，Vue 渲染的无绑定元素）：4 秒后自动清空。 */
export function showSkillStatus(text: string, cls: string): void {
  const el = $("skills-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (cls ? " " + cls : "");
  clearTimeout(skillStatusTimer);
  if (text) {
    skillStatusTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = "settings-status"; }
    }, 4000);
  }
}

/** 进入 skills 分区时懒加载（挂载 + store.refresh 一体在组件 onMounted 完成）。 */
export async function refreshSkills(): Promise<void> {
  void import("./settings-skills-vue.js")
    .then((m) => m.mountSkillsVue())
    .catch(() => {});
}
