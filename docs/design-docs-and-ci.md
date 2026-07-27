# 设计：CLAUDE.md 重写 与 CI 落地

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41`
> 依据：`docs/upstream-merge-plan.md` 决策 70 / 71 / 87 / 88 · `docs/merge-test-plan.md` §6
> 对应执行阶段：**阶段 6.1（CLAUDE.md）· 6.2（参考文档）· 6.3（CI）**
> 编制：2026-07-26

本文两节都是**可直接执行**的设计：第一节给出重写后的章节骨架与逐条内容归属，
第二节给出可直接落盘的 `.github/workflows/ci.yml`。

文中所有数字均为本次在本地树上实测所得，与既有文档不一致处已在正文标注更正。

---

# 第一节 · CLAUDE.md 重写成约 420 行的章节结构

## 1.1 为什么采纳 upstream 骨架

upstream 在 `652000f` 一个 commit 里同时做了两件事：CLAUDE.md 从 821 行砍到 **349 行**，
并新增 `scripts/check-docs.mjs`。这两件事是一体的 —— 砍到 349 行的前提是**剩下的每一条
路径都能被机器校验**，否则只是把过时内容换成了更简短的过时内容。

本地 904 行。用 upstream 的脚本跑一遍本地树：

```
$ node scripts/check-docs.mjs
Documentation consistency check failed:
- CLAUDE.md:637 references missing container/agent-runner/src/happyclaw-mcp-server.js
- CLAUDE.md:763 references missing src/affected-file.ts
- CLAUDE.md:829..847 references missing tests/units/*.test.ts   （17 条）
- docs/API.md does not index route module src/routes/*.ts        （19 条）
```

**实测 38 条**，不是既有文档里写的 39 条 —— `upstream-decision-tree.md:522` 和
`merge-test-plan.md:1474` 都写 "39 条（19 + 19）"，但 19 + 19 = 38。两处文档需一并订正。

这 38 条只是**机器能看见**的死内容。机器看不见的更严重：8 张已建表零提及、
pm2 与 launchd 两套托管并存却一处未写、Agent 档案有表无入口。见 §1.4。

## 1.2 目标结构

目标 **约 426 行**（upstream 349 + 本地独有净增约 77）。章节号沿用 upstream，
方便未来两边对照合并。

| # | 章节 | 这节写什么 | 行 | 来源 |
|---|---|---|---|---|
| — | 头部 | 标题 + 一句话定位（须写明"三条运行时"，upstream 只提 Claude Agent SDK）+ "本文只写工程约束与导航，产品介绍在 README" | 4 | 改写 upstream |
| 1 | 文档与代码真相源 | 指针清单：`README.md` / `docs/API.md` / `docs/ACL-MATRIX.md` / **`docs/RUNTIMES.md`（新建）** / `container/agent-runner/prompts/` / `src/db.ts` 的 `SCHEMA_VERSION` / `web/src/App.tsx` / `src/runtime-config.ts` / `shared/{stream-event,image-detector,channel-prefixes}.ts`；末尾声明哪些 `docs/*.md` 是历史设计记录、不作真相源 | 22 | 照搬 upstream 结构，条目全换成本地真实存在的文件（upstream 列的 `src/im-channel-capabilities.ts`、`src/channel-mount-service.ts` 本地没有，删） |
| 2 | 产品模型 | 定位（自托管多用户、三运行时）+ 产品层级图 + 命名边界（`registered_groups` 是工作区兼容层、`agents` 表是历史命名）+ **「当前落地边界」小节**（§1.4.3） | 34 | upstream §2 骨架 + 本地 §1 内容 + 全新第三段 |
| 3 | 主要模块 | **3.1 主服务**：文件→职责表，按 upstream 粒度（11~16 行，不是本地现在的 60 行全量清单），补 `model-runtime.ts` / `provider-pool.ts` / `turn-trace.ts` / `im-safety/`；**3.2 Web**：技术栈一句 + 路由表（声明以 `web/src/App.tsx` 为准）+ Store 目录指针；**3.3 Agent Runner**：stdin/stdout/IPC 契约 + prompts 加载 + **三运行时能力矩阵**（§1.4.4）+ "不要在文档里维护 MCP 工具数量 / StreamEvent 数量" | 82 | 本地 §2.1/§2.2/§2.3 压缩到 upstream 粒度；能力矩阵全新 |
| 4 | 执行、并发与挂载 | 执行模式表（host / container，含 `is_home` 模型）+ 并发与超时约束 + **容器挂载策略表（§1.3.2，原样保留）** + IPC 四通道契约（原 §3.3） | 48 | upstream §4 + 本地 §3.4 + 本地 §3.3 |
| 5 | Prompt、能力与 Plugin | 四段 Prompt 定义 + 能力解析链（context resolver → skill/mcp 清单 → 挂载）+ Skills 两级来源 + **Plugin 6 条硬约束（§1.3.3）** + 「人格注入必须对三条运行时生效」 | 48 | upstream §5 + 本地 §10 Plugin 压缩 |
| 6 | 渠道、账号与上下文 | 七渠道清单 + JID 前缀真相源 + 主容器回复路由（`normalizeHomeJid`）+ 群聊 mention / owner 门控 + IM 斜杠命令表 + 飞书会话语义；**多账号写成"阶段 5 之后"的前瞻一句，不提前描述未落地形态** | 36 | upstream §6 裁剪到本地现状 + 本地 §8.6/§8.11/§8.12 |
| 7 | 数据与目录 | `data/` 目录树 + 「Schema 版本以 `SCHEMA_VERSION` 常量为准，勿硬编码」+ **核心表族（补齐 8 张，§1.4.1）** | 46 | upstream §7 + 本地 §6 目录树 + 补表 |
| 8 | 认证与权限 | Cookie HMAC / 会话有效期 / RBAC 两角色五权限 / 用户隔离一句 / 指向 `docs/ACL-MATRIX.md` | 16 | upstream §8 + 本地 §4.2 |
| 9 | 配置 | 配置优先级链 + 环境变量表（upstream 13 项 ∪ 本地独有 6 项：`ASSISTANT_NAME`、`MAX_CONCURRENT_HOST_PROCESSES`、`AUTO_COMPACT_WINDOW`、`TASK_BACKFILL_GRACE_MS`、`MAX_LOGIN_ATTEMPTS`、`LOGIN_LOCKOUT_MINUTES`）+ **`GROK_HOME` / codex 凭据物化语义（§1.3.1）** | 30 | upstream §9 + 本地 §9 |
| 10 | 开发与验证 | 三个 Node 项目 + 常用命令 + **运行模型：launchd 唯一托管 + 三条运维红线（§1.4.2、§1.3.4）** + 常见修改入口表 + 提交前门槛 | 48 | upstream §10 + 本地 §11 择要 |
| 11 | 提交与 PR 规范 | commit message 中文格式 + Issue/PR 标题前缀 + 分支干净性一句；**Issue/PR 正文长模板移出到 `.github/`**（§1.5.3） | 12 | 本地 §10.1 压缩（69 行 → 12 行） |

合计 **426 行**。

三条贯穿全文的写法约束（对应 CLAUDE.md 自己的 §10 "准确性优先于详尽度"）：

1. **易变枚举一律写指针**。MCP 工具数、StreamEvent 数、Schema 版本号、渠道全集、
   Store 个数、路由条数 —— 全部改成"以某文件为准"。本地现在还硬编码着
   "14 个通用工具 + 3 个 Discord 工具"、"15 个 Store"、"5 种权限"。
2. **每一条反引号包裹的仓库路径必须真实存在**，因为 `check-docs.mjs` 会逐条 `fs.existsSync`。
3. **每一个 `make X` 必须在 Makefile 里有对应 target**，同样是脚本校验项。

## 1.3 本地独有内容的安置

### 1.3.1 §8.14 Grok 运行时（本地 CLAUDE.md:618–649，32 行）

> 更正：任务描述里写"约 40 行"，实测 32 行。

**不保留为独立章节。** 理由：upstream 骨架里没有"某个运行时占一整节"这种粒度 ——
§3.3 讲 Agent Runner 契约只有 12 行。留一整节 Grok 会让文档重新失衡
（Claude 0 节 / Codex 0 节 / Grok 1 节），而失衡正是 904 行的成因。

拆成四处 + 一个新文档：

| 内容 | 去处 | 行 |
|---|---|---|
| `grok-cli-runner.ts` / `grok-event-normalizer.ts` 两行模块职责 | §3.3 Agent Runner 模块表 | 2 |
| 三运行时能力矩阵里 Grok 那一列（含 `supportsLiveInput=false`、单 turn re-spawn） | §3.3 能力矩阵 | 0（并入矩阵） |
| systemPrompt 走 ACP `session/new` 的 `_meta.rules`**追加**而非 `systemPromptOverride` 整体替换 | §5 Prompt 与能力（作为"人格注入对三运行时生效"的一条实现约束） | 3 |
| MCP 复用 `happyclaw-mcp-server.ts` 独立进程 + context 文件传 IPC 路径（Codex/Grok 共用） | §5 Plugin/MCP 小节 | 3 |
| `GROK_HOME` seed 语义：整体 seed auth.json、目录 **RW** 挂载让 CLI 自刷新、seed-metadata 三件套去重、`deleteProvider` 时 GC | §9 配置 | 5 |
| **ACP 协议细节**（initialize → session/new → 一次 session/prompt → 消费 session/update → 关进程；`use_tool` 解包；`result._meta` 用量口径；`classifyRuntimeError` 的 grok 措辞） | **新建 `docs/RUNTIMES.md`**，CLAUDE.md §1 与 §3.3 各留一条指针 | 2（指针） |

`docs/RUNTIMES.md` 是决策 88（参考文档取 upstream 再按本地删改）的本地增量：
upstream 是单运行时，没有这份文档；三条运行时的差异（resume 模式、live input、
用量口径、错误分类、subagent 体系）需要一个集中落点，而这些恰恰是**每次改运行时都要查、
但不是每次请求都要加载**的内容 —— 与 §7 拆出 `docs/API.md` 是同一条理由。

### 1.3.2 §3.4 容器挂载策略表（本地 CLAUDE.md:234–254，21 行）

**整表保留，原样搬进新 §4。**

`docs/ACL-MATRIX.md` 全文 323 行，`grep -i "挂载\|mount"` 只有 **1 处命中**
（`/api/browse/directories` 那行"受 mount-allowlist 白名单约束"）—— 它覆盖的是 HTTP API 层的
访问控制，**完全不覆盖容器挂载层**。挂载表是"admin 主容器能读写项目根目录、member 不能"
这类安全边界的**唯一书面记录**，删掉就没有第二处。

压缩到 18 行的做法：

- 12 行表格保留全部行（工作目录 / 项目根 / 用户全局记忆 / Claude 会话 / IPC / 项目级 Skills /
  用户级 Skills / feishu-cli OAuth / 环境变量 / 持久 extra / 额外挂载 / npm 全局包），
  列头保持 `资源 | 容器路径 | admin 主容器 | member 主容器/其他`。
- 表下那段 5 行的 npm 全局包持久化说明压成 1 行 + 指向 `container/entrypoint.sh`。
- 补 1 行本地独有、现在表里没有的：**Grok/Codex 凭据目录是 RW 挂载**（`/workspace/grok-home`、
  codex 的 `CLAUDE_CONFIG_DIR`），因为 CLI 要在容器内自刷新 token 并回写。这条现在只在
  §8.14 正文里，一旦 §8.14 被拆，会成为新的孤儿。

### 1.3.3 §10 Plugin 接入（本地 CLAUDE.md:674–706，实测 **12 条**）

> 更正：任务描述里写"9 条"，实测 12 条 bullet。

进 **§5「Prompt、能力与 Plugin」**，压缩到 **6 条硬约束**（判据：违反会导致运行时错误、
数据污染或安全边界破裂的留下；属于"怎么用"的降级到设计文档）。

**留在 CLAUDE.md 的 6 条**：

| 原条目 | 为什么必须留 |
|---|---|
| 走 SDK `options.plugins`，**不**走 settings.json 的 `enabledPlugins` / `CLAUDE_CODE_PLUGIN_SEED_DIR` | v2 方案已废；写错这条 plugin 静默不加载 |
| `ContainerInput.plugins` 就地**派生新 input**，禁止原地 mutate | 队列/日志/重试路径共享同一 input 引用，mutate 会串号 |
| 路径必须是已展开绝对路径；Docker 侧一定带 `snapshots/` 前缀，Host 侧走 `DATA_DIR` 拼接；**不允许 `~` 字面量** | SDK/CLI 不保证展开，写错直接加载失败 |
| catalog 按内容 hash 寻址且 **immutable**；runtime 与 catalog **始终独立 inode**（`copyTreeIsolated`） | host 模式 bypass-permissions agent 的写穿透不能污染共享 catalog —— 这是安全边界 |
| `container-runner.ts` 的 **host / docker 两条 spawn 路径 materialize 必须对称** | 不对称 = 两条路径 runtime 不一致，且只在其中一条能复现 |
| 运行中 agent **不热加载** plugin 变化，UI 必须提示"下次新会话生效" | 用户直接感知的行为契约 |

**降级到 `docs/claude-code-plugin-automation-design.md` 的 6 条**（CLAUDE.md 只留一条指针）：
依赖检测是 best-effort 警告 · `DELETE /marketplaces/:name` 只清调用者自己的 refs ·
`PATCH /enabled` 的 read-modify-write 范式 · runtime versioned snapshot 布局细节 ·
自动 scan 默认开启与 `pluginAutoScan` 开关 · v3 时代两个已废 endpoint。

> 注意：`docs/API.md` 的 Plugins 小节已经写了后四条中的大部分，降级不会丢信息。

### 1.3.4 禁止手动创建 launchd plist

进 **§10 开发与验证**，与另外两条并列成"三条运维红线"：

1. 关服只能杀监听进程：`lsof -ti:PORT -sTCP:LISTEN | xargs kill`。
   宽泛的 `lsof -ti:PORT | xargs kill` 会杀掉 OrbStack/Docker 网络代理，让 daemon 崩溃。
   （upstream CLAUDE.md:322 有一条一模一样的规则，两边独立写出，合并时不会冲突。）
2. **禁止手写 launchd plist**。统一走 `make launchd-install`（模板 `config/com.happyclaw.plist`）。
   第二份 plist 会造成双服务抢 3000 端口 → 无限 crash loop 且截断有效日志。
   `make launchd-install` 里已有冲突检测（`Makefile:436-441`），手写绕过它。
3. 容器以非 root `node` 用户执行；改 `container/Dockerfile` 或 `container/entrypoint.sh`
   后必须 `./container/build.sh` 重建镜像。

## 1.4 必须新补的

### 1.4.1 8 张已建但零提及的表

实测：8 张表在 `src/db.ts` 全部有 `CREATE TABLE`，在 `CLAUDE.md` **命中数全部为 0**。

进 §7 的核心表族清单。但**不能只是把表名列进去** —— 其中 5 张的真实状态是"建了没人用"，
只列表名会让下一个人以为能用。按实测的消费链分三档写：

| 表 | `src/db.ts` 内 SQL | db.ts 之外的 SQL | 生产代码调用方 | 状态 |
|---|---|---|---|---|
| `turn_events` | 9 | 0 | `src/turn-trace.ts` → `src/web.ts:2515` → `src/routes/groups.ts` → `web/src/components/chat/TurnTracePanel.tsx` | **✅ 端到端活的**（本地独有，upstream 无此表） |
| `workspaces` | 6 | 0 | `rebuildWorkspaceProjection()` / `verifyWorkspaceProjection()`，`src/index.ts:3290` 每次启动重建 | **⚠️ 只写不读**：投影每次开机重建，但全仓无任何读取方 |
| `workspace_runtime_sessions` | 4 | 0 | 同上（同一次投影一起重建） | **⚠️ 只写不读** |
| `agent_channel_mounts` | 8 | 0 | `migrateTargetMainJidToChannelMounts()` + `reconcileChannelMounts()`，`src/index.ts:3262` | **⚠️ 只写不读**：路由仍由 `target_main_jid` 提供（`index.ts:3274` 的日志原话） |
| `agent_profiles` | 8 | 0 | 读：`src/container-runner.ts:701` `getWorkspaceAgentProfile()`；**写：仅测试** | **🟡 有表无入口**（详见 §1.4.3） |
| `workspace_agent_profiles` | 4 | 0 | 同上 | **🟡 有表无入口** |
| `agent_profile_prompt_versions` | 2 | 0 | 只被 `createAgentProfile` / `updateAgentProfile` 写，而这两个只有测试调用 | **🟡 有表无入口** |
| `agent_builder_drafts` | **0** | 0 | 无 | **🔴 纯死表**：只有 `CREATE TABLE`，零条 SQL |

写进 §7 的形式（并入 upstream 的分族格式）：

```markdown
- 工作区与会话：`registered_groups`、`sessions`、`conversation_runtime_state`、
  `conversation_runtime_sessions`、`conversation_handoff_summaries`
- 执行轨迹：`turn_events`（本地独有）
- 尚未接通的投影表：`workspaces`、`workspace_runtime_sessions`、`agent_channel_mounts`
  —— 由启动时的迁移/投影写入，当前**无读取方**；路由仍由 `registered_groups.target_main_jid`
  提供。改动路由前先确认这三张表是否已成为真相源。
- Agent 档案（有表无入口，见 §2）：`agent_profiles`、`workspace_agent_profiles`、
  `agent_profile_prompt_versions`、`agent_builder_drafts`
```

> 这一段同时是决策 8（`workspaces` 投影按 folder 改 36 行）和决策 19（`channel_mounts` 权威表）
> 的**文档前置** —— 阶段 2/5 改完之后，这里的"⚠️ 只写不读"要跟着改成"权威表"。

### 1.4.2 pm2 与 launchd 的运行模型

现状（实测）：`Makefile` 同时存在两套托管路径 —— `_start-pm2` / `_start-direct`
（`Makefile:69,77`），`dev` / `dev-backend` 会自动暂停并恢复 pm2（`Makefile:26-31`），
`start` 按"pm2 是否注册过 happyclaw"分流（`Makefile:61-62`），`stop` 同样分流（`Makefile:138`）；
另一套是 launchd 五个 target（`launchd-install/uninstall/restart/status/log`，`Makefile:434-472`）
+ `config/com.happyclaw.plist` + `scripts/launchd-start.sh`。

而 **CLAUDE.md 和 README 里 pm2 出现 0 次**。这不是"本地约束没写"，是**文档缺口**：
读文档的人不会知道 `make start` 可能不是前台阻塞、而是 `pm2 restart`。

决策 72 已定：**删 pm2**（实测服务由 launchd 托管，`com.happyclaw` PID 直挂 init）。
所以 §10 要写的是**删完之后的**单一模型，四句话：

```markdown
运行模型只有一套：launchd。

- 常驻托管：`make launchd-install` 注册 `com.happyclaw`（开机自启），
  `make launchd-{restart,status,log}` 运维，`make launchd-uninstall` 卸载。
- 前台调试：`make start` 前台阻塞、日志直出终端；`make dev` / `make dev-backend`
  用 tsx watch。前台运行时 Ctrl+C 停止，不要用 `make stop`。
- 日志：launchd 模式写 `data/launchd-{stdout,stderr}.log`，
  由 `scripts/rotate-logs.sh --if-due` 轮转。
- 不使用 pm2。Makefile 里的 pm2 分支已在阶段 6 删除；不要重新引入第二套托管。
```

同时 §10 的命令表要修正：本地 §11 现在写 "`make start` 一键启动生产环境（前台阻塞运行）"
和 "`make stop` 停止占用 3000 端口的服务" —— 在 pm2 分支还在的当下这两句都是**条件成立**，
删 pm2 之后才无条件成立。文档改动要与 Makefile 改动**同一个 commit**。

### 1.4.3 Agent 档案「有表无入口」的半落地状态

这是 8 张表里最需要写清楚的一档，因为**读路径是活的**：
`src/container-runner.ts:701` 每次 spawn 都会 `getWorkspaceAgentProfile(group.folder, group.created_by)`。

但写路径不存在：

- `src/routes/` 19 个模块，**没有** agent-profiles 路由（只有 `agent-definitions.ts`，那是另一回事）；
- `web/src/` 全文 0 命中；
- `createAgentProfile` / `setWorkspaceAgentProfile` / `updateAgentProfile` 的调用点**只有
  `tests/agent-profiles-db.test.ts`**；
- `getDefaultAgentProfile` / `updateAgentProfile` 外部引用数 = 0。

净效果：表永远是空的，`getWorkspaceAgentProfile` 永远返回 `null`，`container-runner` 走
兜底分支。**功能等价于不存在，但代码看起来像存在。**

写进 §2 产品模型末尾，标题就叫「当前落地边界」：

```markdown
### 当前落地边界

产品层级图里的 Agent Profile 层**当前只有数据层与一个读取点**：

- `agent_profiles` / `workspace_agent_profiles` / `agent_profile_prompt_versions`
  已建表，`src/container-runner.ts` 在 spawn 前会读取工作区绑定的档案；
- 但**没有创建入口**（无 HTTP 路由、无 Web 页面），写访问器只在测试中被调用，
  因此运行时该查询恒为空、恒走兜底人格。
- `agent_builder_drafts` 是纯占位表，零 SQL。

结论：**当前人格来自工作区 `CLAUDE.md` 与 `container/agent-runner/prompts/`，
不来自 Agent Profile。** 要启用档案层，需要先补写入口，不要假设它已生效。
```

> 决策 56（只要 Agent-first 核心 2400 行）和决策 57（砍对话式 Agent Builder）落地后，
> 这一段要么改成"已接通"，要么把 `agent_builder_drafts` 一起删表。在此之前它必须显式存在。

### 1.4.4 三运行时能力矩阵

进 §3.3 Agent Runner。这是决策 86（建能力矩阵，并入 SDK 特性探测）的**文档面**，
也是 `merge-test-plan.md` §5.3 那张验收矩阵的静态版本。

CLAUDE.md 里放**结构性差异**（不随版本变、决定怎么写代码），不放**验收状态**
（那属于测试文档）：

| 能力 | Claude | Codex | Grok |
|---|---|---|---|
| 驱动方式 | Agent SDK `query()` | CLI exec | ACP / JSON-RPC over stdio |
| 会话模型 | 常驻 + IPC 注入 | 单 turn re-spawn | 单 turn re-spawn |
| `supportsNativeResume` | ✓ | ✓ | ✓ |
| `supportsLiveInput`（run() 内可收后续消息） | ✓ | — | — |
| MCP 注册 | 同进程 `createSdkMcpServer()` | 独立进程 `happyclaw-mcp-server.ts` | 同左，经 ACP `session/new` 的 `mcpServers` |
| 系统提示注入 | SDK `systemPrompt` | 项目文档回退文件 | ACP `_meta.rules`（**追加**，不可整体替换） |
| 用量口径 | `input` 与 `cacheRead` 分列，可相加 | `input` **已含** `cacheRead` | 同 Codex |
| subagent | SDK `agents` 选项 | 运行时内置 | 运行时内置 `spawn_subagent` |
| Workflow 可视化 / 后台任务挂流 / subagent 运行时契约 | ✓ | — | — |

`—` 是**结构性不可能**，不是缺陷；三项 Claude-only 的原因写在表下一行
（单轮 re-spawn 模型物理上没有后台任务）。

用量口径那两行是这张表里**最值钱**的：决策 41 实测 codex 输入膨胀 1.853×、grok 1.783×，
按 Claude 口径相加会错扣。有这张表，改计费代码的人不需要先读 §8.14 才知道。

## 1.5 必须删的

### 1.5.1 §11 约束测试表（CLAUDE.md:821–848，28 行）

**整节删除**，包括表格上方的"测试框架：vitest 4.1.1"和下方的"重要约束"三条。

表格 13 行，逐行核对结果：

| 表里写的 | 实测 |
|---|---|
| `tests/units/markdown.test.ts` … `tests/units/dm-integration.test.ts`（11 个） | `tests/units/` **目录不存在** |
| `tests/channel-prefixes.test.ts` | 不存在（实际是 `tests/channel-mounts.test.ts` 等 119 个扁平文件，无此名） |
| `tests/helpers/im-utils.ts` | 不存在（`tests/helpers/` 下只有 `legacy-runtime-owner.ts`） |

**13 行全部无效**，配合正文的重复引用共 17 条 check-docs 错误。

同时删除表下的三条"重要约束"，因为它们都建立在这套不存在的结构上：
- "`make test` 必须在 Phase 2/3 重构前后都通过" —— Phase 0/2/3 这套编号在仓库任何地方都不再存在；
- "测试中的纯函数来自 `tests/helpers/im-utils.ts`（Phase 2 提取到 `src/im-utils.ts` 后切换导入源）"
  —— 两个文件都不存在，`src/im-utils.ts` 也不存在（实际是 `src/im-command-utils.ts`）；
- "`ALL_IM_CHANNELS` 数组在 `tests/channel-prefixes.test.ts` 和 `tests/units/jid-routing.test.ts` 中定义"
  —— 两个文件都不存在。

**替代内容（§10 里 2 行）**：

```markdown
测试位于 `tests/`（扁平，119 个 `*.test.ts`）与 `web/tests/`，
由根目录单一 vitest 实例统一发现，配置见 `vitest.config.ts`。
```

不再维护测试清单表 —— 这正是它烂掉的原因（119 个文件，手工表永远追不上）。

### 1.5.2 check-docs 的 38 条逐条归类

按"路径写错" vs "内容已死" vs "脚本误报"三档分：

| 档 | 条数 | 明细 | 处理 |
|---|---|---|---|
| **内容已死** | 17 | `CLAUDE.md:829-841,846,847×2,898` 全部指向 `tests/units/*`、`tests/channel-prefixes.test.ts`、`tests/helpers/im-utils.ts` | **删整节**（§1.5.1）。这批不是路径写错 —— `tests/units/` 从未在本仓库存在过（`git log --diff-filter=A -- tests/units` 无记录），是从某个未落地的重构计划里抄来的 |
| **路径写错** | 1 | `CLAUDE.md:637` 写 `container/agent-runner/src/happyclaw-mcp-server.js` | 源文件是 `.ts`，构建产物是 `container/agent-runner/dist/happyclaw-mcp-server.js`。**改成 `.ts`**（文中语境是"复用哪个模块"，指源文件） |
| **脚本误报** | 1 | `CLAUDE.md:763` 的 `### \`src/affected-file.ts\`` | 这是 §10.1 PR 正文 **markdown 模板**里的占位符，不是真实路径。§1.5.3 一并处理 |
| **结构性缺口** | 19 | `docs/API.md` 未索引 19 个路由模块 | 不是错误内容，是**缺内容**。见 §1.6 |

结论：38 条里 **只有 1 条是真正的"路径写错"**，17 条是死内容，1 条是误报，19 条是缺口。
"逐条修路径"是错误的处置方式 —— 主要工作量在删和补。

### 1.5.3 脚本查不出的死内容

`check-docs.mjs` 只查反引号路径、markdown 链接、`make` target 和 API 索引。以下四类它看不见，
需要人工删：

| 死内容 | 位置 | 为什么死 | 处理 |
|---|---|---|---|
| **§10.1 Issue/PR 正文长模板** | CLAUDE.md:707–767（**61 行**，含 `## 用户现象` 等 8 个伪二级标题，把文档大纲搞乱） | 模板属于协作流程，不是工程约束；且模板里的 `src/affected-file.ts` 触发 check-docs 误报 | 移到 `.github/ISSUE_TEMPLATE/bug.md` 与 `.github/pull_request_template.md`（CI 那步正好要建 `.github/`）。CLAUDE.md §11 留标题前缀表 + 一句指针 |
| **"约束测试工程（Phase 0）"里的阶段编号** | CLAUDE.md:821 及其三条约束 | Phase 0/2/3 编号在仓库任何地方都不存在 | 随 §1.5.1 整节删 |
| **硬编码的易变枚举** | §2.3 "14 个通用工具 + 3 个 Discord 工具"；§2.2 "15 个 Store"；§4.2 "5 种权限"；§2.2 "React 19 + Vite 6" | CLAUDE.md 自己 §10 就写着"易变枚举写指针，不硬编码"，正文却在违反 | 全改成指针（`createMcpToolCatalog()` / `web/src/stores/` / `src/permissions.ts` / `web/package.json`） |
| **`src/im-utils.ts`** | CLAUDE.md:846 正文（非反引号形式的那处） | 文件不存在，实际是 `src/im-command-utils.ts` | 随 §1.5.1 删 |

## 1.6 `docs/API.md`：补 19 个路由模块索引

`checkApiRouteModuleIndex()` 的判据很简单：遍历 `src/routes/*.ts`，要求 `docs/API.md`
的正文里出现字面量 `src/routes/<name>.ts`。当前 19 个模块**一个都没出现** ——
`docs/API.md` 现在是按"功能域"组织的裸端点列表，没有回指源文件。

同时 `checkInlineRepositoryPaths()` 也会扫 `docs/API.md`，所以新加的每条路径必须真实存在
（19 个都存在，已核）。

### 组织方式

在文件头部加一张**模块索引表**（满足脚本），正文各小节保持现有的端点清单（人读），
两者用小节标题对齐。这样脚本校验和人类可读性各得其所，且未来新增路由时
"改一处表 + 加一节"是机械动作。

索引表放在现有引言之后、`## 认证` 之前：

```markdown
## 路由模块索引

> 新增或删除 `src/routes/*.ts` 时必须同步本表 —— `npm run docs:check` 会逐个校验。

| 模块 | 挂载前缀 | 本文小节 | 说明 |
|------|---------|---------|------|
| `src/routes/auth.ts` | `/api/auth` | [认证](#认证) | 登录 / 注册 / 设置向导 / Profile |
| `src/routes/groups.ts` | `/api/groups` | [群组](#群组) | 工作区 CRUD、消息分页、会话重置、群组级环境变量 |
| `src/routes/files.ts` | `/api/groups` | [文件](#文件) | 上传 / 下载 / 删除 / 目录（与 groups 共用前缀） |
| `src/routes/memory.ts` | `/api/memory` | [记忆](#记忆) | 记忆文件读写与全文检索 |
| `src/routes/config.ts` | `/api/config` | [配置](#配置) | Claude / IM 通道 / 系统设置 / 外观 |
| `src/routes/tasks.ts` | `/api/tasks` | [任务](#任务) | 定时任务 CRUD + 执行日志 |
| `src/routes/skills.ts` | `/api/skills` | [Skills](#skills) | Skills 列表与管理 |
| `src/routes/admin.ts` | `/api/admin` | [管理](#管理) | 用户 / 邀请码 / 审计 / 注册设置 |
| `src/routes/browse.ts` | `/api/browse` | [目录浏览](#目录浏览) | 受挂载白名单约束的目录枚举 |
| `src/routes/mcp-servers.ts` | `/api/mcp-servers` | [MCP Servers](#mcp-servers) | per-user MCP Server CRUD |
| `src/routes/plugins.ts` | `/api/plugins` | [Claude Code Plugins](#claude-code-plugins) | catalog / enabled / materialize |
| `src/routes/agent-definitions.ts` | `/api/agent-definitions` | [自定义 SubAgent](#自定义-subagent) | SubAgent 定义管理 |
| `src/routes/agents.ts` | `/api/groups` | [Sub-Agent](#sub-agent) | `/api/groups/:jid/agents` |
| `src/routes/workspace-config.ts` | `/api/groups` | [工作区配置](#工作区配置) | `/api/groups/:jid/workspace-config` |
| `src/routes/monitor.ts` | `/api` | [监控](#监控) | `/api/status`、`/api/health`（health 无需认证） |
| `src/routes/usage.ts` | `/api/usage` | [用量统计](#用量统计) | 日汇总 / 明细 / 模型与用户维度 |
| `src/routes/billing.ts` | `/api/billing` | [计费与订阅](#计费与订阅) | 套餐 / 订阅 / 余额 / 兑换码 |
| `src/routes/bug-report.ts` | `/api/bug-report` | [Bug 报告](#bug-报告) | Bug 收集 |
| `src/routes/model.ts` | `/api/model` | [模型与运行时](#模型与运行时) | 系统 / 工作区默认、会话级切换 |
```

挂载前缀已按 `src/web.ts:385-403` 逐行核对（`files.ts` / `agents.ts` /
`workspace-config.ts` 三者与 `groups.ts` 共用 `/api/groups`，`monitor.ts` 挂在裸 `/api`）。

### 需要新写的小节

现有 `docs/API.md` 缺 5 个域的端点清单：**Skills · 自定义 SubAgent · 工作区配置 ·
计费与订阅 · 模型与运行时**（`bug-report` 只有一个端点，一行即可）。每节模板：

```markdown
## <域名>

> 源文件：`src/routes/<name>.ts` · 挂载前缀 `<prefix>`

| Method | Path | Auth | 用途 |
|--------|------|------|------|
| `GET` | `/api/...` | 登录 / admin(`perm`) | … |
```

统一成表格形式（现在是裸列表 + 一处表格混用）。改完后 `docs/API.md` 从 112 行
增到约 230 行 —— 这部分**不占 CLAUDE.md 的 cache_read 预算**，只在改 API 时按需 Read。

## 1.7 执行顺序与验收

必须按序，因为后一步依赖前一步的产物：

```
1. 建 .github/{ISSUE_TEMPLATE/bug.md,pull_request_template.md}   ← 承接 §10.1 的 61 行模板
2. 建 docs/RUNTIMES.md                                            ← 承接 §8.14 的 ACP 细节
3. 补 docs/API.md 模块索引表 + 5 个缺失小节                        ← 消掉 19 条
4. 重写 CLAUDE.md（904 → ~426）                                    ← 消掉 19 条
5. 落地 scripts/check-docs.mjs + package.json 的 docs:check        ← 从 upstream 取，零改动
6. node scripts/check-docs.mjs  →  必须 0 错
7. CI 里把 docs:check 的 continue-on-error 去掉                    ← 见第二节 §2.5
```

**验收**（对应 `merge-test-plan.md` G6 的 ①②）：

- `npm run docs:check` 退出码 0；
- `wc -l CLAUDE.md` 在 400–450 之间；
- 抽查：8 张表在 §7 全部出现，且三档状态标注与 `git grep` 结果一致；
- 抽查：`grep -c 'pm2' Makefile CLAUDE.md README.md` 全为 0（决策 72 与文档同步落地）。

---

# 第二节 · CI 的实际配置

## 2.1 前置条件

CI 落在**阶段 6.3**，它有两个硬前置，缺一不可：

| 前置 | 现状（实测） | 缺了会怎样 |
|---|---|---|
| **阶段 2.1 格式基线统一** | `npx prettier --check "src/**/*.ts"` → **84 个文件不合格**；4 个 `stream-event` 生成文件也不合格 | 格式步骤第一次跑就红，且是 84 个文件的红，无法分辨真问题 |
| **阶段 1.2 后台任务挂流四个洞** | `buildBackgroundTaskSummaryPrompt` / `shouldForceBackgroundTaskSummary` 在本地 agent-runner 中**不存在** | upstream CI 的 `self-test:agent-runner` 步骤直接 import 这两个符号，会 import 失败 |

