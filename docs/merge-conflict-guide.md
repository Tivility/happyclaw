# 合并冲突逐文件处置指引

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 方法：独立 worktree 实跑 `git merge upstream/main --no-commit --no-ff`，逐块读取冲突内容
> 依据：`upstream-merge-plan.md` §2.0 决策台账（93 条，下文标注为「决策 N」）· `upstream-silent-changes.md`
> 生成：2026-07-26

---

## 零、实测总览

```
冲突文件   56 个
冲突块     329 个   （与执行方案 §七的估算一致）
内容冲突   51 个 UU
add/add     3 个 AA   src/feishu-capability.ts · tests/agent-profiles-db.test.ts · tests/feishu-capability.test.ts
modify/del  2 个 UD   web/src/components/groups/{GroupCard,GroupDetail}.tsx
                       ＋ container/skills/agent-browser/SKILL.md（也是 UD，共 3 个）
静默删除   50 个文件（实测）
```

### 冲突块分布

| 文件 | 块数 | 处置 |
|---|---:|---|
| `src/index.ts` | 75 | 逐块判断 |
| `src/feishu-streaming-card.ts` | 34 | 逐块判断（本地为基线） |
| `container/agent-runner/src/index.ts` | 19 | 逐块判断 |
| `src/container-runner.ts` | 19 | 逐块判断（本地为基线） |
| `src/db.ts` | 18 | 逐块判断 |
| `container/agent-runner/src/mcp-tools.ts` | 16 | 逐块判断 |
| `CLAUDE.md` | 11 | 全取 upstream（骨架），阶段 6.1 重写 |
| `src/routes/groups.ts` | 11 | 逐块判断 |
| `src/task-scheduler.ts` | 10 | 逐块判断 |
| `container/agent-runner/src/stream-processor.ts` | 9 | 逐块判断 |
| `src/web.ts` | 9 | 逐块判断（大多取并集） |
| `src/feishu.ts` | 8 | 逐块判断 |
| `src/routes/config.ts` | 8 | 逐块判断（锁取上游 + 池过滤保本地） |
| `src/feishu-cards/sections.ts` | 7 | 逐块判断 |
| `Makefile` | 6 | 逐块判断 |
| `src/group-queue.ts` | 5 | 逐块判断 |
| `web/src/components/chat/MessageBubble.tsx` | 5 | 逐块判断 |
| `src/runtime-config.ts` / `src/schemas.ts` / `web/src/pages/SettingsPage.tsx` | 各 4 | 逐块判断 |
| `src/im-channel.ts` / `src/wechat.ts` / `web/src/stores/chat.ts` | 各 3 | 见正文 |
| `container/agent-runner/src/types.ts` / `src/feishu-cards/builder.ts` / `src/im-manager.ts` / `src/types.ts` / `web/src/components/chat/{ChatView,ContainerEnvPanel}.tsx` / `web/src/components/settings/SettingsNav.tsx` / `tests/feishu-card.test.ts` | 各 2 | 见正文 |
| 其余 18 个单块文件 | 各 1 | 见正文 |

### 三条通用规则

1. **行号会漂移。** 下文标注的行号是**冲突态**文件里的行号，解掉任何一块后面全变。按内容搜索定位，或**从文件末尾往前解**。
2. **「两边都要」不等于「顺序拼接」。** 很多块两侧是**不同的函数 / 不同的 switch case**（如 `src/index.ts` H57 是 `feishu_capability` vs `update_task`），不是同一段的两个版本。这类块删掉任何一侧都是纯功能丢失。
3. **`--ours` / `--theirs` 整文件解法只在 7 个文件上安全**（下文逐个标出）。其余一律逐块。

---

## 一、核心后端

### 1.1 `src/index.ts` — 75 块 · 逐块判断

全仓块数最多。按主题分组，逐组给判断。

#### 组 A：import（H1–H5，行 110–456）

**取并集。** upstream 侧新符号（`setSession` / `getChannelMount` / `channel_accounts` 家族 / `AgentProfile` / `ChannelTurnContext` / `IpcDeliveryReceipt`）与本地符号（`migrateTargetMainJidToChannelMounts` / `reconcileChannelMounts` / `evaluateSessionValidity` / `GroupQueue` / `task-scheduler`）互不冲突。

**陷阱**：H3 本地导入 `type DeliveryStatus`。决策 46 已定「本地 IM 投递改名让位」——若 `db.ts` 那侧改了名而这里没改，编译断；若两侧都留，`src/types.ts` 会重复声明（实测 `web/src/stores/chat.ts` 已经重复了，见 §六.3）。

#### 组 B：用量归因（H6、H10–H13、H23–H24、H68）

- **H6**（551）：本地 40 行 `usageModelNameFromResolution` 等 vs upstream 8 行 `buildWebTraceUrl` → **两边都要**（不同函数）。
- **H10–H13**（2473–2588）：`writeUsageRecords` 签名与实现。本地 67 行带 `runtimeResolution` 归因；upstream 11 行走 `recordUsageEvent`。
  → **取本地主体**（决策 11：31 列，11 个归因列继续写），**吸收 upstream 的 `reasoningTokens` / `costUSD` 必填字段**（决策 40/41）。
- **H23–H24**（7896/7931）、**H68**（15735，Sub-Agent 侧）：同上；H68 另吸收 upstream 的「Sub-Agent 从父群组继承 `created_by`」。

**陷阱（全组）**：取 upstream 侧不会报错，但 `runtime` / `provider_family` / `provider_pool_id` / `provider_id` / `auth_profile_generation` / `selected_model` / `resolved_model` / `billing_scope` / `cost_status` / `cost_source` / `usage_metadata_json` **11 列全部写成 NULL**。用量页照常显示，只是再也分不出运行时。

#### 组 C：投递状态（H14、H15、H37、H38）

本地 `deliveryStatus: DeliveryStatus`；upstream `ChannelOutboxDeliveryRef` + `sendImWithRetry` 返回布尔。
→ **取 upstream**（决策 43 投递可靠性记录方案 + 决策 46 五列让位）。

**陷阱**：`MessageBubble.tsx:935-950` 的「未送达 / 送达未确认」红角标依赖本地值域 `failed`/`pending`。跟 upstream 后判断**永不命中** —— 不报错，提示静默消失。要么本地列改名保留，要么把角标接到 upstream 的 outbox 状态上（见 §四.4）。

#### 组 D：流式会话（H16–H20、H25–H26、H30、H70）

- **H16/H17**（6088/6547）：局部变量声明，**并集**。
- **H18**（7103）：本地「路由变更时重建 streamingSession，清空到 null 时回落 web JID」33 行 vs upstream `activateMainProjectionForInput`（按 `inputTurnId` 分组）9 行。
  → **取 upstream 骨架 + 移植本地的回落逻辑**。只取 upstream：web 消息注入 IM 会话时飞书卡片不销毁，卡在「生成中」。
- **H20**（7551）：本地 23 行「usage 晚到 ~500ms，路由到刚完成的 session 让 `patchUsageNote()` 生效」 vs upstream 43 行 `answerProjection`。
  → **两边都要**。丢本地那段 → 飞书卡片的 token/费用尾注**永远不出现**，静默。
- **H25/H26**（8195/8301）、**H70**（16095）：upstream 的 `cardHeld` / `pendingStreamingCardCompletion`（挂起完成）。
  → **取本地主体**。决策台账把 `5f04246`「流式卡片挂起完成」和 `81f0b5a`「挂起序列全渠道合并」标为 ❌ 不采纳（与 F2 决策冲突：过程放挂起卡、结果发新消息）。只吸收 upstream 的 `channelStreamingSessionsByInput` 键管理。
- **H30**（8707）：upstream 加 `holdReason` 判断，挂起时不清 Workflow 快照。
  → **取 upstream 判断 + 保本地 `resetNonStreamingState()`**（决策 35 Workflow 可视化要，标 Claude-only）。

#### 组 E：interrupt 与 IPC 回执（H19、H21–H22、H31、H40–H41、H67）

- **H21/H22**（7698/7716）：本地把 `interruptedText` 写回并重放；upstream 不重放 + `commitCursor(inputTurnId)`。
  → **取 upstream**。
- **H41**（11662，upstream 72 行 `writeIpcMessageResult`）：**必须一起取**。
  **陷阱**：决策 47 明写「只取『不重放』不取回执 = 丢消息」。H21 和 H41 是一对，分开解就是丢消息。
- **H19**（7205）、**H31**（9512）：`commitCursor` 路径，**取 upstream**（本地那段隐私模式清消息按决策 61 下线）。
- **H40**（11459）：IPC 结果文件前缀白名单，**取 upstream**（决策 23）。
- **H67**（15640）：upstream 加 `if (interruptedText)` 守卫 → **取守卫 + 保本地 30 行主体**。

#### 组 F：会话与 provider（H32–H36、H66、H69、H72）

- **H32**（9653，本地 76 行 / upstream 17 行）：**全文件最需要手工混合的一块。**
  - `isAdminHome`：本地 `isHome && group.folder === MAIN_GROUP_FOLDER` → **改成 upstream 的 `isHome && owner?.role === 'admin'`**（决策 54，实测两口径当前命中相同）。
  - 其余 71 行本地 runtime resolution / handoff summary / pending binding 提升 → **全保**（决策 21，fork 核心）。
  - **陷阱**：整块取 upstream = 多运行时全灭；整块取本地 = `isAdminHome` 口径不对齐且 `agentProfile` 缺失。两个极端都不报错到你运行时才发现。
- **H33/H36/H66/H72**：`persistNativeSessionForResolution`（本地，写 `conversation_runtime_sessions`）vs `setSession` + agentProfile 身份（upstream）。
  → **两边都要**（决策 12：权威表 + 单向派生投影；决策 50：身份指纹不含策略）。
- **H34/H35**（9890/9943）：`ContainerInput` 构造，**docker 与 host 两处内容必须完全一致**。
  → **并集**（本地 24 行 runtime/provider/authMaterial + upstream 的 `agentProfile` / `agentBuilderEnabled`）。
  **陷阱**：只改一处 → host 与 docker 行为分叉，不报错（CLAUDE.md §8.14「双路对称」）。
- **H69**（16026）：**混合** —— 取 upstream 的 `holdReason` 分支 + 保本地 `persistNativeSessionForResolution`。

#### 组 G：任务 IPC（H39、H44–H63）

- **H39**（11054，upstream 125 行）：IPC 图片投递路由 + 任务图片识别 → **取 upstream**（决策 23/43），核对本地 `resolveImRoute` 的 `ipcAgentId`/`isHome` 语义能映射过去。
- **H44**（11836）：IPC data 字段。本地 `feishu_capability` 的 `operation`/`chatId`/`params`；upstream `inputTurnId` + Agent Builder 字段 → **并集**（决策 25 + 24）。
- **H45**（11933，upstream 137 行）：`agent_profile_*` IPC 分支 → **取 upstream**（决策 24）。
- **H46**（12094）：任务数量上限 → **取 upstream**（决策 84）。
- **H48**（12146）与 **H59**（12725）：授权判定。本地 `!isAdminHome && targetFolder !== sourceGroup`；upstream `ipcActorCanAccessGroupJid` / `ipcActorCanManageTask`（admin home 不再是全局旁路）。
  → **保本地**（决策 81：跨组 ACL 保本地，admin 主容器本来就能读全库）。
  **陷阱**：取 upstream 会切断 CLAUDE.md §8.5 明写的 admin 主容器跨组任务管理特权。
- **H49**（12161）：本地 25 行内联 cron 解析 → **取 upstream 的 `computeNextRunForSchedule`**。注意它内含 `MIN_INTERVAL_MS = 60_000` 硬闸会 throw，存量秒级/亚分钟任务要先普查（`upstream-silent-changes.md` §三）。
- **H50**（12205，本地 40 行）：幂等去重。本地只对 agent 任务去重（#564）；upstream 把 `execution_mode` 纳入任务身份。
  → **并集**：保本地「script 任务不按 prompt 去重」（否则命令不同的 script 任务会被静默丢），加 upstream 的 `execution_mode` 维度。
- **H51–H56**（12400–12645）：pause/resume/cancel 的结果写入 + prettier 折行 → **取 upstream**（`notifyTaskSchedulerChanged` + `revision`，决策 23）。
- **H57**（12656）：**最容易误删的一块。** 本地是 `case 'feishu_capability':`（39 行，支撑十个 `feishu_*` MCP 工具），upstream 是 `case 'update_task':`。**两个 case 都要留**（决策 25 保本地飞书实现 + 决策 23 吸收 `update_task`）。这不是同一段的两个版本。
- **H58/H60–H63**（12713–13102）：`update_task` 的 revision / execution_mode 校验，以及 upstream 210 行新 case（`run_task_now` / `stop_task_run` / `restore_task` / `list_task_runs`）→ **取 upstream**（决策 20 + 23）。
- **H42/H43/H47/H52/H54/H56**：纯 prettier 折行 → **取 upstream**（决策 5）。

#### 组 H：其余（H7、H8–H9、H64–H65、H71、H73–H75）

