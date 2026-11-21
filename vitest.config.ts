/**
 * vitest.config.ts — Vue 组件测试配置（框架迁移 M4 批次 4.0）
 * ============================================================
 * 与 vite.config.ts 分离：组件测试跑 happy-dom 环境，只收 tests/vue/**；
 * 存量 node:test 套件（npm test）保持独立运行，两套 runner 不混跑。
 */
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // .vue 的转译同样需要 vue 插件（SFC 预编译），与构建配置保持一致
  plugins: [vue()],
  test: {
    environment: "happy-dom",
    include: ["tests/vue/**/*.test.ts"],
    // Vue 组件用 @vue/test-utils 挂载；fetch 由测试用 vi.stubGlobal 打桩
    globals: false,
  },
});
