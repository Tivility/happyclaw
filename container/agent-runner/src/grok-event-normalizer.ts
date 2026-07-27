/**
 * GrokEventNormalizer —— Grok 自家 CLI（`grok agent stdio`，ACP / JSON-RPC 2.0）NDJSON 事件归一化器。
 *
 * 把 grok 的 ACP `session/update` 通知 + `session/prompt` 响应映射成 fork 的 StreamEvent。
 * 字段映射依据 grok 0.2.67 真机抓包（P0 spike）+ ACP schema：
 *   - agent_message_chunk → text_delta（content.text 增量，不 diff）
 *   - agent_thought_chunk → thinking_delta
 *   - tool_call / tool_call_update → tool_use_start / tool_use_end / tool_progress
 *     （grok 把 MCP/间接工具包成 use_tool：真实工具在 rawInput.tool_name，须解包）
 *   - plan → todo_update
 *   - 完成事件在 session/prompt 响应 result._meta：inputTokens/outputTokens/cachedReadTokens/reasoningTokens
 *     （reasoning 已含 output 不另加；cachedRead ⊂ input；订阅制 costUSD=0）
 *
 * 与 CodexEventNormalizer 同构（class + emit(ContainerOutput) 契约），便于 runOneTurnRuntime 共用。
 */
import type { RuntimeEmit } from './runtime-adapter.js';

interface GrokToolState {
  toolName: string;
  title: string;
  status: string;
}

export interface GrokEventNormalizerState {
  currentMessageId: string | null;
  currentSegmentText: string;
  toolCalls: Map<string, GrokToolState>;
  emittedUsage: boolean;
}

type PlanStatus = 'pending' | 'in_progress' | 'completed';

// ── 工具函数 ──────────────────────────────────────────────────────────
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** ACP ToolCallContent 文本提取：兼容 [{type:'content',content:{type:'text',text}}] / {type:'text',text} / 字符串 */
function contentBlocksToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const arr = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of arr) {
    const b = asRecord(block);
    if (!b) {
      if (typeof block === 'string') parts.push(block);
      continue;
    }
    const inner = asRecord(b.content);
    if (inner && typeof inner.text === 'string') {
      parts.push(inner.text);
      continue;
    }
    if (typeof b.text === 'string') {
      parts.push(b.text);
      continue;
    }
  }
  return parts.join('');
}

function normalizePlanStatus(s: unknown): PlanStatus {
  const st = String(s ?? '').toLowerCase();
  if (st === 'running') return 'in_progress';
  if (st === 'in_progress' || st === 'completed') return st;
  return 'pending';
}

/**
 * grok 把 MCP / 间接工具调用包成 use_tool：真实工具名在 rawInput.tool_name，真实参数在 tool_input。
 * 命名空间工具（{server}__{tool}）的 rawInput 同样带 tool_name。原生工具（run_terminal_command 等）无 tool_name。
 * 返回 { toolName, toolInput } —— 解包后的真实工具名与参数。
 */
function unwrapTool(
  update: Record<string, unknown>,
  metaUpdateParams: Record<string, unknown> | null,
): { toolName: string; toolInput: unknown } {
  const rawInput = asRecord(update.rawInput);
  const unwrappedName =
    rawInput && typeof rawInput.tool_name === 'string' ? rawInput.tool_name : null;
  if (unwrappedName) {
    return { toolName: unwrappedName, toolInput: rawInput?.tool_input ?? {} };
  }
  const toolName = String(
    update.kind || update.title || metaUpdateParams?.kind || 'tool',
  );
  return { toolName, toolInput: update.rawInput ?? {} };
}

function emitUsage(
  src: Record<string, unknown>,
  emit: RuntimeEmit,
  startedAt: number,
): void {
  const num = (v: unknown): number => Number(v ?? 0) || 0;
  emit({
    status: 'stream',
    result: null,
    streamEvent: {
      eventType: 'usage',
      usage: {
        // grok inputTokens 为全量（含 cachedRead，OpenAI 口径）；reasoning 已含 output，不另加
        inputTokens: num(src.inputTokens),
        outputTokens: num(src.outputTokens),
        cacheReadInputTokens: num(src.cachedReadTokens),
        // xAI 口径：outputTokens 已含 reasoning，不另计（CLAUDE.md §8.14）
        reasoningTokens: 0,
        cacheCreationInputTokens: 0, // grok 无此概念
        costUSD: 0, // 订阅制无 per-token 价 → 上层标 cost_status='unavailable'
        durationMs: Date.now() - startedAt,
        numTurns: 1,
      },
    },
  });
}