- **H7**（715）：状态文案。**合并** —— 取 upstream 的 `requesting`/`compacting` 中文化映射，保本地 `se.runtime === 'codex'` 的 `pushRecentEvent` 分支（决策 34 精神）。
- **H8/H9**（2137/2196）：`unbindImGroup` / `removeImGroupRecord`。本地清 `target_*` 指针 + 审计日志；upstream 走 `restoreDefaultChannelMount`。
  → **取 upstream 主体 + 保本地审计日志 6 行**（决策 19：`channel_mounts` 是权威表）。
  **陷阱**：upstream 分支依赖 `getChannelMount()` —— 那正是 fail-closed 路由的兜底来源。取 upstream 这侧的**前置条件**是先做决策 16 的三行修法（区分「没覆盖」和「解不出来」），否则 8 个无绑定会话失联、两个 member 用户被完全切断。
- **H64**（14173）：定时任务 prompt 构造。**保本地主体 + 加 agentProfile 解析**（决策 27）。
- **H65**（15115）：Sub-Agent 运行循环的局部状态 → **并集**。
- **H71**（16480）：Sub-Agent `ContainerInput` → 同 H34/H35，**并集**。
- **H73**（17116）：本地 `ipcWatcherManager.processNow` + upstream outbox scope unbind → **并集**。
- **H74**（17967）：IM 群 owner 转移。→ **取 upstream 的 `releaseOwner` + `owner_claim_source`**（反向增量：防凭据转移后被同一 sender「洗白」），**保留本地 `previousOwnerStillConnected` 判据作为额外前置**。
- **H75**（20095）：关停清理。本地清日志轮转定时器；upstream 清 channel reliability loop → **并集**（决策 76 + 决策 75）。

---

### 1.2 `src/db.ts` — 18 块 · 逐块判断

**这个文件决定启动时跑哪些数据变换。解错的代价不是编译失败，是数据。**

| # | 行 | 争什么 | 取哪侧 | 依据 |
|---|---|---|---|---|
| H1 | 30 | type import | 并集 | — |
| H2 | 101 | `SCHEMA_VERSION='45'`(string) vs `CURRENT_SCHEMA_VERSION=63`(number, exported) + `isDatabaseInitialized()` | **取 upstream 形态**，起始版本号按副本实测定 | 决策 2 |
| H3 | 218 | usage insert 列：本地 26 列（含 11 归因列）vs upstream 20 列（含 `reasoning_output_tokens`/`provider_estimated_cost_usd`/`billed_cost_usd`/`usage_date`） | **并集 = 31 列** | 决策 11 |
| H4 | 1235 | 本地 366 行模型/运行时 8 张表 CREATE vs upstream 17 行 usage_records v51 列 | 两边都要 | 决策 21 + 11 |
| H5 | 1828 | 本地 usage_records 11 个归因列 vs upstream messages 5 个 `delivery_*` 列 + follow-up 索引 | 两边都要 | 决策 11 + 46 |
| H6 | 2403 | 本地 1 行 `initializeModelSwitchingDefaults()` vs upstream 198 行 v39→v62 迁移阶梯 | 两边都要 | 决策 2/9/49 |
| H7 | 2667 | 本地 606 行 vs upstream 145 行 —— 见下方逐段 | 逐段 | — |
| H8 | 3627 | `storeMessage` 的 sourceKind 命中：upstream 加 `truncation_continue` | 取 upstream；删本地 privacy 注释 | 决策 61 |
| H9 | 4468 | 本地 39 行 insert vs upstream 258 行 `UsageModelRecordInput`/`recordUsageEvent` 新体系 | 取 upstream 骨架 + 补 11 归因列写入 | 决策 10/11/42 |
| H10–H12 | 7869/7920/8006 | `setSession`/`clearSession`/`clearAllSessions` 事务化。upstream 包 `db.transaction` + 清 `workspace_runtime_sessions` + `channel_session_owner`；本地清 `conversation_runtime_sessions` | 两边都要 | 决策 12/13 |
| H13 | 10648 | 本地 `setRegisteredGroup`（27 列）vs upstream 396 行 `channel_accounts` 行映射家族 | 两边都要 | 决策 18 |
| H14 | 11573 | upstream 新增 `getImContextBindingByRootMessageId` | 取 upstream | 决策 16 |
| H15 | 11897 | `deleteGroupData` 级联：本地删 `conversation_runtime_*`；upstream 删 `agents` | 两边都要 | 决策 13 |
| H16/H17 | 11966/11981 | `getMessagesSince`/`getNewMessagesStmt` 的 SELECT 列 | 取 upstream | 决策 46 |
| H18 | 13419 | `deleteAgent` 级联 | 取 upstream 事务版 + 保本地 `deleteImContextBindingsByAgent` | 决策 13 |

#### H7 逐段（本地 606 行 / upstream 145 行）

upstream 侧是 v42→v61 的 backfill，里面四件事要分别定：

| upstream 侧的操作 | 处置 | 依据 |
|---|---|---|
| `DROP TABLE IF EXISTS group_members` | **放行**（本地 32 行全是「创建者是自己」的冗余） | 决策 7 |
| `DELETE FROM workspaces WHERE NOT EXISTS(… rg.jid LIKE 'web:%')` → 64 行删成 35 | **不能原样取**，改成按 folder 投影（36 行） | 决策 8 |
| `syncAllChannelMountsFromRegisteredGroups()`：`DELETE channel_mounts` + `DELETE agent_channel_mounts` 全删重建成 10 列 | 接受，但先确认本地 13 列的 `agent_profile_id`/`owner_user_id`/`workspace_folder` 三列确实无消费方 | 决策 9/19 |
| v58 `UPDATE registered_groups SET audience_mode='owner_only' WHERE jid LIKE 'feishu:%' AND sender_allowlist IS NOT NULL` → 10 个飞书会话 | **放行**（实测那 10 个群白名单恰好只有 owner，等价） | 决策 15 |

本地侧 606 行里的 `schema_version` 写入、`refreshPrivacyCache()`、以及约 598 行本地函数 → **全保**（`refreshPrivacyCache` 随决策 61 一起下线）。

#### `src/db.ts` 文件级陷阱

1. **H3 的列数与 `VALUES (?,…)` 占位符数必须一致。** 取错不编译报错，运行时才炸。
2. **H2 决定后面全部版本门是否触发。** 本地 45 < upstream 的 51/58/62 三道门 → 全跑：7008 行 `usage_events` 复制、10 个飞书群设 owner_only、`workspace_agent_profiles` 表重建。
3. **`enforcePreMigrationBackup` 的触发条件是 `>= 39 && < 63`，且 upstream 没有 env override。** 本地现有的 `HAPPYCLAW_ALLOW_DB_MIGRATION_WITHOUT_BACKUP` 常量在 H2 那侧，**必须保住**，并按决策 4 把条件改成「版本要变就备份」——否则每次没升到 63 的启动都 `VACUUM INTO` 一份约 130 MB，失败重启 N 次就是 N × 130 MB，没有 GC。
4. **H16/H17 的 SELECT 列改动之外**，upstream 还在同两条语句上追加了 `AND COALESCE(delivery_status,'') NOT IN ('queued','promoting','cancelled')` —— 这段**不在冲突块里**。本地历史值域是 `pending/sent/failed/skipped`，暂不命中；但只要保留本地写入路径，被标这三态的消息就会被主循环**永久跳过**。决策 46 已定让位，这里是执行点。

---

### 1.3 `src/container-runner.ts` — 19 块 · 逐块判断（本地为基线）

多运行时的落点集中在这个文件，**基调是保本地**。

| # | 行 | 争什么 | 取哪侧 | 依据 |
|---|---|---|---|---|
| H1 | 46 | `providerPoolManager`（本地多池）vs `resolveProviderFailureDisposition`（upstream） | 并集 | 决策 21 + 31 |
| H2/H3 | 62/101 | import。本地 `CodexProviderAuthMaterial`/`GrokProviderAuthMaterial` | 并集，本地两个类型必留 | §8.14 |
| H4 | 415 | `ContainerInput.agentProfile`（本地 19 行）vs `skillManifest`（upstream 2 行） | 两边都要 | 决策 27 + 74 |
| H5 | 463 | `ContainerOutput`：本地 `runtimeContext`；upstream `finalizationReason:'truncated'`/`pendingBgTasks`/`inputTurnCompleted` | 并集 | 决策 36/47 |
| H6 | 869 | 本地 30 行 provider override / 显式 pin（sticky 复用，不 resetSession） | **保本地** | 决策 21/85 |
| H7 | 1122 | `resolveAgentProfileForInput`（本地 54 行）vs `prepareHostPlugins`（upstream 3 行） | **两边都要**（不同函数） | — |
| H8 | 1222 | `buildVolumeMounts` 形参：本地 `modelOverride`/`codexAuthMaterial`/`grokAuthMaterial`；upstream `ipcAgentId`/`agentProfile` | **并集，并改成命名参数** | 静默杀手 #4 |
| H9 | 1347 | `.claude.json`：本地挂精简模板；upstream 按 `STRIPPED_CLAUDE_JSON_MAX_SIZE=500` 体积启发式清理 | **保本地** | 决策 78 |
| H10 | 1496 | env 行：本地 codex/grok 走 `nativeCliMaterial` 分流；upstream「Agent policy is authoritative，不继承 global/custom env」 | **保本地分流** | §8.14 + 静默杀手 #5 |
| H11 | 1619 | 纯缩进差（本地在块内 / upstream 在块外） | 按本地块结构 | — |
| H12 | 1756 | runtime 判定 + pool 选择（本地 32 行） | **保本地** | 决策 21 |
| H13 | 1797 | `evaluateSessionValidity`（本地）vs `providerFailure*` 变量（upstream） | 两边都要 | 决策 31 + §2.1 |
| H14 | 1835 | codex/grok auth material 写入（本地 25 行） | **保本地** | §8.14 |
| H15 | 1874 | `buildVolumeMounts` 实参 | 同 H8 | — |
| H16/H19 | 2259/3320 | `providerPoolManager.reportFailure(poolId,…)`（本地按池）vs `providerPool.reportFailure(…)`（upstream 全局） | **保本地按池** + 吸收 upstream 的 `success`/`closed` 分支 | §2.1「provider 池按池隔离·多运行时必需」 |
| H17 | 2691 | host 路径的 codex/grok provider 选择（本地 33 行） | **保本地** | §8.14 双路对称 |
| H18 | 3084 | host 的 `agentProfile` + `plugins` | 并集 | — |

**文件级陷阱**

- **H8/H15 是静默杀手 #4 的落点**：`buildVolumeMounts` 两侧参数列表不同，位置参数错配不会报错（类型都是 string/object），只会让模型覆盖失效或认证材料传错位。改成命名参数后逐个调用点核对。
- **H10/H14/H17 是静默杀手 #5**：Docker 路径的两个可写挂载（`CODEX_HOME`/`GROK_HOME`）+ 原生 CLI 环境变量分流。丢了 → codex/grok 在 docker 模式认证失败，报的是 provider 401 不是挂载错误。
- **H16/H19 必须同侧**：一个在 docker 分支一个在 host 分支，只改一处 = 两条路径的健康标记逻辑分叉。
- `prepareHostPlugins` 与 `buildVolumeMounts` 内联 materialize **必须对称**（CLAUDE.md §10）。H7 把 upstream 的 `prepareHostPlugins` 引进来时确认没顶掉本地版本。

---

### 1.4 `src/group-queue.ts` — 5 块 · 逐块判断

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 11 | `AgentRuntime`（本地）vs `ChannelTurnContext`（upstream） | 并集 |
| H2 | 2266 | 本地 `state.selectedProviderId = null` / `state.runtime = null` / `state.currentRunInitiator = null`；upstream 侧为空 | **保前两行，删第三行** |
| H3–H5 | 2703/2721/2740 | runner state 快照字段：本地 `runtime`；upstream `queryInFlight`/`queryId`/`queryStartedAt` | 并集 |

**陷阱（H2，响亮失败点）**：`currentRunInitiator` 字段与 `getActiveRunInitiator()` 已被**静默删除**（决策 55：stop/interrupt ACL 退回 owner-only，实测 0 个共享工作区），但这行赋值残留在 HEAD 侧。按 HEAD 解 → 引用已删字段，typecheck 挂。这是「按 `--ours` 整文件解会炸」的典型。

**H3–H5 的价值**：`queryInFlight` 正是决策 73 要的「进行中的轮次」信号 —— 宿主机并发闸要从「数活着的进程」改成「数进行中的轮次 + 最久空闲逐出」，这三个字段是前置。**别只取本地 `runtime` 一项。**

---

### 1.5 `src/types.ts` — 2 块 · 逐块判断

- **H1**（37）：本地 33 行（`AgentRuntime`/`ProviderFamily`/`ModelSelectionKind`/`BindingSource`/`ModelOptionStatus`/`ModelOptionSource`/`RuntimeAvailabilityStatus`/`ConversationSource`）vs upstream 3 行（`InteractionMode` + 三值 `ConversationSource`）。
  → **并集**；`ConversationSource` 取 upstream 三值版（加 `'native_thread'`，决策 49）。
