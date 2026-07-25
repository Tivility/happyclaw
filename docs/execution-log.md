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

**提交**：`a5dc230`

---

## 阶段 B · 独立修复

### B-1 · F3 会话隔离（P2 + P3）

**背景**：从任一对话点「重置会话」会 force-kill 同 folder 下所有 runner。根因是 `registered_groups.folder` 与实际执行位置脱钩——IM 群按 §8.2 自动注册到 owner 的 home folder，之后 `target_main_jid` 被指向独立工作区，但 `folder` 列没跟着改。生产库实测：`folder='main'` 收了 **24 个 JID，其中 21 个实际在别的工作区执行**。

`getJidsByFolder()` 回答的是「哪些行的 folder 列 = X」，而 stop/interrupt 想问的是「哪些 JID 实际在 X 里执行」。两个问题在这 21 行上答案不同。

**方案**（①②③，不做 ④——阶段 E 批次 7 会退役整套机制）

| # | 改动 |
|---|---|
| ① | `db.ts` 新增 `getJidsExecutingInFolder(folder)` |
| ② | `routes/groups.ts` 会话重置（:1092）与删除工作区（:900）改用新函数 |
| ③ | 序列化键改为按「执行 folder」计算 |

②③ 必须同时做：只改 ③ 会让重置 main 时那 21 个 JID 解析到各自目标 runner 然后停掉它们，**比原状更糟**。

**落地**

- `src/db.ts` — 新增 `getJidsExecutingInFolder`。其余 28 处 `getJidsByFolder` 调用点**不动**（ACL、model 绑定传播、cursor 推进、runtime 属性继承要的确实是 folder 列语义）
- `src/routes/groups.ts` — 两处调用点切换 + import
- `src/task-routing.ts` — 把整个 resolver 抽成纯函数 `resolveExecutingFolder` / `resolveSerializationKey`。**没有沿用现有测试的「镜像 resolver」写法**——那种写法测的是副本不是生产代码（`group-queue-descendants.test.ts` 的注释自己也写着「If the real resolver changes, update both sides」）。抽成纯函数后测试直接覆盖真实逻辑
- `src/index.ts` — `setSerializationKeyResolver` 改为调用纯函数；用内存 `registeredGroups` 而非 DB 查询（队列在 per-group 扫描里调它，DB 往返会变成 O(n) 次查询）

**测试过程中发现并修掉一个自己引入的 bug**

首版 SQL 的 `WHERE ... (g.target_main_jid IS NULL OR t.folder = g.folder)` 在**悬空指针**（target 行已删除）时把行整个丢掉——`t.folder` 为 NULL，比较结果非真。后果是那一行永远不会被 stop/delete 命中，**留下一个停不掉的 runner**。加 `t.jid IS NULL` 分支，让悬空指针退回「按自身 folder 处理」。

纯函数版本 `resolveExecutingFolder` 本来就处理对了（`target?.folder || group.folder`），是 SQL 侧漏了。两侧现在语义一致。

**验收**

| 项 | 结果 |
|---|---|
| 生产库实测 `getJidsExecutingInFolder('main')` | ✅ **24 → 3**，剩下的正是真正在 main 执行的三个：`web:main` / 飞书私聊 / QQ |
| 新增 `tests/serialization-key-routing.test.ts` | ✅ 12 用例（含悬空指针、自引用绑定、agent/task 虚拟 JID、含冒号的 agentId） |
| 新增 `tests/jids-executing-in-folder.test.ts` | ✅ 7 用例（含 `getJidsByFolder` 基线未变） |
| `group-queue-initiator` / `runtime-boundary` / `descendants` | ✅ 全绿 |
| `make typecheck` | ✅ 三项目全绿 |
| `make test` | ✅ 105 文件 / 1185 通过 / 1 skipped |

**影响面**：`folder` 列一个字节未动 → ACL（`web-context.ts:297/340`）、`30a240a` 的重路由特例、注册逻辑（`index.ts:8999`）、`web.ts:1995` 全部零影响。用户侧无功能变化，只是误杀停止。

**数据备份**：不涉及（无 schema 变更、无数据写入；新增函数是只读查询）。

**退役时间**：阶段 E 批次 7 引入 `channel_mounts` 后，这三处改动连同 `target_main_jid` 一起删除。
