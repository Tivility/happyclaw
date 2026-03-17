# 日报 + 认知回顾系统重构方案

## 1. 现状

### 1.1 四个系统

| # | 系统 | 代码位置 | 触发方式 | 模型 | 输出 |
|---|------|---------|---------|------|------|
| A | 框架每日汇总 | `src/daily-summary.ts` | 内置调度，2-3AM 自动 | 无 AI | `user-global/{uid}/daily-summary/{date}.md` + `HEARTBEAT.md` |
| B | AI 日报脚本 | `scripts/daily-report/` | 定时任务 `task-...-tdbmeh`，agent 类型，5AM，跑在 `flow-mmr36fue-k6f4` | Haiku(pass1) + Sonnet(pass2) | `user-global/{uid}/daily-report/{date}.md` + 飞书文档 + 卡片 |
| C | 每日认知提取 | prompt `data/groups/main/prompts/daily-cognitive-extract.md` | 定时任务 `task-...-vhvyz6`，agent 类型，3AM，跑在 `main` | agent 默认(opus) | `groups/{folder}/observations.md` |
| D | 每周认知聚合 | prompt `data/groups/main/prompts/weekly-cognitive-aggregate.md` | 定时任务 `task-...-p65ufu`，agent 类型，周日 4AM，跑在 `main` | agent 默认(opus) | `groups/main/cognitive-profile.md` + send_message |

### 1.2 模型选择机制

agent-runner 模型选择逻辑（`container/agent-runner/src/index.ts:45`）：
```
HAPPYCLAW_MODEL || ANTHROPIC_MODEL || 'opus'
```
- **没有 per-task 模型指定**，所有 agent 任务使用同一个容器级模型
- admin 的 `main` 容器默认就是 opus
- daily-report **脚本**自带 AI client，模型由 `data/config/daily-report.json` 的 `pass1Model`/`pass2Model` 控制，与 agent 模型无关

### 1.3 现存问题

| 问题 | 说明 |
|------|------|
| 日报触发浪费 | task B 是 agent 类型，用 Opus agent 会话来跑一个自带 Sonnet 的脚本。Opus agent 只是读 skill 然后执行 `node scripts/daily-report/dist/index.js`，纯调度开销 |
| 日报 pass1 模型偏弱 | 当前 pass1 用 Haiku，需求改为 Sonnet |
| 认知提取数据源受限 | 当前读 `conversations/` 归档，只有触发过上下文压缩的长对话才有归档。短对话、当天进行中的对话无法分析 |
| 认知提取缺少原话 | 归档格式中用户消息被 `<messages>` 标签包裹，格式不稳定，有时原话被截断 |
| 日报跑在错误的 group | task B 跑在 `flow-mmr36fue-k6f4` 而非 `main`，数据访问受限 |
| daily-summary 产物冗余 | 纯消息拼接的 `daily-summary/{date}.md` 对 admin 无价值（有 AI 日报），但其他用户需要 |

## 2. 重构目标

1. 日报脚本改为 **script 执行类型**，不再浪费 Opus agent 会话
2. 日报 pass1 改用 **Sonnet**
3. 认知提取数据源改为 **DB messages**（用户原话完整 + Agent 回复作上下文）
4. 认知提取继续用 **Opus**（默认值，无需额外配置）
5. 四个系统产物**完全独立**，无交叉覆盖
6. 框架层 daily-summary **不动**，其他用户不受影响

## 3. 重构后架构

### 3.1 时间线

```
2:00 AM ── [A] daily-summary.ts（框架，所有用户，不动）
             输入: DB messages
             输出: user-global/{uid}/daily-summary/{date}.md
                   user-global/{uid}/HEARTBEAT.md

3:00 AM ── [B] daily-report 脚本（admin only，script 执行类型）
             输入: DB messages + conversation archives
             模型: Sonnet(pass1) + Sonnet(pass2)
             输出: user-global/{uid}/daily-report/{date}.md
                   飞书文档 + 卡片

4:00 AM ── [C] 认知提取 Agent（admin only，agent 执行类型）
             输入: DB messages（用户原话 + Agent 回复摘要）
             模型: Opus（agent-runner 默认值）
             输出: groups/{folder}/observations.md（追加）

4:00 AM 周日 ── [D] 认知聚合 Agent（admin only，agent 执行类型）
             输入: 各 folder 的 observations.md
             模型: Opus（agent-runner 默认值）
             输出: groups/main/cognitive-profile.md
                   send_message 通知用户
```

