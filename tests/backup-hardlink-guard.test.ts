import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const script = path.join(root, 'scripts/check-source-hardlinks.mjs');
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'backup-hardlink-guard-')),
);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * 备份的硬链接守卫。
 *
 * 这个守卫原本按 `find -type f -links +1` 拦截，判据是「文件 nlink > 1」。
 * 但 nlink 是**全局**引用计数，跟「另一端是否在归档树内」无关：
 *
 *   Claude Code 跑后台命令时，会把 /tmp/claude-501/.../tasks/xxx.output
 *   硬链接进 data/sessions/{folder}/.claude/projects/.../tool-results/xxx.txt。
 *   该文件 nlink=2，另一端在 /tmp，永远不会进归档。
 *
 * 后果是：agent 在 HappyClaw 工作区里跑过一次后台命令，`make backup` 就永久
 * 失败 —— 恰好在最需要备份的时候（比如追版本合并前）没有备份。
 *
 * 正确判据是「同一 inode 在归档树内出现 ≥2 次」，因为只有那时 tar 才会为第 2
 * 次出现写「链接到前面成员」的条目。
 *
 * 下面两个用例把方向钉死：树外兄弟必须放行，树内成对必须拦截。搞反了比没有
 * 守卫更糟 —— 会把「备份不可用」这个事实一直藏着。
 */
async function runGuard(dir: string): Promise<{ code: number; err: string }> {
  try {
    await execFileAsync('node', [script, dir]);
    return { code: 0, err: '' };
  } catch (error) {
    const e = error as { code?: number; stderr?: string };
    return { code: e.code ?? 1, err: e.stderr ?? '' };
  }
}

describe('备份硬链接守卫 · 判据是树内重复 inode', () => {
  test('硬链接的另一端在归档树外 —— 放行', async () => {
    const dir = path.join(tmp, 'sibling-outside');
    const outside = path.join(tmp, 'outside-sibling');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    // 模拟 Claude Code 的 tool-results 硬链接：源在 /tmp，链接落在会话目录里。
    const source = path.join(outside, 'task.output');
    fs.writeFileSync(source, 'background task output');
    const inTree = path.join(dir, 'sessions', 'tool-result.txt');
    fs.linkSync(source, inTree);

    // 前提确认：这个文件确实 nlink=2 —— 老判据正是在这里误拦的。
    expect(fs.lstatSync(inTree).nlink).toBe(2);

    const { code } = await runGuard(dir);
    expect(code, '另一端在树外，tar 会当普通文件存，不该拦').toBe(0);
  });

  test('同一 inode 在归档树内出现两次 —— 拦截', async () => {
    const dir = path.join(tmp, 'pair-inside');
    fs.mkdirSync(path.join(dir, 'groups'), { recursive: true });

    const a = path.join(dir, 'groups', 'a.txt');
    const b = path.join(dir, 'groups', 'b.txt');
    fs.writeFileSync(a, 'shared payload');
    fs.linkSync(a, b);

    const { code, err } = await runGuard(dir);
    expect(code, '两端都在树内，tar 会写链接条目，必须拦').toBe(1);
    expect(err).toContain('a.txt');
    expect(err).toContain('b.txt');
  });

  test('普通文件树放行', async () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'x.json'), '{}');
    expect((await runGuard(dir)).code).toBe(0);
  });

  test('符号链接不参与判定（由 prepare-backup-tree 负责）', async () => {
    const dir = path.join(tmp, 'symlinks');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    const target = path.join(dir, 'config', 'real.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, path.join(dir, 'config', 'link.json'));
    expect((await runGuard(dir)).code).toBe(0);
  });

  test('目录不存在时静默放行，不让守卫本身成为失败源', async () => {
    expect((await runGuard(path.join(tmp, 'nope'))).code).toBe(0);
  });
});
