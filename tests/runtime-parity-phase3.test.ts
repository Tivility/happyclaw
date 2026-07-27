import { describe, expect, test } from 'vitest';

import { allowsExternalMcpServers } from '../container/agent-runner/src/runtime-mcp-policy.js';

/**
 * 阶段 3「三条运行时对齐」的回归护栏。
 *
 * 这些能力此前只在 Claude 一条路上生效 —— Codex/Grok 要么拿不到输入（人格、
 * 投递契约、渠道上下文），要么产出缺字段（工具结果、上下文水位），要么口径
 * 不一致（用量的 inputTokens 含不含 cacheRead）。它们的共同特征是**类型能过、
 * 单跑目标测试也能过**，只有针对性断言才拦得住，所以在这里独立成文件。
 *
 * 覆盖不到 spawn 真进程的部分（人格 / 契约 / 渠道上下文的注入位置）由
 * agent-persona.test.ts 与 index.ts 的构造逻辑各自负责；本文件盯住可纯函数
 * 化验证的那几条不变量。
 */

describe('阶段 3 · MCP 权限策略对三条运行时生效', () => {
  test('无 runtimePolicy 时默认放行外部 MCP server（保持既有行为）', () => {
    expect(allowsExternalMcpServers(undefined)).toBe(true);
    expect(allowsExternalMcpServers(null)).toBe(true);
    expect(allowsExternalMcpServers({})).toBe(true);
  });

  test('mcp.mode = disabled 时禁止外部 MCP server', () => {
    expect(allowsExternalMcpServers({ mcp: { mode: 'disabled' } })).toBe(false);
  });

  test('mcp.mode 为其他值时放行（只有 disabled 是禁用信号）', () => {
    expect(allowsExternalMcpServers({ mcp: { mode: 'allow' } })).toBe(true);
    expect(allowsExternalMcpServers({ mcp: {} })).toBe(true);
    // 非对象输入不能当成禁用 —— 那会让配置写错的用户静默丢掉全部 MCP 工具。
    expect(allowsExternalMcpServers('disabled')).toBe(true);
    expect(allowsExternalMcpServers({ mcp: 'disabled' })).toBe(true);
  });
});

describe('阶段 3 · 用量口径自描述（inputTokens 含不含 cacheRead）', () => {
  /**
   * 两种口径都不该改，所以由事件自己声明：
   * - Anthropic（Claude）：input_tokens **不含** cache read → 标记缺省。
   * - OpenAI（Codex）/ xAI（Grok）：inputTokens 是全量 → 标记为 true。
   *
   * 下面复刻 formatUsageNote 里「新增输入」的算法。若哪天有人把扣减去掉，
   * Codex/Grok 的卡片会把缓存读同时算进 new 和 cached，同一批 token 显示两遍。
   */
  const uncachedInput = (u: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    inputTokensIncludeCacheRead?: boolean;
  }): number =>
    (u.inputTokensIncludeCacheRead
      ? Math.max(0, u.inputTokens - u.cacheReadInputTokens)
      : u.inputTokens) + u.cacheCreationInputTokens;

  test('Claude 口径：input 与 cacheRead 是两笔，不扣减', () => {
    expect(
      uncachedInput({
        inputTokens: 300,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 0,
      }),
    ).toBe(300);
  });

  test('Codex/Grok 口径：从全量 input 里扣掉 cacheRead 才是新增输入', () => {
    expect(
      uncachedInput({
        inputTokens: 1000,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 0,
        inputTokensIncludeCacheRead: true,
      }),
    ).toBe(300);
  });

  test('cacheRead 大于 input 时钳到 0，不产生负数 token 文案', () => {
    expect(
      uncachedInput({
        inputTokens: 500,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
        inputTokensIncludeCacheRead: true,
      }),
    ).toBe(0);
  });

  test('cacheCreation 在两种口径下都独立计入（它不在 input 里）', () => {
    expect(
      uncachedInput({
        inputTokens: 1000,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 120,
        inputTokensIncludeCacheRead: true,
      }),
    ).toBe(420);
    expect(
      uncachedInput({
        inputTokens: 300,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 120,
      }),
    ).toBe(420);
  });
});
