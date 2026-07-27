import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'usage-deferred-')),
);
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

const db = await import('../src/db.js');
const dbPath = path.join(tmpStoreDir, 'messages.db');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * usage 事件与回复消息的到达顺序。
 *
 * SDK 先报用量、再给最终文本，所以 usage 常常**早于**回复落库。主消息路径与
 * SubAgent 路径都为此设了 `pendingUsage` / `pendingAgentUsage` 缓存，等回复
 * 落库后由对应的 flush 函数补记。
 *
 * 合并时两处的**赋值一侧都丢了** —— 两个变量只被读和清空、从没被写过，
 * flush 恒为 no-op。后果是 `messages.token_usage` 永远是 NULL，飞书卡片的
 * metaRow 和 Web 的用量摘要行都拿不到数据，用户看到的现象是「那条 bar 没了」。
 *
 * 下面锁住那个让 pendingUsage 成为必需品的事实：回复还不存在时，
 * `updateLatestMessageTokenUsage` 的 fallback 匹配不到任何行，用量直接丢失。
 */
const USAGE_JSON = JSON.stringify({
  inputTokens: 10,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0.001,
  durationMs: 1234,
});

function readTokenUsage(chatJid: string, id: string): string | null {
  const raw = new Database(dbPath, { readonly: true });
  const row = raw
    .prepare('SELECT token_usage FROM messages WHERE id = ? AND chat_jid = ?')
    .get(id, chatJid) as { token_usage: string | null } | undefined;
  raw.close();
  return row?.token_usage ?? null;
}

function storeAgentReply(
  chatJid: string,
  id: string,
  ts: string,
  sourceKind?: string,
): void {
  db.storeChatMetadata(chatJid, ts, chatJid);
  db.storeMessageDirect(
    id,
    chatJid,
    'assistant',
    'Assistant',
    'reply',
    ts,
    true,
    sourceKind ? { meta: { sourceKind } } : undefined,
  );
}

describe('usage 早于回复到达时必须缓存', () => {
  test('回复不存在时 fallback 匹配不到任何行 —— 用量会丢', () => {
    const chatJid = 'web:no-reply-yet';
    db.storeChatMetadata(chatJid, '2026-07-27T00:00:00.000Z', chatJid);

    // 没有任何 agent 消息。fallback 的 WHERE is_from_me = 1 匹配不到 →
    // 静默不更新任何行。这正是 pendingUsage 存在的理由。
    expect(() =>
      db.updateLatestMessageTokenUsage(chatJid, USAGE_JSON, undefined, 0.001),
    ).not.toThrow();

    const raw = new Database(dbPath, { readonly: true });
    const n = (
      raw
        .prepare(
          'SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND token_usage IS NOT NULL',
        )
        .get(chatJid) as { n: number }
    ).n;
    raw.close();
    expect(n).toBe(0);
  });

  test('回复落库后按 id 精确补记成功（flush 的行为）', () => {
    const chatJid = 'web:deferred-flush';
    storeAgentReply(chatJid, 'm-deferred', '2026-07-27T00:00:00.000Z');

    db.updateLatestMessageTokenUsage(
      chatJid,
      USAGE_JSON,
      'm-deferred',
      0.001,
    );

    const stored = readTokenUsage(chatJid, 'm-deferred');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).inputTokens).toBe(10);
  });

  test('fallback 跳过 sdk_send_message，不把用量记到主动发送的消息上', () => {
    const chatJid = 'web:skip-send-message';
    // MCP send_message 主动发的消息不代表一个 turn 的用量归属。
    storeAgentReply(
      chatJid,
      'm-sdk-send',
      '2026-07-27T00:00:00.000Z',
      'sdk_send_message',
    );

    db.updateLatestMessageTokenUsage(chatJid, USAGE_JSON, undefined, 0.001);
    expect(readTokenUsage(chatJid, 'm-sdk-send')).toBeNull();
  });

  test('已有 token_usage 的消息不被 fallback 覆盖', () => {
    const chatJid = 'web:no-overwrite';
    storeAgentReply(chatJid, 'm-first', '2026-07-27T00:00:00.000Z');
    db.updateLatestMessageTokenUsage(chatJid, USAGE_JSON, 'm-first', 0.001);

    // 第二条也是 agent 消息但更早，fallback 取「最近一条无 token_usage 的」。
    storeAgentReply(chatJid, 'm-second', '2026-07-27T00:00:01.000Z');
    const second = JSON.stringify({ inputTokens: 99, outputTokens: 2 });
    db.updateLatestMessageTokenUsage(chatJid, second, undefined, 0);

    expect(JSON.parse(readTokenUsage(chatJid, 'm-first')!).inputTokens).toBe(10);
    expect(JSON.parse(readTokenUsage(chatJid, 'm-second')!).inputTokens).toBe(
      99,
    );
  });
});
