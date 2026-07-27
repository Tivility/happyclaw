/**
 * GrokEventNormalizer 单测：格式 / 用量 / 结构 / 工具解包。
 *
 * 合成 NDJSON + grok 0.2.67 真机抓包驱动 normalizer，断言映射到 fork StreamEvent 正确。
 * 真机 Grok 需订阅账号，本测用 schema-accurate 样本 + P0 实采样本验证解析结构。
 */
import { describe, expect, test } from 'vitest';
import { GrokEventNormalizer } from '../container/agent-runner/src/grok-event-normalizer.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';

type SE = NonNullable<ContainerOutput['streamEvent']>;

function run(lines: string[]): {
  events: SE[];
  returns: Array<{ usage?: boolean; sessionId?: string }>;
  normalizer: GrokEventNormalizer;
} {
  const events: SE[] = [];
  const emit = (out: ContainerOutput): void => {
    if (out.streamEvent) events.push(out.streamEvent);
  };
  const normalizer = new GrokEventNormalizer(emit, 0);
  const returns = lines.map((line) =>
    normalizer.handle(JSON.parse(line) as Record<string, unknown>),
  );
  return { events, returns, normalizer };
}

// 合成 NDJSON（§5 的 11 行样本）
const FIX = [
  `{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_01"}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"先读文件再判断..."}}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"tool_call","toolCallId":"call_abc","title":"read src/utils.py","kind":"read","status":"pending","rawInput":{"path":"src/utils.py"}}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_abc","status":"in_progress"}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_abc","status":"completed","content":[{"type":"content","content":{"type":"text","text":"def foo(): ..."}}]}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_a1","content":{"type":"text","text":"好的，我来"}}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_a1","content":{"type":"text","text":"处理。"}}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_a2","content":{"type":"text","text":"现在解释"}}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"plan","entries":[{"id":"p1","content":"读 utils","status":"completed"},{"id":"p2","content":"写测试","status":"in_progress"}]}}}`,
  `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01","update":{"sessionUpdate":"usage_update","used":17324,"size":2000000,"cost":null}}}`,
  `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{"totalTokens":17382,"inputTokens":17324,"outputTokens":58,"cachedReadTokens":128,"reasoningTokens":57,"modelId":"grok-build"}}}`,
];

describe('GrokEventNormalizer — 格式解析', () => {
  test('session/new response 提取 sessionId，不 emit streamEvent', () => {
    const { events, returns } = run([FIX[0]]);
    expect(returns[0]).toEqual({ sessionId: 'sess_01' });
    expect(events).toHaveLength(0);
  });

  test('agent_thought_chunk → thinking_delta', () => {
    const { events } = run([FIX[1]]);
    expect(events).toEqual([{ eventType: 'thinking_delta', text: '先读文件再判断...' }]);
  });

  test('agent_message_chunk → text_delta（INCREMENTAL 不 diff）', () => {
    const { events } = run([FIX[5], FIX[6]]);
    expect(events).toEqual([
      { eventType: 'text_delta', text: '好的，我来' },
      { eventType: 'text_delta', text: '处理。' },
    ]);
  });

  test('plan → todo_update（status 归一）', () => {
    const { events } = run([FIX[8]]);
    expect(events).toEqual([
      {
        eventType: 'todo_update',
        todos: [
          { id: 'p1', content: '读 utils', status: 'completed' },
          { id: 'p2', content: '写测试', status: 'in_progress' },
        ],
      },
    ]);
  });
});

describe('GrokEventNormalizer — tool_call 状态机', () => {
  test('tool_call → tool_use_start（rawInput 摘要）', () => {
    const { events } = run([FIX[2]]);
    expect(events).toEqual([
      {
        eventType: 'tool_use_start',
        toolUseId: 'call_abc',
        toolName: 'read',
        toolInputSummary: '{"path":"src/utils.py"}',
      },
    ]);
  });

  test('in_progress → tool_progress；completed → tool_use_end（toolName 回填 + 结果文本）', () => {
    const { events, normalizer } = run([FIX[2], FIX[3], FIX[4]]);
    expect(events[1]).toEqual({
      eventType: 'tool_progress',
      toolUseId: 'call_abc',
      toolInputSummary: '',
    });
    expect(events[2]).toEqual({
      eventType: 'tool_use_end',
      toolUseId: 'call_abc',
      toolName: 'read',
      toolResult: 'def foo(): ...',
    });
    expect(normalizer.pendingToolCount).toBe(0);
  });

  test('Pascal 大小写（Running/Completed）归一', () => {
    const start = `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"x","kind":"execute","status":"Pending","rawInput":{}}}}`;
    const running = `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"Running"}}}`;
    const done = `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"Completed","content":[{"type":"text","text":"ok"}]}}}`;
    const { events } = run([start, running, done]);
    expect(events[1].eventType).toBe('tool_progress');
    expect(events[2].eventType).toBe('tool_use_end');
    expect(events[2].toolResult).toBe('ok');
  });
});

