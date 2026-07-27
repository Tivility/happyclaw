import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../src/sqlite-compat.js';

const tmpDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v45-to-v63-')),
);
const storeDir = path.join(tmpDir, 'db');
const groupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

const db = await import('../src/db.js');
const dbPath = path.join(storeDir, 'messages.db');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * v45 → v63 的存量库升级。
 *
 * 这条路径此前**完全没有测试**，而它和全新安装走的是不同分支：新库由
 * CREATE TABLE 一次性建出全部列，存量库靠 ensureColumn 逐列补。合并期间
 * usage_records 有三列（provider_estimated_cost_usd / billed_cost_usd /
 * event_id）只写进了 CREATE TABLE，没有对应 ensureColumn ——
 *
 *   - v51 的回填 UPDATE 直接引用 provider_estimated_cost_usd，
 *     存量库升级时抛 "no such column"，initDatabase 崩，服务起不来；
 *   - 空库启动一切正常，所以 CI 和本地开发都看不见。
 *
 * 下面的 DDL 是从一个真实 v45 生产库导出的 usage_records 形态（含本地当年
 * 加的 11 个归因列，不含 upstream v51 的那批）。用它做起点，才能复现真实
 * 升级而不是「先建全再删几列」的人造场景。
 */
const V45_USAGE_RECORDS_DDL = `
  CREATE TABLE usage_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    group_folder TEXT NOT NULL,
    agent_id TEXT,
    message_id TEXT,
    model TEXT NOT NULL DEFAULT 'unknown',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    num_turns INTEGER DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'agent',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    runtime TEXT, provider_family TEXT, provider_pool_id TEXT,
    provider_id TEXT, auth_profile_generation INTEGER,
    selected_model TEXT, resolved_model TEXT, billing_scope TEXT,
    cost_status TEXT, cost_source TEXT, usage_metadata_json TEXT
  )
`;

