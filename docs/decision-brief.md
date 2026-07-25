# HappyClaw 现状梳理与决策清单

> 2026-07-24 · 本文汇总本轮排查与讨论的全部结论
> 技术细节见 [upstream-compat-design.md](./upstream-compat-design.md)

---

## 一、你的架构判断（本轮讨论形成）

### 1. Agent-first 是合理方向

Claude / Codex 的 runtime 已是成熟 agent server（会话、上下文、子 Agent、工具编排、权限、MCP 全都自带）。HappyClaw 早期做的部分工作（上下文压缩等）与之 overlap。

**推论**：HappyClaw 应从"agent 框架"退回"agent 运营者"——多租户、渠道、调度、身份、持久化、路由。upstream 的 Agent-first 正是这个定位的数据模型表达。

### 2. runtime 易变，personal 数据无价

**推论**：conversation 归档、memory 更新、CLAUDE.md 更新这类数据资产能力，不能挂在 runtime 的内部事件上（如 PreCompact hook）。资产层必须由 HappyClaw 自己的触发器驱动。

### 3. 归档已在多 runtime 化时下线，改靠 DB 持久化

**已核实**：不是全局关闭，而是降级为 Claude 专属能力——`codex-cli-runner.ts:581` 与 `grok-cli-runner.ts:159` 各有一行 `supportsPreCompactHook: false`。

### 4. subagents / toolcall 的问题是执行稳定性，不是归档

**已核实且找到确切根因**，见 §2 的 P1。

---

## 二、当前问题清单

### A 类 · 执行稳定性（最痛，根因已确认）

#### P1 · 后台子 Agent 被过早关流杀死 ⚠️ 单一根因

```ts
// container/agent-runner/src/index.ts:1291, :1358
const POST_RESULT_TIMEOUT_MS = 5_000;
if (resultReceivedAt && Date.now() - resultReceivedAt > POST_RESULT_TIMEOUT_MS) {
  log(`Post-result timeout (5s), closing stream`);
  interruptQueryForShutdown('Post-result timeout');
  stream.end();
}
```

主 Agent 输出最终文本后 **5 秒无条件关流**，后台子 Agent 被连坐 interrupt。本地 `getPendingSdkTaskCount` / `describePendingSdkTasks` 出现次数 **0 / 0** —— 根本没有能力知道还有几个后台任务在跑。

**实测受害清单**（从工作区日志捞出）：

| 被杀的后台 Agent | 次数 |
|---|---|
| `AI music generation research` | 2 |
| `认知维度提取` / `知识维度提取` / `交互维度提取` | 各 1 |
| `Cognitive / Knowledge / Interaction extraction round 2` | 各 1 |

- **认知管线两轮共 6 个子 Agent 全灭** —— 个人知识资产管道一直在静默失败
- `AI music generation research` 就是 7-24 11:12 在水酉为酒发的调研任务

**这是"稍微长点的任务都会失败"的单一根因**：任务越长越依赖后台子 Agent 分工，而分工必被杀。

> 更正：此前把该问题归因于"上下文压缩制造 query 边界导致 `pendingAgentResults` 内存 map 清空"。该机制存在但**是次要的**——正常一问一答即足以杀死子 Agent，不需要压缩参与。日志里的 `No completion record was found` 是 SDK 下一轮 resume 时发现孤儿的**尸检报告，不是死因**。

**upstream 已修**：`0cc9993`，有后台任务未完成则 `resultReceivedAt = null` 撤销倒计时，流保持打开。**不引入新表、不改数据模型，可独立摘取。**

### B 类 · 会话隔离（造成工作丢失）

| # | 问题 | 位置 | upstream 最新版 |
|---|---|---|---|
| P2 | 重置任一对话 force-kill 同 folder 全部运行进程 | `routes/groups.ts:1090` | 一字不差，未修 |
| P3 | 中断跨会话打断（实现与自身注释矛盾） | `group-queue.ts:929` | 一字不差，未修 |

