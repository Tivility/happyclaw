/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import {
  clearSessionChannelOwner,
  deleteSession,
  getJidsByFolder,
  getJidsExecutingInFolder,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { logger } from './logger.js';
import { clearSessionFiles } from './session-files.js';
import type { NewMessage, MessageCursor } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
}

// ─── Command parsing ────────────────────────────────────────────

export function isClearCommand(content: string): boolean {
  return content.trim().toLowerCase() === '/clear';
}

export const SESSION_RESET_FAILURE_MESSAGE =
  'system_error:清除上下文失败，请稍后重试';

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  baseChatJid: string,
  folder: string,
  deps: CommandDeps,
  agentId?: string,
): Promise<void> {
  const targetJid = agentId ? `${baseChatJid}#agent:${agentId}` : baseChatJid;

  if (agentId) {
    // Agent-specific reset: only stop the agent's virtual JID process
    await deps.queue.stopGroup(targetJid, { force: true });
  } else {
    // Main session reset: stop every runner that actually executes in this
    // folder. Deliberately not getJidsByFolder — IM rows routed elsewhere via
    // target_main_jid serve another workspace, and resetting this folder must not
    // kill their in-flight runs. On the reference deployment folder='main'
    // collects 24 JIDs of which 21 run elsewhere (see db.ts
    // getJidsExecutingInFolder). Reached from both the /clear IM command and the
    // web reset route, so this was the third call site of the same bug.
    const siblingJids = getJidsExecutingInFolder(folder);
    await Promise.all(
      siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })),
    );
  }

  // 2. Clear .claude/ session files (preserve settings.json)
  clearSessionFiles(folder, agentId);

  // 3. Delete runtime-aware native session state from DB.
  deleteSession(folder, agentId);
  clearSessionChannelOwner(folder, agentId);

  // 4. Insert context_reset divider message into the correct JID
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(targetJid);
  storeMessageDirect(
    dividerMessageId,
    targetJid,
    '__system__',
    'system',
    'context_reset',
    timestamp,
    true,
  );

  deps.broadcast(targetJid, {
    id: dividerMessageId,
    chat_jid: targetJid,
    sender: '__system__',
    sender_name: 'system',
    content: 'context_reset',
    timestamp,
    is_from_me: true,
  });

  // 5. Advance lastAgentTimestamp so old messages before the reset are not
  //    re-sent to the next fresh agent session.
  if (agentId) {
    deps.setLastAgentTimestamp(targetJid, { timestamp, id: dividerMessageId });
  } else {
    // Same execution-folder scoping as the stop above, and for a sharper reason:
    // advancing the cursor of a JID that runs in another workspace would make
    // *that* conversation skip every message before this divider. Resetting one
    // workspace must not silently drop another's pending input.
    const siblingJids = getJidsExecutingInFolder(folder);
    for (const siblingJid of siblingJids) {
      deps.setLastAgentTimestamp(siblingJid, {
        timestamp,
        id: dividerMessageId,
      });
    }
  }

  logger.info(
    { baseChatJid, targetJid, folder, agentId },
    'Session reset via /clear command',
  );
}
