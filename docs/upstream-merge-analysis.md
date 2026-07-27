# upstream → local 合并完整影响分析

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 分析日期：2026-07-25 · 方法：9 个 subagent 逐文件读源码 + 独立 worktree 实测合并

---

## 零、方法与可信度声明

本文的数字分三类，可信度不同：

| 类型 | 来源 | 可信度 |
|---|---|---|
| **实测** | 在独立 worktree 真跑 `git merge --no-commit`，逐项统计 | 确定 |
| **读码确认** | subagent 打开源文件逐行核对 | 高 |
| **推断** | 由已确认事实外推 | 已在文中标注"估算/推测" |

**本次分析推翻了此前四个前提**（此前判断基于文件名推断，现已被读码纠正）：

| 此前判断 | 实际 |
|---|---|
| 脚本任务是本地独有 | upstream 也有 `script-runner.ts` |
| IM 回投是本地独有 | upstream 也有，且带 ACK 回执 |
| 逾期容忍窗口是本地独有 | upstream 也有 `taskBackfillGraceMs`，语义等价 |
| 计费九表是本地独有 | upstream 一张不少，`usage_events` 是叠加的第十张 |

---

## 一、规模：实测数字

```
分叉：本地领先 103 commit · upstream 领先 121 commit
diff：788 文件 · +171875 / −75800
      374 A（upstream 新增）· 204 D（本地独有，合并会删）· 210 M（双改）

实测 merge --no-commit：
      56 个冲突文件
      329 个冲突 hunk
      16,928 行落在冲突区内
      3 个 modify/delete（git 会提示）
      50 个文件被静默删除（无冲突标记）
      20 个本地导出符号静默消失
```

**关键校正：diff 体量与冲突量不相关。** upstream 改动第 11、12 大的两个文件（`UsagePage.tsx` 1693 行、`routes/agents.ts` 1591 行）**零冲突自动合并**——因为本地自基线起从未碰过它们。冲突集中在本地也大改过的文件。

| 文件 | 本地改动 | upstream 改动 | 实测冲突 hunk |
|---|---|---|---|
| `src/index.ts` | 1862+/307− | 11348+/1983− | **75** |
| `src/feishu-streaming-card.ts` | 646+/237− | 973+/322− | **34** |
| `src/container-runner.ts` | 581+/74− | 1117+/175− | **19** |
| `container/agent-runner/src/index.ts` | 620+/86− | 2891+/688− | **19** |
| `src/db.ts` | 3512+/150− | 7563+/861− | **18** |
| `container/agent-runner/src/mcp-tools.ts` | 426+/61− | 1398+/311− | **16** |
| `src/task-scheduler.ts` | 238+/9− | 2047+/421− | **10** |
| `src/web.ts` | 233+/2− | 1016+/355− | **9** |
| `src/routes/config.ts` | 1381+/186− | 1789+/325− | **8** |
| `src/feishu.ts` | 191+/18− | 2199+/680− | **8** |
| `web/src/stores/chat.ts` | 32+/2− | 1892+/526− | **3** |
| `web/src/pages/UsagePage.tsx` | **0** | 1261+/432− | **0** |
| `src/routes/agents.ts` | **0** | 1336+/255− | **0** |

---

## 二、静默丢失清单（最危险的一类）

**这是 git 不会警告、review 也看不见的部分。** 机制：upstream 删除了某段代码，本地自基线起没有修改过那**具体的行**，git 判定"一侧删除、一侧未动"→ 干净采纳删除。调用方同样被自动合并成 upstream 版本，**连编译错误都不会有**。

### 2.1 静默消失的导出符号（实测 20 个）

| 符号 | 所属特性 | 影响 |
|---|---|---|
| `addGroupMember` `removeGroupMember` `getGroupMembers` `getGroupMemberRole` `getUserMemberFolders` `isGroupShared` `canManageGroupMembers` `GroupMember` `GroupMemberAddSchema` | **工作区共享（`group_members`）** | ACL 从"owner + 成员"退化为纯 owner。upstream 有一行**无条件** `DROP TABLE IF EXISTS group_members`（不在任何版本门内，每次启动都执行）→ 32 行授权数据即刻销毁，**不可逆** |
| `PREDEFINED_AGENTS` | **预定义 SubAgent**（code-reviewer / web-researcher） | upstream 整体移除了这套体系 |
| `resolveAdminSharedRuntimeOwner` `resolvePerMessageRuntimeOwner` `resolveLatestAdminSenderOverride` `RuntimeOwnerCandidateMessage` `RuntimeOwnerCandidateUser` | **`src/runtime-owner.ts` 整个模块** | 文件被整体删除 |
| `isWeChatBypassingProxy` `updateWeChatNoProxy` | 微信代理绕过 | |
| `setFeishuTyping` | 飞书 typing 指示 | upstream 换成 `processing-indicator.ts` |
| `invalidateAllowedUserCache` | 用户白名单缓存失效 | |
| `ResolveContextFn` | | |