根因是**建模失败**：channel→workspace 绑定经由 `folder`，而 `folder=main` 挂了 **24 个 JID**（web:main + 飞书私聊 + 22 个飞书群 + QQ）。其中 21 个飞书群已有 `target_main_jid` 指向自己的独立工作区，但 `folder` 列仍是 `main`——**路由上独立，注册上仍是 main 的兄弟**。

6 月串台事故的修复（三层纵深防御 + 两次数据回填）修的是路由层，没动 folder 列。

**Agent-first 会消解这类问题**：`channel_mounts.workspace_jid` / `agent_channel_mounts.agent_profile_id` 显式绑定，`getJidsByFolder()` 这个查询不该存在。

### C 类 · 服务稳定性

#### P4 · EPIPE 拖垮整个服务

`logger.ts:28` 对**任何** uncaughtException 一律 `process.exit(1)`。7-19 01:54 实际发生过一次：飞书 503 撕连接 → 上传流异步抛 EPIPE（在 await 的 try/catch 之外）→ 进程死亡。EPIPE 是纯 I/O 事件，不破坏进程状态。upstream 未修。

### D 类 · 数据资产层（与你的理念直接冲突）

| # | 问题 | 实测证据 |
|---|---|---|
| P5 | conversation 归档触发条件极窄 | 触发需 Claude runtime + 单会话撞 ~190k token（日志：`Context: 189709/200000 (95.0%)`）。38 工作区仅 12 有过归档；main 停 6-10（44 天）；玄览今天仍活跃但最新归档 3-17（4 个月） |
| P6 | memory flush / CLAUDE.md 更新挂在 PreCompact 上 | `needsMemoryFlush = true` 全 agent-runner **仅一处赋值**，在 PreCompact hook 内。且有 `consecutiveCompactions === 0` 门——压缩三次只写一次 |
| P7 | 工具调用 / 子 Agent / thinking 零持久化 | `db.ts` 对 `streamEvent` 引用数 **0**；`agents` 表 **0 行**（SDK Task 子 Agent 是前端"虚拟 Agent"）；`MessageBubble` 只有 `thinkingContent` prop，无 toolUse/subAgent → **刷新即失** |
| P8 | 1M 上下文会进一步饿死 P5/P6 | 本地已支持 `opus-4.8-1m`（`6cabcfb`），撞阈值概率降约 5 倍 |

DB 本身健康：13718 条消息，3-14 至 7-24 连续，近 7 天每天有记录。但 13718 条中仅 **72 条**含 `tool_use`/`thinking` 痕迹——**DB 记住了"说了什么"，没记住"当时怎么做的"**。

飞书端部分幸存：`feishu-streaming-card.ts` 的 `subAgentResults` / `priorTextSegments` 会烘进定稿卡片的折叠面板（存在飞书服务器上）。同一次对话，飞书能翻到子 Agent 结果，Web 刷新就没了。

### E 类 · 环境与运维

| # | 问题 | 状态 |
|---|---|---|
| P9 | devDeps 被裁剪 → 后端 typecheck 红、`make test`/`format` 不可用 | **由 launchd 迁移引入**：plist 有 `NODE_ENV=production`，`launchd-start.sh` 每次启动跑 `npm update` → npm 连带 prune devDependencies |
| P10 | SDK 0.3.215 改 `Query.interrupt()` 返回类型 → agent-runner typecheck 红 | `tsc` 带错仍输出 JS，运行时正常，门禁红 |
| P11 | 日志无轮转 | 92MB + 28MB，约 9MB/天 |
| P12 | 僵尸 Chrome（agent-browser） | 已止血（曾 43 个 / 772% CPU），根因未定位 |
| P13 | 幽灵"执行中"、kill 重开仍卡 | `data/streaming-buffer/` 今天仍有孤儿文件（内容是认知管线起子 Agent 那一刻），与 P1 同源 |

