import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Scope vitest's root-level discovery to project tests only.
// `data/` holds the user's agent scratch workspaces (gitignored) which can
// contain nested projects with their own test suites; vitest does not respect
// .gitignore, so we must exclude explicitly.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      react: fileURLToPath(
        new URL('./web/node_modules/react', import.meta.url),
      ),
      'react-dom': fileURLToPath(
        new URL('./web/node_modules/react-dom', import.meta.url),
      ),
      'react-router-dom': fileURLToPath(
        new URL('./web/node_modules/react-router-dom', import.meta.url),
      ),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'data/**', '.claude/**'],
    // 固定时区：用量记账按本地日期（toLocalDateString）分桶，测试里的
    // createdAt 都写成 UTC 时刻。不锁 TZ 的话，同一份用例在 UTC 机器上通过、
    // 在 UTC-7 机器上会整体差一天而失败。
    env: { TZ: 'UTC' },
  },
});
