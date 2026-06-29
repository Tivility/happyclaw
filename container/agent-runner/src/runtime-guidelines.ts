export type RuntimeGuidelineRuntime = 'claude' | 'codex' | 'grok';

const CLAUDE_BACKGROUND_TASK_GUIDELINES = [
  '',
  '## 后台任务',
  '',
  '当用户要求执行耗时较长的批量任务（如批量文件处理、大规模数据操作等），',
  '你应该使用 Task 工具并设置 `run_in_background: true`，让任务在后台运行。',
  '这样用户无需等待，可以继续与你交流其他事项。',
  '任务结束时你会自动收到通知，届时在对话中向用户汇报即可。',
  '告知用户：「已为您在后台启动该任务，完成后我会第一时间反馈。现在有其他问题也可以随时问我。」',
  '',
  '### 任务通知处理（重要）',
  '',
  '当你收到多条后台任务的完成或失败通知时：',
  '- **禁止逐条回复**。不要对每条通知都调用 `send_message`，这会导致 IM 群刷屏。',
  '- **等待所有通知到齐后，汇总为一条消息回复用户**，例如：「N 个任务完成，M 个失败，失败原因：...」',
  '- 对于已知的无害失败（如浏览器进程被回收、临时资源超时），**不需要通知用户**，静默忽略即可。',
].join('\n');

const CODEX_BACKGROUND_TASK_GUIDELINES = [
  '',
  '## 后台任务与子代理',
  '',
  '当前运行时是 Codex。不要使用或声称使用 Claude 的 Task / TaskOutput / TaskStop 工具；Codex SDK 事件不会产生 Claude 的 task_start、task_notification 或 sub_agent_result 生命周期。',
  '如果任务可以在当前回合完成，直接在当前回合执行，并用 Codex 的 Todo/工具调用展示进度。',
  '如果用户明确需要定时、延后或周期执行，使用 HappyClaw MCP 的 schedule_task 工具创建系统定时任务。',
  '如果用户明确要求 Claude Task 风格的 subagent，请说明当前 Codex 运行时不支持这种 SDK-native 子代理，并给出可执行替代方案：在当前回合完成、切回 Claude，或让用户使用 HappyClaw 的 /spawn / conversation agent 产品能力。',
].join('\n');

const GROK_BACKGROUND_TASK_GUIDELINES = [
  '',
  '## 后台任务与子代理',
  '',
  '当前运行时是 Grok。不要使用或声称使用 Claude 的 Task / TaskOutput / TaskStop 工具；Grok 的 ACP 事件不会产生 Claude 的 task_start、task_notification 或 sub_agent_result 生命周期。',
  '如果任务可以在当前回合完成，直接在当前回合执行，并用 Grok 的 plan / 工具调用展示进度。',
  'Grok 内置 subagent 能力（如 spawn_subagent），需要并行探索或拆分时可直接使用，HappyClaw 会把它当作普通工具调用展示。',
  '如果用户明确需要定时、延后或周期执行，使用 HappyClaw MCP 的 schedule_task 工具创建系统定时任务。',
].join('\n');

export function buildRuntimeBackgroundTaskGuidelines(
  runtime: RuntimeGuidelineRuntime,
): string {
  if (runtime === 'codex') return CODEX_BACKGROUND_TASK_GUIDELINES;
  if (runtime === 'grok') return GROK_BACKGROUND_TASK_GUIDELINES;
  return CLAUDE_BACKGROUND_TASK_GUIDELINES;
}

/**
 * Grok 通过 `search_tool` 间接发现 MCP 工具：happyclaw 注册的工具对模型不是
 * always-available，模型若不知道它们存在就不会去 search。为确保 scheduled-task
 * 的「必须用 send_message 才能回复用户」契约成立，把 happyclaw MCP 工具清单+用法
 * 显式写进 session/new 的 _meta.rules（追加到 grok 系统提示），让模型知道工具存在
 * 并主动 search → use。工具名带 `happyclaw__` 命名空间前缀（ACP/MCP 命名约定）。
 */
const GROK_HAPPYCLAW_TOOLS_GUIDELINES = [
  '',
  '## HappyClaw 工具（通过 MCP 提供）',
  '',
  'HappyClaw 通过名为 `happyclaw` 的 MCP server 向你提供以下工具。这些工具可能需要',
  '你先用工具搜索（如 search_tool）才能调用——它们**确实存在**，需要时请主动查找并使用：',
  '',
  '- `happyclaw__send_message`：在运行过程中立即向用户/群发送一条消息（进度更新或多段回复）。可多次调用。',
  '  **重要**：作为定时任务运行时，你的最终文本不会自动发给用户——必须用这个工具才能联系到用户。',
  '- `happyclaw__schedule_task`：创建一次性或周期性定时任务（cron / interval / once）。',
  '- `happyclaw__list_tasks` / `happyclaw__pause_task` / `happyclaw__resume_task` / `happyclaw__cancel_task`：管理定时任务。',
  '- `happyclaw__memory_append`：把时效性记忆追加到 memory/YYYY-MM-DD.md（仅追加，不覆盖）。',
  '- `happyclaw__memory_search`：在工作区记忆文件（CLAUDE.md、memory/、conversations/ 等）中检索。',
  '- `happyclaw__memory_get`：读取记忆文件或指定行范围（配合 memory_search 使用）。',
  '- `happyclaw__register_group` / `happyclaw__install_skill` / `happyclaw__uninstall_skill`：仅在你有相应权限时可用，无权限会被拒绝。',
  '',
  '说明：实际可用的工具集由 happyclaw MCP server 按你的权限动态决定（如跨组工具仅 admin 主容器可用）。',
  '若某工具不存在或被拒绝，按返回的错误信息处理即可，不要臆造。',
].join('\n');

/**
 * 仅 grok 需要：返回追加进 _meta.rules 的 happyclaw 工具说明块。
 * codex/claude 走 SDK first-class 工具注册，无需此提示，返回空串。
 */
export function buildHappyClawToolsHint(
  runtime: RuntimeGuidelineRuntime,
): string {
  return runtime === 'grok' ? GROK_HAPPYCLAW_TOOLS_GUIDELINES : '';
}
