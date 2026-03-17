/**
 * Daily Report Generator — standalone script entry point.
 *
 * Runs as a scheduled script task via HappyClaw's task scheduler.
 * Zero framework coupling: reads DB + encrypted configs directly.
 *
 * Usage:
 *   node dist/index.js                # generate for yesterday
 *   node dist/index.js 2026-03-14     # generate for specific date
 */
import fs from 'fs';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

import {
  DATA_DIR,
  TIMEZONE,
  loadDailyReportConfig,
  saveDailyReportConfig,
  getClaudeApiConfig,
  getUserFeishuConfig,
  listActiveUsers,
  getGroupsByOwner,
  getMessagesByTimeRange,
  findFeishuOpenIdByUser,
  findFeishuChatId,
  closeDb,
  type DailyReportConfig,
  type BitableFieldSchema,
} from './config-reader.js';
import {
  analyzeTopics,
  deepAnalyzeTopic,
  type TopicItem,
  type DeepAnalysisResult,
} from './ai-client.js';
import {
  createDocument,
  createFolder,
  writeDocumentBlocks,
  grantPermission,
  heading2Block,
  heading3Block,
  textBlock,
  bulletBlock,
  todoBlock,
  dividerBlock,
} from './feishu-doc.js';
import {
  fetchBitableSchema,
  fetchPendingTodos,
  type BitableTodoItem,
} from './bitable-client.js';

// ─── Types ───────────────────────────────────────────────────────

interface WorkspaceMessages {
  jid: string;
  folder: string;
  name: string;
  messages: Array<{
    sender: string;
    content: string;
    is_from_me: boolean;
    timestamp: string;
  }>;
}

interface ReportData {
  date: string;
  totalMessages: number;
  activeWorkspaces: string[];
  topics: Array<TopicItem & { deepAnalysis?: DeepAnalysisResult }>;
  allActionItems: string[];
  allInsights: string[];
  currentTodos: BitableTodoItem[];
}

// ─── Time Utilities ─────────────────────────────────────────────

function getLocalDateString(timestampMs: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: TIMEZONE,
  }).format(new Date(timestampMs));
}

function getDayBounds(dateStr: string): { startTs: number; endTs: number } {
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
  const localHour = get('hour') % 24;
  const localMin = get('minute');
  const localSec = get('second');

  const localSecondsFromMidnight = localHour * 3600 + localMin * 60 + localSec;
  const localDateStr = `${localYear}-${String(localMonth).padStart(2, '0')}-${String(localDay).padStart(2, '0')}`;

  let startTs: number;
  if (localDateStr === dateStr) {
    startTs = utcMidnight - localSecondsFromMidnight * 1000;
  } else if (localDateStr < dateStr) {
    startTs = utcMidnight + (86400 - localSecondsFromMidnight) * 1000;
  } else {
    startTs = utcMidnight - (86400 + localSecondsFromMidnight) * 1000;
  }

  return { startTs, endTs: startTs + 86400000 };
}

// ─── Data Collection ────────────────────────────────────────────

function collectWorkspaceMessages(userId: string, startTs: number, endTs: number): WorkspaceMessages[] {
  const groups = getGroupsByOwner(userId);
  const result: WorkspaceMessages[] = [];

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
      result.push({ jid: group.jid, folder: group.folder, name: group.name || group.folder, messages: mapped });
    }
  }

  for (const ws of result) {
    ws.messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  return result;
}

// ─── AI Analysis ────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  const s = text.replace(/\n/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '...';
}

function readConversationArchives(folder: string, dateStr: string): string | null {
  const convDir = path.join(DATA_DIR, 'groups', folder, 'conversations');
  if (!fs.existsSync(convDir)) return null;
  try {
    const files = fs.readdirSync(convDir).filter(f => f.startsWith(dateStr) && f.endsWith('.md')).sort();
    if (files.length === 0) return null;
    return files.map(f => fs.readFileSync(path.join(convDir, f), 'utf-8')).join('\n\n---\n\n');
  } catch { return null; }
}