### 2.2 静默删除的文件（实测 50 个，非文档非测试的 7 个）

```
container/agent-runner/prompts/agent-override.md      ← 本地 index.ts 仍在加载
container/agent-runner/prompts/output.md              ← upstream 换成 output.{assistant,proactive,task}.md
container/agent-runner/prompts/skill-routing.md       ← 本地 index.ts 仍在加载
container/agent-runner/src/agent-definitions.ts       ← 自定义 SubAgent
container/skills/install-skill/SKILL.md
src/routes/agent-definitions.ts                       ← /api/agent-definitions 整个路由族
src/runtime-owner.ts
```

`agent-override.md` / `skill-routing.md` / `output.md` 被删后，本地 `index.ts` 仍在 load 它们 → `scripts/check-agent-runner-prompts.sh` 会在 typecheck 阶段失败。这是唯一一处静默删除**会被门禁抓住**的。

### 2.3 modify/delete（git 会提示，需人工决定）

```
web/src/components/groups/GroupCard.tsx        本地 16+/1−，upstream 已删
web/src/components/groups/GroupDetail.tsx      本地 96+/1−，upstream 已删
container/skills/agent-browser/SKILL.md        本地 31+/134−，upstream 已删
```

### 2.4 「干净合并但语义有坑」的 4 个文件（B 类）

这类文件 git **不报冲突**，但合并产物是坏的——因为 upstream 删掉/收窄了本地正在用的东西，而本地没改过那些具体行。

| 文件 | git 结果 | 实际后果 |
|---|---|---|
| `src/config.ts` | 干净 | upstream 删除 `updateWeChatNoProxy` / `isWeChatBypassingProxy` / `WECHAT_NO_PROXY_DOMAINS`。本地 `index.ts:20,10597` 与 `routes/config.ts:11,3657` 仍 import → **编译断裂**。断裂点在 import 行而非冲突标记里 |
| `src/web-context.ts` | 干净 | **双向静默**：本地删的 `sessions`/`getSessions` 胜出，但 upstream 新文件 `capability-runtime-mutation.ts:103` 仍引用 → 编译错误只在 `tsc` 阶段冒出。同时 upstream 删掉 `canManageGroupMembers()` 并把 `canAccessGroup`/`canModifyGroup` 里的成员判定拿掉 → **共享工作区访问能力静默移除** |
| `src/plugin-expander-core.ts` | 干净 | upstream 删 `ResolveContextFn` 重载 + 删整个 `src/runtime-owner.ts`。本地 `index.ts` 三个调用点（3619/7609/8941）传的都是 resolver 函数 → **编译断裂** |
| `src/feishu-cards/types.ts` | 干净并集 | 类型层合上了（`reasoningTokens` + `priorTextSegments` + `subAgentResults` + `codexTodos` 共存），但实现层 `builder.ts` / `sections.ts` 都冲突 → **类型能合不等于能编译** |

### 2.5 语义相反、取 upstream 会回退本地修复的

| 文件 | 本地 | upstream | 取 upstream 的后果 |
|---|---|---|---|
| `src/script-runner.ts` | `env` 从白名单放宽到 `{...process.env}`，理由"子进程 Claude CLI 需要 OAuth 凭据和 Keychain" | 大改这个文件（spawn detached + 进程树 kill + AbortSignal），但 **`env` 白名单原样保留** | 宿主机脚本任务里的 Claude CLI **丢 OAuth** |
| `container/agent-runner/src/index.ts` `queryRef` | 放宽为 `Promise<unknown>`（commit `a5dc230`，修 SDK 0.3.215 升级后 typecheck 失败） | 仍是旧写法 | **重新引入已修复的类型门禁失败** |

---

## 三、upstream 带来的新功能（按用户可感知能力组织）

### 3.1 Agent-first：Agent 成为一等产品实体

**本地已吸收数据层，未吸收产品面。** `agent_profiles` 表在，但全仓只被 `db.ts` 和 `container-runner.ts` 引用——没有管理页、没有路由、没有创建入口。当前是"有骨架无入口"。

upstream 的完整形态：

