import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Continuous, runtime-agnostic conversation archiving.
 *
 * Why this exists: archives under `groups/{folder}/conversations/` used to be
 * written only by the Claude SDK's PreCompact hook, which fires just before the
 * context window is compacted. Two consequences made that unreliable as the
 * archive of record:
 *
 *   1. Codex and Grok have no compaction event at all, so those runtimes
 *      archived *nothing* — `supportsPreCompactHook: false` in all three
 *      non-Claude adapters.
 *   2. Even on Claude, compaction almost never happens now: the default context
 *      window is ~1M tokens, so a workspace can run for weeks without a single
 *      compact. Measured on this deployment before the change: only 4 archive
 *      files written across all workspaces in 7 days, and `main` had not
 *      archived since 2026-06-10 — six weeks stale.
 *
 * The archive is what `memory_search` greps, so a stale archive means the agent
 * silently cannot recall recent conversations. Writing it per completed turn,
 * straight from what we already persist, removes the dependency on a
 * runtime-specific event entirely.
 *
 * Files are monthly (`YYYY-MM.md`) so they stay greppable and bounded, and
 * appends are atomic-enough for this purpose: a single `appendFileSync` of a
 * few KB does not interleave across the single-threaded main process.
 */

/** Turn content to archive. Empty parts are skipped rather than written blank. */
export interface ArchiveTurn {
  folder: string;
  /** What the user (or scheduler) sent. */
  prompt?: string | null;
  /** What the agent replied. */
  reply?: string | null;
  /** Conversation JID, recorded so a multi-chat folder stays disambiguated. */
  chatJid?: string;
  /** Runtime that produced the reply — makes per-runtime gaps visible in the archive. */
  runtime?: string | null;
  /** Skip archiving entirely (workspace has privacy_mode enabled). */
  privacyMode?: boolean;
  timestamp?: Date;
}

/** Trim a very long body so one runaway turn cannot dominate a monthly file. */
const MAX_PART_CHARS = 200_000;

function clip(text: string): string {
  if (text.length <= MAX_PART_CHARS) return text;
  return `${text.slice(0, MAX_PART_CHARS)}\n\n…（已截断，原文 ${text.length} 字符）`;
}

function monthlyFileFor(folder: string, when: Date): string {
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
  return path.join(GROUPS_DIR, folder, 'conversations', `${stamp}.md`);
}

/**
 * Append one completed turn to the workspace's monthly archive.
 *
 * Best-effort by design: archiving must never fail a turn that already
 * succeeded, so every error is swallowed after a warn. Returns the file it
 * wrote to, or null when it skipped.
 */
export function appendConversationArchive(turn: ArchiveTurn): string | null {
  if (turn.privacyMode) return null;
  if (!turn.folder) return null;

  const prompt = turn.prompt?.trim() || '';
  const reply = turn.reply?.trim() || '';
  if (!prompt && !reply) return null;

  const when = turn.timestamp ?? new Date();
  const target = monthlyFileFor(turn.folder, when);

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const stampedTime = when.toISOString();
    const header = turn.runtime
      ? `## ${stampedTime} · ${turn.runtime}`
      : `## ${stampedTime}`;
    const lines = [header];
    if (turn.chatJid) lines.push(`<!-- chat: ${turn.chatJid} -->`);
    lines.push('');
    if (prompt) lines.push('**User**', '', clip(prompt), '');
    if (reply) lines.push('**Assistant**', '', clip(reply), '');
    lines.push('---', '');

    fs.appendFileSync(target, `${lines.join('\n')}\n`, 'utf8');
    return target;
  } catch (err) {
    logger.warn(
      { err, folder: turn.folder, target },
      'Conversation archive append failed',
    );
    return null;
  }
}
