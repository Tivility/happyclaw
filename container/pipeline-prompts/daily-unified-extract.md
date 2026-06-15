# 天级统一提取任务

你是认知×知识×交互三维度统一提取管线的主调度器。从当前任务 owner 名下的工作区对话数据中并行提取三个维度的观察。

本任务从 main 工作区执行，只覆盖当前任务 owner 名下的注册工作区。

## 路径约定

- 数据库：`/Users/tivility/happyclaw/data/db/messages.db`
- 工作区根目录：`/Users/tivility/happyclaw/data/groups/`
- Prompt 模板目录：`/Users/tivility/happyclaw/container/pipeline-prompts/sub-agents/`
- Pipeline 输出目录：`/Users/tivility/happyclaw/data/groups/main/pipeline/`

## Step 1: 确定 owner 并发现工作区

先确定当前任务对应的 owner user id。优先从当前任务临时工作区反查 `scheduled_tasks.created_by`；如果不是在任务临时工作区运行，则 fallback 到 main home workspace 的 owner：

```bash
CURRENT_FOLDER=$(basename "$PWD")
TARGET_USER_ID=$(sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
  "SELECT created_by FROM scheduled_tasks
   WHERE workspace_folder = '$CURRENT_FOLDER' AND created_by IS NOT NULL AND created_by != ''
   ORDER BY created_at DESC LIMIT 1")

if [ -z "$TARGET_USER_ID" ]; then
  TARGET_USER_ID=$(sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
    "SELECT created_by FROM registered_groups
     WHERE folder = 'main' AND is_home = 1 AND created_by IS NOT NULL AND created_by != ''
     LIMIT 1")
fi

if [ -z "$TARGET_USER_ID" ]; then
  echo "ERROR: cannot resolve TARGET_USER_ID"
  exit 1
fi
```

只查询该 owner 名下的注册工作区 folder。必须排除 `user-global*` 和 `task-*`，避免跨用户污染和定时任务临时工作区回灌：

```bash
sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
  "SELECT DISTINCT folder
   FROM registered_groups
   WHERE created_by = '$TARGET_USER_ID'
     AND folder NOT LIKE 'user-global%'
     AND folder NOT LIKE 'task-%'
   ORDER BY folder"
```

## Step 2: 准备输入数据

### 2.1 时间戳

读取 main 工作区的 `.cognitive-last-date` 文件获取上次处理的时间戳（ISO 格式字符串）。
- 路径：`/Users/tivility/happyclaw/data/groups/main/.cognitive-last-date`
- 如不存在，默认为 24 小时前的时间戳

### 2.2 Messages 数据（认知 + 知识维度）

查询该时间戳之后、当前 owner 名下工作区的用户消息：

```bash
sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
  "SELECT rg.folder, m.chat_jid, m.sender_name, m.is_from_me, m.content, m.timestamp
   FROM messages m
   JOIN registered_groups rg ON rg.jid = m.chat_jid
   WHERE m.timestamp > '{last_timestamp}'
     AND rg.created_by = '$TARGET_USER_ID'
     AND rg.folder NOT LIKE 'user-global%'
     AND rg.folder NOT LIKE 'task-%'
   ORDER BY rg.folder, m.chat_jid, m.timestamp"
```

按 `folder + chat_jid` 分组。过滤掉无认知含量的消息（纯斜杠命令、单字确认、系统自动发送的 cron prompt）。

如果查询结果为空，记录"当天无新消息"，跳到 Step 4 收尾。

### 2.3 Conversations 归档（交互维度）

只遍历当前 owner 名下工作区的 `conversations/` 目录，找到上次时间戳之后新增/修改的归档文件。

**重要**：使用 `.cognitive-last-date` 文件中的**内容**（ISO 时间戳字符串）作为时间基准，而不是文件的 mtime。这确保与认知/知识维度使用相同的时间窗口。

```bash
# 用 .cognitive-last-date 文件本身作为 -newer 的参考文件
# 但必须先同步文件 mtime 与内容中的时间戳一致
LAST_TS=$(cat /Users/tivility/happyclaw/data/groups/main/.cognitive-last-date 2>/dev/null)
if [ -n "$LAST_TS" ]; then
  # 创建临时参考文件，设置 mtime 为 last_timestamp 对应时间
  touch -t $(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_TS%%.*}" "+%Y%m%d%H%M.%S" 2>/dev/null || echo "202603210000.00") /tmp/.cognitive-ref
  sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
    "SELECT DISTINCT folder
     FROM registered_groups
     WHERE created_by = '$TARGET_USER_ID'
       AND folder NOT LIKE 'user-global%'
       AND folder NOT LIKE 'task-%'
     ORDER BY folder" |
  while IFS= read -r folder; do
    find "/Users/tivility/happyclaw/data/groups/$folder/conversations" -maxdepth 1 -name "*.md" -newer /tmp/.cognitive-ref 2>/dev/null
  done
  rm -f /tmp/.cognitive-ref
else
  sqlite3 /Users/tivility/happyclaw/data/db/messages.db \
    "SELECT DISTINCT folder
     FROM registered_groups
     WHERE created_by = '$TARGET_USER_ID'
       AND folder NOT LIKE 'user-global%'
       AND folder NOT LIKE 'task-%'
     ORDER BY folder" |
  while IFS= read -r folder; do
    find "/Users/tivility/happyclaw/data/groups/$folder/conversations" -maxdepth 1 -name "*.md" -mtime -1 2>/dev/null
  done
fi
```

