import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { buildRuntimePrompt } = await import('../src/runtime-input-builder.ts');

/**
 * A runtime switch cannot resume the native session — a Claude session id means
 * nothing to Codex or Grok — so the receiving runtime used to start from the
 * handoff summary alone. A summary compresses away exactly what a continuing
 * conversation needs: the wording of the last decision, which file was being
 * edited, what the user actually asked.
 *
 * Real transcript now travels with the summary, bounded by a token budget. The
 * cost is one-off input tokens on the first turn after a switch; the alternative
 * is re-deriving that context by asking the user again.
 */
function msg(id: string, content: string, fromMe = false) {
  return {
    id,
    sender_name: fromMe ? 'HappyClaw' : 'user',
    content,
    timestamp: `2026-07-25T10:00:${id.padStart(2, '0')}.000Z`,
    is_from_me: fromMe,
  };
}

function build(over: Record<string, unknown> = {}) {
  return buildRuntimePrompt({
    runtime: 'codex',
    groupFolder: 'w1',
    chatJid: 'web:w1',
    turnId: 't1',
    basePrompt: 'continue',
    forceSoftInjectionReason: 'model_binding_changed',
    handoffSummary: { id: 'h1', text: '之前在排查登录失败' },
    recentMessages: [msg('01', '第一条'), msg('02', '第二条', true)],
    workspaceInstructions: '',
    ...over,
  } as Parameters<typeof buildRuntimePrompt>[0]);
}

describe('handoff carries real history alongside the summary', () => {
  test('both blocks are present', () => {
    const { prompt } = build();
    expect(prompt).toContain('<handoff-summary');
    expect(prompt).toContain('之前在排查登录失败');
    expect(prompt).toContain('<handoff-history');
    expect(prompt).toContain('第一条');
    expect(prompt).toContain('第二条');
  });

  test('messages keep chronological order', () => {
    const { prompt } = build();
    expect(prompt.indexOf('第一条')).toBeLessThan(prompt.indexOf('第二条'));
  });

  test('roles are labelled so the receiving runtime can tell who said what', () => {
    const { prompt } = build();
    expect(prompt).toContain('role="user"');
    expect(prompt).toContain('role="assistant"');
  });

  test('no history block when there are no messages', () => {
    const { prompt } = build({ recentMessages: [] });
    expect(prompt).toContain('<handoff-summary');
    expect(prompt).not.toContain('<handoff-history');
  });

  test('privacy mode emits neither summary nor history', () => {
    const { prompt } = build({ privacyMode: true });
    expect(prompt).not.toContain('<handoff-summary');
    expect(prompt).not.toContain('<handoff-history');
  });

  test('suppressRecentHistory drops the transcript but keeps the summary', () => {
    const { prompt } = build({ suppressRecentHistory: true });
    expect(prompt).toContain('<handoff-summary');
    expect(prompt).not.toContain('<handoff-history');
  });
});

describe('token budget', () => {
  test('a long conversation is trimmed and says so', () => {
    // 400 messages of ~800 Chinese characters each is far past 100k tokens.
    const many = Array.from({ length: 400 }, (_, i) =>
      msg(String(i).padStart(2, '0'), '排查'.repeat(400), i % 2 === 1),
    );
    const { prompt } = build({ recentMessages: many });

    expect(prompt).toContain('<handoff-history');
    // The attribute is how the model learns the record is partial rather than
    // assuming it has seen the whole conversation.
    expect(prompt).toMatch(/truncated-older="\d+"/);
  });

  test('the newest messages survive, the oldest are dropped', () => {
    // Dropping the tail would hand over a conversation missing its own ending.
    const many = Array.from({ length: 200 }, (_, i) =>
      msg(String(i).padStart(3, '0'), `消息${i}内容`.repeat(200), false),
    );
    const { prompt } = build({ recentMessages: many });
    expect(prompt).toContain('消息199内容');
    expect(prompt).not.toContain('消息0内容');
  });

  test('a short conversation is not marked as truncated', () => {
    const { prompt } = build();
    expect(prompt).not.toMatch(/truncated-older=/);
  });

  test('messages are carried whole, never per-message truncated', () => {
    // A half-quoted decision or clipped code block is often worse than the
    // message being absent, since the model cannot tell what was removed.
    const body = '完整内容'.repeat(500); // ~2000 chars, well within budget
    const { prompt } = build({ recentMessages: [msg('01', body, true)] });
    expect(prompt).toContain(body);
    expect(prompt).not.toContain('...');
  });

  test('a giant newest message is clipped rather than yielding an empty block', () => {
    // Pathological, but an empty history block would be worse than a clipped one.
    const { prompt } = build({
      recentMessages: [msg('01', '旧的'), msg('02', '巨'.repeat(400_000), true)],
    });
    expect(prompt).toContain('<handoff-history');
    expect(prompt).toContain('巨巨巨');
  });

  test('an older message that does not fit is dropped whole, not clipped', () => {
    const { prompt } = build({
      recentMessages: [
        msg('01', '这条太老放不下'.repeat(30_000)),
        msg('02', '最新的必须保留', true),
      ],
    });
    expect(prompt).toContain('最新的必须保留');
    expect(prompt).not.toContain('这条太老放不下');
    expect(prompt).toMatch(/truncated-older="1"/);
  });
});

describe('ordinary soft-injection is unchanged', () => {
  test('without a summary only recent-messages is emitted', () => {
    const { prompt } = build({
      handoffSummary: undefined,
      forceSoftInjectionReason: 'workspace_instructions_changed',
    });
    expect(prompt).not.toContain('<handoff-history');
    expect(prompt).not.toContain('<handoff-summary');
  });
});
