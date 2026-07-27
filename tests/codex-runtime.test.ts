import { describe, expect, it } from 'vitest';

import { probeCodexDependencies } from '../src/codex-runtime.js';

describe('Codex runtime dependency probe', () => {
  it('validates required CLI flags when a CLI exists', async () => {
    const status = await probeCodexDependencies();

    // 决策 38：只探测 CLI。SDK 分支已随 `@openai/codex-sdk` 一起移除。
    expect(status).not.toHaveProperty('sdk');
    if (status.cli.available) {
      expect(status.cli.path).toBeTruthy();
      expect(status.cli.version).toBeTruthy();
      expect(status.cli.supportsExecRequiredFlags).toBe(true);
    } else {
      expect(status.cli.error).toBeTruthy();
    }
  }, 15_000);
});
