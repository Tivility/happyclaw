import { getMessagesPage } from './db.js';

/**
 * Build a `<system_context>` block of recent persisted HappyClaw chat history
 * to prepend to a prompt when the underlying Claude SDK session is fresh
 * (recovery after a crash, or after switching provider/model so the old
 * thinking-block-bearing session was cleared). Without this the new model sees
 * an empty conversation and loses context the user already established.
 *
 * Shared by the orchestration layer (index.ts: recovery + agent fresh-session)
 * and the container/host runner (proactive provider switch that clears the
 * session). Keeping a single implementation ensures the injected framing — and
 * the lone-surrogate / closing-tag sanitisation — stays byte-for-byte
 * consistent across every path that feeds the same Anthropic API.
 *
 * Messages are carried whole up to a token budget, matching the runtime-handoff
 * path: losing the session to a provider rotation and losing it to a runtime
 * switch are the same event from the user's side, so they hand over the same
 * amount of context.
 */
/**
 * Rough token count, CJK-aware.
 *
 * Mirrors estimateTokens in runtime-input-builder.ts — a plain chars/4 estimate
 * under-counts Chinese text by roughly 3x, which on a mostly-Chinese deployment
 * would let a 100k budget admit ~300k tokens and blow the context window.
 * Counting CJK codepoints as about one token each errs toward over-counting, so
 * the budget is respected rather than silently exceeded.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Default budget, matching the runtime-handoff path so both hand over the same amount. */
const DEFAULT_HISTORY_TOKEN_BUDGET = 100_000;

export function buildRecentConversationHistoryContext(
  chatJid: string,
  pendingMessageIds: Set<string>,
  opts: {
    limit?: number;
    tokenBudget?: number;
    intro: string;
  },
): { context: string; count: number; droppedCount: number } | null {
  const recentHistory = getMessagesPage(chatJid, undefined, opts.limit ?? 1000);
  const candidates = recentHistory
    .reverse()
    .filter((m) => !pendingMessageIds.has(m.id))
    .filter((m) => m.content.trim().length > 0);

  if (candidates.length === 0) return null;

  // Fill backwards from the newest message, taking each one whole.
  //
  // Per-message truncation would hand the model a transcript of mutilated
  // messages — a half-quoted decision or clipped code block is often worse than
  // the message being absent, because the model cannot tell what was removed and
  // will treat the fragment as the whole. Dropping whole old messages degrades
  // cleanly instead: everything present is verbatim, and the drop count is
  // stated so the model knows the record is partial.
  const budget = opts.tokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET;
  const picked: typeof candidates = [];
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i];
    const cost = estimateTokens(message.content) + 16; // per-line envelope
    if (used + cost > budget) break;
    used += cost;
    picked.push(message);
  }
  picked.reverse();

  // A single newest message larger than the whole budget is pathological, but
  // handing over nothing would be worse than handing over a clipped one.
  if (picked.length === 0) {
    const newest = candidates[candidates.length - 1];
    picked.push({ ...newest, content: newest.content.slice(0, budget * 2) });
  }

  const historyMsgs = picked;
  const droppedCount = candidates.length - historyMsgs.length;

  const historyLines = historyMsgs.map((m) => {
    const role = m.is_from_me ? 'assistant' : m.sender_name;
    const truncated = m.content;
    // Strip lone (unpaired) surrogates while preserving valid surrogate pairs
    // such as emoji. Must stay byte-for-byte aligned with the matching regex in
    // container/agent-runner/src/index.ts:extractSessionHistory — both sides
    // feed the same Anthropic API and must produce identical strings.
    let cleaned = truncated.replace(
      /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
      '',
    );
    // Defense in depth: strip the closing tag we use to fence this block so a
    // user message containing "</system_context>" can't escape early.
    cleaned = cleaned.replace(/<\/system_context>/gi, '</system_context_>');
    return `[${role}] ${cleaned}`;
  });

  const droppedNote =
    droppedCount > 0
      ? `\n（更早的 ${droppedCount} 条因长度限制未包含，这份记录是部分的。）`
      : '';

  return {
    count: historyMsgs.length,
    droppedCount,
    context:
      '<system_context>\n' +
      opts.intro +
      '\n重要：这些只是 HappyClaw 持久化的历史聊天记录，用来在新模型/新 session 中恢复上下文。回答当前用户消息时，请优先依据当前消息和当前文件状态；如果历史与当前问题无关，请直接忽略。' +
      droppedNote +
      '\n\n' +
      historyLines.join('\n') +
      '\n</system_context>\n\n',
  };
}