| 能力 | 说明 |
|---|---|
| **四段人格** | IDENTITY（我是谁，刻意收窄）/ SOUL（价值观，可空）/ AGENTS（工作流、拒绝规则、失败处理，**必填**）/ TOOLS（工具选择，可空）。单段 ≤20000 字符，版本化 + 内容 hash |
| **对话式 Agent Builder** | 在主对话里说"帮我建一个 Agent"，7 个 MCP 工具驱动。**确认口令机制**：每次 prepare 用 `crypto.randomBytes(4)` 生成 `确认发布 AGENT-3F9A2C18`，必须由**后一轮人类消息精确全等**才能 publish |
| **能力治理** | 每个 Agent 独立授权：上下文来源（managed / host_claude）、Skill 授权、MCP 授权、自动压缩阈值。**明确不含引擎/模型/provider** |
| **最终生效能力预览** | 改一个开关实时重算，显示 6 层 Skill 优先级解析结果、manifest hash、与"最近一次真实运行"的对比 |
| **Agent 挂载渠道** | 渠道先挂到 Agent，再路由到工作区 |

**Builder 的威胁模型值得单独说**（代码注释原文）：

> Runner-supplied chat/turn/task claims are not authorization inputs because Agents intentionally have full Bash and write access to their IPC mount.

要防的不是用户误操作，是 **Agent 自我提权**。五道闸门：① 只有默认 profile 才注册这 7 个工具 ② 定时任务/隔离任务/跨 folder 一律拒绝 ③ 宿主机自持轮次登记簿，逐条回数据库重读原始消息 ④ owner 身份规范化**精确**匹配（注释明写"callers must never use suffix matching"）⑤ publish 四条件全等。

### 3.2 投递可靠性：从"尽力而为"到"有状态契约"

5 张新表（`channel_inbox` / `channel_cursors` / `turn_runs` / `channel_outbox` / `streaming_cards`），统一 fencing token 协议。

**核心设计是 `uncertain` 状态**：

```ts
const explicitlyRejected = error instanceof DefinitiveChannelDeliveryError;
const uncertain = current.status === 'sending' && !explicitlyRejected;
```

只有 provider **明确拒绝**才敢重试；`sending` 之后的普通超时/断连一律 fence 成 `uncertain`，**永不自动重试**，必须人工裁决（`POST /api/status/channel-outbox/:id/resolve`，`expectedRevision` 做 CAS）。且 uncertain 会**围栏整个 turn**——该 turn 后续所有输出被阻断。

配套：`ordinal` 不是自增而是语义身份 hash（`provider+account+chat+kind+payloadHash`），**故意排除 requestId**——模型重试会换 UUID，但物理副作用必须只发一次。

### 3.3 后台任务挂流：`background-task-drain.ts`

**这一条直接指出本地 F1 实现的四个 bug**（见 §五 D1）。

upstream 的设计前提写在注释里：**SDK 的边沿信号（`task_started`/`task_notification`）与电平信号（`background_tasks_changed`）之间的相对顺序是故意不指定的**。所以消失的任务先记"完成债"，只有"通知驱动的主 Agent 活动 + 随后的 result"才能偿还。

三个类：`BackgroundTaskDrainTracker`（六集合状态机）/ `QuiescentResultGate`（100ms 静默闸）/ `DurableInputTurnCompletion`。

### 3.4 上下文预算三件套

| 模块 | 能力 |
|---|---|
| `context-window.ts` | `[1m]` 后缀 → 1M 窗口映射；把"压缩百分比"换算成 token 阈值。**修的坑**：从 `[1m]` 模型继承来的 800K 阈值在切回 200K 模型后永远触发不了压缩 |
| `context-budget.ts` | 调 SDK `getContextUsage()` 拿权威用量 + `calculateStaticStartupTokens()` 算"还没说第一句话就烧掉多少"。阈值**模型自适应**：`min(50K, max*0.25)` 警告 / `min(100K, max*0.4)` 硬超 |
| `prompt-plan.ts` | system prompt 拆成带元数据的 `PromptBlock[]`（id/version/scope/owner/required/condition/hash/bytes/estimatedTokens），整个 plan 有 sha256——**prompt 变更可审计、可回归** |

本地对应物是 `promptPieces: {name, text}[]` + `buildPromptAudit()`，无 hash、无重复检测、无体积守卫。

### 3.5 Provider 降级：按爆炸半径分类

upstream `provider-fallback.ts` 把限流分成两类：

| 类型 | 触发 | 动作 |
|---|---|---|
| `model` | `seven_day_opus` / `seven_day_sonnet` / `seven_day_overage_included` | 换模型，**不得隔离整个 OAuth 账号** |
| `account` | `five_hour` / `seven_day` / `overage` / **未知或缺失** | 隔离账号（失败保守） |

**本地只有"连续 3 次错误 → 标记不健康"**，一条 `seven_day_opus` 会让整个 OAuth profile 立即熔断，而实际上只需换个模型。

另有 `isAccountProviderAssistantError()`：第三方兼容端点会发带 error 的 AssistantMessage 却**永远不跟 result**，upstream 把 7 种 error 当终态控制信号；本地遇到这种只能等 30 分钟 `CONTAINER_TIMEOUT`。

