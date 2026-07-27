# upstream → local 合并 · 完整决策树

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 依据：`docs/upstream-merge-analysis.md`（代码/功能差异）+ `docs/upstream-silent-changes.md`（静默变更）
> 更新：2026-07-25

**图例**：✅ 已决策 · ❓ 待决策 · 🔗 依赖其他项 · ⚠️ 不可逆 · 🐛 是 bug 不是决策

统计：**共 47 项** · 已决策 24 · 待决策 21 · 降级为 bug 2

---

## 分析过程中的错误更正

以下是我在分析中给出过、后被推翻的结论。记在这里防止后续误用：

| 错误结论 | 实际 | 怎么发现的 |
|---|---|---|
| "host 并发闸不能拆，37 个工作区同时跑会打死 Mac" | 机制说错了。`activeHostProcessCount--` 在 `runForGroup` 的 finally，同时做 `state.process = null` + `onContainerExitFn` → **是进程退出路径**。Claude 常驻，槽位被暖进程占到 IDLE_TIMEOUT | 查释放时机 |
| "本地 CLAUDE.md 描述 schema 40，实际运行 45" | CLAUDE.md **没有硬编码版本号**，写的是"以 `SCHEMA_VERSION` 常量为准，勿在文档中硬编码"。真正的缺口是表清单（8 张表零提及）和 §11 的 12 处死引用 | subagent 逐行核对 |
| "`DROP TABLE group_members` 是静默的、每次启动无条件执行" | 在 upstream 源码里确实无条件，但**落在合并冲突区 2667–3420 内，人会看到**。真正静默的是周边（6 个函数 + CREATE + backfill） | 分析合并产物而非源码 |
| "迁移前备份每次启动都建，是磁盘炸弹" | 条件 `39 ≤ v < 63`，迁移成功后版本变 63 → 永远为假。**是一次性 130MB** | 用户指出 |
| "`/new` 建工作区时不写绑定" | **写**。`handleNewCommand` 第 36 行 `target_main_jid: newJid`，回复里明说"已创建并绑定" | 用户质疑后读实现 |
| "8 个无绑定会话是历史遗留（机制未上线）" | 绑定机制 2026-03-06 就有，8 个会话是 3-14 之后注册的。**无绑定是正常默认态** —— 没跑过 `/new` 的聊天就是无绑定 | 查注册时间 + `/new` 实现 |

---

## 第 0 层 · 合并形态（决定后面所有事的执行顺序）

### D0.1 ❓ 合并方式

原定"分层：先收纯新增文件 + 机械层"。**静默分析后发现这条行不通** —— 374 个新增文件里包含 `db.ts` 的迁移阶梯，一落地就跑无条件的数据销毁。

| 选项 | 后果 |
|---|---|
| **A. 单次全量 merge** | 一次面对 329 hunk + 51 个静默删除文件 + 20 个静默符号 + C 类注入。中途无法验证 |
| **B. 按子系统分批 port**（不做 git merge，逐个搬模块） | 每批可独立验证；behind 计数不降，靠台账追踪。与"不允许 merge -s 跳过"不冲突——这是真搬代码 |
| **C. 分层 + 数据库前置**（修订版）：① DB 副本跑完整迁移验证 → ② 给无条件销毁加门控 → ③ 补路由前置 → ④ 收机械层 + 纯新增 → ⑤ 硬冲突子系统单独分支 | 步骤多，但每步可回退 |

### D0.2 ✅ Schema 版本对齐 → 接到 63 之后

**执行细节需确认**：不能只改常量。当前 `router_state.schema_version='45'`，upstream 门控在 28/48/51/58/62 —— 直接改成 64 会让四道门**全部判假被跳过**，而本地从没跑过 upstream 的 v46–v62。

正确顺序：**先把 schema_version 降到 39** → 让 upstream 的 v40→63 阶梯完整跑一遍 → 本地新迁移从 64 开始。本地 v40–45 是无条件幂等 DDL，重跑无害。

**⚠️ 这一步前必须备份。**

---

## 第 1 层 · 不可逆 / 数据销毁（做错没法回退）

### D1.1 ✅ `group_members` → **跟随 upstream 删除，共享工作区能力不要了**

**影响（决策依据）**：功能完整存在但从未被用过 —— 4 个后端端点 + 前端「成员」侧栏 tab。`isGroupShared()` 判定是 `COUNT(*) > 1`，而每个 folder 只有 1 行 owner，**现在全库返回 false**。它唯一控制的行为是 `formatMessages(messages, isShared)` —— 消息前面加不加发送者名字。所以**运行时行为零变化**。

**执行细节**：那 32 行是 `/new` 产生的 —— `handleNewCommand` 第 31 行 `addGroupMember(folder, userId, 'owner', userId)`。删表时这一行也要删。

<details><summary>原选项（已决策，留档）</summary>

### ~~D1.1 ❓⚠️ `group_members`（32 行）~~

**已查证**：32 行全部 `role='owner'` 且全部 `is_creator='yes'`，与 `registered_groups.created_by` 完全冗余，**零个真实共享**。

**但要知道**：即使在冲突里选保留数据，六个访问函数（`addGroupMember` / `removeGroupMember` / `getGroupMembers` / `getGroupMemberRole` / `getUserMemberFolders` / `isGroupShared`）+ `CREATE TABLE` + v15 backfill + `deleteGroupData` 里的 DELETE **全部静默删除**。表在、数据在、没有代码能读。

| 选项 | 后果 |
|---|---|
| **A. 跟随删除** | 与 upstream owner-only ACL 对齐。32 行销毁不可逆，但已证明零访问损失 |
| **B. 保留表 + 自己补回六个函数** | 保住共享能力；每次合并要手动摘那行 DROP，漏一次即销毁 |
| **C. 改名 `workspace_members`** | 一次性改 22 处引用，之后永久免疫 upstream 的 DROP |
</details>

### D1.2 ❓⚠️ `agent_channel_mounts` 的 3 列

**穷举复查结论**（第一次 grep 太窄，这次列出 db.ts 里所有涉及该表的语句 + 每个访问函数的外部调用点）：

```
getChannelMount      → 0 处外部调用
listChannelMounts    → 0 处外部调用
setChannelMount      → 0 处外部调用
deleteChannelMount   → 0 处外部调用
migrateTargetMainJidToChannelMounts → 2 处（index.ts:102 import, :3262 调用）
reconcileChannelMounts              → 2 处（index.ts:103 import, :3263 调用）
```

**这张表只写不读**：迁移写入 + 自我对账，没有任何路由/业务代码读它。21 行是孤儿数据。

`reconcileCanonicalRuntimeProjections()` 静默执行 `DELETE FROM agent_channel_mounts`（21 行全删）再从 `registered_groups` 重建。本地 13 列，upstream 10 列 —— 你多的 `agent_profile_id` / `owner_user_id` / `workspace_folder` 重建后不存在。

| 选项 | 后果 |
|---|---|
| **A. 接受 upstream 10 列** | 与 upstream 一致；批次 7 加的三列语义丢失 |
| **B. 保 13 列，自己写重建逻辑** | 保住；每次 upstream 改 sync 逻辑要重新适配 |
| **C. 给重建加门控，跳过这一步** | mount 表不再自动对账，可能与 `registered_groups` 漂移 |

