import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-notify-wake-'));
const storeDir = path.join(tmpDir, 'db');
fs.mkdirSync(storeDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('notification retry wake scheduling', () => {
  test('an active slow-delivery lease wakes at lease expiry, not stale available_at', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'slow-notification-wake',
      group_folder: 'workspace',
      chat_jid: 'web:workspace',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('slow-notification-wake')!;
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('execution-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'slow connector',
        },
        {
          kind: 'im_message',
          targetJid: 'feishu:slow',
          text: 'slow',
          localImagePaths: [],
        },
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const claim = db.claimNextTaskRunNotification('slow-worker', 60_000)!;
    const wakeAt = db.getNextTaskRunWakeAt();

    expect(wakeAt).toBe(claim.expiresAt);
    expect(new Date(wakeAt!).getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(
      db.claimNextTaskRunNotification('competing-worker', 60_000),
    ).toBeUndefined();
    expect(
      db.completeTaskRunNotificationAttempt(claim, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(true);
  });

  test('a crashed final attempt becomes terminal without replay or past wake', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'final-attempt-crash',
      group_folder: 'workspace-final',
      chat_jid: 'web:workspace-final',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('final-attempt-crash')!;
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('final-execution-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'initial failure',
        },
        {
          kind: 'im_message',
          targetJid: 'feishu:final',
          text: 'final',
          localImagePaths: [],
        },
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = db.claimTaskRunNotificationById(
        created.run.id,
        `crashed-worker-${attempt}`,
        2,
      )!;
      expect(claim.attempt).toBe(attempt);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(1);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'failed',
      notification_error: expect.stringContaining(
        'delivery outcome is unknown',
      ),
      notification_attempt: 5,
    });
    expect(
      db.claimTaskRunNotificationById(
        created.run.id,
        'must-not-replay',
        60_000,
      ),
    ).toBeUndefined();
    const raw = db.getTaskRunById(created.run.id) as unknown as {
      notification_payload: string | null;
      notification_lease_owner: string | null;
    };
    expect(raw.notification_payload).toBeNull();
    expect(raw.notification_lease_owner).toBeNull();
    expect(db.getNextTaskRunWakeAt()).toBeNull();
  });

  test('a crashed final A claim is terminal while late B keeps a fresh budget', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'final-attempt-late-payload',
      group_folder: 'workspace-late',
      chat_jid: 'web:workspace-late',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('final-attempt-late-payload')!;
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('late-execution-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    const payloadA: db.TaskRunNotificationPayload = {
      kind: 'im_message',
      targetJid: 'feishu:final-a',
      text: 'A',
      localImagePaths: [],
    };
    const payloadB: db.TaskRunNotificationPayload = {
      kind: 'im_file',
      targetJid: 'telegram:late-b',
      workspaceFolder: 'workspace-late',
      filePath: 'late-b.pdf',
      fileName: 'late-b.pdf',
    };
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'A initial failure',
        },
        payloadA,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    for (let attempt = 1; attempt < 5; attempt++) {
      const claim = db.claimTaskRunNotificationById(
        created.run.id,
        `late-crashed-worker-${attempt}`,
        2,
      )!;
      expect(claim.attempt).toBe(attempt);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finalClaim = db.claimTaskRunNotificationById(
      created.run.id,
      'late-crashed-worker-5',
      2,
    )!;
    expect(finalClaim).toMatchObject({ attempt: 5, payload: payloadA });

    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['telegram'],
          },
          error: 'B arrived during final A attempt',
        },
        payloadB,
      ),
    ).toBe(true);
    const beforeExpiry = db.getTaskRunById(created.run.id) as unknown as {
      notification_attempt: number;
      notification_payload: string;
      notification_lease_payload: string;
    };
    expect(beforeExpiry.notification_attempt).toBe(5);
    expect(JSON.parse(beforeExpiry.notification_lease_payload)).toEqual(
      payloadA,
    );
    expect(JSON.parse(beforeExpiry.notification_payload)).toMatchObject({
      kind: 'batch',
      items: expect.arrayContaining([payloadA, payloadB]),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(1);
    const recovered = db.getTaskRunById(created.run.id) as unknown as {
      notification_status: string;
      notification_error: string;
      notification_attempt: number;
      notification_payload: string;
      notification_lease_owner: string | null;
      notification_lease_payload: string | null;
    };
    expect(recovered).toMatchObject({
      notification_status: 'failed',
      notification_error: expect.stringContaining(
        'delivery outcome is unknown',
      ),
      notification_attempt: 0,
      notification_lease_owner: null,
      notification_lease_payload: null,
    });
    expect(JSON.parse(recovered.notification_payload)).toEqual(payloadB);
    const wakeAt = db.getNextTaskRunWakeAt();
    expect(wakeAt).not.toBeNull();
    expect(new Date(wakeAt!).getTime()).toBeGreaterThan(Date.now());

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const freshB = db.claimTaskRunNotificationById(
      created.run.id,
      'fresh-b-worker',
      60_000,
    )!;
    expect(freshB).toMatchObject({ attempt: 1, payload: payloadB });
    expect(
      db.completeTaskRunNotificationAttempt(freshB, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(true);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'partial_failed',
      notification_error: expect.stringContaining(
        'delivery outcome is unknown',
      ),
      notification_summary: {
        attempted: 4,
        succeeded: 1,
        failed: 3,
        failed_channels: expect.arrayContaining(['feishu', 'telegram']),
      },
    });
    expect(db.getNextTaskRunWakeAt()).toBeNull();
  });
});
