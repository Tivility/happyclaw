import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-archive-'));

vi.mock('../src/config.js', () => ({ GROUPS_DIR: path.join(tmpRoot, 'groups') }));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { appendConversationArchive } = await import('../src/conversation-archive.ts');

/**
 * Archives are what `memory_search` greps, so the agent's recall of recent
 * conversations depends entirely on them being current.
 *
 * They used to be written only by the Claude SDK's PreCompact hook. Codex and
 * Grok emit no compaction event at all, and a ~1M-token window makes compaction
 * rare even on Claude — measured on the reference deployment, 4 archive files
 * across every workspace in 7 days, with `main` six weeks stale. These tests
 * lock in the replacement: written per completed turn, independent of runtime.
 */
function readArchive(folder: string, when = new Date()): string {
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
  return fs.readFileSync(
    path.join(tmpRoot, 'groups', folder, 'conversations', `${stamp}.md`),
    'utf8',
  );
}

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'groups'), { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(tmpRoot, 'groups'), { recursive: true, force: true });
});

describe('appendConversationArchive', () => {
  test('writes prompt and reply into the monthly file', () => {
    const written = appendConversationArchive({
      folder: 'w1',
      prompt: 'what is the plan',
      reply: 'here is the plan',
    });
    expect(written).toBeTruthy();

    const body = readArchive('w1');
    expect(body).toContain('**User**');
    expect(body).toContain('what is the plan');
    expect(body).toContain('**Assistant**');
    expect(body).toContain('here is the plan');
  });

  test('creates the conversations directory on first write', () => {
    // The workspace may never have compacted, so the directory can be absent.
    appendConversationArchive({ folder: 'fresh', reply: 'hi' });
    expect(
      fs.existsSync(path.join(tmpRoot, 'groups', 'fresh', 'conversations')),
    ).toBe(true);
  });

  test('appends rather than overwrites across turns', () => {
    appendConversationArchive({ folder: 'w1', prompt: 'first', reply: 'r1' });
    appendConversationArchive({ folder: 'w1', prompt: 'second', reply: 'r2' });

    const body = readArchive('w1');
    expect(body).toContain('first');
    expect(body).toContain('second');
    expect(body.match(/^---$/gm)?.length).toBe(2);
  });

  test('records the runtime so per-runtime gaps stay visible', () => {
    // The whole point of the change: codex/grok turns must appear too.
    for (const runtime of ['claude', 'codex', 'grok']) {
      appendConversationArchive({ folder: 'multi', reply: 'ok', runtime });
    }
    const body = readArchive('multi');
    expect(body).toContain('· claude');
    expect(body).toContain('· codex');
    expect(body).toContain('· grok');
  });

  test('records the chat jid so a multi-chat folder stays disambiguated', () => {
    appendConversationArchive({
      folder: 'w1',
      reply: 'ok',
      chatJid: 'feishu:oc_abc',
    });
    expect(readArchive('w1')).toContain('<!-- chat: feishu:oc_abc -->');
  });

  test('privacy mode skips archiving entirely', () => {
    const written = appendConversationArchive({
      folder: 'private',
      prompt: 'secret',
      reply: 'also secret',
      privacyMode: true,
    });
    expect(written).toBeNull();
    expect(
      fs.existsSync(path.join(tmpRoot, 'groups', 'private', 'conversations')),
    ).toBe(false);
  });

  test('an empty turn writes nothing', () => {
    expect(appendConversationArchive({ folder: 'w1' })).toBeNull();
    expect(
      appendConversationArchive({ folder: 'w1', prompt: '  ', reply: '' }),
    ).toBeNull();
  });

  test('a reply-only turn still archives', () => {
    // Scheduled tasks and agent-initiated sends have no user prompt.
    appendConversationArchive({ folder: 'w1', reply: 'proactive note' });
    const body = readArchive('w1');
    expect(body).toContain('proactive note');
    expect(body).not.toContain('**User**');
  });

  test('a runaway turn is clipped rather than dominating the file', () => {
    appendConversationArchive({ folder: 'w1', reply: 'x'.repeat(300_000) });
    const body = readArchive('w1');
    expect(body).toContain('已截断，原文 300000 字符');
    expect(body.length).toBeLessThan(220_000);
  });

  test('a missing folder name is rejected', () => {
    expect(appendConversationArchive({ folder: '', reply: 'x' })).toBeNull();
  });

  test('write failures never throw — a completed turn must not fail on archiving', () => {
    // Make the workspace path a file so mkdirSync cannot create under it.
    fs.mkdirSync(path.join(tmpRoot, 'groups'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'groups', 'blocked'), 'not a dir');
    expect(() =>
      appendConversationArchive({ folder: 'blocked', reply: 'x' }),
    ).not.toThrow();
    expect(appendConversationArchive({ folder: 'blocked', reply: 'x' })).toBeNull();
  });
});