async function runAIAnalysis(
  config: DailyReportConfig,
  workspaceData: WorkspaceMessages[],
  dateStr: string,
  totalMessages: number,
): Promise<ReportData> {
  const sections: string[] = [];
  for (const ws of workspaceData) {
    const lines: string[] = [`## 工作区: ${ws.name} (${ws.folder})`];
    let prevWasAgent = false;
    for (const msg of ws.messages) {
      if (msg.is_from_me && prevWasAgent) continue;
      lines.push(`- ${msg.sender}: ${truncate(msg.content, 200)}`);
      prevWasAgent = msg.is_from_me;
    }
    sections.push(lines.join('\n'));
  }

  console.log('[daily-report] Running Pass 1 (topic scan)...');
  const analysis = await analyzeTopics(sections.join('\n\n'), config.pass1Model);

  const enrichedTopics: Array<TopicItem & { deepAnalysis?: DeepAnalysisResult }> = [];
  for (const topic of analysis.topics) {
    if (topic.need_deep_analysis) {
      console.log(`[daily-report] Running Pass 2: ${topic.title}`);
      const ws = workspaceData.find(w => w.name === topic.workspace || w.folder === topic.workspace);
      let convText = '';
      if (ws) {
        convText = readConversationArchives(ws.folder, dateStr) ||
          ws.messages.map(m => `${m.sender}: ${m.content}`).join('\n');
      }
      if (convText) {
        const trimmed = convText.length > 100_000 ? convText.slice(0, 100_000) + '\n\n[...截断]' : convText;
        enrichedTopics.push({ ...topic, deepAnalysis: await deepAnalyzeTopic(topic.title, trimmed, config.pass2Model) });
      } else {
        enrichedTopics.push(topic);
      }
    } else {
      enrichedTopics.push(topic);
    }
  }

  const allActionItems: string[] = [];
  const allInsights: string[] = [];
  for (const t of enrichedTopics) {
    if (t.deepAnalysis) {
      allActionItems.push(...t.deepAnalysis.action_items);
      allInsights.push(...t.deepAnalysis.insights);
    }
  }

  return {
    date: dateStr,
    totalMessages,
    activeWorkspaces: workspaceData.map(w => w.name),
    topics: enrichedTopics,
    allActionItems,
    allInsights,
    currentTodos: [],
  };
}

// ─── Markdown Output ────────────────────────────────────────────

