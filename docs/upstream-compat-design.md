# HappyClaw × upstream 完整差异分析与兼容架构设计

> 2026-07-24 · **v3 全量穷举版**
> 硬约束：**保留本地三运行时（claude / codex / grok）**
> 分叉点 `39e651e`（2026-06-19）· upstream +102 · 本地 +73 · 596 文件 / +158263 −28200 / 51 冲突文件

---

## 第一部分 · 系统设计层：两个 fork 已是两个产品

穷举 102 + 73 个提交后，分歧不在实现细节，在**产品范式**。

### upstream 的主线：Agent-first 架构

有一条贯穿主线，占据 upstream 近半提交：

```
Implement agent-first workspace architecture
agent-first: align workspace ownership and agent capabilities
agent-first: harden workspace runtime architecture
agent-first: streamline settings and agent identity
feat: 完成 Agent 优先架构与合并质量加固
feat: add conversational agent builder
feat: enable agent builder across main agent sessions
feat: refine agent capabilities and workspace runtime
feat: improve agent runtime governance and workflow UX
feat: govern host skills per agent
```

**范式转变：从「工作区为中心」转向「Agent 为中心」。**

| | 旧模型（= 本地现状） | upstream 新模型 |
|---|---|---|
| 顶层实体 | 工作区（registered_groups） | **Agent Profile**（人格 + 能力 + 版本） |
| 归属 | 工作区属于用户 | **Agent 拥有工作区**（`workspaces.owner_user_id` + `workspace_agent_profiles`） |
| 渠道 | 群/私聊注册到工作区 folder | **渠道挂载到 Agent**（`agent_channel_mounts`） |
| 身份 | 用户级 `ai_name`/`ai_avatar_*` | Agent 级 identity/soul/agents/tools 四段 prompt + 版本化 |
| 创建方式 | 手动建工作区 | **对话式 Agent Builder**（`agent_builder_drafts` + 7 个 MCP 工具） |
| 会话失效 | — | `identity_hash` 失配即重开 |

配套的还有渠道多账号化、调度器工业化、投递可靠性——都是支撑"一个用户运营多个 Agent"这个新形态的基础设施。

### 本地的主线：多引擎 + 个人知识工作流

```
grok ACP runner / grok provider 账号池 / grok docker / grok 飞书卡
GPT Codex 模型切换运行时 / model provider 设置 UI / 模型目录
认知×知识×交互三维度统一管线 + /proposal Skill
日报数据采集脚本 + 认知提取重构 + ASR 语音转写
Per-Group 隐私模式 + PRIVATE.md 双层记忆
飞书卡片 token 拆分 / 分段文本 / 子任务折叠面板
macOS launchd 守护
```

**方向：把单个 Agent 的执行能力做深**——换引擎、换模型、深度定制输出、沉淀个人知识资产。

### 结论

upstream 在做**横向扩展**（一个人运营多个 Agent，每个 Agent 有独立人格/渠道/能力）。
本地在做**纵向深化**（一个 Agent，多种引擎，深度个人化工作流）。

两者不矛盾，但**基础设施的假设不同**，这才是合并困难的根源——不是代码冲突多，是两套代码在回答不同的问题。

---

## 第二部分 · 预期功能层：全量接口面差异

### 2.1 数据模型（21 表差异）

**本地独有 10 表**
```
provider_pools · provider_model_options · provider_pool_model_options   ← 多运行时模型目录（3 池 / 33 选项）
system_model_default · workspace_model_defaults                          ← 模型默认值
conversation_runtime_state · conversation_runtime_sessions               ← 会话级运行时绑定
conversation_handoff_summaries · conversation_context_summaries          ← 跨运行时交接
group_members                                                            ← 工作区共享（32 行）
```

**upstream 独有 11 表**
```
agent_profiles · agent_profile_prompt_versions · agent_builder_drafts    ← Agent 人格体系
workspace_agent_profiles · agent_channel_mounts                          ← Agent↔工作区↔渠道
channel_accounts · channel_mounts                                        ← 渠道多账号 + 路由策略
workspaces · workspace_runtime_sessions                                  ← 工作区规范层
task_runs                                                                ← 租约作业队列
usage_events                                                             ← 幂等用量事件账本
```

**共有表但列不同**

| 表 | 本地独有列 | upstream 独有列 |
|---|---|---|
| `messages` | `cost_usd`, `task_id` | `channel_context`, `delivery_mode/status/run_id/priority/updated_at` |
| `agents` | `kind` | — |
| `sessions` | （被 upstream 的 `workspace_runtime_sessions` 取代） | `agent_profile_id/version`, `identity_hash`, `workspace_jid` |

### 2.2 MCP 工具面 —— 最悬殊的一处

| | 数量 |
|---|---|
| 共有 | 23 |
| **upstream 独有** | **约 40** |
| 本地独有 | **0** |

upstream 新增的三大类：