其余步骤（`make sync-types` + `git diff --exit-code`、`make typecheck`、`vitest run`、
`npm run build:all`）在**当前 HEAD 上就能通过**，已实测。

## 2.2 workflow 文件

落盘到 `.github/workflows/ci.yml`（本地当前无 `.github/` 目录）：

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  # 依赖不锁版本（决策 70），漂移必须有带外发现渠道：每天 03:17 UTC 空跑一次。
  # 没有这条，SDK/CLI 的破坏性更新只会在下一个 PR 上爆炸，且看起来像那个 PR 的锅。
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

permissions:
  contents: read

# 同一分支上被后续 push 取代的运行直接取消；不锁版本时 CI 偏慢，省资源。
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  validate:
    runs-on: ubuntu-24.04
    # 30 而非 upstream 的 20：不锁版本时安装阶段要真实解析 registry，
    # 且 agent-runner 会拉 claude-agent-sdk / claude-code / codex 三个大包。
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          # check-format-changed.mjs 要算 merge-base，必须全history。
          fetch-depth: 0

      # 不设 cache: npm —— setup-node 的内置缓存强制要求 lockfile 存在，
      # 找不到会直接 fail the step。缓存改由下面的 actions/cache 手工做。
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22.22.3

      # 只缓存 npm 的内容寻址下载目录（~/.npm），不缓存 node_modules。
      # ~/.npm 里是 tarball，按 integrity 寻址，命中与否不影响版本解析结果，
      # 因此"缓存"与"始终最新"不冲突。node_modules 缓存则会真的钉住版本，禁止。
      - name: Restore npm cache
        uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4
        with:
          path: ~/.npm
          # 无 lockfile，改用 package.json 内容 + 周序号做 key：
          # 同一周内复用，跨周强制回源，避免缓存把旧 tarball 留太久。
          key: npm-${{ runner.os }}-node22-${{ hashFiles('package.json', 'web/package.json', 'container/agent-runner/package.json') }}-${{ github.run_id }}
          restore-keys: |
            npm-${{ runner.os }}-node22-${{ hashFiles('package.json', 'web/package.json', 'container/agent-runner/package.json') }}-
            npm-${{ runner.os }}-node22-

      - name: Configure npm
        run: |
          npm config set fetch-retries 5
          npm config set fetch-retry-maxtimeout 120000
          npm config set audit false
          npm config set fund false

      # 不用 npm ci：它要求 lockfile 存在，而三个 lockfile 都在 .gitignore
      # （.gitignore:34-37，决策 70 明确不提交）。
      # --no-package-lock 让 npm 既不读也不写 lockfile，保证工作树干净，
      # 后面 git diff 类断言不会被意外生成的 package-lock.json 干扰。
      - name: Install dependencies
        run: |
          npm install --no-package-lock
          npm --prefix web install --no-package-lock
          npm --prefix container/agent-runner install --no-package-lock

      # 记录本次实际解析到的版本。不锁版本时这是唯一的事后取证手段：
      # 某天 CI 突然红了，靠这段日志才能对比出是哪个包动了。
      - name: Record resolved dependency versions
        run: |
          echo '### 本次解析到的关键依赖' >> "$GITHUB_STEP_SUMMARY"
          echo '```' >> "$GITHUB_STEP_SUMMARY"
          npm ls --depth=0 --json 2>/dev/null \
            | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const[k,v]of Object.entries(j.dependencies||{}))console.log(`${k} ${v.version??"?"}`)})' \
            >> "$GITHUB_STEP_SUMMARY" || true
          npm --prefix container/agent-runner ls --depth=0 2>/dev/null \
            | grep -E '@anthropic-ai|@openai|@agentclientprotocol' >> "$GITHUB_STEP_SUMMARY" || true
          echo '```' >> "$GITHUB_STEP_SUMMARY"

      # 只检查本次改动的文件。全量 prettier --check 当前有 84 个文件不合格，
      # 阶段 2.1 的格式基线统一之后才可能全绿，而那属于合并主体、不属于 CI。
      - name: Check changed-file formatting
        run: npm run format:check
        env:
          FORMAT_BASE_REF: ${{ github.event.pull_request.base.sha || github.event.before }}

      # 共享类型的四份副本必须一致。这是本地已有的不变量，当前就绿。
      # 注意：不做 upstream 那步 `npx prettier --check` 生成文件 ——
      # 那四个文件当前不合 prettier 规范，等阶段 2.1 之后再打开（见下方注释）。
      - name: Verify generated type sources
        run: |
          make sync-types
          git diff --exit-code -- \
            shared/stream-event.ts \
            src/stream-event.types.ts \
            web/src/stream-event.types.ts \
            container/agent-runner/src/stream-event.types.ts
          git diff --exit-code -- \
            shared/image-detector.ts \
            shared/channel-prefixes.ts \
            src/image-detector.ts \
            src/channel-prefixes.ts \
            container/agent-runner/src/image-detector.ts \
            container/agent-runner/src/channel-prefixes.ts
          # 阶段 2.1（格式基线统一）完成后，取消下一行注释：
          # npx prettier --check shared/stream-event.ts src/stream-event.types.ts web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts

      - name: Check agent-runner prompts
        run: bash scripts/check-agent-runner-prompts.sh

      - name: Typecheck
        run: make typecheck

      # 单 job 单次调用即可覆盖 tests/ 与 web/tests/：
      # 实测 120 文件 / 1429 用例 / 4.93s，没有拆 job 的理由。
      # 没有测试需要真实 Docker daemon（涉及 docker 的 5 个文件全部 mock spawn）。
      - name: Test
        run: npm test -- --run

      - name: Build
        run: npm run build:all

      # 阶段 6.1 完成前，文档检查只报告不拦截（当前实测 38 条错误）。
      # 阶段 6.1 落地后删掉 continue-on-error 这一行，本步骤即成为硬门槛。
      - name: Docs consistency (non-blocking until phase 6.1)
        continue-on-error: true
        run: npm run docs:check

      # 阶段 1.2（后台任务挂流四个洞）落地后取消注释：
      # scripts/self-test-agent-runner.ts 直接 import
      # buildBackgroundTaskSummaryPrompt / shouldForceBackgroundTaskSummary，
      # 这两个符号当前在本地 agent-runner 中不存在。
      # - name: Agent runner self-test
      #   run: npm run self-test:agent-runner