- **H2**（81，本地 135 行 / upstream 82 行）：`ModelBinding` 家族 vs `ChannelTurnContext` + FollowUp 家族。
  → **两边都要**（决策 21 + 26 + 46/48）。

**文件级陷阱（实测）**：本地 `export type DeliveryStatus = 'pending'|'sent'|'failed'|'skipped'` **不在任何冲突块里，已被静默替换**为 upstream 的 `FollowUpStatus`。合并后 `src/types.ts` 只剩：

```ts
delivery_status?: FollowUpStatus | null;   // 562
export type FollowUpStatus = 'queued' | 'promoting' | 'released' | 'cancelled';   // 570
```

而 `src/db.ts:15890` 仍然导出同名的 `export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'`，`src/index.ts` H3 仍在 import 它。决策 46「本地 IM 投递改名让位」的执行点就在这三处，必须一次改齐。

---

## 二、共享类型（`shared/stream-event.ts` + 三份副本）

四个文件各 1 块，**是同一处冲突**：

```
shared/stream-event.ts                            :35-42
src/stream-event.types.ts                         :35-42
web/src/stream-event.types.ts                     :35-42
container/agent-runner/src/stream-event.types.ts  :35-42
```

争的是 `StreamEventType` 联合的尾部：本地多两个成员 `'assistant_text_boundary'` / `'sub_agent_result'`，upstream 只到 `'status' | 'init'`。

**处置：取并集。** 本地这两个成员有真实发射方（`container/agent-runner/src/index.ts` H17 那 199 行）。

**正确的操作顺序（重要）**

```bash
# 只解源文件，其余三份不要手工解
git checkout --ours src/stream-event.types.ts web/src/stream-event.types.ts \
                    container/agent-runner/src/stream-event.types.ts
# 手工解 shared/stream-event.ts（取并集）
make sync-types      # 用源文件覆盖三份副本
```

**陷阱 1（会静默）**：四份都在冲突列表里，手工解四遍极易解出**不一致**的四份。`scripts/check-stream-event-sync.sh` 只在 `make typecheck` 才校验；在那之前后端和前端会各自按自己那份编译通过。

**陷阱 2（响亮失败，但发生在别的文件）**：upstream 把 `usage.reasoningTokens` 和 `usage.modelUsage[].reasoningTokens` 改成了**必填**（无 `?`），这段**不在冲突块里**，静默落地：

```ts
usage?: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;   // ← 必填
  costUSD: number;
  ...
}
```

所有本地 emit usage 的点（`grok-event-normalizer.ts` / codex runner / `stream-processor.ts`）都要补字段。这是「响亮失败清单」的第 1 项，`make typecheck` 会拦。

**陷阱 3**：upstream 在同一文件里静默新增了 `tool_result` / `task_progress` / `task_updated` / `permission_denied` / `memory_recall` / `compact_boundary` / `notification` / `prompt_suggestion` / `raw_sdk_event` / `context_audit` 等成员，以及 `WorkflowRunSnapshot` / `ClaudeContext*Audit` 一整套接口，还有 `queryRunId` 字段。这些**全部干净落地**。其中 `queryRunId` 是静默杀手 #3 —— 流事件不带它，Codex/Grok 的重试轮在 Web 端全哑。本地 `runtime?: 'claude'|'codex'|'grok'` 字段实测存活。

---

### `container/agent-runner/src/types.ts` — 2 块

- **H1**（276）：本地 `agentProfile`（20 行，runtime-neutral persona）vs upstream `skillManifest`（2 行）→ **两边都要**。
- **H2**（334）：`sourceKind` 联合 + `runtimeContext`。→ **并集**，`sourceKind` 加 upstream 的 `'truncation_continue'`。

**陷阱**：`sourceKind` 这个联合在 `src/container-runner.ts` H5 有**同名副本**，两处必须字面一致。不一致不会立刻报错（两侧独立编译），只有跨进程反序列化到不认识的值时才出问题。

---

## 三、Agent Runner

### 3.1 `container/agent-runner/src/index.ts` — 19 块 · 逐块判断

| # | 行 | 争什么 | 取哪侧 | 依据 |
|---|---|---|---|---|
| H1/H2 | 22/58 | import 折行 + upstream 新符号（`Query` 类型 / `isSuspectTruncatedStreamResult` 等） | 并集 | — |
| H3 | 75 | import 主块。本地 `agent-persona`/`PREDEFINED_AGENTS`/`createMcpTools`/`codexCliAdapter`/`codexSdkAdapter`/`grokCliAdapter`；upstream `runtime-mcp-policy` 等 | 并集，**但删两行**：`PREDEFINED_AGENTS`（决策 60 转定义文件，源文件已删）、`codexSdkAdapter`（决策 38 不留，切 CLI） | 决策 60 / 38 |
| H4 | 195 | `DEFAULT_ALLOWED_TOOLS` 常量（upstream 38 行） | 并集 | 决策 28 |
| H5 | 323 | 三个提示词符号 —— 见下方专项 | 见下 | — |
| H6/H8 | 1128/1238 | `disableMemoryLayer` + `privacyMode` 形参 | **取 upstream（都删）** | 决策 61/62 |
| H7 | 1202 | PreCompact 归档：本地隐私模式跳过；upstream 完整归档 | 取 upstream | 决策 61 |
| H9 | 1721 | 本地 56 行 `globalClaudeMdPath` / `uniqueExistingDirectories` 等 | **保本地** | 决策 89（仓库文档污染人格的排除模块落点） |
| H10 | 1816 | `parseSkillDescription`（本地 62 行）vs `pruneProcessedHistoryImagesInTranscript`（upstream 6 行） | **两边都要**（不同函数） | — |
| H11 | 2130 | `queryRef` 类型：本地放宽为 `{interrupt(): Promise<unknown>}`；upstream `Pick<Query,'interrupt'>` | **保本地** | 决策 80（取 upstream 重新引入已修的 SDK 0.3.215 构建失败） |
| H12 | 2321 | `POST_RESULT_TIMEOUT_MS` 判定 —— **F1 的判定点** | **两个条件都要** | 决策 90 / §一点五 |
| H13/H18 | 2444/4482 | `disableMemoryLayer`/`globalMemoryContext`（本地）vs `agentBuilderEnabled`/`channel`（upstream） | 取 upstream + 删 `disableMemoryLayer`，保 `globalMemoryContext` | 决策 62 + 27 |
| H14 | 2496 | 本地 persona 注入 29 行 vs upstream `publishResultCandidate` 115 行 | 两边都要 | 决策 27 + 36/90 |
| H15 | 2683 | `extraDirs`：本地按 `disableMemoryLayer` 分支；upstream 按 `isHome` | 取 upstream | 决策 62 |
| H16 | 2833 | `query()` options：本地 `resolveClaudePermissionOptions({privacyMode,…})`；upstream `withHappyClawSubagentContract({…})` | **混合**：取 upstream 的 `sdkCompat` 包装，删 `privacyMode`，保本地 allowed/disallowedTools 派生 | 决策 37 + 61 + 28 |
| H17 | 3010 | 本地 199 行 `tool_use_summary`/`sub_agent_result` 处理 vs upstream 12 行 `rate_limit_event` | **两边都要** | 本地 `sub_agent_result` 是 StreamEventType 成员；upstream `rate_limit_event` 是决策 85 额度墙前置 |
| H19 | 4523 | `McpContext` 的 `privacyMode` vs `currentInputTurnId` | 取 upstream | 决策 61 + 47 |

#### H5 专项：三个提示词符号（响亮失败）

实测合并结果：

```
317  const SECURITY_RULES = loadPrompt('security-rules.md');
318  const INTERACTION_GUIDELINES = loadPrompt('interaction.md');
319  const ASSISTANT_OUTPUT_GUIDELINES = loadPrompt('output.assistant.md');   ← 静默落地
320  const PROACTIVE_OUTPUT_GUIDELINES = loadPrompt('output.proactive.md');   ← 静默落地
321  const TASK_OUTPUT_GUIDELINES = loadPrompt('output.task.md');             ← 静默落地
322  const WEB_FETCH_GUIDELINES = loadPrompt('web-fetch.md');
<<<<<<< HEAD
324  const CONVERSATION_AGENT_GUIDELINES = loadPrompt('agent-override.md');   ← 文件已被删
...
339  return `<guidelines>\n${OUTPUT_GUIDELINES}\n...`;                        ← OUTPUT_GUIDELINES 已无声明
```

本地原来在 123/124 行的 `loadPrompt('skill-routing.md')` 和 `loadPrompt('output.md')` 被 upstream 的三段拆分**静默替换掉了**（那两行不在冲突块内），但引用点还在 **3 处**：`:339`（`buildGuidelinesBlock`）、`:2511`（skill-routing 块）、`:4657`（Codex 侧 skill-routing 块）。

**处置**：
1. 取 upstream 的三段 output prompt，把 `buildGuidelinesBlock()` 改成按 mode 选 assistant / proactive / task；
2. `prompts/skill-routing.md` 与 `prompts/agent-override.md` 已被删（见 §六），要么从 HEAD 恢复这两个文件，要么改写三处引用；
3. 本地独有的 `CODEX_SKILL_FILE_GUIDELINES` 内联常量 **保留**（决策 21）。

#### H12 专项：F1 挂流判定

```
HEAD（本地，28 行）    if (resultReceivedAt && Date.now() - resultReceivedAt > POST_RESULT_TIMEOUT_MS) { …pendingSdkTasks 判断… }
upstream（8 行）       if (resultReceivedAt && !ipcDeliveryTracker.hasPendingTurns && Date.now() - … > POST_RESULT_TIMEOUT_MS)
```

**两个条件都要**（`!ipcDeliveryTracker.hasPendingTurns && pendingSdkTasks.size === 0`）。`upstream-merge-plan.md` §一点五明写：F1「状态追踪存活，但判定点在冲突区，选 upstream 侧即撤销」。撤销的后果是长任务的后台子 Agent 在主 Agent 出最终文本 5 秒后被连坐 interrupt，且**失败静默**（agents 表不记录 SDK Task，StreamEvent 也不落库），只有下一轮 resume 时 SDK 才报 `No completion record was found`。

---

### 3.2 `container/agent-runner/src/mcp-tools.ts` — 16 块 · 逐块判断

**这个文件是 MCP 工具中立层（决策 22）的所在地。整体基调：保中立层的包装器，吸收 upstream 的工具内容。**

| # | 行 | 争什么 | 取哪侧 | 依据 |
|---|---|---|---|---|
| H1 | 19 | `normalizeChannelTurnContext` import | 取 upstream | 决策 26 |
| H2/H3 | 44/56 | `McpContext` 字段：本地 `privacyMode`/`resumeMode`/`inputContextHash`/`workspaceInstructionHash`/`softInjectionReason`/`disableMemoryLayer`；upstream `currentInputTurnId` | 取 upstream 的 `currentInputTurnId`；保本地 `resumeMode`+两个 hash+`softInjectionReason`；删 `privacyMode`/`disableMemoryLayer` | 决策 61/62 |
| H4 | 277 | 本地一行 `const tools: RuntimeNeutralMcpToolDefinition<any>[] = [` vs upstream 258 行 proactive 契约 + 工具描述 | **把 upstream 258 行移植进中立层**，不要连带换掉数组类型 | 决策 22 + 29 |
| H5–H13 | 1039–1480 | 任务工具族：upstream 加 `revision`/`expected_revision`/`current_run`/`deleted_at`，H13 含 297 行四个新工具 | 取 upstream | 决策 23 + 20 |
| H14 | 2464 | `memory_append` 门控：本地 `isHome && !disableMemoryLayer && !privacyMode`；upstream `isHome` | 取 upstream | 决策 61/62 |
| H15/H16 | 2594/2778 | `memory_search` / `memory_get` —— 见下方专项 | **保本地** | 决策 22 |

#### H15/H16 专项：`defineTool` vs `tool`（最隐蔽的一块）

```
HEAD:      defineTool('memory_search', …)     ← 运行时中立层，Claude/Codex/Grok 共享
upstream:  tool('memory_search', …)           ← SDK 专用包装
```

两侧的函数体几乎逐字相同（连中文描述的 unicode 转义都一样），diff 只体现为**包装器名不同 + 整体缩进差 2 格**。这让它看起来像纯格式冲突，极易误取 upstream。

**取 upstream 的后果**：`memory_search` / `memory_get` 从中立 catalog 里消失 → Codex 和 Grok 运行时**失去 memory 工具**。决策 22 明写「取 upstream 会切断 Codex/Grok 的 24 个内建工具（飞书工具用了 1045 次）」。

**必须保本地的 `defineTool`。** H4 同理：`RuntimeNeutralMcpToolDefinition<any>[]` 这个类型不能换。

---