注意：上述 bash 脚本中的 `date -j -f` 是 macOS 语法。如果 Agent 在实际执行时 date 命令行为不同，可以改用 python/node 一行脚本解析 ISO 时间戳。

如果 `.cognitive-last-date` 文件不存在，用 `find -mtime -1` 找最近 24 小时的归档。

## Step 3: 并行提取

使用 Agent 工具启动三个子任务。每个子任务的 prompt 从对应文件读取。

### 子任务 1: 认知维度

读取 `/Users/tivility/happyclaw/container/pipeline-prompts/sub-agents/cognitive-extractor.md` 的完整内容作为子任务 prompt。

将 Step 2.2 的 messages 数据（按工作区分组）作为输入附在 prompt 之后。

子任务完成后，按工作区拆分输出，追加到各工作区的 `observations.md`：
- 路径：`/Users/tivility/happyclaw/data/groups/{folder}/observations.md`
- 在日期标题 `## YYYY-MM-DD` 下追加
- 如果子任务输出"无观察"，跳过
- 如果子任务输出了不在 Step 1 owner 工作区列表中的 folder，丢弃该条并在 `<internal>` 记录错误，绝不写入其他 owner 的工作区

### 子任务 2: 知识维度

读取 `/Users/tivility/happyclaw/container/pipeline-prompts/sub-agents/knowledge-extractor.md` 的完整内容作为子任务 prompt。

将 Step 2.2 的 messages 数据作为输入附在 prompt 之后。

子任务完成后，将输出追加到 `pipeline/knowledge-buffer.md`：
- 路径：`/Users/tivility/happyclaw/data/groups/main/pipeline/knowledge-buffer.md`
- 在日期标题 `## YYYY-MM-DD` 下追加
- 如果子任务输出"无知识产出"，跳过
- 如果文件不存在，先创建

### 子任务 3: 交互维度

**仅在 Step 2.3 找到新归档文件时执行。**

读取 `/Users/tivility/happyclaw/container/pipeline-prompts/sub-agents/interaction-extractor.md` 的完整内容作为子任务 prompt。

将 Step 2.3 的归档文件内容作为输入附在 prompt 之后。如有多个归档文件，全部传入（标注来源工作区）。

子任务完成后，将输出追加到 `pipeline/interaction-buffer.md`：
- 路径：`/Users/tivility/happyclaw/data/groups/main/pipeline/interaction-buffer.md`
- 在日期标题 `## YYYY-MM-DD` 下追加
- 如果子任务输出"无交互观察"，跳过
- 如果文件不存在，先创建

## Step 4: 截断与收尾

### 4.1 截断超限条目

每个维度每天最多保留 6 条。如果子任务输出超过 6 条，只保留前 6 条，丢弃多余的。

截断规则：
- **认知维度**：检查今天日期标题（`## YYYY-MM-DD`）下的 `### 观察 N` 条目数。如果超过 6 条，删除第 7 条及之后的内容（到下一个 `## ` 标题或文件末尾为止）。
- **知识维度**：检查今天日期标题下的 `### K{N}` 条目数。如果超过 6 条，删除 K7 及之后的内容。
- **交互维度**：检查今天日期标题下的 `### I{N}` 条目数。如果超过 6 条，删除 I7 及之后的内容。

### 4.2 更新时间戳与记录

1. 将已处理的最新消息时间戳写入 `.cognitive-last-date`
2. 记录执行摘要到 `<internal>`：
   - 处理工作区数：N 个
   - 认知维度：X 条观察（截断前 Y 条）/ 无观察 / 失败
   - 知识维度：X 条知识（截断前 Y 条）/ 无知识 / 失败
   - 交互维度：X 条观察（截断前 Y 条）/ 无归档跳过 / 失败

## 错误处理

- 某个子任务失败不影响其他子任务的执行和输出
- 失败的子任务记录错误信息到 `<internal>`，不向用户发消息
- 所有子任务都失败时，仍然更新 `.cognitive-last-date`

## 约束

- 全程使用 `<internal>` 包裹思考过程，不要发送消息给用户
- 不修改已有的 observations.md / buffer 文件中的历史内容，只追加
- pipeline/ 目录下的 buffer 文件是跨天累积的，周级 cron 会消费并归档
