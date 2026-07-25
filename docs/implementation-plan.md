# HappyClaw 落地方案

> 2026-07-25 · 决策依据见 [decision-brief.md](./decision-brief.md)，技术差异见 [upstream-compat-design.md](./upstream-compat-design.md)
> 分叉点 `39e651e` · upstream +102 · 本地 +73

---

## 第一部分 · 决策总表（22 项）

### 方向性

| # | 决策 |
|---|---|
| **R** | fork 定位：**尽量兼容** upstream |
| **A4** | **采纳 Agent-first**，硬约束：数据不能丢 + 体验丝滑 |
| **M1** | 路径 **B**（本地为 base，能力矩阵 + 分层取舍）。理由：本地已有 runtime 抽象层、upstream 没有；往「已有抽象」加数据模型比往「无抽象」插抽象容易 |
| **M2** | 建 **RuntimeCapability 矩阵**（B 的组成部分，前期 1~2 天） |
| 顺序 | 按（冲突体量 × 架构决策权重 × 数据风险）**升序** |

### 修复

| # | 决策 | 关键约束 |
|---|---|---|
| **F1** | 后台子 Agent 挂流 → **合并带入**（阶段 C 批次 2） | 不自研 |
| **F2** | **raw 口径**挂流 + 挂起卡承载过程 + **结果单独发新消息** | 内容重复可接受；本地增强，永久 diff |
| **F3** | **①②③**：db helper + 两处调用点 + 序列化键 | 不做 ④；阶段 E 批次 7 退役 |
| **F5** | **只**给飞书上传路径加流防护 | 其他渠道日后再补 |
| **F6** | SDK 自动更新**加门禁** | 成本≈0（tsc 已在跑），要写失败回滚 |
| **P12** | **a + b**：SKILL.md 强制 `close` + agent-runner 退出清理 | b 需先读 agent-browser 源码 |
| **O2** | 日志轮转：**每天一次，历史全保留** | launchd 须 truncate 而非 rename |

### 数据资产层

| # | 决策 | 关键数据 |
|---|---|---|
| **A1** | 剥离 **要做**，安排在阶段 E 之前 | — |
| **A2 + A1-d** | 归档 / turn_events = **连续写，无触发器**；记忆 **并入认知管线**，退役 PreCompact flush | `memory_append` 是 Agent 自主 MCP 工具，不依赖 PreCompact，退役风险低 |
| **A3** | **方案 3**：DB 存元数据 + 大 payload 落文件 | 实测 2.3 MB/天，年化 ~850 MB |
| **A3-a** | thinking **留** | Claude ✓ / Grok ✓（`agent_thought_chunk`）/ Codex ✗ |
| **A3-b** | 保留期限 **永久**，按实际增长再调 | — |

### Agent-first 语义

| # | 决策 | 依据 |
|---|---|---|
| **A5** | 引擎选择 **留 session 级**；`identity_hash` **只由人格决定**，不含引擎 | 换引擎不集体失效会话 |
| **A5** | 会话有效性 = `identityHash` 匹配 && `runtimeFingerprint` 匹配 | 双指纹加在**本地已有 `sessions` 表**；per-runtime native session 在 `conversation_runtime_sessions`，两者不冲突 |
| **A5-Q1** | 同一 Agent 多工作区，记忆 **各自独立** | **人格可复用，记忆不流动** |
| **O1-a** | Agent Profile **接受共享语义**（N 工作区 : 1 模板） | 照 upstream `workspace_agent_profiles` 设计 |
| **O1-b** | 人格变更时 **保留上下文，走 cache miss 回灌** | upstream 对「记忆变化导致前缀失效」是继续 resume，对「人格变化」却删会话 —— 同类事件两种处理，不自洽 |

### Merge 取舍

| 层 | 取 | 备注 |
|---|---|---|
| 渠道绑定 | **upstream** `channel_mounts` | 本地 `target_main_jid` 是补丁层 |
| 投递可靠性 | **upstream** | 纯加法，改善「发送失败无感知」 |
| 飞书 MCP 工具（10 个） | **upstream** | 纯增量 |
| Agent 人格体系 | **upstream** | A 类正交 |
| 会话语义 | **融合** | 两边失效触发器互补 |
| 上下文来源 | **融合** | 保留 `isAdminOwned` 作 profile 默认值 |
| 任务执行 | **本地** | 承载脚本任务 / IM 回投 / 逾期窗口；幂等去重不需 `task_runs`（已验证） |
| IM 账号 | **本地** | 9 个月加密凭据在文件里 |
| 用量账本 | **本地** | 计费 / 日报 / 认知管线三处依赖 |
| Skills 治理 | **本地** | 含 7 个本地独有 Skill |
| **M3** 串台三层防御 | **保留并迁移到新表** | upstream 无此防御 |
| **M4** `group_members` | **跟随删除** | 已验证零感知（`created_by` 32/32 覆盖、`getUserMemberFolders` 死代码）；须一并摘 ChatView 成员面板 |
| **M5** 迁移验收 | **3 账户所有工作区一次性正确，零妥协** | 脚本对账，不人工核对；回滚须在副本上真跑过 |

