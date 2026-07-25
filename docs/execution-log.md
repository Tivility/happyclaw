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

**提交**：`fdaeb14`

---

### B-4 · O2 日志轮转（每天一次，历史全保留）

**背景**：launchd 把 stdout/stderr 直接重定向到 `data/launchd-*.log` 且从不轮转，实测已涨到 **92 MB + 28 MB，约 9 MB/天无上限**。

**为什么用 copy-and-truncate 而不是 rename**：launchd 自己持有 `StandardOutPath` / `StandardErrorPath` 的文件描述符，直到服务重启为止。`mv` 之后 launchd 继续往**同一个 inode**（现在换了路径）写，原路径上的新文件永远是空的——这是 launchd/systemd 托管日志的经典轮转陷阱。truncate 保住 inode，服务不必重启也不丢行。

**为什么调度放在进程内而不是第二个 launchd agent**：CLAUDE.md §10 明确「禁止手动创建 launchd plist」，且 `make launchd-install` 会扫描 `com.happyclaw*.plist`，发现任何非主 plist 就报错退出（历史上双 plist 造成过 crash loop）。所以按项目已有的 `setInterval` 模式（对照 `periodicPluginScanInterval`）做进程内每日定时。

**落地**

- 新增 `scripts/rotate-logs.sh`：gzip 归档到 `data/logs-archive/{name}-{date}.log.gz` → `sync` → truncate。**先归档、确认落盘后才 truncate**，中途崩溃只会多一份归档，不会丢日志。空文件跳过；同日二次运行加数字后缀而非覆盖
- `src/index.ts` 加每日定时器 `logRotationInterval`（24h），关停时 `clearInterval`
- 脚本内置**稀疏检测** `check_sparse()`：若 launchd 其实没用 `O_APPEND`，truncate 后描述符保留旧偏移，内核会填空洞——表现为「表观体积大、实际占块接近零」。检测到该背离就明确告警并给出替代方案，而不是静默轮转稀疏文件

**验收**

| 项 | 结果 |
|---|---|
| `bash -n` 语法 | ✅ |
| 首次真实轮转 | ✅ **110 MB → 3.4 MB 归档（32× 压缩）**，两个日志清零 |
| 幂等性（空文件重跑） | ✅ 正确跳过，不产生空归档 |
| 服务在 truncate 后仍健康 | ✅ `/api/health` healthy；审计表确认请求仍在处理（`login_failed` 探针记录） |
| `make typecheck` / `make test` | ✅ 全绿 / 1191 通过 |

**✅ append 模式已实测确认（追加验证）**

truncate 后挂后台观察，等到第一条真实写入（05:54:50 的 `plugin-importer: scan complete`）：

```
data/launchd-stdout.log: 表观 224 bytes / 占块 4 KB
```

判定逻辑：truncate 前该文件 82 MB。若 launchd **没有**用 `O_APPEND`，描述符会保留约 82 MB 的旧偏移，这次写入会落在那个位置，形成稀疏文件——**表观约 82 MB、占块仅 4 KB**。实测表观 224 bytes 与占块 4 KB（单个文件系统块）一致，**没有空洞**。

⇒ **launchd 使用 `O_APPEND`，copy-and-truncate 对这两个日志是安全的**：服务无需重启即继续正常写入，不丢行、不产生稀疏文件。内容也确认完整（时间戳、级别、pid、结构化字段都正常）。

脚本里的 `check_sparse()` 作为长期回归保险保留——若将来 macOS/launchd 行为变化，下次轮转会立即报出。

此前排除的两个不足为证的观察：`lsof -o` 读到偏移 0（macOS 上该列可能显示 SIZE 而非 OFFSET）；404 请求与登录失败都不产生 info 级日志（服务确实在处理，审计表有 `login_failed` 记录）。

**数据备份**：轮转本身即备份——原始 110 MB 日志已完整 gzip 归档在 `data/logs-archive/`（`data/` 已在 .gitignore 中）。

**提交**：`12029c6`

---

### B-5 · P12 僵尸 Chrome 清理（a + b）

**根因**：agent-browser 为了让 `@e1` 这类元素引用**跨多次 CLI 调用保持有效**，必须维持一个常驻浏览器进程，而且它是 detached 的——脱离 agent-runner 的进程组，`killProcessTree(-pid)` 收不到。三个条件叠加导致累积：常驻设计 + agent 用完不 close + HappyClaw 无退出清理（在 agent-runner 与 container-runner 里搜 `agent-browser|chromium` 曾**零匹配**）。曾累积到 43 个进程 / 772% CPU / 17% 内存。

**调研结论：不需要 pid 匹配**

agent-browser 是编译好的原生二进制（`agent-browser-darwin-arm64`），读不到源码，但 CLI 自带隔离机制：

```
--session <name>        Isolated session (or AGENT_BROWSER_SESSION env)
session list            List active sessions
close [--all]           Close browser (--all closes every session)
```

于是清理可以**按会话名精确定位**，而不是靠进程名/pid 猜——这是关键，因为 pid 匹配无法可靠区分"agent 起的 Chromium"和"操作者自己的 Chrome"。

**落地**

