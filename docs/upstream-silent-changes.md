# 静默变更完整清单

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 方法：6 个 subagent 逐文件读源码；其中 3 个在独立 worktree 实跑 `git merge` + `tsc --noEmit`
> 生成：2026-07-25

**"静默"的定义**：git 合并时**不产生冲突标记**、review 时看不见的改动。分四类：

| 类 | 机制 | 危险度 |
|---|---|---|
| **A 静默删除** | upstream 删了某段，本地没改过那些行 → git 判"一侧删除一侧未动"，干净采纳删除 | 高 |
| **B 静默采纳** | 本地零改动的文件，upstream 的全部改动直接落地 | 中高 |
| **C 静默注入** | 374 个新增文件干净落地后**自动开始做事** | 高 |
| **D 半静默** | 双改文件里，两边改了不同区域 → 冲突之外的部分静默取 upstream | 中 |

规模：562 个文件本地零改动（143 在 `src/`）· 74 个双改 · 静默 hunk 数 db.ts 90 / index.ts 211 / group-queue.ts 49 / agent-runner index.ts 77 / web.ts 69 / feishu.ts 45 / task-scheduler.ts 38 / container-runner.ts 34

---

## 一、会让线上直接哑掉的（最高优先级）

### 1.1 8 个现有会话失联 —— fail-closed 路由

```
本地 index.ts:10018   无绑定 → return null
本地 index.ts:10241   resolver 无条件传给全部 7 个渠道
upstream channel-admission.ts:129   resolver 返回 null → 返回 null
upstream qq.ts:1592 等              if (!resolvedRoute) { warn; return; }   ← 丢消息
```

**现在**：`agentRouting?.effectiveJid ?? jid` —— null 回落到聊天自己的 jid，正常处理。
**合并后**：丢弃，只留一条 warn。

受影响（实测，8 个无绑定 IM 会话）：

| jid | 属于 |
|---|---|
| `feishu:oc_0989ee…` 私聊 · `qq:c2c:557765EB…` | admin |
| `feishu:oc_2f1428…` 私聊 · `feishu:oc_9b0558…` 群 · `feishu:oc_923f95…` 群 · `wechat:o9cq80zW…` | **cxx** |
| `wechat:o9cq802M…` | **whz** |
| `wechat:o9cq8089…` | wechat folder |

**两个 member 用户会被完全切断。** upstream 自己不出问题是因为它的 resolver 有 `getChannelMount()` 兜底分支 —— 本地 `index.ts` 零命中，那 21 条 mount 数据是没有读路径的孤儿。

**前置条件**：采纳 fail-closed 路由前，必须给本地 resolver 补 mount 查询分支，或先补全这 8 个绑定。

### 1.2 三个渠道的自动注册永久失效

upstream 把 `onNewChat` 挪到路由解析**之后**（discord `:539` / whatsapp `:843` / dingtalk `:1551`）。本地给这三个渠道没传 `isChatAuthorized`、没传 `onPairAttempt`：

```
admission 放行 → resolver 查不到 group → null → return → onNewChat 永不被调用
```

把 bot 拉进新钉钉群 / Discord 频道 / WhatsApp 群：**发消息毫无反应，侧边栏也不冒新会话**。CLAUDE.md §8.2 对这三个渠道失效。

telegram / qq 不受影响（本地传了配对回调），但注册后仍可能落回 1.1。

### 1.3 host 并发闸静默失效，且设置项变成哑的

`hasCapacityFor` 对 host 模式直接 `return true`（**静默**）。而 `maxConcurrentHostProcesses` 在 `schemas.ts`、`runtime-config.ts`、设置页表单**全部保留** —— 用户还能改这个数字，但它不再是准入门，`activeHostProcessCount` 只剩计数展示。

最坏的形态：**设置存在、可修改、完全无效**。

> 补充事实：本地这个闸当前的行为也有问题。`activeHostProcessCount--` 在 `runForGroup` 的 finally，而那个 finally 同时做 `state.process = null` + `onContainerExitFn` —— 是**进程退出**路径。Claude 运行时常驻，两轮之间不退出，所以槽位在暖进程空闲期间一直被占，直到 IDLE_TIMEOUT。upstream 注释描述的正是这个（"warm, idle sessions block unrelated Feishu topics for up to IDLE_TIMEOUT"），并配了回归测试。
>
> 本地当前 37 个 host 工作区 / 27 个 container。正确解法是第三种：把计数从"活着的进程"改成"进行中的轮次"。