---

## 第二部分 · 落地方案

### 结构原则

**阶段 C 用 cherry-pick，阶段 E 才用 merge。** 这个区分很重要：`db.ts` 里那行无条件 `DROP TABLE IF EXISTS group_members` 只有在合并 db.ts 的迁移块时才会进来。阶段 C 精确挑 commit，不碰迁移块；阶段 E 才做真正的 merge，届时 M4 单列处理。

---

### 阶段 A · 门禁恢复（前置，~20 分钟）

| 步骤 | 内容 |
|---|---|
| A-1 | ~~P9 恢复 devDeps~~ ✅ 已完成（`npm install --include=dev`） |
| A-2 | **P10** `queryRef` 类型：`{ interrupt(): Promise<void> }` → `Promise<unknown>`，附注释说明为何不钉死返回类型 |

**验收**：`make typecheck` 三项目全绿 + `make test` 103 文件 / 1166 测试全过。

> 这是所有后续验证的基线。不绿则任何改动的验证结果都无法区分「新破坏」与「存量破坏」。

---

### 阶段 B · 独立修复（不依赖任何合并，1~1.5 天）

#### B-1 · F3 会话隔离（半天）

**改动**
1. `db.ts` 新增 `getJidsExecutingInFolder(folder)`：返回 folder 内、且 `target_main_jid` 为空或指向本 folder 的 jid
2. `routes/groups.ts:1092`（会话重置）、`:900`（删除工作区）改用新函数
3. `group-queue.ts` `serializationKeyResolver`：对有 `target_main_jid` 的 jid，键取**目标的 folder**

其余 28 处 `getJidsByFolder` 调用点**不动**——它们要的确实是「folder 列 = X」语义（ACL、model 绑定传播、cursor 推进、runtime 属性继承）。

**为什么 ② 与 ③ 必须同时做**：只改 ③ 会让重置 main 时那 21 个 jid 解析到各自目标 runner 然后停掉它们，比现状更糟。

**验收**
- `group-queue-initiator` / `group-queue-runtime-boundary` 两测试全绿
- 新增用例：有 `target_main_jid` 的 jid，序列化键 = 目标 folder
- 实测：从飞书群侧点重置，确认只停它路由到的工作区，`main` 正在跑的不受影响

**影响**：`folder` 列一个字节不动 → ACL（`web-context.ts:297/340`）、`30a240a` 的重路由特例、注册逻辑（`index.ts:8999`）全部零影响。

#### B-2 · F5 飞书上传流防护（~1 小时）

`feishu.ts` 的 `client.im.v1.image.create()` 调用外层加流级 error 防护——`await` 的 try/catch 抓不到异步 EPIPE（7-19 那次崩溃就是 503 撕连接后 2ms 抛出的）。

**验收**：单测模拟 503 + 连接中断，确认进程不退出。

#### B-3 · F6 SDK 更新门禁（~1 小时）

`Makefile:249` 现在是 `(cd ... && npm update && npm run build);` —— 结尾 `;` 让 make 只看最后一条命令退出码，构建失败被吞掉后照样打印「✅ 更新完成」。

**改动**：捕获 build 退出码，失败则 `npm install @anthropic-ai/claude-agent-sdk@<上一版本>` 回滚并明确报错。成本≈0（tsc 本来就在跑）。

#### B-4 · O2 日志轮转（~1 小时）

每天一次，历史全保留。launchd 的 `StandardOutPath` 直接持有 fd，**必须 truncate 不能 rename**（rename 后 launchd 继续写旧 inode，新文件永空）。做法：归档一份（压缩）后 `: > logfile`。

#### B-5 · P12 僵尸 Chrome（半天）

- **a**：`container/skills/agent-browser/SKILL.md` 加强制要求——任务结束必须 `agent-browser close`
- **b**：先读 agent-browser 源码确认进程标识方式（pid 文件？进程名标记？），再在 agent-runner 退出路径加清理。必须能区分「自己起的」和「用户自己的 Chrome」

**顺带**：清掉 `data/streaming-buffer/` 里那个孤儿文件。

---

