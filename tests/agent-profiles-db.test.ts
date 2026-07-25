import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-profiles-'));

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

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
const mkProfile = (over: Record<string, unknown> = {}) =>
  db.createAgentProfile({
    id: `p${++seq}`,
    ownerUserId: 'u1',
    name: `Profile ${seq}`,
    identityPrompt: 'base identity',
    ...over,
  } as Parameters<typeof db.createAgentProfile>[0]);

describe('computeAgentIdentityHash', () => {
  test('is stable for identical prompt content', () => {
    const parts = {
      identityPrompt: 'a',
      soulPrompt: 'b',
      agentsPrompt: 'c',
      toolsPrompt: 'd',
      promptMode: 'append',
    };
    expect(db.computeAgentIdentityHash(parts)).toBe(
      db.computeAgentIdentityHash({ ...parts }),
    );
  });

  test('changes when any prompt section changes', () => {
    const base = {
      identityPrompt: 'a',
      soulPrompt: 'b',
      agentsPrompt: 'c',
      toolsPrompt: 'd',
      promptMode: 'append',
    };
    const h = db.computeAgentIdentityHash(base);
    for (const key of [
      'identityPrompt',
      'soulPrompt',
      'agentsPrompt',
      'toolsPrompt',
      'promptMode',
    ] as const) {
      expect(db.computeAgentIdentityHash({ ...base, [key]: 'changed' })).not.toBe(h);
    }
  });

  test('does not mix sections — moving text between them changes the hash', () => {
    // A naive concatenation without separators would collide here.
    const a = db.computeAgentIdentityHash({
      identityPrompt: 'ab',
      soulPrompt: '',
      agentsPrompt: '',
      toolsPrompt: '',
      promptMode: 'append',
    });
    const b = db.computeAgentIdentityHash({
      identityPrompt: 'a',
      soulPrompt: 'b',
      agentsPrompt: '',
      toolsPrompt: '',
      promptMode: 'append',
    });
    expect(a).not.toBe(b);
  });
});

describe('create / update / archive', () => {
  test('create stores prompts, fills the hash, and snapshots version 1', () => {
    const p = mkProfile({ soulPrompt: 'terse' });
    expect(p.version).toBe(1);
    expect(p.identityHash).toHaveLength(32);
    expect(db.getAgentProfile(p.id)?.soulPrompt).toBe('terse');
  });

  test('update bumps the version and the hash', () => {
    const p = mkProfile();
    const updated = db.updateAgentProfilePrompts(p.id, {
      soulPrompt: 'now blunt',
    })!;
    expect(updated.version).toBe(2);
    expect(updated.identityHash).not.toBe(p.identityHash);
    expect(updated.soulPrompt).toBe('now blunt');
    // Unspecified fields survive the patch.
    expect(updated.identityPrompt).toBe('base identity');
  });

  test('updating a missing profile returns null rather than throwing', () => {
    expect(db.updateAgentProfilePrompts('nope', { soulPrompt: 'x' })).toBeNull();
  });

  test('only one active default per owner', () => {
    const first = mkProfile({ isDefault: true });
    const second = mkProfile({ isDefault: true });
    expect(db.getAgentProfile(second.id)?.isDefault).toBe(true);
    expect(db.getAgentProfile(first.id)?.isDefault).toBe(false);
  });

  test('archive soft-deletes so version history stays resolvable', () => {
    const p = mkProfile();
    db.archiveAgentProfile(p.id);
    expect(db.getAgentProfile(p.id)).toBeNull();
    expect(db.listAgentProfiles('u1').map((x) => x.id)).not.toContain(p.id);
  });

  test('archiving also unbinds any workspace pointing at it', () => {
    const p = mkProfile();
    db.setWorkspaceAgentProfile('ws-archive', p.id);
    db.archiveAgentProfile(p.id);
    expect(db.getWorkspaceAgentProfile('ws-archive')).toBeNull();
  });
});

