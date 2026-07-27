import { describe, expect, it } from 'vitest';

import {
  buildResumeFailureRetryInput,
  classifyRuntimeError,
} from '../container/agent-runner/src/runtime-adapter.js';

describe('runtime adapter boundary helpers', () => {
  it('classifies common runtime errors for user-facing handling', () => {
    expect(classifyRuntimeError(new Error('The operation was aborted'))).toBe(
      'cancelled',
    );
    expect(classifyRuntimeError(new Error('401 unauthorized: invalid API key'))).toBe(
      'auth',
    );
    expect(classifyRuntimeError(new Error('unsupported model gpt-x'))).toBe(
      'unsupported_model',
    );
    expect(classifyRuntimeError(new Error('rate limit exceeded'))).toBe(
      'rate_limit',
    );
    expect(classifyRuntimeError(new Error('spawn codex ENOENT'))).toBe(
      'runtime_unavailable',
    );
    expect(classifyRuntimeError(new Error('spawn grok ENOENT'))).toBe(
      'runtime_unavailable',
    );
  });

  it('classifies grok/x.ai-specific quota and rate-limit wording', () => {
    // x.ai 速率限制措辞
    expect(
      classifyRuntimeError(new Error('Rate limit reached for requests per minute')),
    ).toBe('rate_limit');
    expect(
      classifyRuntimeError(new Error('TPM limit hit, please slow down')),
    ).toBe('rate_limit');
    // 订阅/配额措辞（区别于 rate limit）
    expect(classifyRuntimeError(new Error('You are out of credits'))).toBe(
      'quota',
    );
    expect(classifyRuntimeError(new Error('Monthly limit reached'))).toBe(
      'quota',
    );
    expect(classifyRuntimeError(new Error('402 Payment Required'))).toBe(
      'quota',
    );
    expect(classifyRuntimeError(new Error('EACCES permission denied'))).toBe(
      'permission',
    );
  });

  it('builds soft-injection retry input after native resume failure', () => {
    const retry = buildResumeFailureRetryInput(
      {
        input: {
          prompt: 'hello',
          groupFolder: 'flow-test',
          chatJid: 'web:flow-test',
        },
        prompt: 'resume prompt',
        resumeFailureFallbackPrompt: 'fallback prompt',
        sessionId: 'native-1',
        cwd: '/tmp',
        systemPromptAppend: '',
      },
      'native_resume_failed',
    );

    expect(retry).toMatchObject({
      prompt: 'fallback prompt',
      sessionId: undefined,
      resumeMode: 'soft_inject',
      softInjectionReason: 'native_resume_failed',
    });
  });
});

/**
 * resume 失败 fallback 的守卫条件。
 *
 * codex 与 grok 都是单 turn re-spawn + native resume。`session/load`（grok）
 * 或 `codex resume`（codex）会在会话文件找不到时失败 —— 换机器、清缓存、
 * 会话文件被 CLI 轮转掉都会触发。不 fallback 的话整个会话从此永久报错，
 * 用户只能手动 /clear。
 *
 * 合并后 codex 有这个 fallback、grok 没有（又一处运行时不对齐），已补齐。
 * 端到端很难稳定复现（凭据轮换会先让 session key 失配、直接走新会话，
 * 那是另一条正确路径），所以这里锁住判定条件本身。
 */
describe('resume 失败 fallback 的判定', () => {
  // 与两个 runner 里的正则保持一致；改动其一必须同步改这里。
  const looksLikeResumeFailure = (stderr: string): boolean =>
    /session|resume|conversation|thread|not found|does not exist|path not found/i.test(
      stderr,
    );

  it('识别 grok 的 Path not found（实测遇到的原文）', () => {
    expect(
      looksLikeResumeFailure('Grok CLI exited with code null: Path not found.'),
    ).toBe(true);
  });

  it('识别常见的会话不存在措辞', () => {
    for (const msg of [
      'session not found',
      'conversation does not exist',
      'failed to resume thread',
      'Session 019fa3ce not found',
    ]) {
      expect(looksLikeResumeFailure(msg)).toBe(true);
    }
  });

  it('不把无关错误误判成 resume 失败', () => {
    for (const msg of [
      'Authentication required',
      'out of credits',
      'rate limit reached',
      'ENOENT: spawn grok',
    ]) {
      expect(looksLikeResumeFailure(msg)).toBe(false);
    }
  });

  it('buildResumeFailureRetryInput 清掉 sessionId 并转 soft_inject', () => {
    const retry = buildResumeFailureRetryInput(
      {
        prompt: 'original',
        sessionId: 'sess_gone',
        resumeMode: 'resume',
        resumeFailureFallbackPrompt: 'with-history-prefix',
        input: {} as never,
      } as Parameters<typeof buildResumeFailureRetryInput>[0],
      'grok_resume_failed',
    );

    // 关键：不能带着失效的 sessionId 重试，否则第二次还是同样失败。
    expect(retry.sessionId).toBeUndefined();
    // soft_inject：新会话拿不到 native 上下文，靠注入的历史摘要续上。
    expect(retry.resumeMode).toBe('soft_inject');
    expect(retry.prompt).toBe('with-history-prefix');
    expect(retry.softInjectionReason).toBe('grok_resume_failed');
  });

  it('没有 fallback prompt 时退回原 prompt', () => {
    const retry = buildResumeFailureRetryInput(
      {
        prompt: 'original',
        sessionId: 'sess_gone',
        input: {} as never,
      } as Parameters<typeof buildResumeFailureRetryInput>[0],
      'codex_resume_failed',
    );
    expect(retry.prompt).toBe('original');
    expect(retry.sessionId).toBeUndefined();
  });
});
