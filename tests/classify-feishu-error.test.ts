import { describe, expect, test } from 'vitest';

import { classifyFeishuError } from '../src/feishu.js';

/**
 * 根治事故的核心断言：feishu getChatInfo 的异常分类必须把"我方/传输故障"
 * 与"针对该群的确定性否定"严格分开。前者一律 'unknown'（零信息量，不参与
 * 破坏性决策），只有明确的 404/403 等才是 'gone'。
 */
describe('classifyFeishuError', () => {
  test('EADDRNOTAVAIL（飞书 token 接口抖动的网络码）→ unknown', () => {
    const probe = classifyFeishuError({ code: 'EADDRNOTAVAIL' });
    expect(probe.status).toBe('unknown');
  });

  test('网络码挂在 err.cause.code 上 → unknown', () => {
    const probe = classifyFeishuError({ cause: { code: 'ECONNREFUSED' } });
    expect(probe.status).toBe('unknown');
  });

  test('其它传输码（ETIMEDOUT / ENOTFOUND / ECONNRESET）→ unknown', () => {
    for (const code of ['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET']) {
      expect(classifyFeishuError({ code }).status).toBe('unknown');
    }
  });

  test('tenant_access_token 相关错误 → unknown', () => {
    const probe = classifyFeishuError({
      message: 'failed to get tenant_access_token',
    });
    expect(probe.status).toBe('unknown');
  });

  test('Cannot destructure（token 管道解构失败）→ unknown', () => {
    const probe = classifyFeishuError({
      message: "Cannot destructure property 'x' of undefined",
    });
    expect(probe.status).toBe('unknown');
  });

  test('HTTP 429（限流）→ unknown', () => {
    const probe = classifyFeishuError({ response: { status: 429 } });
    expect(probe.status).toBe('unknown');
  });

  test('HTTP 503（服务端故障）→ unknown', () => {
    const probe = classifyFeishuError({ response: { status: 503 } });
    expect(probe.status).toBe('unknown');
  });

  test('HTTP 500 → unknown', () => {
    expect(classifyFeishuError({ response: { status: 500 } }).status).toBe(
      'unknown',
    );
  });

  test('完全未知/空错误 → unknown（宁可漏判不删）', () => {
    expect(classifyFeishuError(undefined).status).toBe('unknown');
    expect(classifyFeishuError({}).status).toBe('unknown');
    expect(classifyFeishuError(new Error('boom')).status).toBe('unknown');
  });

  test('无法确定含义的飞书业务码 → unknown（不凭猜测删群）', () => {
    const probe = classifyFeishuError({ response: { data: { code: 99999 } } });
    expect(probe.status).toBe('unknown');
  });

  test('HTTP 404（chat 不存在）→ gone', () => {
    const probe = classifyFeishuError({ response: { status: 404 } });
    expect(probe.status).toBe('gone');
  });

  test('HTTP 403（bot 无权限/被踢）→ gone', () => {
    const probe = classifyFeishuError({ response: { status: 403 } });
    expect(probe.status).toBe('gone');
  });

  test('网络码优先于 HTTP 状态（传输层先短路为 unknown）', () => {
    // 即便错误对象上同时挂了网络码和一个可疑的 status，网络码代表传输故障，
    // 必须先归 unknown，不能升级成 gone。
    const probe = classifyFeishuError({
      code: 'EADDRNOTAVAIL',
      response: { status: 404 },
    });
    expect(probe.status).toBe('unknown');
  });
});