### 3.6 其余新能力

| 能力 | 说明 | 本地 |
|---|---|---|
| **Workflow 可视化** | Agent 用 Task 工具提交 JS 脚本声明 phases + agent() 调用，upstream 手写 JS 子集解析器投影成两级进度面板 | 无，退化成黑盒 Task |
| **follow-up 队列** | 运行中发消息可选排队/引导（⌘⇧Enter 反转）。飞书：普通消息=排队，回复活卡=引导当前轮 | **零命中** |
| **交互模式** | 工作区级 `assistant` / `proactive`，分流四份 prompt + delivery contract | `interaction_mode` 命中数 0 |
| **`sdk-control.ts`** | control request 超时隔离 + 60s 首响应 watchdog | 无，只能等 30 分钟超时 |
| **`claude-memory-policy.ts`** | 排除宿主机与仓库根的 CLAUDE.md（见 §五 D2） | 无 |
| **多账号** | `channel_accounts` + 13 个端点 + JID `#account:` 片段 | 无（已决策不合） |
| **Skill 导入** | HTTPS Git / ZIP 导入，含 traversal/symlink 拒绝 + pin 代理 | 无 |
| **CI** | `.github/workflows/ci.yml` + 285 个测试（本地 121） | 无 CI |
| **文档门禁** | `npm run docs:check` | 无 |
| **全局 fetch 走代理** | `load-env.ts` 用 undici `setGlobalDispatcher(new EnvHttpProxyAgent())`。注释动机：undici 默认不读代理环境变量，导致服务端 fetch（官方 Claude OAuth token 交换、连通性测试）用裸出口 IP 直连，**在大陆被 Anthropic 403** | **无此能力** |
| **DNS rebinding 防护** | `url-safety.ts` 的 `assertResolvesToPublicAddress()`：真做一次 `lookup(all:true)`，任一地址落私网/link-local 就抛（防打云 metadata 169.254.169.254），并返回解析出的 IP 让调用方"解析一次连一次"关掉 TOCTOU | 无 |
| **owner 信任分级** | `owner_claim_source`：`explicit`/`configured`/`trusted_direct`/`transfer_reset`，`claimOwnerFromMention()` 幂等且不降级已有更强信任源 | 无 |
| **飞书 mention 收紧** | `stripLeadingBotMention()` 只依据飞书可信 mention 元数据剥开头的 `@名字`，避免把用户自己敲的 `@xxx` 当成被 @ | 无 |
| **入站授权闸门** | wechat / whatsapp 的 `isChatAuthorized(jid)`——"任何入站消息在通过前不得注册会话或下载媒体" | 无 |
| **ack reaction 精确清除** | `clearAckReaction(chatId, inputMessageId)`：从"清掉这个会话的 ack"变成"清掉这一条确切入站消息拥有的 ack" | 旧签名 |

---

## 四、双方"同一职责的两套实现"（必须择一，不能并存）

| 职责 | 本地 | upstream |
|---|---|---|
| **投递可靠性** | `messages` 表加 5 列（`delivery_mode/status/run_id/priority/updated_at`）+ `setMessageDeliveryState()` | 独立模块 5 张表 + `turn_runs` 租约 + `channel_outbox` 逐 artifact |
| **后台任务挂流** | `pendingSdkTasks` Map + 5s 轮询（边沿配对） | `BackgroundTaskDrainTracker`（电平优先 + 完成债） |
| **渠道挂载表** | `agent_channel_mounts`（13 列，多 `agent_profile_id`/`owner_user_id`/`workspace_folder`） | `channel_mounts`（10 列） |
| **MCP 工具抽象** | `createMcpToolCatalog()` 运行时中立层 → Claude/Codex/Grok 共享 | 直接 SDK 耦合，**无中立层** |
| **人格渲染** | agent-runner 内四段分渲，`<agent-persona>` 包裹 | host 侧 flatten 成单串 |
| **`.claude.json` 挂起** | 挂载精简模板 + entrypoint 复制为可写 | 按 >500B 判定清理 session 目录遗留 |
| **飞书错误** | `describeFeishuError()` 日志瘦身（消除 48KB 写入） | `FeishuTextDeliveryError` 抛出供 outbox 感知 |
| **定时任务会话** | 持久会话 + 运行时绑定提升 | run-scoped 会话（避免 isolated 跨 run 累积） |
| **原生线程** | `thread_map` | Native Context Session |

---

## 五、本地正在发生的活 bug（由 upstream 代码反向揭示）

### D1 · 后台任务挂流的四个洞

实测本地装的 SDK **0.3.220 已经在发 `background_tasks_changed`**（`sdk.d.ts:2917`），SDK 文档字符串明确反对本地的做法：

