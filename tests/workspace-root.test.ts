import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  WORKSPACE_ROOT_MARKER,
  buildGrokCompatEnv,
  ensureWorkspaceGitRoot,
  ensureWorkspaceRootMarker,
} from '../container/agent-runner/src/workspace-root.js';

const tmpRoots: string[] = [];

function makeTree(withAncestorRepo: boolean): { ancestor: string; workspace: string } {
  const ancestor = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-wsroot-'));
  tmpRoots.push(ancestor);
  if (withAncestorRepo) {
    execFileSync('git', ['init', '-q', '.'], { cwd: ancestor, stdio: 'ignore' });
  }
  const workspace = path.join(ancestor, 'data', 'groups', 'demo');
  fs.mkdirSync(workspace, { recursive: true });
  return { ancestor, workspace };
}

afterEach(() => {
  while (tmpRoots.length) {
    fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe('ensureWorkspaceRootMarker', () => {
  test('写入标记且幂等，不覆盖已有内容', () => {
    const { workspace } = makeTree(false);
    const marker = path.join(workspace, WORKSPACE_ROOT_MARKER);

    ensureWorkspaceRootMarker(workspace);
    expect(fs.existsSync(marker)).toBe(true);

    fs.writeFileSync(marker, 'edited-by-hand', 'utf-8');
    ensureWorkspaceRootMarker(workspace);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('edited-by-hand');
  });

  test('目录不存在时静默退回，不抛异常', () => {
    expect(() => ensureWorkspaceRootMarker('/nonexistent/hc/xyz')).not.toThrow();
  });
});

describe('ensureWorkspaceGitRoot', () => {
  test('host 模式 + 存在祖先仓库 → 建仓，屏蔽祖先', () => {
    const { workspace } = makeTree(true);
    expect(ensureWorkspaceGitRoot(workspace, 'host')).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(true);
  });

  test('没有祖先仓库时不凭空建仓', () => {
    const { workspace } = makeTree(false);
    expect(ensureWorkspaceGitRoot(workspace, 'host')).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(false);
  });

  test('container 模式不动手（容器里看不到宿主仓库）', () => {
    const { workspace } = makeTree(true);
    expect(ensureWorkspaceGitRoot(workspace, 'container')).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(false);
  });

  test('executionMode 缺失时保守不动手', () => {
    const { workspace } = makeTree(true);
    expect(ensureWorkspaceGitRoot(workspace, undefined)).toBe(false);
  });

  test('工作区已是 git 根时幂等，不重新 init', () => {
    const { workspace } = makeTree(true);
    expect(ensureWorkspaceGitRoot(workspace, 'host')).toBe(true);
    expect(ensureWorkspaceGitRoot(workspace, 'host')).toBe(false);
  });
});

describe('buildGrokCompatEnv', () => {
  const env = buildGrokCompatEnv();

  test('三家厂商的注入面全部关闭', () => {
    for (const vendor of ['CLAUDE', 'CURSOR', 'CODEX']) {
      for (const cell of ['AGENTS', 'RULES', 'MCPS', 'HOOKS', 'SESSIONS']) {
        expect(env[`GROK_${vendor}_${cell}_ENABLED`]).toBe('false');
      }
    }
  });

  // 反直觉但必须保持：容器模式下 HappyClaw 正是把技能挂在 ~/.claude/skills，
  // 关掉这一格会让 grok 直接丢掉全部技能能力。
  test('claude 的 skills 必须保持开启，cursor/codex 的关闭', () => {
    expect(env.GROK_CLAUDE_SKILLS_ENABLED).toBe('true');
    expect(env.GROK_CURSOR_SKILLS_ENABLED).toBe('false');
    expect(env.GROK_CODEX_SKILLS_ENABLED).toBe('false');
  });

  test('只产出 GROK_ 前缀的布尔字符串，不污染其他环境变量', () => {
    for (const [key, value] of Object.entries(env)) {
      expect(key).toMatch(/^GROK_[A-Z]+_[A-Z]+_ENABLED$/);
      expect(['true', 'false']).toContain(value);
    }
  });
});
