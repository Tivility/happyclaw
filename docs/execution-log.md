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

**提交**：`85b8496`

---

### B-2 · F5 飞书错误日志瘦身

> ⚠️ **实现方式与原决策不同**，依据是动手前的新证据。原决策是「只给飞书上传路径加**流防护**」；实测后改为「飞书 API 错误日志瘦身」。理由见下，若判断不认可可回退。

**原假设**：飞书 503 撕连接 → SDK 内部上传流异步抛 EPIPE → 逃出 `await` 的 try/catch → uncaughtException → `logger.ts:28` 无条件 `exit(1)`。

**动手前的新证据**：量了 7-19 那条日志的实际落盘体积——

```
503 日志起始行 = 1736424   FATAL 行 = 1737827
跨度 = 1403 行 / 48161 bytes
```

`logger.error({ err, chatId, mimeType }, ...)` 收到的是 AxiosError，它的 `request` / `response` / `config` 传递引用了 TLS socket、http agent 及其缓冲区。pino 把整张对象图序列化成了**单条 48 KB / 1403 行**的日志。

而 `logger.ts` 用的是 `transport: { target: 'pino-pretty' }` —— pino 的 transport 走**管道到 worker**，不是直接写文件。48 KB 的巨型写入在飞往该管道的途中，进程随即死于 `write EPIPE`。

**所以更可能的因果是**：不是上传 socket 抛 EPIPE，而是**把 48 KB 错误对象写进 pino transport 管道**时抛的。这也解释了为什么栈里没有任何 userland 帧。

**为什么改了实现方式**：如果病因是日志写入，那"给上传流加防护"防不到它；反过来，把错误对象瘦身则同时消除了噪声与超大写入。而且 `lark.Client` 虽然支持注入 `httpInstance`，但要在第三方 SDK 的流上挂 error 监听仍然做不到——真正能阻止 `exit(1)` 的只有改 `logger.ts` 的 uncaughtException 策略，那正是本决策排除掉的选项。

**落地**

- `src/feishu.ts` 新增 `describeFeishuError(err)`：只保留 `name` / `code`（含 `cause.code`）/ `httpStatus` / `feishuCode` / `feishuMsg`（截 200）/ `message`（截 500）
- 四处错误日志切换：文本回复（:1055）、卡片消息（:2004）、图片发送（:2062）、图片附件（:2000 warn）
- 放在 `classifyFeishuError` 旁边，复用同一套错误字段解析心智模型

**验收**

| 项 | 结果 |
|---|---|
| 新增 `tests/feishu-error-describe.test.ts` | ✅ 6 用例 |
| 循环引用的 socket 对象图 | ✅ 完全丢弃，序列化 < 500 bytes |
| 凭据不泄漏（`config.headers.Authorization`） | ✅ 已验证不出现在输出中 |
| `make typecheck` / `make test` | ✅ 全绿 / 1191 通过 |

**残留风险（诚实记录）**：若那次 EPIPE 其实来自上传 socket 而非日志管道，本次改动不能根治它。但改动之后同类 503 只会产生一条小日志——**下次若再崩，就能凭「日志已瘦身仍崩」直接排除日志管道假设**，指向 socket，届时再决定是否放宽 `logger.ts` 的 EPIPE 策略。

**数据备份**：不涉及（纯日志序列化改动）。

**提交**：`7070477`

---

### B-3 · F6 SDK 自动更新门禁

**背景**：`Makefile` 的 `ensure-latest-sdk` 有两个缺陷，7-19 那次自动更新把两个都触发了。

**缺陷一 · 构建失败被吞掉**

```make
(cd container/agent-runner && $(PKG) update ... && $(PKG) run build); \
```

`npm run build` 就是 `tsc`。0.3.215 的类型破坏**当时已经完整打进日志**，但整条命令以 `;` 结尾——make 只看最后一条命令的退出码，失败被吞，随后照样打印「✅ SDK 更新完成」。所以门禁不是"要多跑一次检查"，是**别再吞掉已有的失败信号**，成本≈0。

**缺陷二 · `npm update` 裁掉 devDependencies**

plist 里有 `NODE_ENV=production`，npm 在该模式下连带 prune 掉已装的 devDependencies。这就是 P9 的根因——启动脚本每次跑 SDK 自检，第一次真更新就把 vitest / prettier / tsx / `@types/*` 清了。

**落地**（`ensure-latest-sdk` + `ensure-latest-codex-sdk` 两个 target 同样处理）

- 所有 `npm update` / `npm install` 加 `--include=dev`，根治 devDeps 被裁
- 构建包进 `if (...); then ... else ... fi`：成功才写回 `package.json` 的 `"*"`；失败则回滚到更新前版本并重新构建，最后 `exit 1`
- 回滚前判断 `!= "0.0.0"`（此前未安装则无版本可回滚，明确提示而非误装）
- agent-runner 构建失败时**跳过主服务的 SDK 更新**，避免两侧版本分叉
- `exit 1` 由 `scripts/launchd-start.sh` 现有的 `|| { ... }` 兜住，服务继续用回滚后的 SDK 启动，不会因此起不来

**验收**

| 项 | 结果 |
|---|---|
| `make -n` make 层语法 | ✅ |
| **真实更新 0.3.215 → 0.3.220** | ✅ 构建通过，走成功分支 |
| `--include=dev` 效果 | ✅ **同一步操作此前会裁掉 devDeps，本次 vitest / prettier / tsx / `@types/*` 全部存活** |
| 新 SDK 下 `make typecheck` | ✅ 三项目全绿 |
| 新 SDK 下 `make test` | ✅ 1191 通过 |
| 失败分支的 shell 逻辑 | ✅ 用强制失败替代 npm 验证：报错 → 回滚提示 → 跳过主服务 → exit 1；`0.0.0` 无版本可回滚的分支也正确 |

**未端到端验证的部分（诚实记录）**：失败分支里的 `npm install <上一版本> && npm run build` 这一段没有真实跑过——需要一个"能装上但构建失败"的 SDK 版本才能触发，而 0.3.220 构建是通过的。已验证的是分支结构、提示与退出码；npm 回滚命令本身与成功路径用的是同一套 `$(PKG) install --include=dev` 形式。

**数据备份**：`package.json` 两处 SDK 版本行由 git 管住；更新前已记录 `agent-runner=0.3.215 / root=0.3.215` 作为回滚基准。node_modules 可由 `npm install` 重建。

**副产物**：本次顺带把 SDK 升到 0.3.220，且 P10 的类型放宽让它平稳通过——正是门禁想保证的效果。