describe('GrokEventNormalizer — use_tool / 间接层解包（P0 实测）', () => {
  test('use_tool → 解包出真实工具名(rawInput.tool_name)', () => {
    const line = `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"u1","title":"use_tool","rawInput":{"tool_name":"happyclaw__send_message","tool_input":{"text":"hi"}}}}}`;
    const { events } = run([line]);
    expect(events[0]).toMatchObject({
      eventType: 'tool_use_start',
      toolUseId: 'u1',
      toolName: 'happyclaw__send_message', // 解包，非 "use_tool"
    });
    expect(events[0].toolInputSummary).toContain('hi'); // 用 tool_input 而非外层
  });

  test('命名空间工具(variant UseTool) 同样取 tool_name', () => {
    const line = `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"u2","title":"probe__echo_probe","rawInput":{"variant":"UseTool","tool_name":"probe__echo_probe","tool_input":{}}}}}`;
    const { events } = run([line]);
    expect(events[0].toolName).toBe('probe__echo_probe');
  });

  test('原生工具(无 tool_name) 用 title/kind', () => {
    const line = `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"n1","title":"run_terminal_command","kind":"execute","rawInput":{"command":"ls"}}}}`;
    const { events } = run([line]);
    expect(events[0].toolName).toBe('execute'); // kind 优先
    expect(events[0].toolInputSummary).toContain('ls');
  });
});

describe('GrokEventNormalizer — message 边界', () => {
  test('messageId 切换先 emit assistant_text_boundary（上段累积）再 text_delta', () => {
    const { events } = run([FIX[5], FIX[6], FIX[7]]);
    expect(events).toEqual([
      { eventType: 'text_delta', text: '好的，我来' },
      { eventType: 'text_delta', text: '处理。' },
      { eventType: 'assistant_text_boundary', segmentText: '好的，我来处理。' },
      { eventType: 'text_delta', text: '现在解释' },
    ]);
  });
});

describe('GrokEventNormalizer — 用量解析', () => {
  test('完成事件 _meta → usage（4 token 映射，cacheCreation 0，costUSD 0）', () => {
    const { events, returns } = run([FIX[10]]);
    expect(returns[0]).toEqual({ usage: true });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('usage');
    expect(events[0].usage).toMatchObject({
      inputTokens: 17324,
      outputTokens: 58,
      cacheReadInputTokens: 128,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      numTurns: 1,
    });
  });

  test('usage_update 只发上下文水位 status，绝不 emit usage', () => {
    const { events } = run([FIX[9]]);
    // 水位接上后这里会有一条 status；关键不变量是「不产生 usage」——
    // 计费用量真身在 session/prompt 响应的 _meta，水位不能进用量管线。
    expect(events.map((e) => e.eventType)).toEqual(['status']);
    expect(events[0].statusText).toContain('上下文');
    expect(events.some((e) => e.eventType === 'usage')).toBe(false);
  });

  test('上下文水位按 10% 台阶去抖，同台阶不重复上报', () => {
    const line = (used: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_01',
          update: { sessionUpdate: 'usage_update', used, size: 1000 },
        },
      });
    // 12% → 15%（同台阶，吞）→ 27%（跨台阶，报）
    const { events } = run([line(120), line(150), line(270)]);
    expect(events.map((e) => e.statusText)).toEqual([
      '上下文 12%（120/1000）',
      '上下文 27%（270/1000）',
    ]);
  });

  test('size 为 0 或非数时不发水位（避免除零/NaN 文案）', () => {
    const bad = (u: unknown, sz: unknown) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_01',
          update: { sessionUpdate: 'usage_update', used: u, size: sz },
        },
      });
    expect(run([bad(10, 0)]).events).toHaveLength(0);
    expect(run([bad(10, null)]).events).toHaveLength(0);
    expect(run([bad('x', 100)]).events).toHaveLength(0);
  });
});

