import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-turn-events-'));

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
const { recordTurnEvent, resetTurnTraceSeq } = await import('../src/turn-trace.ts');

/**
 * The turn execution trace — which tools ran, what sub-agents concluded — was
 * broadcast over WebSocket and then dropped. `messages` kept the final text,
 * but the work behind it survived only in whichever browser tab watched it
 * live; a refresh erased every tool-call and sub-agent panel.
 *
 * These tests pin down what gets persisted, what deliberately does not, and
 * that deletion paths take the trace with them.
 */
const ev = (eventType: string, extra: Record<string, unknown> = {}) =>
  ({ eventType, ...extra }) as never;

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('recordTurnEvent filtering', () => {
  test('persists turn-structure events', () => {
    const chat = 'web:filter-keep';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_start', { toolName: 'Bash' }));
    recordTurnEvent(chat, 'f1', ev('tool_use_end', { toolName: 'Bash' }));
    recordTurnEvent(chat, 'f1', ev('task_start', { taskId: 't1' }));
    recordTurnEvent(chat, 'f1', ev('usage', { usage: { inputTokens: 5 } }));

    expect(db.getTurnEventsForChat(chat).map((e) => e.eventType)).toEqual([
      'tool_use_start',
      'tool_use_end',
      'task_start',
      'usage',
    ]);
  });

  test('drops high-frequency deltas — they would multiply rows ~100x', () => {
    const chat = 'web:filter-drop';
    resetTurnTraceSeq(chat);
    for (let i = 0; i < 50; i++) {
      recordTurnEvent(chat, 'f1', ev('text_delta', { text: 'x' }));
      recordTurnEvent(chat, 'f1', ev('thinking_delta', { text: 'y' }));
    }
    expect(db.getTurnEventsForChat(chat)).toHaveLength(0);
  });

  test('an unknown event type is ignored rather than stored blindly', () => {
    const chat = 'web:filter-unknown';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('some_future_event'));
    expect(db.getTurnEventsForChat(chat)).toHaveLength(0);
  });

  test('a missing folder is skipped — the trace has nowhere to spill to', () => {
    const chat = 'web:filter-nofolder';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, '', ev('tool_use_start', { toolName: 'Bash' }));
    expect(db.getTurnEventsForChat(chat)).toHaveLength(0);
  });
});

describe('recorded content', () => {
  test('keeps the fields needed to rebuild a tool panel', () => {
    const chat = 'web:content';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_start', {
      toolName: 'Read',
      toolUseId: 'tu-1',
      turnId: 'turn-9',
      runtime: 'claude',
      summary: 'reading config',
      toolInput: { file_path: '/etc/hosts' },
    }));

    const [row] = db.getTurnEventsForChat(chat);
    expect(row.toolName).toBe('Read');
    expect(row.toolUseId).toBe('tu-1');
    expect(row.turnId).toBe('turn-9');
    expect(row.runtime).toBe('claude');
    expect(row.summary).toBe('reading config');
    expect(JSON.parse(row.payloadJson!).toolInput).toEqual({
      file_path: '/etc/hosts',
    });
  });

  test('sequence increases so events keep their order within a turn', () => {
    const chat = 'web:seq';
    resetTurnTraceSeq(chat);
    for (let i = 0; i < 5; i++) {
      recordTurnEvent(chat, 'f1', ev('tool_progress', { toolName: `t${i}` }));
    }
    const seqs = db.getTurnEventsForChat(chat).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(5);
  });

  test('a large payload spills to a file and leaves a readable preview', () => {
    const chat = 'web:spill';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'spillfolder', ev('tool_use_end', {
      toolName: 'Read',
      toolResult: 'z'.repeat(20_000),
    }));

    const [row] = db.getTurnEventsForChat(chat);
    expect(row.payloadFile).toBeTruthy();
    // The row must stay readable even if the spill file is later pruned.
    const inline = JSON.parse(row.payloadJson!);
    expect(inline.truncated).toBe(true);
    expect(inline.preview.length).toBeGreaterThan(0);

    const spilled = path.join(tmpRoot, 'groups', 'spillfolder', row.payloadFile!);
    expect(fs.existsSync(spilled)).toBe(true);
    expect(JSON.parse(fs.readFileSync(spilled, 'utf8')).toolResult).toHaveLength(
      20_000,
    );
  });

  test('a small payload stays inline — no file is written', () => {
    const chat = 'web:inline';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_end', { toolResult: 'ok' }));
    const [row] = db.getTurnEventsForChat(chat);
    expect(row.payloadFile).toBeNull();
    expect(JSON.parse(row.payloadJson!).toolResult).toBe('ok');
  });
});

