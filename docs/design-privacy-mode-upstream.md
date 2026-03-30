# 功能: Per-Group 隐私模式（Upstream 设计方案）

## 背景

用户需要在某些工作区（如涉及收入、税务、法律等敏感话题）中开启隐私模式，确保对话内容不被本地数据库记录、不被后台任务读取。Claude 端已确认可关闭数据训练。

核心语义：**对话内容不落盘**。WebSocket 实时传输不受影响，刷新后消息消失。保留 agent-runner 日志用于 debug。

**关键约束**：单方向切换（public → private），不可逆。

## 用户场景分析

| 场景 | 用户行为 | 系统行为 |
|------|---------|---------|
| **新建隐私工作区** | 创建时勾选"隐私模式" | 创建即为 private，从未有消息入库 |
| **已有工作区切到隐私** | 在设置/右键菜单中开启，确认不可逆 | 历史消息保留可见，后续不存储 |
| **正常使用隐私工作区** | 发消息、收回复、看流式输出 | WebSocket 实时推送正常，消息不入 DB |
| **刷新页面** | 当前会话的消息消失 | API 返回空（仅有切换前的历史），显示提示 |
| **Agent 使用工具** | Agent 要写文件或上传飞书 | SDK 弹出确认（dangerousTools 模式） |
| **上下文压缩** | 自动触发 | 跳过 conversations/ 归档，CLAUDE.md 正常更新 |
| **日报/定时汇总** | 凌晨自动运行 | 跳过隐私群组，不读取其消息 |
| **切换时 Agent 正在运行** | 用户在设置中开启 | 立即生效（消息不再入库），Agent 自然退出后下次携带 privacyMode |

## 实现方案

### 1. 数据模型

**`src/db.ts`**：
- `SCHEMA_VERSION` +1
- Migration: `ensureColumn('registered_groups', 'privacy_mode', 'INTEGER DEFAULT 0')`
- `parseGroupRow()` 映射：`privacy_mode: row.privacy_mode === 1`

**`src/types.ts`**：
- `RegisteredGroup` 新增 `privacy_mode?: boolean`

**`container/agent-runner/src/types.ts`**：
- `ContainerInput` 新增 `privacyMode?: boolean`（与 `isHome`/`isAdminHome`/`isScheduledTask` 同级）

### 2. 隐私缓存 + 消息路由 + 延迟清理

**`src/db.ts`** 新增模块级缓存：

```typescript
const privacyJids = new Set<string>();
const privacyFolders = new Set<string>();

export function refreshPrivacyCache(): void {
  // 从 DB 加载 privacy_mode=1 的所有 jid + folder
}
export function isPrivacyFolder(folder: string): boolean;
export function isPrivacyJid(jid: string): boolean;
```

刷新时机：`initDb()` 后、`setRegisteredGroup()` 后、`deleteRegisteredGroup()` 后。

**`storeMessageDirect()` 不拦截**：
隐私模式下消息**照常写入** `messages` 表。消息路由（`getNewMessages()` 轮询 → `getMessagesSince()` 拉取 → agent 处理）依赖 DB 中的消息记录，跳过写入会导致 agent 永远无法拾取消息。

**延迟清理**：消息在 agent 处理完成后从 DB 删除。

```typescript
// src/db.ts
export function deletePrivacyMessages(chatJid: string): number {
  return db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid).changes;
}

export function cleanupAllPrivacyMessages(): number {
  // 启动时调用，清理上次进程崩溃残留的隐私消息
  let total = 0;
  for (const jid of privacyJids) {
    total += db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid).changes;
  }
  return total;
}
```

**清理时机**：
1. **Agent 回复后**：`processGroupMessages()` 中 `commitCursor()` 后，检查 `isPrivacyJid(chatJid)` 则调用 `deletePrivacyMessages(chatJid)`
2. **进程启动时**：`loadState()` 末尾调用 `cleanupAllPrivacyMessages()` 清理崩溃残留

**注意**：`ensureChatExists()` 是独立调用（在 IM 消息入口等处单独调用），不在 `storeMessageDirect` 内部。隐私模式下 `chats` 表记录照常存在（群组需要出现在侧边栏），`messages` 表短暂存储后清理。

**安全性说明**：消息在 SQLite WAL 中短暂存在（秒级到分钟级），与 agent-runner 的 stderr 日志（设计文档明确保留）风险等级相当，可接受。

### 3. API（遵循现有 PATCH 模式）

现有代码中**所有 per-group 属性修改都通过 `PATCH /api/groups/:jid`**（`name`、`is_pinned`、`activation_mode`、`execution_mode`）。无独立的 POST 端点修改属性的先例。