- **a · `container/skills/agent-browser/SKILL.md`**：核心流程加第 5 步「必须 `agent-browser close`」，并新增「用完必须关闭」小节，解释常驻+detached 的原因、给出 `session list` 排查方法、明确**禁止 `close --all`**（会关掉机器上所有会话，影响其他工作区）
- **b · `src/container-runner.ts`**：
  - `hostEnv` 注入 `AGENT_BROWSER_SESSION=hc-{folder}[-{agentId}]`，让每次宿主机运行拥有独立会话
  - `proc.on('close')` 里 fire-and-forget 执行 `agent-browser --session <name> close`，15s 超时，失败只记 debug（未起过浏览器的运行本就非零退出）
  - **仅宿主机模式需要**：docker 模式下 Chromium 活在 `--rm` 容器内，容器销毁即回收

**验收（端到端实测）**

| 步骤 | 结果 |
|---|---|
| `AGENT_BROWSER_SESSION=hc-probe-test agent-browser open ...` | ✅ 退出码 0 |
| `agent-browser session list` | ✅ 显示 `hc-probe-test`，会话隔离生效 |
| `agent-browser --session hc-probe-test close` | ✅ `✓ Browser closed` |
| 清理后 `session list` | ✅ `No active sessions` |
| 清理后 chromium 残留进程 | ✅ **0** |
| `make typecheck` / `make test` | ✅ 全绿 / 1191 通过 |

**设计取舍**：a 是降低产生率（提示词层，不可靠），b 是兜底根治。两者都做的理由是 b 只在 agent 进程退出时触发——中途换任务、长时间不退出的会话仍会占资源，所以仍需 a 要求 agent 主动关闭。SKILL.md 里明确写了「b 是兜底不是替代」。

**数据备份**：不涉及（无数据/schema 变更）。

**提交**：`0d9e892`

---

## 阶段 A + B 小结

| 阶段 | 内容 | 提交 |
|---|---|---|
| A-1 | P9 恢复 devDependencies | （随 A-2） |
| A-2 | P10 `queryRef` 类型放宽 | `a5dc230` |
| B-1 | F3 重置/中断不再跨工作区误杀 | `85b8496` |
| B-2 | F5 飞书 API 错误日志瘦身 | `7070477` |
| B-3 | F6 SDK 更新构建门禁 + 根治 devDeps 被裁 | `fdaeb14` |
| B-4 | O2 日志每日轮转（全归档） | `12029c6` |
| B-5 | P12 agent-browser 会话按名清理 | `0d9e892` |

**门禁状态**：`make typecheck` 三项目全绿；`make test` 105 文件 / 1191 通过 / 1 skipped（本阶段新增 32 个用例）。

**过程中修掉的自引入缺陷 1 个**：F3 首版 SQL 在悬空指针下丢行，会留下停不掉的 runner——由新增测试捕获。

**实现方式与原决策不同的 1 项**：F5 由「上传流防护」改为「错误日志瘦身」，依据是实测那条日志跨 1403 行 / 48 KB，且 pino 走 transport 管道。已在 B-2 记录理由与残留风险。

### ⚠️ 部署状态：改动尚未生效

运行中的服务是 **2026-07-19 01:54 启动**的，加载的是旧 `dist`。本次 `make build` 已通过（`dist/index.js` 更新至 07-25 05:26），但：

- **F3 / F5 / O2 / P12 都在主服务进程内**，需要 `make launchd-restart` 才生效
- agent-runner 侧改动（P10）行为中立，且新 spawn 会自动读新 dist
- 未自行重启：重启会中断进行中的 agent 任务并重连所有 IM 渠道，交由使用者选择时机

### 待验证项（需重启后观察）

1. ~~**O2 的 append 模式判定**~~ — ✅ **已实测确认**（见 B-4）：truncate 后首次写入为 224 bytes 表观 / 4 KB 占块，无稀疏空洞，`O_APPEND` 成立，copy-and-truncate 安全。**无需重启即已生效**
2. **F3 的实机效果**：从飞书群侧点重置，确认只停它路由到的工作区
3. **P12 的实机效果**：跑一次用到浏览器的任务，确认退出后 `agent-browser session list` 为空

---

## 阶段 C · 无状态摘取

### C-2a · F1 后台子 Agent 挂流（核心修复）

> 这是本次全部改动里**用户体感最强**的一项：修的是「稍微长点的任务都会失败」。

**根因**（`container/agent-runner/src/index.ts`）

```ts
const POST_RESULT_TIMEOUT_MS = 5_000;
if (resultReceivedAt && Date.now() - resultReceivedAt > POST_RESULT_TIMEOUT_MS) {
  interruptQueryForShutdown('Post-result timeout');   // ← 连坐杀掉后台子 Agent
  stream.end();
}
```

主 Agent 一输出最终文本，**5 秒后无条件关流**，仍在跑的后台子 Agent 被一起 interrupt。而本地 `getPendingSdkTaskCount` 出现次数为 **0/0**——根本没有能力知道还有几个后台任务在跑。

**实测受害**（从工作区日志捞出）：`AI music generation research` ×2、`认知维度提取` / `知识维度提取` / `交互维度提取` 各 1、`Cognitive / Knowledge / Interaction extraction round 2` 各 1 —— **认知管线两轮六个子 Agent 全灭**。

失败还是静默的：`agents` 表不记录 SDK Task（前端按「虚拟 Agent」处理），StreamEvent 也不落库，所以只有下一轮 resume 时 SDK 才报 `No completion record was found for background agent` ——**那是尸检报告，不是死因**。

**落地**（移植 upstream `0cc9993`，适配本地三运行时架构）

