import { describe, expect, test } from 'vitest';

import {
  isApiError,
  isProviderFailureResult,
} from '../src/agent-output-parser.js';

describe('isProviderFailureResult — positive (genuine Claude limit notices)', () => {
  test('detects Claude extra-usage exhaustion returned as final text', () => {
    const msg = "You're out of extra usage · resets 2:10am (Asia/Shanghai)";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects legacy Claude "hit your limit" final text', () => {
    const msg = "You've hit your limit · resets 3am (Asia/Shanghai)";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects "usage limit reached" notice with reset time', () => {
    const msg =
      'Claude usage limit reached. Your limit will reset at 3pm (America/New_York)';
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects "out of extra usage" as a short standalone notice (no reset stamp)', () => {
    const msg = "You're out of extra usage.";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects upgrade prompt with reset stamp', () => {
    const msg =
      'Upgrade to increase your usage limit · resets 9:00pm (Asia/Tokyo)';
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('tolerates surrounding whitespace', () => {
    const msg =
      "\n  You're out of extra usage · resets 2:10am (Asia/Shanghai)  \n";
    expect(isProviderFailureResult(msg)).toBe(true);
  });
});

describe('isProviderFailureResult — negative (normal replies must NOT be flagged)', () => {
  // CRITICAL regression guard: a false positive here kills the container,
  // clears the Claude session, and marks the provider unhealthy for ALL users.
  // The original PR used generic /rate.limit/ and /quota (exceeded|exhausted)/
  // patterns that fired on ordinary technical conversation. These cases pin
  // that down — they are the 5/8 mislabelled examples called out in review.

  test('does not flag a reply that mentions avoiding the API rate limit', () => {
    const msg =
      '为避免触发 API rate limit，我在循环里加了 200ms 的 sleep，并对 429 做了指数退避重试。';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply discussing disk quota exceeded', () => {
    const msg =
      'The upload failed with "disk quota exceeded" — you need to free up space on /var before retrying.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply explaining how to handle rate-limited requests', () => {
    const msg =
      'When the endpoint is rate limited it returns HTTP 429; wrap the call in a retry with backoff so the job is not rate-limited again.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply about a database quota being exhausted', () => {
    const msg =
      'The connection pool quota was exhausted because every request opened a new connection without closing it.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply quoting the word "limit" generically', () => {
    const msg =
      'I lowered the rate limit on the gateway from 1000 to 200 req/s and added a quota per tenant.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a long answer that merely mentions a Claude limit phrase mid-text', () => {
    // A genuine notice is a single short line. A long answer that happens to
    // quote "you've hit your limit" (e.g. explaining the UI) and has no reset
    // stamp must NOT be treated as a provider failure.
    const msg =
      'When Claude shows the banner that says "you\'ve hit your limit", it means the account ran out of usage for the window. ' +
      'To diagnose this in our app you can inspect the ContainerOutput.providerFailure flag, look at the provider-pool health map, ' +
      'and confirm the sticky binding was cleared. The full investigation usually takes a few minutes and involves checking the logs, ' +
      'the session table, and the env overrides for that group folder before you decide whether to switch providers manually.';
    expect(msg.length).toBeGreaterThan(200);
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a short reply saying a generic "rate limit reached"', () => {
    // "usage limit reached" is the Claude phrase; a generic "rate limit
    // reached" must not match even though it is short.
    const msg = 'The gateway rate limit reached its cap, so requests got 429s.';
    expect(msg.length).toBeLessThan(200);
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a short reply mentioning a request limit reached', () => {
    const msg = 'Heads up: the per-minute request limit reached 100% briefly.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag null or empty result', () => {
    expect(isProviderFailureResult(null)).toBe(false);
    expect(isProviderFailureResult('')).toBe(false);
    expect(isProviderFailureResult('   ')).toBe(false);
  });

  test('does not flag an ordinary successful answer', () => {
    const msg =
      '我已经把函数重命名为 buildVolumeMounts 并更新了所有调用点，测试全部通过。';
    expect(isProviderFailureResult(msg)).toBe(false);
  });
});

describe('isApiError — stderr classification still detects provider issues', () => {
  // isApiError runs against STDERR (process error stream), not the agent's
  // reply body, so generic rate-limit/quota matching is appropriate there.
  test('detects rate limit in stderr', () => {
    expect(isApiError('Error: rate limit exceeded (429)')).toBe(true);
  });

  test('detects quota exhausted in stderr', () => {
    expect(isApiError('quota exhausted for this API key')).toBe(true);
  });

  test('detects Claude extra-usage phrasing in stderr', () => {
    expect(isApiError("You're out of extra usage")).toBe(true);
  });

  test('detects connection errors in stderr', () => {
    expect(isApiError('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
  });

  test('returns false for empty stderr', () => {
    expect(isApiError('')).toBe(false);
  });
});