> consumers that only need 'is background work running' should replace their set with each payload rather than pairing edges, so a missed bookend cannot wedge a stale running indicator.

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 完全不处理电平信号，纯配对边沿 | 任一终态边沿丢失 → taskId 永久留在 map → 容器钉到 IDLE_TIMEOUT（30 分钟） |
| 2 | 首条 result 无条件当终稿发布 | 用户先看到"我已启动 6 个子 Agent，等待其余 5 个"定稿，几分钟后才是真汇总。**双终稿** |
| 3 | 旧 result 与 `task_notification` 竞速 | 主 Agent 被通知唤醒后的收尾轮**被 interrupt 掉**。窗口 = IPC 轮询周期 5s |
| 4 | 不识别 `shouldQuery: false` | 最后一个通知是 `shouldQuery:false` 时永远不会再有 result → `resultReceivedAt` 恒为 null → 关流分支永不进入 → **挂死 30 分钟** |

### D2 · admin host agent 正在被仓库开发文档污染 —— 已验证

```
admin 主容器 folder=main，execution_mode=host
cwd = /Users/tivility/happyclaw/data/groups/main   ← 嵌套在仓库内部
仓库根 CLAUDE.md = 70867 bytes
本地 claudeMdExcludes 机制 = 0 处
```

Claude Code 把**本仓库的 CLAUDE.md（70KB 架构文档）当 Project memory 加载**，一个业务 Agent 被开发文档重新定义成"代码库助手"。upstream `claude-memory-policy.ts` 的注释直接描述了这个场景。约 107 行可独立移植，与任何合并方案都不冲突。

### D3 · 一次 query 多条 result 可能重复计费

upstream `result-usage.ts` 的文件头洞察：官方 SDK 0.3.x 的根 `usage` 是从**累计** `modelUsage` 派生的。本地每条 result 直接原样上报 `sdkUsage`——而本地会在同一 query 内产生多条 result（mid-query IPC follow-up、后台任务收尾轮）。

### D4 · Kaboo 定价会对订阅制运行时错误扣款

`kaboo-pricing.ts` 13 条规则全是 Claude，Grok/Codex 模型名不匹配 → **fallback 到 Claude Sonnet 的 $3/$15 per Mtok**，并真的从 `user_balances` 扣款。而本地 Codex/Grok 是订阅制、`costUSD: 0`。

叠加 **cachedRead 双重计费**：Grok 的 `inputTokens` 含 cachedRead（OpenAI 口径），Kaboo 按 Claude 口径（互斥）分别计价 → 缓存部分算两次。同一 bug 在配额侧独立复现：`billableInput = inputTokens + cacheRead + cacheCreation`。

这违反本地 CLAUDE.md §8.14 写的"入库分列 SUM 不相减"。

### D5 · 本地 CLAUDE.md 已经不描述本地系统

```
agent_profiles            CLAUDE.md: 0 处
agent_channel_mounts      CLAUDE.md: 0 处
workspaces                CLAUDE.md: 0 处
turn_events               CLAUDE.md: 0 处
privacy_mode / PRIVATE.md CLAUDE.md: 0 处
```

阶段 D+E 的 5 次 schema 迁移（40→45）、7 张新表、2 个新模块、1 个新 API——CLAUDE.md 和 README.md 一个字都没改。违反本地自己写在 §10 的规则。

---

## 六、upstream 主动禁止本地现有做法的三条

这不是"冲突要解"，是 upstream 的**测试/文档主动封杀**本地配置：

```js
// tests/reproducible-build-contract.test.ts
expect(dockerfile).not.toContain('npm install -g');   ← 本地装 grok CLI 的方式
expect(dockerfile).not.toContain('releases/latest');  ← 本地 feishu-cli 动态下载
expect(buildScript).not.toContain('CACHEBUST');       ← 本地"始终最新"策略的支点

// tests/makefile-runtime-contract.test.ts
expect(makefile).not.toMatch(/pm2/i);                 ← 本地 pm2 全套
expect(makefile).not.toContain('PM2_GUARD');
```

```
// upstream CLAUDE.md
"Host 模式没有 maxConcurrentHostProcesses。旧客户端提交该字段时后端仅为兼容而忽略，
 不得重新把它实现为全局 Host 并发池。"        ← 本地 MAX_CONCURRENT_HOST_PROCESSES=5 是活的

"内置 Skills 由 scripts/install-host-tools.sh 固定版本下载到 data/builtin-skills/，
 仓库不再维护或注入另一套容器内未治理 Skills。"  ← 本地 container/skills/ 有 7 个
```

同时 upstream 把 SDK **钉死** `@anthropic-ai/claude-agent-sdk@0.3.205` + `claude-code@2.1.205`，`sdk-compat.ts` 把这两个版本号硬编码进审计字段；本地是 `"*"`（实测 0.3.220），CLAUDE.md §10 明文"始终最新"。