**P9 + P10 使两条 typecheck 门禁在合并前就已是红的**——若直接开始合并，无法区分合并引入的破坏与存量破坏。

---

## 三、upstream 改动全景

### 主线：Agent-first 架构范式转变

102 个提交中近半属于这条主线（`Implement agent-first workspace architecture`、`agent-first: *` 三连、`feat: add conversational agent builder` 等）。

| | 旧模型（= 本地现状） | upstream 新模型 |
|---|---|---|
| 顶层实体 | 工作区 | **Agent Profile**（四段 prompt + 版本 + capability policy） |
| 归属 | 工作区属于用户 | **Agent 拥有工作区** |
| 渠道 | 注册到工作区 folder | **挂载到 Agent** |
| 创建 | 手动建工作区 | **对话式 Agent Builder** |
| 会话失效 | — | `identity_hash` 失配即重开 |

配套基础设施：`channel_accounts` 多账号、`channel_mounts` 路由策略、`task_runs` 租约作业队列、`usage_events` 幂等账本、messages 投递状态机、`workspaces` 投影层。

### 规模

| 指标 | 数值 |
|---|---|
| 变更 | 596 文件 / +158263 / −28200 |
| 冲突文件 | 51（`db.ts` 3214 行 / `index.ts` 1383 行 40 块） |
| schema | 本地 v40 vs upstream v60（分叉点 v39，两边的"40"不同源） |
| MCP 工具 | 共有 23；**upstream 独有 ~40**（飞书 10 + Agent Builder 7 + 任务扩展）；本地独有 0 |
| 测试 | upstream 262（191 独有）；本地 103（32 独有，全是多 runtime / 模型 / plugin-expander / 串台修复） |
| Skills | 本地独有 7；upstream 独有 0 |
| 运行时 | upstream `codex\|grok\|runtime-adapter` 文件数 = **0**，仍纯 Claude |

### 对本文问题的覆盖

| 问题 | upstream |
|---|---|
| P1 后台子 Agent 被杀 | **已修**（`0cc9993`，可独立摘取） |
| P2 / P3 会话隔离 | 未修（逐字节确认） |
| P4 EPIPE | 未修 |
| P5–P8 数据资产层 | 无此理念，未覆盖 |
| P12 / P13 | 未查证 |

### 冲突性质三分类

- **A 类 · 正交可组合**：运行时分发、模型/provider 选择、Agent 人格体系、RBAC、`agents` 实体、`messages` 加列、`workspaces` 投影层
  依据：`ContainerInput` 上 `agentProfile` 与 `runtime`/`providerId` 互不引用；`AgentProfileRuntimePolicy` 只含 context/skills/mcp，**无 model/provider/runtime 字段**
- **B 类 · 真冲突**（9 层）：任务执行、IM 账号、渠道绑定、投递可靠性、用量账本、会话语义、Skills 治理、上下文来源、流式卡片
- **C 类 · 不可兼容**：工作区共享——upstream `initDatabase()` 中**无条件** `DROP TABLE IF EXISTS group_members`（本地 32 行 / 22 处引用）

---

## 四、需要你决策的点

### D1 · P1 的修复方式

| 选项 | 影响 |
|---|---|
| 单独摘 `0cc9993` 的挂流机制 | 改动小（`StreamEventProcessor` 加后台任务计数 + 关流判定几行）；Codex/Grok 恒为 0 属自然降级；不依赖任何合并决策 |
| 等整体合并时一并带入 | 认知管线与调研任务在合并完成前持续失败 |
| 自行实现等价逻辑 | 不引入 upstream 代码，但需自己处理常驻任务永不 settle 的兜底 |

### D2 · P2 / P3 / P4 是自修还是等 Agent-first 消解

