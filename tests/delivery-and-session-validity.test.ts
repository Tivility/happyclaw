import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-delivery-'));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return {
    ...actual,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.ts');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let n = 0;
function storeReply(chatJid: string): string {
  const id = `m${++n}`;
  // messages.chat_jid is a foreign key onto chats.
  db.storeChatMetadata(chatJid, new Date().toISOString(), chatJid);
  db.storeMessageDirect(
    id,
    chatJid,
    'happyclaw-agent',
    'HappyClaw',
    'reply body',
    new Date().toISOString(),
    true,
  );
  return id;
}

function statusOf(id: string, chatJid: string): string | null {
  return db.getMessageDeliveryState(id, chatJid)?.status ?? null;
}

/**
 * A stored reply used to record only that it existed. Whether it actually
 * reached Feishu/QQ/WeChat was invisible — a send that threw looked identical in
 * the database to one that arrived, so a dropped reply could only be discovered
 * by the user noticing it never came.
 */
describe('delivery state', () => {
  test('records a successful send', () => {
    const chat = 'feishu:oc_ok';
    const id = storeReply(chat);
    db.setMessageDeliveryState(id, chat, { status: 'sent', mode: 'feishu' });
    expect(statusOf(id, chat)).toBe('sent');
  });

  test('records a failed send so it is visible after the fact', () => {
    const chat = 'feishu:oc_fail';
    const id = storeReply(chat);
    db.setMessageDeliveryState(id, chat, { status: 'failed', mode: 'feishu' });
    expect(statusOf(id, chat)).toBe('failed');
  });

  test("records 'skipped' when a reply was deliberately not delivered", () => {
    // Routed elsewhere or web-only: not a failure, and must not read as one.
    const chat = 'feishu:oc_skip';
    const id = storeReply(chat);
    db.setMessageDeliveryState(id, chat, { status: 'skipped' });
    expect(statusOf(id, chat)).toBe('skipped');
  });

  test('pre-existing rows stay NULL rather than being backfilled with a guess', () => {
    // Inventing a status would turn thousands of historical rows into fabricated
    // delivery history.
    const chat = 'feishu:oc_untracked';
    const id = storeReply(chat);
    expect(statusOf(id, chat)).toBeNull();
  });

  test('a later update supersedes an earlier one', () => {
    const chat = 'feishu:oc_retry';
    const id = storeReply(chat);
    db.setMessageDeliveryState(id, chat, { status: 'pending' });
    db.setMessageDeliveryState(id, chat, { status: 'sent' });
    expect(statusOf(id, chat)).toBe('sent');
  });

  test('updating an unknown message is a silent no-op, never a throw', () => {
    // Bookkeeping must not fail a turn that already produced a reply.
    expect(() =>
      db.setMessageDeliveryState('missing', 'feishu:oc_x', { status: 'sent' }),
    ).not.toThrow();
  });

  test('stats count outcomes by status', () => {
    const chat = 'feishu:oc_stats';
    for (const status of ['sent', 'sent', 'failed'] as const) {
      db.setMessageDeliveryState(storeReply(chat), chat, { status });
    }
    const stats = db.getDeliveryStats();
    expect(stats.sent).toBeGreaterThanOrEqual(2);
    expect(stats.failed).toBeGreaterThanOrEqual(1);
  });

  test('stale pending deliveries surface — those read as "the agent never answered"', () => {
    const chat = 'feishu:oc_stale';
    const id = storeReply(chat);
    db.setMessageDeliveryState(id, chat, { status: 'pending' });

    // Nothing is stale yet.
    expect(db.getStalePendingDeliveries(60_000).map((r) => r.id)).not.toContain(id);
    // With a zero threshold every pending row qualifies.
    expect(db.getStalePendingDeliveries(0).map((r) => r.id)).toContain(id);
  });

  test('settled deliveries never appear as stale', () => {
    const chat = 'feishu:oc_settled';
    const id = storeReply(chat);
    db.setMessageDeliveryState(id, chat, { status: 'sent' });
    expect(db.getStalePendingDeliveries(0).map((r) => r.id)).not.toContain(id);
  });
});

