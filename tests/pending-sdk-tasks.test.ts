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