| 选项 | 影响 |
|---|---|
| 现在自修 | P2/P3/P4 改动均小，当天可完成；若后续迁移 Agent-first，P2/P3 的补丁作废 |
| 等 Agent-first 迁移消解 | 迁移期间继续丢工作；P4 与 Agent-first 无关，仍需单独修 |

### D3 · 是否采纳 Agent-first，以及采纳路径

| 方案 | 工作量 | 风险 | 说明 |
|---|---|---|---|
| **A 全面对齐** | 数周 | 极高 | 吸收全部，含替换调度器 + IM 配置层；同时动三条主路径 |
| **B 能力矩阵 + 分层取舍** | 1~2 周 | 中 | A 类直接组合，B 类逐层选边；先建 `RuntimeCapability` 抽象再合并 |
| **C 影子表双轨** | 中 | 低数据 / 中债务 | B 类不选边，本地为真相源，upstream 表做单向投影，完全可逆 |
| **D 无状态摘取** | 1~2 天 | 低 | 只取不改数据模型的 commit；与 upstream 差距继续拉大 |
| **E Agent-first 反向重基** | 数周 | 高 | 以 upstream 为 base，重新植入本地差异化轴；付一次代价回归主线，后续跟进变便宜 |

方案 E 的前置条件是数据资产层先剥离（见 D5），否则迁移风险从"功能待重植"升为"数据可能丢"。

### D4 · 多 runtime 在 Agent-first 下如何建模

若采纳 Agent-first，"同一 Agent 在 claude/codex/grok 间切换"的定位需要重新表达：

| 选项 | 说明 |
|---|---|
| 引擎路由作为 Agent 属性 | Agent 声明"可跑在哪些引擎上"，是 Agent-first 的自然延伸；需新增 upstream 完全没有的建模 |
| 维持会话级临时覆盖（现状） | 与 Agent-first 的"Agent 是稳定实体"有张力：切引擎时 Agent 连续性依赖 `conversation_handoff_summaries` 补偿 |

无论哪种，**跨 runtime 连续性（handoff）是任何 runtime 都不会提供的部分**，属本地永久增量价值，不是 overlap。

### D5 · 数据资产层剥离的范围与优先级

| 子项 | 说明 |
|---|---|
| 三件事的触发器改造 | 归档 / memory flush / CLAUDE.md 更新从 PreCompact 挪到 HappyClaw 自己的触发器（会话空闲、turn 计数、定时），三条 runtime 一视同仁 |
| `supportsPreCompactHook` 语义降级 | 从"要不要归档的开关"改为只表示"该 runtime 有无压缩事件"——capability flag 只描述引擎事实，不决定产品能力有无 |
| StreamEvent 持久化层 | 工具调用 / 子 Agent / thinking 落盘为 turn 级执行轨迹；同时给 P1 提供补救依据、给 P13 幽灵状态提供权威来源 |
| 认知管线是否成为唯一记忆写入路径 | 认知管线已是 DB 驱动 + 定时触发（`dc82179` 改 DB 数据源），与 PreCompact memory flush 目的重叠——是否退役后者 |

此项独立于合并决策，不论最终合不合都是净收益。

### D6 · B 类九层逐个选边

| 层 | 选项 |
|---|---|
| 渠道绑定 | upstream `channel_mounts` / 本地 `target_main_jid` |
| 投递可靠性 | upstream 状态机 / 不引入 |
| 飞书 MCP 工具（10 个） | 吸收 / 不吸收 |
| Agent 人格体系 | 吸收（A 类正交）/ 不吸收 |
| 会话语义 | 融合两边失效触发器（换引擎 OR 换人格）/ 二选一 |
| 上下文来源 | 融合（保留 `isAdminOwned` 作为 profile 默认值）/ 二选一 |
| 任务执行 | 本地（承载脚本任务/IM 回投/逾期窗口）/ upstream 租约队列 / 仅借鉴 `occurrence_key` 幂等约束 |
| IM 账号 | 本地文件单账号 / upstream DB 多账号状态机 |
| 用量账本 | 本地（计费/日报/认知管线依赖）/ upstream `usage_events` |
| Skills 治理 | 本地（含 7 个独有 Skill）/ upstream per-profile host skill policy |