### 1.4 唯一解冲突也修不掉的编译断裂

```
src/capability-runtime-mutation.ts:103   deps.sessions   → TS2339
```

`web-context.ts` 自动合并成功、本地删除（`WebDeps.sessions` / `getSessions`）胜出，但 upstream 新文件还在用。**56 个冲突全解完也不会修好。**

（实测 `tsc --noEmit` 报 309 条错，其余全是冲突文件按 `--ours` 解才炸的假警报，取 upstream 侧即消失。）

---

## 二、启动即执行的数据变换（C 类）

### 2.1 无条件、每次启动都跑

upstream `db.ts:2204-2207` 四行连在一起，不在任何版本门内：

| 操作 | 落在冲突区？ | 对本地库 |
|---|---|---|
| `DROP TABLE IF EXISTS group_members` | **是**（2667–3420 upstream 侧，人会看到） | 删表 + 32 行 |
| `backfillAgentProfileDefaultsAndWorkspaceMappings()` | 静默 | 建 **3 条** `agent_profiles` + **~35 条** `workspace_agent_profiles` |
| `removeLegacyAgentToolPolicies()` | 静默 | 0 行（新建的 3 条不含 tools 键） |
| `reconcileCanonicalRuntimeProjections()` | 静默 | ↓ |

`reconcileCanonicalRuntimeProjections()` 内部（实测套本地数据）：

```sql
DELETE FROM workspaces WHERE NOT EXISTS (…rg.jid LIKE 'web:%')     → 64 行删掉 29 行
syncAllChannelMountsFromRegisteredGroups():
    DELETE FROM channel_mounts
    DELETE FROM agent_channel_mounts                                → 21 行全删
    再从 registered_groups 逐条重建（upstream 的 10 列形态）
DELETE FROM workspace_agent_profiles WHERE 无对应 workspace
```

本地 `agent_channel_mounts` 是 13 列（多 `agent_profile_id` / `owner_user_id` / `workspace_folder`），重建后这三列的值取决于 upstream 的 sync 实现 —— 它的模型里没有这三列。

**注意**：即使在冲突里选保留 `group_members` 数据，六个访问函数 + CREATE TABLE + backfill + `deleteGroupData` 里的 DELETE **全部静默删除**。表在、数据在、没有任何代码能读。

### 2.2 版本门触发的一次性迁移（45 < 阈值 → 全跑）

| 阈值 | 对本地库 |
|---|---|
| `< 51` | `INSERT OR IGNORE INTO usage_events` **全量复制 7008 行**（数据翻倍）；`user_id='system'` 的 16 行按 group_folder 反查改写归属；`event_id = 'legacy:'||id` 全填 |
| `< 58` | `UPDATE registered_groups SET audience_mode='owner_only' WHERE jid LIKE 'feishu:%' AND sender_allowlist IS NOT NULL` → **10 个飞书会话被设为 owner_only**。upstream 注释自承："一次性语义迁移，重放会覆盖用户后来的显式选择" |
| `< 62` | `workspace_agent_profiles` 表重建 + 加 `interaction_mode` 列与 CHECK。本地 0 行，只是结构变更 |
| `< 39` / `< 17` / `< 22` / `< 24` | 45 ≥ 阈值 → 跳过 |

### 2.3 其他无条件回填

```
scheduled_tasks.delivery_route_jid = chat_jid              24 行
scheduled_tasks.updated_at = created_at                    24 行
registered_groups.owner_claim_source = 'explicit'          12 行（owner_im_id 非空的）
usage_records.usage_date = date(created_at,'localtime')    7008 行
workspace_agent_profiles.interaction_mode = 'assistant'    35 行（紧跟 2.1 新建的）
```

### 2.4 `PRAGMA foreign_keys = ON` 保持开启

