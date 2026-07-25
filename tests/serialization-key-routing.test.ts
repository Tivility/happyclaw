import { describe, expect, test } from 'vitest';
import {
  resolveExecutingFolder,
  resolveSerializationKey,
  type GroupRoutingRow,
} from '../src/task-routing.js';

/**
 * Regression coverage for the folder-vs-execution split that let a workspace
 * reset / interrupt reach across workspaces.
 *
 * IM chats auto-register to their owner's home folder (§8.2). When the chat is
 * later bound to a dedicated workspace, `target_main_jid` starts pointing at
 * that workspace but the `folder` column keeps its original value. On the
 * reference deployment folder='main' collects 24 JIDs, 21 of which actually
 * execute in their own workspace folder — so keying serialization on `folder`
 * made all 21 resolve to main's runner.
 */

// Mirrors the reference deployment: web:main + a QQ chat + a Feishu DM really
// live in main; two Feishu groups carry folder='main' but route elsewhere.
const groups: Record<string, GroupRoutingRow | undefined> = {
  'web:main': { folder: 'main' },
  'qq:c2c:QQ1': { folder: 'main' },
  'feishu:DM': { folder: 'main' },
  'feishu:G1': { folder: 'main', target_main_jid: 'web:ws-alpha' },
  'feishu:G2': { folder: 'main', target_main_jid: 'web:ws-beta' },
  'web:ws-alpha': { folder: 'flow-alpha' },
  'web:ws-beta': { folder: 'flow-beta' },
  // Self-referential binding: pointer resolves back into the same folder.
  'feishu:SELF': { folder: 'flow-alpha', target_main_jid: 'web:ws-alpha' },
};

describe('resolveExecutingFolder', () => {
  test('unrouted rows keep their own folder', () => {
    expect(resolveExecutingFolder('web:main', groups)).toBe('main');
    expect(resolveExecutingFolder('qq:c2c:QQ1', groups)).toBe('main');
    expect(resolveExecutingFolder('feishu:DM', groups)).toBe('main');
  });

  test('routed rows resolve to the target workspace folder, not their own', () => {
    expect(resolveExecutingFolder('feishu:G1', groups)).toBe('flow-alpha');
    expect(resolveExecutingFolder('feishu:G2', groups)).toBe('flow-beta');
  });

  test('self-referential binding stays in the same folder', () => {
    expect(resolveExecutingFolder('feishu:SELF', groups)).toBe('flow-alpha');
  });

  test('unknown JID falls back to itself', () => {
    expect(resolveExecutingFolder('feishu:UNKNOWN', groups)).toBe(
      'feishu:UNKNOWN',
    );
  });

  test('dangling pointer falls back to the row folder', () => {
    const dangling: Record<string, GroupRoutingRow | undefined> = {
      'feishu:X': { folder: 'main', target_main_jid: 'web:deleted' },
    };
    expect(resolveExecutingFolder('feishu:X', dangling)).toBe('main');
  });
});

describe('resolveSerializationKey', () => {
  test('JIDs sharing a folder column but routing elsewhere get distinct keys', () => {
    const mainKey = resolveSerializationKey('web:main', groups);
    const g1Key = resolveSerializationKey('feishu:G1', groups);
    const g2Key = resolveSerializationKey('feishu:G2', groups);

    expect(g1Key).not.toBe(mainKey);
    expect(g2Key).not.toBe(mainKey);
    expect(g1Key).not.toBe(g2Key);
  });

  test('a routed IM JID shares its key with the workspace serving it', () => {
    // This is what makes interrupting from the IM side hit the right runner.
    expect(resolveSerializationKey('feishu:G1', groups)).toBe(
      resolveSerializationKey('web:ws-alpha', groups),
    );
  });

  test('genuine main siblings still share one key', () => {
    const mainKey = resolveSerializationKey('web:main', groups);
    expect(resolveSerializationKey('qq:c2c:QQ1', groups)).toBe(mainKey);
    expect(resolveSerializationKey('feishu:DM', groups)).toBe(mainKey);
  });

  test('agent virtual JIDs key on the executing folder plus agent id', () => {
    expect(resolveSerializationKey('feishu:G1#agent:a1', groups)).toBe(
      'flow-alpha#a1',
    );
    expect(resolveSerializationKey('web:main#agent:a1', groups)).toBe('main#a1');
  });

  test('task virtual JIDs key on the executing folder plus task id', () => {
    expect(resolveSerializationKey('feishu:G2#task:t7', groups)).toBe(
      'flow-beta#task:t7',
    );
    expect(resolveSerializationKey('web:main#task:t7', groups)).toBe(
      'main#task:t7',
    );
  });

  test('sub-agent and task keys stay separate from their parent conversation', () => {
    const parent = resolveSerializationKey('web:main', groups);
    expect(resolveSerializationKey('web:main#agent:a1', groups)).not.toBe(
      parent,
    );
    expect(resolveSerializationKey('web:main#task:t7', groups)).not.toBe(
      parent,
    );
  });

  test('agent ids containing a colon survive the split', () => {
    expect(resolveSerializationKey('web:main#agent:a:1', groups)).toBe(
      'main#a:1',
    );
  });
});