```

## 2.3 逐处偏离 upstream 的理由

| # | upstream | 本配置 | 理由 |
|---|---|---|---|
| 1 | `on: pull_request, push` | 加 `schedule`（每日）+ `workflow_dispatch` | **不锁版本的必要补偿**。lockfile 的作用之一是让"依赖变了"和"代码变了"可区分；没有它，唯一的替代是让依赖漂移在**无代码改动**的定时运行里先暴露。这也正好服务决策 69（SDK 保持最新 + 运行时探测）—— 定时任务红了就是该跑 `make update-sdk` 的信号 |
| 2 | 无 concurrency | 加 `concurrency`，PR 上 cancel-in-progress | 不锁版本时装依赖更慢，取消被取代的运行省时间；`push: main` 上不取消（要保住每次 main 的记录） |
| 3 | `timeout-minutes: 20` | `30` | 安装阶段要真实解析 registry；agent-runner 拉 `@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/claude-code`、`@openai/codex` 三个大包 |
| 4 | `setup-node` 带 `cache: npm` + `cache-dependency-path: 三个 package-lock.json` | **删掉 cache 参数**，改手工 `actions/cache` | setup-node 的内置缓存在找不到 `cache-dependency-path` 指定的文件时**直接 fail the step**（不是降级）。三个 lockfile 都在 `.gitignore:34-37`，永远不存在 |
| 5 | `npm ci` ×3 | `npm install --no-package-lock` ×3 | **决策 70 的直接后果**。`npm ci` 硬性要求 lockfile 存在且与 package.json 一致，第一步就失败。`--no-package-lock` 让 npm 既不读也不写 lockfile：不读 = 每次解析到 `"*"` 的最新版（保住"始终最新"）；不写 = 工作树保持干净，后续 `git diff --exit-code` 步骤不会被意外生成的 `package-lock.json` 污染 |
| 6 | 无 | 新增 `Configure npm`（retries / 关 audit&fund） | 每次都真实回源，registry 抖动概率高于 `npm ci` 走缓存的场景，5 次重试是必要的抗抖 |
| 7 | 无 | 新增 `Record resolved dependency versions` 写入 Step Summary | **不锁版本的取证手段**。CI 某天红了，需要能回答"是哪个包动了"。lockfile 仓库靠 `git diff package-lock.json` 回答，我们只能靠日志 |
| 8 | `Verify generated type sources` 含 `npx prettier --check` 四个生成文件 | 该子步骤**注释掉**，但**扩充**了 `git diff --exit-code` 的覆盖：从 4 个 stream-event 文件扩到 10 个（加上 `image-detector` / `channel-prefixes` 各 3 份） | prettier 子步骤当前必红（实测那 4 个文件不合规范），等阶段 2.1 再开。扩充 diff 覆盖是**本地增量**：CLAUDE.md §3.2 明确 `make sync-types` 同步三组共享类型，upstream 只校验其中一组，另两组漏网 |
| 9 | 无 | 新增 `Check agent-runner prompts` | 本地已有 `scripts/check-agent-runner-prompts.sh` 且**当前就通过**（实测退出码 0）。upstream 的 CLAUDE.md §10 要求改 prompt 后跑它，但 upstream CI 里没这一步 —— 补上是零成本的净收益 |
| 10 | `Test: npm test -- --run` | 相同 | 无偏离。见 §2.6 |
| 11 | `Agent runner self-test` | **注释掉** | 见 §2.1 前置条件表第二行 |
| 12 | 无 docs 步骤（upstream 在 pre-commit 门槛里跑） | 新增 `Docs consistency`，带 `continue-on-error: true` | 见 §2.5 |
| 13 | `prettier: 3.8.3`（精确锁） | **建议本地也锁死 `3.8.3`** | 见下方补充 |

### 补充：唯一建议锁死的依赖

决策 70 的"不锁版本"针对的是 **Claude SDK / CLI / 容器内置工具**（CLAUDE.md §10 的
"始终使用最新版本"约束）。**Prettier 是唯一应该例外的**：

- 一个 prettier minor 版本可以重排全仓代码，让 `format:check` 在**零代码改动**的 PR 上变红；
- 这种红既不是真问题，也无法通过"更新依赖"消除（下一次运行可能又装到别的版本）；
- prettier 不是 Agent 运行时的一部分，锁死它不影响任何"始终最新"的目标。

改动：`package.json` 的 `devDependencies.prettier` 从 `^3.8.1` 改成 `3.8.3`（与 upstream 一致）。

`typescript` **不建议锁**：TS 新版本报出的新类型错误是真信号，正是"运行时探测 + 早发现"
想要的。同理 `vitest`。

## 2.4 三个契约测试的处理

三个文件（`reproducible-build-contract.test.ts` · `makefile-runtime-contract.test.ts` ·
`builtin-skill-bootstrap-contract.test.ts`）在**本地当前不存在** —— 它们是 upstream 独有，
会在阶段 2 的 `git merge` 里作为新增文件带进来。

**结论：删掉文件，不是排除。** 并加一条守卫测试防止未来静默回归。

### 为什么不用 vitest exclude

| 方案 | 问题 |
|---|---|
| `vitest.config.ts` 的 `exclude` 加三个路径 | 文件仍在树里，会被 typecheck 编译、被 `grep` 命中、被下一个人当成"有效的约束"读。而这三个测试的内容与 CLAUDE.md 的约束**直接矛盾**（要求 lockfile 不得 gitignore、禁 `CACHEBUST`、禁 `npm install -g`）—— 留一份说反话的文件在仓库里，比删掉危险 |
| 文件名约定（改成 `.skip.ts` / 挪进 `tests/disabled/`） | 同上，且多一套只服务于三个文件的命名规则 |
| `describe.skip` | 最差：看起来在跑，实际全绿，永远不会有人发现它是空的 |

### 具体做法

**阶段 2 解冲突时**：

```bash
git rm tests/reproducible-build-contract.test.ts \
       tests/makefile-runtime-contract.test.ts \
       tests/builtin-skill-bootstrap-contract.test.ts