### D7 · 工作区共享是否保留

产品决策。三种处置：

| 选项 | 后果 |
|---|---|
| 跟随 upstream 删除 | 失去共享工作区功能，32 行数据销毁 |
| 永久保留 | 每次合并需手动摘除那行无条件 DROP（易漏，后果不可逆） |
| 改名规避 | 改为 `workspace_members`，代价 22 处引用 + 迁移 |

---

## 四点五、决策树

标记：⚠️ = 不可逆（数据层面）· 🔍 = 验证门控（先查再定）

```
【第 0 层 · 无条件前置，不是决策】
  P9 恢复 devDeps  +  P10 修 SDK 类型  →  解锁两条 typecheck 门禁
  ※ 不做的话，下面所有决策的验证结果都不可信

【第 1 层 · 完全独立，现在就能定，与 fork 走向无关】
  ├─ F1 后台子 Agent 挂流怎么修          ← 用户体感最强
  │    ├─ 摘 upstream 0cc9993  ─┐
  │    ├─ 自研等价逻辑         ─┼→ 都要接着定 F2
  │    └─ 等合并一并带入        →  时间取决于第 3 层 M1
  │         └─ F2 常驻后台任务兜底
  │              ├─ 接受 IDLE/CONTAINER_TIMEOUT 兜底（卡片挂久，占并发槽）
  │              ├─ 加后台任务专用较短上限（dev server 类用法失效）
  │              └─ 区分可settle/常驻分别处理（判定错则随机杀任务）
  ├─ F5 EPIPE 放行范围
  │    ├─ uncaughtException 放行纯 I/O 错误
  │    ├─ 只给飞书上传路径加流防护（其他渠道会再现）
  │    └─ 两者都做
  └─ F6 SDK 自动更新策略（已咬两次）
       ├─ 保留自动 + 只修 --include=dev（类型破坏仍会再来）
       ├─ 保留自动 + 加 typecheck 门禁失败回滚
       └─ 改手动（改变 CLAUDE.md 既定策略）

【第 1.5 层 · 🔍 验证门控 —— 不是选择题，先查】
  └─ F3 / F4：核实 folder 列回填可行性（把所有读 folder 的消费方过一遍）
       ├─ 可行 → 直接回填 + 修自动注册路径。P2 与 P3 一起消失，无功能变化
       └─ 不可行 → 才进入选择题：
            ├─ 改重置语义（只停当前 runner，接受其他 runner 写已重置工作区）
            ├─ 保持现状 + UI 提示影响范围
            └─ 等 Agent-first 消解（期间继续丢工作）

【第 2 层 · 资产层 —— 独立于 fork 走向，但是路径 E 的强制前置】
  └─ A1 数据资产层剥离做到哪一层
       ├─ 全做
       │    ├─ A2 归档/记忆的新触发器
       │    │    ├─ 会话空闲（粒度细、贴合节奏、写入频繁）
       │    │    ├─ turn 计数阈值（可控、可能切断话题）
       │    │    ├─ 定时并入现有调度器（成本最低、当天进展延后）
       │    │    └─ 显式命令（完全可控、需记得触发）
       │    ├─ A3 StreamEvent 持久化粒度
       │    │    ├─ 全量：工具调用+参数+结果+thinking（可完整回溯"怎么做的"，磁盘最大）
       │    │    ├─ 摘要+子Agent结果（能回看做了什么，看不到推理）
       │    │    └─ 只子Agent结果（仅解决 P1 补救依据）
       │    └─ 保留期限：永久（无限增长）/ N 天 / 按工作区配额
       ├─ 只做触发器改造（记忆归档修好；执行轨迹仍刷新即失）
       └─ 不做（现状持续，随 1M 上下文普及继续恶化）

【第 3 层 · 根决策】
  R · 你还想不想跟 upstream 同步？
   │
   ├─ R1 回归主线（长期同步）
   │    └─ A4 = 采纳 Agent-first（此分支下为必然）
   │         ├─ 路径 E 反向重基 ⚠️（迁移 9 个月生产数据）
   │         │    ⚠ 强制前置：A1 必须选"全做"
   │         │       否则风险从「功能待重植」升级为「数据可能丢」
   │         │    └─ A5 必须选「引擎路由 = Agent 属性」
   │         │         （会话级覆盖与「Agent 是稳定实体」矛盾）
   │         └─ 路径 B 渐进吸收
   │              ├─ M2 要不要先建 RuntimeCapability 矩阵
   │              │    ├─ 建：以后 upstream 新特性自动降级，前期多 1~2 天
   │              │    └─ 不建：每次人工判断，漏一个即「对 grok 必炸」
   │              └─ M3 B 类逐层选边（10 个子决策，见 §四 D6）
   │
   ├─ R2 有选择地跟（拿有用的，保持自己方向）
   │    └─ A4 独立判断「我自己要不要这个抽象」
   │         ├─ 要 → 路径 B（同上 M2 / M3）
   │         └─ 不要
   │              ├─ 路径 C 影子表双轨 → M3 变为「逐层定投影方向」
   │              └─ 路径 D 无状态摘取 → 不需要 M3
   │                   ※ A5 保持会话级覆盖（现状）
   │
   └─ R3 彻底独立（不再跟 upstream）
        ├─ 只摘 F1 挂流，其余全自研
        ├─ A4 成为纯自主架构决策，与 upstream 无关
        └─ P2 / P3 / P4 必须自修（无消解路径可等）

【仅 R1 / R2 分支需要定】
  ├─ M4 工作区共享（32 行数据 / 22 处引用）
  │    ├─ 跟随 upstream 删除 ⚠️（数据销毁，不可逆）
  │    ├─ 永久保留（每次合并手动摘 DROP，漏一次不可逆）
  │    └─ 改名 workspace_members 规避（一次性改 22 处，之后永久安全）
  └─ M5 合并窗口与回滚界线 ⚠️（37 表 / 9 个月数据）
```