describe('workspace binding is N workspaces : 1 profile (decision O1-a)', () => {
  test('one profile serves several workspaces', () => {
    const shared = mkProfile({ identityPrompt: 'shared brain' });
    db.setWorkspaceAgentProfile('ws-a', shared.id);
    db.setWorkspaceAgentProfile('ws-b', shared.id);

    expect(db.getWorkspaceAgentProfile('ws-a')?.id).toBe(shared.id);
    expect(db.getWorkspaceAgentProfile('ws-b')?.id).toBe(shared.id);
  });

  test('editing the shared profile is visible from every bound workspace', () => {
    // This is the accepted consequence of the shared semantics: one edit lands
    // everywhere. The UI must say so; the data model does not fan out copies.
    const shared = mkProfile();
    db.setWorkspaceAgentProfile('ws-c', shared.id);
    db.setWorkspaceAgentProfile('ws-d', shared.id);
    db.updateAgentProfilePrompts(shared.id, { soulPrompt: 'edited once' });

    expect(db.getWorkspaceAgentProfile('ws-c')?.soulPrompt).toBe('edited once');
    expect(db.getWorkspaceAgentProfile('ws-d')?.soulPrompt).toBe('edited once');
  });

  test('rebinding replaces rather than duplicating', () => {
    const a = mkProfile();
    const b = mkProfile();
    db.setWorkspaceAgentProfile('ws-rebind', a.id);
    db.setWorkspaceAgentProfile('ws-rebind', b.id);
    expect(db.getWorkspaceAgentProfile('ws-rebind')?.id).toBe(b.id);
  });

  test('an unbound workspace falls back to the owner default', () => {
    const def = mkProfile({ isDefault: true, identityPrompt: 'the default' });
    expect(db.getWorkspaceAgentProfile('never-bound', 'u1')?.id).toBe(def.id);
  });

  test('no profile at all means no persona, not an error', () => {
    // A deployment that never creates a profile must behave exactly as before.
    expect(db.getWorkspaceAgentProfile('never-bound', 'user-with-nothing')).toBeNull();
    expect(db.getWorkspaceAgentProfile('never-bound')).toBeNull();
  });

  test('clearing a binding falls back to the default again', () => {
    const def = db.listAgentProfiles('u1').find((p) => p.isDefault)!;
    const other = mkProfile();
    db.setWorkspaceAgentProfile('ws-clear', other.id);
    db.clearWorkspaceAgentProfile('ws-clear');
    expect(db.getWorkspaceAgentProfile('ws-clear', 'u1')?.id).toBe(def.id);
  });
});

describe('session identity — persona change must NOT reset (decision O1-b)', () => {
  test('mismatch is reported when the identity hash moved', () => {
    const p = mkProfile();
    db.setSession('folder-x', 'sess-1');
    db.setSessionAgentIdentity('folder-x', '', {
      agentProfileId: p.id,
      identityHash: p.identityHash,
      version: p.version,
    });

    const updated = db.updateAgentProfilePrompts(p.id, { soulPrompt: 'changed' })!;
    expect(
      db.hasSessionAgentProfileMismatch('folder-x', '', {
        agentProfileId: updated.id,
        identityHash: updated.identityHash,
      }),
    ).toBe(true);
  });

  test('the session itself survives the mismatch — context is kept', () => {
    // The whole point of O1-b: upstream deletes the session here. This codebase
    // already tolerates prefix drift from memory rewrites without deleting
    // anything, so a persona edit gets the same treatment.
    const p = mkProfile();
    db.setSession('folder-keep', 'sess-keep');
    db.setSessionAgentIdentity('folder-keep', '', {
      agentProfileId: p.id,
      identityHash: p.identityHash,
      version: p.version,
    });
    const updated = db.updateAgentProfilePrompts(p.id, { soulPrompt: 'drifted' })!;

    db.hasSessionAgentProfileMismatch('folder-keep', '', {
      agentProfileId: updated.id,
      identityHash: updated.identityHash,
    });

    expect(db.getSession('folder-keep')).toBe('sess-keep');
  });

  test('no mismatch when the persona is unchanged', () => {
    const p = mkProfile();
    db.setSession('folder-same', 'sess-2');
    db.setSessionAgentIdentity('folder-same', '', {
      agentProfileId: p.id,
      identityHash: p.identityHash,
      version: p.version,
    });
    expect(
      db.hasSessionAgentProfileMismatch('folder-same', '', {
        agentProfileId: p.id,
        identityHash: p.identityHash,
      }),
    ).toBe(false);
  });

  test('switching to a different profile counts as a mismatch', () => {
    const a = mkProfile();
    const b = mkProfile();
    db.setSession('folder-swap', 'sess-3');
    db.setSessionAgentIdentity('folder-swap', '', {
      agentProfileId: a.id,
      identityHash: a.identityHash,
      version: a.version,
    });
    expect(
      db.hasSessionAgentProfileMismatch('folder-swap', '', {
        agentProfileId: b.id,
        identityHash: b.identityHash,
      }),
    ).toBe(true);
  });

  test('a session with no recorded identity is not a mismatch', () => {
    // Pre-existing sessions must not all report drift the moment profiles land.
    db.setSession('folder-legacy', 'sess-legacy');
    expect(
      db.hasSessionAgentProfileMismatch('folder-legacy', '', {
        agentProfileId: 'p-any',
        identityHash: 'h-any',
      }),
    ).toBe(false);
  });

  test('an unknown session is not a mismatch', () => {
    expect(
      db.hasSessionAgentProfileMismatch('folder-absent', '', {
        agentProfileId: 'p',
        identityHash: 'h',
      }),
    ).toBe(false);
  });
});