**`src/schemas.ts`**：
```typescript
export const GroupPatchSchema = z.object({
  name: ...,
  is_pinned: ...,
  activation_mode: ...,
  execution_mode: ...,
  privacy_mode: z.literal(true).optional(), // 只接受 true，不接受 false
});
```

用 `z.literal(true)` 而非 `z.boolean()`，从 schema 层面保证单方向。客户端发 `{ privacy_mode: false }` 会被 zod 校验拒绝。

**`src/routes/groups.ts` PATCH 处理**：
- `privacy_mode` 字段的处理逻辑：
  - 已是 `privacy_mode=true` → 幂等，跳过
  - **Per-folder 同步**：`getJidsByFolder(folder)` → 逐个 UPDATE → `refreshPrivacyCache()`
  - 广播状态更新到 WebSocket 客户端（现有 `status_update` 机制）

**`src/schemas.ts` 创建 schema**：
- `GroupCreateSchema`（如有）新增 `privacy_mode: z.boolean().optional()`，创建时可直接设为 true

**`src/routes/groups.ts` buildGroupsPayload**：
- 返回的 `GroupPayloadItem` 新增 `privacy_mode` 字段（`parseGroupRow` 自然包含）

### 4. ContainerInput 传递

**`src/index.ts`**：
- `processGroupMessages()` 构建 input 时：`privacyMode: !!effectiveGroup.privacy_mode`
- `processAgentConversation()` 同理

**`src/task-scheduler.ts`**：
- 任务执行时同理传递

与 `isHome`/`isAdminHome` 同级，agent-runner 通过 `normalizeHomeFlags` 类似模式读取。

### 5. Agent Runner

**`container/agent-runner/src/index.ts`**：

**(a) 读取标志**（main 函数中，与 `normalizeHomeFlags` 同一位置）：
```typescript
const privacyMode = !!containerInput.privacyMode;
```

**(b) PreCompact Hook**：
- `createPreCompactHook()` 新增 `privacyMode` 参数
- 隐私模式下跳过 `fs.writeFileSync(archivePath, ...)` 归档步骤
- `compact_partial` 输出、CLAUDE.md 更新标记照常

**(c) Permission 模式**：
- 隐私模式下初始 `currentPermissionMode = 'requestPermissionsForDangerousTools'`
- 效果：Write/Edit/Bash 等危险工具执行前需用户确认

**(d) 系统提示**：
- 在首次 query 的 prompt 前注入隐私模式提示段
- 告知 Agent：对话不会被记录，文件写入和网络上传需谨慎

**`container/agent-runner/src/mcp-tools.ts`**：
- `createMcpTools()` 接收 `privacyMode` 参数
- 隐私模式下 `memory_append` 工具不注册（与现有的 `isHome` 条件判断同级）
- `memory_search` / `memory_get` 保留

### 6. 后台任务隔离

**`src/daily-summary.ts`**：
- `generateUserSummary()` 过滤 `privacy_mode=true` 的群组
- 该模块通过 `getMessagesByTimeRange()` 从 DB 读消息，隐私模式下消息未入库所以读不到，但显式过滤更干净

**自然隔离（无需改动）**：
- PreCompact Hook 归档 — 已跳过 conversations/ 写入
- 定时任务框架 — 输出走 storeMessageDirect，agent 完成后同样触发清理

### 7. 切换时机处理

切换时主进程调用 `refreshPrivacyCache()` 后立即生效：

- **消息存储**：`storeMessageDirect` 通过内存缓存判断，**即时生效**，不需要等 agent 重启
- **Agent 行为**（PreCompact/permissions/提示）：需要 ContainerInput 传递，**下次 agent 启动时生效**
- 如果当前有 agent 在运行，会存在一个过渡窗口：消息已不入库，但 agent 仍在旧模式运行（PreCompact 仍会归档、permissions 仍为 bypass）
- **可接受**：过渡窗口 = 当前 agent session 的剩余时间（最长 idle timeout 30min），且 conversations/ 的归档内容来自 SDK transcript（SDK 层面的数据，不受我们控制），隐私模式的核心保证（消息不入 DB）已即时满足

### 8. 前端

**`web/src/types.ts`**：`GroupInfo` 新增 `privacy_mode?: boolean`

**`web/src/components/chat/ChatGroupItem.tsx`** 右键菜单：
- 新增菜单项："开启隐私模式"
- 显示条件：`!group.privacy_mode`（已开启时不显示）
- 点击触发 `ConfirmDialog`（复用现有的确认对话框模式，参考 ChatSidebar.tsx 第 365-387 行）