### 3.3 `container/agent-runner/src/stream-processor.ts` — 9 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 13 | import 折行 + upstream 13 个新符号 | 并集 |
| H2 | 174 | 本地 `pendingSdkTasks` 注释块（F1）vs upstream `workflowRunsByToolUseId` | **两边都要**（决策 90 + 35） |
| H3 | 974 | prettier 折行 | 取 upstream |
| H4 | 1102 | upstream 加 `backgroundDrain.taskStarted()` | 取 upstream + 保本地 `pendingSdkTasks.set` |
| H5 | 1174 | upstream 加 `patchStatus` 处理 18 行 | 取 upstream + 保本地 `isBackgrounded` 标记 |
| H6 | 1962 | 本地 `settlePendingSdkTask`（40 行）vs upstream `processTaskNotification`（17 行） | **两边都要**（不同方法） |
| H7 | 2056 | 本地 `pendingAgentResults.set`（等 tool_result 提全文）vs upstream `taskSummariesByToolUseId.set` | **两边都要** |
| H8/H9 | 2323/2340 | reset：本地清 `pendingAgentResults`/`taskDescriptions`；upstream 清 `lastThinkingTokenStatusAt` | 并集 |

**陷阱**：H6/H7 两侧是不同名的方法/字段，看起来像「upstream 重写了这段」，实际是两套并存的机制（本地 `sub_agent_result` 提取路径 + upstream `pendingSubAgentMessages` 路径）。本地 H9 的注释「本地 sub_agent_result 提取路径状态：与上游两套并清」正是为此写的 —— **两套都要清**。

`MAX_RECENT_EVENTS`（20→5）与 `MAX_THINKING_CHARS`（2000→800）是**本地已改**且合并未覆盖，不用管。

---

### 3.4 `container/agent-runner/src/utils.ts` — 1 块

upstream 新增 130 行（`isSuspectTruncatedStreamResult` / `shouldForceBackgroundTaskSummary` / `buildBackgroundTaskSummaryPrompt` 等），本地侧为空。

**处置：可以取**（纯新增函数，不调用就不生效）。但决策台账把 `c4fb789`「上游断流截断的回复自动续写」标为 ⏸ 暂缓，理由是「收益推测性，多运行时 usage 口径不同易误判」。

**陷阱**：`isSuspectTruncatedStreamResult` 的指纹是「正文非空 + usage 双零」。Codex/Grok 的 usage 口径与 Claude 不同（决策 41：codex 1.85×、grok 1.78× 膨胀，且 `inputTokens` 含 cachedRead），双零判据在这两条运行时上不可靠。**取这 130 行时，`index.ts` 那侧的调用点必须门控到 `runtime === 'claude'`。**

---

## 四、前端

### 4.1 `web/src/components/settings/types.ts` — 1 块

争 `SettingsTab` 联合 + 三个模型相关 interface。

| | 本地 | upstream |
|---|---|---|
| tab 数 | 21 | 23 |
| 本地独有 | `models` `gpt` `grok` `agent-definitions` | — |
| upstream 独有 | — | `automation` `main-agent` `host-integration` `billing` `preferences` `agent-profiles` |
| 附带 | `ProviderPoolModelOption` / `ProviderPool` / `ConversationRuntimeState` 三个 interface | 无 |

**处置：并集减去已砍项。**

- 保 `models` / `gpt` / `grok`（决策 65：GPT/Grok 并进「模型与提供商」，模型页单开）
- 去掉 `agent-definitions`（决策 59：自定义 SubAgent 删）
- `agent-profiles` 是否保留看决策 56 的边界（只要核心 2400 行；Builder UI 砍）
- **三个 interface 必保**（决策 21）

**陷阱**：`SettingsTab` 是字符串联合 —— **少**一个成员会在 `SettingsPage.tsx` / `SettingsNav.tsx` 触发穷举错误（好事，编译器会拦）；**多**一个不会报错，只是那个 tab 永远进不去。这是单向的静默。

---

### 4.2 `web/src/pages/SettingsPage.tsx` — 4 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 29 | `VALID_TABS` / `SYSTEM_TABS` / `FULLPAGE_TABS` | 并集减砍项，与 §4.1 保持一致 |
| H2 | 105 | `defaultTab`：本地 `'models'`，upstream `'claude'` | **保本地 `'models'`**（决策 65：模型页单开且是入口） |
| H3 | 140 | 本地 58 行 `mobileTabs` vs upstream 20 行 `sectionTitle: Record<SettingsTab,string>` | **两边都要** |
| H4 | 308 | 渲染分支：本地 7 行含 `gpt`/`grok`/`models` 三个 section；upstream 33 行含 `automation`/`main-agent`/`host-integration` 分组 | **并集减砍项** |

**陷阱**：H3 的 `sectionTitle` 是 `Record<SettingsTab, string>` —— 少一个 key 会编译报错，正好当穷举检查，**别把它改成 `Partial<>`**。

H4 是**静默杀手 #6** 的一半：类型对了不代表渲染分支写了。合并后必须打开界面肉眼确认「模型 / GPT 提供商 / Grok 提供商」三个入口都在且能点开。

---

### 4.3 `web/src/components/settings/SettingsNav.tsx` — 2 块

- **H1**（4）：图标 import（本地 `Cpu`/`KeyRound`；upstream 13 个）→ **并集**。
- **H2**（39）：本地 10 行 `systemItems` 数组（models / claude / gpt / grok / registration / appearance / system），**upstream 侧为空**。
  → **保本地数组**，再按 upstream 的新分组结构调整。

**陷阱**：upstream 侧为空意味着它把这个数组挪走或改了结构。取 upstream（空）→ 侧边栏「系统」分组整个消失，**不报错**（数组只是没人渲染）。这是静默杀手 #6 的另一半。

---

### 4.4 `web/src/components/chat/ChatView.tsx` — 2 块 · 静默杀手 #6 主战场

- **H1**（46）：
  ```
  HEAD:      import { TopicSidebar } …  +  import { WorkspaceModelSelector } …
  upstream:  import { SessionSidebar } …
  ```
  - `TopicSidebar.tsx` 在静默删除清单里，且是「merge-base 就有的 upstream 功能、本地一行没改」→ **用 upstream 的 `SessionSidebar` 替代**。
  - `WorkspaceModelSelector` **必保**（决策 21 + 静默杀手 #6「模型切换下拉」）。

- **H2**（858，本地 319 行 / upstream 8 行）：整个 header + 主体布局。
  → **以本地 319 行为基线，逐段合入 upstream 的 header 结构**（决策 63：前端形态跟 upstream，执行轨迹面板保留）。

**陷阱**：本地那 319 行里挂着三样东西 —— 模型切换器的挂载点、执行轨迹面板的挂载点、`is_shared` 徽章。选 upstream 侧 8 行 → 三样全从界面消失，**typecheck 全绿**（组件还在，只是没人渲染）。`upstream-silent-changes.md` 把「面板挂载点在冲突区」单列为静默杀手 #6。

---

### 4.5 `web/src/components/chat/MessageBubble.tsx` — 5 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1/H2 | 2/32 | import。本地 `AlertTriangle`（未送达角标）+ `formatTokens` + `TurnTracePanel`；upstream `resolveAgentDisplayIdentity` / `token-usage-presentation` / `WorkflowRunCard` | 并集；`TurnTracePanel` **必保**（决策 63） |
| H3 | 122 | 本地 `shortModel()` 61 行 vs upstream `TokenUsageDisplay` 25 行 | 保本地 `shortModel`（Opus 5 / `[1m]` 后缀处理是本地新增），取 upstream 的 `TokenUsageDisplay` 骨架 |
| H4 | 217 | **决策 66 的落点** —— 见下 | **保本地分列** |
| H5 | 868 | 本地 160 行 AI 消息渲染主体 vs upstream 12 行 `React.memo` 比较器 | **两边都要** |

**H4 详情**：

```
HEAD:      🆕 {new} new · 🗂 {cached} cached · 💡 {out} out · 💰 ${cost}
upstream:  {displayTotal} tokens · {duration}s
```

决策 66 明写「token 总数显示按运行时分口径，五类相加会让 codex/grok 缓存算两遍」→ **保本地分列**，可吸收 upstream 的展开明细面板作为补充。

**H5 陷阱**：本地 160 行是渲染主体（含 §8.9 per-user AI 外观 + 未送达角标），upstream 12 行是 `React.memo` 的 props 比较函数。两段在文件里紧邻但功能正交，**极易只取一边**。取本地丢 memo（性能回退，不报错）；取 upstream 丢整个渲染体（编译报错，能拦住）。

**文件级陷阱**：`:935-950` 的角标依赖 `delivery_status ∈ {'failed','pending'}`。决策 46 让位后这个值域不存在 → 角标永不显示，不报错。三选一：本地列改名保留、角标接到 upstream outbox 状态、或明确接受角标下线。

---

### 4.6 `web/src/stores/chat.ts` — 3 块

- **H1**（402）/ **H3**（2353）：`enablePrivacy`（本地）vs `updateInteractionMode`（upstream）→ **取 upstream，删本地**（决策 61 隐私模式下线 + 决策 49 交互模式列）。
- **H2**（1884）：发送消息响应契约。本地 `handledCommand?`；upstream `disposition: 'started'|'queued'|'steered'` + `runId?`。
  → **取并集**。决策 51 明写：「命令响应契约取并集 —— `/model` 是本地独有，处置状态是队列需要」。

**文件级陷阱（实测，响亮失败）**：`Message` 接口里 `delivery_status` **出现两次，没有冲突标记**：

```ts
// :62  本地
delivery_status?: 'pending' | 'sent' | 'failed' | 'skipped' | null;
...
// :73  upstream
delivery_status?: 'queued' | 'promoting' | 'released' | 'cancelled' | null;
```

TS 会报 duplicate identifier。这是「响亮失败清单」的「投递状态重复成员」——它在一个**有冲突**的文件里，但重复本身在冲突块**之外**，解完三块也不会消失。

---

### 4.7 `web/src/types.ts` — 1 块

本地 `privacy_mode?: boolean` vs upstream 6 个 `agent_profile_*` 字段。
→ **取 upstream，删 `privacy_mode`**（决策 61）。必须与 `src/routes/groups.ts` H2/H3 同侧。

---

### 4.8 `web/src/components/chat/ContainerEnvPanel.tsx` — 2 块

- **H1**（12）：`MODEL_ENV_KEY` + `MODEL_PRESETS`（本地 13 行，含 `fable`/`claude-opus-4-8[1m]`/`claude-sonnet-5`）vs `SYSTEM_MANAGED_ENV_KEYS`（upstream 7 行）→ **两边都要**。
- **H2**（211）：本地 65 行手填 Claude provider 字段 vs upstream 14 行 error 提示 + legacy override 警告。
  → **取 upstream 的「这些键由系统托管」提示**（避免用户手改 `ANTHROPIC_MODEL` 与模型页打架，决策 65），本地 `MODEL_PRESETS` 下拉按需保留。

---

### 4.9 `web/src/components/settings/ClaudeProviderSection.tsx` — 1 块

```
HEAD:      api.patch(`/api/config/claude/providers/${id}`, { enabled: !enabled })
upstream:  api.post(`/api/config/claude/providers/${id}/toggle`, { enabled: !enabled }, 120_000)
```

→ **取 upstream**（决策 53：provider 开关跟 upstream 全局判断）。

**陷阱**：必须与 `src/routes/config.ts` H8 **同侧**。前后端解成不同侧 = 404，typecheck 不会发现，点一下开关才知道。

---

### 4.10 `web/src/components/settings/ProviderEditor.tsx` — 1 块

本地 48 行：official 与第三方共用模型输入 + 本地模型下拉；upstream 11 行：只 official 有下拉。
→ **保本地**（决策 21 多运行时 + 决策 65 模型页）。

---

## 五、其余后端文件

### 5.1 `src/routes/groups.ts` — 11 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1/H2/H3 | 64/300/407 | `privacy_mode` / `enablePrivacyForFolder` vs `agent_profile_*` 六字段 | 取 upstream，删 privacy（决策 61） |
| H4/H5/H6 | 941/955/986 | PATCH body 字段：`privacy_mode` vs `interaction_mode` | 取 upstream（决策 49） |
| H7 | 1038 | 本地 13 行 privacy 一次性开启 vs upstream 28 行 interaction_mode 校验 | 取 upstream |
| H8 | 1215 | 响应体 + upstream 新增 170 行 `PATCH /api/groups/:jid/agent-profile` | 取 upstream（决策 56 核心数据层） |
| H9 | 1655 | 本地 7 行 `deleteGroupData` + `removeFlowArtifacts` + 清 deps；upstream 侧为空 | **保本地**（`removeFlowArtifacts` 本地独有） |
| H10/H11 | 1846/1985 | `clearSessionChannelOwner(...)` + `delete deps.getSessions()[folder]` | **取前者，删后者** |

**陷阱（H10/H11）**：`WebDeps.sessions` / `getSessions` 已被本地删除并在 `src/web-context.ts` **静默胜出**（实测合并后该文件 `sessions` 零命中）。取 upstream 这两块原样 → `TS2339: Property 'getSessions' does not exist`。同一个陷阱在 `src/commands.ts` 和 `src/capability-runtime-mutation.ts` 各出现一次（后者不冲突，见 §七.2）。

---

### 5.2 `src/commands.ts` — 1 块

upstream 新增 4 行：`clearSessionChannelOwner(folder, agentId)` + `delete deps.sessions[folder]`。
→ **取 `clearSessionChannelOwner`，删 `delete deps.sessions[...]`**（同上陷阱）。