// ── 核心：emitGrokEvent ───────────────────────────────────────────────
export function emitGrokEvent(
  event: Record<string, unknown>,
  emit: RuntimeEmit,
  startedAt: number,
  state: GrokEventNormalizerState,
): { usage?: boolean; sessionId?: string } {
  const result = asRecord(event.result);

  // 分支 A：session/prompt JSON-RPC 响应（result.stopReason）= turn 完成 + 用量真身
  if (result && result.stopReason !== undefined) {
    const src = asRecord(result._meta) ?? asRecord(result.usage) ?? {};
    if (!state.emittedUsage) {
      emitUsage(src, emit, startedAt);
      state.emittedUsage = true;
    }
    const stop = String(result.stopReason || '').toLowerCase();
    if (stop === 'tool_use') return {}; // 本 turn 未结束（runner 不在此模型下触发）
    if (stop === 'error' || stop === 'cancelled' || stop === 'refusal') {
      emit({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'status', statusText: `Grok 结束：${stop}` },
      });
    }
    return { usage: true };
  }

  // 分支 B：session/new 响应（result.sessionId 无 stopReason）= 提取 sessionId
  if (
    result &&
    typeof result.sessionId === 'string' &&
    result.stopReason === undefined
  ) {
    return { sessionId: result.sessionId };
  }

  // 分支 C：notification —— session/update 与 _x.ai/session_notification 两种 method 都携带 update
  const method = String(event.method || '');
  if (method !== 'session/update' && !method.endsWith('x.ai/session_notification')) {
    return {};
  }
  const params = asRecord(event.params);
  const u = asRecord(params?.update);
  if (!u) return {};
  const v = String(u.sessionUpdate || '');
  // 实测：tool_call 的 kind/status 不在 update 顶层，而在 params._meta.updateParams（PascalCase）
  const metaUpdateParams = asRecord(asRecord(params?._meta)?.updateParams);

  switch (v) {
    case 'agent_message_chunk': {
      const mid = u.messageId ? String(u.messageId) : null;
      if (
        mid &&
        state.currentMessageId &&
        mid !== state.currentMessageId &&
        state.currentSegmentText
      ) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'assistant_text_boundary',
            segmentText: state.currentSegmentText,
          },
        });
        state.currentSegmentText = '';
      }
      if (mid) state.currentMessageId = mid;
      const content = asRecord(u.content);
      const text = String(content?.text ?? '');
      state.currentSegmentText += text;
      emit({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'text_delta', text },
      });
      return {};
    }

    case 'agent_thought_chunk': {
      const content = asRecord(u.content);
      emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'thinking_delta',
          text: String(content?.text ?? ''),
        },
      });
      return {};
    }

    case 'tool_call': {
      const id = String(u.toolCallId);
      const { toolName, toolInput } = unwrapTool(u, metaUpdateParams);
      state.toolCalls.set(id, {
        toolName,
        title: String(u.title || ''),
        status: String(
          u.status || metaUpdateParams?.status || 'pending',
        ).toLowerCase(),
      });
      emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_start',
          toolUseId: id,
          toolName,
          toolInputSummary: truncate(JSON.stringify(toolInput ?? {})),
        },
      });
      return {};
    }

    case 'tool_call_update': {
      const id = String(u.toolCallId);
      const entry = state.toolCalls.get(id);
      const toolName = entry?.toolName ?? 'tool';
      // status 有时在 update 顶层（in_progress/completed），有时只在 _meta.updateParams（Pascal）
      let st = String(u.status || metaUpdateParams?.status || '').toLowerCase();
      if (st === 'running') st = 'in_progress';
      if (entry && st) entry.status = st;
      if (st === 'completed' || st === 'failed') {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: id,
            toolName,
            toolResult: contentBlocksToText(u.content),
          },
        });
        state.toolCalls.delete(id);
      } else {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_progress',
            toolUseId: id,
            toolInputSummary: truncate(contentBlocksToText(u.content)),
          },
        });
      }
      return {};
    }

    case 'tool_call_delta_chunk': {
      const content = asRecord(u.content);
      emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_progress',
          toolUseId: String(u.toolCallId),
          toolInputSummary: String(content?.text ?? ''),
        },
      });
      return {};
    }

    case 'plan':
    case 'plan_update': {
      const entries = Array.isArray(u.entries) ? u.entries : [];
      emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'todo_update',
          todos: entries.map((e: unknown, i: number) => {
            const er = asRecord(e) ?? {};
            return {
              id: String(er.id ?? i),
              content: String(er.content ?? ''),
              status: normalizePlanStatus(er.status),
            };
          }),
        },
      });
      return {};
    }

    case 'usage_update':
      // 上下文水位，绝不落库（用量真身在 session/prompt 响应 _meta）
      return {};

    case 'available_commands_update':
    case 'current_mode_update':
    case 'session_info_update':
      emit({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'status', statusText: `Grok: ${v}` },
      });
      return {};

    default:
      return {};
  }
}

// ── 包装类（对标 CodexEventNormalizer）──────────────────────────────────
export class GrokEventNormalizer {
  private readonly state: GrokEventNormalizerState = {
    currentMessageId: null,
    currentSegmentText: '',
    toolCalls: new Map(),
    emittedUsage: false,
  };

  constructor(
    private readonly emit: RuntimeEmit,
    private readonly startedAt: number,
  ) {}

  handle(event: Record<string, unknown>): { usage?: boolean; sessionId?: string } {
    return emitGrokEvent(event, this.emit, this.startedAt, this.state);
  }

  /** close 兜底：全程未 emit usage 则补全 0 usage（对标 codex close 兜底）。 */
  finalize(): void {
    if (!this.state.emittedUsage) {
      emitUsage({}, this.emit, this.startedAt);
      this.state.emittedUsage = true;
    }
  }

  get emittedUsage(): boolean {
    return this.state.emittedUsage;
  }
  get pendingToolCount(): number {
    return this.state.toolCalls.size;
  }
  /** 当前累积的 assistant 文本（供 runner 兜底 result 用）。 */
  get currentSegmentText(): string {
    return this.state.currentSegmentText;
  }
}
