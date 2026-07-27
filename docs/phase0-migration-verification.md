# 阶段 0.5 · 数据库迁移实测记录

> 2026-07-26 · 在 upstream/main 的 worktree 里对备份副本跑真实 `initDatabase()`
> 副本来源：`data/backups/pre-merge-20260726-021711/messages.db`（VACUUM INTO 一致快照）

## 结果：迁移跑通，退出码 0，schema 45 → 63

自动建了迁移前备份 `messages-v45-to-v63-*.db`（140MB，一次性）。

## 14 项对账全部符合预测

| 表 | 前 | 后 | 判定 |
|---|---|---|---|
| `messages` | 13744 | 13744 | 不变 ✓ |
| `registered_groups` | 64 | 64 | 不变 ✓ |
| `group_members` | 32 | **表不存在** | 被 DROP ✓（已决策删除） |
| `workspaces` | 64 | **35** | upstream 按 `web:` 前缀筛 ✓ |
| `agent_channel_mounts` | 21 | 21 | 全删重建，集合一致 ✓ |
| `usage_records` | 7011 | 7011 | 不变 ✓ |
| **`conversation_runtime_state`** | 33 | 33 | **本地独有，完好** ✓ |
| **`conversation_runtime_sessions`** | 52 | 52 | **本地独有，完好** ✓ |
| **`conversation_handoff_summaries`** | 137 | 137 | **本地独有，完好** ✓ |
| `workspace_agent_profiles` | 0 | 35 | 自动绑定 ✓ |
| `agent_profiles` | 0 | 3 | 每个 active user 一条 ✓ |
| `scheduled_tasks` | 24 | 24 | 不变 ✓ |
| `sessions` | 17 | 17 | 不变 ✓ |
| `usage_events` | — | 7011 | 全量复制 ✓ |

upstream 新表：`task_runs` 0 · `channel_accounts` 0 · `channel_mounts` **21** · `channel_inbox` 0 · `turn_runs` 0 · `channel_outbox` 0 · `streaming_cards` 0 · `workspace_runtime_sessions` **16**

## 内容级验证（数量对 ≠ 内容对）

**① `messages.chat_jid` 完全不变** —— 64 distinct 前后一致，含 `#account:` 片段的消息 **0 条**。
→ 多账号方案「不重写历史 JID」的前提坐实。

**② `agent_channel_mounts` 的 `channel_jid` 集合完全一致**，列数 14 → 15。
→ 本地多的三列 `agent_profile_id` / `owner_user_id` / `workspace_folder` **迁移后 21/21 全部非空**。

**③ `workspaces` 漏掉的正是 `wechat` folder** —— 那是唯一一个没有 `web:` 对应记录、却是真实执行上下文的 folder。
→ 印证「按 folder 投影 36 行」的设计是对两边的修正。

**④ v58 把恰好 10 个飞书群设成 `owner_only`**（54 everyone / 10 owner_only）。
→ 与此前核实的「这 10 个群 allowlist 恰好只有 owner」一致，是等价变换。

**⑤ 无回溯计价** —— codex `$0.5877`、grok `$0.0` 原样带过去，未按 Sonnet 兜底价重算。
→ Kaboo 风险只在合并后的新数据。（有成本的 6197 行是 claude 1839 + 历史 null-runtime 4356，本来就该有。）

**⑥ 本地 11 个归因列存活** —— `runtime` / `provider_family` / `provider_pool_id` / `usage_metadata_json` 各 2626 行非空，`cost_status` / `cost_source` 各 2674 行。

**⑦ `PRAGMA foreign_key_check` 零违规，`quick_check` ok。**

## 因此修正的决策

**D1.2 前提错误，撤销。** 原判断是「`agent_channel_mounts` 全删重建会丢掉本地多的三列」，实测三列完好（upstream 那张派生表本身也有这些列）。不需要为它做任何事。

## 因此确认的决策

- **D1.4**（按 folder 投影 36 行）—— 实测证实 upstream 会漏 `wechat`
- **多账号不重写 JID** —— 实测 `chat_jid` 零变化
- **D1.1**（删 `group_members`）—— 无条件 DROP 确认执行
- **v58 owner_only** —— 等价变换确认
- **Kaboo 只影响新数据** —— 历史安全

## 起始版本号

upstream 的 `runMigrations()` 从本地 `'45'`（字符串）正常推进到 `63`（数字），中途无异常、无跳过。
→ **不需要预先降到 39**。本地新迁移从 64 开始编号即可。