### D1.3 ✅ `usage_events` → **让它跑**

**影响（决策依据）**：7008 行约 1.2 MB，当前库 140 MB → **+0.9%，可忽略**。跑了之后 upstream 的新 UsagePage（1324 行，会静默取 upstream 版）能正常显示历史用量；不跑则打开是空的。

<details><summary>原选项（已决策，留档）</summary>

### ~~D1.3 ❓ `usage_events` 复制 7008 行~~

v51 迁移无条件 `INSERT OR IGNORE INTO usage_events` 全量复制，`usage_records` 7008 行 → 总量翻倍。

你此前决策"用量账本保留本地、不采纳 `usage_events`"，但迁移不看这个决策。

| 选项 | 后果 |
|---|---|
| **A. 让它跑** | 多一份冗余账本（约 +7008 行）；upstream 的新 UsagePage（1324 行，会静默取 upstream 版）需要它 |
| **B. 跳过这段迁移** | UsagePage 读到空，得改回本地版或自己适配 |
</details>

### D1.4 ❓ `workspaces` 29 行删除

**穷举复查结论**：`workspaces` 表在 `db.ts` 里只出现在 5 处 —— `DELETE FROM`（sync 开头）、`INSERT INTO`（sync 重建）、两处 `SELECT COUNT(*)`（对账用）、一处 `NOT EXISTS`（sync 判空）。**没有任何导出函数按行读取它**。外部被调用的 workspace 相关函数（`deleteImContextBindingsByWorkspace` 4 处 · `getWorkspaceAgentProfile` 2 处）读的是 `im_context_bindings` 和 `workspace_agent_profiles`，**不是这张表**。

与 D1.2 同性质：只写不读。

**已查证**：那 29 行全是 IM jid（25 feishu / 1 qq / 3 wechat），`src/` 里除 `db.ts` 外零读取。本地当初是**过度投影**（upstream 语义只保留 `web:%`）。

| 选项 | 后果 |
|---|---|
| **A. 让它删** | 投影语义与 upstream 对齐。风险低（无读取方） |
| **B. 保留 IM 投影** | 若将来本地代码要按 IM jid 查 workspace，不用重建；但与 upstream 语义分叉 |

### D1.5 🐛 迁移前备份的触发条件是 bug —— 不是决策项

原本我把它描述成"每次启动 130MB 的磁盘炸弹"，**错了**。条件是 `schemaVersion >= 39 && schemaVersion < 63`，迁移成功后版本变 63 → 条件永远为假 → **一次性 130MB**。

> **执行阶段更正（2026-07-26）**：上面这段「上界写死成 63」是错的。读 upstream
> 源码原文，条件是 `schemaVersion >= 39 && schemaVersion < CURRENT_SCHEMA_VERSION`
> —— 上界用的是**常量**（`CURRENT_SCHEMA_VERSION = 63` 只是它当前的取值），不是
> 字面量。所以「本地将来 v64、v65 不备份」的推论不成立，这个 bug 不存在。

实际剩下的只有**下界 `>= 39` 是硬编码**：比 v39 更老的库反而不备份，而越老的库
迁移风险越大。对本地无影响（现在 v45，合并后走 45 → 63，条件成立），只是语义上
拧着——留作阶段 2 解 `db.ts` 冲突时顺手去掉下界。

另外，本地现有实现（`backupDatabaseBeforeMigration`，`66b8a68` 引入）是**按
SCHEMA_VERSION 打标记文件**的路子，与 upstream 按版本差判断不同。两者都满足
「版本不变时启动不产生新 backup」：本地靠 `.schema-v{N}.done` 存在即跳过，
upstream 靠 `schemaVersion < CURRENT` 为假即跳过。合并时取 upstream 侧——
`VACUUM INTO` 是事务一致快照，比分别拷 `.db/.db-wal/.db-shm` 三个文件更可靠。

**处理**：修条件 + 加保留策略（避免迁移反复失败时累积）+ 加回本地的 `HAPPYCLAW_ALLOW_DB_MIGRATION_WITHOUT_BACKUP` override。不需要你决策。

<details><summary>原选项（已降级为 bug，留档）</summary>

### ~~D1.5 ❓ 迁移前备份策略~~

upstream 的 `enforcePreMigrationBackup`：`39 ≤ v < 63` 时每次启动 `VACUUM INTO` 一份（你的库 147MB → 约 130MB/份）。**没有 GC、没有保留策略、没有 env override**（本地现有的 `HAPPYCLAW_ALLOW_DB_MIGRATION_WITHOUT_BACKUP` 在 upstream 不存在），失败即拒绝启动。

`schema_version` 写在 `runMigrations` **最后一行**，备份在最前 → 迁移中途任何一步抛异常，版本停在 45，下次重启再建一份。**N 次失败重启 = N × 130MB**。现有 `data/db/backups/` 已占 1.2GB。

| 选项 | 后果 |
|---|---|
| **A. 原样采纳** | 最安全；磁盘可能被吃掉 |
| **B. 加保留策略（保留最近 N 份）+ 加回 env override** | 可控；偏离 upstream，每次合并要重新打补丁 |
| **C. 只在首次迁移时备份（用 marker 文件去重，同本地现有机制）** | 不会累积；迁移失败后重试时没有新备份 |
</details>

---

## 第 2 层 · 架构方向（二选一，决定大片代码归属）

### D2.1 ✅ agent-runner 基座 → 保本地多 runtime，对齐共性 + 突出各自特性

### D2.2 ✅ mcp-tools 中立层 → 保本地（T3 的直接推论）

采纳 upstream 会切断 Codex/Grok 的 24 个内建工具（实测使用量：`feishu_*` 1045 次 / `send_message` 182 / `send_file` 155）。

### D2.3 ❓ 路由 fail-closed vs fail-open —— **会让 8 个会话失联，且此后每个新会话一注册就是死的**

**为什么有 8 个无绑定 —— 查清了，不是 bug**：

```
跑了 /new  → handleNewCommand:36  target_main_jid = newJid → 绑定
            → 回复「工作区「X」已创建并绑定」
没跑 /new  → onNewChat 自动注册到 owner 的 home folder，不写 target_main_jid
            → 消息走 `agentRouting?.effectiveJid ?? jid` 回落，在 home 工作区里跑
```

21 个有绑定 = 跑过 `/new`（各绑到一个不同的 `flow-*` 工作区，一对一）。
8 个无绑定 = **直接跟 bot 聊、没建专属工作区**。正常且常见的用法。

绑定机制 2026-03-06 就存在，这 8 个是 3-14 之后注册的 —— **不是历史遗留**。

**所以采纳 fail-closed 而不改注册路径，等于此后每个新 IM 会话一注册就是死的** —— 拉进群、发消息、没反应、也不知道为什么。

新增第四个选项 **D**（见下表）。原选项 B「先补全 8 个绑定」**治标不治本**，下一个新会话照样死。

```
本地 index.ts:10018  无绑定 → return null
upstream channel-admission.ts:129 + 各渠道 → if (!resolvedRoute) { warn; return; }  ← 丢消息
现在：agentRouting?.effectiveJid ?? jid → 回落到聊天自己的 jid，正常处理
```

**实测受影响的 8 个无绑定 IM 会话**：admin 2 个（feishu 私聊、qq）· **cxx 4 个**（feishu 私聊 + 2 个群 + wechat）· **whz 1 个**（wechat）· wechat folder 1 个。

