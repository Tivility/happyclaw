import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-carryover-'));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
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

/**
 * conversation_runtime_sessions is keyed by model_key, so switching opus to
 * sonnet used to find no row and restart the conversation from a handoff
 * summary. For Claude that is stricter than the platform requires — the
 * transcript is model-agnostic and resumes fine under another model — so the
 * summary was discarding verbatim context for nothing.
 *
 * The carry-over stays narrow, and these tests pin the boundary: runtime and
 * provider must match, because another runtime issues its own session ids and
 * another provider invalidates thinking-block signatures.
 */
const KEY = {
  group_folder: 'w1',
  agent_id: '',
  runtime: 'claude' as const,
  provider_family: 'anthropic' as const,
  provider_pool_id: 'pool1',
  provider_id: 'prov1',
  auth_profile_generation: 1,
  auth_profile_fingerprint: 'oauth:1',
  selected_model: null,
  model_kind: 'explicit_version' as const,
  resolved_model: null,
};

function seed(
  over: Partial<typeof KEY> & { model_key: string; native_session_id: string },
): void {
  db.setRuntimeNativeSession({
    ...KEY,
    ...over,
  } as Parameters<typeof db.setRuntimeNativeSession>[0]);
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  db.deleteRuntimeNativeSessionsForFolder('w1');
  db.deleteRuntimeNativeSessionsForFolder('other');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getCarryOverNativeSession', () => {
  test('carries a session over when only the model changed', () => {
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });

    const carried = db.getCarryOverNativeSession({ ...KEY, model_key: 'sonnet' });
    expect(carried?.native_session_id).toBe('sess-opus');
  });

  test('does not carry across runtimes — another runtime issues its own ids', () => {
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });

    const carried = db.getCarryOverNativeSession({
      ...KEY,
      runtime: 'codex' as never,
      model_key: 'gpt',
    });
    expect(carried).toBeUndefined();
  });

  test('does not carry across providers — thinking-block signatures would break', () => {
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });

    const carried = db.getCarryOverNativeSession({
      ...KEY,
      provider_id: 'prov2',
      model_key: 'sonnet',
    });
    expect(carried).toBeUndefined();
  });

  test('does not carry across auth generations — a re-auth is a new credential lineage', () => {
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });

    const carried = db.getCarryOverNativeSession({
      ...KEY,
      auth_profile_generation: 2,
      model_key: 'sonnet',
    });
    expect(carried).toBeUndefined();
  });

  test('excludes the exact model — that row is the caller’s own lookup', () => {
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });
    expect(
      db.getCarryOverNativeSession({ ...KEY, model_key: 'opus' }),
    ).toBeUndefined();
  });

  test('picks the most recently updated candidate', async () => {
    // A conversation that moved through several models carries over from
    // wherever it last actually ran, not from the oldest row.
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });
    await new Promise((r) => setTimeout(r, 5));
    seed({ model_key: 'haiku', native_session_id: 'sess-haiku' });

    const carried = db.getCarryOverNativeSession({ ...KEY, model_key: 'sonnet' });
    expect(carried?.native_session_id).toBe('sess-haiku');
  });

  test('ignores rows with no session id', () => {
    seed({ model_key: 'opus', native_session_id: '' });
    expect(
      db.getCarryOverNativeSession({ ...KEY, model_key: 'sonnet' }),
    ).toBeUndefined();
  });

  test('another workspace never leaks in', () => {
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });
    expect(
      db.getCarryOverNativeSession({
        ...KEY,
        group_folder: 'other',
        model_key: 'sonnet',
      }),
    ).toBeUndefined();
  });

  test('another agent tab never leaks in', () => {
    // Agent tabs are separate conversations with separate sessions by design.
    seed({ model_key: 'opus', native_session_id: 'sess-opus' });
    expect(
      db.getCarryOverNativeSession({ ...KEY, agent_id: 'a2', model_key: 'sonnet' }),
    ).toBeUndefined();
  });

  test('no candidate at all returns undefined rather than throwing', () => {
    expect(
      db.getCarryOverNativeSession({ ...KEY, model_key: 'sonnet' }),
    ).toBeUndefined();
  });
});
