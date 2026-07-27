import { describe, expect, test, vi } from 'vitest';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';

/**
 * Locks in the fix for background sub-agents being killed 5s after the main
 * answer.
 *
 * Before this tracking existed, the session loop closed the stream on
 * POST_RESULT_TIMEOUT_MS regardless of what was still running, and every
 * delegated sub-agent got interrupted with it. Measured damage on the
 * reference deployment: the cognitive pipeline lost all six extraction
 * sub-agents across two rounds, silently — SDK Task agents are not recorded in
 * the `agents` table and StreamEvents are not persisted, so the only trace was
 * the SDK reporting "No completion record was found for background agent" on
 * the *next* turn. That message is the autopsy, not the cause.
 *
 * The invariant that matters: a task registered by `task_started` must be
 * settled by *some* path, or the stream is held open forever.
 */
function makeProcessor() {
  const emit = vi.fn();
  const log = vi.fn();
  return { processor: new StreamEventProcessor(emit, log), emit, log };
}

const taskStarted = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: `tool-${taskId}`,
  description: `work for ${taskId}`,
  ...extra,
});

describe('pending SDK task tracking', () => {
  test('task_started registers, task_notification settles', () => {
    const { processor } = makeProcessor();
    expect(processor.getPendingSdkTaskCount()).toBe(0);

    processor.processSystemMessage(taskStarted('t1'));
    expect(processor.getPendingSdkTaskCount()).toBe(1);

    processor.processTaskNotification({
      task_id: 't1',
      status: 'completed',
      summary: 'done',
    });
    expect(processor.getPendingSdkTaskCount()).toBe(0);
  });

  test('task_updated settles on each terminal status', () => {
    for (const status of ['completed', 'failed', 'killed']) {
      const { processor } = makeProcessor();
      processor.processSystemMessage(taskStarted('t1'));
      processor.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 't1',
        patch: { status },
      });
      expect(processor.getPendingSdkTaskCount()).toBe(0);
    }
  });

  test('task_updated with a non-terminal status keeps the task pending', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'running' },
    });
    expect(processor.getPendingSdkTaskCount()).toBe(1);
  });

  test('several concurrent tasks settle independently', () => {
    // The cognitive pipeline shape: three dimensions fan out in parallel.
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('cognitive'));
    processor.processSystemMessage(taskStarted('knowledge'));
    processor.processSystemMessage(taskStarted('interaction'));
    expect(processor.getPendingSdkTaskCount()).toBe(3);

    processor.processTaskNotification({
      task_id: 'knowledge',
      status: 'completed',
      summary: '',
    });
    expect(processor.getPendingSdkTaskCount()).toBe(2);
    // Still blocking: the stream must not close while two remain.
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(2);
  });

  test('housekeeping tasks (skip_transcript) are never registered', () => {
    // Registering these would let an internal task hold the stream open.
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('hk', { skip_transcript: true }));
    expect(processor.getPendingSdkTaskCount()).toBe(0);
  });

  test('settling an unknown task id is a no-op', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processTaskNotification({
      task_id: 'never-registered',
      status: 'completed',
      summary: '',
    });
    expect(processor.getPendingSdkTaskCount()).toBe(1);
  });

  test('double settle does not underflow', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'completed' },
    });
    processor.processTaskNotification({
      task_id: 't1',
      status: 'completed',
      summary: '',
    });
    expect(processor.getPendingSdkTaskCount()).toBe(0);
  });
});

describe('blocking vs total pending count', () => {
  test('a backgrounded local_bash counts as pending but not as blocking', () => {
    // dev server / tail -f are designed to outlive the turn; waiting on them
    // would pin the stream open until IDLE_TIMEOUT for no benefit.
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('bash1', { task_type: 'local_bash' }));
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bash1',
      patch: { is_backgrounded: true },
    });

    expect(processor.getPendingSdkTaskCount()).toBe(1);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
  });

  test('a local_bash that has NOT been backgrounded still blocks', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('bash1', { task_type: 'local_bash' }));
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);
  });

  test('a backgrounded Agent task still blocks — only local_bash is exempt', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('agent1', { task_type: 'agent' }));
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent1',
      patch: { is_backgrounded: true },
    });
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);
  });

  test('mixed fleet reports both counts correctly', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('research', { task_type: 'agent' }));
    processor.processSystemMessage(taskStarted('devserver', { task_type: 'local_bash' }));
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'devserver',
      patch: { is_backgrounded: true },
    });

    expect(processor.getPendingSdkTaskCount()).toBe(2);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);
  });
});