**两个 member 会被完全切断。** upstream 自己不出问题是因为它的 resolver 有 `getChannelMount()` 兜底 —— 本地零命中，21 条 mount 是没有读路径的孤儿。

| 选项 | 后果 |
|---|---|
| **A. 采纳 fail-closed + 补 resolver 的 mount 查询分支** | 语义更对（不把消息路由到错的地方）；要写 mount 读路径，🔗 依赖 D1.2 |
| **B. 采纳 fail-closed + 先补全 8 个绑定** | ❌ **治标不治本** —— 下一个不跑 `/new` 的新会话照样死 |
| **D. 改注册路径：`onNewChat` 时显式写一条指向 owner home 工作区的默认绑定** | 把现在隐式的 `?? jid` 回落变成显式记录。一处改动，fail-closed 变安全，且顺带让那 21 条 mount 数据有了消费方 |
| **C. 保本地 fail-open 回落** | 零风险；与 upstream 渠道代码永久分叉（7 个渠道文件都要改） |

### D2.4 ✅ 人格渲染位置 → 保本地（runner 内分段渲染，三运行时共享一份定义）

### D2.5 ❓ 投递可靠性的落地形态

已定方向：**upstream 的记录方案 + 自动重试（分钟/小时/天级），不要人工裁决**。剩下三个子决策：

#### D2.5a ❓ `uncertain` 重试前是否做 provider 回查

**实测影响**（66 天日志 / 919 条 IM 出站）：

```
发送失败总计            24 次  = 2.6%（剔除 6 月 token 事故后 4 次 = 0.44%）
  ├─ 发送前就失败        22 次  91.7%  token 获取失败 / DNS / 连接 / 上传 → 重试不会重复
  ├─ 服务端明确错误码     2 次   8.3%  两次 HTTP 503 → 理论可能重复
  └─ 已写出后超时/断连    0 次   0%
`IM operation failed after all retries`  →  66 天 0 次
```

**不回查的实际代价：66 天内最多产生 2 条重复消息（约每 33 天 1 条），也可能是 0。**
对照面：不重试的代价是 66 天丢 24 条回复。

**两个决定性事实**：

1. **本地现在就已经在无条件重试** —— `retryImOperation`（`index.ts:1436`）对 `sendMessage` 做 3 次重试、2s/4s 退避，零回查。「不回查就重试」不是新增风险，是既有行为。
2. **7 个渠道只有 2 个能回查**：飞书（`im.v1.message.list` 已用于 backfill，且代码里显式过滤 `senderType === 'app'` —— 证明 bot 自己发的消息确实在结果里）· Discord（`channel.messages.fetch()`）。Telegram / QQ / 钉钉 / 微信 / WhatsApp **都没有服务端历史查询 API**。

**且飞书回查有前置障碍**：`sendToFeishu()`（`feishu.ts:1019`）签名是 `Promise<void>`，**直接扔掉了 message_id**。要做 hash 比对得先改这条链路回传 receipt。

⚠️ **另一个必须知道的**：upstream 的 uncertain 判定是「`status==='sending'` 且不是 `DefinitiveChannelDeliveryError`」，而 `markChannelOutboxSending` 在 `send()` **之前**调用。飞书的 token 异常抛在 SDK 内部（即 `send()` 里）→ **那 20 次"根本没发出去"的失败会 100% 被标成 `uncertain`**，除非飞书适配器显式把 token 类错误包成 definitive。

`uncertain` 的语义是"不知道这条到底发出去没有"。自动重试意味着接受偶发重复消息。

| 选项 | 后果 |
|---|---|
| **A. 不回查，直接重试** | 简单；偶发重复消息 |
| **B. 重试前调飞书 `im.message.list` 按 chat + 时间窗回查，比对 payloadHash** | 几乎不会重复；多一次 API 调用，且只有飞书能做（其他渠道没有等价 API） |

#### D2.5b ❓⚠️ `delivery_status` 五列的归属 —— **语义撞车，阻塞 D2.5**

**实测影响**：`messages` 13741 行中 `delivery_status` 非空**仅 3 行**，全部 `'sent'`，全部写于 2026-07-25（上线约 5 小时）。`delivery_run_id` 0 行，`delivery_priority` 全 0。**生产代码读取点 0 个** —— `getStalePendingDeliveries` / `getMessageDeliveryState` / `getDeliveryStats` 都没有调用者。

**「未送达」角标从未渲染过**，且结构上很难渲染：① 飞书 `feishu.ts:2006` 的 catch 只 `logger.error` 不 rethrow → 上层记成 `'sent'`。实测佐证：**20 次 `Failed to send Feishu card message`，20/20 后面紧跟一行 INFO `Message sent`** ② WebSocket 广播不带这个字段，只有 `getMessagesPage` 带 → 角标只能刷新后出现。

**两方案实测工作量**：A（改 upstream 那半边）**9 文件 / 156 处**，数据迁移 0 行 · B（改本地这半边）**5 文件 / ~50 处**，数据迁移 **3 行**。

⚠️ A 方案额外风险：upstream 的 `getNewMessagesStmt` / `getMessagesSince` 带 `AND COALESCE(delivery_status,'') NOT IN (...)` —— 改列名必须同步改，否则**消息轮询静默漏读或多读**。

**行集合天然不相交**（upstream 写路径带 `AND is_from_me = 0`，本地三个写点全在 `is_from_me=1`），但本地 `setMessageDeliveryState` 的 WHERE **无 `is_from_me` 约束**，schema 也无 CHECK —— 隔离靠自觉。

| | 本地 | upstream |
|---|---|---|
| 值域 | `pending`/`sent`/`failed`/`skipped` | `queued`/`promoting`/`released`/`cancelled` |
| 含义 | agent 回复**有没有送达 IM** | 用户消息在 **follow-up 队列**里的位置 |

共用 `delivery_status` / `delivery_mode` / `delivery_run_id` / `delivery_priority` / `delivery_updated_at` 五列。两边都留：TS 在 union 上报错，后端两套写入互相覆盖同一列。

| 选项 | 后果 |
|---|---|
| **A. 给 follow-up 队列另开列** | 保住本地「未送达」角标；与 upstream 表结构分叉 |
| **B. 给 IM 投递另开列** | 与 upstream 对齐；本地五列要迁移 |
| **C. 不引入 follow-up 队列** | 无冲突；🔗 但 D4.6 选了"前端跟 upstream"，队列 UI 是它的一部分 |

#### D2.5c ❓⚠️ interrupt 后的重放 —— **唯一会丢数据的一项**

本地：`pipedMessagesDuringQuery` 全部写回重放。
upstream：当前 turn 已被 `cancelCurrentTurn()` 移除，**不重放**，靠 IPC receipt 机制兜底。

**如果只拿"不重放"、没拿 receipt 机制 → 既不重放也没兜底 = 丢消息。**

| 选项 | 后果 |
|---|---|
| **A. 保本地全量重放** | 不丢；被取代的 prompt 会排在 steering prompt 前面重放（upstream 注释指出的问题） |
| **B. 引入完整 IPC receipt** | 语义最正确；要动 `group-queue.ts`（upstream 改了 1256 行）+ `agent-runner` 三条运行时各实现回执 + host 侧 363 处引用 |
| **C. 折中：不重放 + 自己写一个轻量兜底** | 工作量中等；要自己维护正确性 |