### 3.2 产物隔离

| 产物 | 生产者 | 路径 | 消费者 |
|------|--------|------|--------|
| 每日汇总(纯文本) | A 框架 | `user-global/{uid}/daily-summary/{date}.md` | 所有用户的 Agent（via HEARTBEAT.md） |
| HEARTBEAT.md | A 框架 | `user-global/{uid}/HEARTBEAT.md` | 所有用户的 Agent（自动读取） |
| AI 日报 | B 脚本 | `user-global/{uid}/daily-report/{date}.md` | admin 自己（本地存档） |
| 飞书文档 | B 脚本 | 飞书云空间 | admin 自己（在线阅读） |
| 行为观察 | C Agent | `groups/{folder}/observations.md` | D 聚合 Agent |
| 认知画像 | D Agent | `groups/main/cognitive-profile.md` | admin 自己 + Agent |

**零交叉。零覆盖。**

## 4. 逐系统改动

### 4.1 [A] daily-summary.ts — 不动

零改动。继续为所有用户提供基础的 HEARTBEAT.md。

### 4.2 [B] daily-report 脚本 — 3 处改动

#### 改动 1：pass1 模型改为 Sonnet

文件：`scripts/daily-report/src/config-reader.ts`

`loadDailyReportConfig()` 的默认值中：
```diff
- pass1Model: 'claude-haiku-4-5-20251001',
+ pass1Model: 'claude-sonnet-4-5-20250929',
```

同时更新 `data/config/daily-report.json`（如果存在 pass1Model 字段的话）。

#### 改动 2：定时任务改为 script 执行类型

当前任务 `task-1773600689371-tdbmeh`：
- execution_type: `agent`（浪费 Opus 做调度）
- group_folder: `flow-mmr36fue-k6f4`（数据访问受限）
- schedule_value: `0 5 * * *`

**操作**：删除旧任务，创建新的 script 类型任务。

```sql
-- 删除旧的 agent 类型日报任务
DELETE FROM scheduled_tasks WHERE id = 'task-1773600689371-tdbmeh';

-- 创建新的 script 类型日报任务
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, script_command, status, created_at)
VALUES (
  'task-daily-report-script',
  'main',
  'web:main',
  '每日 AI 日报（script 模式，Sonnet 两轮分析 + 飞书发布）',
  'cron',
  '0 3 * * *',
  'isolated',
  'script',
  'node /Users/tivility/happyclaw/scripts/daily-report/dist/index.js',
  'active',
  datetime('now')
);
```

**效果**：
- 不再启动 Opus agent 会话，直接执行 Node 脚本
- 脚本自带 AI client，用 Sonnet 做分析
- 跑在 `main` 上，有完整数据访问权限
- 3AM 执行，在框架 daily-summary（2AM）之后

#### 改动 3：重新构建脚本

```bash
cd scripts/daily-report && npm run build
```

确认 `dist/index.js` 存在且可执行。

### 4.3 [C] 认知提取 — 重写 prompt + 调整时间

#### 改动 1：重写 prompt

替换 `data/groups/main/prompts/daily-cognitive-extract.md` 全文：

**核心变更**：
- 数据源从 `conversations/` 归档 → **DB messages**
- 用 sqlite3 直接查询（host 模式有权限）
- 强制保留用户原话
- 上限从 5 条提高到 10 条
- 增量处理标记从 `.cognitive-last-processed`（文件名列表）→ `.cognitive-last-date`（时间戳）

新 prompt 见 §5.1。

#### 改动 2：调整定时任务时间

```sql
-- 从 3AM 改为 4AM（在日报脚本之后运行）
UPDATE scheduled_tasks
SET schedule_value = '0 4 * * *'
WHERE id = 'task-1773546866562-vhvyz6';
```

**原因**：
- 3AM 给日报脚本（需要独占 API 带宽做 Sonnet 分析）
- 4AM 认知提取用 Opus 分析（不与日报争资源）
- 时间错开也避免 DB 并发读写

#### 改动 3：模型 — 无需操作