本地当前 `foreign_key_check` 干净（0 违规）→ FK 强制会保持 ON。此后往 `messages` 写 `chats` 里不存在的 `chat_jid` 会**直接抛错**，而不是像现在静默成功。带 FK 的表：`messages` / `task_run_logs` / `invite_codes` / `user_sessions` / `user_subscriptions` / `user_balances`。

### 2.5 备份磁盘炸弹

`enforcePreMigrationBackup` 触发条件 `schemaVersion >= 39 && < 63`。本地 45 → **每次启动只要没升到 63 就建一次**。

```
方式：VACUUM INTO      messages.db 147 MB → 每份约 130 MB
目录：data/db/migration-backups/     （与现有 data/db/backups/ 是两个目录）
文件名带 pid + 毫秒时间戳，不覆盖
失败即中止启动，且【没有 env override】
    （本地现有的 HAPPYCLAW_ALLOW_DB_MIGRATION_WITHOUT_BACKUP 在 upstream 不存在）
```

关键在顺序：**`schema_version` 写在 `runMigrations` 最后一行，备份在最前**。中间任何一步抛异常（v62 表重建 / v51 的 7008 行插入 / 那句 DROP），版本号停在 45 → 下次重启再建一个 130 MB。

**N 次失败重启 = N × 130 MB**。没有 GC、没有保留策略、`make clean` 不覆盖。现有 `data/db/backups/` 已占 **1.2 GB**（15 个文件），upstream 也不会清。

### 2.6 关不掉的 15 秒循环

`index.ts:19488` 无条件 `setInterval(15000)` 跑 channel reliability 恢复 —— 没有 SystemSettings 开关、没有 env 门控、没有条件分支。

空表下 no-op，但写 **5760 条/天**的 `Channel reliability reconciliation completed`。

另：`cleanupChannelReliability()` **生产代码零调用**（只有测试调）。`channel_inbox` / `channel_outbox` / `turn_runs` / `streaming_cards` / `channel_cursors` 五张表**只增不删**。

### 2.7 启动时的 legacy IM 配置投影

`ensureLegacyDefaultChannelAccount` 把 `data/config/user-im/{userId}/{channel}.json` 投影成 `channel_accounts` 行，凭据重新加密，并**回填 `registered_groups.channel_account_id`**。

本地会被投影的 7 份配置：admin 的 discord/wechat/feishu/qq、cxx 的 wechat/feishu、whz 的 wechat。

**顺序陷阱**：`listEnabledChannelAccounts()` 在投影之前返回空 → 启动早期**没有任何渠道会连上**，直到 legacy 迁移跑完。

---

## 三、静默的行为反转

| 项 | base | 合并后 | 影响 |
|---|---|---|---|
| **`createTask` 默认上下文** | `context_mode \|\| 'group'` | `\|\| 'isolated'` | 新建任务默认从"共享工作区上下文"变成"隔离" |
| **`computeNextRun` 失败处理** | interval ≤ 0 → `return null` | `< MIN_INTERVAL_MS(60s)` → **throw** | 存量秒级/亚分钟任务下次算 next_run 时抛错，走 missed+pause 路径 |
| **`triggerTaskNow` 的拒绝条件** | `status === 'paused'` 拒绝 | `status === 'parsing'` 拒绝 | **暂停的任务现在可以被手动触发** |
| **`getDueTasks`** | `status='active' AND next_run<=?` | 追加 `deleted_at IS NULL AND (running_until IS NULL OR running_until <= ?)` | 持租约任务不再被拉出 |
| **`getMessagesSince` / `getNewMessagesStmt`** | 无过滤 | 追加 `AND COALESCE(delivery_status,'') NOT IN ('queued','promoting','cancelled')` | 被标这三态的消息主循环不再拉取（本地值域是 pending/sent/failed/skipped，暂不命中，但见 §五） |
| **`ensureUserHomeGroup`** | admin 固定 `web:main`，已存在则复用并修补 `executionMode='host'` | `useLegacyMain = isAdmin && (!existingMain \|\| !existingMain.created_by)` | 第二个 admin 注册拿到 `home-{userId}`；**不再修补已存在 web:main 的 executionMode** |
| **interrupt 后的重放** | `pipedMessagesDuringQuery` 全部写回重放 | 当前 turn 已被 `cancelCurrentTurn()` 移除，**不重放**；只回放之后已接受未出结果的 turn | 被中断的那条用户输入不再自动重跑，依赖 receipt 机制兜底 |
| **首屏主题默认** | 无 localStorage key → 跟随系统 | 无 key → **强制浅色** | 系统深色 + 从没设过主题的用户，升级后界面变亮 |
| **post-result 错误降级判据** | `if (resultCount > 0)` | `if (durableInputCompletion.isCompleted)` | 注释：resultCount 含被 background debt 暂扣的边界，当"已成功发射"会吞掉恢复信号 |