### 树的读法

- **第 0 层**先做，它不是决策。
- **第 1 层**四个决策彼此独立，也独立于 fork 走向，可以立刻定、立刻做。其中 F1 对应「长任务必失败」这个最痛的问题。
- **第 1.5 层**是查证而非选择——若 folder 回填可行，P2/P3 用极小代价消失，不必等任何架构决策。
- **第 2 层**独立于 fork 走向，但若第 3 层选路径 E，A1 必须先「全做」。
- **第 3 层**是最宽的分叉，R 一旦定下，A4 / A5 / 路径 / M3 的选项范围立刻收窄。



| 项 | 说明 |
|---|---|
| 恢复 devDeps（P9） | `npm install --include=dev`；长期给 `ensure-latest-sdk` 加 `--include=dev` 或把 `NODE_ENV=production` 从启动脚本环节剥离 |
| 修 SDK 类型（P10） | `queryRef` 声明改为从 SDK 推导类型 |
| 日志轮转（P11） | 加 rotate 或改 launchd 日志路径策略 |

P9 + P10 是所有后续验证的前置——两条 typecheck 门禁必须先绿，否则任何合并/修复的验证结果都不可信。

---

## 五、决策记录（最终）

> §四 与 §四点五 是审议过程；本节是结论。

### 修复类