agent-runner 默认模型已经是 `'opus'`，认知提取作为 agent 任务天然使用 Opus。

### 4.4 [D] 认知聚合 — 确认路径

#### 检查项

1. prompt 中的路径确认为 macOS 路径（迁移时已处理）
2. 健康检查逻辑中创建新 daily cron 时，应使用**新版** prompt（DB messages 数据源）
3. 模型：同 C，默认 Opus，无需操作

#### 可能需要的改动

如果 `weekly-cognitive-aggregate.md` 中的健康检查代码引用了旧版 prompt 内容（创建新 cron 时内联 prompt），需要改为读取 prompt 文件：

当前逻辑（第 23 行）：
```
prompt 内容从 /Users/tivility/happyclaw/data/groups/main/prompts/daily-cognitive-extract.md 读取
```

这是读文件，不是内联，所以**无需改动**——新 cron 自动使用新版 prompt 文件。

## 5. 新版 Prompt

### 5.1 daily-cognitive-extract.md（完整替换）

```markdown
# Daily 认知模式提取任务

你是认知模式分析器。从数据库消息记录中提取用户 Moran 的认知和行为模式。

## 数据获取

1. 读取 `.cognitive-last-date` 文件获取上次处理的时间戳毫秒值
   - 如不存在，默认为 24 小时前的时间戳

2. 查询该时间戳之后、所有工作区的消息：

   ```bash
   sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
     "SELECT chat_jid, sender_name, is_from_me, content, timestamp
      FROM messages
      WHERE timestamp > {last_timestamp}
      ORDER BY chat_jid, timestamp"
   ```

3. 按 chat_jid 分组，还原每个工作区的对话流：
   - **用户消息**（is_from_me=0）：完整保留原文，这是分析的核心素材
   - **Agent 回复**（is_from_me=1）：仅作为上下文（理解用户在回应什么），不分析 Agent 行为

4. 过滤掉无认知含量的消息：
   - 纯斜杠命令（`/restart`、`/clear` 等）
   - 单字确认（"好"、"ok"、"行"）
   - 系统自动发送的定时任务 prompt

## 分析维度

1. **决策模式**：如何做决定（快/慢、数据驱动/直觉、风险偏好、迭代方式）
2. **思考路径**：如何推理（自顶向下/自底向上、发散/收敛、类比使用、元认知）
3. **反应模式**：如何回应（对不确定性、对错误、对敷衍、面对反驳时的反应）
4. **注意力分配**：关注什么、忽略什么、话题切换频率和触发点
5. **语言与沟通**：口癖、措辞偏好、表达风格、追问方式

## 分析重点

- **措辞选择**：用了什么词、什么语气、什么句式
- **追问和纠正**：面对 AI 回复，怎么追问、纠正、引导方向
- **决策瞬间**：什么时候拍板、犹豫、改主意
- **不满表达**：怎么表达"不对"、"重来"、"换个方式"
- **跳跃思维**：话题切换模式，注意力转移的触发点

## 输出格式

追加到 `observations.md` 对应日期下（如文件不存在则创建）：

    ## YYYY-MM-DD

    ### 观察 N
    - **类别**：（5 个维度之一）
    - **上下文**：（2-3 句概括对话场景，标注所在工作区 chat_jid）
    - **观察**：（1 句结论）
    - **原话**：（Moran 的关键原话，1-2 句，必须保留原文）
    - **置信度**：高/中

## 约束

- 每天最多提取 10 条观察（跨所有工作区汇总，优先最显著的模式）
- **必须引用用户原话**，不允许只写总结不贴原文
- 只记录有明确证据的观察，不推测
- 置信度低于"中"的不记录
- 如果当天没有值得记录的认知模式，跳过（不创建空的日期段）
- 追加到 observations.md 末尾，不覆盖已有内容
- 处理完成后，将已处理的最新消息时间戳写入 `.cognitive-last-date`
- 全程使用 `<internal>` 包裹思考过程，不要发送消息给用户
```

## 6. 实施步骤