function groupTodosByPriority(todos: BitableTodoItem[]): Array<[string, BitableTodoItem[]]> {
  const groups = new Map<string, BitableTodoItem[]>();
  for (const todo of todos) {
    const key = todo.priority || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(todo);
  }
  const order = ['P0', '🔴 P0', 'P1', '🟠 P1', 'P2', '🟡 P2', 'P3', '⚪ P3'];
  return [...groups.entries()].sort((a, b) => {
    const ia = order.findIndex(p => a[0].includes(p));
    const ib = order.findIndex(p => b[0].includes(p));
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

function generateMarkdown(data: ReportData, username: string): string {
  const lines: string[] = [
    `# ${data.date} 日报`, '',
    `> 用户: ${username} | 消息数: ${data.totalMessages} | 活跃工作区: ${data.activeWorkspaces.length}`, '',
    '## 概览', '',
    `- 对话消息总数: ${data.totalMessages}`,
    `- 活跃工作区: ${data.activeWorkspaces.join(', ')}`,
    `- 识别主题数: ${data.topics.length}`, '',
  ];

  if (data.topics.length > 0) {
    lines.push('## 主题', '');
    for (const topic of data.topics) {
      const emoji = topic.value === 'high' ? '🔴' : topic.value === 'medium' ? '🟡' : '🟢';
      lines.push(`### ${emoji} ${topic.title}`, '', `- **工作区**: ${topic.workspace}`, `- **摘要**: ${topic.brief}`);
      if (topic.deepAnalysis) {
        const da = topic.deepAnalysis;
        if (da.summary) lines.push(`- **详细总结**: ${da.summary}`);
        if (da.decisions.length > 0) { lines.push('- **决策**:'); for (const d of da.decisions) lines.push(`  - ${d}`); }
        if (da.action_items.length > 0) { lines.push('- **行动项**:'); for (const a of da.action_items) lines.push(`  - [ ] ${a}`); }
        if (da.insights.length > 0) { lines.push('- **洞察**:'); for (const i of da.insights) lines.push(`  - ${i}`); }
      }
      lines.push('');
    }
  }

  if (data.currentTodos.length > 0) {
    lines.push('## 📋 当前待办', '');
    for (const [priority, items] of groupTodosByPriority(data.currentTodos)) {
      lines.push(`### ${priority}`);
      for (const item of items) lines.push(`- [ ] ${item.name}${item.dueDate ? ` 📅 ${item.dueDate}` : ''}`);
      lines.push('');
    }
  }

  if (data.allActionItems.length > 0) {
    lines.push('## 🆕 建议新增待办', '', '> 以下行动项从当日对话中提取，可选择性加入待办清单', '');
    data.allActionItems.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
    lines.push('');
  }

  if (data.allInsights.length > 0) {
    lines.push('## 洞察与反思', '');
    for (const insight of data.allInsights) lines.push(`- ${insight}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Feishu Document ────────────────────────────────────────────

function buildDocumentBlocks(data: ReportData): ReturnType<typeof heading2Block>[] {
  const blocks: ReturnType<typeof heading2Block>[] = [];

  blocks.push(heading2Block('概览'));
  blocks.push(textBlock(`对话消息: ${data.totalMessages} | 活跃工作区: ${data.activeWorkspaces.length} | 主题数: ${data.topics.length}`));
  blocks.push(textBlock(`工作区: ${data.activeWorkspaces.join(', ')}`));
  blocks.push(dividerBlock());

  if (data.topics.length > 0) {
    blocks.push(heading2Block('主题'));
    for (const topic of data.topics) {
      const label = topic.value === 'high' ? '[高价值]' : topic.value === 'medium' ? '[中价值]' : '[低价值]';
      blocks.push(heading3Block(`${label} ${topic.title}`));
      blocks.push(bulletBlock(`工作区: ${topic.workspace}`));
      blocks.push(bulletBlock(`摘要: ${topic.brief}`));
      if (topic.deepAnalysis) {
        const da = topic.deepAnalysis;
        if (da.summary) blocks.push(textBlock(da.summary));
        if (da.decisions.length > 0) { blocks.push(textBlock('决策:', true)); for (const d of da.decisions) blocks.push(bulletBlock(d)); }
        if (da.action_items.length > 0) { blocks.push(textBlock('行动项:', true)); for (const a of da.action_items) blocks.push(todoBlock(a)); }
        if (da.insights.length > 0) { blocks.push(textBlock('洞察:', true)); for (const i of da.insights) blocks.push(bulletBlock(i)); }
      }
    }
    blocks.push(dividerBlock());
  }

  if (data.currentTodos.length > 0) {
    blocks.push(heading2Block('当前待办'));
    for (const [priority, items] of groupTodosByPriority(data.currentTodos)) {
      blocks.push(heading3Block(priority));
      for (const item of items) blocks.push(todoBlock(`${item.name}${item.dueDate ? ` 📅 ${item.dueDate}` : ''}`));
    }
    blocks.push(dividerBlock());
  }

  if (data.allActionItems.length > 0) {
    blocks.push(heading2Block('建议新增待办'));
    blocks.push(textBlock('以下行动项从当日对话中提取，可选择性加入待办清单'));
    data.allActionItems.forEach((item, idx) => blocks.push(bulletBlock(`${idx + 1}. ${item}`)));
    blocks.push(dividerBlock());
  }

  if (data.allInsights.length > 0) {
    blocks.push(heading2Block('洞察与反思'));
    for (const insight of data.allInsights) blocks.push(bulletBlock(insight));
  }

  return blocks;
}

async function ensureFolder(
  config: DailyReportConfig,
  client: lark.Client,
  userId: string,
  openId: string | null,
): Promise<string | null> {
  const userConfig = config.users[userId] || {};
  if (userConfig.feishuFolderToken) return userConfig.feishuFolderToken;

  const token = await createFolder(client, 'HappyClaw 日报');
  if (!token) return null;

  if (openId) {
    await grantPermission(client, token, 'folder', openId, 'openid', 'full_access');
  }

  config.users[userId] = { ...userConfig, feishuFolderToken: token };
  saveDailyReportConfig(config);
  return token;
}

async function sendReportCard(client: lark.Client, chatId: string, data: ReportData, docUrl: string): Promise<void> {
  const topicSummaries = data.topics.slice(0, 5).map(t => {
    const emoji = t.value === 'high' ? '🔴' : t.value === 'medium' ? '🟡' : '🟢';
    return `${emoji} **${t.title}** — ${t.brief}`;
  }).join('\n');

  const todosSummary = data.currentTodos.length > 0
    ? data.currentTodos.slice(0, 5).map(t => `• ${t.priority} ${t.name}${t.dueDate ? ` 📅 ${t.dueDate}` : ''}`).join('\n')
      + (data.currentTodos.length > 5 ? `\n...及其他 ${data.currentTodos.length - 5} 项` : '')
    : '';

  const suggestedItems = data.allActionItems.length > 0
    ? data.allActionItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
    : '';

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `📅 ${data.date} 日报` }, template: 'indigo' },
    elements: [
      { tag: 'markdown', content: `📊 **${data.totalMessages}** 条消息 · **${data.activeWorkspaces.length}** 个工作区 · **${data.topics.length}** 个主题` },
      { tag: 'hr' },
      { tag: 'markdown', content: `**🎯 主题**\n${topicSummaries || '无主题'}` },
      ...(todosSummary ? [{ tag: 'hr' }, { tag: 'markdown', content: `**📋 当前待办** (${data.currentTodos.length} 项)\n${todosSummary}` }] : []),
      ...(suggestedItems ? [{ tag: 'hr' }, { tag: 'markdown', content: `**🆕 建议新增待办**\n${suggestedItems}\n\n💡 回复 \`添加 1 3\` 可将对应项加入待办清单` }] : []),
      { tag: 'hr' },
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看完整日报 →' }, url: docUrl, type: 'primary' }] },
    ],
  };

  await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
  });
}

