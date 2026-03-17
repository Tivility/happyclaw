/**
 * Data Collector — lightweight SQLite-only script for daily report.
 *
 * Collects messages from all workspaces for a given date/user
 * and outputs structured JSON to stdout. No AI, no Feishu, no encryption
 * beyond DB access.
 *
 * Usage:
 *   node dist/collect-data.js                # yesterday, all users
 *   node dist/collect-data.js 2026-03-14     # specific date, all users
 *
 * Output JSON structure:
 * {
 *   "date": "2026-03-14",
 *   "timezone": "Asia/Shanghai",
 *   "users": [{
 *     "userId": "...",
 *     "username": "...",
 *     "totalMessages": 42,
 *     "workspaces": [{
 *       "folder": "flow-xxx",
 *       "name": "工作区名",
 *       "messages": [{ "sender": "...", "content": "...", "is_from_me": false, "timestamp": "..." }]
 *     }],
 *     "conversationArchives": { "flow-xxx": "..." }
 *   }]
 * }
 */
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  TIMEZONE,
  listActiveUsers,
  getGroupsByOwner,
  getMessagesByTimeRange,
  closeDb,
} from './config-reader.js';

// ─── Time Utilities ─────────────────────────────────────────────

function getLocalDateString(timestampMs: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: TIMEZONE,
  }).format(new Date(timestampMs));
}

function getDayBounds(dateStr: string): { startTs: number; endTs: number } {
  // Find the UTC timestamp that corresponds to midnight of dateStr in TIMEZONE.
  // Strategy: start from UTC midnight of dateStr, check what local date/time that is,
  // then adjust to land on local midnight.
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMidnight));
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
  const localYear = get('year');
  const localMonth = get('month');
  const localDay = get('day');
  const localHour = get('hour') % 24; // hour12:false can give '24' for midnight
  const localMin = get('minute');
  const localSec = get('second');

  // How many seconds past local midnight when utcMidnight occurs in TIMEZONE
  const localSecondsFromMidnight = localHour * 3600 + localMin * 60 + localSec;

  // Build YYYY-MM-DD for comparison
  const localDateStr = `${localYear}-${String(localMonth).padStart(2, '0')}-${String(localDay).padStart(2, '0')}`;

  let startTs: number;
  if (localDateStr === dateStr) {
    // UTC midnight falls on the target date in local time → subtract local time offset
    startTs = utcMidnight - localSecondsFromMidnight * 1000;
  } else if (localDateStr < dateStr) {
    // UTC midnight is still on the previous day locally → add remaining time to next midnight
    startTs = utcMidnight + (86400 - localSecondsFromMidnight) * 1000;
  } else {
    // UTC midnight is already on the next day locally → subtract past-midnight seconds + full day
    startTs = utcMidnight - (86400 + localSecondsFromMidnight) * 1000;
  }

  return { startTs, endTs: startTs + 86400000 };
}

// ─── Data Collection ────────────────────────────────────────────

interface WorkspaceData {
  folder: string;
  name: string;
  messages: Array<{
    sender: string;
    content: string;
    is_from_me: boolean;
    timestamp: string;
  }>;
}

function collectWorkspaceMessages(userId: string, startTs: number, endTs: number): WorkspaceData[] {
  const groups = getGroupsByOwner(userId);
  const result: WorkspaceData[] = [];

  for (const group of groups) {
    const messages = getMessagesByTimeRange(group.jid, startTs, endTs, 1000);
    if (messages.length === 0) continue;

    const existing = result.find(w => w.folder === group.folder);
    const mapped = messages.map(msg => ({
      sender: msg.is_from_me ? 'Agent' : (msg.sender_name || msg.sender || 'User'),
      content: msg.content || '',
      is_from_me: !!msg.is_from_me,
      timestamp: msg.timestamp,
    }));

    if (existing) {
      existing.messages.push(...mapped);
    } else {
      result.push({ folder: group.folder, name: group.name || group.folder, messages: mapped });
    }
  }

  for (const ws of result) {
    ws.messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  return result;
}

function readConversationArchives(folder: string, dateStr: string, startTs: number, endTs: number): string | null {
  // Archive filenames use UTC dates (new Date().toISOString().split('T')[0]).
  // We need to check which UTC dates overlap with the local-time day boundaries.
  const startUtcDate = new Date(startTs).toISOString().split('T')[0];
  const endUtcDate = new Date(endTs).toISOString().split('T')[0];
  // Collect candidate UTC date prefixes (usually 1-2 dates)
  const candidateDates = new Set([startUtcDate, endUtcDate]);

  const convDir = path.join(DATA_DIR, 'groups', folder, 'conversations');
  if (!fs.existsSync(convDir)) return null;
  try {
    const files = fs.readdirSync(convDir)
      .filter(f => f.endsWith('.md') && [...candidateDates].some(d => f.startsWith(d)))
      .sort();
    if (files.length === 0) return null;
    return files.map(f => fs.readFileSync(path.join(convDir, f), 'utf-8')).join('\n\n---\n\n');
  } catch { return null; }
}

// ─── Main ───────────────────────────────────────────────────────

function main(): void {
  const dateArg = process.argv[2];
  let dateStr: string;
  if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    dateStr = dateArg;
  } else {
    dateStr = getLocalDateString(Date.now() - 24 * 60 * 60 * 1000);
  }

  const { startTs, endTs } = getDayBounds(dateStr);
  const users = listActiveUsers();

  // Output directory for split data files
  const outDir = path.join(DATA_DIR, 'tmp', `daily-report-${dateStr}`);
  fs.mkdirSync(outDir, { recursive: true });

  interface UserSummary {
    userId: string;
    username: string;
    totalMessages: number;
    workspaces: Array<{
      folder: string;
      name: string;
      messageCount: number;
      messagesFile: string;
      archiveFile: string | null;
    }>;
  }

  const index: {
    date: string;
    timezone: string;
    dataDir: string;
    users: UserSummary[];
  } = { date: dateStr, timezone: TIMEZONE, dataDir: outDir, users: [] };

  for (const user of users) {
    const workspaces = collectWorkspaceMessages(user.id, startTs, endTs);
    const totalMessages = workspaces.reduce((sum, w) => sum + w.messages.length, 0);
    if (totalMessages === 0) continue;

    const userSummary: UserSummary = {
      userId: user.id,
      username: user.username,
      totalMessages,
      workspaces: [],
    };

    for (const ws of workspaces) {
      // Write messages to separate file
      const safeFolder = ws.folder.replace(/[^a-zA-Z0-9_-]/g, '_');
      const msgsFile = path.join(outDir, `messages-${safeFolder}.json`);
      fs.writeFileSync(msgsFile, JSON.stringify(ws.messages, null, 2));

      // Write archive to separate file if exists
      const archive = readConversationArchives(ws.folder, dateStr, startTs, endTs);
      let archiveFile: string | null = null;
      if (archive) {
        archiveFile = path.join(outDir, `archive-${safeFolder}.md`);
        fs.writeFileSync(archiveFile, archive);
      }

      userSummary.workspaces.push({
        folder: ws.folder,
        name: ws.name,
        messageCount: ws.messages.length,
        messagesFile: msgsFile,
        archiveFile,
      });
    }

    index.users.push(userSummary);
  }

  // Output compact index to stdout (small enough for Bash tool)
  console.log(JSON.stringify(index, null, 2));
  closeDb();
}

main();
