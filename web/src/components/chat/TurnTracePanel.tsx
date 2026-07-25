import { useCallback, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

import { api } from '../../api/client';

/**
 * Execution trace for a completed turn.
 *
 * Live streaming already shows tool panels and sub-agent output, but that state
 * lives only in the browser tab that watched it happen — a refresh erased it and
 * reopening the conversation tomorrow showed the reply with no record that any
 * work went into it. `turn_events` persists that record; this panel is what
 * makes it visible again.
 *
 * Fetched on expand rather than with the message list: a conversation can carry
 * hundreds of turns and almost none of them get inspected, so loading every
 * trace up front would cost far more than it returns.
 */

interface TurnEventRow {
  id: number;
  seq: number;
  eventType: string;
  runtime?: string | null;
  toolName?: string | null;
  toolUseId?: string | null;
  summary?: string | null;
  title?: string | null;
  payloadJson?: string | null;
  payloadFile?: string | null;
  createdAt?: string;
}

interface Props {
  groupJid: string;
  turnId: string;
}

/** Event types that carry no standalone meaning in a replayed list. */
const HIDDEN_TYPES = new Set(['tool_progress', 'task_progress', 'init']);

const TYPE_LABEL: Record<string, string> = {
  tool_use_start: '调用',
  tool_use_end: '完成',
  tool_result: '结果',
  task_start: '子任务开始',
  task_updated: '子任务更新',
  task_notification: '子任务结束',
  sub_agent_result: '子 Agent 结论',
  todo_update: '任务清单',
  usage: '用量',
  permission_denied: '权限拒绝',
  hook_started: 'Hook',
  hook_response: 'Hook 返回',
  context_audit: '上下文',
  compact_boundary: '上下文压缩',
  memory_recall: '记忆回忆',
};

function describe(row: TurnEventRow): string {
  if (row.summary) return row.summary;
  if (row.title) return row.title;
  if (!row.payloadJson) return '';
  try {
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    // A sub-agent's conclusion is the single most useful line here, so prefer it
    // over the generic input/result summaries.
    const sub = payload.subAgentResult as
      | { summary?: string; description?: string }
      | undefined;
    if (sub?.summary || sub?.description) return sub.summary || sub.description || '';
    if (typeof payload.toolInputSummary === 'string') return payload.toolInputSummary;
    if (typeof payload.toolResultSummary === 'string') return payload.toolResultSummary;
    if (typeof payload.toolResult === 'string') return payload.toolResult.slice(0, 200);
    if (payload.toolInput) return JSON.stringify(payload.toolInput).slice(0, 200);
    return '';
  } catch {
    return '';
  }
}

export function TurnTracePanel({ groupJid, turnId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TurnEventRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || rows || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ events: TurnEventRow[] }>(
        `/api/groups/${encodeURIComponent(groupJid)}/turn-events?turnId=${encodeURIComponent(turnId)}`,
      );
      setRows(res.events ?? []);
    } catch {
      setError('轨迹加载失败');
    } finally {
      setLoading(false);
    }
  }, [open, rows, loading, groupJid, turnId]);

  const visible = rows?.filter((r) => !HIDDEN_TYPES.has(r.eventType)) ?? [];

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        执行轨迹
        {rows && <span className="text-slate-300">· {visible.length}</span>}
      </button>

      {open && (
        <div className="mt-1 pl-4 border-l border-slate-200 dark:border-slate-700 space-y-1">
          {loading && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 py-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              加载中
            </div>
          )}
          {error && <div className="text-[11px] text-rose-500 py-1">{error}</div>}
          {rows && !loading && visible.length === 0 && (
            // Distinguish "nothing was recorded" from "the panel is broken":
            // turns that predate turn_events legitimately have no trace.
            <div className="text-[11px] text-slate-400 py-1">
              这一轮没有记录到工具调用
            </div>
          )}
          {visible.map((row) => {
            const detail = describe(row);
            return (
              <div key={row.id} className="text-[11px] leading-relaxed">
                <span className="text-slate-400">
                  {TYPE_LABEL[row.eventType] ?? row.eventType}
                </span>
                {row.toolName && (
                  <span className="ml-1 font-mono text-slate-600 dark:text-slate-300">
                    {row.toolName}
                  </span>
                )}
                {detail && (
                  <span className="ml-1 text-slate-500 dark:text-slate-400 break-all">
                    {detail}
                  </span>
                )}
                {row.payloadFile && (
                  <span className="ml-1 text-slate-300" title={row.payloadFile}>
                    （完整内容已落盘）
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