# 同批一起删（merge-test-plan §6.2「其他不引入」）：
git rm tests/frontend-pwa-retirement.test.ts \
       tests/legacy-paired-chat-isolation-contract.test.ts \
       tests/agent-builder.test.ts \
       tests/agent-builder-turn-auth.test.ts \
       tests/agent-builder-runtime-scope-contract.test.ts \
       tests/agent-profile-generator.test.ts \
       tests/agent-capability-preview.test.ts \
       tests/capability-lock.test.ts \
       tests/capability-runtime-mutation.test.ts
```

**同时新增一个守卫测试** `tests/upstream-optout-registry.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 明确不采纳的 upstream 测试登记表。
 *
 * 这些文件断言的行为与本地决策直接矛盾（见 docs/upstream-merge-plan.md 决策
 * 64/70/71/72/57）。它们在阶段 2 的合并里被删除。本测试的作用是：
 * 未来任何一次 upstream 合并如果把它们带回来，这里立刻变红，
 * 强迫做一次显式决定，而不是让矛盾的约束静默生效。
 *
 * 要重新采纳某个文件：先改决策台账，再从本表移除。
 */
const OPT_OUT: Array<[file: string, reason: string]> = [
  ['reproducible-build-contract.test.ts', '决策 70：lockfile 不提交；CLAUDE.md §10 要求 SDK/CLI 始终最新，CACHEBUST 与 releases/latest 是其实现手段'],
  ['makefile-runtime-contract.test.ts', '决策 72：pm2 已删，但该测试还要求一批 upstream 特有 target'],
  ['builtin-skill-bootstrap-contract.test.ts', '本地 builtin-skills 无 .catalog.json marker，引入后每次 make start 会整体覆盖自定义改动'],
  ['frontend-pwa-retirement.test.ts', '决策 64：保本地 PWA 离线能力'],
  ['legacy-paired-chat-isolation-contract.test.ts', '决策 16：与「区分没覆盖/解不出来」的三行修法语义相反'],
  ['agent-builder.test.ts', '决策 57：砍对话式 Agent Builder'],
  ['agent-builder-turn-auth.test.ts', '决策 57'],
  ['agent-builder-runtime-scope-contract.test.ts', '决策 57'],
  ['agent-profile-generator.test.ts', '决策 2.5：砍 AI 辅助生成人格'],
  ['agent-capability-preview.test.ts', '决策 2.5：砍有效能力预览面板'],
  ['capability-lock.test.ts', '依赖已删除的 WebDeps.sessions'],
  ['capability-runtime-mutation.test.ts', '依赖已删除的 WebDeps.sessions'],
];

