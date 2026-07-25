import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-executing-folder-'),
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

/**
 * Reproduces the reference deployment's shape: folder='main' collects the real
 * main entry points (web + QQ + Feishu DM) plus Feishu groups that were
 * auto-registered under main (§8.2) and later bound to their own workspaces via
 * target_main_jid. Those bound rows still carry folder='main' but execute
 * elsewhere, so stopping "every sibling of main" used to kill them too.
 */
function addGroup(
  jid: string,
  folder: string,
  targetMainJid?: string,
): void {
  db.setRegisteredGroup(jid, {
    name: jid,
    folder,
    added_at: new Date().toISOString(),
    is_home: jid === 'web:main',
    target_main_jid: targetMainJid,
  } as Parameters<typeof db.setRegisteredGroup>[1]);
}

beforeAll(() => {
  db.initDatabase();
  addGroup('web:main', 'main');
  addGroup('qq:c2c:QQ1', 'main');
  addGroup('feishu:DM', 'main');
  addGroup('web:ws-alpha', 'flow-alpha');
  addGroup('web:ws-beta', 'flow-beta');
  addGroup('feishu:G1', 'main', 'web:ws-alpha');
  addGroup('feishu:G2', 'main', 'web:ws-beta');
  // Pointer that resolves back into the same folder.
  addGroup('feishu:SELF', 'flow-alpha', 'web:ws-alpha');
  // Pointer to a row that no longer exists.
  addGroup('feishu:DANGLING', 'main', 'web:deleted');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getJidsExecutingInFolder', () => {
  test('getJidsByFolder still returns every row carrying the folder', () => {
    // Baseline: the old query is unchanged, other callers keep their semantics.
    expect(db.getJidsByFolder('main').sort()).toEqual(
      [
        'feishu:DANGLING',
        'feishu:DM',
        'feishu:G1',
        'feishu:G2',
        'qq:c2c:QQ1',
        'web:main',
      ].sort(),
    );
  });

  test('excludes rows routed to another folder', () => {
    const jids = db.getJidsExecutingInFolder('main');
    expect(jids).not.toContain('feishu:G1');
    expect(jids).not.toContain('feishu:G2');
  });

  test('keeps the folder’s genuine entry points', () => {
    expect(db.getJidsExecutingInFolder('main').sort()).toEqual(
      ['feishu:DANGLING', 'feishu:DM', 'qq:c2c:QQ1', 'web:main'].sort(),
    );
  });

  test('a self-referential pointer stays in its folder', () => {
    expect(db.getJidsExecutingInFolder('flow-alpha').sort()).toEqual(
      ['feishu:SELF', 'web:ws-alpha'].sort(),
    );
  });

  test('the routing target itself is listed under its own folder', () => {
    expect(db.getJidsExecutingInFolder('flow-beta')).toEqual(['web:ws-beta']);
  });

  test('a dangling pointer keeps the row in its own folder', () => {
    // LEFT JOIN yields no target row, so the row is treated as unrouted rather
    // than silently dropped — losing it would leave an unstoppable runner.
    expect(db.getJidsExecutingInFolder('main')).toContain('feishu:DANGLING');
  });

  test('unknown folder returns empty', () => {
    expect(db.getJidsExecutingInFolder('flow-nonexistent')).toEqual([]);
  });
});