---

### 5.3 `src/task-scheduler.ts` — 10 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1/H3 | 57/97 | import | 并集 |
| H2 | 88 | 本地 `resolveTaskOwner` / `resolveTaskSourceImJid` import；upstream 侧为空 | **保本地**（任务 IM 回投，决策 77 周边） |
| H4 | 489 | `storePromptMessage` 签名 + upstream 多两参 | 取 upstream（决策 43） |
| H5 | 651 | cron 解析 → `nextValidatedCronRun` | 取 upstream |
| H6 | 663 | interval 下限：`<= 0` → `< MIN_INTERVAL_MS(60s)` 且 throw | 取 upstream，**但先普查存量任务** |
| H7 | 683 | `safeComputeNextRun`（本地）vs `computeNextRunForTaskResume`（upstream 27 行） | **两边都要** |
| H8 | 1124 | 本地 50 行（`promotePendingConversationRuntimeBinding` 模型切换）vs upstream 28 行（run-scoped session） | **混合**：保本地 binding 提升（决策 21），会话 agentId 取 upstream 的 run-scoped（决策 20 前置） |
| H9 | 1256 | `ContainerInput`：本地 21 行 runtime/provider vs upstream 5 行 `messageTaskId`/`sessionAgentId`/`agentProfile` | 并集（决策 21 + 27） |
| H10 | 1422 | session 持久化 | 保本地 + 吸收 upstream 的 `!output.providerFailure` 条件（决策 31） |

**陷阱（H6）**：`MIN_INTERVAL_MS = 60_000` 是新增硬闸。存量秒级/亚分钟 interval 任务在下次算 `next_run` 时会 **throw**，走 missed + pause 路径。合并前先跑一遍 `SELECT id, schedule_type, schedule_value FROM scheduled_tasks WHERE schedule_type='interval'` 确认。

**注意边界**：决策 82「定时任务默认上下文保 `group`」和决策 83「暂停任务手动触发保拒绝」的落点**不在这个文件的冲突块里** —— `createTask` 的 `context_mode || 'isolated'` 和 `triggerTaskNow` 的 `status === 'parsing'` 判据是**静默采纳**的行为反转（`upstream-silent-changes.md` §三）。必须主动改回，见 §七.9。

---

### 5.4 `src/web.ts` — 9 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1/H3 | 64/416 | `modelRoutes`（本地）vs `channelAccountRoutes`（upstream） | **两条路由都挂**（决策 18 + 21） |
| H2 | 88 | import。本地 `recordTurnEvent`（执行轨迹）**必保** | 并集（决策 63/93） |
| H4 | 472 | `executeSessionReset` 折行 + upstream 多参 | 取 upstream |
| H5 | 546 | 命令响应 + upstream 100 行 follow-up 广播 | 并集（决策 51） |
| H6 | 699 | 响应类型：`handledCommand?` vs `disposition`+`runId` | **并集**（决策 51） |
| H7 | 1207 | 本地 12 行 `handleWebModelCommand`（`/model`）vs upstream 23 行 `queueForLater`/`steer` | **两边都要** |
| H8 | 2413 | `broadcastModelChanged`（本地）vs `broadcastFollowUpUpdate`（upstream） | **两个函数都要** |
| H9 | 3081 | 本地 12 行流式快照 + `recordTurnEvent`；upstream 1 行 `updateStreamingSnapshot(jid, event, decision.runId)` | 保本地 + 吸收 `decision.runId` 参数 |

**陷阱（H7）**：只取 upstream → Web 端 `/model` 命令失效，消息被当普通文本发给 agent。静默。

**陷阱（H9）**：`decision.runId` 就是静默杀手 #3 的 `queryRunId` 来源。不接 → Codex/Grok 重试轮在 Web 端全哑（有流事件但归不到当前 run）。同时本地 `recordTurnEvent` 是执行轨迹面板的唯一写入点（决策 93 还要查清 runtime 列来源），必须保。

---

### 5.5 `src/feishu.ts` — 8 块

| # | 行 | 争什么 | 取哪侧 | 依据 |
|---|---|---|---|---|
| H1 | 38 | import：upstream 39 行含 `resolveAdmittedChannelRoute` / `parseChannelAddress` / `scopeChannelJid` | 并集 | 决策 16/18 |
| H2 | 113 | `messageMeta?: FeishuMessageMeta` 形参 | **保本地** | 决策 25 |
| H3/H8 | 207/3699 | `getChatInfo` 返回：本地 `ChatProbe`（三态 ok/unknown/dead）vs upstream `FeishuChatInfo \| null`；upstream 另加 `executeCapability` | **保本地 `ChatProbe` 三态**；`executeCapability` **不接** | 决策 25 |
| H4/H6/H7 | 1796/3535/3548 | 错误处理 —— 见下 | **组合** | 决策 79 |
| H5 | 1971 | upstream 78 行入站 meta 构造 + admission | 取 upstream，保本地 `onCommand` 的 `threadId`/`rootId`/`parentId` 透传 | 决策 16/17/18 |

**H4/H6/H7 详情（决策 79：组合）**

```
HEAD:      logger.error({ chatId, err: describeFeishuError(err) }, '…'); clearAckForTarget(chatId);
upstream:  logger.error({ chatId, err }, '…'); throw new FeishuTextDeliveryError(…);
```

两边意图相反但不互斥：本地是 F5 日志瘦身（消除 48KB 单条），upstream 是把静默失败改成抛出。**都要**：`describeFeishuError(err)` 保 + `throw` 加。

**陷阱**：H7 本地在抛出前还有 `clearAckForTarget(chatId)`。upstream 直接 throw → ack 表情残留（决策 52 要求精确记账，实测每 8~9 条消息残留 1 个）。**抛出前必须先清 ack。**

**H3/H8 陷阱**：本地 `ChatProbe` 的三态是一处修复 —— 「空响应是我方/传输异常，无法断言群失效 → unknown」。upstream 的 `null` 把「空响应」和「群不存在」混为一谈，配合 `autoRemoveDeadImGroup` 会误删绑定。

---

### 5.6 `src/routes/config.ts` — 8 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1/H2/H3 | 4/15/165 | import | **并集**，但见下方陷阱 |
| H4 | 1005 | `applyToAllGroups` → upstream `mutateClaudeConfigForAllGroups` | 取 upstream（决策 53） |
| H5–H8 | 1235/1423/1521/1592 | provider PATCH / secrets / DELETE / toggle | **两者都要**：upstream 的 `withClaudeConfigMutationLock` + 本地的池过滤 |

**H5–H8 详情**

```
HEAD:      const current = getProviders().find(p => p.id === id);
           if (!current || current.providerPoolId !== 'claude') return c.json({error:'Claude provider not found'}, 404);
upstream:  return await withClaudeConfigMutationLock(async () => {
             const previous = getProviders().find(p => p.id === id);
             if (!previous) throw new Error('未找到指定供应商');
             …
```

- 取 upstream 的锁（决策 53：provider 开关全局判断、失败可恢复）
- **保本地的 `providerPoolId !== 'claude'` 池过滤**（决策 21）

**陷阱（最贵的一个）**：upstream 版**没有池检查**。用 Claude 的 provider API 去 toggle 一个 grok provider 会**成功**，然后写盘时按 upstream 的 v4 schema 落地 —— 而两边都写 v4 但 schema 不同 → **销毁 codex/grok 凭据**。这正是决策 3「provider 配置版本号推到 5」和阶段 0.2 要在合并**之前**做的事。静默杀手 #1 的验证方法：合并后在设置页点一次 provider 开关，再检查 `data/config/codex/`、`data/config/grok/` 下的 `auth.json` 是否完好。

**陷阱（H2 import）**：

```ts
import { DATA_DIR, updateWeChatNoProxy } from '../config.js';
```

`updateWeChatNoProxy` 在 `src/config.ts` 里已被**静默删除**（实测合并后该文件 `WECHAT_NO_PROXY` / `updateWeChatNoProxy` / `isWeChatBypassingProxy` 三个符号零命中）。保这行 → `TS2305`。要么从 HEAD 恢复 `src/config.ts` 那段，要么删这个 import 及其调用点。

**H8 方法要与前端 `ClaudeProviderSection.tsx` 同侧（`POST /toggle`）。**

---

### 5.7 `src/runtime-config.ts` — 4 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 1734 | 禁用最后一个 provider 的保护：本地按池；upstream 全局 | **取 upstream**（决策 53） |
| H2/H3 | 4356/4405 | `SystemSettings`：本地 `autoRemoveDeadImGroup`；upstream `maxRepliesPerTurn`(20) / `maxTasksPerUser`(200) | 并集 |
| H4 | 4681 | 本地 165 行逐字段 file→env→default vs upstream 32 行 `normalizeSystemSettings` 重构 | 取 upstream 骨架 + 把本地全部字段搬进去 |

**陷阱（H4）**：本地那 165 行里藏着 `maxConcurrentHostProcesses`。upstream 的 `hasCapacityFor` 对 host 模式直接 `return true`（静默），而这个设置项在 `schemas.ts`、`runtime-config.ts`、设置页表单**全部保留** → 用户还能改这个数字，但它不再是准入门。最坏形态：设置存在、可修改、完全无效。决策 73 要「数进行中的轮次 + 最久空闲逐出」，这个字段要留且要真生效（配合 `group-queue.ts` H3–H5 的 `queryInFlight`）。

**H1 与 §5.6 不矛盾**：一个是「至少留一个 enabled provider」（跟 upstream 全局），一个是「别用 Claude 的 API 改 grok 的 provider」（保本地池过滤）。

---

### 5.8 `src/schemas.ts` — 4 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 495 | `privacy_mode: z.literal(true)` vs `interaction_mode: InteractionModeSchema` | 取 upstream（决策 61/49） |
| H2 | 519 | `SystemSettingsSchema`：本地 42 行 vs upstream 64 行（`z.object({}).refine(...)` 形态） | 并集，与 §5.7 H2/H3 对齐 |
| H3 | 787 | prettier 折行（飞书 appId 校验） | 取 upstream |
| H4 | 1067 | 本地 14 行 `runtime`/`providerFamily`/`providerPoolId`/`authMode` vs upstream 1 行 `anthropicBaseUrl` | **保本地** |

**陷阱（H4）**：这 14 行是 provider 配置 v5 的字段基础（决策 3）。取 upstream → 保存 provider 时 codex/grok 的字段被 zod **strip 掉**，静默丢失。zod 默认 strip 未声明字段，不会报错。

---

### 5.9 `src/provider-pool.ts` — 1 块

本地 22 行内联自动恢复 vs upstream 2 行 `this.refreshRecoveryState()`。
→ **取 upstream 的抽取**（附带 `DEFAULT_RECOVERY_INTERVAL_MS = 300_000` / `UNHEALTHY_THRESHOLD = 3`）。

**陷阱**：本地那 22 行里 `recoveryIntervalMs` 是**按池可配**的（`const { strategy, members, recoveryIntervalMs } = this`）。取 upstream 时确认 `refreshRecoveryState()` 里没把它写死成常量，否则 grok 池和 claude 池共用一个恢复间隔（决策 21 要求按池隔离）。

---

### 5.10 `src/im-channel.ts` — 3 块

- **H1**（51）：import → 并集。
- **H2**（207）：`getProviderClient(): unknown`（本地 9 行，飞书 MCP 工具的底座）vs `reconcileStreamingCard` / `getChatInfo` / `executeCapability`（upstream 22 行）→ **两边都要**，`getProviderClient` **必保**（决策 25）。
- **H3**（393）：适配器实现。`getProviderClient()` 返回 `inner.getLarkClient()`（本地）vs `executeFeishuCapability`（upstream）→ **保 `getProviderClient`**，`executeFeishuCapability` 可作为额外方法加上但不接管本地实现。

---

### 5.11 `src/im-manager.ts` — 2 块

- **H1**（59）：import → 并集。
- **H2**（150）：`sendMessage` 签名。本地有 `messageMeta?: FeishuMessageMeta`；upstream 只是 `mentions` 折行。
  → **保本地 `messageMeta`**（决策 25）+ 取 upstream 的折行。

**注意**：`setFeishuTyping()`（`:1006` 附近）依赖的 `sendReaction(chatId, isTyping)` 已被静默删除（§六.2）。这个文件不冲突的那部分要一起处理。

---

### 5.12 `src/wechat.ts` — 3 块

三处结构相同：upstream 新增 `throw new Error('No context_token available for WeChat chat …')`，本地侧为空（原来静默返回）。
→ **取 upstream 三处**（反向增量：可观测性）。

**陷阱（这个文件最危险）**：微信是 fail-closed 路由的重灾区 —— 实测 4 个无绑定会话里有 3 个是 wechat（cxx / whz / wechat folder 各一）。这三个 `throw` 叠加 fail-closed 路由 = **微信全线断**。

**前置条件**：必须先做决策 16 的三行修法（区分「没有覆盖」和「解不出来」），或先补全那 8 个绑定。决策 17「四渠道补配对码」里 wechat 也在列。

---

### 5.13 `src/script-runner.ts` — 1 块

