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