- **飞书一等公民化（10 个）**：`feishu_send_card`、`feishu_edit_message`、`feishu_recall_message`、`feishu_add_reaction`、`feishu_remove_reaction`、`feishu_get_chat`、`feishu_get_history`、`feishu_get_user`、`feishu_list_members`、`feishu_api_request`
- **Agent Builder（7 个）**：`agent_profile_prepare/publish/discard/get/list`、`agent_profile_draft_get`、`agent_capability_catalog`
- **任务管理扩展**：`update_task`、`restore_task`、`run_task_now`、`stop_task_run`、`list_task_runs`（+ 各自的 `_result` 回执）
- 另有 `get_channel_context`

本地零独有——说明本地的差异化不在 Agent 可调用的工具面，而在执行引擎层。

### 2.3 路由 / 前端 / Store

| 层 | upstream 独有 | 本地独有 |
|---|---|---|
| 路由 | `agent-profiles.ts`、`channel-accounts.ts`、`workspaces.ts` | `agent-definitions.ts`、`model.ts` |
| 页面 | `AgentProfilesPage`、`CapabilitiesPage` | `AgentDefinitionsPage`、`GroupsPage` |
| Store | `agent-profiles`、`channel-accounts` | `agent-definitions`、`workspace-config` |

### 2.4 StreamEvent 协议

- **本地独有**：`assistant_text_boundary`、`sub_agent_result`、运行时枚举 `claude`/`codex`/`grok`
- **upstream 独有**：`agent_profile`、`workspace`、`channel`、`managed`、`platform`、`settings`、`hard_exceeded`、`queued`/`running`/`stopped`、`merged`、`warning`

### 2.5 系统配置项

- **upstream 独有**：`fallbackModel`（撞额度墙回退）、`mainAgentAutoCompactWindow/Percentage`、`mainAgentContextSource`、`aiAvatarMode/Url`
- **本地独有**：`grokAuthJson`/`codexAuthJson`/`openaiApiKey` 等凭据物化全套、`grokHomeDir`/`codexHomeDir`、`providerFamily`/`providerId`/`providerPoolId`/`runtime`、`subagentModel`、`autoCompactWindow`、`maxConcurrentHostProcesses`、`autoRemoveDeadImGroup`、`disableMemoryLayerForAdminHost`

### 2.6 提示词与 Skills

| | upstream 独有 | 本地独有 |
|---|---|---|
| prompts | `agent-builder.md`、`delivery-contract.md` | `agent-override.md`、`skill-routing.md` |
| container/skills | **无** | `agent-browser`、`create-feishu-workspace`、`daily-report`、`install-skill`、`post-test-cleanup`、`proposal`、`skill-creator` |

### 2.7 测试覆盖 —— 最能反映"各自想保证什么"

| | 文件数 | 独有 |
|---|---|---|
| 本地 | 103 | 32 |
| upstream | 262 | 191 |
| 共有 | — | 71 |

**本地 32 个独有测试全部集中在差异化能力上**：
`codex-*`（5）、`grok-*`（5）、`model-*`/`provider-pool`/`runtime-*`（10）、`plugin-expander-*`（3）、`classify-feishu-error` + `im-health-action`（串台修复）、`group-queue-runtime-boundary`

**upstream 191 个独有测试的分布**：
`agent-builder-*`/`agent-profile-*`（12）、`agent-runner-*`（14）、`channel-account-*`（9）、`task-*`（12，含 `task-run-idempotency`/`task-runs-v2`）、`wechat-*`（6）、`turn-*`（3）、`capability-*`（3）、`schema-v46/49/51/54/60`（5）

---

## 第三部分 · 实际效果层

### 3.1 合并能拿到什么

| 类别 | 具体 |
|---|---|
| 直接改善你反馈的问题 | **B3 子任务丢失**（挂流机制，本地完全没有）；**投递可靠性**（消息发失败无感知）；定时任务递归增殖 |
| 能力增强 | 飞书 10 个 MCP 工具、Agent Builder、渠道多账号、撞额度墙自动回退 |
| 稳定性 | 流式质量五连、Windows 兼容、大文件上传、系统代理、better-sqlite3 |

### 3.2 合并**拿不到**什么（逐字节确认）

| 问题 | 位置 | upstream 最新状态 |
|---|---|---|
| B1 重置误杀同 folder 全部对话 | `routes/groups.ts:1090` | 一字不差 |
| B2 中断跨会话打断 | `group-queue.ts:929` | 一字不差（含自相矛盾注释） |
| C1 EPIPE 拖垮整个服务 | `logger.ts:28` | 一字不差 |
| B4 SubAgent 结果灌主上下文 | — | 未处理 |

### 3.3 合并会**危及**什么

| 资产 | 风险 |
|---|---|
| `group_members`（32 行 / 22 处引用） | upstream **无条件** `DROP TABLE`，不可逆 |
| 三运行时（103 测试中 20 个守着它） | agent-runner 全部冲突需以本地架构为基底重解 |
| 模型目录（3 池 / 33 选项） | upstream 无对应概念，迁移中易被 agent_profiles 体系挤掉 |
| 认知管线 / 日报 / ASR | 依赖 `usage_records` 与消息粒度，受用量账本与挂起合并双重影响 |
| 隐私模式 | 依赖消息落盘时机，与投递状态机冲突面未知 |
| 7 个本地 Skills | upstream 无，需确保不被覆盖 |
| 串台修复（三层纵深 + 两次回填） | 与 `channel_mounts` 是同问题两解法 |

