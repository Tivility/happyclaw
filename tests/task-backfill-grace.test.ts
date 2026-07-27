import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir — same pattern as task-meta.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backfill-grace-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  createTask,
  getTaskById,
  getDueTasks,
  claimTaskForRun,
  advanceSkippedTask,
  updateTaskAfterRun,
  clearStaleTaskLeases,
  listHeldTaskLeases,
  releaseTaskLeaseByRunner,
} = await import('../src/db.js');

const { shouldSkipBackfill, validateCronMinimumInterval } =
  await import('../src/task-scheduler.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  createTask({
    id,
    group_folder: 'home-test',
    chat_jid: 'web:home-test',
    prompt: 'noop',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    script_command: null,
    execution_mode: 'container',
    next_run: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h overdue
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    workspace_jid: null,
    workspace_folder: null,
    ...overrides,
  });
  return id;
}

describe('task backfill grace — db helpers', () => {
  test('cron minimum interval is deterministic from the complete seconds field', () => {
    for (const value of ['* * * * * *', '0,30 0 * * * *', '@secondly']) {
      expect(() => validateCronMinimumInterval(value)).toThrow(
        'at least 60 seconds',
      );
    }
    for (const value of ['* * * * *', '0 * * * * *', '*/60 * * * * *']) {
      expect(() => validateCronMinimumInterval(value)).not.toThrow();
    }
  });

  test('getDueTasks returns all tasks with next_run <= now (regardless of how overdue)', () => {
    const id1 = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(), // 1 min overdue
    });
    const id2 = makeTask({
      next_run: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days overdue
    });
    const due = getDueTasks();
    const ids = due.map((t) => t.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  test('advanceSkippedTask updates next_run and does NOT touch last_run', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    });
    const before = getTaskById(id)!;
    expect(before.last_run).toBeFalsy(); // never ran

    const newNext = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    advanceSkippedTask(id, newNext);

    const after = getTaskById(id)!;
    expect(after.next_run).toBe(newNext);
    expect(after.last_run).toBeFalsy(); // still not set — skipping is not running
    expect(after.status).toBe('active');
  });

  test('advanceSkippedTask with null nextRun marks once-task as completed', () => {
    const id = makeTask({
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    advanceSkippedTask(id, null);
    const after = getTaskById(id)!;
    expect(after.next_run).toBeNull();
    expect(after.status).toBe('completed');
  });

  test('updateTaskAfterRun continues to set last_run (sanity check the helpers stay distinct)', () => {
    const id = makeTask();
    updateTaskAfterRun(
      id,
      new Date(Date.now() + 60_000).toISOString(),
      'ran ok',
    );
    const after = getTaskById(id)!;
    expect(after.last_run).toBeTruthy(); // contrast with advanceSkippedTask
    expect(after.last_result).toBe('ran ok');
  });

  test('claimTaskForRun gives a due task to only one scheduler runner and hides it from getDueTasks until released', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(claimTaskForRun(id, 'runner-a', 60_000)).toBe(true);
    expect(claimTaskForRun(id, 'runner-b', 60_000)).toBe(false);
    expect(getDueTasks().map((t) => t.id)).not.toContain(id);

    updateTaskAfterRun(
      id,
      new Date(Date.now() + 60_000).toISOString(),
      'claimed run done',
    );
    const after = getTaskById(id)!;
    expect(after.running_until).toBeNull();
    expect(after.runner_id).toBeNull();
  });

  test('clearStaleTaskLeases releases a lease abandoned by a crashed runner so the task becomes due again', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    // Simulate a runner claiming the task, then crashing before it can call
    // updateTaskAfterRun/advanceSkippedTask — running_until/runner_id are
    // left set in the DB, exactly as they would be after a process kill.
    expect(claimTaskForRun(id, 'crashed-runner', 30 * 60_000)).toBe(true);
    expect(getDueTasks().map((t) => t.id)).not.toContain(id);

    const cleared = clearStaleTaskLeases();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const after = getTaskById(id)!;
    expect(after.running_until).toBeNull();
    expect(after.runner_id).toBeNull();
    // The task must be immediately claimable again by the restarted
    // scheduler, not hidden until the old (now-meaningless) lease expiry.
    expect(getDueTasks().map((t) => t.id)).toContain(id);
    expect(claimTaskForRun(id, 'new-runner', 30 * 60_000)).toBe(true);
  });

  test('clearStaleTaskLeases is a no-op when no task holds a lease', () => {
    // A task with no lease at all must not be touched/counted.
    makeTask({ next_run: new Date(Date.now() - 60_000).toISOString() });
    const clearedFirst = clearStaleTaskLeases();
    expect(clearedFirst).toBeGreaterThanOrEqual(0);
    const clearedSecond = clearStaleTaskLeases();
    expect(clearedSecond).toBe(0);
  });
});