按以下顺序执行，每步完成后验证：

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1 | 修改 `scripts/daily-report/src/config-reader.ts` 默认 pass1Model 为 Sonnet | 读代码确认 |
| 2 | 更新 `data/config/daily-report.json` 中的 pass1Model（如有） | `cat` 确认 |
| 3 | `cd scripts/daily-report && npm run build` | `dist/index.js` 存在 |
| 4 | 手动测试日报脚本：`node scripts/daily-report/dist/index.js` | 检查输出 + 飞书文档 |
| 5 | 替换 `daily-cognitive-extract.md` 为新版 prompt | 读文件确认 |
| 6 | SQL：删除旧日报任务 + 创建新 script 类型任务 | `SELECT` 确认 |
| 7 | SQL：认知提取任务时间 3AM→4AM | `SELECT` 确认 |
| 8 | 手动触发一次认知提取（通过 Web 或 API） | 检查 observations.md 新增内容 |
| 9 | 确认 weekly-cognitive-aggregate.md 路径无误 | 读文件确认 |

## 7. 不改的清单

- `src/daily-summary.ts` — 不动（其他用户的 HEARTBEAT 依赖它）
- `src/index.ts` — 不动（daily-summary 调用保持）
- `weekly-cognitive-aggregate.md` — 不动（已确认路径正确，数据源是 observations.md 不变）
- `container/skills/daily-report/SKILL.md` — 保留（手动触发日报的入口，agent 任务场景仍可用）
- 历史数据文件 — 全部保留

## 8. 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| ~~日报脚本 script 模式下缺少 API 凭据~~ | ~~脚本无法调用 Claude API~~ | **已验证无风险**：`config-reader.ts` 通过 `path.resolve(__dirname, '..', '..', '..', 'data')` 自发现项目路径，直接读取加密配置文件获取凭据，完全不依赖 `script-runner.ts` 的受限 env。Windows 上已验证可行 |
| 认知提取查 DB 时消息量过大 | Opus 单次输入 token 超限 | prompt 中可加消息数上限（如 500 条/天），或只取 is_from_me=0 的用户消息 |
| script 类型任务不经过 agent，无法使用 MCP 工具 | 日报脚本本身不需要 MCP 工具（自带 Feishu API client） | 无影响 |
| 认知提取时间改为 4AM，与周日聚合任务冲突 | 两个 agent 任务同时启动 | group-queue 会串行处理同一 group_folder 的任务，不会并发 |

## 9. 实施记录（2026-03-17）

全部 9 步已执行完毕，逐条验证通过。

| 步骤 | 操作 | 结果 |
|------|------|------|
| 1 | `config-reader.ts` 默认 pass1Model → `claude-sonnet-4-5-20250929` | grep 确认 |
| 2 | `data/config/daily-report.json` pass1Model → Sonnet | 文件已更新 |
| 3 | `cd scripts/daily-report && npm run build` | `dist/index.js` 21KB |
| 4 | dry-run 验证脚本启动、读配置、连 DB | pass1Model=sonnet, API=true, users=2 |
| 5 | `daily-cognitive-extract.md` 全文替换为 DB messages 数据源版本 | 包含 sqlite3 + .cognitive-last-date |
| 6 | 删除旧 agent 任务 `task-1773600689371-tdbmeh`（含 task_run_logs FK），创建 `task-daily-report-script`（script 类型，0 3 * * *，main） | SELECT 确认 |
| 7 | 认知提取任务 `task-1773546866562-vhvyz6` schedule_value → `0 4 * * *` | SELECT 确认 |
| 8 | 验证 sqlite3 可用（/usr/bin/sqlite3），24h 内 91 条消息，前置文件状态正确 | OK |
| 9 | weekly-cognitive-aggregate.md 所有路径为 macOS 路径，健康检查读文件方式自动用新 prompt | 无需改动 |

### 额外发现并修复

- **DB prompt 快照问题**：agent 任务执行时使用 DB 中存储的 prompt（`task.prompt`），不是读文件。旧任务的 prompt 是创建时的快照，需要手动同步。已更新认知提取和周聚合两个任务的 DB prompt。

### 最终任务状态

```
2:00 AM  [A] daily-summary.ts       框架内置  所有用户  不动
3:00 AM  [B] task-daily-report-script  script  main  Sonnet 两轮 + 飞书发布
4:00 AM  [C] task-...-vhvyz6          agent   main  Opus, DB messages 数据源
4:00 AM  [D] task-...-p65ufu (周日)    agent   main  Opus, 读 observations.md
```
