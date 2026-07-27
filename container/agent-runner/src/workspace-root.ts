import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 工作区根隔离。
 *
 * host 模式的 agent 跑在 `data/groups/<folder>`，这个目录嵌套在 HappyClaw 仓库
 * 内部。三条运行时都会从 cwd 向上找「项目根」，于是本仓库的开发文档（CLAUDE.md、
 * .claude/rules、.claude/settings.local.json）被当成项目指令加载，把一个业务
 * Agent 重新定义成「HappyClaw 代码库助手」。
 *
 * 三条运行时各有各的向上查找机制，所以止血手段也不同：
 *   - Claude：SDK 支持 `claudeMdExcludes` 显式排除 → claude-memory-policy.ts
 *   - Codex ：配置 `project_root_markers` → 在工作区放标记文件即可停住
 *   - Grok  ：只认 git，无标记可配 → 必须让工作区自己成为 git 根
 */

export const WORKSPACE_ROOT_MARKER = '.happyclaw-workspace';

const MARKER_CONTENT = `# HappyClaw 工作区根标记
#
# 这个文件让运行时的「项目根」向上查找停在本目录，避免把 HappyClaw 仓库自身的
# 开发文档当成项目指令加载。删除它会导致 Agent 人格被仓库 CLAUDE.md 污染。
`;

/** 写入 codex 的 project_root_markers 标记文件（幂等）。 */
export function ensureWorkspaceRootMarker(cwd: string): void {
  try {
    const marker = path.join(cwd, WORKSPACE_ROOT_MARKER);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, MARKER_CONTENT, 'utf-8');
    }
  } catch {
    /* 退回默认行为：污染但不致命 */
  }
}

/** 从 cwd 向上找是否存在祖先 git 仓库（不含 cwd 自身）。 */
function findAncestorGitRoot(cwd: string): string | undefined {
  let dir = path.dirname(path.resolve(cwd));
  let prev = '';
  while (dir && dir !== prev) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    prev = dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * 让工作区自己成为 git 根，屏蔽祖先仓库。
 *
 * 只在「host 模式 + 工作区自身没有 .git + 确实存在祖先仓库」时才动手——没有祖先
 * 仓库时 grok 走 CWD-only 模式，本来就干净，不需要凭空造一个 repo。
 *
 * 顺带修掉一个更凶的隐患：在此之前，host 工作区里的 agent 执行任何 git 命令
 * （`git status` / `git commit -am` / `git checkout .`）操作的都是 HappyClaw
 * 源码树本身。
 *
 * @returns 是否新建了仓库
 */
export function ensureWorkspaceGitRoot(
  cwd: string,
  executionMode: 'host' | 'container' | undefined,
): boolean {
  if (executionMode !== 'host') return false;
  try {
    if (fs.existsSync(path.join(cwd, '.git'))) return false;
    if (!findAncestorGitRoot(cwd)) return false;
    execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Grok 的 harness 兼容扫描开关。
 *
 * grok 默认会去扒 Claude / Cursor / Codex 三家的配置目录（每一档 6 个格子：
 * skills / rules / agents / mcps / hooks / sessions，env var 优先级最高）。
 * 对齐 claude-memory-policy 的取舍：
 *   - agents / rules —— 关。HappyClaw 自己把 CLAUDE.md 和 rules 链进会话目录
 *     下发，原始路径再被扫一遍就是重复加载 + 绕过 managed 计划。
 *   - mcps / hooks / sessions —— 关。MCP server 经 ACP `session/new` 显式下发，
 *     hooks 由平台管；让 grok 去读 ~/.claude.json、~/.claude/settings.json 属于
 *     纯粹的越权注入。
 *   - skills —— 留。容器模式下 HappyClaw 正是把技能挂在 ~/.claude/skills，
 *     关掉会直接丢能力；这也与 claude-memory-policy「保留 user-source Skills」
 *     的注释一致。
 */
export function buildGrokCompatEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const vendor of ['CLAUDE', 'CURSOR', 'CODEX']) {
    for (const cell of ['AGENTS', 'RULES', 'MCPS', 'HOOKS', 'SESSIONS']) {
      env[`GROK_${vendor}_${cell}_ENABLED`] = 'false';
    }
  }
  env.GROK_CLAUDE_SKILLS_ENABLED = 'true';
  env.GROK_CURSOR_SKILLS_ENABLED = 'false';
  env.GROK_CODEX_SKILLS_ENABLED = 'false';
  return env;
}