`stream-processor.ts`：
- 新增 `pendingSdkTasks` Map + `SDK_TERMINAL_TASK_STATUSES`
- `task_started`（`!skip_transcript`）登记；housekeeping 任务不登记，避免内部任务卡住收尾
- `task_updated` 标记 `is_backgrounded`，终态状态时 settle
- `processTaskNotification` **无条件 settle** —— 第二条兜底路径，不依赖 `task_updated` 是否报过终态（漏 settle 会永久推迟关流）
- 三个查询接口：`getPendingSdkTaskCount` / `getBlockingPendingSdkTaskCount` / `describePendingSdkTasks`

`index.ts` 关流判定：
- 有 blocking 任务时 `resultReceivedAt = null` 撤销倒计时，并 emit「N 个后台任务运行中」状态事件
- **用 blocking 口径而非总数**（F2 决策）：已 backgrounded 的 `local_bash`（dev server、`tail -f`）设计上就活过本 turn，等它只会把流挂到 IDLE_TIMEOUT
- 两个 `resultReceivedAt = Date.now()` 重置点仍在（:1697 / :1917），后台任务 settle 后新 result 会重新起算倒计时并正常关流；永不 settle 的由 IDLE_TIMEOUT / CONTAINER_TIMEOUT 兜底

**三运行时安全性**：Codex/Grok 不产生 SDK `task_started` 系统消息，`getBlockingPendingSdkTaskCount()` 恒为 0，走原有关流路径——**自然降级，不误伤**。

**验收**

| 项 | 结果 |
|---|---|
| 新增 `tests/pending-sdk-tasks.test.ts` | ✅ 14 用例 |
| 三终态状态（completed/failed/killed）均 settle | ✅ |
| 非终态状态保持 pending | ✅ |
| 并发三任务独立 settle（认知管线形态） | ✅ |
| `skip_transcript` 不登记 | ✅ |
| 未知 task_id settle 是 no-op、重复 settle 不下溢 | ✅ |
| backgrounded `local_bash` 计入总数但不计入 blocking | ✅ |
| backgrounded **Agent** 仍计入 blocking（只豁免 local_bash） | ✅ |
| `make typecheck` / `make test` | ✅ 全绿 / **1205 通过** |

**过程中修掉的测试缺陷 1 个**：我对 `shorten(s, 80)` 的断言写成了 ≤81，实际是「截 80 + `...`」= 83。改的是测试不是实现。

**数据备份**：不涉及（无数据/schema 变更）。

**待实机验证**：需重启后跑一轮认知管线，确认三个维度子 Agent **都有产出**（对照修复前 6/6 全灭）。

### C-2b · F2 完成通知 —— 查证结论：**无需改动**

原计划要为 F2（「过程放挂起卡、结果发新消息」）写本地增强。读完本地实现后确认**现有行为已经满足**，反而是移植 upstream 会破坏它。

**证据链**

1. **状态横幅已通**：C-2a 新增的 `status` 事件（`N 个后台任务运行中`）→ `index.ts:416` 的 `case 'status'` → `session.setSystemStatus()` → 卡片渲染。**「过程」的可见性已经有了**
2. **结果自动成为新消息**：`index.ts:4356` 有「Rebuild streaming card after completion」——定稿后立即重建新卡，注释写明「so subsequent messages get a fresh streaming card」。所以后台任务完成后的第二个 result 落在**新卡** = 一条新飞书消息
3. **多 result 是被显式支持的**：`index.ts:4430` 专门处理重复 turnId——`sentReply && effectiveTurnId === lastSavedTurnId` 时用 fresh INSERT，**避免第二条回复覆盖第一条**。这说明「一次运行多个 result 各自投递」是既有设计而非意外

⇒ upstream commit `5f04246` 描述的那个 bug（「首条回复后的 result 只入库不发 IM，飞书端永远看不到汇总」）**本地不存在**。

### C-2c · 五连里三项**不移植**（按既有决策）

| upstream commit | 内容 | 不移植的理由 |
|---|---|---|
| `5f04246` | 挂起完成——后台任务结束前不定稿、内容同卡追加 | 与 F2 决策**直接冲突**：它把过程与结果合并进同一张卡，而你要的是结果单独发消息 |
| `81f0b5a` | 挂起序列全渠道合并为一条回复 | 同上，它进一步把多个 turn 合并成**同一行 DB 消息** |
| `453eed3` | 定稿剔除工具调用间的过程旁白 | B 决策已定**保留本地**（全量拼接 + 分段折叠面板） |

移植它们会把行为推向你明确不要的方向。

### C-2d · 断流续写 —— **暂缓，理由如下**

`c4fb789` 的指纹是 `usage.input_tokens === 0 && output_tokens === 0 && 文本非空` → 判定为上游断流截断 → 自动开续写 turn。

暂缓的判断：
- **收益是推测性的**：你从未反馈过「回复被截断」，而认知管线/调研任务的失败已由 C-2a 解释清楚（关流杀子 Agent），不是断流
- **多运行时误判风险实在**：Codex 与 Grok 的 usage 上报口径各不相同（Codex 的 `inputTokens` 含 cachedRead，Grok 走 ACP `_meta`），零 usage 在它们那里可能是正常情形。误报的代价是凭空多跑一个 turn 烧 token
- 若将来真观察到截断回复，再按 checklist「gate 到 claude runtime」补上即可，改动是独立的