/**
 * Session validity combines two checks that each codebase tracked alone:
 * upstream invalidated on persona drift, this fork on runtime/provider/model
 * drift. Only the conjunction actually means "resumable".
 */
describe('evaluateSessionValidity', () => {
  const base = {
    identityHash: 'h1',
    agentProfileId: 'p1',
    runtime: 'claude',
    providerId: 'prov1',
    resolvedModel: 'opus',
  };

  test('identical state is valid', () => {
    const v = db.evaluateSessionValidity(base, { ...base });
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.shouldDiscard).toBe(false);
  });

  test('persona drift is reported but must NOT discard the session (O1-b)', () => {
    // The prompt prefix changed; the next turn pays one cache miss, exactly as
    // it already does when the agent rewrites its own CLAUDE.md.
    const v = db.evaluateSessionValidity(base, { ...base, identityHash: 'h2' });
    expect(v.valid).toBe(false);
    expect(v.reasons).toContain('persona_changed');
    expect(v.shouldDiscard).toBe(false);
  });

  test('switching profile also counts as persona drift', () => {
    const v = db.evaluateSessionValidity(base, { ...base, agentProfileId: 'p2' });
    expect(v.reasons).toContain('persona_changed');
    expect(v.shouldDiscard).toBe(false);
  });

  test('runtime drift discards — a native session id is meaningless to another runtime', () => {
    const v = db.evaluateSessionValidity(base, { ...base, runtime: 'codex' });
    expect(v.reasons).toContain('runtime_changed');
    expect(v.shouldDiscard).toBe(true);
  });

  test('provider drift discards', () => {
    const v = db.evaluateSessionValidity(base, { ...base, providerId: 'prov2' });
    expect(v.reasons).toContain('provider_changed');
    expect(v.shouldDiscard).toBe(true);
  });

  test('model drift discards', () => {
    const v = db.evaluateSessionValidity(base, { ...base, resolvedModel: 'sonnet' });
    expect(v.reasons).toContain('model_changed');
    expect(v.shouldDiscard).toBe(true);
  });

  test('persona plus engine drift discards, and reports both', () => {
    const v = db.evaluateSessionValidity(base, {
      ...base,
      identityHash: 'h2',
      runtime: 'grok',
    });
    expect(v.reasons).toEqual(
      expect.arrayContaining(['persona_changed', 'runtime_changed']),
    );
    expect(v.shouldDiscard).toBe(true);
  });

  test('a missing value on either side is silence, not a mismatch', () => {
    // Sessions predating these columns must not all invalidate at once.
    expect(db.evaluateSessionValidity({}, base).valid).toBe(true);
    expect(db.evaluateSessionValidity(base, {}).valid).toBe(true);
    expect(
      db.evaluateSessionValidity({ ...base, runtime: null }, base).valid,
    ).toBe(true);
  });
});

describe('evaluateStoredSessionValidity', () => {
  test('reads persona identity from sessions and reports drift', () => {
    db.setSession('folder-v', 'sdk-1');
    db.setSessionAgentIdentity('folder-v', '', {
      agentProfileId: 'p1',
      identityHash: 'h1',
      version: 1,
    });

    const same = db.evaluateStoredSessionValidity('folder-v', '', {
      agentProfileId: 'p1',
      identityHash: 'h1',
    });
    expect(same.valid).toBe(true);

    const drifted = db.evaluateStoredSessionValidity('folder-v', '', {
      agentProfileId: 'p1',
      identityHash: 'h2',
    });
    expect(drifted.reasons).toContain('persona_changed');
    // Still keeps the context — the whole point of O1-b.
    expect(drifted.shouldDiscard).toBe(false);
  });

  test('an unknown session reports valid rather than inventing drift', () => {
    expect(
      db.evaluateStoredSessionValidity('folder-absent', '', {
        identityHash: 'h1',
        runtime: 'claude',
      }).valid,
    ).toBe(true);
  });
});