---

## 四、静默撤销的本地修复

| 本地修复 | 命运 |
|---|---|
| **F1**（后台子 Agent 不被 5s 关流杀死，`b01ec47`） | `pendingSdkTasks` / `getPendingSdkTaskCount` 在合并后的 `stream-processor.ts` 中**存活**；但 `POST_RESULT_TIMEOUT_MS` 的两处判定落在**冲突区 2321–2359**，选 upstream 侧即撤销 |
| **F3**（重置/中断不跨工作区误杀，`85b8496`） | ✅ **存活**（`getJidsExecutingInFolder` 等计数一致） |
| **F5**（飞书日志瘦身，`7070477`） | ✅ **存活**（`describeFeishuError` 5 处） |
| **queryRef 类型放宽**（`a5dc230`，修 SDK 0.3.215 typecheck） | 冲突区 2130–2139，选 upstream 侧会**重新引入已修复的门禁失败** |
| **per-message 插件运行时属主**（#23 round-15 P2-2） | ❌ **静默撤销**。两处 `resolveCtxForMsg` 替换回整批共用 `fallbackExpandCtx(group.created_by)`，`src/runtime-owner.ts` 整个文件静默删除，3 个对应测试一并删除 |
| **`loadState()` 的 lastCommittedCursor 迁移** | ❌ **静默删除**。upstream 注释："不从 next-pull 合成 committed 游标……legacy 装机可能从 EMPTY_CURSOR 重放一次，at-least-once 是有意的安全取舍"。实测本地两张游标表各 69 key、**缺口为 0**，本次升级不触发全量重放，但保护网没了 |
| **`currentRunInitiator`**（stop/interrupt 的 owner-OR-initiator ACL） | ❌ 字段与 `getActiveRunInitiator()` 静默删除，退回 owner-only。但 `state.currentRunInitiator = null` 的赋值残留在**冲突区 HEAD 侧** → 按 HEAD 解会引用已删字段，typecheck 失败 |
| **隔离任务 IPC 目录清理** | ❌ 静默删除（`fs.rmSync(data/ipc/{folder}/tasks-run/{taskRunId})`，-16 行）→ `tasks-run/` 累积残留 |
| **`disableMemoryLayer` 开关** | ❌ 主进程侧注入被**静默整块删除**（`hostEnv['HAPPYCLAW_DISABLE_MEMORY_LAYER']`、`REQUIRED_SETTINGS_ENV` 逐项注入、`HAPPYCLAW_USER_MCP_SERVERS_JSON`、计算本身）。设置项在 `schemas.ts`/`runtime-config.ts` 仍在但**无消费方**，开关变哑。同 hunk 里 `SUBAGENT_MODEL` 注入也被删 |
| **微信代理绕过** | ❌ `WECHAT_NO_PROXY_DOMAINS` / `updateWeChatNoProxy()` / `isWeChatBypassingProxy()` 静默删除，本地 `index.ts:20,10597` 和 `routes/config.ts:11,3657` 仍引用 → 编译断裂 |
| **飞书 typing 指示** | ❌ `sendReaction(chatId, isTyping)` 整个方法静默删除（OnIt 表情），`im-manager.ts:1006` 的 `setFeishuTyping()` 仍在但底层没了 |

---

## 五、`delivery_status` 语义撞车

**同名、不同义、不同值域、复用同一批列**：

