import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectedModel: 'claude-opus-4-8',
}));

vi.mock('../src/db.js', () => ({
  LEGACY_CLAUDE_AUTH_GENERATION: 0,
  LEGACY_CLAUDE_MODEL_KEY: 'claude:default',
  LEGACY_CLAUDE_PROVIDER_ID: 'claude',
  ensureConversationRuntimeState: () => ({
    group_folder: 'flow',
    agent_id: '',
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    selected_model: mocks.selectedModel,
    model_kind: 'explicit_version',
    resolved_model: mocks.selectedModel,
    binding_source: 'workspace_default',
    binding_revision: 1,
    active_runtime: null,
    active_provider_family: null,
    active_provider_pool_id: null,
    active_selected_model: null,
    active_model_kind: null,
    active_resolved_model: null,
    pending_runtime: null,
    pending_provider_family: null,
    pending_provider_pool_id: null,
    pending_selected_model: null,
    pending_model_kind: null,
    pending_resolved_model: null,
    pending_handoff_summary_id: null,
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  }),
  getLatestSessionTokenUsage: () => undefined,
  getProviderPool: () => ({
    provider_pool_id: 'claude',
    runtime: 'claude',
    provider_family: 'claude',
    display_name: 'Claude',
    balancing_strategy: 'round_robin',
    enabled: true,
    unhealthy_threshold: 3,
    recovery_interval_ms: 60_000,
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-07-06T00:00:00.000Z',
  }),
  getRuntimeNativeSession: () => undefined,
  // Same-runtime model switches consult this fallback; undefined here keeps these
  // normalization tests focused on model naming rather than session carry-over.
  getCarryOverNativeSession: () => undefined,
  listProviderPoolModelOptions: () => [
    {
      runtime: 'claude',
      provider_family: 'claude',
      provider_pool_id: 'claude',
      model_id: mocks.selectedModel,
      model_kind: 'explicit_version',
      display_name: mocks.selectedModel,
      source: 'admin_configured',
      status: 'available',
      metadata_json: JSON.stringify({ resolved_model: mocks.selectedModel }),
      updated_by: 'test',
      updated_at: '2026-07-06T00:00:00.000Z',
    },
  ],
  modelKeyForBinding: () => `claude:${mocks.selectedModel}`,
  setRuntimeNativeSession: vi.fn(),
}));

vi.mock('../src/runtime-config.js', () => ({
  getBalancingConfig: () => ({ strategy: 'round_robin' }),
  getContainerEnvConfig: () => ({}),
  getEnabledProvidersForPool: () => [],
}));

vi.mock('../src/provider-pool.js', () => ({
  providerPoolManager: {
    refreshPoolFromConfig: vi.fn(),
    selectProvider: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveRuntimeForScope } = await import('../src/model-runtime.js');

describe('Claude model override normalization', () => {
  it('keeps Claude Opus 4.8 unsuffixed unless the user selected 1M explicitly', () => {
    mocks.selectedModel = 'claude-opus-4-8';

    expect(resolveRuntimeForScope('flow').modelOverride).toBe('claude-opus-4-8');
  });

  it('passes through the explicit Claude Opus 4.8 1M variant', () => {
    mocks.selectedModel = 'claude-opus-4-8[1m]';

    expect(resolveRuntimeForScope('flow').modelOverride).toBe(
      'claude-opus-4-8[1m]',
    );
  });

  it.each(['claude-fable-5', 'claude-sonnet-5'])(
    'keeps %s unsuffixed because it has no 200K variant',
    (modelId) => {
      mocks.selectedModel = modelId;

      expect(resolveRuntimeForScope('flow').modelOverride).toBe(modelId);
    },
  );
});