| # | 决策 | 要点 |
|---|---|---|
| **F1** | 后台子 Agent 挂流 → **合并带入**（批次 2） | 不写自研代码；批次 2 排在前面，不必等整体合并完成 |
| **F2** | **raw 口径 + 挂起卡承载过程 + 结果单独发新消息** | 内容重复可接受。理由：飞书编辑消息不触发通知，静默追加会看不到。⚠️ 对 upstream 的本地增强，成为永久 diff |
| **F3** | **①②③**（db helper + 两处调用点 + 序列化键） | 不做 ④（自动注册防复发）——批次 7 会退役整套机制 |
| **F4** | 并入 F3 的 ③ | 序列化键取路由目标的 folder，让「从飞书侧中断」行为变正确 |
| **F5** | **只给飞书上传路径加流防护** | EPIPE 属偶发（9 天 1 次）；其他渠道同类问题日后再补 |
| **F6** | **加门禁** | 成本≈0：`npm run build` 已在跑 tsc，只是别再吞掉失败信号；要写的是失败回滚 |

### 架构类

| # | 决策 | 要点 |
|---|---|---|
| **A1** | 数据资产层剥离 **要做** | 路径 B 下非强制前置，仍安排在批次 5 之前 |
| **A2 + A1-d** | **归档/turn_events 连续写，无触发器**；**记忆并入认知管线，退役 PreCompact flush** | 关键认知：归档 = DB 连续写，触发器问题不存在。退役风险低——`memory_append` 是 Agent 自主调用的 MCP 工具，不依赖 PreCompact |
| **A3** | **方案 3**：DB 存元数据 + 大 payload 落文件 | 实测：`data/sessions/` 4.5 月 319 MB ≈ 2.3 MB/天，年化 ~850 MB |
| **A3-a** | thinking **留** | Claude ✓ / **Grok ✓**（`agent_thought_chunk`）/ Codex ✗ —— 2/3 可得 |
| **A3-b** | 保留期限 **先永久** | 按实际增长再定 |
| **A4** | **采纳 Agent-first** | 约束：数据不能丢 + 体验丝滑 |
| **A5** | 引擎选择 **留 session 级**，三层分离 | ① Agent Profile 存人格，`identity_hash` **只由人格决定**（不含引擎）→ 换引擎不集体失效会话 ② `conversation_runtime_state` 存会话级引擎，`/model` 不变 ③ 会话有效性 = `identityHash` 匹配 && `runtimeFingerprint` 匹配 |
| **A5** | 保住 per-runtime native session | claude→grok→claude 能续上原会话；合并 upstream 单条记录结构时容易丢 |
| **A5-Q1** | 同一 Agent 多工作区，记忆 **各自独立** | **人格可复用，记忆不流动**；需共享则改 agent 模板 |

### Merge 类

| # | 决策 | 要点 |
|---|---|---|
| **R** | **尽量兼容** | — |
| **M1** | **路径 B** | 本地已有 runtime 抽象层，upstream 没有。往「已有抽象」加数据模型，比往「无抽象」插入抽象容易；E 的失败模式（某路径静默走 Claude 分支）极难发现 |
| **M2** | RuntimeCapability 矩阵（B 的组成部分） | 前期 1~2 天，换后续每次合并不必逐个判断 |
| **M3** | 串台三层防御 **保留并迁移到 `channel_mounts`** | 风险在新模型下依然存在；upstream 无此防御 |
| **M4** | **跟随删除 `group_members`** | 已验证零感知：`created_by` 32/32 覆盖、`getUserMemberFolders` 死代码；需一并摘除 ChatView 成员面板（:870/:978）。删表**不影响**多人在 IM 群与同一 Bot 对话 |
| **M5** | **3 账户所有工作区一次性正确，零妥协** | 迁移前全量清单 + 脚本自动对账 + 在副本上真跑过回滚 |
| 顺序 | **按难度排序**，批次 0–9 | 批次 0–4 不需架构决策、不碰数据模型 |

### 运维类