describe('GrokEventNormalizer — 端到端 + 兜底', () => {
  test('完整 11 行 fixture 产出有序 StreamEvent 序列', () => {
    const { events, normalizer } = run(FIX);
    expect(events.map((e) => e.eventType)).toEqual([
      'thinking_delta',
      'tool_use_start',
      'tool_progress',
      'tool_use_end',
      'text_delta',
      'text_delta',
      'assistant_text_boundary',
      'text_delta',
      'todo_update',
      // usage_update → 上下文水位 status（不进用量管线）
      'status',
      'usage',
    ]);
    expect(normalizer.emittedUsage).toBe(true);
    expect(normalizer.pendingToolCount).toBe(0);
  });

  test('usage 事件声明 xAI 口径：inputTokens 已含 cacheRead', () => {
    const { events } = run(FIX);
    const usage = events.find((e) => e.eventType === 'usage');
    // 少了这个标记，展示/聚合侧会把 cacheRead 再加一遍 → 总量虚高、
    // 卡片把同一批 token 同时算进 new 和 cached。
    expect(usage?.usage?.inputTokensIncludeCacheRead).toBe(true);
  });

  test('无完成事件时 finalize() 补全 0 usage', () => {
    const { normalizer } = run(FIX.slice(0, 10));
    expect(normalizer.emittedUsage).toBe(false);
    const collected: SE[] = [];
    const n2 = new GrokEventNormalizer(
      (o) => o.streamEvent && collected.push(o.streamEvent),
      0,
    );
    FIX.slice(0, 10).forEach((l) => n2.handle(JSON.parse(l)));
    n2.finalize();
    expect(collected.find((e) => e.eventType === 'usage')?.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  test('stopReason=error → emit status；usage 去重只一次', () => {
    const errDone = `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"error","_meta":{"inputTokens":5,"outputTokens":0,"cachedReadTokens":0}}}`;
    const { events } = run([errDone, errDone]);
    expect(events.filter((e) => e.eventType === 'usage')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'status')).toHaveLength(2);
    expect(events.find((e) => e.eventType === 'status')?.statusText).toContain('error');
  });
});

// ── grok 0.2.67 真机抓包（P0 spike，2026-06）──
describe('GrokEventNormalizer — 真实抓包数据', () => {
  const REAL = {
    msgChunk: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019f0b60","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"P"}},"_meta":{"totalTokens":20958}}}`,
    toolCall: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019f0b62","update":{"sessionUpdate":"tool_call","toolCallId":"call-1ead","title":"run_terminal_command","rawInput":{"command":"echo hello-grok-poc","timeout":30000}},"_meta":{"updateParams":{"toolCallId":"call-1ead","title":"run_terminal_command","kind":"Other","status":"Pending"}}}}`,
    toolDone: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019f0b62","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1ead","status":"completed","content":[{"type":"content","content":{"type":"text","text":"hello-grok-poc\\n"}}],"rawOutput":{"exit_code":0}},"_meta":{"updateParams":{"status":"Completed"}}}}`,
    turnCompleted: `{"jsonrpc":"2.0","method":"_x.ai/session_notification","params":{"sessionId":"019f0b62","update":{"sessionUpdate":"turn_completed","prompt_id":"b53e","stop_reason":"end_turn"}}}`,
    promptResponse: `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{"sessionId":"019f0b62","modelId":"grok-build","totalTokens":35406,"inputTokens":35243,"outputTokens":163,"cachedReadTokens":35072,"reasoningTokens":138}}}`,
  };

  test('真实 agent_message_chunk → text_delta', () => {
    expect(run([REAL.msgChunk]).events).toEqual([{ eventType: 'text_delta', text: 'P' }]);
  });

  test('真实 tool_call(kind/status 在 _meta.updateParams) → tool_use_start，toolName 取 title', () => {
    const { events } = run([REAL.toolCall]);
    expect(events[0]).toMatchObject({ eventType: 'tool_use_start', toolUseId: 'call-1ead', toolName: 'run_terminal_command' });
    expect(events[0].toolInputSummary).toContain('echo hello-grok-poc');
  });

  test('真实 tool_call_update completed → tool_use_end，结果取自嵌套 content', () => {
    const { events } = run([REAL.toolCall, REAL.toolDone]);
    const end = events.find((e) => e.eventType === 'tool_use_end');
    expect(end?.toolResult).toBe('hello-grok-poc\n');
  });

  test('真实 turn_completed(_x.ai/session_notification) 不 emit usage', () => {
    expect(run([REAL.turnCompleted]).events.filter((e) => e.eventType === 'usage')).toHaveLength(0);
  });

  test('真实 id:3 响应 → usage（reasoning 已含 output 不另加；cachedRead⊂input）', () => {
    const { events } = run([REAL.promptResponse]);
    expect(events[0].usage).toMatchObject({
      inputTokens: 35243,
      outputTokens: 163,
      cacheReadInputTokens: 35072,
      cacheCreationInputTokens: 0,
      costUSD: 0,
    });
    expect(35243 + 163).toBe(35406); // input+output==total，reasoning 不另加
  });
});