| | 本地 | upstream |
|---|---|---|
| 值域 | `pending` / `sent` / `failed` / `skipped` | `queued` / `promoting` / `released` / `cancelled` |
| 含义 | agent 回复**有没有送达 IM** | 用户消息在 **follow-up 队列**里的位置 |
| 渲染 | `MessageBubble` 红色「未送达」角标 | `MessageInput` 队列卡片 |
| 后端 | `setMessageDeliveryState` / `getStalePendingDeliveries` | follow-up 队列状态机 |

共用 `delivery_status` / `delivery_mode` / `delivery_run_id` / `delivery_priority` / `delivery_updated_at` 五列。

跟 upstream：本地角标判断永不命中（不误报，但「未送达」提示消失）。两边都留：TS 在 union 上报错，后端两套写入互相覆盖同一列。

---

## 六、门禁会红的（合并后立刻）

| 门禁 | 失败原因 |
|---|---|
| **CI `npm ci` ×3** | 本地 `.gitignore:34-37` 忽略三个 lockfile，`npm ci` 要求 lockfile 存在 → **第一步就失败** |
| **`npm run docs:check`**（新挂到 `make typecheck`） | 实测 **39 条**：CLAUDE.md 19 条路径失效（其中 §11 测试表 17 条指向不存在的 `tests/units/`）+ `docs/API.md` 未索引 19 个路由模块 |
| `tests/reproducible-build-contract.test.ts` | 三条断言全挂：lockfile 不得 gitignore（本地忽略）· `install:` 必须 `npm ci`（本地 `npm install`）· Dockerfile 必须 pin digest / 禁 `npm install -g` / 禁 `releases/latest` / build.sh 禁 `CACHEBUST`（本地全中） |
| `tests/makefile-runtime-contract.test.ts` | 禁 `pm2` / `_start-direct` / `PM2_GUARD`（本地全有）+ 要求多个本地没有的 target |
| `tests/builtin-skill-bootstrap-contract.test.ts` | 要求 Makefile 含 `_ensure-builtin-skills` / `install-host-tools.sh skills` / `builtin-skill-catalog.mjs validate`（本地一处都没有）；要求 `entrypoint.sh` 含 `/workspace/effective-skills`（本地 grep = 0） |
| `tests/frontend-pwa-retirement.test.ts` | 要求 `vite.config.ts` 无 VitePWA、devDeps 无 `vite-plugin-pwa`、存在 `web/public/sw.js` 自毁 worker |
| `npm run format:check` | 语义从 `prettier --check "src/**/*.ts"` 改成 `scripts/check-format-changed.mjs`，范围扩到 12 种扩展名（含 `.md`/`.json`/`.yml`）。合并 commit 后基线集 = 全部 380+ 改动文件 |
| `check-agent-runner-prompts.sh` | 变严：`src/` 里每个 `.md` 字面量必须被 4 个 pattern 之一捕获或在白名单里 |

### `make start` 会覆盖 builtin-skills

Makefile 新增 `_ensure-builtin-skills`：先 `builtin-skill-catalog.mjs validate data/builtin-skills`，失败就跑 `install-host-tools.sh skills`。

**实测本地验证失败**（有 8+ 个 skill 目录但**没有 `.catalog.json` marker**）→ **每次 `make start` 都会 curl 下载 feishu-cli tarball 并整体替换 `data/builtin-skills/`**，自定义改动被覆盖。

---

## 七、Skills 挂载模型变更（必须重建镜像）

| | base | 合并后 |
|---|---|---|
| 挂载 | `projectSkillsDir → /workspace/project-skills` + `userSkillsDir → /workspace/user-skills`（两个整目录只读） | 遍历 `claudeContextPlan.effectiveSkills.selected`，逐个挂 `/workspace/effective-skills/{skill.id}`（`source==='plugin'` 跳过） |
| `entrypoint.sh` | 遍历 4 个目录建符号链接，**保留 agent 自建的 skill** | 先 `find /home/node/.claude/skills -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +` **完全清空**，再从 `/workspace/effective-skills/*/` 重建 |

两者必须同时生效，**必须 `./container/build.sh` 重建镜像**；否则旧 entrypoint 找不到 `project-skills` / `user-skills`，容器内 skills 全空。

另：**agent 在容器内自建的 skill 现在每次重启都会被清掉**。

