import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-tool-init-'));
// realpathSync：require.resolve 返回的是展开符号链接后的真实路径，而
// path.resolve 不展开。macOS 上 /var → /private/var 这类链接会让
// startsWith 前缀比较落空。
const runnerRoot = fs.realpathSync(path.resolve('container/agent-runner'));
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdkEntry = runnerRequire.resolve('@anthropic-ai/claude-agent-sdk');
const runnerSdk = (await import(
  pathToFileURL(runnerSdkEntry).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function toolNames(
  isHome: boolean,
  options: {
    isScheduledTask?: boolean;
    currentTaskId?: string | null;
    agentBuilderEnabled?: boolean;
  } = {},
): string[] {
  return createMcpTools({
    chatJid: 'web:tool-init',
    groupFolder: 'tool-init',
    isHome,
    isAdminHome: true,
    agentBuilderEnabled: options.agentBuilderEnabled ?? isHome,
    isScheduledTask: options.isScheduledTask ?? false,
    currentTaskId: options.currentTaskId ?? null,
    currentInputTurnId: 'turn-1',
    workspaceIpc: '/tmp/tool-init-ipc',
    workspaceGroup: '/tmp/tool-init-group',
    workspaceGlobal: '/tmp/tool-init-global',
    workspaceMemory: '/tmp/tool-init-memory',
  }).map((tool) => tool.name);
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('HappyClaw tool initialization', () => {
  // 决策（用户拍板）：保本地「始终最新」策略，不采用 upstream 的版本钉死 +
  // package-lock。原用例断言 SDK/CLI 版本号形如 x.y.z 且与 lock file 一致，
  // 与本地契约（"*" + 无 lock + CACHEBUST）直接冲突。改为验证本地契约本身：
  // 依赖声明必须是 "*"、不得有 lock file、且 runner 解析到的 SDK 在自己的
  // node_modules 内（不串到仓库根）。
  test('resolves the always-latest SDK from the runner own node_modules', () => {
    const runnerPackage = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    expect(runnerPackage.dependencies['@anthropic-ai/claude-agent-sdk']).toBe(
      '*',
    );
    expect(fs.existsSync(path.join(runnerRoot, 'package-lock.json'))).toBe(
      false,
    );
    // 断言「SDK 来自 runner 自己的 node_modules」而不是仓库根的：比较
    // node_modules 目录的真实路径，而非 runnerRoot 前缀 —— 该目录可能是指向
    // 别处的符号链接（如 git worktree 共用主仓库的依赖），此时前缀比较会误报。
    const runnerModulesReal = fs.realpathSync(
      path.join(runnerRoot, 'node_modules'),
    );
    expect(
      runnerSdkEntry.startsWith(`${runnerModulesReal}${path.sep}`),
    ).toBe(true);
    // 解析到的版本必须是具体版本号（"*" 已被 npm 解析成实际安装的那个）
    const sdkPkg = JSON.parse(
      fs.readFileSync(
        path.join(
          runnerModulesReal,
          '@anthropic-ai',
          'claude-agent-sdk',
          'package.json',
        ),
        'utf8',
      ),
    ) as { version: string };
    expect(sdkPkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('main-Agent runtime exposes the complete tool set and Agent Builder', () => {
    const names = toolNames(true);
    expect(names).toEqual(
      expect.arrayContaining([
        'schedule_task',
        'install_skill',
        'memory_append',
        'agent_profile_list',
        'agent_profile_get',
        'agent_profile_draft_get',
        'agent_capability_catalog',
        'agent_profile_prepare',
        'agent_profile_publish',
        'agent_profile_discard',
      ]),
    );
  });

  test('main Agent exposes Agent Builder in every workspace', () => {
    const names = toolNames(false, { agentBuilderEnabled: true });
    expect(names).toContain('agent_profile_prepare');
    expect(names).toContain('agent_profile_publish');
  });

  test('custom Agent runtime keeps ordinary tools but does not advertise Agent Builder', () => {
    const names = toolNames(false, { agentBuilderEnabled: false });
    expect(names).toContain('schedule_task');
    expect(names).not.toContain('install_skill');
    expect(names).not.toContain('agent_profile_prepare');
  });

  test('home tool registration stays stable across scheduled and human turns', () => {
    expect(toolNames(true, { isScheduledTask: true })).toContain(
      'agent_profile_prepare',
    );
    expect(
      toolNames(true, { currentTaskId: 'scheduled-group-task' }),
    ).toContain('agent_profile_publish');
  });

  test('real Claude CLI initializes unrestricted builtins and Agent Builder tools', async () => {
    const tools = createMcpTools({
      chatJid: 'web:tool-init-real',
      groupFolder: 'tool-init-real',
      isHome: true,
      isAdminHome: true,
      agentBuilderEnabled: true,
      isScheduledTask: false,
      currentTaskId: null,
      currentInputTurnId: 'turn-real',
      workspaceIpc: path.join(cwd, 'ipc'),
      workspaceGroup: cwd,
      workspaceGlobal: path.join(cwd, 'global'),
      workspaceMemory: path.join(cwd, 'memory'),
    });
    const server = runnerSdk.createSdkMcpServer({
      name: 'happyclaw',
      version: 'test',
      tools,
    });
    const stream = runnerSdk.query({
      prompt: 'Reply with OK.',
      options: {
        pathToClaudeCodeExecutable: runnerClaudeExecutable,
        cwd,
        model: 'claude-sonnet-4-5-20250929',
        env: {
          ...cleanEnv(),
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'happyclaw-init-test',
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        allowedTools: ['Bash', 'Write', 'Edit', 'Task', 'mcp__happyclaw__*'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { happyclaw: server },
      },
    });

    let initializedTools: string[] | undefined;
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        initializedTools = message.tools;
        break;
      }
    }
    expect(initializedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'Task',
        'mcp__happyclaw__agent_profile_prepare',
        'mcp__happyclaw__agent_profile_publish',
      ]),
    );
  }, 20_000);
});
