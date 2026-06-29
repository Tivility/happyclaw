/**
 * grokCliAdapter —— 通过 ACP（Agent Client Protocol，JSON-RPC over stdio）驱动
 * Grok 自家 CLI（`grok agent stdio`）。
 *
 * 设计与 codexCliAdapter 同构：**一次 run() = 一个 ACP turn**（NOT 多 turn 循环）。
 * 多 turn 交给 host：本 run() 返回 newSessionId → host setSession → 下条消息
 * drain + re-spawn 带 input.sessionId → session/load(resume)。绝不在 run() 内
 * 等待下一条 IPC 消息（会与 host drain 抢消息死锁）。
 *
 * 流程：spawn grok agent stdio → initialize → session/new（或 session/load resume）
 *   → session/prompt（一次）→ 消费 session/update notification（经 GrokEventNormalizer）
 *   → prompt response（stopReason + _meta）→ 关进程 return。
 *
 * Client 契约（固化，勿改）：clientCapabilities.fs/terminal=false → grok 不会
 * 反向请求 fs/terminal，配合 --always-approve（yolo）permission 也不来；故 Client
 * 只实现 sessionUpdate（→ normalizer）+ requestPermission（兜底返回 allow）。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable, Writable } from 'stream';
import { fileURLToPath } from 'url';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

import { GrokEventNormalizer } from './grok-event-normalizer.js';
import type {
  AgentRuntimeAdapter,
  RuntimeEmit,
  RuntimeRunInput,
  RuntimeRunResult,
} from './runtime-adapter.js';
import {
  classifyRuntimeError,
  runtimeErrorMessage,
} from './runtime-adapter.js';
import { writeMcpContext } from './codex-cli-runner.js';

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

export function findGrokCli(): string {
  return process.env.HAPPYCLAW_GROK_CLI_PATH || 'grok';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 读取 settings.json 风格的 mcpServers map（{name: {command,args,env,...}}）。
 * 与 codex-cli-runner 的 loadUserMcpServers/loadWorkspaceMcpServers 等价语义，
 * 但输出 ACP McpServer[]（仅支持 stdio 形态；http/sse 用户 server 暂跳过）。
 */
function readMcpServersFromSettingsFile(
  settingsFile: string,
): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(settingsFile)) return {};
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      return settings.mcpServers as Record<string, Record<string, unknown>>;
    }
  } catch {
    // 用户 MCP 配置损坏不应阻断 happyclaw 核心 MCP 桥。
  }
  return {};
}

function loadExternalMcpServers(
  cwd: string,
): Record<string, Record<string, unknown>> {
  const envJson = process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON;
  let userServers: Record<string, Record<string, unknown>> = {};
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (parsed && typeof parsed === 'object') {
        userServers = parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // 退回 settings.json。
    }
  }
  if (Object.keys(userServers).length === 0) {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(process.env.HOME || '/home/node', '.claude');
    userServers = readMcpServersFromSettingsFile(
      path.join(configDir, 'settings.json'),
    );
  }
  const workspaceServers = readMcpServersFromSettingsFile(
    path.join(cwd, '.claude', 'settings.json'),
  );
  return { ...userServers, ...workspaceServers };
}

function envMapToAcpEnv(
  env: unknown,
): Array<{ name: string; value: string }> {
  const rec = asRecord(env);
  if (!rec) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(rec)) {
    if (typeof value === 'string') out.push({ name, value });
  }
  return out;
}

/**
 * 构造 ACP session/new 的 mcpServers 数组：happyclaw（first-class，经 context 文件
 * 传 IPC 路径）+ merge 用户/工作区自配 stdio MCP server。name==='happyclaw' 去重。
 */
export function buildAcpMcpServers(
  contextPath: string,
  cwd: string,
): McpServer[] {
  const servers: McpServer[] = [];
  const external = loadExternalMcpServers(cwd);
  for (const [name, config] of Object.entries(external)) {
    if (!config || typeof config !== 'object') continue;
    if (name === 'happyclaw') continue;
    // 仅支持 stdio 形态的用户 server（command + args）。
    if (typeof config.command !== 'string') continue;
    servers.push({
      name,
      command: config.command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: envMapToAcpEnv(config.env),
    });
  }

  const serverPath = path.join(DIST_DIR, 'happyclaw-mcp-server.js');
  servers.push({
    name: 'happyclaw',
    command: 'node',
    args: [serverPath, contextPath],
    env: [],
  });
  return servers;
}