本地 17 行 `exec(command, { cwd, timeout, maxBuffer, env: { …全量继承 } })` vs upstream 19 行 `runId` + `settled` promise + 白名单 env。

→ **取 upstream 的 `runId`/`settled` 生命周期骨架，env 部分保本地全量继承。**

**陷阱**：这是最容易「整块取 upstream」的文件之一 —— 只有 1 个 hunk，看起来像纯重构。决策 77 明写「脚本任务环境变量保本地全量继承」，理由是日报脚本内部调 `claude --print`，取白名单会丢 OAuth。取错 → 脚本任务静默失去认证，报的是 Claude CLI 未登录，追不到 env 上。

---

### 5.14 `src/routes/tasks.ts` — 1 块

本地 18 行（运行中任务拒删 + 清理专属工作区）vs upstream 3 行 `getActiveTaskRunForTask(id)` 租约判定。
→ **取 upstream 租约判定 + 保本地的工作区清理**（决策 20）。

---

### 5.15 `src/feishu-cards/sections.ts` — 7 块 · 保本地为主

决策 1 以本地外观为基线（见 `tests/feishu-thread-routing.test.ts` 里那条 `.skip` 的注释）。

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 222 | 本地 29 行「🆕 new / 🗂 cached / 💡 out」三分类 usage 行 vs upstream 26 行 `is_short` 字段网格 | **保本地**（决策 66，与 MessageBubble H4 同口径） |
| H2 | 782 | 面板顺序注释 | 取 upstream（加 status banner） |
| H3 | 821 | 本地 `buildRuntimePanel({ASK_PANEL, expanded: profile === 'claude', …})` vs upstream `STATUS_BANNER` markdown + 不渲染假 ask 面板 | **两边都要**：加 upstream 的 `STATUS_BANNER`，保本地的 runtime-aware ask 面板（决策 34） |
| H4–H7 | 853/873/885/897 | 占位文案：本地用常量 `progressPlaceholder` 等；upstream 内联中文字符串 | **保本地常量**（可读性 + 便于 runtime 特化） |

---

### 5.16 `src/feishu-cards/builder.ts` — 2 块

- **H1**（174）：标题。本地 `${baseTitle} · 生成中`（从正文提取标题）；upstream `statusHeadline('running')`（永不用正文首行做标题）。
  → **保本地**（决策 1）。upstream 的理由（保持 streaming→terminal 一致）可作为后续改进，不在本次合并做。
- **H2**（266）：`expandThinking`。本地 `true`（用户可看推理流入）；upstream `false`（status banner 承载进度）。
  → **保本地 `true`**（决策 1，本地外观基线）。

---

### 5.17 `src/feishu-streaming-card.ts` — 34 块 · 逐块判断（本地为基线）

全仓块数第二。**基调：保本地外观与 liveness 机制，吸收 upstream 的三项**（lifecycle 观测 / terminal guard / status banner）。

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 68 | opts 接口：本地 `runtimeProfile`；upstream `lifecycle` + 100 行新类型 | **并集**（决策 34 需 runtimeProfile；lifecycle 是决策 43 的观测点） |
| H2 | 731 | `titleWithStreamingStatus(title \|\| 'Agent 回复')` vs `statusHeadline('running')` + `STREAMING_PLACEHOLDER` | **保本地** |
| H3 | 810 | 同上 + upstream 的空内容早退 | **保本地** |
| H4 | 877 | 本地 18 行 `formatUsageNote` | **保本地**（决策 66） |
| H5 | 2149 | 成员 `runtimeProfile` vs `lifecycle` | 并集 |
| H6 | 2186 | upstream `heldOpen` 字段（挂起完成） | **不取**（台账 `5f04246`/`81f0b5a` ❌，与 F2 冲突） |
| H7 | 2197 | 本地 35 行 `operationHistory`/`firstTextFlushLogged`/liveness 状态 | **保本地**（F5 + liveness） |
| H8 | 2245 | 构造器赋值 | 并集 |
| H9 | 2409 | `ensureCardCreating('thinking')` vs `beginCreation()` | **保本地**（带 reason 是 F5 日志瘦身的一部分） |
| H10 | 2423 | `heldOpen = null` + upstream 的 `AskUserQuestion` 让位处理 | **不取 heldOpen，取 AskUserQuestion 处理** |
| H11 | 2476 | upstream `wasWaiting`（AskUserQuestion 结束） | 取 upstream |
| H12 | 2510 | `heldOpen = null` | 不取 |
| H13 | 2526 | `ensureCardCreating('thinking_delta')` vs `beginCreation()` | 保本地 |
| H14 | 2646 | todo 面板：本地 `state==='idle' && todos.length>0` 也建卡 | **保本地**（决策 34：Grok 发 todo 也要有面板） |
| H15 | 2668 | `recordCardActivity()` | 保本地（liveness） |
| H16 | 2684 | task 面板 idle 分支 | **保本地**（同 H14） |
| H17 | 2702 | `recordCardActivity()` + event 对象 | 保本地 |
| H18 | 2748 | `recordCardActivity()` vs `heldOpen = null` | 保本地 |
| H19 | 2822 | `patchUsageNote(usage: UsageNoteData)` vs 内联字面量类型 | **保本地类型**（决策 66） |
| H20 | 2851 | legacy 卡片 usage patch：本地重建完整结构卡（metaRow）vs upstream 只 patch footer | **保本地** |
| H21 | 3127 | 创建期间 finalize：upstream 注释「abort() 拥有并 await provider finalization」 | **取 upstream**（防 double-finalize） |
| H22 | 3152 | `startLivenessHeartbeat()` vs `startHeartbeat()` + `emitLifecycle('streaming')` | 并集 |
| H23 | 3251 | `runtimeProfile: this.runtimeProfile` 透传 | **保本地**（决策 34） |
| H24 | 3259 | `setTraceUrl`（本地 8 行）vs upstream 35 行「provider projection 保持可见中性面」 | **两边都要** |
| H25 | 3324 | upstream 25 行 terminal guard（调度与执行之间已 complete/abort 则不推） | **取 upstream** |
| H26 | 3448 | `withLivenessSilence(...)` 包装 | 保本地 + 吸收折行 |
| H27/H28 | 3489/3589 | `statusBanner` 字段 | 取 upstream |
| H29 | 3629 | flush 的 markdown patch 列表：本地 55 行（collapsible_panel 结构恒定约束）vs upstream 53 行（STATUS_BANNER 优先） | **逐行合并**：保本地的结构恒定约束，加 upstream 的 STATUS_BANNER 元素 |
| H30 | 3808 | 同 H19 | 保本地类型 |
| H31 | 3838 | 本地 24 行 `finalThinkingText` + `MAX_FINAL_THINKING = 3800` | **保本地** |
| H32 | 3960 | usage 缓存到 controller 防竞态（H20 的配套） | **保本地** |
| H33/H34 | 4131/4173 | `effectiveFooterNote` + `buildLiveFooterNote()`（本地）vs `liveDisplayText()`（upstream） | **保本地** |

**文件级陷阱**

1. `MAX_STREAMING_CONTENT` 从 `100000` 改成 **`30000`** —— **不在任何冲突块里**。决策 68 是「跟 upstream 30000」（7421 条回复只有 3 条超，且只影响打字过程），所以放行即可，但要知道它是静默生效的。
2. H29 的 `collapsible_panel` 结构恒定约束（本地注释：「保持 collapsible_panel 结构恒定，避免 mid-stream 结构重写，Feishu streaming_mode 会抖」）如果被 upstream 侧覆盖，症状是卡片在流式过程中闪烁重排 —— 不报错，只有肉眼能看出来。
3. H6/H10/H12/H18 的 `heldOpen` 是一整套机制，**要么全不取**。取一半（比如取了字段声明但没取清除逻辑）会让卡片永久停在挂起态。

---

## 六、modify/delete 冲突（3 个）

git 报了 3 个 UD，三个 HEAD 版本都被留在工作树里（`git status` 显示 `UD`）。**什么都不做 = 文件保留但没人 import = 死代码，不报错，功能静默消失。**

### 6.1 `web/src/components/groups/GroupCard.tsx`

- **本地改动**：`+16/-1` —— 执行模式徽章（`宿主机` / `Docker`，带 Monitor / Box 图标和配色）
- **upstream 删除原因**：整个 `GroupsPage` 被 SettingsPage 的 `groups` tab 取代（`web/src/pages/GroupsPage.tsx` 也在静默删除清单里）
- **处置**：**接受删除**（`git rm web/src/components/groups/GroupCard.tsx`），**把那 16 行徽章移植到 upstream 的替代组件**

**依据**：决策 63「前端形态跟 upstream」；但执行模式是 host/container 双模的用户可见信息（CLAUDE.md §2.4），不能丢。

**陷阱**：执行模式徽章是唯一让用户看出「这个工作区跑在宿主机还是容器里」的地方。删了不报错。

### 6.2 `web/src/components/groups/GroupDetail.tsx`

- **本地改动**：`+96/-1` —— 执行模式切换器
- **处置**：**接受删除，把切换器移植进 upstream 的工作区设置面板。移植完成前不要合进 main。**

**陷阱**：这 96 行是**唯一**能在界面上切换 host / container 的入口。删掉后只能改数据库。比 6.1 更严重。

### 6.3 `container/skills/agent-browser/SKILL.md`

- **本地改动**：`+31/-134` —— 文档瘦身
- **upstream 删除原因**：upstream 删掉了**整个 `container/skills/` 目录**（实测 `git ls-tree upstream/main -- container/skills/` 为空），改走 `data/builtin-skills/` + `scripts/builtin-skill-catalog.mjs`
- **处置**：**接受删除**，agent-browser 技能改由 builtin-skills catalog 提供（决策 74）

**陷阱（比文件本身更重要）**：本地在 merge-base 之后新增了 4 个技能，它们**不在冲突里、自动保留**：

```
container/skills/create-feishu-workspace/
container/skills/daily-report/
container/skills/proposal/
container/skills/skill-creator/
```

决策 74 采纳 upstream 的技能挂载模型之后，`container/skills/` **不再被挂载**（`entrypoint.sh` 改成先清空 `~/.claude/skills` 再从 `/workspace/effective-skills/*/` 重建）。这 4 个技能会**静默失效** —— 目录还在仓库里，容器里看不到。必须一起迁进 `data/builtin-skills/` 或 `~/.claude/skills/`。

---

## 七、静默删除清单

### 7.1 被删的 50 个文件（实测 `git diff --diff-filter=D`）

| 类别 | 数量 | 文件 | 处置 |
|---|---:|---|---|
| **SubAgent 体系** | 4 | `container/agent-runner/src/agent-definitions.ts` · `src/routes/agent-definitions.ts` · `web/src/pages/AgentDefinitionsPage.tsx` · `web/src/stores/agent-definitions.ts` | **放行**。决策 59（自定义 SubAgent 删，从没建过定义）+ 决策 60（预定义 SubAgent 转成定义文件）。但 `PREDEFINED_AGENTS` 在 agent-runner `index.ts` 还有 2 处引用（`:77` import、`:2885` `agents: PREDEFINED_AGENTS`），必须一起改 —— `web-researcher` 用了 61 次，转成定义文件而不是丢掉 |
| **插件属主** | 5 | `src/runtime-owner.ts` · `tests/helpers/legacy-runtime-owner.ts` · `tests/plugin-expander-{mixed-admin-batch,runtime-owner-divergence,web-main-admin-gating}.test.ts` | **放行**（有条件）。§一点五：「当前只有 1 个 admin 无影响；加第二个 admin 才有」。若近期会有第二个 admin，从 HEAD 恢复这 5 个文件 |
| **Prompt** | 3 | `container/agent-runner/prompts/{agent-override,output,skill-routing}.md` | **主动保住 2 个**。`agent-override.md` 和 `skill-routing.md` 仍被 `index.ts` 引用（见 §3.1 H5 专项）。`output.md` 已被 upstream 的三段拆分取代，可放行 |
| **Skills** | 2 | `container/skills/{install-skill,post-test-cleanup}/SKILL.md` | **放行**（决策 74，改走 builtin-skills） |
| **IM 渠道 UI** | 8 | 7 个 `*ChannelCard.tsx`（Feishu/Telegram/QQ/DingTalk/Discord/WeChat/WhatsApp）+ `WeChatQRDialog.tsx` | **放行**（决策 18/3.6：upstream 的统一渠道账号管理页取代 8 个独立卡片）。**但 WhatsApp 的 QR 推送流程（CLAUDE.md §8.13）要确认新页面覆盖了** |
| **聊天面板** | 5 | `AgentTabBar.tsx` · `GroupMembersPanel.tsx` · `TopicSidebar.tsx` · `WorkspaceMcpPanel.tsx` · `WorkspaceSkillsPanel.tsx` | **放行**。§八注明 `AgentTabBar`/`TopicSidebar` 是「merge-base 就有的 upstream 功能、本地一行没改」——消失属于静默回退，不是 fork 特性丢失。`ChatView.tsx` H1 要改用 `SessionSidebar` |
| **其他前端** | 12 | `GroupsPage.tsx` · `stores/workspace-config.ts` · `utils/pwaCache.ts` · `ui/{avatar,collapsible,progress,separator}.tsx` · `components/shared/index.ts` · `public/icons/*.svg`(3) | **`pwaCache.ts` 要主动保住**（决策 64，见 §八.1）。其余放行 —— 但删 `ui/*.tsx` 前 grep 一遍还有没有本地组件在 import |
| **测试** | 1 | `tests/group-queue-initiator.test.ts` | **放行**（决策 55 stop/interrupt 退回 owner-only，这个测试测的就是被删的 initiator ACL） |
| **截图** | 11 | `docs/screenshots/*.png` | **放行**（README 一起重写，决策 88） |

