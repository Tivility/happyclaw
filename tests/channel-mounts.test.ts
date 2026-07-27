import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mounts-'));

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
 * agent_channel_mounts replaces registered_groups.target_main_jid, which was a
 * patch layer on a column that already meant something else: an IM chat
 * auto-registers into its owner's home folder, so `folder` says where it was
 * registered while target_main_jid says where it actually runs. On the reference
 * deployment those answers diverge for 21 of the 24 rows carrying folder='main'.
 *
 * The migration is additive — target_main_jid is not cleared — and reconciliation
 * is the acceptance gate (decision M5: correct in one pass, no compromise). These
 * tests exist because a *partially* correct routing table looks fine, which is
 * precisely what makes it dangerous.
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

function wipe(): void {
  for (const m of db.listChannelMounts()) db.deleteChannelMount(m.channelJid);
  for (const folder of ['main', 'flow-a', 'flow-b']) {
    for (const jid of db.getJidsByFolder(folder)) db.deleteImGroupRecord(jid);
  }
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(wipe);

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migrateTargetMainJidToChannelMounts', () => {
  test('copies each binding to the workspace it actually routes to', () => {
    addGroup('web:main', 'main', { is_home: true, created_by: 'u1' });
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', {
      created_by: 'u1',
      target_main_jid: 'web:wsA',
    });

    const { migrated, skipped } = db.migrateTargetMainJidToChannelMounts();
    expect(migrated).toBe(1);
    expect(skipped).toEqual([]);

    const mount = db.getAgentChannelMountView('feishu:G1')!;
    // The mount records the *execution* target, not the registration folder.
    expect(mount.workspaceJid).toBe('web:wsA');
    expect(mount.workspaceFolder).toBe('flow-a');
    expect(mount.channelType).toBe('feishu');
    expect(mount.ownerUserId).toBe('u1');
  });

  test('derives channel type from the jid prefix', () => {
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    for (const jid of ['feishu:oc_x', 'qq:c2c:abc', 'wechat:o9cq@im.wechat']) {
      addGroup(jid, 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });
    }
    db.migrateTargetMainJidToChannelMounts();

    expect(db.getAgentChannelMountView('feishu:oc_x')?.channelType).toBe('feishu');
    expect(db.getAgentChannelMountView('qq:c2c:abc')?.channelType).toBe('qq');
    expect(db.getAgentChannelMountView('wechat:o9cq@im.wechat')?.channelType).toBe('wechat');
  });

  test('a dangling target is skipped with a reason, never guessed at', () => {
    // Inventing a target would silently route messages to the wrong workspace.
    addGroup('feishu:DANGLE', 'main', {
      created_by: 'u1',
      target_main_jid: 'web:deleted',
    });

    const { migrated, skipped } = db.migrateTargetMainJidToChannelMounts();
    expect(migrated).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].jid).toBe('feishu:DANGLE');
    expect(skipped[0].reason).toContain('web:deleted');
    expect(db.getAgentChannelMountView('feishu:DANGLE')).toBeNull();
  });

  test('unbound groups are not mounted', () => {
    addGroup('web:main', 'main', { is_home: true, created_by: 'u1' });
    db.migrateTargetMainJidToChannelMounts();
    expect(db.getAgentChannelMountView('web:main')).toBeNull();
  });

  test('re-running converges instead of duplicating', () => {
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });

    db.migrateTargetMainJidToChannelMounts();
    db.migrateTargetMainJidToChannelMounts();
    expect(db.listChannelMounts()).toHaveLength(1);
  });

  test('a rebound channel follows the binding on the next run', () => {
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('web:wsB', 'flow-b', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });
    db.migrateTargetMainJidToChannelMounts();

    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsB' });
    db.migrateTargetMainJidToChannelMounts();

    expect(db.getAgentChannelMountView('feishu:G1')?.workspaceJid).toBe('web:wsB');
    expect(db.getAgentChannelMountView('feishu:G1')?.workspaceFolder).toBe('flow-b');
  });

  test('target_main_jid is left in place — migration is additive', () => {
    // The column keeps serving routing until reconciliation proves the mounts.
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });
    db.migrateTargetMainJidToChannelMounts();

    expect(db.getRegisteredGroup('feishu:G1')?.target_main_jid).toBe('web:wsA');
  });
});