admin 的 CLAUDE.md / rules 挂载点也迁了：`/workspace/CLAUDE.md` → `/home/node/.claude/CLAUDE.md`，`/workspace/.claude/rules` → `/home/node/.claude/rules`。

---

## 八、静默删除的文件（51 个，git 只对 2 个报 modify/delete）

| 类别 | 文件 |
|---|---|
| **SubAgent 体系** | `container/agent-runner/src/agent-definitions.ts`（预定义 code-reviewer / web-researcher）· `src/routes/agent-definitions.ts` · `web/src/pages/AgentDefinitionsPage.tsx` · `web/src/stores/agent-definitions.ts` |
| **插件属主** | `src/runtime-owner.ts` · `tests/helpers/legacy-runtime-owner.ts` · `tests/plugin-expander-{mixed-admin-batch,runtime-owner-divergence,web-main-admin-gating}.test.ts` |
| **Skills** | `container/skills/install-skill/SKILL.md` · `container/skills/post-test-cleanup/SKILL.md` |
| **Prompt** | `container/agent-runner/prompts/{agent-override,output,skill-routing}.md` ← 本地 `index.ts` 仍在 load，`check-agent-runner-prompts.sh` 会挂 |
| **IM 渠道配置 UI** | 7 个 `*ChannelCard.tsx`（Feishu/Telegram/QQ/DingTalk/Discord/WeChat/WhatsApp）+ `WeChatQRDialog.tsx` |
| **聊天面板** | `AgentTabBar.tsx` · `GroupMembersPanel.tsx` · `TopicSidebar.tsx` · `WorkspaceMcpPanel.tsx` · `WorkspaceSkillsPanel.tsx` |
| **其他前端** | `GroupsPage.tsx` · `stores/workspace-config.ts` · `utils/pwaCache.ts` · `ui/{avatar,collapsible,progress,separator}.tsx` · `components/shared/index.ts` · `public/icons/*.svg` |
| **测试** | `tests/group-queue-initiator.test.ts` |

git 只对这两个报 modify/delete（本地有改动）：`web/src/components/groups/GroupCard.tsx`（+16/-1，执行模式徽章）· `GroupDetail.tsx`（+96/-1，执行模式切换器）。

**注意**：`AgentTabBar` / `TopicSidebar` / `AgentDefinitionsPage` 是 merge-base 就有的 upstream 功能、本地一行没改 —— 消失属于**静默回退**，不是 fork 特性丢失。

---

## 九、静默消失的导出符号（20 个）

```
group_members 族（7）  addGroupMember removeGroupMember getGroupMembers
                       getGroupMemberRole getUserMemberFolders isGroupShared
                       canManageGroupMembers  (+ GroupMember / GroupMemberAddSchema)
runtime-owner 族（5）  resolveAdminSharedRuntimeOwner resolvePerMessageRuntimeOwner
                       resolveLatestAdminSenderOverride
                       RuntimeOwnerCandidateMessage RuntimeOwnerCandidateUser
预定义 SubAgent（1）   PREDEFINED_AGENTS
微信代理（2）          isWeChatBypassingProxy updateWeChatNoProxy
其他（3）              setFeishuTyping invalidateAllowedUserCache ResolveContextFn
```

`invalidateAllowedUserCache` 值得单说：upstream 用新模块 `src/group-broadcast-acl.ts` 替换了整套广播 ACL，新实现**只放 owner 一人**（不再展开共享成员）、**没有 invalidate 接口**（只有 10s TTL）。本地 `routes/groups.ts:1689` 和 `:1730` 两处调用失去目标。

---

## 十、常量与阈值静默变化

### 数值改写

| 文件 | 常量 | base | 合并后 |
|---|---|---|---|
| `feishu-streaming-card.ts` | `MAX_STREAMING_CONTENT` | `100000` | **`30000`** |
| `index.ts` | `maxMessageLength`（一处） | `500` | `700` |
| `group-queue.ts` | stopGroup force / kill 等待 | 忙等 `5000` | `RUNNER_TEARDOWN_TIMEOUT_MS = 15_000` |
| `agent-output-parser.ts` | 限流通知长度上限 | `200` | 常量删除，改为内联 `> 400` |
| `web.ts` | HTTP `requestTimeout` | Node 默认 300s | `10 * 60 * 1000` |
| `routes/config.ts` | 批量应用失败状态码 | `207` | `503` |
| `schemas.ts` | `appName` | `.max(32)` | `.min(1).max(32)` |
| `container/Dockerfile` | 基础镜像 | `node:22-slim` | `node:22.22.3-slim@sha256:e21fc3…` |
| `package.json` | prettier | `^3.8.1` | `3.8.3`（去 caret） |