同批次的 `isStaleBackgroundWaitReply`（后台任务完成与模型出文的竞态防护）一并暂缓——在「过程卡 + 结果新消息」的形态下，那条陈旧进度消息正好落在过程卡上，本就是你想看到的「过程」。

**批次 2 结论**：实际需要的代码只有 C-2a 一项，其余四项经查证或**已被本地满足**、或**与决策冲突**、或**属推测性收益**。

---

## 部署 · 阶段 A/B/C 改动上线

**重启前状态确认**：0 个 Docker 容器、0 个宿主机 agent 进程、最后一条消息在 3 小时前（11:00）——完全空闲，重启无中断代价。

**数据备份**（不可逆操作前的规定动作）

```
data/backups/messages-pre-restart-20260725-140948.db   147 MB
```

用 `sqlite3 .backup` 取**一致性快照**而非文件拷贝（WAL 模式下直接 cp 可能取到撕裂状态）。校验：备份内与生产库均为 **13727 条消息**，一致。

**重启**：`make launchd-restart` → PID 35445 → 健康检查 healthy → 启动日志无 error（Database initialized / State loaded / Web server started / Scheduler loop started）。

**部署验证**

| 项 | 验证方式 | 结果 |
|---|---|---|
| F3 | 生产数据实测 | ✅ `folder='main'` 执行范围 **24 → 3** |
| F1 | 构建产物比对 | ✅ `pending-tasks` 标记 ×2、`getBlockingPendingSdkTaskCount` 定义+调用均在 `dist/` |
| P12 | 构建产物比对 | ✅ `AGENT_BROWSER_SESSION` ×2 在 `dist/container-runner.js` |
| O2 | 已于 B-4 实测 | ✅ append 模式确认，轮转已生效 |
| F6 | 已于 B-3 实测 | ✅ 真实 SDK 更新 0.3.215→0.3.220 走成功分支 |

**仍需真实使用才能观察的两项**（无法在不占用你的工作区与 token 的前提下自行触发）

1. **F1 端到端**：下次跑认知管线或长调研任务时，日志里应出现
   `[pending-tasks] +xxx (...) → N pending`，随后
   `Result emitted but N background task(s) still running, holding stream open`。
   成功标志是**三个维度子 Agent 都有产出**（对照修复前 6/6 全灭）
2. **P12 集成**：任一宿主机任务用过浏览器后退出，日志应出现
   `Closed agent-browser session after host run`；`agent-browser session list` 应为空

---

### C-3 · 飞书 10 个 MCP 工具 —— **暂缓，撞到依赖墙**

原计划把 upstream 的 `feishu_send_card` / `edit_message` / `recall_message` / `add_reaction` / `remove_reaction` / `get_chat` / `get_history` / `get_user` / `list_members` / `api_request` 十个工具作为「纯加法」摘过来。查证后发现**不是纯加法**。

十个工具全部经由同一个 `callFeishuCapability(operation, params)` 走 IPC，而它的前置检查是：

```ts
const channelContext = currentChannelContext();
if (channelContext?.provider !== 'feishu') throw ...
if (!ctx.currentInputTurnId) throw ...
```

本地 `McpContext` **既没有 `channelContext` 也没有 `currentInputTurnId`**（已核对字段清单）。而 upstream 的 `ChannelTurnContext` 结构里带 `channelAccountId` —— 指向 `channel_accounts` 表，正是**本地已决定不采纳**的多账号模型。

所以有两条路，都不适合现在做：

| 选项 | 代价 |
|---|---|
| 等批次 7/8 的 channel 基础设施落地后再摘 | 顺序正确，但要等 |
| 本地按 `ctx.chatJid`（已含 `feishu:` 前缀与 chat id）重新实现 | 约 400~600 行**重写**，且不与 upstream 同源——将来每次合并都要手工对齐 |

**结论**：暂缓，移到批次 7 之后。这不是「不做」，是**顺序纠正**——原计划把它排在批次 3 是基于「纯加法」的误判。

---

### C-4 · 定时任务加固（cherry-pick 四连）

**改动**：按时序 cherry-pick `c4ad5c0`（时区注入）→ `065e874`（阻塞确认 + `update_task` + 幂等去重）→ `ec62d7c`（触发框定堵递归增殖）→ `ae42183`（对抗审查 CR 修复）。

**四个 commit 全部零冲突应用** —— 印证了此前的判断：它们不碰 `db.ts`、不需要 `task_runs` 表（租约队列由另一个 commit `2dbb553` 引入，属「任务执行保留本地」的不合范围）。

**实际带来的能力**

| 项 | 说明 |
|---|---|
| `update_task` | 新 MCP 工具，Agent 可就地改任务而非「取消再建」 |
| 五个操作改阻塞确认 | `schedule` / `update` / `cancel` / `pause` / `resume` 均等待 `*_result` 回执，不再「发出即假定成功」 |
| 递归增殖框定 | 任务触发提示词明确「这条只是触发信号，对应定时任务已在调度中，不要再 `schedule_task` 重复创建」 |
| 时区注入 | 给 Agent 注入带时区的当前时间，`list_tasks` 按本地时区展示 |

**集成完整性核对**（阻塞确认最怕主进程不写回执——那样每次任务操作都会阻塞到超时）

```
writeTaskResult 调用点：
  cancel_task ×3   pause_task ×3   resume_task ×3   schedule_task ×3   update_task ×2
```

五个操作的成功/失败分支回执均已就位；孤儿结果文件的清理前缀列表也同步更新。

**验收**