### D2.6 ❓ `db.ts` 的五组同概念异名

| 本地 | upstream |
|---|---|
| `getAgentProfile` | `getAgentProfileForUser`（多 owner 校验） |
| `listAgentProfiles` | `listAgentProfilesForUser` |
| `getWorkspaceAgentProfile` | `getWorkspaceAgentProfileId` |
| `setWorkspaceAgentProfile` | `assignWorkspaceAgentProfile` |
| `computeAgentIdentityHash` | `computeAgentProfileIdentityHash`（hash 含 runtime_policy） |
| `getChannelMount` / `setChannelMount` | `getAgentChannelMount` / `upsertAgentChannelMount` |

按本地侧解冲突 → upstream 的 30 个新文件全部找不到符号。

| 选项 | 后果 |
|---|---|
| **A. 全部改名对齐 upstream** | 未来合并零摩擦；改本地全部调用点 |
| **B. 保本地名 + 加 upstream 名的别名导出** | 改动小；两套名字并存，容易漂 |

---

## 第 3 层 · 契约与语义

### D3.1 ✅ `isAdminHome` → 采纳 upstream（`isHome && owner?.role === 'admin'`）

已查证：两种口径当前命中完全相同的 1 行，切换零行为变化。

### D3.2 ❓ `sendMessage` 响应契约

| 本地 | upstream |
|---|---|
| `{ success, messageId, timestamp, handledCommand? }` | `{ success, messageId, timestamp, disposition: 'started'\|'queued'\|'steered', runId? }` |

**我此前说"会让输入框一直转圈"是夸大了。** 实测：

`handledCommand` 全仓**只有一个来源**（`web.ts:611`，`/model` 正则命中）。后端在 `:608` 先 WS 推送回复，才在 `:611` 返回 HTTP。所以：

- **WS 先到**（多数情况）→ `latest` 是 AI 回复 → `shouldWait` 本来就 false → **无影响**
- **HTTP 先到** → 转圈，随后 WS 到达立刻清 → **闪烁一帧，毫秒级**

`handledCommand` 的作用是把这个竞态变成确定的，**不是防 60 秒卡死**。唯一长时间转圈的场景是 **WS 断线** —— 兜底是 `StreamingDisplay.tsx:686` 的 `STALE_NO_DATA_MS = 60_000`，60~70 秒后自动清除。而且**不会禁用输入框**（`MessageInput` 没接 `isWaiting`），也不会误发第二条。

**但 `disposition` 不能单独摘** —— `runId` 靠 `getActiveQueryId()`，`queued`/`steered` 靠 `promoteFollowUp()`，本地两者都没有。follow-up 特性引用面：`web.ts` 35 处 · `index.ts` 33 · `db.ts` 45 · `chat.ts` 41 · `types.ts` 11（本地对应各 0/1/18/1/0）。

| 选项 | 影响 |
|---|---|
| **A. 保留 `handledCommand`** | 0 改动。`/model` 回复瞬间出现无转圈 |
| **B. 删掉，`/model` 走 `started`** | 删 5 处。正常网络多数无感知，偶发闪一帧；WS 断线时转圈 60~70s + 中断按钮常驻 |
| **C. 完整跟 upstream 的 follow-up** | 多出"消息排队/转向"能力；代价 165 处引用面 + 🔗 D2.5b 的列语义冲突 |

### D3.3 ❓ `clearAckReaction` 签名 —— **实测每 8 条消息就残留 1 个表情**

**用户看到的**：飞书 `OnIt`（「得令」）· 钉钉 `🤔思考中` · Discord 👀，加在用户刚发的那条消息上，Agent 回复后应当撤掉。

**两个独立缺陷**（不需要"并发两个 turn"就能触发）：

1. **单槽覆盖** —— `ackReactionByChat` 是 `Map<chatKey, ...>`，**per-chat 单槽**。用户在 Agent 回复前连发两条，两条都加 ack，第二条 `.set()` 覆盖第一条 → 一次回复只 clear 一次 → **第一条的表情永久残留**
2. **attach/clear 竞态** —— `addReaction` 是异步（~100-300ms），clear 若跑在 `.then()` 之前，map 是空的 → 空转 → 随后写入 → **永久孤儿**

**实测残留率**（feishu/dingtalk/discord 的入站消息，统计"连发段"）：

```
全量 4.4 个月：1243 条入站 → 104 个 ≥2 连发段 → 残留 160 个表情 = 12.9%
近 30 天：      86 条入站  →   6 个连发段   → 残留  10 个       = 11.6%
```

**约每 8~9 条 IM 消息就留下一个撤不掉的「得令」。** 往上翻历史能看到一串。

| 选项 | 改动量 | 影响 |
|---|---|---|
| **A. 不改** | 0 | 残留按上表继续累积 |
| **B. 只改签名，不引 registry** | 9 调用点 + 4 接口 + 3 实现；且 `index.ts` 那 5 处要拿到"本 turn 的输入消息 id"——IPC 中途注入的消息不在 `missedMessages` 里，而那恰是缺陷 1 的主要来源 → 还要额外维护 per-turn 输入 id 集合 | 解决 1 不解决 2 |
| **C. 完整跟 upstream** | 新增 `processing-indicator.ts`（116 行）+ 三渠道存储换 registry + `index.ts` 一整套 lease（upstream 里 99 处引用），`setTyping` 签名同步变 | 两个都解决；🔗 与 D5.3 是同一子系统 |

### D3.4 ❓ provider 开关 API —— **本地是超集，且 upstream 的保护更弱**

**前提纠正：本地两个端点都在。** `PATCH /providers/:id`（`config.ts:704`）**和** `POST /providers/:id/toggle`（`config.ts:890`，纯翻转，没删）。所以"前端跟 upstream 会 404"是错的。

**upstream 的 `/toggle` 早就不是翻转了** —— 它读 body 的 `enabled` 做幂等设值（`config.ts:1216`），和本地 PATCH 收敛到同一语义，只是 URL 不同。本地保留的 `POST /toggle` 反而是旧翻转版。

本地改成 PATCH 的原因（`27be703`，2026-05-05）：`delete deps.sessions[group.folder]` 在 `deps.sessions` 为 undefined 时抛错，导致开关整体失败。新增测试的标题直说了：*"sets Claude provider enabled state without requiring legacy in-memory sessions"*。

**⚠️ 真正的风险在"最后一个启用项"的保护**：

| | 判断范围 |
|---|---|
| 本地 | **按池**，且只对 claude 池生效 |
| upstream | **全局** `state.providers.filter(p => p.enabled).length <= 1` |

本机实测 `claude-provider.json`（4 个 provider）：**claude 池 2 个 / 启用 1 · gpt 1/1 · grok 1/1，全局启用 3**。用 upstream 的全局判断，**禁用那唯一启用的 claude provider 会通过校验（3 > 1）→ claude 池 0 可用 → Claude 运行时静默失效**。

另外 upstream 只有 claude 一节 —— `/codex/providers/*` 和 `/grok/providers/*` 在 upstream 完全不存在，前端三节要么不一致，要么给 codex/grok 各补一条 `/toggle`。

