import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-claude-models-'));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.ts');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Claude model catalog defaults', () => {
  test('seeds the latest Claude Code model options', () => {
    const options = db.listProviderPoolModelOptions('claude', true);
    const byId = new Map(options.map((option) => [option.model_id, option]));

    expect(byId.get('fable')).toMatchObject({
      model_kind: 'alias',
      status: 'unverified',
    });
    for (const modelId of [
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]) {
      expect(byId.get(modelId)).toMatchObject({
        model_kind: 'explicit_version',
        status: 'unverified',
      });
      expect(JSON.parse(byId.get(modelId)?.metadata_json || '{}')).toMatchObject({
        resolved_model: modelId,
        capabilities: {
          context_window: 1_000_000,
          max_output_tokens: 128_000,
          adaptive_thinking: true,
          supports_effort: true,
        },
      });
    }

    expect(byId.get('opus[1m]')).toMatchObject({
      model_kind: 'alias',
      display_name: 'Claude Opus 1M',
      status: 'unverified',
    });
    expect(byId.get('sonnet[1m]')).toMatchObject({
      model_kind: 'alias',
      display_name: 'Claude Sonnet 1M',
      status: 'unverified',
    });

    expect(byId.get('claude-opus-4-8[1m]')).toMatchObject({
      model_kind: 'explicit_version',
      display_name: 'Claude Opus 4.8 1M',
      status: 'unverified',
    });
    expect(JSON.parse(byId.get('claude-opus-4-8[1m]')?.metadata_json || '{}')).toMatchObject({
      resolved_model: 'claude-opus-4-8[1m]',
      base_model: 'claude-opus-4-8',
      aliases: ['opus-4.8-1m', 'opus-4-8-1m'],
      capabilities: {
        context_window: 1_000_000,
        context_variant: '1m',
      },
    });
  });
});