| 项 | 结果 |
|---|---|
| cherry-pick 冲突 | ✅ **0** |
| `make typecheck` | ✅ 三项目全绿 |
| `make test` | ✅ 107 文件 / 1205 通过 |
| `make build` | ✅ 通过，`update_task` 已进 `dist`（agent-runner ×4 / 主服务 ×6） |

**数据备份**：不涉及（无 schema 变更；重启前的库快照已于上一节留档）。

**待实机验证**：下次定时任务触发时，确认只触发一次、回投 IM 一次、不增殖；Codex/Grok 经独立 MCP server 调 `update_task` 的通路正常。

---

### C-1 · 机械修复（cherry-pick）

按价值挑选而非全量照搬——Windows 兼容三连对 macOS 部署零收益，暂不摘。

| commit | 内容 | 冲突 |
|---|---|---|
| `072e608` | 大文件上传/下载：超时误杀 + 50MB 上限写死 → `MAX_FILE_SIZE_MB` 可配 | CLAUDE.md（文档） |
| `631e465` | Markdown 图片中文文件名解码 | `MarkdownRenderer.tsx` |
| `9262274` | better-sqlite3 `^11.8.1` → `^12.10.0`（Node 26 原生编译兼容） | 无 |
| `eabc1f3` | 飞书 IM 配置 appId 格式校验 + 保存前连通性测试 | 无 |

**两处冲突的解决**

- **CLAUDE.md**：本地版多三行（`feishu-streaming-card` / `qq-streaming-card` / `feishu-cards`）且 `im-manager` 描述含微信；upstream 更新了 `im-downloader` 的大小限制描述。**保留本地行 + 采纳 upstream 的事实更新**，两者不互斥
- **`MarkdownRenderer.tsx`**：upstream 把内联的 `resolveImageSrc` 抽成了 `web/src/utils/markdownImageSrc.ts` 并配 122 行测试。**取 upstream 版**——抽出的实现更健壮（中文文件名解码正是这次修的），且带测试。删掉本地内联函数后 `toBase64Url` / `withBasePath` 的导入也随之不再需要

**better-sqlite3 升级的额外验证**（原生模块，且要读 147 MB 生产库）

```
装上版本: 12.11.1
原生模块加载: ✅（Node 25.9 / darwin-arm64，内存库读写往返正常）
生产库只读校验: ✅ 13728 条消息 / 37 表 / schema 40 / journal=wal
```

**验收**

| 项 | 结果 |
|---|---|
| `make typecheck` | ✅ 三项目全绿 |
| `make test` | ✅ **109 文件 / 1258 通过**（cherry-pick 带来 +53 个用例） |
| `make build` | ✅ 通过 |
| 生产库兼容性 | ✅ 见上 |

**数据备份**：升级前的库快照已于「部署」一节留档（`messages-pre-restart-20260725-140948.db`）。本次为只读校验，未写入生产库。

---

## 端到端验证 · F1 的真实病理（比原诊断更严重）

原本打算「等下次真实使用再观察」——那不是端到端。改为主动验证，过程中发现 F1 的破坏链**比我此前描述的更深一层**。

### 认知管线四天的日志证据

| 日期 | 关键日志 | 判读 |
|---|---|---|
| 07-22 | `Result #1: success text=<internal>三个子任务已启动，等待完成通知。</internal>` turns=8 $1.88 | 起了 3 个子 Agent，随即被 5 秒关流杀掉 |
| 07-23 | `No completion record was found for background agent "Cognitive/Knowledge/Interaction extraction r3"` ×3 → `turns=0` → `error_during_execution` | **resume 到被污染的会话，0 turn 空返回** |
| 07-24 | 同 07-22（turns=7 $1.97） | 再次起、再次被杀 |
| 07-25 | 同 07-23 | 再次空转 |

**交替循环：杀 → 污染 → 空转 → 杀。** 三天零产出的真正机制不是「子 Agent 被杀」这么简单——被杀的子 Agent **在会话里留下了无主的 task 记录**，此后每次 `resumeAt: latest` 都会先收到三条 `No completion record`，然后 SDK 立刻返回 `subtype=success` 但 `turns=0 / usage 全零 / result=null`，会话再也推不动。

**⇒ F1 修复阻止未来的污染，但已污染的会话不会自愈。** 这是原方案里漏掉的一步。

（顺带修正一次我自己的误判：看到 `usage` 全零时我一度认为是上游断流、并说 C-2d 暂缓断流续写判断错了。查完完整链条后确认——零 usage 是「resume 污染会话」的**下游症状**，不是上游截断。C-2d 的暂缓结论仍然成立。）

### 处置

1. **备份**：`data/backups/poisoned-session-task-1fa16ce0-20260725-142644.tar.gz`（3.6 MB，含整个 `.claude` 目录）
2. **清理**：把三个 `.jsonl` 会话文件移入 `.poisoned-archive/`（移动而非删除，可回滚）。`resumeAt: latest` 因此解析不到旧会话，下次运行从干净状态开始
3. **重放**：手工重放 11:00 那条从未产生回复的任务消息，用修复后的代码真实跑一遍

### 观察到的即时差异

被污染的运行都是**秒退**（turns=0）。重放后的运行持续数分钟、流式缓冲在写、agent 进程活跃——行为已经不同。

---

### F1 端到端验证结果 · ✅ 通过

清掉污染会话后重放认知管线，真实跑通：