**若后端跟 upstream（schema 去掉 `enabled`）+ 本地前端 PATCH**：refine 因"所有字段都 undefined"失败 → **400 + 页面弹红色错误条**，不是静默失败。

### D3.5 ❓ `resolveBoundChatTarget` 返回 `| null` —— **⚠️ 这是雷，不是契约细节**

**悬空绑定时 `/clear` 会炸掉 admin 主会话。**

实测：全部 21 条绑定的**源群 `folder` 全是 `main`**。所以任一绑定悬空后，在那个飞书群发 `/clear`：

```
resolveBoundChatTarget 兜底 → folder = 源群自己的 folder = 'main'
executeSessionReset('死jid', 'main')
  ├─ getJidsExecutingInFolder('main') → 实测返回 3 个：
  │     web:main（tivility Home, host）· feishu:oc_0989ee11（私聊, host）· qq:c2c:557765EB（host）
  ├─ 逐个 queue.stopGroup(jid, {force:true})    ← 停掉 admin 的 host 主进程
  ├─ clearSessionFiles('main')                  ← 抹掉 data/sessions/main/.claude/
  ├─ deleteSession('main')                      ← 删 DB session 行
  └─ context_reset 分隔符写进那个【已经死掉的 jid】
```

用户看到的回复是**「已清除对话上下文 ✓」** —— 不会意识到清错了对象，等回到 Web 主对话才发现上下文没了。`/model use` 走同一条兜底，会改到 **admin 主会话的模型绑定**。

**本地现在 0 悬空**（21 条逐条 join 校验，目标全部存在；`target_agent_id` 0 条；`im_context_bindings` 0 行），因为有 3 道前置防御：`DELETE /api/groups/:jid` 的 409 · `DELETE /agents/:agentId` 的 409 · `clearTargetAgentBindingsForDeletedAgents()`。

**但有 1 条未覆盖路径**：`deleteImGroupRecord()`（`db.ts:5090`）里的 `DELETE FROM agents WHERE chat_jid = ?` —— 删 IM 群时连带删挂在它上面的 agent，**不走 409 检查**。另有直接改库 / migration。

| 选项 | 影响 |
|---|---|
| **A. 保兜底** | 0 悬空时无差别。一旦悬空 → 静默清掉 admin 主会话，且提示是"成功" |
| **B. 改 null** | 补 3 处空指针（约 5 行）。同场景收到「当前绑定目标不存在，请先重新绑定」，`/clear` 不执行 |

⚠️ upstream 还给它加了第 6 参 `resolveWorkspaceJid?` —— **这会改变行为**：本地对 `target_main_jid = 'web:{folder}'` 旧格式的绑定现在直接走兜底，接了之后会先按 folder 反查真实 jid，即**部分"看起来悬空"的旧绑定会被救活而不是变 null**。

---

## 第 4 层 · 功能取舍

### D4.1 ✅ Agent-first 产品面 → 对齐 upstream

#### D4.1a ❓ 但设置页信息架构不兼容 —— **阻塞 D4.1**

本地：扁平 tab 列表 + `models` / `gpt` / `grok` 三个。
upstream：重排成 `appearance` / `claude` / `main-agent` / `system` / `automation` / `host-integration` / `billing`，并新增 `preferences` / `agent-profiles`，**删掉 `skills` / `mcp-servers` / `plugins` / `agent-definitions` 四个 tab**。

本地那三个 tab 不能"贴回去"。**若按 upstream 解冲突，GPT/Grok/模型池三个入口消失，多运行时只剩后端能力、前端无法配置** —— 与 D2.1 直接矛盾。

| 选项 | 后果 |
|---|---|
| **A. 三个 tab 并进 upstream 的 `claude`（改名"模型与提供商"）** | 一个 tab 里塞三套 provider UI |
| **B. 新开一个 `runtimes` 分组** | 结构清晰；与 upstream 分叉一个 tab |
| **C. 并进 `system`** | 语义不太对 |

### D4.2 ✅ SDK 版本 → 保持 `"*"` 最新 + 运行时特性探测（不钉死）

#### D4.2a ❓ `HAPPYCLAW_DISABLE_SUBAGENT_RUNTIME_CONTRACT` 默认开启

判定是 `!== 'true'` → 默认启用 → 注入 `appendSubagentSystemPrompt`，而这个选项**绑死 SDK 0.3.205**。实测 0.3.220 的类型里已 0 命中。

| 选项 | 后果 |
|---|---|
| **A. 显式设 `=true` 关掉** | 一行 env；失去 subagent 运行时契约 |
| **B. 改成运行时探测**（有这个选项才注入） | 与 D4.2 的理念一致；要写探测代码 |

### D4.3 ✅ 契约测试 → 删 pm2、其余保本地现状

已查证：服务实际由 **launchd** 托管（PID 68927，PPID=1），pm2 只剩 Makefile 里的 `PM2_GUARD` 开发辅助。

#### D4.3a ❓ lockfile 是否开始提交 —— **CI 的前提**

本地 `.gitignore:34-37` 忽略三个 lockfile。CI 用 `npm ci`，**要求 lockfile 存在，第一步就失败**。而契约测试的第一条断言正是"lockfile 不得 gitignore"。

| 选项 | 后果 |
|---|---|
| **A. 开始提交三个 lockfile** | CI 能跑，构建可重现；与"SDK 始终最新"（`"*"` + 无 lock）**直接冲突** 🔗 D4.2 |
| **B. 不提交，不要 CI** | 保住"始终最新"；没有自动门禁 |
| **C. 提交 web + 根，agent-runner 保持无 lock**（那个才是"始终最新"的支点） | 折中；契约测试要改 |

#### D4.3b ❓ host 并发闸 —— 三个选项

**已查证机制**：`activeHostProcessCount--` 在 `runForGroup` 的 finally，而那个 finally 同时做 `state.process = null` + `onContainerExitFn` —— 是**进程退出**路径。Claude 常驻，两轮之间不退出 → **槽位在暖进程空闲期间一直被占，直到 IDLE_TIMEOUT**。

upstream 的注释描述的正是这个，并配了回归测试。当前本地 37 个 host 工作区 / 27 个 container / 5 个槽位。

**另外**：upstream 的 `hasCapacityFor` 对 host `return true` 是**静默**的，但 `maxConcurrentHostProcesses` 在 `schemas.ts` / `runtime-config.ts` / 设置页表单**全部保留** → 变成"存在、可修改、完全无效"的幽灵设置。

| 选项 | 后果 |
|---|---|
| **A. 跟 upstream 拆闸** | 修了暖会话堵塞；37 个 host 工作区无应用层上限，Mac 可能被打死。**且必须同时删掉设置项**，否则是幽灵设置 |
| **B. 保本地闸** | 有上限；保留"暖会话霸占槽位"的 bug，每次合并要重新处理 |
| **C. 第三方案：把计数从"活着的进程"改成"进行中的轮次"** | 两个问题都解；要自己改 + 写测试，upstream 不维护 |

### D4.4 ✅ Kaboo 定价 → 引入

#### D4.4a ❓ 但非 Claude 运行时会错价

13 条规则全是 Claude，Grok/Codex 模型名不匹配 → fallback 到 Claude Sonnet 的 $3/$15 per Mtok，并**真的从 `user_balances` 扣款**。而你的 Codex/Grok 是订阅制 `costUSD: 0`。

