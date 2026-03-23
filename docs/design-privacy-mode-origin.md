# 功能: Per-Group 隐私模式（Origin 定制化扩展）

## 前置依赖

本文档基于 upstream 隐私模式框架合入后的扩展。upstream 方案见 `design-privacy-mode-upstream.md`。

## 扩展内容

### 1. PRIVATE.md 双层记忆

upstream 隐私模式下 `CLAUDE.md` 继续由 Agent 维护，用于记录工作区基本信息（对框架可见）。origin 新增 Layer 2 私密记忆。

- **Layer 1**: `CLAUDE.md` — 对框架可见（日报/认知系统可读取），记录工作区基本信息
- **Layer 2**: `PRIVATE.md` — 仅该工作区 Agent 可读写，存放敏感上下文（收入、税务具体数字等）

#### 实现

**`container/agent-runner/src/index.ts`**：
- 隐私模式下在系统提示中注入额外指引：
  - 敏感信息（数字、金额、个人信息等）写入 `PRIVATE.md`
  - 公开信息（工作区结构、项目状态等）写入 `CLAUDE.md`
  - `PRIVATE.md` 不会被外部系统（日报、认知观察）读取

**`src/file-manager.ts`**：
- 将 `PRIVATE.md` 加入系统保护路径列表（与 `CLAUDE.md`、`logs/`、`.claude/` 同级）
- 效果：通过文件 API（`GET /api/groups/:jid/files`）无法读取 `PRIVATE.md`

**`container/agent-runner/src/mcp-tools.ts`**：
- `memory_search` 工具搜索文件时排除 `PRIVATE.md`
- 效果：其他工作区的 Agent 通过 memory_search 搜不到隐私工作区的 PRIVATE.md 内容

### 2. Memory Flush 跳过

origin 独有的 memory flush 流程（`container/agent-runner/src/index.ts` 第 1733-1777 行）在上下文压缩后自动将记忆写入 `memory/YYYY-MM-DD.md` 日期文件。

隐私模式下跳过该流程：
- 在 PreCompact Hook 中，隐私模式时不设置 `needsMemoryFlush = true`
- 效果：对话内容不会通过 memory flush 路径泄露到 `memory/` 目录

### 3. Origin 独有后台任务隔离

| 任务 | 读取方式 | 隔离方案 |
|------|---------|---------|
| 认知观察 daily cron | 读 `conversations/` 归档文件 | 自然隔离（upstream PreCompact Hook 已跳过归档写入，目录无新文件） |
| 认知观察 weekly cron | 读各工作区 `observations.md` | 自然隔离（daily 无产出 → weekly 无新数据） |
| 日报数据采集脚本 `scripts/daily-report` | 独立脚本，读 DB | 脚本中过滤 `privacy_mode=true` 的群组（查 registered_groups 表或调用 `isPrivacyFolder()`） |
| daily-report Skill | cron 触发 Agent 执行 | Agent 通过 `memory_search` 读数据 — memory_append 已禁用（upstream），无新记忆写入，自然隔离 |

## 实现顺序

1. `container/agent-runner/src/index.ts` — PRIVATE.md 提示注入 + memory flush 跳过
2. `src/file-manager.ts` — PRIVATE.md 系统保护路径
3. `container/agent-runner/src/mcp-tools.ts` — memory_search 排除 PRIVATE.md
4. `scripts/daily-report/src/index.ts` — 隐私群组过滤

## 验证

1. Agent 在隐私工作区写入 PRIVATE.md → 内容包含敏感数字
2. 通过文件 API `GET /api/groups/:jid/files` 访问 PRIVATE.md → 403/404
3. 其他工作区 Agent 执行 `memory_search` 搜索关键词 → 不返回 PRIVATE.md 内容
4. 上下文压缩后 → `memory/` 目录无新文件（memory flush 被跳过）
5. 认知观察 daily cron → 隐私工作区 `conversations/` 无新归档 → observations.md 无新内容
6. 日报脚本 → 不包含隐私群组的数据