---

## 七、冲突热力图

### 🔴 必须整体重写 / 二选一后全量改写调用点

| 文件 | hunk | 原因 |
|---|---|---|
| `src/index.ts` | 75 | 投递可靠性两套竞争实现；`isAdminHome` 语义分歧；实际决策点估算 100–150 |
| `src/feishu-streaming-card.ts` | 34 | 同一个类两个方向重构逐段交织，几乎全需手写第三版。**全仓冲突密度最高** |
| `src/container-runner.ts` | 19 | 每个 hunk 都是"本地运行时机制 vs upstream Agent 治理"正撞；含位置参数签名冲突 |
| `src/db.ts` 的 `runMigrations()` | #7 | **函数边界被冲突区横切**：本地 606 行含函数终结符 + 一整个新函数定义 |
| `src/feishu-capability.ts` | add/add | 本地 211 行 vs upstream 604 行 |

### 🟠 需人工逐 hunk 判断

`container/agent-runner/src/index.ts`(19) · `src/db.ts` 其余(17) · `mcp-tools.ts`(16) · `task-scheduler.ts`(10) · `routes/config.ts`(8) · `feishu.ts`(8) · `web.ts`(9) · `runtime-config.ts`(4) · `schemas.ts`(4) · `SettingsPage.tsx`(4) · `MessageBubble.tsx`(5)

其中 `routes/config.ts` #5/#6 是**正交必须都留**：本地加的是"这个 provider 属于 claude 池吗"（防误改 Grok provider），upstream 加的是"变更期间加锁、静默 runner、失败回滚"。只取一侧要么丢池隔离，要么丢并发安全。

### 🟡 机械可解（并集 / 相邻性假冲突 / 格式化）

`group-queue.ts`(5) · `chat.ts`(3) · `types.ts`(2) · `im-manager.ts`(2) · `feishu-cards/builder.ts`(2) · `shared/stream-event.ts`(1，解完必须 `make sync-types`) · 各 `package.json` / `Dockerfile` / `Makefile`(6) · `CLAUDE.md`(11)

### ⚫ 无冲突但需主动决策

- §二 的 20 个符号 + 50 个文件（**默认丢失**）
- `UsagePage.tsx` / `routes/agents.ts` 取 upstream 版 —— 但 UsagePage 消费的 `reasoning_output_tokens` / `billed_cost_usd` / `usage_date` 依赖 `db.ts` 冲突 #3 的 upstream 侧
- `ACL-MATRIX.md` / `API.md` 本地零修改，取 upstream 版零冲突 —— **但文档立刻描述本地不存在的东西**（`channel_accounts` 13 个端点、`task-acl.ts`、owner-only ACL），从"过时"换成"虚构"
- upstream 新增 72 个 `src/` + 51 个 `web/src/` 文件干净并入，全部依赖冲突文件的 upstream 侧符号
- 本地独有 23 个文件干净并入，全部依赖冲突文件的本地侧符号

---

## 八、决策树

### 第 0 层 · 合并形态（这一项决定后面所有事）

```
T0. 用什么方式把 upstream 拨进来？
├── A. 单次全量 merge
│      一次面对 329 hunk + 20 个静默符号 + 50 个静默文件
│      中途无法验证；出错难定位到具体决策
├── B. 按子系统分批 port（不做 git merge，逐个搬模块）
│      每批可独立验证；behind 计数不下降，需靠台账追踪
│      与"不允许 merge -s 跳过"不冲突——这是真搬代码，不是假合并
└── C. 分层：先 merge 机械可解层 + 纯新增文件，硬冲突子系统单独分支逐个 port
       第一批就能把 123 个纯新增文件和 🟡 层收掉，缩小后续面
```

### 第 1 层 · 不可逆项（做错了没法回退，必须先定）

```
T1. group_members（工作区共享）
├── 跟随 upstream 删除
│      与 upstream ACL 对齐（owner-only、admin 不旁路）
│      已核实：64 个群组全有 created_by，32 行全被覆盖，零个 (用户,folder) 对只靠它拿权
│      需动 4 个授权分支 + 摘 ChatView 成员面板
│      ⚠ 32 行数据销毁不可逆
├── 永久保留
│      每次合 db.ts 都要手动摘那行无条件 DROP TABLE，漏一次即销毁
└── 改名 workspace_members
       一次性改 22 处引用 + 迁移，之后永久免疫那行 DROP

T2. schema 版本号体系
     本地 SCHEMA_VERSION = '45'（字符串，v39 后无门控）
     upstream CURRENT_SCHEMA_VERSION = 63（数字，门控在 28/48/51/58/62）
     ⚠ 现存生产库带 '45' 启动 upstream 代码：Number('45')=45 < 63 → 不拒绝、建备份、继续
       然后 upstream 所有门（<48/<51/<58/<62）全部判真并执行
       = 把本地库当作"已完成 upstream v40–45 迁移"来对待，而本地从未跑过 v42→43、v44→45
├── 重编号本地迁移接在 63 之后
├── 引入独立 fork 版本命名空间
└── 给存量库写一次性对账脚本
```