| # | 决策 | 状态 |
|---|---|---|
| **P9** | 恢复 devDeps | ✅ 已执行，两条 typecheck 全绿、103 文件 / 1166 测试全过 |
| **P10** | `queryRef` 放宽为 `Promise<unknown>` | 已改未提交，待确认保留或 revert |
| **P12** | **a + b** | a=SKILL.md 强制 `close`；b=agent-runner 退出清理（需先读 agent-browser 源码） |
| **P11** | 日志轮转 | **未定** |

---

## 六、仍然开放的

### 已关闭

**O1 · Agent Profile 共享语义与失效处理** ✅

- **O1-a 影响半径**：**接受共享语义**（N 工作区 : 1 模板，照 upstream `workspace_agent_profiles` 的 `group_folder` 主键设计）
- **O1-b 失效处理**：**保留上下文，走 cache miss 回灌**（偏离 upstream）

**决策依据（硬证据）**：`systemPromptAppend` 由 8 个 piece 拼成，其中 `global-memory`（读 `/workspace/global/CLAUDE.md`，你的 12.5 KB）与 `memoryRecall` **本身就是动态的**。Agent 每次写全局记忆，前缀即失效——而代码里**没有任何逻辑因记忆变化去删 session**，会话照常 resume 只吃一次 cache miss。

⇒ **upstream 对「人格变化导致前缀失效」删整个会话，与它自己对「记忆变化导致前缀失效」的处理不自洽。** 两者是同一类事件。

**量级**：systemPrompt 约 6K–10K tokens（静态文件 2K + Skills 实测 4.1K–6.9K + 全局记忆），而典型 prefix 是 19 万 tokens（日志 `Context: 189709/200000`）。systemPrompt 只占 3–5%，但位于最前面，动它即废掉后面 95% 的历史缓存。实测 cache 命中率 99.97%（近 30 天 opus-4-6[1m]：cache 读 172 M / 写 18.7 M / 纯 input 0.057 M），说明这类失效实践中很少发生，成本是偶发一次性而非持续开销。

**实现范围**：摘掉 `resetMainSessionForAgentProfileMismatch` / `resetConversationSessionForAgentProfileMismatch` 两处**调用**；`hasSessionAgentProfileMismatch` 保留（改为只记日志，便于用量对账）；`sessions` 表的 `identity_hash` / `agent_profile_id` / `agent_profile_version` 三列照常写，投影不受影响。

### 仍需判断（2 项，均不阻塞）

**O2 · P11 日志轮转策略** —— 按大小还是天数、保留几份。

**O3 · P10 那处改动** —— 保留还是 revert（`queryRef` 类型放宽，已改未提交）。

### 已由调查解决（无需决策）

- **A5 双指纹挂哪张表**：upstream 通过 `ensureColumn('sessions','identity_hash')` 把它加在**本地已有的 `sessions` 表**上，`workspace_runtime_sessions` 只是投影；本地 per-runtime native session 在**另一张** `conversation_runtime_sessions` 表 → **两者不冲突**，直接加列即可
- **批次 4 的边界**：`065e874`（阻塞确认 + `update_task` + 幂等去重）只改 `mcp-tools.ts` / `index.ts` / `task-scheduler.ts`，**不碰 db.ts、不需要 `task_runs`**；租约队列表由另一个 commit（`2dbb553`）引入，属「任务执行保留本地」的不合范围 → **「任务执行保留本地」的决策不需要重新评估**

### 实现层待设计（不需拍板，动手前会先说明）

- A5 双指纹挂哪张表：本地 `sessions` 加列，或用 upstream `workspace_runtime_sessions` 改成 per-runtime 多条
- `turn_events` 字段、与 `messages` 关联方式、轨迹文件格式与目录布局
- 批次 7 对账脚本校验哪些不变量
- F3 的 SQL + 序列化键改动如何不破坏 `group-queue-initiator` / `group-queue-runtime-boundary`
- P12-b 的进程识别方式（待读 agent-browser 源码）
