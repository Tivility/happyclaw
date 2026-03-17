---
name: daily-report
description: >
  Generate daily conversation analysis reports. Collects the previous day's chat
  data across all workspaces, performs topic identification and deep analysis,
  creates a Feishu document with hierarchical folder organization, and sends a
  summary card to the current group chat. Triggered automatically by scheduled
  tasks. Use this skill whenever the prompt mentions daily reports, conversation
  summaries, or daily digests, even if triggered by a cron job rather than direct
  user input.
---

# Daily Report Generation

Produce a daily conversation analysis report: collect data, identify themes,
extract action items, publish to Feishu, and notify via group chat card.

## Step 1 — Collect Data

Run the data collection script:

```bash
node "/Users/tivility/happyclaw/scripts/daily-report/dist/collect-data.js"
```

To target a specific date: append `2026-03-14` as an argument.

The script outputs a small index JSON to stdout (~2 KB). Actual data files
(messages + conversation archives) are written to disk under `dataDir`:

```json
{
  "date": "2026-03-14",
  "dataDir": "/Users/tivility/happyclaw\\data\\tmp\\daily-report-2026-03-14",
  "users": [{
    "userId": "...",
    "username": "...",
    "totalMessages": 235,
    "workspaces": [{
      "folder": "flow-xxx",
      "name": "工作区名",
      "messageCount": 53,
      "messagesFile": "/Users/tivility/happyclaw/.../messages-flow-xxx.json",
      "archiveFile": "/Users/tivility/happyclaw/.../archive-flow-xxx.md"
    }]
  }]
}
```

If `users` is empty, there were no messages — stop here without generating a report.

## Step 2 — Read and Analyze

For each workspace, read two kinds of files using the Read tool:

1. **Messages file** (`messagesFile`) — a JSON array of `{sender, content, is_from_me, timestamp}`. This gives the surface-level conversation flow.

2. **Archive file** (`archiveFile`, may be null) — a Markdown transcript of the full conversation including the AI's reasoning, tool calls, and detailed responses. This is the richest source of context because it captures *what actually happened*, not just what was said in chat. Skipping or truncating archives is the single biggest cause of inaccurate summaries.

Archives can be hundreds of KB. Read them in 2000-line chunks:
`Read(file, limit=2000)`, then `Read(file, offset=2000, limit=2000)`, and so on
until the end. Read every workspace — do not skip any.

### Phase 1: Topic Scan

After reading all data, identify discussion topics across all workspaces:

| Field | Description |
|-------|-------------|
| Topic name | Concise title |
| Workspace | Which workspace(s) it belongs to |
| Value | `high` / `medium` / `low` |
| Summary | One-sentence description |
| Deep analysis? | Whether this topic warrants detailed breakdown |

Mark a topic as high-value when it involves architectural decisions, new feature
implementations, significant debugging sessions, or process changes.

### Phase 2: Deep Analysis

For each high-value topic, go back to the relevant archive data and extract:

- **What happened**: Concrete actions taken, outcomes achieved, problems hit
- **Decisions made**: What was decided and why (trade-offs considered)
- **Action items**: Follow-up tasks that emerged
- **Insights**: Non-obvious takeaways or lessons learned

Ground every claim in the actual conversation. If a task failed or is still
in progress, say so — do not round up to "completed".

## Step 3 — Fetch Current Todos (optional)

Query the Bitable todo list so the report can show existing items alongside
newly suggested ones. Use `bitable_v1_appTableRecord_search`:

- `app_token`: `YWW4bwLtVa5ISAsElGmcowxNnod`
- `table_id`: `tblp5uqFUItIPEXO`
- Fields of interest: 事项, 状态, 优先级, 截止日
- Filter: 状态 is not "已完成" and is not "已放弃"

The 状态 field uses single-select options — query available options first if
the exact option text is unknown. If this step fails for any reason, continue
without it — the report is still valuable without the todo section.

## Step 4 — Save Local Markdown

Write the full report to:
`/Users/tivility/happyclaw/data/groups/user-global/{userId}/daily-report/{date}.md`

Template:

```markdown
# {date} 日报

> 用户: {username} | 消息数: {N} | 活跃工作区: {N}

## 概览
- 对话消息总数: N
- 活跃工作区: A, B, C
- 识别主题数: N

## 主题

### 🔴 高价值主题标题
- **工作区**: xxx
- **摘要**: 一句话描述
- **详细总结**: ...
- **决策**: ...
- **行动项**: ...
- **洞察**: ...

### 🟡 中价值主题标题
- **工作区**: xxx
- **摘要**: 一句话描述

### 🟢 低价值主题标题
- **工作区**: xxx
- **摘要**: 一句话描述

## 📋 当前待办
（Bitable 待办按优先级分组）

## 🆕 建议新增待办
（从对话中提取的行动项，带编号）

## 洞察与反思
（跨主题的 patterns、趋势、建议）
```

## Step 5 — Publish Feishu Document

### 5a. Ensure folder hierarchy

Documents are organized as:
```
云空间根目录/
  └── 日报/
       └── {YYYY}年{M}月/     (e.g. "2026年3月")
            └── {date} 日报
```

1. Call `get_feishu_root_folder_info` → get `root_folder.token`
2. Call `get_feishu_folder_files(folderToken=root_folder.token)` → find folder named "日报"
   - If missing, call `create_feishu_folder(name="日报", folderToken=root_folder.token)`
3. Inside "日报", find the month folder (format: `{YYYY}年{M}月`, e.g. "2026年3月")
   - If missing, create it
4. Use the month folder's token as `folderToken` for the document

### 5b. Create document

Call `create_feishu_document`:
- `title`: `{date} 日报`
- `folderToken`: month folder token from 5a

### 5c. Write content

Call `batch_create_feishu_blocks`:
- `documentId`: the `document_id` from creation
- `parentBlockId`: same as `document_id`
- `index`: 0
- `blocks`: heading2 for sections, heading3 for topics, bullet/ordered lists
  for details, text blocks for summaries

### 5d. Grant access

Call `drive_v1_permissionMember_create`:
- `path.token`: document_id
- `params.type`: `docx`
- `data.member_type`: `openchat`
- `data.member_id`: current chat's chat_id (strip `feishu:` prefix from chatJid)
- `data.perm`: `view`

If this fails, continue — the document is still useful via direct link.

### 5e. Build URL

The user-facing URL is:
```
https://my.feishu.cn/docx/{document_id}
```

This is the correct domain (`my.feishu.cn`), not `open.feishu.cn`.

## Step 6 — Send Card Message

Use `send_message` to post a summary card. The card uses Markdown:

```
📅 **{date} 日报**

📊 **{N}** 条消息 · **{M}** 个工作区 · **{K}** 个主题

---

**🎯 主要主题**
🔴 **主题1** — 摘要
🟡 **主题2** — 摘要
🟢 **主题3** — 摘要

---

📋 **当前待办** ({N} 项)
• P0 任务1
• P1 任务2

---

🆕 **建议新增待办**
1. 行动项1
2. 行动项2

💡 回复 `添加 1 3` 可将对应项加入待办清单

---

📄 完整日报: {文档URL}
```

## Step 7 — Timezone Sanity Check

The daily report uses the timezone configured in `daily-report.json` (field:
`timezone`, currently `America/Los_Angeles`). Since the user travels between
timezones, check whether the configured timezone still matches reality.

**How to check**: Look at the message timestamps collected in Step 2. Convert
them to the configured timezone and compute the activity distribution:

- Count messages in "deep night" hours (local 3:00–8:00)
- Count messages in "normal" hours (local 8:00–3:00)

**If ≥40% of messages fall in the deep-night window**, the user is likely in a
different timezone. Append a timezone confirmation note at the end of the card
message (Step 6) and local Markdown report (Step 4):

```
---
⏰ **时区确认**
当前日报按 {configured_tz} 统计。我注意到有较多消息出现在该时区的凌晨时段，
你最近是否换了时区？如果是，请告诉我新的时区（如 Asia/Shanghai），我会更新配置。
```

If the distribution looks normal (most activity in daytime), skip this note.

## Step 8 — Clean Up

Delete the temporary data directory:

```bash
rm -rf "{dataDir}"
```

## Step 9 — Update Config

Record that this date has been processed:

```bash
node -e "
const fs = require('fs');
const f = '/Users/tivility/happyclaw/data/config/daily-report.json';
const c = JSON.parse(fs.readFileSync(f, 'utf-8'));
const userId = '{userId}';
if (!c.users[userId]) c.users[userId] = {};
c.users[userId].lastRunDate = '{date}';
fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log('lastRunDate updated');
"
```

## Resilience

Each step is independent. If any step fails (Bitable unavailable, Feishu API
error, permission grant rejected), log the failure and continue with the
remaining steps. The local Markdown save (Step 4) is the minimum viable output
— everything else is enhancement.
