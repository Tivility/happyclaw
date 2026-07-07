import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledProvidersByPool: new Map<string, Array<{ id: string }>>(),
}));

const modelOptions = [
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'opus',
    model_kind: 'alias',
    display_name: 'Opus',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'claude-opus-4-20260401',
    }),
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'fable',
    model_kind: 'alias',
    display_name: 'Fable',
    source: 'admin_configured',
    status: 'available',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'opus[1m]',
    model_kind: 'alias',
    display_name: 'Opus 1M',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'opus[1m]',
      aliases: ['opus-1m'],
    }),
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'fast',
    model_kind: 'alias',
    display_name: 'Claude Fast',
    source: 'admin_configured',
    status: 'available',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'codex',
    provider_family: 'gpt',
    provider_pool_id: 'gpt',
    model_id: 'gpt-5.5',
    model_kind: 'explicit_version',
    display_name: 'GPT-5.5',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'gpt-5.5',
    }),
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'codex',
    provider_family: 'gpt',
    provider_pool_id: 'gpt',
    model_id: 'fast',
    model_kind: 'alias',
    display_name: 'GPT Fast',
    source: 'admin_configured',
    status: 'available',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'codex',
    provider_family: 'gpt',
    provider_pool_id: 'gpt',
    model_id: 'gpt-legacy-hidden',
    model_kind: 'explicit_version',
    display_name: 'GPT Legacy Hidden',
    source: 'admin_configured',
    status: 'hidden',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'claude-fable-5',
    model_kind: 'explicit_version',
    display_name: 'Claude Fable 5',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'claude-fable-5',
    }),
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'claude-opus-4-8',
    model_kind: 'explicit_version',
    display_name: 'Claude Opus 4.8',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'claude-opus-4-8',
      aliases: ['opus-4.8', 'opus-4-8'],
    }),
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'claude-opus-4-8[1m]',
    model_kind: 'explicit_version',
    display_name: 'Claude Opus 4.8 1M',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'claude-opus-4-8[1m]',
      aliases: ['opus-4.8-1m', 'opus-4-8-1m'],
    }),
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'claude-sonnet-5',
    model_kind: 'explicit_version',
    display_name: 'Claude Sonnet 5',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'claude-sonnet-5',
    }),
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'claude-retired',
    model_kind: 'explicit_version',
    display_name: 'Claude Retired',
    source: 'admin_configured',
    status: 'unsupported',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
];

vi.mock('../src/db.js', () => ({
  getProviderPools: () => [
    {
      provider_pool_id: 'claude',
      display_name: 'Claude',
      runtime: 'claude',
      provider_family: 'claude',
      enabled: true,
    },
    {
      provider_pool_id: 'gpt',
      display_name: 'GPT',
      runtime: 'codex',
      provider_family: 'gpt',
      enabled: true,
    },
  ],
  getProviderPool: (providerPoolId: string) =>
    providerPoolId === 'claude'
      ? {
          provider_pool_id: 'claude',
          display_name: 'Claude',
          runtime: 'claude',
          provider_family: 'claude',
          enabled: true,
        }
      : providerPoolId === 'gpt'
        ? {
            provider_pool_id: 'gpt',
            display_name: 'GPT',
            runtime: 'codex',
            provider_family: 'gpt',
            enabled: true,
          }
      : null,
  listProviderPoolModelOptions: (_providerPoolId?: string, includeAll = false) =>
    includeAll
      ? modelOptions
      : modelOptions.filter((option) => option.status !== 'hidden'),
}));

vi.mock('../src/runtime-config.js', () => ({
  getEnabledProvidersForPool: (providerPoolId: string) =>
    mocks.enabledProvidersByPool.get(providerPoolId) || [],
}));

import {
  formatModelList,
  parseModelBindingFromArgs,
} from '../src/model-command.js';