### 新增的硬闸

```
task-scheduler.ts   MIN_INTERVAL_MS = 60_000        ← 任务最小频率，低于此值 throw
                    TASK_RUN_LEASE_MS = 60_000
                    MAX_CLAIMS_PER_PUMP = 32
agent-runner        SDK_FIRST_RESPONSE_TIMEOUT_MS = 60_000   ← 本地无 watchdog，只能等 30min
                    MAX_TRUNCATION_CONTINUES = 2
feishu.ts           FEISHU_RESOURCE_REQUEST_TIMEOUT_MS = 15_000 / STREAM = 30_000
                    BACKFILL_LOOKBACK_MS = 5min / MAX_PAGES_PER_CHAT = 5
group-queue.ts      RUNNER_TEARDOWN_TIMEOUT_MS = 15_000
provider-pool.ts    DEFAULT_RECOVERY_INTERVAL_MS = 300_000 / UNHEALTHY_THRESHOLD = 3
```

### 未变（核实过，避免误报）

`MAX_RETRIES=5` / `BASE_RETRY_MS=5000`（退避曲线不变）· `CARD_SIZE_LIMIT=25KB` / `MAX_ELEMENTS_PER_CARD=43` · `feishu.ts` 的 `MAX_FILE_SIZE=30MB` · `ipc-send-dedup` 的 TTL/上限迁移后数值不变。

`MAX_RECENT_EVENTS`（20→5）与 `MAX_THINKING_CHARS`（2000→800）是**本地已改**，合并未覆盖。

---

## 十一、依赖的破坏性变更

```
@whiskeysockets/baileys ^6.17.16  →  baileys ^7.0.0-rc13    ← 换包名 + 主版本 + RC
better-sqlite3 ^11.8.1            →  ^12.10.0                ← 主版本
hono ^4.11.9                      →  ^4.12.25
新增：undici 6.27.0 · adm-zip · overrides: {libsignal: "6.0.0"}
移除（前端）：@dnd-kit/{core,sortable,utilities} · vite-plugin-pwa · @fontsource-variable/inter
新增：web/package-lock.json（12271 行，base 没提交过 lockfile）
```

`baileys` 是 **RC 版本** —— WhatsApp 通道会跑在未正式发布的主版本上。

---

## 十二、PWA 退役（用户会直接察觉）

upstream 移除 `vite-plugin-pwa`，`vite.config.ts` 从 274 行砍到 47 行，改为手写 `public/sw.js` —— 一个**一次性自毁迁移脚本**：install 立即 skipWaiting，activate 时删掉所有 `workbox-*` 和 6 个具名 cache、`registration.unregister()`、然后 `client.navigate()` **强制所有受控标签页重载**。

已安装 PWA 用户的体验：
1. 下次打开时旧 SW 更新到自毁版 → 清空全部缓存 → 注销自己 → **强制刷新**（可能是一次意外白屏）
2. 之后仍可安装、仍全屏、仍有桌面图标，但**完全失去离线能力**
3. 消息历史的 local-first 缓存（50 条/1 天 SWR）消失 —— 切对话不再有 0ms 首帧，弱网每次都等网络

---

## 十三、虚惊（核实后确认无影响）

