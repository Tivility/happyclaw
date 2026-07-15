import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-gpt-models-'));

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

describe('GPT model catalog defaults', () => {
  test('seeds GPT-5.6 family options and aliases', () => {
    const options = db.listProviderPoolModelOptions('gpt', true);
    const byId = new Map(options.map((option) => [option.model_id, option]));

    for (const modelId of [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]) {
      expect(byId.get(modelId)).toMatchObject({
        model_kind: 'explicit_version',
        status: 'unverified',
      });
      expect(
        JSON.parse(byId.get(modelId)?.metadata_json || '{}'),
      ).toMatchObject({
        resolved_model: modelId,
        capabilities: {
          context_window: 1_050_000,
          max_output_tokens: 128_000,
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          reasoning: true,
          supports_effort: true,
          effort_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
      });
    }

    expect(
      JSON.parse(byId.get('gpt-5.6-sol')?.metadata_json || '{}'),
    ).toMatchObject({
      aliases: ['gpt-5.6'],
    });
  });
});
