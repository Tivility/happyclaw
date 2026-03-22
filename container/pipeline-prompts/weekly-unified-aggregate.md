# 周级统一聚合任务

你是认知×知识×交互三维度统一管线的周级聚合器。先做 daily cron 健康检查，然后并行运行三个维度的聚合子任务，最后向用户发送周报摘要。

## 数据库路径

宿主机模式：`/Users/tivility/happyclaw/data/db/messages.db`

## Step 1: Daily Cron 健康检查

先读取 daily cron 的规格定义文件 `prompts/daily-cron-spec.md`（如存在），按其参数规格执行健康检查。

1. 查询所有注册的工作区 folder：
   ```bash
   sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
     "SELECT DISTINCT folder FROM registered_groups WHERE folder NOT LIKE 'user-global%'"
   ```

2. 查询所有活跃的 daily 统一提取 cron：
   ```bash
   sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
     "SELECT group_folder, status FROM scheduled_tasks WHERE prompt LIKE '%统一提取%' AND schedule_type = 'cron'"
   ```
   注：如果系统仍在使用旧版 prompt（包含「认知模式提取」），也要检查：
   ```bash
   sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
     "SELECT group_folder, status FROM scheduled_tasks WHERE prompt LIKE '%认知模式提取%' AND schedule_type = 'cron'"
   ```

3. 对比两个列表。对于缺少 daily cron 的工作区：
   - 查找该工作区对应的 JID
   - 使用 `schedule_task` 创建 daily cron（参数参考 daily-cron-spec.md）

4. 对于状态不是 active 的 daily cron，用 `resume_task` 恢复

5. 记录：`[健康检查] N 个工作区，M 个 cron 正常，新增 X 个，修复 Y 个`

## Step 2: 收集聚合输入

### 2.1 认知维度输入

动态发现所有工作区的 observations.md：
```bash
find /Users/tivility/happyclaw/data/groups/ -maxdepth 2 -name "observations.md" -not -path "*/user-global/*"
```

读取每个文件，筛选出本周新增的观察（按日期判断，最近 7 天）。

### 2.2 知识维度输入

读取当前 home 工作区的 `pipeline/knowledge-buffer.md`。

### 2.3 交互维度输入

读取当前 home 工作区的 `pipeline/interaction-buffer.md`。

### 2.4 现有聚合产出

读取 user-global 目录下的现有文件（用于增量更新）：
- `cognitive/cognitive-profile.md`
- `knowledge/AI-Chat-Knowledge.md`
- `knowledge/KNOWLEDGE-INDEX.md`
- `interaction/interaction-rules.md`

如果 user-global 路径不可达（宿主机模式），使用绝对路径：
`/Users/tivility/happyclaw/data/groups/user-global/{userId}/`

## Step 3: 并行聚合

使用 Agent 工具启动三个聚合子任务。

### 子任务 A: 认知聚合

读取 `container/pipeline-prompts/sub-agents/cognitive-aggregator.md` 的完整内容作为 prompt。

传入：
- Step 2.1 收集的所有 observations.md 本周新增内容
- 当前 cognitive-profile.md 完整内容

子任务完成后，将输出的 Weekly Report 插入到 cognitive-profile.md 的 `<!-- Weekly reports will be prepended below this line -->` 标记之后（最新在前）。

### 子任务 B: 知识聚合

读取 `container/pipeline-prompts/sub-agents/knowledge-aggregator.md` 的完整内容作为 prompt。

传入：
- Step 2.2 的 knowledge-buffer.md 内容
- 当前 AI-Chat-Knowledge.md 完整内容
- 当前 KNOWLEDGE-INDEX.md 完整内容

子任务负责直接执行文件写入（追加知识库、更新索引、归档 buffer）。

**仅在 knowledge-buffer.md 有内容时执行。**

### 子任务 C: 交互聚合

读取 `container/pipeline-prompts/sub-agents/interaction-aggregator.md` 的完整内容作为 prompt。

传入：
- Step 2.3 的 interaction-buffer.md 内容
- 当前 interaction-rules.md 完整内容

子任务负责直接执行 interaction-rules.md 更新和 buffer 归档。

**仅在 interaction-buffer.md 有内容时执行。**

## Step 4: 汇总周报

收集三个子任务的输出摘要，组织为周报消息。

使用 `send_message` 向用户发送周报摘要，格式：

```
📊 本周认知×知识×交互三维度周报

【认知维度】
- 本周 N 条新观察，来自 M 个工作区
- 新识别模式：...
- 状态变化：...

【知识维度】
- 本周蒸馏 N 条知识
- 新增主题：...
- 跨工作区关联：...

【交互维度】
- 本周 N 条交互观察
- 新增候选规则：...
- 待确认的 CLAUDE.md 补丁：N 条（如有，列出摘要）

详细报告见 cognitive-profile.md / interaction-rules.md
```

如果有 CLAUDE.md 补丁建议，在周报中单独列出，等待用户确认后执行写入。

## Step 5: 清理

- 确认所有 buffer 归档和清空已完成
- 记录执行摘要到 `<internal>`

## 错误处理

- 某个子任务失败不影响其他子任务
- 失败的子任务在周报中标注"[失败]"并附错误摘要
- 无数据的维度在周报中标注"本周无数据"
- 如果所有维度都无数据，仍发送简短通知："本周三个维度均无新增数据"

## 约束

- 周报消息简洁，不超过 800 字，重点突出变化和新发现
- 健康检查和思考过程用 `<internal>` 包裹
- CLAUDE.md 补丁**绝不自动写入**，必须等用户在消息中确认