// ─── Main ───────────────────────────────────────────────────────

async function generateUserReport(
  config: DailyReportConfig,
  userId: string,
  username: string,
  dateStr: string,
  startTs: number,
  endTs: number,
): Promise<boolean> {
  const userConfig = config.users[userId] || {};
  if (userConfig.lastRunDate === dateStr) {
    console.log(`[daily-report] ${username}: already generated for ${dateStr}, skipping`);
    return false;
  }

  // Phase 1: Collect messages
  const workspaceData = collectWorkspaceMessages(userId, startTs, endTs);
  const totalMessages = workspaceData.reduce((sum, w) => sum + w.messages.length, 0);
  if (totalMessages === 0) {
    console.log(`[daily-report] ${username}: no messages found for ${dateStr}`);
    return false;
  }
  console.log(`[daily-report] ${username}: ${totalMessages} messages across ${workspaceData.length} workspaces`);

  // Phase 2: AI Analysis
  const reportData = await runAIAnalysis(config, workspaceData, dateStr, totalMessages);

  // Phase 2.5: Bitable Todos (best-effort)
  const feishuConfig = getUserFeishuConfig(userId);
  let larkClient: lark.Client | null = null;

  if (feishuConfig) {
    larkClient = new lark.Client({ appId: feishuConfig.appId, appSecret: feishuConfig.appSecret });

    if (userConfig.bitableAppToken && userConfig.bitableTableId) {
      try {
        if (!userConfig.bitableFieldSchema) {
          const schema = await fetchBitableSchema(larkClient, userConfig.bitableAppToken, userConfig.bitableTableId);
          if (schema) {
            userConfig.bitableFieldSchema = schema;
            config.users[userId] = { ...userConfig, bitableFieldSchema: schema };
            saveDailyReportConfig(config);
          }
        }
        if (userConfig.bitableFieldSchema) {
          reportData.currentTodos = await fetchPendingTodos(
            larkClient, userConfig.bitableAppToken, userConfig.bitableTableId, userConfig.bitableFieldSchema,
          );
          console.log(`[daily-report] ${username}: ${reportData.currentTodos.length} Bitable todos collected`);
        }
      } catch (err) {
        console.warn(`[daily-report] ${username}: Bitable read failed, continuing:`, err);
      }
    }
  }

  // Phase 3a: Local markdown
  const markdown = generateMarkdown(reportData, username);
  const reportDir = path.join(DATA_DIR, 'groups', 'user-global', userId, 'daily-report');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `${dateStr}.md`), markdown, 'utf-8');
  console.log(`[daily-report] ${username}: local archive saved → ${dateStr}.md`);

  // Phase 3b: Feishu document + card
  if (larkClient) {
    try {
      const openId = findFeishuOpenIdByUser(userId);
      const folderToken = await ensureFolder(config, larkClient, userId, openId);
      const doc = await createDocument(larkClient, `${dateStr} 日报`, folderToken || undefined);
      if (doc) {
        if (openId) await grantPermission(larkClient, doc.documentId, 'docx', openId, 'openid', 'full_access');
        await writeDocumentBlocks(larkClient, doc.documentId, buildDocumentBlocks(reportData));
        console.log(`[daily-report] ${username}: Feishu doc published → ${doc.url}`);

        const chatId = findFeishuChatId(userId);
        if (chatId) {
          await sendReportCard(larkClient, chatId, reportData, doc.url);
          console.log(`[daily-report] ${username}: card message sent`);
        }
      }
    } catch (err) {
      console.error(`[daily-report] ${username}: Feishu publishing failed:`, err);
    }
  }

  // Update last run date
  config.users[userId] = { ...userConfig, lastRunDate: dateStr };
  saveDailyReportConfig(config);
  return true;
}