describe('upstream 测试 opt-out 登记表', () => {
  for (const [file, reason] of OPT_OUT) {
    it(`不应存在 tests/${file} —— ${reason}`, () => {
      expect(
        fs.existsSync(path.join(process.cwd(), 'tests', file)),
        `tests/${file} 又出现了。这多半是一次 upstream 合并带回来的。\n` +
          `不采纳的理由：${reason}\n` +
          `要么删掉它，要么改决策台账后从 OPT_OUT 移除本条。`,
      ).toBe(false);
    });
  }
});
```

这样"静默重新引入"变成"一次响亮失败"，成本 12 行数据 + 一次 `git rm`。

`makefile-runtime-contract.test.ts` 里**确实有价值**的部分（禁 pm2、禁 `_start-direct`）
与决策 72 一致 —— 但不要为此保留整个文件。删掉之后，如果想要这条守卫，
在 §1.7 验收里的 `grep -c 'pm2' Makefile` 已经覆盖，或另写一条三行的本地测试。

## 2.5 文档检查的接入时机

阶段 6.1（CLAUDE.md 重写）之前，`npm run docs:check` 必红 38 条。三种占位方式：

| 方案 | 评价 |
|---|---|
| 干脆不加这一步，6.1 之后再加 | 最省事，但 CI 文件要改两次，且 6.1 期间没有任何反馈：改完 CLAUDE.md 才第一次知道对不对 |
| **`continue-on-error: true`**（本配置采用） | 步骤照跑、日志完整、PR 上显示黄色警告不拦合并；6.1 落地后**删一行**即成硬门槛。零额外文件 |
| 棘轮（允许不超过 N 条，N 逐步下调） | 最严格 —— 保证只降不升。代价是要给 `check-docs.mjs` 打补丁 |

采用 `continue-on-error`。**但如果 6.1 的重写要跨多个 commit 分批做**，棘轮更值得，
补丁只有 9 行，加在 `scripts/check-docs.mjs` 末尾：

```js
// ── 本地增量：棘轮模式 ────────────────────────────────────────
// 阶段 6.1 分批重写 CLAUDE.md 期间，允许残留不超过 DOCS_CHECK_BUDGET 条，
// 但绝不允许变多。每批改完把 CI 里的 budget 调低。6.1 完成后删掉本段和 env。
const budget = Number(process.env.DOCS_CHECK_BUDGET ?? 0);
if (errors.length > 0 && errors.length <= budget) {
  console.warn(
    `Documentation consistency: ${errors.length} known issue(s) within budget ${budget}:\n` +
      errors.map((e) => `- ${e}`).join('\n'),
  );
  process.exit(0);
}
```

对应 CI 步骤改成：

```yaml
      - name: Docs consistency (ratchet, phase 6.1)
        run: npm run docs:check
        env:
          # 阶段 6.1 起始 38 条，每批下调；改完设 0 并删除本 env 与脚本末尾的棘轮段。
          DOCS_CHECK_BUDGET: 38
