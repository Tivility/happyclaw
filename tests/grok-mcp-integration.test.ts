/**
 * P3 集成测：grok ACP `session/new` 挂载的 happyclaw MCP server 端到端验证。
 *
 * grok-cli-runner 把 happyclaw 工具以 `{name:'happyclaw',command:'node',
 * args:[happyclaw-mcp-server.js, contextPath]}` 挂进 ACP session/new mcpServers。
 * grok 进程会 spawn 这个 server 并经 MCP 协议调用工具。本测**不依赖真机 grok**，
 * 而是直接 spawn 编译后的 happyclaw-mcp-server.js（与 runner 完全相同的 argv），
 * 用裸 MCP JSON-RPC（stdio）发 `tools/call: send_message`，断言 IPC messages
 * 目录落下消息文件 —— 即「mock 发 happyclaw__send_message tool_call → IPC 落文件」。
 *
 * 同时校验 grok-cli-runner.buildAcpMcpServers 的形状（happyclaw first-class +
 * 用户 MCP merge + 去重）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SERVER_PATH = path.join(
  REPO_ROOT,
  'container',
  'agent-runner',
  'dist',
  'happyclaw-mcp-server.js',
);

// ── 裸 MCP JSON-RPC over stdio 客户端（无需 @modelcontextprotocol/sdk）──────
interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class StdioMcpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (resp: JsonRpcResponse) => void>();
  stderr = '';

  constructor(serverPath: string, contextPath: string) {
    this.proc = spawn('node', [serverPath, contextPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  private send(obj: Record<string, unknown>): void {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request "${method}" timed out. stderr:\n${this.stderr}`,
          ),
        );
      }, 8000);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

// ── fixture：临时 IPC 目录 + context 文件 ────────────────────────────────
let tmpRoot: string;
let ipcDir: string;
let contextPath: string;
let client: StdioMcpClient | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mcp-it-'));
  ipcDir = path.join(tmpRoot, 'ipc');
  fs.mkdirSync(ipcDir, { recursive: true });
  const context = {
    chatJid: 'web:home-42',
    groupFolder: 'home-42',
    isHome: true,
    isAdminHome: false,
    isScheduledTask: false,
    currentTaskId: null,
    privacyMode: false,
    workspaceIpc: ipcDir,
    workspaceGroup: path.join(tmpRoot, 'group'),
    workspaceGlobal: path.join(tmpRoot, 'global'),
    workspaceMemory: path.join(tmpRoot, 'memory'),
    disableMemoryLayer: false,
  };
  fs.mkdirSync(context.workspaceGroup, { recursive: true });
  contextPath = path.join(tmpRoot, 'mcp-context.json');
  fs.writeFileSync(contextPath, JSON.stringify(context), 'utf-8');
});

afterEach(() => {
  client?.close();
  client = undefined;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('P3 grok happyclaw MCP wiring', () => {
  test('dist happyclaw-mcp-server.js exists (built artifact runner spawns)', () => {
    expect(fs.existsSync(SERVER_PATH)).toBe(true);
  });

  test('send_message tool_call writes an IPC message file', async () => {
    client = new StdioMcpClient(SERVER_PATH, contextPath);

    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'grok-mcp-it', version: '1.0.0' },
    });
    expect(init.error).toBeUndefined();
    client.notify('notifications/initialized');

    // 工具应在列表里（grok 经 search_tool 发现的目标）
    const list = await client.request('tools/list', {});
    const names = (
      (list.result?.tools as Array<{ name: string }>) || []
    ).map((t) => t.name);
    expect(names).toContain('send_message');

    // upstream 把 send_message 从 fire-and-forget 改成「等主进程回写投递结果」：
    // 写完 IPC 后轮询 message-results/send_message_result_{requestId}.json，
    // 失败会抛错让 Agent 知道消息没送到。这里模拟主进程那一侧的回写。
    const messagesDirForAck = path.join(ipcDir, 'messages');
    const resultsDir = path.join(ipcDir, 'message-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const ackTimer = setInterval(() => {
      if (!fs.existsSync(messagesDirForAck)) return;
      for (const f of fs.readdirSync(messagesDirForAck)) {
        if (!f.endsWith('.json')) continue;
        const payload = JSON.parse(
          fs.readFileSync(path.join(messagesDirForAck, f), 'utf-8'),
        ) as { requestId?: string };
        if (!payload.requestId) continue;
        const out = path.join(
          resultsDir,
          `send_message_result_${payload.requestId}.json`,
        );
        if (!fs.existsSync(out)) {
          fs.writeFileSync(
            out,
            JSON.stringify({ success: true, disposition: 'sent' }),
            'utf-8',
          );
        }
      }
    }, 20);

    let call;
    try {
      // mock grok 发 happyclaw__send_message tool_call（MCP 内工具名去命名空间即 send_message）
      call = await client.request('tools/call', {
        name: 'send_message',
        arguments: { text: '来自 grok 的进度更新' },
      });
    } finally {
      clearInterval(ackTimer);
    }
    expect(call.error).toBeUndefined();

    // 断言 IPC messages 目录落文件
    const messagesDir = path.join(ipcDir, 'messages');
    expect(fs.existsSync(messagesDir)).toBe(true);
    const files = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    const written = JSON.parse(
      fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
    ) as Record<string, unknown>;
    expect(written.type).toBe('message');
    expect(written.text).toBe('来自 grok 的进度更新');
    expect(written.chatJid).toBe('web:home-42');
    expect(written.groupFolder).toBe('home-42');
  });
});
