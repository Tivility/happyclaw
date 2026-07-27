import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMcpToolCatalog,
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const tmpDirs: string[] = [];

function makeContext(): McpContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mcp-catalog-'));
  tmpDirs.push(tmpDir);
  const workspaceIpc = path.join(tmpDir, 'ipc');
  const workspaceGroup = path.join(tmpDir, 'group');
  const workspaceGlobal = path.join(tmpDir, 'global');
  const workspaceMemory = path.join(tmpDir, 'memory');
  for (const dir of [
    workspaceIpc,
    workspaceGroup,
    workspaceGlobal,
    workspaceMemory,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    chatJid: 'web:mcp-catalog',
    groupFolder: 'mcp-catalog',
    isHome: true,
    isAdminHome: true,
    privacyMode: false,
    workspaceIpc,
    workspaceGroup,
    workspaceGlobal,
    workspaceMemory,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime-neutral MCP tool catalog', () => {
  it('is the single source for Claude SDK tools and Codex MCP tools', () => {
    const ctx = makeContext();
    const catalog = createMcpToolCatalog(ctx);
    const claudeTools = createMcpTools(ctx) as Array<{ name: string }>;

    expect(catalog.map((tool) => tool.name)).toEqual(
      claudeTools.map((tool) => tool.name),
    );
    expect(catalog.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'send_message',
        'send_image',
        'send_file',
        'schedule_task',
        'list_tasks',
        'install_skill',
        'memory_append',
        'memory_search',
        'memory_get',
      ]),
    );
  });

  it('executes side-effect tools through the neutral handler', async () => {
    const ctx = makeContext();
    const sendMessage = createMcpToolCatalog(ctx).find(
      (tool) => tool.name === 'send_message',
    );
    expect(sendMessage).toBeTruthy();

    // send_message 不再是 fire-and-forget：写完 IPC 后会等主进程回写
    // message-results/send_message_result_{requestId}.json，失败要抛错让
    // Agent 知道消息没送到。这里模拟主进程那一侧。
    const messagesDir = path.join(ctx.workspaceIpc, 'messages');
    const resultsDir = path.join(ctx.workspaceIpc, 'message-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const ackTimer = setInterval(() => {
      if (!fs.existsSync(messagesDir)) return;
      for (const file of fs.readdirSync(messagesDir)) {
        if (!file.endsWith('.json')) continue;
        const { requestId } = JSON.parse(
          fs.readFileSync(path.join(messagesDir, file), 'utf-8'),
        ) as { requestId?: string };
        if (!requestId) continue;
        const out = path.join(
          resultsDir,
          `send_message_result_${requestId}.json`,
        );
        if (!fs.existsSync(out)) {
          fs.writeFileSync(
            out,
            JSON.stringify({ success: true, disposition: 'delivered_separately' }),
            'utf-8',
          );
        }
      }
    }, 20);
    let result;
    try {
      result = await sendMessage!.handler({ text: 'hello from catalog' });
    } finally {
      clearInterval(ackTimer);
    }
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Message sent separately.' }],
    });

    const messageDir = path.join(ctx.workspaceIpc, 'messages');
    const files = fs
      .readdirSync(messageDir)
      .filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(
      fs.readFileSync(path.join(messageDir, files[0]), 'utf-8'),
    );
    expect(payload).toMatchObject({
      chatJid: 'web:mcp-catalog',
      groupFolder: 'mcp-catalog',
      type: 'message',
      text: 'hello from catalog',
    });
  });
});