describe('queries', () => {
  test('getTurnEvents returns one turn in order', () => {
    const chat = 'web:byturn';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_start', { turnId: 'T1' }));
    recordTurnEvent(chat, 'f1', ev('tool_use_end', { turnId: 'T1' }));
    recordTurnEvent(chat, 'f1', ev('tool_use_start', { turnId: 'T2' }));

    expect(db.getTurnEvents('T1')).toHaveLength(2);
    expect(db.getTurnEvents('T2')).toHaveLength(1);
  });

  test('chat query pages by id and returns oldest-first', () => {
    const chat = 'web:paging';
    resetTurnTraceSeq(chat);
    for (let i = 0; i < 10; i++) {
      recordTurnEvent(chat, 'f1', ev('tool_progress', { summary: `s${i}` }));
    }
    const lastThree = db.getTurnEventsForChat(chat, { limit: 3 });
    expect(lastThree.map((e) => e.summary)).toEqual(['s7', 's8', 's9']);

    const older = db.getTurnEventsForChat(chat, {
      limit: 3,
      beforeId: lastThree[0].id,
    });
    expect(older.map((e) => e.summary)).toEqual(['s4', 's5', 's6']);
  });

  test('events from other conversations never leak in', () => {
    resetTurnTraceSeq('web:iso-a');
    resetTurnTraceSeq('web:iso-b');
    recordTurnEvent('web:iso-a', 'f1', ev('tool_use_start', { toolName: 'A' }));
    recordTurnEvent('web:iso-b', 'f1', ev('tool_use_start', { toolName: 'B' }));

    expect(db.getTurnEventsForChat('web:iso-a').map((e) => e.toolName)).toEqual([
      'A',
    ]);
  });
});

describe('deletion', () => {
  test('deleting chat history takes the trace with it', () => {
    const chat = 'web:del-history';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_start', { toolName: 'X' }));
    expect(db.getTurnEventsForChat(chat)).toHaveLength(1);

    db.deleteChatHistory(chat);
    expect(db.getTurnEventsForChat(chat)).toHaveLength(0);
  });

  test('privacy cleanup removes the trace — it holds tool inputs and results', () => {
    const chat = 'web:del-privacy';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_end', { toolResult: 'sensitive' }));
    expect(db.getTurnEventsForChat(chat)).toHaveLength(1);

    db.deletePrivacyMessages(chat);
    expect(db.getTurnEventsForChat(chat)).toHaveLength(0);
  });

  test('explicit trace deletion reports how many rows went', () => {
    const chat = 'web:del-explicit';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_use_start'));
    recordTurnEvent(chat, 'f1', ev('tool_use_end'));
    expect(db.deleteTurnEventsForChat(chat)).toBe(2);
  });
});

describe('sub-agent and tool output are the point of the trace', () => {
  test('a sub-agent result is persisted in full', () => {
    // This is what used to vanish on refresh: a delegated research turn's
    // conclusion existed only in the browser tab that watched it stream.
    const chat = 'web:subagent';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('sub_agent_result', {
      toolUseId: 'tu-9',
      subAgentResult: {
        toolUseId: 'tu-9',
        description: 'Cognitive extraction',
        summary: '19 observations',
        text: 'detailed findings…',
      },
    }));

    const [row] = db.getTurnEventsForChat(chat);
    expect(row.eventType).toBe('sub_agent_result');
    const payload = JSON.parse(row.payloadJson!);
    expect(payload.subAgentResult.description).toBe('Cognitive extraction');
    expect(payload.subAgentResult.summary).toBe('19 observations');
    expect(payload.subAgentResult.text).toBe('detailed findings…');
  });

  test("a tool's returned content is persisted, not just that it ran", () => {
    const chat = 'web:toolresult';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('tool_result', {
      toolUseId: 'tu-1',
      toolResult: 'file contents here',
    }));

    const [row] = db.getTurnEventsForChat(chat);
    expect(JSON.parse(row.payloadJson!).toolResult).toBe('file contents here');
  });

  test('a compaction boundary is recorded so trace gaps stay explainable', () => {
    const chat = 'web:compact';
    resetTurnTraceSeq(chat);
    recordTurnEvent(chat, 'f1', ev('compact_boundary', { summary: 'compacted' }));
    expect(db.getTurnEventsForChat(chat)[0].eventType).toBe('compact_boundary');
  });
});
