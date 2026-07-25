# 落地执行日志

> 方案见 [implementation-plan.md](./implementation-plan.md) · 决策见 [decision-brief.md](./decision-brief.md)
> 每步记录：改动方案 → 实际落地 → 验收结果。不可逆改动前的备份记录一并留档。

---

## 阶段 A · 门禁恢复

### A-1 · P9 恢复被裁剪的 devDependencies

**背景**：launchd 迁移后，plist 的 `NODE_ENV=production` 叠加 `launchd-start.sh` 每次启动跑 `make ensure-latest-sdk`（内含 `npm update`），导致 npm 连带 prune 掉 devDependencies。7-19 那次 SDK 自动更新触发了它。

**方案**：`npm install --include=dev`

**落地**：已执行。`vitest` / `typescript` / `prettier` / `tsx` / `@types/qrcode` / `@types/better-sqlite3` 全部恢复。`package-lock.json` 无变化（说明依赖声明本来就在，只是物理缺失）。

**长期修复**：见 B-3（F6 门禁），把 `--include=dev` 与失败回滚一并处理。

### A-2 · P10 `queryRef` 类型放宽

**背景**：SDK 0.3.210 → 0.3.215 把 `Query.interrupt()` 的返回类型从 `Promise<void>` 改为 `Promise<SDKControlInterruptResponse | undefined>`，而 `agent-runner/src/index.ts:1293` 把 `queryRef` 钉死成 `{ interrupt(): Promise<void> }`，赋值不再兼容。`tsc` 带错仍输出 JS，所以运行时正常，但 typecheck 门禁红。

**方案**：把返回类型放宽为 `Promise<unknown>`（所有调用点都丢弃返回值），并注释说明为何不钉死——避免下次 SDK 变签名时重复踩。

**落地**：`container/agent-runner/src/index.ts:1292-1296`

```ts
// queryRef is set just before the for-await loop so pollIpcDuringQuery can call interrupt().
// The return type stays `Promise<unknown>` on purpose: the SDK's Query.interrupt() resolves to
// SDKControlInterruptResponse | undefined, and every caller here discards the value. Pinning it
// to Promise<void> made agent-runner fail typecheck on the 0.3.210 → 0.3.215 SDK bump.
let queryRef: { interrupt(): Promise<unknown> } | null = null;
```

**验收**

| 项 | 结果 |
|---|---|
| `make typecheck`（后端 / web / agent-runner） | ✅ 三项目全绿 |
| shared 类型副本同步校验 | ✅ in sync |
| prompt 引用校验 | ✅ 8/8 resolved |
| `make test` | ✅ 103 文件 / 1166 通过 / 1 skipped |

**数据备份**：不涉及（纯类型声明改动，无数据/schema 变更）。

**意义**：这是后续所有验证的基线。此前两条门禁都是红的，任何改动都无法区分「新破坏」与「存量破坏」。
