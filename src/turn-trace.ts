import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { insertTurnEvent } from './db.js';
import { logger } from './logger.js';
import type { StreamEvent } from './types.js';

/**
 * Persistence for the turn execution trace.
 *
 * StreamEvents were broadcast over WebSocket and then discarded. The final
 * reply text lands in `messages`, but the *work* — which tools ran, what the
 * sub-agents concluded, what the model was reasoning about — existed only in
 * whichever browser tab happened to be watching. Refresh the page and it was
 * gone; open the conversation tomorrow and there was no record that the agent
 * had done anything at all.
 *
 * This module decides what is worth keeping and writes it to `turn_events`.
 */

/**
 * Events that describe the shape of a turn.
 *
 * `text_delta` and `thinking_delta` are deliberately absent: they arrive
 * hundreds of times per turn, and their accumulation already becomes the
 * message body (text) or the thinking payload attached to a completed block.
 * Persisting them would multiply row count by ~100x for content we already
 * store elsewhere.
 */
const PERSISTED_EVENT_TYPES = new Set([
  'tool_use_start',
  'tool_use_end',
  // The tool's actual output. Without it the trace records only that a tool
  // ran, not what it returned — a panel showing "Read" with no content.
  'tool_result',
  'tool_progress',
  'task_start',
  'task_progress',
  'task_updated',
  'task_notification',
  // A sub-agent's conclusion — the single most valuable thing here. Losing it
  // is what made a delegated research turn unreconstructable after refresh.
  'sub_agent_result',
  'todo_update',
  'usage',
  'permission_denied',
  'hook_started',
  'hook_response',
  'context_audit',
  // Marks where the context was compacted, so a reader can tell a gap in the
  // trace from a gap in the work.
  'compact_boundary',
  'memory_recall',
  'init',
]);

/**
 * Inline payloads up to this size; spill anything larger to a file.
 * 8 KB keeps the common tool call (a path, a short command, a small diff)
 * queryable in SQL while stopping a single 2 MB file read from bloating the DB.
 */
const INLINE_PAYLOAD_LIMIT = 8 * 1024;

/** Per-chat monotonic sequence, so events inside one turn keep their order. */
const seqByChat = new Map<string, number>();

function nextSeq(chatJid: string): number {
  const next = (seqByChat.get(chatJid) ?? 0) + 1;
  seqByChat.set(chatJid, next);
  return next;
}

/** Reset ordering for a conversation (session reset / workspace delete). */
export function resetTurnTraceSeq(chatJid: string): void {
  seqByChat.delete(chatJid);
}

/**
 * The parts of a StreamEvent worth replaying. Everything the UI needs to
 * rebuild a tool-call or sub-agent panel, and nothing that only mattered live.
 */
function buildPayload(event: StreamEvent): Record<string, unknown> {
  const e = event as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const key of [
    'toolInput',
    'toolInputSummary',
    'toolResult',
    'toolResultSummary',
    // The sub-agent's own description/summary/text, carried as a nested object.
    'subAgentResult',
    'segmentText',
    'taskDescription',
    'taskSummary',
    'taskPatch',
    'subagentType',
    'todos',
    'usage',
    'detail',
    'text',
    'parentToolUseId',
    'displayLevel',
    'statusText',
    'permissionDenied',
    'contextAudit',
  ]) {
    if (e[key] !== undefined && e[key] !== null) payload[key] = e[key];
  }
  return payload;
}

function spillPayload(
  groupFolder: string,
  chatJid: string,
  seq: number,
  serialized: string,
): string | null {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(GROUPS_DIR, groupFolder, 'traces', day);
    fs.mkdirSync(dir, { recursive: true });
    // chatJid can contain ':' and '/', neither of which is safe in a filename.
    const safeChat = chatJid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    const file = path.join(dir, `${safeChat}-${seq}.json`);
    fs.writeFileSync(file, serialized, 'utf8');
    return path.relative(path.join(GROUPS_DIR, groupFolder), file);
  } catch (err) {
    logger.warn({ err, groupFolder }, 'turn trace payload spill failed');
    return null;
  }
}

/**
 * Record one StreamEvent if it carries turn structure.
 *
 * Called from the single broadcast choke point, so it runs on the streaming hot
 * path: it must stay cheap and must never throw. Unknown/high-frequency event
 * types return immediately without touching the DB.
 */
export function recordTurnEvent(
  chatJid: string,
  groupFolder: string,
  event: StreamEvent,
  agentId?: string,
): void {
  try {
    if (!event?.eventType) return;
    if (!PERSISTED_EVENT_TYPES.has(event.eventType)) return;
    if (!groupFolder) return;

    const e = event as unknown as Record<string, unknown>;
    const seq = nextSeq(chatJid);
    const payload = buildPayload(event);
    const serialized = Object.keys(payload).length
      ? JSON.stringify(payload)
      : null;

    let payloadJson: string | null = serialized;
    let payloadFile: string | null = null;
    if (serialized && serialized.length > INLINE_PAYLOAD_LIMIT) {
      payloadFile = spillPayload(groupFolder, chatJid, seq, serialized);
      // Keep a trimmed inline copy too, so a lost/pruned file still leaves the
      // row readable rather than blank.
      payloadJson = payloadFile
        ? JSON.stringify({ truncated: true, preview: serialized.slice(0, 2000) })
        : serialized.slice(0, INLINE_PAYLOAD_LIMIT);
    }

    insertTurnEvent({
      chatJid,
      groupFolder,
      turnId: (e.turnId as string) ?? null,
      seq,
      eventType: event.eventType,
      agentScope: (e.agentScope as string) ?? null,
      runtime: (e.runtime as string) ?? null,
      toolName: (e.toolName as string) ?? null,
      toolUseId: (e.toolUseId as string) ?? null,
      taskId: (e.taskId as string) ?? null,
      agentId: agentId ?? null,
      title: (e.title as string) ?? null,
      summary: (e.summary as string) ?? null,
      payloadJson,
      payloadFile,
    });
  } catch (err) {
    logger.warn({ err, chatJid }, 'recordTurnEvent failed');
  }
}
