import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dataDir: `/tmp/happyclaw-config-codex-routes-${process.pid}`,
  spawn: vi.fn(),
  execFile: vi.fn(),
  deleteAllSessionsForFolder: vi.fn(),
  stopGroup: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: mocks.dataDir,
  updateWeChatNoProxy: vi.fn(),
}));

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-user',
      username: 'admin',
      role: 'admin',
      status: 'active',
      display_name: 'Admin',
      permissions: ['manage_system_config'],
      must_change_password: false,
    });
    await next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireAnyPermission: () => async (_c: any, next: any) => next(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  // execFile must be a function with a `__promisify__` hook so that
  // `promisify(execFile)` at config.ts module load doesn't throw.
  execFile: Object.assign(mocks.execFile, {
    __promisify__: () => Promise.resolve({ stdout: '', stderr: '' }),
  }),
}));

vi.mock('../src/db.js', () => ({
  VALID_ACTIVATION_MODES: new Set([
    'auto',
    'always',
    'when_mentioned',
    'owner_mentioned',
    'disabled',
  ]),
  deleteRegisteredGroup: vi.fn(),
  deleteChatHistory: vi.fn(),
  deleteAllSessionsForFolder: mocks.deleteAllSessionsForFolder,
  getRegisteredGroup: vi.fn(),
  setRegisteredGroup: vi.fn(),
  updateChatName: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/codex-runtime.js', () => ({
  findCodexCli: vi.fn(async () => '/usr/local/bin/codex'),
  probeCodexDependencies: vi.fn(async () => ({
    cliPath: '/usr/local/bin/codex',
    sdkAvailable: true,
  })),
}));

vi.mock('../src/provider-pool.js', () => ({
  providerPool: {
    refreshFromConfig: vi.fn(),
    getHealthStatuses: vi.fn(() => []),
    resetHealth: vi.fn(),
  },
}));

vi.mock('../src/billing.js', () => ({
  checkImChannelLimit: vi.fn(),
  isBillingEnabled: vi.fn(() => false),
  clearBillingEnabledCache: vi.fn(),
}));

vi.mock('../src/web-context.js', () => ({
  MAX_GROUP_NAME_LEN: 40,
  canAccessGroup: vi.fn(() => true),
  getWebDeps: vi.fn(() => null),
}));

vi.mock('../src/im-channel.js', () => ({
  getChannelType: vi.fn(() => 'feishu'),
}));

import configRoutes, { injectConfigDeps } from '../src/routes/config.js';

function cleanup(): void {
  fs.rmSync(mocks.dataDir, { recursive: true, force: true });
}

function jsonRequest(pathname: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function mockCodexDeviceLogin(): void {
  mocks.spawn.mockImplementation(() => {
    const stdout = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') {
          setTimeout(() => {
            cb(
              Buffer.from(
                'Open https://auth.openai.com/codex/device and enter ABCD-12345',
              ),
            );
          }, 0);
        }
        return stdout;
      }),
    };
    const stderr = { on: vi.fn(() => stderr) };
    return {
      stdout,
      stderr,
      on: vi.fn(),
      kill: vi.fn(),
    };
  });
}