| 项 | 结论 |
|---|---|
| **143 处"守卫被删"** | 逐个核对，**没有一处是真的取消保护**。全是 upstream 把入站 handler 整段包进 `try/finally`（缩进 +2）+ prettier 压行造成的假象。唯二真消失的两行属于旧 ack reaction 机制，那套整体被替换 |
| `adminRoleMiddleware` 去 null 检查 | **无影响** —— `authMiddleware` 保证 user 一定被 set，未认证在上一层就 401 |
| `load-env.ts` 代理注入 | 本机**完全 no-op** —— plist / launchd 脚本 / `.env` / shell 全无 proxy 变量，守卫为 false，连 agent 对象都不构造 |
| 2 个 MCP server 迁移 | **无需迁移** —— lark-mcp / feishu-doc-edit 都没有 `env`/`headers`，不触发迁移分支，输出字典完全一致 |
| 用户删除语义 | 本地**已经是软删** —— `deleteUser()` 是 `UPDATE users SET status='deleted', deleted_at=?`，`restoreUser()` 也已存在。upstream 的变化是副作用改 post-commit |
| `parseGroupRow` 的 fail-closed | diff 显示 `-89/+534`，但核实合并结果**语义保留**（fail-closed 注释与 `senderAllowlist = []` 仍在） |
| 五处 `DROP TABLE` | **没有一处是静默新增**：两处静默的是 base 早有且有门（45 不触发），三处 upstream 新增的都落在冲突标记内 |
| lastCommittedCursor 缺口 | 实测两张游标表各 69 key、**缺口为 0**，本次升级不触发全量重放 |

---

## 十四、反向增量：upstream 静默带来的保护

不全是坏消息。这些是**新增**的、本地没有的：

| 能力 | 位置 |
|---|---|
| QQ 的 SSRF 防护（`untrusted WebSocket URL`）+ 三个超时/大小上限 | `qq.ts` |
| WhatsApp 路径穿越防护 + 指数退避重连 + socket generation 校验（修串台） | `whatsapp.ts` |
| Telegram getMe 预检 + 120s 长轮询看门狗（掉线自愈） | `telegram.ts` |
| DNS rebinding 防护（真做 `lookup(all:true)`，防打云 metadata） | `url-safety.ts` |
| 全局 fetch 走代理（本机 no-op，但设了 proxy 就生效） | `load-env.ts` |
| `GET /api/mcp-servers` **不再回传明文 env/headers**，只回 key 名 | `routes/mcp-servers.ts` |
| MCP 密钥独立落盘 + 目录 `0700` / 文件 `0600` | `mcp-utils.ts` |
| 用户删除的副作用改 post-commit（不再留"session 已作废但账号没改"的半状态） | `routes/admin.ts` |
| host-privilege 撤销栅栏（降权时先停脚本 + 静默 runner，失败 503） | `routes/admin.ts` |
| SDK 首响应 60s watchdog（本地只能等 30min `CONTAINER_TIMEOUT`） | `agent-runner/sdk-control.ts` |
| owner 信任分级 `owner_claim_source`（防凭据转移后被同一 sender "洗白"） | `group-owner.ts` |
| `stripLeadingBotMention` 只依据飞书可信 mention 元数据剥 `@名字` | `feishu-mention-gate.ts` |
| 未确认 IPC 投递的恢复（`recoverUnacknowledgedIpcDeliveries`） | `group-queue.ts` |
| stop/restart 期间抑制自动重试（`canScheduleRetry`） | `group-queue.ts` |
| 历史缓存 token 从丢弃变为回填（`json_extract(…'$.cacheReadInputTokens')`） | `db.ts` 迁移 |

---

## 十五、这份清单对合并策略的含义

原定 T0「分层：先收纯新增文件 + 机械层」**有问题** —— 374 个新增文件里包含 `db.ts` 的迁移阶梯，一落地就跑 §2.1 那四行。

必须加前置步骤：

1. **在数据库副本上跑一遍完整迁移**，逐项验证 §2 的每一条数据变换
2. 决定哪些无条件操作要加门控。至少这四项：`DROP TABLE group_members` · `DELETE FROM workspaces` 的非 web 行 · `agent_channel_mounts` 全删重建 · v58 的 owner_only 批量设置
3. **先补 resolver 的 mount 分支或补全 8 个绑定**，否则 §1.1 会让两个 member 完全失联
4. 决定 `delivery_status` 五列的归属（§5）
5. 合并 `shared/stream-event.ts` 后必须 `make sync-types`（4 份副本全冲突）
6. `container/build.sh` 重建镜像（§7 的 Skills 挂载模型）