describe('model command parsing', () => {
  beforeEach(() => {
    mocks.enabledProvidersByPool.clear();
    mocks.enabledProvidersByPool.set('claude', [{ id: 'claude-provider' }]);
    mocks.enabledProvidersByPool.set('gpt', [{ id: 'gpt-provider' }]);
  });

  it('carries resolved model metadata into the binding key material', () => {
    const result = parseModelBindingFromArgs(['claude', 'opus']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      provider_pool_id: 'claude',
      selected_model: 'opus',
      model_kind: 'alias',
      resolved_model: 'claude-opus-4-20260401',
    });
  });

  it('selects a GPT pool explicit model without naming a provider', () => {
    const result = parseModelBindingFromArgs(['gpt', 'gpt-5.5']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      runtime: 'codex',
      provider_family: 'gpt',
      provider_pool_id: 'gpt',
      selected_model: 'gpt-5.5',
      model_kind: 'explicit_version',
      resolved_model: 'gpt-5.5',
    });
  });

  it('selects the Claude Fable alias', () => {
    const result = parseModelBindingFromArgs(['fable']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      runtime: 'claude',
      provider_family: 'claude',
      provider_pool_id: 'claude',
      selected_model: 'fable',
      model_kind: 'alias',
      resolved_model: null,
    });
  });

  it.each([
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-8[1m]',
    'claude-sonnet-5',
  ])('selects new pinned Claude model %s', (modelId) => {
    const result = parseModelBindingFromArgs([modelId]);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      runtime: 'claude',
      provider_family: 'claude',
      provider_pool_id: 'claude',
      selected_model: modelId,
      model_kind: 'explicit_version',
      resolved_model: modelId,
    });
  });

  it.each([
    ['opus-4.8-1m', 'claude-opus-4-8[1m]'],
    ['opus-4-8-1m', 'claude-opus-4-8[1m]'],
    ['opus-4.8', 'claude-opus-4-8'],
    ['fable-5', 'claude-fable-5'],
    ['sonnet-5', 'claude-sonnet-5'],
    ['opus-1m', 'opus[1m]'],
  ])('canonicalizes short model command %s', (input, modelId) => {
    const result = parseModelBindingFromArgs([input]);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      provider_pool_id: 'claude',
      selected_model: modelId,
      resolved_model: modelId,
    });
  });

  it('uses the provider default for an enabled GPT pool', () => {
    const result = parseModelBindingFromArgs(['gpt']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      runtime: 'codex',
      provider_family: 'gpt',
      provider_pool_id: 'gpt',
      selected_model: null,
      model_kind: 'provider_default',
      resolved_model: null,
    });
  });

  it('rejects ambiguous model names that exist in multiple pools', () => {
    const result = parseModelBindingFromArgs(['fast']);

    expect(result.binding).toBeUndefined();
    expect(result.error).toContain('多个模型池');
  });

  it('rejects a pool without an enabled auth provider', () => {
    mocks.enabledProvidersByPool.set('gpt', []);

    const result = parseModelBindingFromArgs(['gpt', 'gpt-5.5']);

    expect(result.binding).toBeUndefined();
    expect(result.error).toContain('没有启用的鉴权供应商');
  });

  it('lists Claude and GPT pool options together', () => {
    const output = formatModelList();

    expect(output).toContain('可用模型（直接复制下面的切换命令）');
    expect(output).toContain('Claude (claude)');
    expect(output).toContain('/model use fable');
    expect(output).toContain('Fable · 自动跟随 · 可用');
    expect(output).toContain('/model use claude-fable-5');
    expect(output).toContain('Claude Fable 5 · 固定版本 · 可用');
    expect(output).toContain('/model use claude-opus-4-8[1m]');
    expect(output).toContain('Claude Opus 4.8 1M · 固定版本 · 可用');
    expect(output).toContain('短写：/model use opus-4.8-1m');
    expect(output).toContain('/model use claude-opus-4-8');
    expect(output).toContain('/model use claude-sonnet-5');
    expect(output).toContain('/model use opus[1m]');
    expect(output).toContain('短写：/model use opus-1m');
    expect(output).toContain('/model use opus');
    expect(output).toContain('Opus · 自动跟随 · 可用');
    expect(output).toContain('/model use claude fast');
    expect(output).toContain('/model use gpt fast');
    expect(output).toContain('GPT (gpt)');
    expect(output).toContain('/model use gpt-5.5');
    expect(output).toContain('GPT-5.5 · 固定版本 · 可用');
    expect(output).not.toContain('Claude Retired');
    expect(output).not.toContain('GPT Legacy Hidden');
  });

  it('supports /model list --all style output for hidden options', () => {
    const output = formatModelList(true);

    expect(output).toContain('模型目录（含隐藏/不可用）');
    expect(output).toContain('/model use gpt-legacy-hidden');
    expect(output).toContain('GPT Legacy Hidden · 固定版本 · 隐藏');
    expect(output).toContain('/model use claude-retired');
    expect(output).toContain('Claude Retired · 固定版本 · 不支持');
  });
});