async function main(): Promise<void> {
  // Determine target date
  const dateArg = process.argv[2];
  let dateStr: string;
  if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    dateStr = dateArg;
  } else {
    dateStr = getLocalDateString(Date.now() - 24 * 60 * 60 * 1000);
  }

  // Verify API key is available
  const apiConfig = getClaudeApiConfig();
  if (!apiConfig) {
    console.error('[daily-report] FATAL: No Anthropic API key configured');
    process.exit(1);
  }

  const config = loadDailyReportConfig();
  if (!config.enabled) {
    console.log('[daily-report] Disabled in config, exiting');
    process.exit(0);
  }

  const { startTs, endTs } = getDayBounds(dateStr);
  console.log(`[daily-report] Generating reports for ${dateStr} (TZ: ${TIMEZONE})`);

  const users = listActiveUsers();
  let processed = 0;
  for (const user of users) {
    try {
      if (await generateUserReport(config, user.id, user.username, dateStr, startTs, endTs)) {
        processed++;
      }
    } catch (err) {
      console.error(`[daily-report] Failed for ${user.username}:`, err);
    }
  }

  console.log(`[daily-report] Done. ${processed}/${users.length} users processed.`);
  closeDb();
}

main().catch(err => {
  console.error('[daily-report] FATAL:', err);
  closeDb();
  process.exit(1);
});