叠加 **cachedRead 双重计费**：Grok 的 `inputTokens` 含 cachedRead（OpenAI 口径），Kaboo 按 Claude 口径分别计价 → 缓存部分算两次。违反你 CLAUDE.md §8.14 的"分列 SUM 不相减"。

| 选项 | 后果 |
|---|---|
| **A. 加运行时门控**（非 Claude 强制 `costUSD=0`） | 最小改动；Grok/Codex 无成本可见性 |
| **B. 补 Grok/Codex 价格规则 + cachedRead 口径统一层** | 完整；要自己维护价格表 |

### D4.5 ✅ 定时任务 → 加 per-task 开关（isolated 是否跨 run 保留上下文）

已查证：2 个 isolated 任务各跑了 30 次，工作目录累积到 1.0MB。

#### D4.5a ❓ `createTask` 默认值 `group` → `isolated`（静默反转）
#### D4.5b ❓ 暂停的任务可否手动触发（`triggerTaskNow` 拒绝条件从 `paused` 改成 `parsing`）

你有 2 个 paused 任务。

> 已查证无需决策：`MIN_INTERVAL_MS = 60_000` 对存量零影响（**零个 interval 任务**，10 个 cron 全是 5 段无秒字段）。

### D4.6 ✅ 前端形态 → TurnTracePanel 保留，其余跟 upstream

#### D4.6a ❓ PWA 离线能力

upstream 移除 `vite-plugin-pwa`，改为手写的**自毁 service worker**：activate 时删所有缓存、注销自己、`client.navigate()` 强制所有标签页重载。

之后仍可安装、仍全屏，但**失去离线能力**和消息本地缓存（50 条/1 天 SWR，切对话 0ms 首帧）。已安装用户会经历一次强制刷新（可能白屏）。

| 选项 | 后果 |
|---|---|
| **A. 跟 upstream 退役 PWA** | 与 upstream 一致；失去离线 + 首帧缓存 |
| **B. 保本地 PWA** | 保住能力；`frontend-pwa-retirement.test.ts` 会红，`vite.config.ts` 永久分叉 |

### D4.7 ✅ task-acl → 保本地（admin 跨组特权保留）

**补充事实**：admin main 是 host 模式，仓库根读写挂载，`data/db/messages.db`（147MB / 13739 条消息）就在里面 —— **它本来就能读所有人的对话**，堵发送这一个出口意义有限。

### D4.8 ✅ 额度墙 → 同模型换账号；无同模型可用或全部失败则报错，不降级到别的模型

需要 upstream `provider-fallback.ts` 的爆炸半径分类（`seven_day_opus` 只隔离模型不隔离账号）+ 本地 `ProviderPoolManager` 加"按 model 筛选池内 provider"。

### D4.9 ✅ `claude-memory-policy` → 修

**已验证的活 bug**：admin 主容器 host 模式、cwd `data/groups/main/` 嵌套在仓库内 → Claude Code 把仓库根那份 **70867 字节的 CLAUDE.md 当 Project memory 加载**。业务 Agent 被架构文档重新定义。约 107 行可独立移植。

### D4.10 ✅ F1 四个洞 → 一起改（但要设计）

#### D4.10a ❓ 分两步还是一次做完

已查证：`pendingSdkTasks` 在合并后的 `stream-processor.ts` 中**存活**，但 `POST_RESULT_TIMEOUT_MS` 的两处判定落在**冲突区 2321–2359**，选 upstream 侧即撤销 F1。

| 选项 | 后果 |
|---|---|
| **A. 分两步**：先修①④（电平信号 + `shouldQuery:false`，约 100 行，局限在 agent-runner 内）；②（首条 result 不当终稿）留到合并 `feishu-streaming-card.ts` 那 34 个冲突时一并做 | 风险低；"双终稿"现象保留一段时间 |
| **B. 一次做完** | 彻底；要同时改 `ContainerOutput` 契约 + `agent-output-parser` + 前端定稿逻辑 + 飞书卡片渲染，都是高风险区 |

### D4.11 ❓ CLAUDE.md 处置

**已查证 upstream 的理念**：不是"拆分"，是**删除 + 加机械校验**。一个 commit（`652000f`）同时把 CLAUDE.md 从 821 砍到 349 行 + 新增 `scripts/check-docs.mjs`。10 个被删段落的特征词在 upstream 全仓 `.md` 里**全部 0 命中** —— 约 530 净行是净删除，不是搬家。

`docs:check` 检查四件事：markdown 链接目标存在 / 反引号里的仓库路径真实存在 / 每个 `make X` 有 target / 每个 `src/routes/*.ts` 被 `docs/API.md` 索引。

**实测本地跑这个脚本：39 条错误**（CLAUDE.md 19 条路径失效 + `docs/API.md` 未索引 19 个路由模块）。其中最糟的是 **§11 约束测试表 12 处引用 `tests/units/`，而这个目录根本不存在**（实际是 `tests/` 下 119 个扁平文件）—— 整节是死内容。

> 更正：我此前说"CLAUDE.md 描述 schema 40"是错的。它写的是"以 `SCHEMA_VERSION` 常量为准，勿在文档中硬编码"，这一条本地做对了。真正的缺口是**表清单**（8 张已建的表零提及）。

| 选项 | 后果 |
|---|---|
| **A. 采纳 upstream 349 行骨架 + docs:check**，本地独有内容按它的粒度重写（落在 400–450 行） | 漂移面积大幅缩小；要重写 §2/§5/§7 全部枚举表 |
| **B. 保留 904 行详尽风格，不采纳 docs:check** | 改动小；继续承担漂移（本次已证明是真实的：13 行测试表全死） |
| **C. 补差量但不改结构，也不加门禁** | 最省事；下次照样漂 |

**本地独有、upstream 结构里没位置、必须新开节的**：§8.14 Grok 运行时（40 行）· §3.4 容器挂载策略表（安全边界，`ACL-MATRIX.md` 不覆盖挂载层）· §10 Plugin 接入的 9 条踩坑记录 · 禁止手动创建 launchd plist。

**必须新补的**：8 张已建表 · `privacy_mode` · pm2/launchd 运行模型 · `agent_profiles` 的"有表无入口"半落地状态 · 三运行时能力矩阵。

> 附带纠正两条：「禁 lsof kill」upstream CLAUDE.md:322 有一模一样的规则（两边独立写出）；pm2 在本地 CLAUDE.md 和 README **出现 0 次**，那不是本地约束，是文档缺口。

#### D4.11a ❓ `docs/ACL-MATRIX.md` / `docs/API.md` 怎么处置

这两份本地**自分叉起零修改**，取 upstream 版零冲突 —— **但文档立刻描述本地不存在的东西**（`channel_accounts` 13 个端点、`task-acl.ts`、owner-only ACL、`interaction_mode`），从"过时"换成"虚构"。

### D4.12 ✅ 隐私模式 → 下线，改成普通工作区

#### D4.12a ❓ 那 1 个隐私工作区怎么转

实测：20 个文件有 privacy 相关代码，**实际启用的工作区 1 个**。

| 选项 | 后果 |
|---|---|
| **A. 直接把 `privacy_mode` 置 0，代码整体清掉** | 干净；该工作区历史上被跳过的归档/turn_events 不会补回来 |
| **B. 先导出该工作区内容再转** | 保住数据；多一步 |