describe('Codex provider config routes', () => {
  beforeEach(() => {
    cleanup();
    mocks.spawn.mockReset();
    mocks.deleteAllSessionsForFolder.mockReset();
    mocks.stopGroup.mockReset();
    mocks.stopGroup.mockResolvedValue(undefined);
    injectConfigDeps({
      getRegisteredGroups: () => ({
        'web:test': { folder: 'flow-test' },
      }),
      queue: {
        stopGroup: mocks.stopGroup,
      },
    });
    mockCodexDeviceLogin();
  });

  afterEach(cleanup);

  it('creates and lists an API-key GPT provider through the route layer', async () => {
    const createRes = await configRoutes.request(
      jsonRequest('/codex/providers', 'POST', {
        name: 'GPT API',
        authMode: 'api_key',
        openaiApiKey: 'sk-test-provider',
        enabled: true,
      }),
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.provider).toMatchObject({
      name: 'GPT API',
      runtime: 'codex',
      providerFamily: 'gpt',
      providerPoolId: 'gpt',
      authMode: 'api_key',
      hasOpenaiApiKey: true,
      hasCodexAuthJson: false,
    });
    expect(created.provider.openaiApiKeyMasked).not.toBe('sk-test-provider');

    const listRes = await configRoutes.request('/codex/providers');
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0].id).toBe(created.provider.id);
  });

  it('rotates GPT secrets through the route layer and bumps auth generation', async () => {
    const createRes = await configRoutes.request(
      jsonRequest('/codex/providers', 'POST', {
        name: 'GPT API',
        authMode: 'api_key',
        openaiApiKey: 'sk-test-provider',
      }),
    );
    const created = await createRes.json();

    const secretsRes = await configRoutes.request(
      jsonRequest(`/codex/providers/${created.provider.id}/secrets`, 'PUT', {
        authMode: 'chatgpt_oauth',
        codexAuthJson: JSON.stringify({ refresh_token: 'refresh' }),
        clearOpenaiApiKey: true,
      }),
    );

    expect(secretsRes.status).toBe(200);
    const updated = await secretsRes.json();
    expect(updated.provider).toMatchObject({
      id: created.provider.id,
      authMode: 'chatgpt_oauth',
      hasOpenaiApiKey: false,
      hasCodexAuthJson: true,
    });
    expect(updated.provider.authProfileGeneration).toBeGreaterThan(
      created.provider.authProfileGeneration,
    );
  });

  it('starts and completes Codex OAuth provider creation', async () => {
    const startRes = await configRoutes.request(
      jsonRequest('/codex/oauth/start', 'POST', {
        name: 'GPT OAuth',
      }),
    );

    expect(startRes.status).toBe(200);
    const started = await startRes.json();
    expect(started.authorizeUrl).toBe('https://auth.openai.com/codex/device');
    expect(started.deviceCode).toBe('ABCD-12345');

    const authHome = path.join(
      mocks.dataDir,
      'config',
      'codex-oauth',
      started.state,
    );
    fs.writeFileSync(
      path.join(authHome, 'auth.json'),
      JSON.stringify({ refresh_token: 'refresh-token' }),
      'utf-8',
    );

    const completeRes = await configRoutes.request(
      jsonRequest('/codex/oauth/complete', 'POST', {
        state: started.state,
      }),
    );

    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.provider).toMatchObject({
      name: 'GPT OAuth',
      runtime: 'codex',
      providerFamily: 'gpt',
      providerPoolId: 'gpt',
      authMode: 'chatgpt_oauth',
      hasCodexAuthJson: true,
    });
    expect(fs.existsSync(authHome)).toBe(false);
  });

  it('sets Claude provider enabled state without requiring legacy in-memory sessions', async () => {
    const firstRes = await configRoutes.request(
      jsonRequest('/claude/providers', 'POST', {
        name: 'Claude One',
        type: 'official',
        claudeCodeOauthToken: 'token-one',
        enabled: true,
      }),
    );
    const secondRes = await configRoutes.request(
      jsonRequest('/claude/providers', 'POST', {
        name: 'Claude Two',
        type: 'official',
        claudeCodeOauthToken: 'token-two',
        enabled: true,
      }),
    );
    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);

    const first = await firstRes.json();
    const patchRes = await configRoutes.request(
      jsonRequest(`/claude/providers/${first.id}`, 'PATCH', {
        enabled: false,
      }),
    );

    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.provider).toMatchObject({
      id: first.id,
      enabled: false,
    });
    expect(patched.applied).toMatchObject({
      success: true,
      stoppedCount: 1,
      failedCount: 0,
    });
    expect(mocks.stopGroup).toHaveBeenCalledWith('web:test');
    // Toggling enabled state must NOT wipe sessions: it does not change any
    // protocol-level provider field, so sticky session→provider bindings stay
    // intact (narrowed cleanup via deleteSessionsByProviderId, only triggered
    // when those fields actually change — see issue #476).
    expect(mocks.deleteAllSessionsForFolder).not.toHaveBeenCalled();
  });
});
