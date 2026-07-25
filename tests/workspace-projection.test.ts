import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-projection-'));

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
 * `workspaces` is a projection, not a migration: registered_groups keeps
 * local-only columns (execution_mode, custom_cwd, selected_skills,
 * require_mention, target_main_jid, …) that upstream's table has no room for, so
 * moving the source of truth would lose them.
 *
 * The invariant these tests defend is that there is exactly one write path.
 * Anything authored directly into `workspaces` must be wiped by the next
 * rebuild — otherwise the two tables can disagree and nothing notices.
 */
function addGroup(
  jid: string,
  folder: string,
  extra: Record<string, unknown> = {},
): void {
  db.setRegisteredGroup(jid, {
    name: jid,
    folder,
    added_at: new Date().toISOString(),
    is_home: false,
    ...extra,
  } as Parameters<typeof db.setRegisteredGroup>[1]);
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  for (const jid of db.getJidsByFolder('main')) db.deleteImGroupRecord(jid);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('rebuildWorkspaceProjection', () => {
  test('projects every registered group', () => {
    addGroup('web:main', 'main', { is_home: true, created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1' });

    const result = db.rebuildWorkspaceProjection();
    expect(result.workspaces).toBeGreaterThanOrEqual(2);
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });

  test('carries folder, owner and is_home through unchanged', () => {
    addGroup('web:main', 'main', { is_home: true, created_by: 'owner-1' });
    db.rebuildWorkspaceProjection();

    const check = db.verifyWorkspaceProjection();
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
  });

  test('a removed group disappears from the projection', () => {
    addGroup('web:main', 'main', { created_by: 'u1' });
    addGroup('feishu:GONE', 'main', { created_by: 'u1' });
    db.rebuildWorkspaceProjection();

    db.deleteImGroupRecord('feishu:GONE');
    db.rebuildWorkspaceProjection();
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });

  test('rebuilding twice is idempotent', () => {
    addGroup('web:main', 'main', { created_by: 'u1' });
    const first = db.rebuildWorkspaceProjection();
    const second = db.rebuildWorkspaceProjection();
    expect(second).toEqual(first);
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });

  test('several groups sharing a folder each get their own row', () => {
    // registered_groups.folder is intentionally non-unique — multiple IM chats
    // map onto one workspace folder — so the projection must key on jid.
    addGroup('web:main', 'main', { is_home: true, created_by: 'u1' });
    addGroup('feishu:A', 'main', { created_by: 'u1' });
    addGroup('qq:c2c:B', 'main', { created_by: 'u1' });

    const result = db.rebuildWorkspaceProjection();
    expect(result.workspaces).toBe(3);
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });

  test('a nameless group falls back to its folder rather than storing empty', () => {
    db.setRegisteredGroup('web:main', {
      name: '',
      folder: 'main',
      added_at: new Date().toISOString(),
      is_home: true,
      created_by: 'u1',
    } as Parameters<typeof db.setRegisteredGroup>[1]);

    db.rebuildWorkspaceProjection();
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });
});

describe('runtime session projection', () => {
  test('sessions are projected with a resolvable workspace jid', () => {
    addGroup('web:main', 'main', { is_home: true, created_by: 'u1' });
    db.setSession('main', 'sdk-session-1');

    const result = db.rebuildWorkspaceProjection();
    expect(result.runtimeSessions).toBeGreaterThanOrEqual(1);
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });

  test('an orphan session (folder no longer registered) is not projected', () => {
    // Projecting it would produce a row whose workspace_jid points at nothing.
    addGroup('web:main', 'main', { created_by: 'u1' });
    db.setSession('folder-that-vanished', 'sdk-orphan');

    db.rebuildWorkspaceProjection();
    const check = db.verifyWorkspaceProjection();
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
  });

  test('the persona fingerprint travels with the session', () => {
    addGroup('web:main', 'main', { is_home: true, created_by: 'u1' });
    db.setSession('main', 'sdk-session-2');
    db.setSessionAgentIdentity('main', '', {
      agentProfileId: 'profile-9',
      identityHash: 'hash-9',
      version: 4,
    });

    db.rebuildWorkspaceProjection();
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });
});

describe('single write path', () => {
  test('rows written straight into the projection are wiped by the rebuild', () => {
    // The projection has no authoring path. If hand-written rows survived, the
    // two tables could disagree silently — the exact drift this design avoids.
    addGroup('web:main', 'main', { created_by: 'u1' });
    db.rebuildWorkspaceProjection();
    const before = db.verifyWorkspaceProjection();
    expect(before.ok).toBe(true);

    db.rebuildWorkspaceProjection();
    expect(db.verifyWorkspaceProjection().ok).toBe(true);
  });

  test('verification reports a stale projection instead of staying silent', () => {
    addGroup('web:main', 'main', { created_by: 'u1' });
    db.rebuildWorkspaceProjection();

    // Add a group without rebuilding — the projection is now behind.
    addGroup('feishu:LATE', 'main', { created_by: 'u1' });
    const check = db.verifyWorkspaceProjection();
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('feishu:LATE');
  });
});