### D4.13 ✅ RuntimeCapability 能力矩阵 → 建

已知至少 3 处需要门控：upstream 的"缺 `ANTHROPIC_MODEL` 就 fail-fast"（Grok 没这个变量）· `context-budget` 走 Claude SDK control request · `pendingBgTasks` 挂流。

**顺带承接 D4.2**：这张表同时记"当前 SDK 有没有 Y"，用运行时探测替代版本判断。

### D4.14 ❓ `disableMemoryLayer` 开关存废

主进程侧注入被**静默整块删除**（`hostEnv['HAPPYCLAW_DISABLE_MEMORY_LAYER']` + `REQUIRED_SETTINGS_ENV` 逐项注入 + `HAPPYCLAW_USER_MCP_SERVERS_JSON` + 计算本身）。设置项在 `schemas.ts` / `runtime-config.ts` 仍在但**无消费方** —— 又一个幽灵设置。同 hunk 里 `SUBAGENT_MODEL` 注入也被删。

| 选项 | 后果 |
|---|---|
| **A. 补回注入** | 开关继续可用 |
| **B. 连设置项一起删** | 干净；失去这个能力 |

### D4.15 ❓ stop/interrupt 的 ACL

`currentRunInitiator` 字段和 `getActiveRunInitiator()` 静默删除 → 从 owner-OR-initiator 退回 **owner-only**。`tests/group-queue-initiator.test.ts` 一并删除。

**附带**：`state.currentRunInitiator = null` 的赋值残留在冲突区 HEAD 侧，按 HEAD 解会引用已删字段 → typecheck 失败。

### D4.16 ❓ 15 秒 channel reliability 循环

`index.ts:19488` 无条件 `setInterval(15000)` —— 没有 SystemSettings 开关、没有 env 门控。空表下 no-op，但写 **5760 条/天**日志。你刚修过日志膨胀。

另：`cleanupChannelReliability()` **生产代码零调用**（只有测试调），五张表只增不删。

| 选项 | 后果 |
|---|---|
| **A. 加 SystemSettings 开关** | 可关；偏离 upstream |
| **B. 拉长到 60s + 降 debug 级** | 日志减 96%；仍在跑 |
| **C. 原样** | 与 upstream 一致；日志膨胀 |

### D4.17 ❓ `PRAGMA foreign_keys = ON`

本地当前 `foreign_key_check` 干净 → 开启后会保持 ON。此后往 `messages` 写 `chats` 里不存在的 `chat_jid` 会**直接抛错**而不是静默成功。带 FK 的表：`messages` / `task_run_logs` / `invite_codes` / `user_sessions` / `user_subscriptions` / `user_balances`。

fail-fast vs 宽容。如果有"先写 message 再建 chat"的路径，会在运行时暴露。

---

## 第 5 层 · 行为细节与观感

### D5.1 ❓ 渠道自动注册的补法 —— **实测发现微信会断线**

**存量影响 = 0**：discord / whatsapp / dingtalk 本地**各 0 个已注册会话、0 条消息**，从没用过。已注册会话不受影响（resolver 能解出路由，`onNewChat` 幂等 no-op）。

**⚠️ 但漏了一个渠道**：upstream 的 `wechat.ts:852` **不走** `evaluateChannelAdmission`，自己写的是 `if (!(opts.isChatAuthorized?.(jid) ?? false))` —— **缺失即拦截（fail-closed）**。而微信本地是活跃渠道（**3 个会话 / 732 条消息 / 最后活跃 07-22**），不传回调会**全线断**。

其余渠道走 `channel-admission.ts` 的 `evaluateChannelAdmission`，注释写明 "Channels without an authorization callback retain their legacy open behavior" → **缺失即放行（fail-open）**。两套语义不一致。

**真正的卡点不是 `isChatAuthorized`，是 `onNewChat` 的位置**：本地 `buildResolveEffectiveChatJid()`（`index.ts:9949`）第一句就是「查不到 group 就 return null」，而 `onNewChat` 排在 `resolveAdmittedChannelRoute` **之后** → 未注册 → resolver 返回 null → 消息被丢 → `onNewChat` 永远跑不到 → **自动注册死锁**。

upstream 自己不撞坑，是因为它给这三个渠道都传了回调；**且单独给 feishu 加了 P2P 逃生口**（`feishu.ts:2221`，p2p 且 resolver 返回 null 时先调一次 `onNewChat` 再解析，注释明说"没有这段，全新 P2P 会话会永远 fail-closed"）—— discord / whatsapp / dingtalk **没有**这个逃生口。

| 选项 | 改动点 | 用户操作变化 |
|---|---|---|
| **A. 补配对码** | `index.ts` 6 处 + `im-manager.ts` 3 个 options 类型透传；若一并修 wechat 再 +2 | 新会话首条消息收到「此聊天尚未配对」→ 回 Web 设置页生成 6 位码 → 5 分钟内发 `/pair XXXXXX`。**每个新群/私聊都要走一遍**（按 jid 逐会话判定） |
| **B. `isChatAuthorized` 恒 true** | 1 处 | ❌ **解决不了** —— 卡点在 resolver 不在 admission，恒 true 后仍被 `resolveAdmittedChannelRoute` 丢 |
| **C. `onNewChat` 挪回路由解析之前** | 三个渠道各 1 处代码块移动（需从 upstream 版反改） | 无感知，保持"发消息即注册" |
| **C'. 照 feishu 加 P2P 逃生口** | 三个渠道各 +1 个 if 块（约 6 行），语义与 upstream feishu 一致 | 同 C；群聊仍靠 bot-added 事件 |

> 现有配对码 UX：6 位大写字母数字，**TTL 5 分钟、一次性、纯内存不落盘（服务重启即全失效）**，每用户同时只有一个有效码。

### D5.2 ❓ `MAX_STREAMING_CONTENT` `100000 → 30000`

**只影响打字机过程，不影响最终结果。** 这个常量只作用于 Level 0 流式后端的**单次推送 payload 上限**；收尾走 `finalizeStreamingCard()`，用完整的 `accumulatedText`，超限就拆成多张续卡 —— 两版行为一致。

**实测本地 7421 条 agent 回复（134 天）**：

```
p50 378  ·  p90 2014  ·  p95 2669  ·  p99 6110  ·  p99.9 17855  ·  max 49225

>30000（改后会被限）：  3 条  = 0.040%   其中飞书渠道仅 1 条（2026-03-15）
>100000（现在就被限）： 0 条
```

**频率：全渠道约 45 天一次，飞书约 134 天一次。**

用户看到的差别：极长回复流到 30000 时卡片正文暂停增长、尾部挂提示，**turn 结束后仍完整展示**。也就是最后那 30000–49225 一段看不到实时逐字，要等收尾。

**不是静默改，有明确理由** —— commit `64fc77a`（2026-07-23）注释：官方 SDK 用 30K 保守 live-element 预算，留余量给 Markdown fence 修复，避免长跑到最后被飞书 API 拒收。同时把裸 `slice()` 换成 `splitCodeBlockSafe()`。

### D5.3 ❓ 飞书 typing 指示 —— **净效果是修 bug，不是减功能**

本地有**两套** OnIt，别混：

