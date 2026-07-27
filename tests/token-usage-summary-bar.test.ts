import { describe, expect, test } from 'vitest';

import {
  getAuthoritativeTokenBreakdown,
  getUncachedInputTokens,
} from '../web/src/lib/token-usage-presentation.js';

/**
 * 消息气泡下方那条用量摘要行：
 *   `模型 · 耗时 · 🆕 new · 🗂 cached · 💡 out · 💰 cost`
 *
 * 合并时被 upstream 的简化版（只有「总 tokens · 耗时」）覆盖，用户直接反馈
 * 「这个 bar 没了」。函数注释还留着完整格式的描述 —— 注释与实现不一致本身
 * 就是这次回退的证据。
 *
 * 这里锁住摘要行的核心计算：new 必须是**非缓存**的输入。
 */
describe('用量摘要行 · 新增输入的计算', () => {
  const breakdown = (
    inputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens = 0,
  ) =>
    getAuthoritativeTokenBreakdown({
      inputTokens,
      outputTokens: 1,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    });

  test('Claude 口径：inputTokens 不含 cacheRead，直接用', () => {
    const b = breakdown(300, 700);
    expect(getUncachedInputTokens({}, b)).toBe(300);
  });

  test('Codex/Grok 口径：从全量 inputTokens 里扣掉 cacheRead', () => {
    const b = breakdown(1000, 700);
    expect(
      getUncachedInputTokens({ inputTokensIncludeCacheRead: true }, b),
    ).toBe(300);
  });

  test('两种口径下 new 的最终值一致（同一次真实请求）', () => {
    // 同一次请求：300 新增 + 700 缓存读。两种口径上报方式不同，
    // 展示出来的 new 必须相同 —— 否则同一批 token 会在 new 和 cached 显示两遍。
    const anthropic = breakdown(300, 700);
    const openai = breakdown(1000, 700);
    expect(getUncachedInputTokens({}, anthropic)).toBe(
      getUncachedInputTokens({ inputTokensIncludeCacheRead: true }, openai),
    );
  });

  test('cacheRead 大于 inputTokens 时钳到 0，不出现负数', () => {
    const b = breakdown(500, 900);
    expect(
      getUncachedInputTokens({ inputTokensIncludeCacheRead: true }, b),
    ).toBe(0);
  });

  test('cacheCreation 不参与扣减（它不在 inputTokens 里）', () => {
    // new = 非缓存输入 + cacheCreation。这里只验前半段不被 cacheCreation 影响。
    const b = breakdown(1000, 700, 120);
    expect(
      getUncachedInputTokens({ inputTokensIncludeCacheRead: true }, b),
    ).toBe(300);
  });

  test('全缓存命中时 new 为 0，cached 独立显示', () => {
    const b = breakdown(700, 700);
    expect(
      getUncachedInputTokens({ inputTokensIncludeCacheRead: true }, b),
    ).toBe(0);
    expect(b.cacheReadInputTokens).toBe(700);
  });
});
