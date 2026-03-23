/**
 * Config Reader — standalone access to HappyClaw encrypted configs and database.
 *
 * Replaces framework imports (runtime-config, db, im-manager) with direct
 * file reads and SQLite queries. Zero framework coupling.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
// ─── Paths ──────────────────────────────────────────────────────
// Resolve DATA_DIR from script location: scripts/daily-report/dist/ → ../../.. → project root → data/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', '..', '..', 'data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const ENCRYPTION_KEY_FILE = path.join(CONFIG_DIR, 'claude-provider.key');
const CLAUDE_CONFIG_FILE = path.join(CONFIG_DIR, 'claude-provider.json');
const DAILY_REPORT_CONFIG_FILE = path.join(CONFIG_DIR, 'daily-report.json');
const DB_FILE = path.join(DATA_DIR, 'db', 'messages.db');
// TIMEZONE: config file → env TZ → system default
// Loaded lazily from daily-report.json to support user-configured timezone
function resolveTimezone() {
    try {
        const cfgPath = path.join(CONFIG_DIR, 'daily-report.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (cfg.timezone && typeof cfg.timezone === 'string')
                return cfg.timezone;
        }
    }
    catch { /* ignore */ }
    return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export const TIMEZONE = resolveTimezone();
function getEncryptionKey() {
    const raw = fs.readFileSync(ENCRYPTION_KEY_FILE, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length !== 32)
        throw new Error('Invalid encryption key');
    return key;
}
function decrypt(secrets) {
    const key = getEncryptionKey();
    const iv = Buffer.from(secrets.iv, 'base64');
    const tag = Buffer.from(secrets.tag, 'base64');
    const encrypted = Buffer.from(secrets.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
    return JSON.parse(decrypted);
}
export function getClaudeApiConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8'));
        // V3 format (current)
        if (raw.version === 3) {
            const activeId = raw.activeProfileId || '__official__';
            // Check third-party profiles first (if active profile is a custom one)
            if (activeId !== '__official__' && Array.isArray(raw.profiles)) {
                for (const p of raw.profiles) {
                    if (p.id === activeId && p.secrets) {
                        const secrets = decrypt(p.secrets);
                        const apiKey = (secrets.anthropicApiKey || secrets.anthropicAuthToken || '');
                        if (apiKey)
                            return { apiKey, baseUrl: p.anthropicBaseUrl || undefined };
                    }
                }
            }
            // Official profile
            if (raw.official?.secrets) {
                const secrets = decrypt(raw.official.secrets);
                const apiKey = (secrets.anthropicApiKey || secrets.anthropicAuthToken || '');
                if (apiKey)
                    return { apiKey, baseUrl: raw.official.anthropicBaseUrl || undefined };
                // OAuth credentials: use authToken (Bearer header) not apiKey
                const oauthCreds = secrets.claudeOAuthCredentials;
                if (oauthCreds?.accessToken && typeof oauthCreds.accessToken === 'string') {
                    return { authToken: oauthCreds.accessToken, baseUrl: raw.official.anthropicBaseUrl || undefined };
                }
            }
        }
        // V2 format
        if (raw.version === 2 && raw.secrets) {
            const secrets = decrypt(raw.secrets);
            const apiKey = (secrets.anthropicApiKey || secrets.anthropicAuthToken || '');
            if (apiKey)
                return { apiKey, baseUrl: raw.anthropicBaseUrl || undefined };
        }
        // Fallback: read OAuth credentials from session file
        const credFile = path.join(DATA_DIR, 'sessions', 'main', '.claude', '.credentials.json');
        if (fs.existsSync(credFile)) {
            const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
            if (creds.claudeAiOauth?.accessToken) {
                return { authToken: creds.claudeAiOauth.accessToken };
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
export function getUserFeishuConfig(userId) {
    try {
        const filePath = path.join(CONFIG_DIR, 'user-im', userId, 'feishu.json');
        if (!fs.existsSync(filePath))
            return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (raw.version !== 1)
            return null;
        const secret = decrypt(raw.secret);
        const appSecret = (secret.appSecret || '');
        const appId = (raw.appId || '');
        if (!appId || !appSecret)
            return null;
        return { appId, appSecret };
    }
    catch {
        return null;
    }
}
export function loadDailyReportConfig() {
    try {
        if (fs.existsSync(DAILY_REPORT_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(DAILY_REPORT_CONFIG_FILE, 'utf-8'));
        }
    }
    catch { /* ignore */ }
    return {
        enabled: true,
        runHour: 5,
        pass1Model: 'claude-sonnet-4-5-20250929',
        pass2Model: 'claude-sonnet-4-5-20250929',
        users: {},
    };
}
export function saveDailyReportConfig(config) {
    const dir = path.dirname(DAILY_REPORT_CONFIG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DAILY_REPORT_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
// ─── Database Access ────────────────────────────────────────────
let db = null;
function getDb() {
    if (!db) {
        db = new Database(DB_FILE, { readonly: true });
        db.pragma('journal_mode = WAL');
    }
    return db;
}
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
export function listActiveUsers() {
    return getDb()
        .prepare('SELECT id, username FROM users WHERE status = ? AND deleted_at IS NULL')
        .all('active');
}
export function getGroupsByOwner(userId) {
    return getDb()
        .prepare('SELECT jid, folder, name, created_by, is_home FROM registered_groups WHERE created_by = ? AND (privacy_mode IS NULL OR privacy_mode = 0)')
        .all(userId);
}
export function getUserHomeGroup(userId) {
    return getDb()
        .prepare('SELECT jid, folder, name, created_by, is_home FROM registered_groups WHERE created_by = ? AND is_home = 1 LIMIT 1')
        .get(userId);
}
export function getJidsByFolder(folder) {
    const rows = getDb()
        .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
        .all(folder);
    return rows.map(r => r.jid);
}
export function getMessagesByTimeRange(chatJid, startTs, endTs, limit) {
    const startIso = new Date(startTs).toISOString();
    const endIso = new Date(endTs).toISOString();
    return getDb()
        .prepare(`SELECT content, is_from_me, sender, sender_name, timestamp, source_jid
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?`)
        .all(chatJid, startIso, endIso, limit);
}
export function findFeishuOpenIdByUser(userId) {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup)
        return null;
    const jids = getJidsByFolder(homeGroup.folder);
    for (const jid of jids) {
        const row = getDb()
            .prepare(`SELECT sender FROM messages
         WHERE chat_jid = ? AND source_jid LIKE 'feishu:%' AND is_from_me = 0 AND sender LIKE 'ou_%'
         ORDER BY timestamp DESC LIMIT 1`)
            .get(jid);
        if (row?.sender)
            return row.sender;
    }
    return null;
}
export function findFeishuChatId(userId) {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup)
        return null;
    const jids = getJidsByFolder(homeGroup.folder);
    const feishuJids = jids.filter(j => j.startsWith('feishu:'));
    if (feishuJids.length === 0)
        return null;
    // Pick the feishu chat with most recent message (the active one)
    let bestJid = feishuJids[0];
    let bestTs = '';
    for (const jid of feishuJids) {
        const row = getDb()
            .prepare('SELECT timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1')
            .get(jid);
        if (row?.timestamp && row.timestamp > bestTs) {
            bestTs = row.timestamp;
            bestJid = jid;
        }
    }
    return bestJid.replace('feishu:', '');
}
export { DATA_DIR };