describe('reconcileChannelMounts is the M5 acceptance gate', () => {
  test('passes when every binding has a matching mount', () => {
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('web:wsB', 'flow-b', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });
    addGroup('feishu:G2', 'main', { created_by: 'u1', target_main_jid: 'web:wsB' });
    db.migrateTargetMainJidToChannelMounts();

    const recon = db.reconcileChannelMounts();
    expect(recon.ok).toBe(true);
    expect(recon.checked).toBe(2);
    expect(recon.problems).toEqual([]);
  });

  test('fails when a binding has no mount', () => {
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });
    // upstream 在 setRegisteredGroup 里加了 channel_mounts → agent_channel_mounts
    // 的自动镜像（syncAgentChannelMountsForWorkspaceJid），所以「绑定了但从未
    // 迁移」这个前提不再能靠"不调用迁移"构造出来 —— 挂载在注册时就有了。
    // 直接删掉挂载来还原这个场景，reconcile 的语义（绑定必须有对应挂载）不变。
    db.deleteAgentChannelMountView('feishu:G1');
    const recon = db.reconcileChannelMounts();
    expect(recon.ok).toBe(false);
    expect(recon.problems.join(' ')).toContain('missing mount for feishu:G1');
  });

  test('fails when a mount points somewhere the binding does not', () => {
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    addGroup('web:wsB', 'flow-b', { created_by: 'u1' });
    addGroup('feishu:G1', 'main', { created_by: 'u1', target_main_jid: 'web:wsA' });
    db.migrateTargetMainJidToChannelMounts();

    // Simulate drift: point the mount at the wrong workspace.
    db.setChannelMount({
      channelJid: 'feishu:G1',
      channelType: 'feishu',
      workspaceJid: 'web:wsB',
      workspaceFolder: 'flow-b',
    });

    const recon = db.reconcileChannelMounts();
    expect(recon.ok).toBe(false);
    expect(recon.problems.join(' ')).toContain('points at web:wsB');
  });

  test('fails on an extra mount with no binding behind it', () => {
    // An extra mount would route a channel the source of truth calls unbound.
    addGroup('web:wsA', 'flow-a', { created_by: 'u1' });
    db.setChannelMount({
      channelJid: 'feishu:GHOST',
      channelType: 'feishu',
      workspaceJid: 'web:wsA',
      workspaceFolder: 'flow-a',
    });

    const recon = db.reconcileChannelMounts();
    expect(recon.ok).toBe(false);
    expect(recon.problems.join(' ')).toContain('feishu:GHOST');
  });

  test('fails on a mount whose workspace is not registered', () => {
    db.setChannelMount({
      channelJid: 'feishu:G1',
      channelType: 'feishu',
      workspaceJid: 'web:nonexistent',
      workspaceFolder: 'nope',
    });
    const recon = db.reconcileChannelMounts();
    expect(recon.ok).toBe(false);
    expect(recon.problems.join(' ')).toContain('unregistered workspace');
  });

  test('a dangling binding does not fail reconciliation — it was reported as skipped', () => {
    addGroup('feishu:DANGLE', 'main', {
      created_by: 'u1',
      target_main_jid: 'web:deleted',
    });
    db.migrateTargetMainJidToChannelMounts();

    const recon = db.reconcileChannelMounts();
    expect(recon.ok).toBe(true);
  });

  test('an empty deployment reconciles cleanly', () => {
    expect(db.reconcileChannelMounts()).toEqual({
      ok: true,
      checked: 0,
      problems: [],
    });
  });
});
