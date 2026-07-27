export interface ModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUSD?: number;
}

export interface TokenUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  costUSD?: number;
  durationMs?: number;
  numTurns?: number;
  /**
   * `inputTokens` 是否**已含** `cacheReadInputTokens`。
   *
   * Anthropic（Claude）口径不含，两列相加才是总输入 → 缺省 / false。
   * OpenAI（Codex）与 xAI（Grok）口径是全量、已含 → true。
   * 展示「新增输入」时据此扣减，否则同一批缓存 token 会在 new 和 cached
   * 各显示一遍。单一真相源见 shared/stream-event.ts。
   */
  inputTokensIncludeCacheRead?: boolean;
  modelUsage?: Record<string, ModelTokenUsage>;
}

export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseTokenUsage(json: string): TokenUsagePayload | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as TokenUsagePayload)
      : null;
  } catch {
    return null;
  }
}

/**
 * The root five token classes are the authoritative per-message totals. A
 * per-model breakdown can contain internal/router models and must never replace
 * these totals.
 */
export function getAuthoritativeTokenBreakdown(
  usage: TokenUsagePayload,
): TokenBreakdown {
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const cacheReadInputTokens = tokenCount(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = tokenCount(usage.cacheCreationInputTokens);
  const reasoningTokens = tokenCount(usage.reasoningTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheReadInputTokens +
      cacheCreationInputTokens +
      reasoningTokens,
  };
}

/**
 * Claude Code Workflow subagents report usage in the SDK task/session record,
 * outside the main assistant-message payload. Combine the two non-overlapping
 * authorities for the user-facing total.
 */
export function getDisplayedTokenTotal(
  usage: TokenUsagePayload,
  workflowTokenTotals: readonly (number | undefined)[] = [],
): number {
  const workflowTokens = workflowTokenTotals.reduce<number>(
    (total, value) => total + tokenCount(value),
    0,
  );
  return getAuthoritativeTokenBreakdown(usage).totalTokens + workflowTokens;
}

export function getPrimaryModelUsage(
  usage: TokenUsagePayload,
): [string, ModelTokenUsage] | null {
  const models = Object.entries(usage.modelUsage ?? {});
  if (models.length === 0) return null;

  return models.reduce((primary, candidate) =>
    tokenCount(candidate[1].costUSD) > tokenCount(primary[1].costUSD)
      ? candidate
      : primary,
  );
}

/**
 * 摘要行的「新增输入」—— 即**非缓存**的输入 token。
 *
 * 分成 new / cached / out 三类而不是 input / output：Anthropic 的
 * `inputTokens` **不含** 走 cache_read / cache_creation 的部分，只显示
 * input+output 会把大上下文请求的绝大多数 token 藏掉，让费用看起来不合理。
 *
 * Codex/Grok 的 `inputTokens` 是全量（已含 cacheRead），所以要先扣掉再算
 * new，否则同一批缓存 token 会在 new 和 cached 各显示一遍。口径由
 * `inputTokensIncludeCacheRead` 自描述（单一真相源 shared/stream-event.ts）。
 */
export function getUncachedInputTokens(
  usage: Pick<TokenUsagePayload, 'inputTokensIncludeCacheRead'>,
  breakdown: Pick<TokenBreakdown, 'inputTokens' | 'cacheReadInputTokens'>,
): number {
  return usage.inputTokensIncludeCacheRead
    ? Math.max(0, breakdown.inputTokens - breakdown.cacheReadInputTokens)
    : breakdown.inputTokens;
}

