import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-grok-models-'),
);

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

describe('Grok model catalog defaults', () => {
  test('seeds current xAI model options and aliases', () => {
    const options = db.listProviderPoolModelOptions('grok', true);
    const byId = new Map(options.map((option) => [option.model_id, option]));

    for (const modelId of ['grok-4.5', 'grok-4.3', 'grok-build-0.1']) {
      expect(byId.get(modelId)).toMatchObject({
        model_kind: 'explicit_version',
        status: 'unverified',
      });
      expect(
        JSON.parse(byId.get(modelId)?.metadata_json || '{}'),
      ).toMatchObject({
        resolved_model: modelId,
      });
    }

    expect(
      JSON.parse(byId.get('grok-4.5')?.metadata_json || '{}'),
    ).toMatchObject({
      aliases: ['grok-4.5-latest', 'grok-build-latest'],
      capabilities: {
        context_window: 500_000,
        input_modalities: ['text', 'image'],
        reasoning: true,
        supports_effort: true,
      },
    });
    expect(
      JSON.parse(byId.get('grok-4.3')?.metadata_json || '{}'),
    ).toMatchObject({
      aliases: ['grok-4.3-latest', 'grok-latest'],
      capabilities: {
        context_window: 1_000_000,
        input_modalities: ['text', 'image'],
        reasoning: true,
        supports_effort: true,
      },
    });
    expect(
      JSON.parse(byId.get('grok-build-0.1')?.metadata_json || '{}'),
    ).toMatchObject({
      aliases: ['grok-code-fast-1', 'grok-code-fast', 'grok-code-fast-1-0825'],
      capabilities: {
        context_window: 256_000,
        input_modalities: ['text', 'image'],
        reasoning: true,
      },
    });
  });
});