export const grokCliAdapter: AgentRuntimeAdapter = {
  runtime: 'grok',
  supportsNativeResume: true,
  // 关键：单 turn re-spawn 模型，与 host drain 一致；勿声明 live input。
  supportsLiveInput: false,
  supportsPreCompactHook: false,
  canNativeResume(sessionId) {
    return !!sessionId?.trim();
  },
  classifyError: classifyRuntimeError,
  async run(
    input: RuntimeRunInput,
    emit: RuntimeEmit,
  ): Promise<RuntimeRunResult> {
    const cli = findGrokCli();
    const contextPath = writeMcpContext(input);
    const mcpServers = buildAcpMcpServers(contextPath, input.cwd);
    const model = input.model || input.input.selectedModel || 'grok-build';
    const startedAt = Date.now();
    const normalizer = new GrokEventNormalizer(emit, startedAt);

    emit({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'status', statusText: 'Grok 正在处理...' },
    });

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(
        cli,
        [
          'agent',
          '--model',
          model,
          '--always-approve',
          'stdio',
        ],
        {
          cwd: input.cwd,
          // 关闭 grok 启动期 auto-update：`--no-auto-update` 仅 headless(`grok -p`)
          // 子命令识别，`grok agent stdio` 不认（会以 "unexpected argument" 退出）。
          // grok 二进制原生支持 env 开关 GROK_DISABLE_AUTOUPDATER=1。
          env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: input.signal,
        },
      );
    } catch (err) {
      const errorClass = classifyRuntimeError(err);
      return {
        status: errorClass === 'cancelled' ? 'closed' : 'error',
        result: null,
        error:
          errorClass === 'cancelled'
            ? runtimeErrorMessage(err)
            : `Grok CLI 启动失败：${runtimeErrorMessage(err)}`,
        errorClass,
        newSessionId: input.sessionId,
      };
    }

    const rawStderr: string[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      rawStderr.push(chunk.toString('utf-8'));
    });

    // grok 进程在 prompt response 返回前过早退出（如启动期 auth 失败）。
    let procExited = false;
    let procExitCode: number | null = null;
    const procDone = new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        procExited = true;
        procExitCode = code;
        resolve();
      });
      proc.on('error', () => {
        procExited = true;
        resolve();
      });
    });

    // 门控：session/load 恢复会话时 grok 会把整段历史当 session/update 重放回来。
    // 在本轮 session/prompt 发出之前收到的通知一律丢弃，只 emit 本轮真正的新内容，
    // 否则每次 resume 都会先把历史复读一遍（用户实测的"先复读再回复"）。
    let promptStarted = false;
    let suppressedNotifications = 0;
    // ACP Client：只实现单向通知 + permission 兜底。fs/terminal 不声明故无反向回调。
    const clientImpl: Client = {
      sessionUpdate: (params: SessionNotification): void => {
        if (!promptStarted) {
          suppressedNotifications++;
          return;
        }
        normalizer.handle({ method: 'session/update', params });
      },
      requestPermission: (
        params: RequestPermissionRequest,
      ): RequestPermissionResponse => {
        // --always-approve 下不应被调用；防御性返回 allow（选 allow_* 选项，
        // 否则第一个），避免 grok 因等待权限决策而挂起本 turn。
        const options = params.options || [];
        const allow =
          options.find(
            (o) => o.kind === 'allow_always' || o.kind === 'allow_once',
          ) || options[0];
        if (allow) {
          return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        }
        return { outcome: { outcome: 'cancelled' } };
      },
    };

    // ndJsonStream 需要 Web 流：用 Node→Web 适配 grok 进程 stdout/stdin。
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => clientImpl, stream);

    let sessionId = input.sessionId;
    const meta = { rules: input.systemPromptAppend };

    try {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'happyclaw', version: '1.0.0' },
      });

      if (sessionId && grokCliAdapter.canNativeResume?.(sessionId)) {
        await conn.loadSession({
          sessionId,
          cwd: input.cwd,
          additionalDirectories: input.additionalDirectories,
          mcpServers,
          _meta: meta,
        });
      } else {
        const created = await conn.newSession({
          cwd: input.cwd,
          additionalDirectories: input.additionalDirectories,
          mcpServers,
          _meta: meta,
        });
        sessionId = created.sessionId;
      }

      // 用 <user-message> 框住本轮用户输入（对标 codex buildPrompt）。
      // soft_inject(模型切换)时 input.prompt 内含 <system_context>历史transcript</system_context>+当前消息；
      // 不加这层框，grok 会把注入的历史当多轮逐条回复（"先复读之前对话再回复"）。
      // systemPromptAppend 不在此拼接——它走 session/new 的 _meta.rules。
      const userMessageText = `<user-message>\n${input.prompt}\n</user-message>`;
      const promptBlocks = [
        { type: 'text' as const, text: userMessageText },
        ...(input.images || []).map((img) => ({
          type: 'image' as const,
          data: img.data,
          mimeType: img.mimeType || 'image/png',
        })),
      ];

      // 从此刻起放行通知：之前(initialize / session/load 重放)的全部已丢弃。
      promptStarted = true;
      if (suppressedNotifications > 0) {
        process.stderr.write(
          `[grok-cli-runner] suppressed ${suppressedNotifications} pre-prompt session/update (session/load 重放历史)\n`,
        );
      }
      const resp = await conn.prompt({
        sessionId: sessionId!,
        prompt: promptBlocks,
      });

      // 把 prompt response 喂给 normalizer（分支 A：result.stopReason → usage + 完成）。
      normalizer.handle({ result: resp as unknown as Record<string, unknown> });
      const newSessionId =
        (asRecord(resp?._meta)?.sessionId as string | undefined) ?? sessionId;

      normalizer.finalize();
      if (!procExited) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // 进程可能已退出。
        }
      }

      const result = normalizer.currentSegmentText.trim() || null;
      return { status: 'success', result, newSessionId };
    } catch (err) {
      // initialize / session / prompt 阶段异常。等进程收尾以读取 stderr。
      if (!procExited) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await Promise.race([
        procDone,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      normalizer.finalize();

      if (input.signal?.aborted) {
        return {
          status: 'closed',
          result: null,
          error: 'Grok ACP run cancelled',
          errorClass: 'cancelled',
          newSessionId: sessionId,
        };
      }
      const stderr = rawStderr.join('').trim();
      const errorText = runtimeErrorMessage(err);
      const errorClass = classifyRuntimeError(stderr || errorText);
      if (errorClass === 'cancelled') {
        return {
          status: 'closed',
          result: null,
          error: errorText,
          errorClass,
          newSessionId: sessionId,
        };
      }
      return {
        status: 'error',
        result: null,
        error:
          stderr ||
          (procExited && procExitCode !== 0
            ? `Grok CLI exited with code ${procExitCode}: ${errorText}`
            : `Grok ACP 失败：${errorText}`),
        errorClass,
        newSessionId: sessionId,
      };
    }
  },
};