### 阶段 C · 无状态摘取（cherry-pick，1~1.5 天）

不引入新表、不改数据模型。

#### 批次 1 · 纯机械

Windows 兼容三连 · 大文件上传 · 系统代理（`load-env.ts`）· better-sqlite3 ^11→^12 · PWA 缓存 · Web 浅色主题 · prettier

**验收**：`make test` + 启动健康检查。better-sqlite3 升级后须跑 DB 相关测试（原生模块重编译，Node 25.9 / ARM）。

#### 批次 2 · F1 + F2 + 流式质量（最高价值）

**F1 挂流**（`0cc9993`）：移植 `StreamEventProcessor` 的后台任务计数 + 关流判定。

```ts
// 现状：主答案到达 5 秒后无条件关流，后台子 Agent 被连坐 interrupt
const POST_RESULT_TIMEOUT_MS = 5_000;
// 改为：有 pending 后台任务则撤销倒计时
if (pendingBgTasks > 0) resultReceivedAt = null;
```

- **口径用 raw**（`getPendingSdkTaskCount`），backgrounded bash 也挂流，保证能汇报
- Codex/Grok 恒为 0，自然降级不误伤

**F2 完成通知**（本地增强）：挂起序列定稿时，除了追加进卡片，**额外发一条新消息**带结果。因为飞书编辑消息不触发通知，静默追加会看不到。

**流式质量五连**：挂起完成 · 断流续写 · 定稿剔除旁白 · 全渠道合并一条回复 · 后台任务不早杀

⚠️ **断流续写指纹必须 gate 到 claude runtime**——零 usage 指纹是按 Claude SSE 断流特征设计的，Codex/Grok 的 usage 缺失各有正常场景，套用会误判。
⚠️ **`d9d0548` 的 ANTHROPIC_MODEL fail-fast 必须 gate 到 claude runtime**——否则 Grok/Codex 会话启动即报「未配置模型」。

**验收**（这批是修你最痛问题的，验收要实测）
- 起一个委派后台子 Agent 的任务，确认**跑完并返回结果**
- 跑一轮认知管线，确认三个维度子 Agent **都有产出**（对照：现在 6/6 全灭）
- 起一个 backgrounded bash，确认卡片挂起 + 完成后收到新消息通知
- 跑一个 Codex turn 和一个 Grok turn，确认不受续写/挂起/fail-fast 波及

#### 批次 3 · 飞书 10 个 MCP 工具

`feishu_send_card` / `edit_message` / `recall_message` / `add_reaction` / `remove_reaction` / `get_chat` / `get_history` / `get_user` / `list_members` / `api_request`

纯加法（`mcp-tools.ts` 654 行冲突但都是追加）。落在 `createMcpToolCatalog()` 内即三运行时共享。

**验收**：飞书里实测 edit / recall / reaction / get_history。

#### 批次 4 · 定时任务加固（纯逻辑）

`065e874`（阻塞确认 + `update_task` + 幂等去重）· `c4ad5c0`（时区注入）· `ec62d7c`（触发框定堵递归增殖）· `ae42183`（CR 修复）

**已验证**：`065e874` 只改 `mcp-tools.ts` / `index.ts` / `task-scheduler.ts`，**不碰 db.ts、不需要 `task_runs`**。租约队列表由 `2dbb553` 引入，属「任务执行保留本地」不合范围。

**验收**：触发一条定时任务——只触发一次、回投 IM 一次、不增殖；Codex/Grok 经独立 MCP server 调 `update_task` 通路正常。

---

### 阶段 D · 资产层剥离（阶段 E 的前置）

「数据不能丢」这个硬约束要求资产层先脱离 runtime 耦合，否则 Agent-first 迁移的风险性质从「功能待重植」变成「数据可能丢」。

| 步骤 | 内容 |
|---|---|
| D-1 | `supportsPreCompactHook` 语义降级——只表示「该 runtime 有无压缩事件」，不再决定产品能力有无 |
| D-2 | 归档改为 **DB 连续写**（无需触发器）。DB 已有全量消息；`conversations/` 目录不再依赖 PreCompact |
| D-3 | 新增 `turn_events` 表 + turn 级轨迹文件：工具调用 / 子 Agent 结果 / thinking（Claude + Grok），DB 存元数据与文件引用 |
| D-4 | 记忆 / CLAUDE.md 更新**并入认知管线**（DB 驱动 + 定时），**退役 PreCompact memory flush** |

**待设计**（动手前会先出方案）：`turn_events` 字段、与 `messages` 的关联键、轨迹文件格式与目录布局。