| 状态 | turns | 结果 |
|---|---|---|
| 污染会话（07-23 / 07-25） | **0** | 无回复 |
| 子 Agent 被杀（07-22 / 07-24） | 7 / 8 | 只有「三个子任务已启动，等待完成通知」 |
| **修复后（07-25 21:43）** | **18** | **「天级统一提取完成…152 条消息，10 个工作区，19 条观察」** |

`Usage: input=30 output=20897 cost=$10.87 turns=18`，日志里 `No completion record` 归零。管线还自己补齐了 07-21 / 07-22 两次未收尾的 cron。

**准确归因**：本次直接解封的是**会话重置**；F1 的挂流机制防止再次污染。这一轮 agent 选择在 18 个 turn 内串行完成提取而非派发后台 SDK Task（`pending-tasks` 日志为 0），所以挂流路径本身未被这一轮触发——它的正确性由 14 个单测覆盖，等下一次真派发后台任务时会在日志里看到。

---

## 阶段 D · 资产层剥离

### D-1 · `supportsPreCompactHook` 语义 —— 查证结论：**无需改动**

原计划要把它「从决定产品能力有无降级为只表示 runtime 有无压缩事件」。全仓搜索后确认：该字段**只在 `runtime-adapter.ts:51` 的接口里声明，三个非 Claude adapter 把它设为 false，没有任何读取点**。它已经不 gate 任何东西，A1 担心的情况在当前代码里不成立。

### D-2 · 归档改为 DB 驱动的连续写

**证据**：归档此前只由 Claude SDK 的 PreCompact hook 写。实测——**最近 7 天全系统只写出 4 个归档文件**，`main` 上次归档停在 **2026-06-10（六周前）**。两个原因叠加：Codex / Grok 根本没有压缩事件（三个 adapter 全是 `supportsPreCompactHook: false`），而 ~1M 上下文窗口让 Claude 侧的压缩也几乎不发生。

归档正是 `memory_search` 检索的对象 —— 陈旧归档意味着 **Agent 静默地失去近期记忆**。

**落地**：新增 `src/conversation-archive.ts`，每个完成的 turn 从已持久化内容直接追加。按月文件保持可 grep 且有界；记录 runtime 使「哪条运行时没产出」在归档里直接可见；单条 turn 超 200k 字符截断；`privacy_mode` 跳过；全程 best-effort。接在 `index.ts` 结果落库之后，三条运行时共用。

**验收**：11 个用例（含 privacy 跳过、空 turn、仅回复、截断、写失败不抛）。

### D-3 · `turn_events` 轨迹落库

**证据**：StreamEvent 广播到 WebSocket 后即丢弃。`messages` 留下最终文本，但「跑了哪些工具、子 Agent 得出什么结论」只存在于当时开着的那个浏览器标签页里。

**落地**：`turn_events` 表（schema 40 → 41）+ `src/turn-trace.ts`

- 只持久化结构性事件；`text_delta` / `thinking_delta` 明确不存（每 turn 数百条，且累积本身就是消息体，存下来行数翻约 100 倍）
- payload 策略（决策 A3）：≤8KB 内联，超出落 `groups/{folder}/traces/{date}/` 并留 2000 字预览，使文件被裁剪后行仍可读
- per-chat 单调 `seq`：同 turn 内事件常共享同一毫秒，`id` + `seq` 才是唯一可靠全序
- 接在 `broadcastStreamEvent` 一个咽喉点，四处调用点全覆盖
- 读取 API `GET /api/groups/:jid/turn-events`，支持 `turnId` 取一轮或 `beforeId` 分页；`turnId` 查询校验归属防跨会话读取
- 删除路径同步覆盖 **5 处**。隐私模式尤其重要——轨迹带工具输入与子 Agent 输出，留下就是隐私泄漏

**实机验证抓到一个漏采**：首版只落下工具名与 `toolUseId`，payload 为空——轨迹能显示「Read 跑过」却不知道读了什么。核对 `StreamEventType` 全集后发现漏了 **`tool_result`**（工具返回内容）与 **`sub_agent_result`**（子 Agent 结论，正是最该保住的东西），已补齐，另补 `compact_boundary` / `memory_recall`。

**上线验证**：schema 迁移到 41、`turn_events` 表就位、`PRAGMA integrity_check` = ok。轻量任务实测落库 —— `context_audit`(1793B) → `tool_use_start`(Read) → `tool_progress`(90B) → `tool_use_end`，seq 有序、runtime 正确。

**数据备份**：`messages-pre-schema41-*.db`（迁移前）；db.ts 自身也在 schema 迁移前自动备份。

### D-4 · 记忆并入认知管线 —— 查证结论：**无 HappyClaw 代码改动**

PreCompact 里的 memory flush 由 `hadCompaction` 触发，而压缩几乎不发生（同 D-2 的实测），所以这条路径**本就近乎从不执行**。决策要求把记忆维护并入认知管线——认知管线是**任务提示词**层面的事，且它现在已被 D-2/F1 解封并实测产出 19 条观察、写入 8 个工作区的 `observations.md`。HappyClaw 侧不需要改动，PreCompact 的 flush 保留为不影响正确性的残留路径。

---

### C-1 补充 · 未摘的

**未摘的**：Windows 兼容三连（`2408d73` / `1d02716` / `fbb37b1` / `0a08fd9`）—— macOS 部署零收益，且其中两个与 `container-runner.ts` 的 Grok 注入分支纠缠，摘入反增冲突面。系统代理（`3371b95`）当前无代理配置时为 no-op，价值待你配代理时再摘；PWA 缓存与浅色主题属纯前端观感，可随时补。

