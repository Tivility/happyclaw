#!/usr/bin/env node
/**
 * create-workspace.mjs
 *
 * 一键创建飞书群组并绑定为 HappyClaw 独立工作区。
 *
 * Usage:
 *   node create-workspace.mjs --name "群名" --mode host [options]
 *
 * Options:
 *   --name           群组名称（必填）
 *   --mode           执行模式：host | container（默认 host）
 *   --avatar-prompt  头像生成提示词（可选，不提供则跳过头像）
 *   --description    群组描述（可选，默认为 "九筒·{name}"）
 *   --user-open-id   添加到群的用户 open_id（可选）
 *   --happyclaw-root HappyClaw 项目根目录（默认 /Users/tivility/happyclaw）
 *
 * Env:
 *   ARK_API_KEY      火山引擎 API Key（头像生成必需）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

// ── Parse CLI args ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1] || '';
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const NAME = args.name;
const MODE = args.mode || 'host';
const AVATAR_PROMPT = args.avatarPrompt || '';
const DESCRIPTION = args.description || `九筒·${NAME}`;
const USER_OPEN_ID = args.userOpenId || '';
const HAPPYCLAW_ROOT = args.happyclawRoot || '/Users/tivility/happyclaw';
const ARK_API_KEY = process.env.ARK_API_KEY || '';

if (!NAME) {
  console.error('Error: --name is required');
  process.exit(1);
}

const DATA_DIR = path.join(HAPPYCLAW_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db', 'messages.db');

// Lazy-load better-sqlite3 (single import)
let _Database = null;
async function getDatabase() {
  if (!_Database) _Database = (await import('better-sqlite3')).default;
  return _Database;
}

// ── Feishu credentials ─────────────────────────────────────────────────

function decryptFeishuCredentials() {
  const keyFile = path.join(DATA_DIR, 'config', 'claude-provider.key');
  const keyHex = readFileSync(keyFile, 'utf-8').trim();
  const encKey = Buffer.from(keyHex, 'hex');

  // Find first available feishu config (any user)
  const userImDir = path.join(DATA_DIR, 'config', 'user-im');
  let feishuConfig = null;
  for (const userId of readdirSync(userImDir)) {
    const cfgPath = path.join(userImDir, userId, 'feishu.json');
    if (existsSync(cfgPath)) {
      feishuConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (feishuConfig.enabled && feishuConfig.appId) break;
    }
  }

  if (!feishuConfig) throw new Error('No Feishu config found');

  const enc = feishuConfig.secret;
  const iv = Buffer.from(enc.iv, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const encrypted = Buffer.from(enc.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
  const parsed = JSON.parse(decrypted);

  return { appId: feishuConfig.appId, appSecret: parsed.appSecret };
}

// ── Feishu API helpers ──────────────────────────────────────────────────

async function getFeishuToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu token: ${data.msg}`);
  return data.tenant_access_token;
}

async function createFeishuGroup(token, name, description) {
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name, description })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Create group: ${data.msg}`);
  return data.data.chat_id;
}

async function addUserToGroup(token, chatId, userOpenId) {
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ id_list: [userOpenId] })
  });
  const data = await res.json();
  if (data.code !== 0) console.warn(`  [WARN] Add user: ${data.msg}`);
}

async function generateAvatar(prompt) {
  const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ARK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'doubao-seedream-5-0-260128',
      prompt,
      response_format: 'url',
      size: '2048x2048',
      stream: false,
      watermark: false
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Seedream: ${JSON.stringify(data.error)}`);
  return data.data[0].url;
}

async function downloadImage(url) {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadFeishuAvatar(token, imageBuffer) {
  const file = new File([imageBuffer], 'avatar.png', { type: 'image/png' });
  const form = new FormData();
  form.append('image_type', 'avatar');
  form.append('image', file);

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Upload avatar: ${data.msg}`);
  return data.data.image_key;
}

async function setGroupAvatar(token, chatId, imageKey) {
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ avatar: imageKey })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Set avatar: ${data.msg}`);
}

// ── HappyClaw workspace ─────────────────────────────────────────────────

async function getAdminSession() {
  const Database = await getDatabase();
  const db = new Database(DB_PATH);
  const row = db.prepare(`
    SELECT us.id FROM user_sessions us
    JOIN users u ON us.user_id = u.id
    WHERE u.role = 'admin' AND us.expires_at > datetime('now')
    ORDER BY us.last_active_at DESC LIMIT 1
  `).get();
  db.close();
  if (!row) throw new Error('No active admin session');
  return row.id;
}

async function createHappyclawWorkspace(sessionToken, name, executionMode) {
  const port = process.env.WEB_PORT || '3000';
  const res = await fetch(`http://localhost:${port}/api/groups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `happyclaw_session=${sessionToken}`
    },
    body: JSON.stringify({ name, execution_mode: executionMode })
  });
  const data = await res.json();
  if (!data.jid) throw new Error(`Create workspace: ${JSON.stringify(data)}`);

  const Database = await getDatabase();
  const db = new Database(DB_PATH);
  const group = db.prepare('SELECT folder FROM registered_groups WHERE jid = ?').get(data.jid);
  db.close();
  return { jid: data.jid, folder: group?.folder || '' };
}

async function bindFeishuGroup(chatId, name, folder, executionMode, userId) {
  const Database = await getDatabase();
  const db = new Database(DB_PATH);
  const feishuJid = `feishu:${chatId}`;

  const groupDir = path.join(DATA_DIR, 'groups', folder);
  mkdirSync(groupDir, { recursive: true });

  db.prepare(`
    INSERT OR REPLACE INTO registered_groups (jid, name, folder, execution_mode, created_by, added_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(feishuJid, name, folder, executionMode, userId || 'system');

  db.prepare(`
    INSERT OR IGNORE INTO chats (jid, name) VALUES (?, ?)
  `).run(feishuJid, name);

  db.close();
  return feishuJid;
}

async function getAdminUserId() {
  const Database = await getDatabase();
  const db = new Database(DB_PATH);
  const row = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  db.close();
  return row?.id || null;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const result = { name: NAME, chatId: '', folder: '', avatarSet: false };

  console.log(`\n=== 创建飞书工作区: ${NAME} ===\n`);

  // 1. Decrypt Feishu credentials
  console.log('[1/6] 获取飞书凭据...');
  const { appId, appSecret } = decryptFeishuCredentials();
  const token = await getFeishuToken(appId, appSecret);
  console.log('  [OK]');

  // 2. Create Feishu group
  console.log(`[2/6] 创建飞书群: ${NAME}...`);
  const chatId = await createFeishuGroup(token, NAME, DESCRIPTION);
  result.chatId = chatId;
  console.log(`  [OK] chat_id: ${chatId}`);

  // 3. Add user to group
  if (USER_OPEN_ID) {
    console.log('[3/6] 添加用户到群...');
    await addUserToGroup(token, chatId, USER_OPEN_ID);
    console.log('  [OK]');
  } else {
    console.log('[3/6] 跳过（未指定 user-open-id）');
  }

  // 4. Generate and set avatar
  if (AVATAR_PROMPT) {
    if (!ARK_API_KEY) {
      console.log('[4/6] 跳过头像生成（未设置 ARK_API_KEY）');
    } else {
      console.log('[4/6] 生成头像...');
      try {
        const imageUrl = await generateAvatar(AVATAR_PROMPT);
        const imageBuffer = await downloadImage(imageUrl);
        console.log(`  下载完成 (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
        const imageKey = await uploadFeishuAvatar(token, imageBuffer);
        await setGroupAvatar(token, chatId, imageKey);
        result.avatarSet = true;
        console.log('  [OK] 头像已设置');
      } catch (err) {
        console.warn(`  [WARN] 头像生成失败: ${err.message}`);
      }
    }
  } else {
    console.log('[4/6] 跳过头像生成（未提供 prompt）');
  }

  // 5. Create HappyClaw workspace
  console.log(`[5/6] 创建 HappyClaw 工作区 (${MODE})...`);
  const sessionToken = await getAdminSession();
  const workspace = await createHappyclawWorkspace(sessionToken, NAME, MODE);
  result.folder = workspace.folder;
  console.log(`  [OK] folder: ${workspace.folder}`);

  // 6. Bind Feishu group to workspace
  console.log('[6/6] 绑定飞书群到工作区...');
  const adminUserId = await getAdminUserId();
  await bindFeishuGroup(chatId, NAME, workspace.folder, MODE, adminUserId);
  console.log('  [OK]');

  console.log('\n=== 完成 ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n提示: 需要重启服务以激活飞书群绑定');
}

main().catch(err => {
  console.error(`\n[FATAL] ${err.message}`);
  process.exit(1);
});
