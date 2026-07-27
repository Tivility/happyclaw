import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: '/tmp/happyclaw-group-queue-close-retry',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: vi.fn(),
}));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 10,
    maxConcurrentHostProcesses: 10,
  }),
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

const JID = 'web:close-retry';
const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let queue: InstanceType<typeof GroupQueue>;

beforeEach(() => {
  vi.useFakeTimers();
  queue = new GroupQueue();
});

afterEach(async () => {
  await queue.shutdown(0);
  vi.useRealTimers();
});

describe('GroupQueue close outcome retry lifecycle', () => {
  test('replays after backoff without requiring a new message', async () => {
    let runs = 0;
    queue.setProcessMessagesFn(async () => {
      runs += 1;
      // First result models closed + no reply + no healthy input completion;
      // the replay then models a completed turn.
      return runs > 1;
    });

    queue.enqueueMessageCheck(JID);
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(runs).toBe(1);

    // No enqueueMessageCheck call occurs here: expiry of the queue-owned
    // backoff timer alone must start the replay.
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(runs).toBe(2);
    expect(queue.getRetryCount(JID)).toBe(0);
  });

  test('user stop cancels a pending failed-run retry', async () => {
    let runs = 0;
    queue.setProcessMessagesFn(async () => {
      runs += 1;
      return false;
    });

    queue.enqueueMessageCheck(JID);
    await flushPromises();
    expect(queue.getRetryCount(JID)).toBe(1);

    await queue.stopGroup(JID);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(0);
  });

  test('restart owns one fresh launch and leaves no duplicate retry timer', async () => {
    let runs = 0;
    let finishReplacement!: () => void;
    const replacementFinished = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    queue.setProcessMessagesFn(async () => {
      runs += 1;
      if (runs === 1) return false;
      if (runs === 2) await replacementFinished;
      return true;
    });

    queue.enqueueMessageCheck(JID);
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    await queue.restartGroup(JID);
    await flushPromises();
    expect(runs).toBe(2);
    expect(queue.getRetryCount(JID)).toBe(0);

    // Keep the replacement in-flight past the old timer's deadline. A stale
    // timer would enqueue/drain it and cause a third run after completion.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(runs).toBe(2);

    finishReplacement();
    await flushPromises();
    expect(runs).toBe(2);
  });

  test('a fresh message supersedes the pending failed-run timer', async () => {
    let runs = 0;
    let finishFreshRun!: () => void;
    const freshRunFinished = new Promise<void>((resolve) => {
      finishFreshRun = resolve;
    });
    queue.setProcessMessagesFn(async () => {
      runs += 1;
      if (runs === 1) return false;
      await freshRunFinished;
      return true;
    });

    queue.enqueueMessageCheck(JID);
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    // A newly-arrived message starts immediately and owns recovery. The old
    // 5s timer must not drain or enqueue this in-flight replacement.
    queue.enqueueMessageCheck(JID);
    await flushPromises();
    expect(runs).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(runs).toBe(2);

    finishFreshRun();
    await flushPromises();
    expect(runs).toBe(2);
  });

  test('consecutive failures exhaust the bounded exponential backoff', async () => {
    let runs = 0;
    const onMaxRetriesExceeded = vi.fn();
    queue.setProcessMessagesFn(async () => {
      runs += 1;
      return false;
    });
    queue.setOnMaxRetriesExceeded(onMaxRetriesExceeded);

    queue.enqueueMessageCheck(JID);
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(runs).toBe(2);
    expect(queue.getRetryCount(JID)).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(runs).toBe(3);
    expect(queue.getRetryCount(JID)).toBe(3);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(runs).toBe(4);

    await vi.advanceTimersByTimeAsync(40_000);
    await flushPromises();
    expect(runs).toBe(5);
    expect(queue.getRetryCount(JID)).toBe(5);

    await vi.advanceTimersByTimeAsync(80_000);
    await flushPromises();
    expect(runs).toBe(6);
    expect(onMaxRetriesExceeded).toHaveBeenCalledOnce();
    expect(onMaxRetriesExceeded).toHaveBeenCalledWith(JID);
    expect(queue.getRetryCount(JID)).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(runs).toBe(6);
  });

  test('conversation task retries on its task lane without invoking message processing', async () => {
    const agentJid = `${JID}#agent:conversation-retry`;
    let taskRuns = 0;
    let messageRuns = 0;
    queue.setProcessMessagesFn(async () => {
      messageRuns += 1;
      return true;
    });

    queue.enqueueTask(agentJid, 'agent-conversation', async () => {
      taskRuns += 1;
      return taskRuns > 1;
    });
    await flushPromises();
    expect(taskRuns).toBe(1);
    expect(messageRuns).toBe(0);
    expect(queue.getRetryCount(agentJid)).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(taskRuns).toBe(2);
    expect(messageRuns).toBe(0);
    expect(queue.getRetryCount(agentJid)).toBe(0);
  });

  test('ordinary stop discards a pending conversation-task retry', async () => {
    const agentJid = `${JID}#agent:conversation-stop`;
    let taskRuns = 0;
    queue.enqueueTask(agentJid, 'agent-conversation', async () => {
      taskRuns += 1;
      return false;
    });
    await flushPromises();
    expect(taskRuns).toBe(1);
    expect(queue.getRetryCount(agentJid)).toBe(1);

    await queue.stopGroup(agentJid);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(taskRuns).toBe(1);
    expect(queue.getRetryCount(agentJid)).toBe(0);
  });
});
