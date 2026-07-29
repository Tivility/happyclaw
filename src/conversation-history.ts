import { getMessagesPage } from './db.js';
import { escapeXml } from './message-prompt.js';

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
    /** 单条消息最大长度（本地历史注入用）。 */
    maxMessageLength?: number;
  },
): {
  context: string;
  count: number;
  // droppedCount 供 runtime-input-builder 提示「这份记录是部分的」；
  // messageIds 供 feishu-streaming-card 去重。两侧都有真实消费方，取并集。
  droppedCount: number;
  messageIds: string[];
} | null {
  // 默认候选池取 1000 而不是 upstream 的 30：本地按 token 预算从最新往回整条填充，
  // 池子太小会让预算根本用不满，droppedCount 也失去意义。调用点仍可显式传 limit。
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
    // role/sender 取 upstream：共享的输出模板同时引用这两个字段。
    const role = m.is_from_me ? 'assistant' : 'user';
    const sender = m.is_from_me ? 'HappyClaw' : m.sender_name;
    // 但**不做单条截断** —— 本地刻意去掉了 upstream 在 maxMessageLength 处加「…」
    // 的行为。两条交接路径（provider 轮换 / runtime 切换）必须交出同样多的内容，
    // 靠上面按 token 预算从最新往回整条填充来保证；再叠一层按字符截断会让同一段
    // 对话因为触发的是哪种切换而降级得不一样。见 conversation-history-budget.test.ts。
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
    return (
      `<history_message id="${escapeXml(m.id)}" role="${role}"` +
      ` sender="${escapeXml(sender)}">${escapeXml(cleaned)}</history_message>`
    );
  });

  const droppedNote =
    droppedCount > 0
      ? `\n（更早的 ${droppedCount} 条因长度限制未包含，这份记录是部分的。）`
      : '';

  return {
    count: historyMsgs.length,
    droppedCount,
    messageIds: historyMsgs.map((message) => message.id),
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