describe('describePendingSdkTasks', () => {
  test('lists descriptions for the status banner', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1', { description: 'AI music research' }));
    expect(processor.describePendingSdkTasks()).toEqual(['AI music research']);
  });

  test('truncates long descriptions', () => {
    // shorten(s, 80) keeps 80 chars and appends "..." → 83 total.
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1', { description: 'x'.repeat(500) }));
    const [described] = processor.describePendingSdkTasks();
    expect(described).toBe(`${'x'.repeat(80)}...`);
  });

  test('falls back to the prompt when description is absent', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'tool-t1',
      prompt: 'summarize the week',
    });
    expect(processor.describePendingSdkTasks()).toEqual(['summarize the week']);
  });
});

/**
 * 电平信号（background_tasks_changed）与完成债。
 *
 * SDK 文档明确反对纯配对边沿：漏掉任一 bookend 就会让 pendingSdkTasks 里留下
 * 永不结算的条目，把流挂到 IDLE_TIMEOUT。电平载荷是「整集替换」语义，用来纠正
 * 漏掉的边沿；完成债则决定任务结束后值不值得为收尾汇总多等一会儿。
 */
const levelPayload = (
  tasks: Array<{ task_id: string; task_type?: string; description?: string }>,
) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
});

/** 让边沿条目越过对账宽限窗（LEVEL_RECONCILE_GRACE_MS = 3s）。 */
function advancePastReconcileGrace() {
  vi.setSystemTime(Date.now() + 5_000);
}

describe('电平信号对账', () => {
  test('漏掉终态边沿时，电平信号把残留条目结算掉', () => {
    vi.useFakeTimers();
    try {
      const { processor } = makeProcessor();
      processor.processSystemMessage(taskStarted('t1'));
      expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);

      // task_notification 丢了，只有电平信号说它不在了
      advancePastReconcileGrace();
      processor.processSystemMessage(levelPayload([]));

      expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
      // 任务确实结束过，欠一笔收尾汇总
      expect(processor.getTaskCompletionDebt()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('刚登记的边沿不被电平集误判为已结束', () => {
    vi.useFakeTimers();
    try {
      const { processor } = makeProcessor();
      processor.processSystemMessage(taskStarted('t1'));
      // 电平载荷紧跟着到达但还没包含 t1（SDK 声明两者顺序不保证）
      processor.processSystemMessage(levelPayload([]));

      expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);
      expect(processor.getTaskCompletionDebt()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('漏掉 task_started 时，电平集补上阻塞计数', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(
      levelPayload([{ task_id: 'ghost', task_type: 'agent', description: '子 Agent' }]),
    );
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);
  });

  test('电平集里的 local_bash 按定义已 backgrounded，不阻塞收尾', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(
      levelPayload([{ task_id: 'devserver', task_type: 'local_bash', description: 'npm run dev' }]),
    );
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
  });

  test('housekeeping 任务从电平侧混进来也不阻塞收尾', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('hk', { skip_transcript: true }));
    processor.processSystemMessage(
      levelPayload([{ task_id: 'hk', task_type: 'agent', description: '内部整理' }]),
    );
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
  });

  test('并集去重：同一任务同时出现在边沿集与电平集只计一次', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processSystemMessage(
      levelPayload([{ task_id: 't1', task_type: 'agent', description: 'work for t1' }]),
    );
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);
  });
});

describe('完成债', () => {
  test('对用户可见的任务结束会记债，housekeeping 不记', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processTaskNotification({ task_id: 't1', status: 'completed', summary: 'done' });
    expect(processor.getTaskCompletionDebt()).toBe(1);

    processor.processSystemMessage(taskStarted('hk', { skip_transcript: true }));
    processor.processTaskNotification({ task_id: 'hk', status: 'completed', summary: 'tidy' });
    // housekeeping 通知不触发助手轮次，记债只会让收尾白等 90 秒
    expect(processor.getTaskCompletionDebt()).toBe(1);
  });

  test('未登记过的通知不记债（避免重复通知把债刷高）', () => {
    const { processor } = makeProcessor();
    processor.processTaskNotification({ task_id: 'unknown', status: 'completed', summary: 'x' });
    expect(processor.getTaskCompletionDebt()).toBe(0);
  });

  test('clearTaskCompletionDebt 归零', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processTaskNotification({ task_id: 't1', status: 'completed', summary: 'done' });
    processor.clearTaskCompletionDebt();
    expect(processor.getTaskCompletionDebt()).toBe(0);
  });

  test('task_notification 同时把电平集里的条目清掉', () => {
    const { processor } = makeProcessor();
    processor.processSystemMessage(taskStarted('t1'));
    processor.processSystemMessage(
      levelPayload([{ task_id: 't1', task_type: 'agent', description: 'work' }]),
    );
    processor.processTaskNotification({ task_id: 't1', status: 'completed', summary: 'done' });
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
  });
});