### 第 2 层 · 架构方向性（二选一，决定大片代码归属）

```
T3. agent-runner 基座
├── 保本地 runtime-adapter，只嫁接 upstream 的纯函数模块
│      → codex/grok 拿不到 context-budget / prompt-plan / provider-fallback
│      → 形成"Claude 路径功能完备、另两条永久退化"的不对称
│      → index.ts 变成"本地骨架 + upstream 血肉"，后续 rebase 面只增不减
└── 转向 upstream 架构，多运行时降为外挂
       → 立即获得 upstream 全部能力且未来低成本跟进
       → 但 resume/soft_inject 三态、grok ACP 归一化（21 测）、
         selectGrokProviderForInput sticky 选择都要重做

T4. mcp-tools 中立层（决定 codex/grok 是否残废）
├── 保本地 createMcpToolCatalog()，upstream 11 个新工具手工翻译进来
│      → codex/grok MCP 复用保住
│      → Agent Builder 8 个工具依赖 upstream 的 agentProfile 体系，翻译完本地也没对应端点
└── 采纳 upstream 的 SDK 直接耦合版
       → happyclaw-mcp-server.js 失去数据源
       → codex/grok 要么三份定义漂移，要么失去 send_message/schedule_task/memory_*
         = 这两条运行时残废

T5. 投递可靠性
├── 保本地 messages.delivery_* 五列
│      → 简单；但只是"可见"不是"可靠"，无幂等、无 uncertain 围栏
└── 采纳 upstream channel-reliability-store 5 表
       → 需要 accountId（本地无 channel_accounts）：
          ├── 合成 accountId（如 {userId}:{channel}）→ 将来真上多账号时
          │     三张表的 idempotency_key 全部要重算 = 不可回退的历史数据重写
          └── 连 channel_accounts 六模块 + JID #account: 迁移一起搬
                → 波及 7 个渠道模块 + im_context_bindings + 所有历史 JID
       → uncertain 需人工裁决：网络抖动会让会话卡住，需配套告警

T6. 人格渲染位置
├── host flatten 成单串（upstream）→ 放弃 runtime-neutral 渲染器的设计意图
├── 保本地 runner 分段渲染 → ContainerInput.agentProfile 契约与 upstream 永久分叉
└── 两层都留 → 必须加一致性测试，否则"Claude 看到的 persona 和 Grok 不一样"极难排查
```

### 第 3 层 · 功能取舍（可独立决策）

```
T7.  Agent-first 产品面补不补（表已建，无入口）
     ├── 补 Web 向导（P0–P3+P5，约 5500 行）→ 80% 功能，风险可控
     ├── 连对话式 Builder 一起补（+1900 行）→ 但 index.ts 的 TurnRegistry
     │     5 个注入点必须全覆盖，漏一个 = 间歇性失败，极难定位
     └── 维持骨架 → 付了 schema 迁移成本没拿产品收益

T8.  SDK 版本
     ├── 跟 upstream 钉 0.3.205 → 违反本地"始终最新"，make update-sdk 语义失效
     └── 保持 "*" → 拿不到 sdk-compat 的 subagent 契约（0.3.220 类型里
           appendSubagentSystemPrompt 已 0 命中），每次升级要重验 4 个未标稳定的表面

T9.  upstream 契约测试是否具有约束力
     ├── 采纳 → 必须改掉 grok 的 npm install -g、feishu-cli 的 releases/latest、
     │     CACHEBUST、pm2 全套、host 并发池、container/skills/ 的 7 个 Skill
     └── 不采纳 → 保留这些测试文件会红；删掉则失去 upstream 的可重现构建保证

T10. Kaboo 定价（会真扣钱）
     ├── 引入并加运行时门控（非 Claude 强制 costUSD=0）
     ├── 引入并补 Grok/Codex 价格规则 + cachedRead 口径统一层
     └── 不引入，保留本地 costUSD=0

T11. isAdminHome 判定口径
     ├── 本地：isHome && folder === MAIN_GROUP_FOLDER
     └── upstream：isHome && owner?.role === 'admin'
     影响：项目根挂载、全局记忆写权限、register_group、跨组任务管理

T12. 定时任务会话语义
     ├── 本地：持久会话 + 运行时绑定提升
     └── upstream：run-scoped（避免 isolated 任务跨 run 累积上下文）
     两者对 isolated 语义的理解直接对立

T13. 前端形态
     ├── SessionSidebar（upstream）→ 失去拖拽排序（@dnd-kit 三个依赖被移除）
     └── AgentTabBar（本地）
     附带：TurnTracePanel（本地新建）在 upstream 无对应物，会被删；
           upstream 的 WorkflowRunCard 只覆盖 workflow 类型

T14. task-acl（admin 不旁路任务 ACL）
     upstream 理由：admin Home Agent 是会接触不可信内容的 LLM，
     而任务 prompt 会被按计划重放、以 Bot 身份发言、计费到目标工作区
     ← 这是把 prompt injection 当威胁模型来设计 ACL
     与本地 CLAUDE.md §8.5「admin 主容器 IPC 可发任意群组」正面冲突

T15. fallbackModel（撞额度墙自动回退）
     与本地 model-switching-design.md 明文「Never silently change the selected model」对立
```

