/**
 * shims-vue.d.ts — 让 tsc 认识 .vue 单文件组件的导入（M4 批次 4.0）
 * ============================================================
 * tsc 只做类型检查（--noEmit），.vue 的转译由 @vitejs/plugin-vue 承担；
 * 这里仅声明「导入 *.vue 得到的是一个组件定义」，避免 tsc 报 Cannot find module。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