---

## 第四部分 · 兼容方案

### 冲突性质三分类

**A 类 · 正交可组合（直接吸收）**
运行时分发、模型/provider 选择、Agent 人格体系、RBAC、`agents` 实体、`messages` 加列、`workspaces` 投影层。
`ContainerInput` 上 `agentProfile` 与 `runtime`/`providerId` 互不引用；`AgentProfileRuntimePolicy` 只含 context/skills/mcp，**无 model/provider/runtime 字段**。

**B 类 · 真冲突（须选边或融合）**
任务执行（日志表 vs 租约队列）、IM 账号（文件单账号 vs DB 多账号状态机）、渠道绑定、投递可靠性、用量账本、会话语义、Skills 治理、上下文来源、流式卡片。

**C 类 · 不可兼容**
工作区共享（upstream 已删功能）。

### 方案

| | 思路 | 工作量 | 风险 | 拿到 / 放弃 |
|---|---|---|---|---|
| **A 全面对齐** | 吸收全部，含替换调度器 + IM 配置层 | 数周 | 极高 | 全部特性 + 长期同步 / 本地任务模型与 IM 配置重写 |
| **B 能力矩阵 + 分层取舍** ★ | A 类直接组合，B 类逐个选边，先建 `RuntimeCapability` 抽象再合并 | 1~2 周 | 中 | A 类全部 + B 类择优 + 长期可维护 / 落选侧特性 |
| **C 影子表双轨** | B 类不选边，本地为真相源，upstream 表做单向投影 | 中 | 低数据 / 中债务 | upstream UI 可跑 + 完全可逆 / 双写一致性负担 |
| **D 无状态摘取** | 只取不改数据模型的 commit | 1~2 天 | 低 | B3 缓解 + 稳定性修复 / 差距继续拉大 |

### 推荐：方案 B

```ts
// container/agent-runner/src/runtime-capability.ts
interface RuntimeCapability {
  sdkBackgroundTasks: boolean;    // 挂起完成 / getPendingSdkTaskCount
  truncationFingerprint: boolean; // 零 usage 断流检测
  autoCompaction: boolean;        // auto-compact + PreCompact hook
  hostClaudeContext: boolean;     // runtime_policy.context.source
  nativeResume: boolean;
  liveInput: boolean;             // 常驻 IPC vs 单 turn re-spawn
  pluginInjection: boolean;
}
```

upstream 特性一律 `if (caps.xxx)`，非 Claude 自动降级。附带收益：`d9d0548`（缺 ANTHROPIC_MODEL 即 fail-fast）这类"文本无冲突但对 grok 必炸"的改动由门控自动挡住。

### B 类逐层建议

| 层 | 建议 | 理由 |
|---|---|---|
| 渠道绑定 | upstream | `channel_mounts` 正是为"24 JID 挂 main"设计；本地 `target_main_jid` 是补丁层 |
| 投递可靠性 | upstream | 纯加法，直接改善"发送失败无感知" |
| 飞书 MCP 工具 | upstream | 10 个工具纯增量，与本地卡片定制不冲突 |
| Agent 人格体系 | upstream | A 类正交，可与本地模型层并存 |
| 会话语义 | **融合** | 失效触发器互补：换引擎 OR 换人格 → 重开 |
| 上下文来源 | **融合** | 保留本地 `isAdminOwned` 作为 profile 默认值来源 |
| 任务执行 | 本地 | 承载脚本任务/IM 回投/逾期窗口；可单独借鉴 `occurrence_key` 幂等约束 |
| IM 账号 | 本地 | 9 个月加密凭据在文件里；多账号是增强非修复 |
| 用量账本 | 本地 | 计费/日报/认知管线三处依赖 |
| Skills 治理 | 本地 | 与自动同步机制耦合，且本地有 7 个独有 Skill |
| 工作区共享 | **待定** | 产品决策 |

---

## 第五部分 · 与合并解耦的先行修复

B1 / B2 / C1 在 upstream 最新版逐字节确认未修，改动小、与任何方案无关，应先行处理。

---

## 附 · 合并期硬性 checklist

- [ ] 摘除或改写 `DROP TABLE IF EXISTS group_members`
- [ ] `d9d0548` 的 ANTHROPIC_MODEL fail-fast gate 到 claude runtime
- [ ] 断流续写指纹不得对 codex/grok 生效
- [ ] 挂起完成依赖 `pendingBgTasks`，非 Claude 恒 0 —— 降级而非报错
- [ ] 本地独有列存活：`messages.cost_usd`/`task_id`、`agents.kind`
- [ ] 本地 10 张独有表完整；`provider_pool_model_options` = 33 行
- [ ] `group_members` = 32 行（若保留）
- [ ] 7 个本地 Skills 未被覆盖
- [ ] 本地 32 个独有测试全绿（多运行时守门）
- [ ] 迁移前手动备份（勿依赖 `enforcePreMigrationBackup`）
