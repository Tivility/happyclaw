import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/happyclaw-grok-provider-roundtrip-${process.pid}`,
}));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: testPaths.dataDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  createProvider,
  getGrokProviders,
  getEnabledGrokProviders,
  updateProviderSecrets,
} from '../src/runtime-config.js';

function cleanup(): void {
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
}

const AUTH_JSON_V1 = JSON.stringify({
  access_token: 'access-v1',
  refresh_token: 'refresh-v1',
});
const AUTH_JSON_V2 = JSON.stringify({
  access_token: 'access-v2',
  refresh_token: 'refresh-v2',
});

describe('grok provider AES-256-GCM round-trip symmetry', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('does NOT lose grokAuthJson on encrypt → decrypt (createProvider → getGrokProviders)', () => {
    const created = createProvider({
      name: 'Grok',
      type: 'official',
      runtime: 'grok',
      providerFamily: 'grok',
      providerPoolId: 'grok',
      authMode: 'grok_oauth',
      grokAuthJson: AUTH_JSON_V1,
    });

    expect(created.runtime).toBe('grok');
    expect(created.providerFamily).toBe('grok');
    expect(created.authMode).toBe('grok_oauth');
    expect(created.grokAuthJson).toBe(AUTH_JSON_V1);

    // Re-read from disk: decryptSecrets must restore grokAuthJson, not drop it.
    const reread = getGrokProviders().find((p) => p.id === created.id);
    expect(reread).toBeDefined();
    expect(reread!.grokAuthJson).toBe(AUTH_JSON_V1);
    expect(reread!.runtime).toBe('grok');
    expect(reread!.providerFamily).toBe('grok');
  });

  it('rotates grokAuthJson via updateProviderSecrets and bumps generation', () => {
    const created = createProvider({
      name: 'Grok',
      type: 'official',
      providerFamily: 'grok',
      grokAuthJson: AUTH_JSON_V1,
    });
    const genBefore = created.authProfileGeneration;

    const updated = updateProviderSecrets(created.id, {
      grokAuthJson: AUTH_JSON_V2,
    });
    expect(updated.grokAuthJson).toBe(AUTH_JSON_V2);
    expect(updated.authMode).toBe('grok_oauth');
    expect(updated.authProfileGeneration).toBe(genBefore + 1);

    // Persisted to disk and survives re-read.
    const reread = getGrokProviders().find((p) => p.id === created.id);
    expect(reread!.grokAuthJson).toBe(AUTH_JSON_V2);
  });

  it('clears grokAuthJson via clearGrokAuthJson', () => {
    const created = createProvider({
      name: 'Grok',
      type: 'official',
      providerFamily: 'grok',
      grokAuthJson: AUTH_JSON_V1,
    });
    const updated = updateProviderSecrets(created.id, {
      clearGrokAuthJson: true,
    });
    expect(updated.grokAuthJson).toBe('');
    const reread = getGrokProviders().find((p) => p.id === created.id);
    expect(reread!.grokAuthJson).toBe('');
  });

  it('createProvider with only providerFamily=grok derives runtime/authMode/pool', () => {
    const created = createProvider({
      name: 'Grok',
      type: 'official',
      providerFamily: 'grok',
      grokAuthJson: AUTH_JSON_V1,
    });
    expect(created.runtime).toBe('grok');
    expect(created.providerPoolId).toBe('grok');
    expect(created.authMode).toBe('grok_oauth');
    expect(getEnabledGrokProviders().some((p) => p.id === created.id)).toBe(true);
  });
});