### 第 4 层 · 低风险清理项（可以现在就做，不依赖上面任何决策）

```
T16. claude-memory-policy.ts 独立移植（约 107 行）
     → 立刻止住 admin host agent 被 70KB 仓库文档污染（D2，已验证）
T17. 修 F1 的四个洞（D1）
T18. CLAUDE.md / README.md 补写到 schema 45（D5）
     ├── 只补差量（保留 904 行穷举结构）
     ├── 同时采用 upstream 瘦身理念（904 → ~350，导航图 + 硬约束 + 指针）
     └── 引入 npm run docs:check 门禁
T19. privacy 死代码清理（本地注释已标「合并后统一清理」）
T20. RuntimeCapability 矩阵（M2 已决策"要建"但代码里没有）
     → 能自动挡住"文本无冲突但对 grok 必炸"的 upstream 改动，已知至少 3 处
```

---

## 九、中小型共有文件的分类统计（48 个文件实测）

用 `git merge-tree --write-tree` 逐文件试算的结果：

| 类 | 数量 | 含义 |
|---|---|---|
| **A** 可直接取 upstream | 26 | 本地零改动、git 干净合并 |
| **B** 干净合并但有坑 | 4 | 见 §2.4 |
| **C** 报冲突需人工合并 | 15 | |
| **D** 本地独有、upstream 未触碰 | 3 | `logger.ts`（codex/grok authJson 脱敏）、`conversation-history.ts`（CJK 预算 + 整条填充）、`im-safety/`（四态健康决策） |

**A 类里最值得先拿的**：`load-env.ts`（代理）、`url-safety.ts`（DNS rebinding）、`feishu-mention-gate.ts`（mention 收紧）、`group-owner.ts`（信任分级）、`routes/usage.ts`（用量明细 + CSV 导出）、`routes/skills.ts`（git/zip 导入）、`claude-context-resolver.ts`。这些本地零改动、纯增量、无架构耦合。

**一个额外的合并顺序约束**：upstream 把 prettier 从 `^3.8.1` 锁到 `3.8.3` 并新增 `scripts/check-format-changed.mjs`。本次冲突里有可观比例是纯格式重排（`wechat.ts` 3 处、`schemas.ts` 的飞书 appId 校验、`stream-event.types.ts` 整个联合体一行一项、`middleware/auth.ts`、`url-safety.ts`）。**先在本地跑 upstream 版 prettier 再合并，会改变冲突集的形状**——但 `package.json` 本身也冲突，需要先解它。

`shared/stream-event.ts` 与它的 3 份生成副本全部冲突，**必须在 `shared/` 解一次再 `make sync-types`**，否则 `check-stream-event-sync.sh` 会一直报不一致。

---

## 十、几个"同一修复的两个写法"（纯噪声冲突）

本地最近的 `5a0bed4「机械修复四连」`是从 upstream 回移的补丁，但改法与 upstream 不完全一致：

| 位置 | 本地写法 | upstream 写法 |
|---|---|---|
| `wechat.ts` 三处 contextToken 缺失 | `throw new Error(...)`（去掉 warn） | `logger.warn(...)` 后再 `throw` |
| `schemas.ts` 飞书 appId 校验 | `FEISHU_APP_ID_REGEX`，同一段中文注释，同样引用 PR #572 | 逐字节几乎相同，只差 prettier 对 `.refine(fn, {message})` 的换行 |
| `config.ts` `MAX_FILE_SIZE_MB` | 与 upstream **逐字节完全相同** | 同左 → git 识别为同一改动，干净合并 |

第三行说明：回移时如果**逐字节照抄 upstream**，git 就能识别为同一改动而不冲突。前两行说明：改法稍有出入就会制造纯噪声冲突。这对后续回移策略有直接含义。