### 7.2 静默消失的 20 个导出符号

```
group_members 族（7）  addGroupMember removeGroupMember getGroupMembers getGroupMemberRole
                       getUserMemberFolders isGroupShared canManageGroupMembers
                       （+ GroupMember 类型 / GroupMemberAddSchema）
runtime-owner 族（5）  resolveAdminSharedRuntimeOwner resolvePerMessageRuntimeOwner
                       resolveLatestAdminSenderOverride
                       RuntimeOwnerCandidateMessage RuntimeOwnerCandidateUser
预定义 SubAgent（1）   PREDEFINED_AGENTS
微信代理（2）          isWeChatBypassingProxy updateWeChatNoProxy
其他（3）              setFeishuTyping invalidateAllowedUserCache ResolveContextFn
```

**实测：合并后仍有引用的只有两个**

| 符号 | 引用点 | 处置 |
|---|---|---|
| `updateWeChatNoProxy` | `src/routes/config.ts:17`（在 H2 冲突块的 HEAD 侧） | 要么从 HEAD 恢复 `src/config.ts` 的三个符号，要么删这个 import 及调用点。**微信代理绕过是本地独有能力，本机若走代理会失效** |
| `PREDEFINED_AGENTS` | `container/agent-runner/src/index.ts:77`（import）、`:2885`（`agents:`） | 决策 60：转成定义文件。改这两处 |

**其余 18 个引用为 0，可放行**，但两个值得单说：

- `setFeishuTyping`：`src/im-manager.ts:1006` 附近还在，但底层 `sendReaction(chatId, isTyping)` 已删（决策 52 跟 upstream 精确记账）。实测引用为 0 说明调用链已断，确认一遍飞书 typing 指示是否还需要。
- `invalidateAllowedUserCache`：upstream 用新模块 `src/group-broadcast-acl.ts` 替换了整套广播 ACL。新实现**只放 owner 一人**（不再展开共享成员）、**没有 invalidate 接口**（只有 10s TTL）。实测 0 个共享工作区（决策 55 的同一依据），可放行；但若将来开共享，广播会漏人。

---

## 八、无冲突但必须主动确认的

这些 **git 不会给你任何标记**，`typecheck` 大多也不会拦。逐项签字。

### 8.1 PWA 离线能力（决策 64 与静默改动直接冲突）

实测合并结果：

```
web/vite.config.ts        274 行 → 48 行，VitePWA 零命中
web/package.json          vite-plugin-pwa 已移除（还移除了 @dnd-kit/* 和 @fontsource-variable/inter）
web/public/sw.js          已落地 —— 一次性自毁迁移脚本
web/src/utils/pwaCache.ts 已删除
```

`sw.js` 的行为：install 立即 `skipWaiting`，activate 时删掉所有 `workbox-*` 和 6 个具名 cache、`registration.unregister()`、然后 `client.navigate()` **强制所有受控标签页重载**。

**决策 64 明写「保本地 —— 纯能力删除无补偿；且不在冲突列表会静默消失」。**

要保就得**四处一起回滚**（vite.config.ts / web/package.json / 删 sw.js / 恢复 pwaCache.ts），并且不引入 `tests/frontend-pwa-retirement.test.ts`（决策 71 说去掉三个契约测试，这是**第四个**，要一并排除）。

不回滚的用户可见后果：已安装 PWA 的用户下次打开会经历一次强制刷新（可能白屏），之后仍可安装、仍全屏，但**完全失去离线能力**，消息历史的 local-first 缓存（50 条 / 1 天 SWR）消失，切对话不再有 0ms 首帧。

### 8.2 `src/capability-runtime-mutation.ts:103` —— 解完 56 个冲突也编译不过

```ts
if (deps) delete deps.sessions[target.folder];   // TS2339
```

`WebDeps.sessions` / `getSessions` 已被本地删除并在 `src/web-context.ts` **自动合并成功**（实测该文件 `sessions` 零命中），但 upstream 的新文件还在用。

这是唯一一处「解冲突也修不掉」的编译断裂。同一根因在 `src/routes/groups.ts` H10/H11 和 `src/commands.ts` H1 各有一处（那两处在冲突块里，看得见）。

**处置**：三处统一 —— 要么恢复 `WebDeps.sessions`，要么把 `capability-runtime-mutation.ts` 改成走 `clearSessionChannelOwner` / `clearSession`。

### 8.3 `web/src/stores/chat.ts` 的 `delivery_status` 重复声明

`Message` 接口里同名字段出现两次（`:62` 本地值域 / `:73` upstream 值域），**没有冲突标记**。TS 报 duplicate identifier。见 §4.6。

### 8.4 `container/agent-runner/src/index.ts` 的三个提示词符号

`OUTPUT_GUIDELINES` 与 `SKILL_ROUTING_GUIDELINES` 的**声明行**被静默替换（不在冲突块内），三处引用还在。`agent-override.md` 文件被删。见 §3.1 H5 专项。

### 8.5 `src/config.ts` 的微信代理三符号

`WECHAT_NO_PROXY_DOMAINS` / `updateWeChatNoProxy` / `isWeChatBypassingProxy` 静默删除，`src/routes/config.ts:17` 仍 import。见 §7.2。

### 8.6 `usage.reasoningTokens` 变必填

`shared/stream-event.ts` 里 `usage.reasoningTokens` 和 `usage.modelUsage[].reasoningTokens` 从可选变必填，改动在冲突块之外。所有 emit usage 的点要补字段。`make typecheck` 会拦。见 §二。

### 8.7 `src/types.ts` 的 `DeliveryStatus` 被 `FollowUpStatus` 静默取代

而 `src/db.ts:15890` 仍导出同名类型。见 §1.5。

### 8.8 常量与阈值的静默改写

| 文件 | 常量 | base | 合并后 | 处置 |
|---|---|---|---|---|
| `feishu-streaming-card.ts` | `MAX_STREAMING_CONTENT` | 100000 | **30000** | 放行（决策 68） |
| `index.ts` | `maxMessageLength`（一处） | 500 | 700 | 放行 |
| `group-queue.ts` | stopGroup force/kill 等待 | 忙等 5000 | `RUNNER_TEARDOWN_TIMEOUT_MS = 15_000` | 放行 |
| `agent-output-parser.ts` | 限流通知长度上限 | 200 | 内联 `> 400` | 放行 |
| `web.ts` | HTTP `requestTimeout` | Node 默认 300s | 600s | 放行 |
| `routes/config.ts` | 批量应用失败状态码 | 207 | 503 | 放行（决策 53 fail-closed） |
| `schemas.ts` | `appName` | `.max(32)` | `.min(1).max(32)` | 放行 |
| `container/Dockerfile` | 基础镜像 | `node:22-slim` | pin digest | **在冲突块里**，见 §九 |
| `package.json` | prettier | `^3.8.1` | `3.8.3` | 放行（决策 5/71） |
| `task-scheduler.ts` | 新增 `MIN_INTERVAL_MS=60_000` / `TASK_RUN_LEASE_MS` / `MAX_CLAIMS_PER_PUMP=32` | — | 新增 | **先普查存量任务**（§5.3 H6） |
| `agent-runner` | 新增 `SDK_FIRST_RESPONSE_TIMEOUT_MS=60_000` / `MAX_TRUNCATION_CONTINUES=2` | — | 新增 | 放行（决策 30 首响应看门狗，且要接上 codex/grok） |
| `provider-pool.ts` | 新增 `DEFAULT_RECOVERY_INTERVAL_MS=300_000` / `UNHEALTHY_THRESHOLD=3` | — | 新增 | 确认没写死按池配置（§5.9） |

**核实过未变，避免误报**：`MAX_RETRIES=5` / `BASE_RETRY_MS=5000` · `CARD_SIZE_LIMIT=25KB` / `MAX_ELEMENTS_PER_CARD=43` · `feishu.ts` 的 `MAX_FILE_SIZE=30MB`。`MAX_RECENT_EVENTS`(20→5) 与 `MAX_THINKING_CHARS`(2000→800) 是本地已改、合并未覆盖。

### 8.9 静默的行为反转（`task-scheduler.ts` / `db.ts` / 前端主题）

这些改动**不在冲突块里**，逐项决定：

| 项 | 合并后行为 | 处置 | 依据 |
|---|---|---|---|
| `createTask` 默认上下文 | `'group'` → `'isolated'` | **改回 `'group'`** | 决策 82（用户直接感知，不该静默改） |
| `triggerTaskNow` 拒绝条件 | `status==='paused'` → `status==='parsing'`（暂停的任务可被手动触发） | **改回拒绝 paused** | 决策 83（那两个任务会真发飞书消息 / 真跑脚本） |
| `computeNextRun` 失败处理 | `return null` → **throw** | 放行，先普查存量 | §5.3 H6 |
| `getDueTasks` | 追加 `deleted_at IS NULL AND (running_until IS NULL OR running_until <= ?)` | 放行 | 决策 20 |
| `getMessagesSince`/`getNewMessagesStmt` | 追加 `delivery_status NOT IN ('queued','promoting','cancelled')` | 放行 | 决策 46 |
| `ensureUserHomeGroup` | 第二个 admin 拿 `home-{userId}`；**不再修补已存在 `web:main` 的 `executionMode`** | 需确认 | 决策 54 周边 |
| interrupt 后重放 | 不重放，依赖 receipt 兜底 | 放行，但 §1.1 组 E 的 H41 必须一起取 | 决策 47 |
| 首屏主题默认 | 跟随系统 → **强制浅色** | **改回跟随系统** | 决策 67（2 行代价） |
| post-result 错误降级判据 | `resultCount > 0` → `durableInputCompletion.isCompleted` | 放行 | 决策 90 |

### 8.10 启动即执行的数据变换

见 §1.2 的 H7 逐段表 + 下列**无条件回填**（不在任何版本门内，也不在冲突块内）：

```
scheduled_tasks.delivery_route_jid = chat_jid                24 行
scheduled_tasks.updated_at = created_at                      24 行
registered_groups.owner_claim_source = 'explicit'            12 行
usage_records.usage_date = date(created_at,'localtime')    7008 行
workspace_agent_profiles.interaction_mode = 'assistant'      35 行
```

另外三项：

- **`PRAGMA foreign_keys = ON` 保持开启**（本地 `foreign_key_check` 干净）。此后往 `messages` 写 `chats` 里不存在的 `chat_jid` 会**直接抛错**而非静默成功。决策 14 跟 upstream。
- **15 秒对账循环**：`index.ts` 无条件 `setInterval(15000)`，无开关无 env 门控，空表下写 5760 条/天日志。决策 75：拉长到 60s + 空转降级（3 行，日志减 96%）。
- **`ensureLegacyDefaultChannelAccount` 顺序陷阱**：`listEnabledChannelAccounts()` 在投影之前返回空 → **启动早期没有任何渠道会连上**，直到 legacy 迁移跑完。7 份配置会被投影（admin 的 discord/wechat/feishu/qq、cxx 的 wechat/feishu、whz 的 wechat）。

### 8.11 容器镜像必须重建

`container/entrypoint.sh` **不在冲突列表里**，但被静默改成：

```
先 find /home/node/.claude/skills -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +   ← 完全清空
再从 /workspace/effective-skills/*/ 重建
```

配合 `container-runner.ts` 的挂载模型变更（从两个整目录只读 → 逐个挂 `/workspace/effective-skills/{skill.id}`）。**两者必须同时生效**，否则旧 entrypoint 找不到 `project-skills`/`user-skills`，容器内 skills 全空。

**必须 `./container/build.sh` 重建镜像**（决策 74，且「去重逻辑必须一起搬」—— 7 个重名技能不去重容器起不来）。

另：admin 的 CLAUDE.md / rules 挂载点也迁了（`/workspace/CLAUDE.md` → `/home/node/.claude/CLAUDE.md`，`/workspace/.claude/rules` → `/home/node/.claude/rules`）。

副作用：**agent 在容器内自建的 skill 现在每次重启都会被清掉。**

### 8.12 `src/whatsapp.ts` 的 import 会静默断裂

这个文件**不在冲突列表里**，但 `package.json` 把 `@whiskeysockets/baileys ^6.17.16` 换成了 `baileys ^7.0.0-rc13`（**换包名 + 主版本 + RC**）。取 upstream 的 package.json 后 `src/whatsapp.ts` 的 import 路径就错了。

决策台账没有直接覆盖这一项。`upstream-silent-changes.md` §十一提示：RC 版本意味着 WhatsApp 通道会跑在未正式发布的主版本上。**要么改 import 跟进，要么在 package.json 里保 `@whiskeysockets/baileys`。**