| | 打在哪 | 用户日常可见？ |
|---|---|---|
| **(a) Ack 表情**（`feishu.ts:1447`） | 用户刚发的那条消息 | ✅ **每条消息都看得到**。upstream **保留**，只是改成按 inbound message 精确记账 |
| **(b) Typing 表情**（`sendReaction`，`feishu.ts:2142`） | 该会话最后一条消息 | ❌ `index.ts:2944` 有短路：**流式卡片活着时根本不发**（注释："the card itself serves as a live typing indicator"） |

被删的是 (b)，而它在正常飞书路径下几乎从不触发。

**(a) 现有的 bug**：`ackReactionByChat` 按 chat 单格，同会话上一轮 clear 之前又来一条消息 → `.set()` 覆盖 → **前一个 reactionId 永久泄漏**，那个 OnIt 再也摘不掉。upstream 的 `ExactAsyncIndicatorRegistry` 按 `(route, inputMessageId)` 精确配对就是修这个。

**净变化**：同会话连发多条时漏掉的 OnIt 以后能正常摘掉。可察觉性低，且是往好的方向。仅在"流式卡片创建失败降级到非流式"这个罕见分支下才会少一个表情。

### D5.4 ❓ 容器内 agent 自建的 skill —— **本地 0 个，且 upstream 不是删是隔离**

**实测**：36 个 session 的 `.claude/skills` 共 **1405 条，全部是符号链接，非符号链接 0 条**。**本地没有任何 agent 自建 skill，这一项零影响。**

**且 upstream 不删**：主进程侧 `reconcileSessionSkills()` 在容器启动**之前**就跑了，对非符号链接条目是 **`fs.renameSync` 移到 `{sessionDir}/.claude/orphaned-skills/{ISO时间戳}/`** 并产生 audit warning，不是删除。entrypoint 的 `rm -rf` 是第二道兜底，跑到时目录已空。实际损失是"skill 从下次会话起不再生效"，文件还在硬盘上。

**`install_skill` 装的不受影响** —— 它写宿主机 `data/skills/{userId}/`（挂载来源层），不碰 `.claude/skills` 目标层。

**挂载 2 → 36 个：实测零开销**（本机 Docker 29.4.0 / OrbStack，各 10 次取平均）：

```
2 个挂载   0.170s / 0.166s        36 个挂载  0.167s     ← 差值在噪声内
100 个     0.198s     200 个 0.183s     400 个 0.215s   ← 没有悬崖
```

**⚠️ 真正的硬约束**：`data/builtin-skills/` 和 `data/skills/{userId}/` 有 **7 个同名 skill**（`feishu-cli-export` / `-board` / `-toolkit` / `-vc` / `-read` / `-auth` / `-import`）。不去重直接挂会 `docker: Duplicate mount point`，**容器起不来**。upstream 靠 `resolveEffectiveSkills` 的 precedence 去重 —— **这个去重是硬依赖，不能只搬 mount 循环不搬 resolver**。

### D5.5 ❓ 首屏主题默认反转 —— **一次性，一次点击解决**

| localStorage 状态 | 现在 | 改后 | 受影响 |
|---|---|---|---|
| **无 key**（从没在设置里选过） | 跟随系统 | **恒浅色** | ✅ **仅此一类，且需系统本身是深色才看得出** |
| `'system'` / `'light'` / `'dark'` | 各自 | 不变 | ❌ |

**服务端零存储** —— `users` 表实测 23 列，无任何 theme/appearance 列，`db.ts` / `routes/auth.ts` grep "theme" 零命中。纯 `localStorage`（key `happyclaw-theme`），per-origin per-browser（换浏览器/换设备/清过站点数据都算"无 key"）。

内联脚本和 hook 两边同步改了，**不会 FOUC 闪烁不一致**。

改回来：设置 → 个人资料 → 主题，点「深色」或「系统」，一次点击永久生效。

---

## 第 6 层 · 现在无影响，只需知悉（不用决策）

| 项 | 为什么现在没事 | 什么时候会有事 |
|---|---|---|
| per-message 插件运行时属主修复被撤销（`runtime-owner.ts` 整个文件删除 + 3 个测试删除） | 只有 1 个 admin，混批场景不存在 | 加第二个 admin 时 |
| `lastCommittedCursor` 迁移保护网删除 | 实测两张游标表各 69 key、**缺口为 0** | 将来出现缺口时会全量重放该 chat 历史 |
| `ensureUserHomeGroup` 第二个 admin 拿 `home-{uuid}` 而非复用 main | 只有 1 个 admin | 加第二个 admin 时。**且不再修补已存在 `web:main` 的 `executionMode='host'`** |
| v58 把 10 个飞书会话设成 `owner_only` | 已查证：这 10 个群的 `sender_allowlist` **恰好只有 owner 本人**，等价变换 | — |
| `MIN_INTERVAL_MS = 60_000` | 零个 interval 任务，10 个 cron 全是 5 段无秒字段 | 将来建亚分钟任务时 |
| 29 行 `workspaces` 删除 | 全是 IM jid，`src/` 里除 `db.ts` 外零读取；本地当初是过度投影 | 若将来要按 IM jid 查 workspace |

---

## 纯执行项（不需要决策，但必须做）

| 项 | 说明 |
|---|---|
| `capability-runtime-mutation.ts:103` 的 `deps.sessions` | 唯一"解冲突也修不掉"的编译断裂 |
| 隔离任务 `tasks-run/` 目录清理被删 | 泄漏，补回来 |
| 微信代理绕过删除导致的编译断裂 | `index.ts:20,10597` + `routes/config.ts:11,3657` 仍引用已删符号 |
| 三个 prompt 文件被删 | 本地 `index.ts` 仍在 load → `check-agent-runner-prompts.sh` 挂 |
| `shared/stream-event.ts` 解完必须 `make sync-types` | 4 份副本全冲突 |
| `./container/build.sh` 重建镜像 | D5.4 的 Skills 挂载模型 |
| `group-owner.ts` 依赖的两个字段 | `RegisteredGroup.owner_claim_source` / `audience_mode` 本地类型和表都没有 → TS2339 |
| `index.ts:2234` 的 `maxHostProcesses` | upstream 从 `QueueStatusInfo` 删了这个字段 🔗 D4.3b |
| `tests/im-command-utils.test.ts:53` | `'主对话'` → `'主会话'` |

---

## 已确认的虚惊（核实后无影响，不必再考虑）

| 项 | 结论 |
|---|---|
| **143 处"守卫被删"** | 逐个核对，**没有一处真取消保护**。全是 upstream 把入站 handler 整段包进 `try/finally`（缩进 +2）+ prettier 压行造成的假象 |
| `adminRoleMiddleware` 去 null 检查 | `authMiddleware` 保证 user 一定被 set，未认证在上一层就 401 |
| `load-env.ts` 代理注入 | 本机**完全 no-op** —— plist / launchd 脚本 / `.env` / shell 全无 proxy 变量，守卫为 false |
| 2 个 MCP server 迁移 | lark-mcp / feishu-doc-edit 都没有 `env`/`headers`，不触发迁移分支 |
| 用户删除语义 | 本地**已经是软删**，`restoreUser()` 也已存在 |
| 五处 `DROP TABLE` | 两处静默的是 base 早有且有门（45 不触发），三处 upstream 新增的都落在冲突标记内（人会看到） |
| `parseGroupRow` fail-closed | diff 显示 `-89/+534`，核实合并结果**语义保留** |
