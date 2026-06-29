import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/happyclaw-grok-auth-material-${process.pid}`,
}));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: testPaths.dataDir,
}));

import {
  toPublicProvider,
  writeGrokProviderAuthMaterial,
  type UnifiedProvider,
} from '../src/runtime-config.js';

function provider(overrides: Partial<UnifiedProvider> = {}): UnifiedProvider {
  return {
    id: 'grok-test',
    name: 'Grok Test',
    type: 'official',
    runtime: 'grok',
    providerFamily: 'grok',
    providerPoolId: 'grok',
    authMode: 'grok_oauth',
    authProfileGeneration: 3,
    enabled: true,
    weight: 1,
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicModel: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    openaiApiKey: '',
    codexAuthJson: '',
    grokAuthJson: '',
    customEnv: {},
    updatedAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a fake JWT (header.payload.signature) carrying the given exp claim. */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    'base64url',
  );
  return `${header}.${payload}.sig`;
}

afterEach(() => {
  for (const id of ['grok-test', 'grok-oauth-test']) {
    fs.rmSync(path.join(testPaths.dataDir, 'config', 'grok', id), {
      recursive: true,
      force: true,
    });
  }
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
});

describe('Grok provider auth material', () => {
  it('seeds provider-scoped GROK_HOME with auth.json (0600)', () => {
    const authJson = JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    const material = writeGrokProviderAuthMaterial(
      provider({ id: 'grok-oauth-test', grokAuthJson: authJson }),
    );

    expect(material.env.GROK_HOME).toBe(material.grokHomeDir);
    expect(material.authProfileGeneration).toBe(3);
    const authPath = path.join(material.grokHomeDir, 'auth.json');
    expect(fs.readFileSync(authPath, 'utf-8').trim()).toBe(authJson);
    // auth.json must be private (0600).
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it('removes auth.json when provider has no grokAuthJson', () => {
    const material = writeGrokProviderAuthMaterial(provider());
    expect(material.env.GROK_HOME).toBe(material.grokHomeDir);
    expect(fs.existsSync(path.join(material.grokHomeDir, 'auth.json'))).toBe(
      false,
    );
  });

  it('exposes hasGrokAuthJson + grokOAuthExpiresAt in public config without leaking the token', () => {
    const expSeconds = 1893456000; // 2030-01-01
    const authJson = JSON.stringify({
      access_token: jwtWithExp(expSeconds),
      refresh_token: 'refresh-token',
    });
    const publicProvider = toPublicProvider(provider({ grokAuthJson: authJson }));
    expect(publicProvider.hasGrokAuthJson).toBe(true);
    expect(publicProvider.grokOAuthExpiresAt).toBe(expSeconds * 1000);
    // Public shape must never carry the raw auth.json / refresh_token.
    expect(JSON.stringify(publicProvider)).not.toContain('refresh-token');
    expect(JSON.stringify(publicProvider)).not.toContain('access_token');
  });

  it('returns null grokOAuthExpiresAt when no auth.json present', () => {
    const publicProvider = toPublicProvider(provider());
    expect(publicProvider.hasGrokAuthJson).toBe(false);
    expect(publicProvider.grokOAuthExpiresAt).toBeNull();
  });

  it('preserves CLI-refreshed auth.json until provider credentials rotate', () => {
    const initialAuthJson = JSON.stringify({ refresh_token: 'rt-v1' });
    const refreshedAuthJson = JSON.stringify({ refresh_token: 'rt-v2-from-cli' });
    const rotatedAuthJson = JSON.stringify({ refresh_token: 'rt-v3-from-user' });
    const initialProvider = provider({
      id: 'grok-oauth-test',
      authProfileGeneration: 3,
      grokAuthJson: initialAuthJson,
      updatedAt: '2026-04-25T00:00:00.000Z',
    });

    const material = writeGrokProviderAuthMaterial(initialProvider);
    const authPath = path.join(material.grokHomeDir, 'auth.json');
    expect(fs.readFileSync(authPath, 'utf-8').trim()).toBe(initialAuthJson);

    // Simulate the grok CLI rotating the token in place: a re-spawn with the
    // SAME provider must NOT clobber the CLI's freshly written auth.json.
    fs.writeFileSync(authPath, refreshedAuthJson + '\n', 'utf-8');
    writeGrokProviderAuthMaterial(initialProvider);
    expect(fs.readFileSync(authPath, 'utf-8').trim()).toBe(refreshedAuthJson);

    // A genuine credential rotation (new generation + newer updatedAt) re-seeds.
    writeGrokProviderAuthMaterial(
      provider({
        id: 'grok-oauth-test',
        authProfileGeneration: 4,
        grokAuthJson: rotatedAuthJson,
        updatedAt: '2026-04-26T00:00:00.000Z',
      }),
    );
    expect(fs.readFileSync(authPath, 'utf-8').trim()).toBe(rotatedAuthJson);
  });
});