### 8.13 门禁会红的（合并后立刻）

| 门禁 | 失败原因 | 处置 |
|---|---|---|
| CI `npm ci` ×3 | `.gitignore:34-37` 忽略三个 lockfile | 决策 70：不提交 lockfile，CI 改成不锁版本安装 |
| `npm run docs:check` | 实测 39 条（CLAUDE.md 19 条路径失效 + `docs/API.md` 未索引 19 个路由模块） | 决策 87：阶段 6.1 重写 |
| `tests/reproducible-build-contract.test.ts` | 三条断言全挂 | 决策 71：不引入 |
| `tests/makefile-runtime-contract.test.ts` | 禁 pm2 / `_start-direct` / `PM2_GUARD` | 决策 71：不引入（但决策 72 要删 pm2，可考虑保留这个测试） |
| `tests/builtin-skill-bootstrap-contract.test.ts` | 本地无 `_ensure-builtin-skills` 等 | 决策 71：不引入 |
| `tests/frontend-pwa-retirement.test.ts` | 与决策 64 直接冲突 | **不引入**（§8.1） |
| `npm run format:check` | 语义改成 `scripts/check-format-changed.mjs`，范围扩到 12 种扩展名 | 决策 5：先跑 upstream 版格式化再合并 |
| `scripts/check-agent-runner-prompts.sh` | 变严：`src/` 里每个 `.md` 字面量必须被 4 个 pattern 之一捕获或在白名单里 | 与 §3.1 H5 的 prompt 处置一起解决 |

### 8.14 `make start` 会覆盖 builtin-skills

Makefile 新增 `_ensure-builtin-skills`：先 `builtin-skill-catalog.mjs validate data/builtin-skills`，失败就跑 `install-host-tools.sh skills`。

**实测本地验证失败**（有 8+ 个 skill 目录但**没有 `.catalog.json` marker**）→ **每次 `make start` 都会 curl 下载 feishu-cli tarball 并整体替换 `data/builtin-skills/`**，自定义改动被覆盖。

决策 74 要这个机制，但**先给 `data/builtin-skills/` 补上 marker**。

---

## 九、构建与依赖

### 9.1 `container/agent-runner/package.json` — 1 块

```
HEAD:      "@agentclientprotocol/sdk": "^1.0.0", "@anthropic-ai/claude-agent-sdk": "*",
           "@anthropic-ai/claude-code": "*", "@modelcontextprotocol/sdk": "^1.29.0",
           "@openai/codex": "^0.125.0", "@openai/codex-sdk": "*",
upstream:  "@anthropic-ai/claude-agent-sdk": "0.3.205", "@anthropic-ai/claude-code": "2.1.205",
           "agent-browser": "0.27.0",
```

**处置**：
- **保本地 `"*"`**（决策 69 SDK 保持最新 + 决策 70 lockfile 不提交）
- **加 upstream 的 `agent-browser` 依赖项**（决策 74：从全局装改成本地依赖）
- **删 `@openai/codex-sdk`**（决策 38：不留，切 CLI）
- **`@openai/codex` 从 `^0.125.0` 改成 `*`**（决策 39：四月旧构建被 XProtect 删，违反「始终最新」；这一步在**阶段 0.3**，合并前就要做）
- 保 `@agentclientprotocol/sdk` 和 `@modelcontextprotocol/sdk`（决策 21 / §8.14）

### 9.2 `package.json` — 1 块

同上策略，另外：

| 依赖 | 变化 | 处置 |
|---|---|---|
| `@whiskeysockets/baileys ^6.17.16` | → `baileys ^7.0.0-rc13` | 见 §8.12，与 `src/whatsapp.ts` 一起定 |
| `better-sqlite3 ^11.8.1` | → `^12.10.0` | 放行（台账 `9262274` ✅ 已采纳） |
| `hono ^4.11.9` | → `^4.12.25` | 放行 |
| `undici 6.27.0` · `adm-zip` · `overrides:{libsignal:"6.0.0"}` | 新增 | 加（`adm-zip` 是决策 58 Skill 从 zip 导入的依赖） |
| `@hapi/boom` | 本地独有 | 保 |
| `@openai/codex` / `@openai/codex-sdk` | 本地独有 | 同 §9.1 |

### 9.3 `container/Dockerfile` — 1 块

```
HEAD:      COPY agent-runner/package.json ./
           ARG CACHEBUST=1
           RUN npm install -g agent-browser …
upstream:  COPY agent-runner/package.json agent-runner/package-lock.json ./
           RUN npm ci …
```

→ **保本地**（决策 70 lockfile 不提交 + 决策 69 SDK 保持最新）。

**好消息（实测）**：装 grok CLI 的三行（`RUN npm install -g @xai-official/grok@0.2.67 && grok --version`）**不在冲突区**，自动保留。基础镜像的 digest pin 也在这一块，跟着本地的选择走。

**但**：§8.11 的 entrypoint.sh 变更是无冲突静默采纳的 —— Dockerfile 保本地不等于技能挂载模型没变。**合并后必须 `./container/build.sh`。**

### 9.4 `Makefile` — 6 块

| # | 行 | 争什么 | 取哪侧 |
|---|---|---|---|
| H1 | 3 | `.PHONY` 列表 | 并集减 pm2 相关（决策 72）+ 加 `_ensure-builtin-skills`（决策 74） |
| H2 | 21 | `CONTAINER_IMAGE ?=`（本地）vs `export WEB_PORT := $(PORT)`（upstream） | **两边都要** |
| H3 | 63 | `start` 目标：本地含 pm2 路由 + `ensure-latest-sdk`；upstream 纯前台 + 注释「生产启动不得隐式改写依赖图」 | **取 upstream 的前台形态，保本地的 `ensure-latest-sdk` 前置**（决策 72 删 pm2 + 决策 69 SDK 最新） |
| H4 | 207 | `DOCKER_SRC` | 取 upstream 的多行形式，**去掉 `package-lock.json`**（决策 70） |
| H5 | 257 | `update-codex-sdk`（本地）vs `ensure-latest-sdk`（upstream） | **两个目标都要**（决策 39） |
| H6 | 274 | `ensure-latest-sdk` 实现：本地自动更新并把版本回写成 `"*"`；upstream 只读检查 | **保本地**（决策 69 + F6 SDK 更新门禁） |

---

## 十、文档与测试

### 10.1 `CLAUDE.md` — 11 块 · 全取 upstream（骨架）

11 个块全是「两份互不相干的文档」—— 本地是详尽的模块表 / 表结构 / WS 协议表，upstream 是 349 行 Agent-first 骨架。逐块手解没有意义。

**处置**：
```bash
git checkout --theirs CLAUDE.md
```
然后作为**阶段 6.1 的独立工作**重写（决策 87：采纳 349 行骨架 + 检查脚本）。

**陷阱**：直接用 upstream 骨架会从「过时」变成「虚构」—— 里面的 Agent Profile 层级、四段 Prompt、`always`/`when_mentioned` 都是本地没有或已砍的。合并 commit 允许 `docs:check` 红，但**阶段 6.1 完成前不能合进 main**。

### 10.2 `README.md` — 1 块 · 全取 upstream

本地 87 行端口/命令表 vs upstream 1 行「只用 npm 不用 bun」。同 CLAUDE.md，`--theirs` 后放到阶段 6.2（决策 88：取 upstream 再按本地删改）。

### 10.3 `config/global-claude-md.template.md` — 1 块 · 全取本地

本地 75 行（子代理模式约定等），**upstream 侧为空**（它删了这段）。

→ **保本地**（决策 89 人格 + 决策 60 预定义 SubAgent 转定义文件）。

**陷阱**：取 upstream 会让所有新工作区的全局 CLAUDE.md 少掉子代理约定，**不报错**。这个模板只在建工作区时读一次，问题要几周后才浮现。

### 10.4 `container/skills/agent-browser/SKILL.md`

见 §6.3。

### 10.5 add/add 冲突（3 个）

| 文件 | 本地 | upstream | 处置 | 依据 |
|---|---:|---:|---|---|
| `src/feishu-capability.ts` | 211 行，4 个导出（`FeishuCapabilityClient` / `FeishuCapabilityRequest` / `FeishuCapabilityResult` / `runFeishuCapability`） | 604 行，6 个导出（`FeishuCapabilityOperation` / `DefinitiveFeishuCapabilityError` / `isFeishuCapabilityMutation` / `executeFeishuCapability` …） | **`--ours`**，但吸收 upstream 的 `DefinitiveFeishuCapabilityError` 和 `isFeishuCapabilityMutation`（幂等判定有价值） | 决策 25：upstream 版硬依赖只有 Claude 常驻进程能写的字段，Codex/Grok 每次调用必抛 |
| `tests/feishu-capability.test.ts` | 271 行 | 338 行 | **`--ours`**（跟随上面） | 同上 |
| `tests/agent-profiles-db.test.ts` | 283 行 | 609 行 | **`--theirs`** 后砍掉 Builder 相关断言 | 决策 56（只要核心 2400 行）+ 决策 57（Builder 砍） |

### 10.6 `tests/feishu-card.test.ts` — 2 块

- **H1**（376）：`header.template` 断言。本地「反映 CardStatus 且省略 icon」；upstream「显式 title 才渲染 header.template」。→ **保本地**（与 `builder.ts` H1 同侧）。
- **H2**（795）：骨架元素 ID 集合。本地「runtime panels + MAIN_CONTENT + BUTTON + FOOTER_NOTE」；upstream 加 `STATUS_BANNER` + invisible ASK slot。→ **取 upstream 的 `STATUS_BANNER`**（与 `sections.ts` H3 同侧），ASK slot 按 §5.15 H3 的决定调整。

### 10.7 `tests/feishu-thread-routing.test.ts` — 1 块

本地是一条 `test.skip`，注释写着：

> merge §7.2: trace link 为上游引入未启用特性。决策 1 以本地外观为基线，终态卡用 metaRow 取代 footer，不渲染 trace footer（`setTraceUrl`/`traceFooterLink` 暂留为死代码）。若后续采纳 trace 特性，移除 `.skip` 并在 `builder.ts` 接 trace footer。

upstream 侧是另一条完全不同的测试（`retries a card reply without reply_in_thread only for unsupported thread errors`）。

→ **两条都要**：保本地的 `.skip`（它是上一轮合并的决策记录），加 upstream 的 thread 重试测试。

---

## 十一、建议的解冲突顺序

按「解错代价 × 发现难度」排，从高到低：

| 批次 | 文件 | 理由 |
|---|---|---|
| **前置**（合并前） | provider 配置版本号推到 5 · codex 依赖 `^0.125.0`→`*` · 数据库副本跑完整迁移 · resolver 补 mount 分支 | 阶段 0.2/0.3/0.5 + 决策 16。前两项防凭据销毁与 CLI 不可用，后两项防 8 会话失联 |
| **1** | `shared/stream-event.ts` → `make sync-types` | 一次解一份，避免四份不一致 |
| **2** | `src/db.ts` H2 / H7 | 决定启动跑哪些数据变换 |
| **3** | `src/types.ts` + `src/db.ts` H16/H17 + `web/src/stores/chat.ts` + `MessageBubble.tsx` | `delivery_status` 语义撞车，四处必须一次改齐 |
| **4** | `src/container-runner.ts` + `container/agent-runner/src/{index,mcp-tools,types}.ts` | 多运行时命脉；`mcp-tools.ts` H15/H16 的 `defineTool` 陷阱最隐蔽 |
| **5** | `src/index.ts` 75 块 | 从文件末尾往前解 |
| **6** | `src/feishu*.ts` + `src/feishu-cards/*` + 卡片测试 | 本地外观为基线，成组解 |
| **7** | 前端 6 个文件 | 解完立刻起前端肉眼确认三处（静默杀手 #6） |
| **8** | 构建与依赖（package.json ×2 / Dockerfile / Makefile） | 然后 `./container/build.sh` |
| **9** | modify/delete 3 个 + 静默删除清单逐项签字 | |
| **10** | `CLAUDE.md` / `README.md` `--theirs` 占位 | 阶段 6.1/6.2 重写 |

解完之后，`upstream-merge-plan.md` §2.4 的六个静默杀手逐项签字，再跑 §5.2 回归矩阵。

---

## 附：可以整文件解的 7 个

只有这些文件用 `--ours` / `--theirs` 是安全的。**其余 49 个一律逐块。**

| 文件 | 解法 |
|---|---|
| `CLAUDE.md` | `--theirs`（占位，阶段 6.1 重写） |
| `README.md` | `--theirs`（占位，阶段 6.2 重写） |
| `config/global-claude-md.template.md` | `--ours` |
| `src/feishu-capability.ts` | `--ours` |
| `tests/feishu-capability.test.ts` | `--ours` |
| `src/stream-event.types.ts` / `web/src/stream-event.types.ts` / `container/agent-runner/src/stream-event.types.ts` | `--ours` 占位后 `make sync-types` 覆盖 |
| `web/src/components/settings/ProviderEditor.tsx` | `--ours` |