---

## 阶段 E · Agent-first

### E-5 · Agent 人格体系（批次 5）

schema 41 → 42。四张表 + `sessions` 三列身份指纹。

**让表不再惰性的关键**：`systemPromptAppend` 由 `promptPieces` 拼成，而它**同时**喂给三条运行时（Claude 走 SDK systemPrompt、Codex 走 CLI 参数、Grok 走 ACP `_meta.rules`）。所以人格块加进 `promptPieces` 首位即三运行时全覆盖，无需在每个 adapter 各写一遍（那样必然漂移）。

**决策落实**：O1-a 共享语义（N 工作区 : 1 模板）；O1-b 只报告不重置（测试专门断言人格改完后 `getSession()` 仍返回原会话）；A5 指纹只由人格内容决定，不含引擎。

**A5 双指纹之争已消解**：三列加在本地已有的 `sessions` 表上，`conversation_runtime_sessions` 是另一张表，上线后 16 个既有会话完好。

**M4 核实后暂缓**：64 个群组全部有 `created_by`，32 行 `group_members` 全部被覆盖，**零个 (用户,folder) 对只靠它拿权**——删除锁不死人。但纯清理零功能收益，却要在 ACL 上动 4 个授权分支，价值/风险不匹配，留到批次 7 之后与 channel 改造一并做。

### E-6 · workspaces 投影层（批次 6）

schema 42 → 43。**投影而非迁移**：`registered_groups` 带 `execution_mode` / `custom_cwd` / `selected_skills` / `require_mention` / `target_main_jid` 等本地独有列，upstream 的表没位置放，搬迁真相源会丢。

全量重建而非增量：投影很小，重建不会漂移；增量要在每处写入挂钩子，漏一个就产生静默陈旧的投影。`verifyWorkspaceProjection` 作为验收门（也是批次 7 复用的模式）。

**上线实测**：64 群组 → 64 workspaces、16 runtime sessions。

### E-7 · channel_mounts（批次 7）· M5 零妥协

schema 43 → 44。`agent_channel_mounts` 取代 `target_main_jid`。

**迁移设计**：加法式（不清旧列）+ 幂等 + 悬空 target 明确跳过不猜测。**在挂载未经验证时就退役旧列，会让迁移 bug 与路由 bug 无法区分。**

**四重验收**
| 项 | 结果 |
|---|---|
| 单测 14 例 | ✅ |
| 生产迁移 | ✅ migrated=21 / checked=21 / skipped=0 |
| **独立脚本对账** | ✅ 迁移前导出 21 条基线，与迁移后逐条 `diff`，**零差异**（不只信应用日志） |
| **回滚在副本上真跑** | ✅ schema 43、21 条绑定完好、无新表、integrity ok |

M3 串台防御与 F3 补丁的退役留到新表稳定服务一段时间之后——现在路由仍由 `target_main_jid` 承担，并存是本设计的安全边界。

### E-8/9 · 投递可靠性与会话语义融合

schema 44 → 45。`messages` 加 delivery 五列。

此前回复行只记「已存储」，发送抛异常与成功在库里长得一样。现在记录 sent / failed / **skipped**（有意不投递，不能读作失败）；存量行保持 NULL 而非回填猜测——回填会把一万三千条历史变成编造的投递记录。

会话有效性把两套判定合一：人格漂移**只报告不丢弃**（O1-b），引擎漂移**必须丢弃**（一个 runtime 的 native session id 对另一个毫无意义）。任一侧缺值视为无漂移证据，存量会话不会集体失效。

**测试抓到一个边界**：`olderThanMs=0` 时 cutoff 即当下，同毫秒写入的行被 `<` 判否。改为闭区间——生产中恰好落在边界的行也不该被静默排除。

### E-3 · 飞书 10 个 MCP 工具（批次 3，依赖墙已拆）

批次 3 此前因 `ChannelTurnContext` 耦合 `channel_accounts` 而暂缓。**按本地 `ctx.chatJid` 实现即可绕开**——它本就编码了 provider 与 chat id。

- `container/agent-runner/src/mcp-tools.ts`：10 个工具，全部经 `callFeishu` 走阻塞 IPC（编辑/撤回必须知道是否真的生效，「假定成功」正是撤回静默失败的方式）
- `src/feishu-capability.ts`：client 注入式 dispatch，**每条路径都返回而非抛出**——Agent 阻塞等回执，无人应答会把 turn 挂到 120s 超时
- `src/im-channel.ts` 加 `getProviderClient()` 暴露 lark client
- `api_request` 限制在 `/open-apis/` 命名空间：这是飞书逃生舱，不是通用 HTTP 客户端

**行为判断**：`edit_message` 拒绝空文本而非清空消息——编辑成空白更可能是传错变量，想删该用 `recall_message`。测试原本断言相反，是测试错了，改测试并把意图写进代码注释。

**验收**：20 用例（含撤回缺 id 时**根本不调 API**、路径越界拒绝、错误不抛出、错误消息 <200 字节不泄漏 socket 图）。

### 阶段 E 小结

| 批次 | schema | 提交 |
|---|---|---|
| 5 人格体系 | 41→42 | `83dc043` |
| 6 workspaces 投影 | 42→43 | `e23e203` |
| 7 channel_mounts + M5 | 43→44 | `6f06562` |
| 8+9 投递与会话语义 | 44→45 | `65ce73d` |
| 3 飞书 10 工具 | — | 本次 |