function seedV45Database(): void {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE messages (
      id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
    ${V45_USAGE_RECORDS_DDL};
  `);
  legacy
    .prepare("INSERT INTO router_state (key, value) VALUES ('schema_version', '45')")
    .run();
  legacy
    .prepare('INSERT INTO chats (jid, name) VALUES (?, ?)')
    .run('web:legacy-ws', 'Legacy Workspace');
  legacy
    .prepare(
      `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('m1', 'web:legacy-ws', 'user', '历史消息', '2026-07-01T00:00:00.000Z', 0);
  // 带成本的历史用量行：v51 的回填要把 cost_usd 复制进
  // provider_estimated_cost_usd，正是崩溃现场。
  legacy
    .prepare(
      `INSERT INTO usage_records
         (id, user_id, group_folder, model, input_tokens, output_tokens,
          cache_read_input_tokens, cache_creation_input_tokens, cost_usd,
          duration_ms, num_turns, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'u1',
      'legacy-user',
      'legacy-ws',
      'claude-legacy',
      100,
      200,
      300,
      400,
      2.5,
      1000,
      1,
      'agent',
      '2026-07-01T00:00:00.000Z',
    );
  legacy.close();
}

describe('schema v45 → v63 存量库升级', () => {
  test('迁移不崩、数据不丢、版本推进到当前值', () => {
    seedV45Database();

    // 这一行就是回归点：修复前这里抛
    // SqliteError: no such column: provider_estimated_cost_usd
    expect(() => db.initDatabase()).not.toThrow();

    const raw = new Database(dbPath, { readonly: true });
    const version = (
      raw
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .get() as { value: string }
    ).value;
    const cols = new Set(
      (raw.prepare('PRAGMA table_info(usage_records)').all() as Array<{
        name: string;
      }>).map((c) => c.name),
    );
    const usage = raw
      .prepare('SELECT * FROM usage_records WHERE id = ?')
      .get('u1') as Record<string, unknown>;
    const messageCount = (
      raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    ).n;
    raw.close();

    expect(version).toBe(String(db.CURRENT_SCHEMA_VERSION));

    // 三个此前漏了 ensureColumn 的列必须补上。
    expect(cols.has('provider_estimated_cost_usd')).toBe(true);
    expect(cols.has('billed_cost_usd')).toBe(true);
    expect(cols.has('event_id')).toBe(true);

    // 历史数据不能丢，且 v51 的回填要真的把成本搬过去。
    expect(messageCount).toBe(1);
    expect(usage.cost_usd).toBe(2.5);
    expect(usage.provider_estimated_cost_usd).toBe(2.5);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(200);
    // usage_date 由 created_at 回填，不能留空 —— 用量页按日聚合依赖它。
    expect(usage.usage_date).toBeTruthy();

    db.closeDatabase();
  });

  test('重复启动幂等：版本与数据都不再变化', () => {
    db.initDatabase();
    const raw = new Database(dbPath, { readonly: true });
    const version = (
      raw
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .get() as { value: string }
    ).value;
    const usageCount = (
      raw.prepare('SELECT COUNT(*) AS n FROM usage_records').get() as {
        n: number;
      }
    ).n;
    raw.close();

    expect(version).toBe(String(db.CURRENT_SCHEMA_VERSION));
    // 幂等的关键：回填不能每次启动都再插一行。
    expect(usageCount).toBe(1);
  });

  test('迁移后新代码能正常写入用量（单行，不双计）', () => {
    db.insertUsageRecord({
      userId: 'legacy-user',
      groupFolder: 'legacy-ws',
      model: 'post-migration',
      inputTokens: 7,
      outputTokens: 8,
      cacheReadInputTokens: 9,
      cacheCreationInputTokens: 0,
      costUSD: 0,
    } as Parameters<typeof db.insertUsageRecord>[0]);

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw
      .prepare('SELECT * FROM usage_records WHERE model = ?')
      .all('post-migration') as Array<Record<string, unknown>>;
    raw.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(7);
    expect(rows[0].cache_read_input_tokens).toBe(9);
  });
});

describe('channel_mounts 的 folder 兜底', () => {
  test('single_context 且无绑定时，folder 有 web 工作区就建 mount', () => {
    db.initDatabase();

    // 复刻实测形态：微信会话 folder=wechat，两个绑定字段都空。
    // durable inbox 路径要走 resolveEffectiveChatJid，没有 mount 就 fail-closed
    // 拒收 —— 且命中的是静默的 'no binding found' 分支，日志里只有
    // ChannelRouteRejectedError，没有任何指向根因的信息。
    db.setRegisteredGroup('web:wechat-ws', {
      name: '微信',
      folder: 'wechat-ws',
      added_at: '2026-03-22T00:00:00.000Z',
      created_by: 'legacy-user',
    } as Parameters<typeof db.setRegisteredGroup>[1]);
    db.setRegisteredGroup('wechat:legacy@im.wechat', {
      name: 'WeChat Legacy',
      folder: 'wechat-ws',
      added_at: '2026-03-22T00:00:00.000Z',
      created_by: 'legacy-user',
      binding_mode: 'single_context',
    } as Parameters<typeof db.setRegisteredGroup>[1]);

    db.syncAllChannelMountsFromRegisteredGroups();

    const mount = db.getChannelMount('wechat:legacy@im.wechat');
    expect(mount).toBeTruthy();
    expect(mount?.workspace_jid).toBe('web:wechat-ws');
  });

  test('folder 没有对应 web 工作区时不建 mount（不凭空指向不存在的目标）', () => {
    db.setRegisteredGroup('wechat:orphan@im.wechat', {
      name: 'Orphan',
      folder: 'no-such-workspace',
      added_at: '2026-03-22T00:00:00.000Z',
      created_by: 'legacy-user',
      binding_mode: 'single_context',
    } as Parameters<typeof db.setRegisteredGroup>[1]);
    db.syncAllChannelMountsFromRegisteredGroups();
    expect(db.getChannelMount('wechat:orphan@im.wechat')).toBeFalsy();
  });
});