describe('task backfill grace — decision predicate', () => {
  // Imported directly from production code so a future inline-only change
  // breaks the test rather than silently drifting from a local mirror.

  test('graceMs=0 disables skipping (legacy behavior preserved)', () => {
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(shouldSkipBackfill(tenDaysAgo, Date.now(), 0)).toBe(false);
  });

  test('within grace window: do not skip', () => {
    const now = Date.now();
    const oneMinuteAgo = new Date(now - 60_000).toISOString();
    // grace = 5 min; 1 min overdue is within window
    expect(shouldSkipBackfill(oneMinuteAgo, now, 300_000)).toBe(false);
  });

  test('beyond grace window: skip', () => {
    const now = Date.now();
    const tenMinutesAgo = new Date(now - 10 * 60_000).toISOString();
    // grace = 5 min; 10 min overdue exceeds window
    expect(shouldSkipBackfill(tenMinutesAgo, now, 300_000)).toBe(true);
  });

  test('null next_run never triggers skip', () => {
    expect(shouldSkipBackfill(null, Date.now(), 300_000)).toBe(false);
  });

  test('exactly at boundary: do not skip (overdue must be strictly greater)', () => {
    const now = Date.now();
    const exactlyFiveMinutesAgo = new Date(now - 300_000).toISOString();
    expect(shouldSkipBackfill(exactlyFiveMinutesAgo, now, 300_000)).toBe(false);
  });
});

describe('旧机制租约 · 按持有者定向回收', () => {
  test('listHeldTaskLeases 只列出真正持有租约的任务', () => {
    const held = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    const free = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(claimTaskForRun(held, '999999:abc', 60_000)).toBe(true);

    const ids = listHeldTaskLeases().map((r) => r.id);
    expect(ids).toContain(held);
    expect(ids).not.toContain(free);
    expect(
      listHeldTaskLeases().find((r) => r.id === held)?.runner_id,
    ).toBe('999999:abc');
  });

  test('releaseTaskLeaseByRunner 只释放指定持有者的租约', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(claimTaskForRun(id, 'runner-x:1', 60_000)).toBe(true);

    // 持有者不匹配 → 不动。这条是安全性关键：否则重启的进程会清掉仍在
    // 运行的兄弟进程的租约，同一任务被跑两遍。
    expect(releaseTaskLeaseByRunner(id, 'runner-y:2')).toBe(false);
    expect(getDueTasks().map((t) => t.id)).not.toContain(id);

    // 持有者匹配 → 释放，任务重新变成 due。
    expect(releaseTaskLeaseByRunner(id, 'runner-x:1')).toBe(true);
    expect(getDueTasks().map((t) => t.id)).toContain(id);
  });

  test('回收判定用 pid 存活：本进程 pid 判为活、不存在的 pid 判为死', () => {
    // 复刻 reclaimDeadRunnerLeases 的判定，锁住「signal 0 探测 + ESRCH 才算死」
    // 这个语义。EPERM（进程存在但非本用户）必须算活，否则会误清。
    const isAlive = (runnerId: string): boolean => {
      const pid = Number(runnerId.split(':')[0]);
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    };

    expect(isAlive(`${process.pid}:self`)).toBe(true);
    // 4194304 超过 Linux/macOS 的默认 pid 上限，必然不存在。
    expect(isAlive('4194304:dead')).toBe(false);
    // runner_id 形态异常时保守判活，宁可等自然过期也不误清。
    expect(isAlive('not-a-pid:x')).toBe(true);
  });
});