```

棘轮优于 `continue-on-error` 的地方：`continue-on-error` 允许错误**变多**（黄色警告
没人看），棘轮不允许。两者都不需要动 6.1 之外的任何东西。

无论选哪个，**阶段 6.1 的验收（§1.7）都是 `docs:check` 退出码 0**，
最终状态是无 budget、无 continue-on-error 的硬门槛。

## 2.6 测试组织

**一个 job，一次 `vitest run`。** 依据是实测数据，不是保守估计：

```
$ npx vitest run
Test Files  120 passed (120)
     Tests  1429 passed | 1 skipped (1430)
  Duration  4.93s
```

- 120 个文件 = `tests/` 下 119 个 `*.test.ts` + `web/tests/MarkdownRenderer.test.tsx`。
  根 `vitest.config.ts` 的 discovery 已经覆盖 `web/tests/`，**不需要为前端单开 job**
  （前提是 `npm --prefix web install` 先跑过，本配置已保证）。
- 4.93 秒。即使按 `merge-test-plan.md` §6.1 引入七组约 90 个 upstream 测试 + §6.3 新写 6 个，
  文件数约 216，线性外推也只到 ~10 秒。**拆 job 的固定开销（各自 checkout + install，
  约 2–4 分钟）会是测试本身的 20 倍。**

### 关于"有些测试要起 Docker"

实测：`grep -l docker tests/*.test.ts` 命中 5 个文件
（`codex-container-conformance` / `container-runner-plugin-mount` / `plugin-expander-core` /
`plugin-inline-bash` / `plugin-utils`），逐个核对后**全部是 mock**
—— 断言的是 `spawnCalls[0].cmd === 'docker'` 这类"我们构造的命令行对不对",
不需要 daemon。`ubuntu-24.04` runner 自带 Docker，即使将来有真实需求也不用额外 service。

**唯一需要真 Docker 的是镜像构建**（`./container/build.sh`），它不在 CI 里 ——
镜像构建依赖 `CACHEBUST` + `npm install -g` 拉最新 SDK，每次都是全量、耗时数分钟，
且构建产物 CI 里用不上。留给本地 `make start` 的 `_ensure-docker-image`。

### 关于"有些测试要真调 provider"

`npm run test:real-model`（`scripts/test-real-model-smoke.ts`）**不进 CI** ——
upstream 自己的 CI 也没有它，理由在 upstream CLAUDE.md 末尾写得很清楚：
会产生真实请求和费用。它是手工 target。

同理，`merge-test-plan.md` 的 P1–P9 对等矩阵、S1–S6 静默杀手验证都是**人工步骤**，
不进 CI。CI 的职责边界是：**静态一致性 + 单元/契约测试 + 构建能过**。

### 引入 upstream 测试时的 CI 影响

`merge-test-plan.md` §6.1 的七组（A 运行时与流控 / B 计费用量 / C 渠道路由 /
D 任务租约 / E 数据库迁移 / F 安全并发 / G 前端契约）分散在阶段 2–5 引入，
不是一次性的。三条约定：

1. **随阶段引入，不预先批量拷贝**。每组测试的前置代码不落地时它必然红。
2. **引入即跑单个文件**（`npx vitest run tests/<file>`），改到绿再进 CI。
   §6.1 已标注哪些"必须改不能照抄"（`agent-runner-result-usage` 要加 codex/grok 口径分支、
   `group-queue-host-session-concurrency` 与决策 73 直接矛盾要改写）。
3. **仍然一个 job**。E 组的迁移测试会建临时 SQLite，D 组会跑租约时序 —— 都是进程内的，
   不改变单 job 的判断。

如果将来测试时长真的超过 ~2 分钟，再拆也不迟，且届时应按**耗时**拆
（vitest 的 `--shard`），不是按"要不要 Docker"拆 —— 因为没有测试要 Docker。

## 2.7 缓存策略

没有 lockfile，就不能用 lockfile hash 做 cache key。分两个问题看。

### 缓存什么

| 候选 | 决定 | 理由 |
|---|---|---|
| `node_modules/`（三份） | **禁止** | 缓存 `node_modules` 等于把上次解析出的版本钉死，直接抵消"始终最新"。这是最容易犯的错 |
| `~/.npm`（npm 的内容寻址下载目录） | **采用** | 里面是按 integrity hash 寻址的 tarball。npm 仍然会向 registry 查 metadata 决定装哪个版本，缓存只省下载。**命中与否不影响解析结果** |
| `~/.cache/ms-playwright` 之类 | 不适用 | 本仓库无此依赖 |

结论：**缓存下载层，不缓存解析结果。** 这正好把"始终最新"和"别每次重下 200MB"分开。

### key 怎么设计

```yaml
key: npm-${{ runner.os }}-node22-${{ hashFiles('package.json', 'web/package.json', 'container/agent-runner/package.json') }}-${{ github.run_id }}
restore-keys: |
  npm-${{ runner.os }}-node22-${{ hashFiles(...) }}-
  npm-${{ runner.os }}-node22-
```

三层设计的每一层都有具体作用：

1. **`${{ github.run_id }}` 后缀** —— 让主 key 每次都不同，因此**每次运行结束都会写一份新缓存**
   （GitHub 的 cache 是 immutable，同 key 第二次写会被忽略）。没有这个后缀，缓存会在第一次
   写入后永久冻结，一个月后里面全是过期 tarball，`"*"` 依赖每次都还是要全量下载。
2. **第一条 restore-key（带 package.json hash）** —— 依赖声明没变时，命中上一次同配置的缓存。
   这是绝大多数 PR 的路径。
3. **第二条 restore-key（只到 node 版本）** —— 改了 package.json 时，仍然命中最近一次任意配置的
   缓存。因为 `"*"` 依赖占了下载体积的大头，而它们的 tarball 与 package.json 改动无关。

**没有周序号轮转的必要** —— `github.run_id` 后缀已经保证每次运行都刷新缓存内容，
GitHub 自己的 7 天未访问驱逐 + 10GB 仓库配额会处理老条目。

### 缓存不是正确性依赖

关键性质：**这个缓存全部失效，CI 结果一模一样，只是慢几分钟。** 
把它写在 CI 文件的注释里，因为下一个人看到"没有 lockfile 却有缓存"时的第一反应
一定是"这会不会钉住版本"。

## 2.8 配套改动清单

CI 落地需要同批的仓库改动（都很小，全部列出以免遗漏）：

| 文件 | 改动 | 依据 |
|---|---|---|
| `.github/workflows/ci.yml` | 新建，内容见 §2.2 | 决策 71 |
| `scripts/check-format-changed.mjs` | 从 upstream 取，**零改动** | 全量 `prettier --check` 当前 84 个文件红 |
| `scripts/check-docs.mjs` | 从 upstream 取，**零改动**（棘轮补丁可选，见 §2.5） | 决策 87 |
| `package.json` scripts | `format:check` 从 `prettier --check "src/**/*.ts"` 改成 `node scripts/check-format-changed.mjs`；新增 `format:changed`、`docs:check`；预留（注释）`self-test`、`self-test:agent-runner`、`test:real-model` | 与 CI 步骤对应 |
| `package.json` devDeps | `prettier` `^3.8.1` → `3.8.3`（精确） | §2.3 补充 |
| `Makefile` | `format-check` target 会自动跟随 `npm run format:check` 的新语义（它就是 `$(PKG) run format:check`），**无需改**；但 `make test`（`vitest run`）与 CI 的 `npm test -- --run` 等价，也无需改 | — |
| `tests/upstream-optout-registry.test.ts` | 新建，内容见 §2.4 | 决策 71 + 64 + 57 |
| `.gitignore` | **不改** —— 三个 lockfile 继续 ignore | 决策 70 |
| `docs/upstream-merge-plan.md` / `docs/upstream-decision-tree.md` / `docs/merge-test-plan.md` | 把 "39 条" 订正为 "38 条" | §1.1 实测 |

### 落地顺序

```
阶段 2.1  格式基线统一（跑一次 upstream 版格式化）          ← CI 的硬前置
阶段 1.2  后台任务挂流四个洞                                ← self-test 步骤的前置
阶段 2    合并时 git rm 掉 12 个不采纳的测试 + 加守卫测试
阶段 6.1  CLAUDE.md 重写 + docs/API.md 补索引               ← 第一节
阶段 6.3  落 .github/workflows/ci.yml + 两个脚本 + package.json
          → 首次跑通后，删掉 docs:check 的 continue-on-error
          → 阶段 1.2 已完成则同时打开 self-test 步骤
```

`.github/ISSUE_TEMPLATE/bug.md` 与 `.github/pull_request_template.md`（§1.5.3）
建议与 CI 同批建 —— 反正都在建 `.github/` 目录。