门禁：**117 文件 / 1382 测试全绿**。每次 schema 迁移前均有一致性备份。

---

## 后续 · 同运行时换模型保留上下文

**触发**：使用者发现「会话切换 agent 会不会 clear，感觉应该保留上下文」。查证后确认系统里其实有**四条语义各异的切换路径**：

| 切换什么 | 原上下文处理 | 是否合理 |
|---|---|---|
| Agent 人格（批次 5） | 完整保留，一次 cache miss | ✅ O1-b |
| Agent 标签页（sub-agent） | 各自独立会话（`sessions` 按 `(folder, agent_id)` 分行） | ✅ 设计如此 |
| **模型/运行时（`/model`）** | **一律生成交接摘要** | ⚠️ 过严 |
| Provider（OAuth 轮换） | 删除会话 | ✅ 必须——跨账号 session id 无效 |

**根因**：`conversation_runtime_sessions` 的主键含 `model_key`，所以 opus → sonnet 会查不到行、退化成从摘要重启。但对 Claude 而言这比平台要求更严——transcript 与模型无关，换模型可以直接续。原设计一律摘要是为降成本的有意取舍，实际用下来成本可接受，而丢掉的上下文不可接受。

**落地**

- `db.ts` 新增 `getCarryOverNativeSession`：同 runtime + 同 provider + 同 auth generation、仅 `model_key` 不同时取最近一条会话。三个约束都是硬的——换 runtime 则 session id 无意义，换 provider / 重新认证则 thinking block 签名失效（这正是 provider 切换路径要删会话的原因）
- `model-runtime.ts`：精确键查不到时回退到 carry-over
- `index.ts`：`/model` 切换先比对 runtime，**同运行时不再生成摘要**；跨运行时仍然生成（Claude 的 session id 对 Codex/Grok 毫无意义）

**验收**：新增 10 用例，边界全部锁死（跨 runtime / 跨 provider / 跨 auth generation / 跨工作区 / 跨 agent 标签页都不串，空 session id 跳过，多候选取最近）。`make test` 118 文件 / 1392 通过。

**顺带修掉一个 mock 缺项**：`model-runtime-claude-models.test.ts` mock 了 `db.js`，新导出未列入导致 4 个既有用例失败。补 mock 而非改行为——那 4 个测的是模型命名归一化，与会话续接无关。

**仍未接入的（诚实记录）**：批次 9 的 `evaluateSessionValidity` / `evaluateStoredSessionValidity` 定义了、19 个用例全过，但**没有任何调用点，目前是死代码**。四条切换路径的判断逻辑仍散在各处。收口它属于纯内部清理、对使用者零可见变化，已告知使用者可择期再做。

### 收口 · 四条切换路径统一由一处判定

使用者确认「是个合理的抽象」后落地。

**动手时发现我自己引入的矛盾**：`evaluateSessionValidity` 写的是 `model_changed → shouldDiscard: true`，但上一节刚把行为改成「同运行时换模型要保留」。两处直接冲突——**这正是这个抽象要防的事，而且它在被接入的第一刻就抓到了自己**。

**修正后的规则**（只有让 session id **不可用**的漂移才丢弃）

| 漂移 | 丢弃 | 理由 |
|---|---|---|
| `runtime_changed` | ✅ | 另一 runtime 签发自己的 session id |
| `provider_changed` | ✅ | 换 OAuth 账号使 thinking block 签名失效 |
| `model_changed` | ❌ | 同运行时内 transcript 与模型无关，carry-over 接得上 |
| `persona_changed` | ❌ | O1-b：前缀变了，吃一次 cache miss |

**收口的三处**
- `container-runner.ts` docker 路径：provider 切换改为经 `evaluateSessionValidity` 判定
- `container-runner.ts` host 路径：同上（两条必须对称）
- `index.ts` 的 `/model` 切换：用统一判定替代上一节我写的 runtime 直接比对

**没有收口的一处（有意）**：`group-queue.ts` 的 `hasPendingConversationRuntimeBinding` 是**排空调度**，不是有效性判断——把它并进来会把"何时应用新绑定"与"会话还能不能用"两件事混为一谈。

**验收**：新增 6 用例，按调用点视角写（provider 轮换 / 同 provider 重选 / 跨运行时 / 同运行时换模型 / 人格编辑 / 首次无证据），使将来改规则时会在这里暴露而非在各站点静默分叉。118 文件 / 1398 通过，上线后启动零 ERROR。

### 附 · 飞书会话内的 agent 切换机制（查证）

使用者问「一个飞书会话内可以切换 agent 吗」。查证结论：**可以，但机制是「话题」而非命令。**

| `binding_mode` | 行为 |
|---|---|
| 默认（`target_main_jid`） | 整群 → 工作区主会话，`agentId = null`，无法切换 |
| `target_agent_id` | 整群 → 钉死一个 agent，无法切换 |
| **`thread_map`** | **每个飞书话题 → 一个独立 agent**，由 `resolveOrCreateThreadAgent` 按需创建 |

所以 `thread_map` 模式下开新话题即开新 agent、回旧话题即回该 agent 的上下文。这也解释了为何 agent 标签页各自独立会话是合理的——它们对应飞书里不同的话题，本就该是不同对话。