**验收**
- 跑一个 Codex 会话和一个 Grok 会话，确认**都有**轨迹落盘（对照：现在这两条 runtime 归档为零）
- 刷新 Web 页面，确认历史消息能重建工具调用与子 Agent 面板
- 认知管线跑一轮后 CLAUDE.md 有更新

---

### 阶段 E · Agent-first（真正的 merge）

#### 批次 5 · Agent 人格体系 + O1-b + M4

- 引入 `agent_profiles` / `agent_profile_prompt_versions` / `agent_builder_drafts` / `workspace_agent_profiles` / `agent_channel_mounts`
- `sessions` 表加 `identity_hash` / `agent_profile_id` / `agent_profile_version` 三列
- **O1-b**：摘掉 `resetMainSessionForAgentProfileMismatch` / `resetConversationSessionForAgentProfileMismatch` 两处**调用**；`hasSessionAgentProfileMismatch` 保留但改为只记日志
- **M4**：这是第一个合并 db.ts 迁移块的批次 → 必须处理那行无条件 `DROP TABLE IF EXISTS group_members`，同时摘除 ChatView 的成员面板（`:870` / `:978`）与死代码
- 人格 prompt 经本地 `runtime-guidelines.ts` 接缝对三运行时分别注入（Claude 走 SDK systemPrompt、Codex 走 CLI 参数、Grok 走 ACP `_meta.rules`）

**验收**：建一个 Agent Profile，三条 runtime 都带上人格；改一次模板，确认**上下文保留**、只有那一轮 cache miss（用 `cache_creation_input_tokens` 对照）。

#### 批次 6 · workspaces 投影层

**验收**：投影与 `registered_groups` 全量对账一致。

#### 批次 7 · channel_mounts ← 唯一有数据迁移的批次

- 21 个 `target_main_jid` 绑定迁移到 `channel_mounts`
- **M3**：串台三层防御（`ChatProbe` 四态 / `decideHealthAction` / 保守 unbind）迁移到新表继续用
- **F3 补丁在此退役**：`getJidsExecutingInFolder` + 序列化键改动 + `target_main_jid` 一起删除

**M5 零妥协验收**
1. 迁移前导出全量清单：所有账户 × 所有工作区 × 绑定映射
2. 迁移后**脚本自动对账**（不人工核对），任何一条不一致即判失败
3. 回滚须在库副本上**真跑过一次**

#### 批次 8 · 投递可靠性

`messages` 加 `delivery_mode/status/run_id/priority/updated_at` + `delivery-contract.md` 提示词 + 投递状态机。

**验收**：制造一次发送失败，确认可见且可重试。注意与本地「微信发送失败可见」的既有改动对齐。

#### 批次 9 · 会话语义融合

两边失效触发器合成一个判定：

```
会话有效 = identityHash 匹配（人格未变）
        && runtimeFingerprint 匹配（runtime + providerId + resolvedModel 未变）
```

保住 per-runtime native session —— `claude → grok → claude` 能续上原会话。

---

### 不合并的

| 层 | 原因 |
|---|---|
| `task_runs` 租约队列（`2dbb553`） | 任务执行保留本地 |
| `channel_accounts` 多账号 | IM 账号保留本地 |
| `usage_events` 幂等账本 | 用量账本保留本地 |

---

## 第三部分 · 仍待你决策

| # | 内容 | 选项 |
|---|---|---|
| **S1** | 产出怎么提交 | 每批次一 commit 即时推 origin / 全部本地做完再推 / **分段**（阶段 A-C 随做随推，阶段 D-E 走分支） |
| **S2** | 要不要给 upstream 回馈 | 三个现成 PR 素材：挂起序列合并 usage 未写回 DB · Agent Profile 失效处理不自洽 · B1/B2 会话隔离缺陷 |

S1 影响我从阶段 A 开始就怎么组织提交，建议先定。S2 可以随时决定。

---

## 附 · 硬性 checklist

- [ ] 断流续写指纹 gate 到 claude runtime
- [ ] `d9d0548` ANTHROPIC_MODEL fail-fast gate 到 claude runtime
- [ ] 挂起完成依赖 `pendingBgTasks`，非 Claude 恒 0 —— 降级而非报错
- [ ] 阶段 E 前手动备份（勿依赖 upstream 的 `enforcePreMigrationBackup`）
- [ ] 本地独有列存活：`messages.cost_usd` / `task_id`、`agents.kind`
- [ ] 本地 10 张独有表完整；`provider_pool_model_options` = 33 行
- [ ] 7 个本地 Skills 未被覆盖
- [ ] 本地 32 个独有测试（20 个守多运行时）全绿
- [ ] `group_members` 那行无条件 DROP 已按 M4 处理