**确认对话框**：
- 标题："开启隐私模式"
- 内容："开启后，该工作区的后续对话将不会被保存到数据库。此操作不可撤销。已有的历史消息不受影响。"
- 确认按钮：`confirmVariant: 'destructive'`
- 调用：`PATCH /api/groups/:jid { privacy_mode: true }`

**视觉指示**：
- 群组名称旁锁图标（`Lock` from lucide-react），`privacy_mode=true` 时常驻
- 聊天区域顶部固定提示条："隐私模式 · 对话不会被保存"
- 隐私模式下消息列表为空时显示说明（非"暂无消息"）

**`CreateContainerDialog.tsx`**：
- 新增"隐私模式"复选框（默认关闭）
- 勾选时显示不可逆提示
- 创建时 POST body 携带 `privacy_mode: true`

**流式状态**：
- `sessionStorage` 中的流式缓存（`STREAMING_STORAGE_KEY`）是短暂的（tab 关闭即清），不影响隐私

## 设计模式一致性对照

| 维度 | 现有模式 | 隐私模式方案 | 一致性 |
|------|---------|------------|--------|
| 群组属性修改 API | 统一 PATCH `/api/groups/:jid` | 同 PATCH，`z.literal(true)` 限制方向 | ✅ |
| ContainerInput 标志 | `isHome`/`isAdminHome`/`isScheduledTask` boolean | 新增 `privacyMode` boolean | ✅ |
| agent-runner 条件行为 | `isHome` → 启用记忆工具、PreCompact 触发 flush | `privacyMode` → 跳过归档、限制权限 | ✅ |
| MCP 工具条件注册 | `createMcpTools` 中有条件逻辑 | `memory_append` 不注册 | ✅ |
| 前端菜单项 | 条件显示（`!isHome && deletable`） | `!privacy_mode` 显示开启选项 | ✅ |
| 确认对话框 | `ConfirmDialog` 组件（删除/重建） | 复用同一组件 | ✅ |
| DB schema 演进 | `ensureColumn` migration | 同 | ✅ |
| 内存缓存 | 无先例（storeMessageDirect 无跳过逻辑） | 新增 privacyJids 缓存 | ⚠️ 新模式，但是最干净的拦截点 |

## 边界情况

| 场景 | 行为 |
|------|------|
| 新建时直接设为隐私 | POST body `privacy_mode: true` |
| 切换后历史消息 | 保留可见 |
| PATCH `{ privacy_mode: false }` | zod 校验失败 400 |
| 已是 private 再 PATCH true | 幂等 200 |
| 切换时 Agent 运行中 | 消息即时不入库，Agent 行为下次启动生效 |
| Per-folder 同步 | 同 folder 所有 JID 同步为 private |
| IM 自动注册到 private folder | `setRegisteredGroup` → `refreshPrivacyCache` → 新 JID 自动进入缓存 |
| 共享工作区 | 所有成员看到相同隐私状态 |
| Sub-Agent | 继承父群组 privacyMode |
| Token 用量 | 照常（usage_records 独立于 storeMessageDirect） |
| Agent 日志 | 照常（stderr → logs/ 目录） |
| CLAUDE.md | 正常维护 |
| 群组删除/重建 | 不受影响 |

## 实现顺序

1. `src/db.ts` — schema + 缓存 + storeMessageDirect 拦截
2. `src/types.ts` — RegisteredGroup 字段
3. `src/schemas.ts` — GroupPatchSchema + GroupCreateSchema
4. `src/routes/groups.ts` — PATCH 处理 + per-folder 同步 + 创建支持 + payload 返回
5. `container/agent-runner/src/types.ts` — ContainerInput 字段
6. `src/index.ts` — processGroupMessages / processAgentConversation 注入
7. `src/task-scheduler.ts` — 任务注入
8. `container/agent-runner/src/index.ts` — PreCompact + permissions + 提示
9. `container/agent-runner/src/mcp-tools.ts` — memory_append 条件
10. `src/daily-summary.ts` — 隐私群组过滤
11. 前端 UI

## 验证

1. 创建时勾选隐私 → DB privacy_mode=1 → 消息不入库 → WebSocket 正常
2. 已有群组 PATCH → per-folder 同步 → 新消息不入库 → 历史可见
3. PATCH false → 400 错误
4. 刷新 → 新消息消失 → 提示文字显示
5. 日报 → 不含隐私群组
6. 上下文压缩 → conversations/ 无新文件
7. Agent 写文件 → 弹确认
8. logs/ 正常写入
