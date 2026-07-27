import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'usage-insert-legacy-')),
);
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * `insertUsageRecord` 是 usage 的**旧**写入路径（upstream v51 之后新增了
 * 批次事件路径，但这条仍在服务 storeMessageDirect —— 每条带用量的 Agent
 * 回复都会走到）。合并期间它出过两次参数错位：
 *
 * 1. usage_records 的 INSERT 从 26 列涨到 31 列，实参没跟上 → token 数落进
 *    成本列（静默数据污染，不报错）。
 * 2. usage_daily_summary 的 upsert 加了 total_reasoning_tokens 变成 9 个
 *    占位符，实参仍是 8 个 → better-sqlite3 抛 RangeError，Agent 回复直接挂。
 *
 * 这两类都是 tsc 看不见的（都是 `.run(...args)` 的可变参数）。之前全仓对这个
 * 函数**零测试覆盖**，所以只有在真实库上跑才暴露。这里锁住：占位符数与实参数
 * 必须一致，且写进去的值必须落在正确的列上。
 */
describe('usage 旧写入路径（insertUsageRecord）', () => {
  const userId = 'u-usage-legacy';

  test('写入成功，且各列值不错位', () => {
    db.insertUsageRecord({
      userId,
      groupFolder: 'ws-legacy',
      model: 'claude-probe',
      inputTokens: 111,
      outputTokens: 222,
      cacheReadInputTokens: 333,
      cacheCreationInputTokens: 444,
      reasoningTokens: 55,
      costUSD: 1.25,
      durationMs: 7000,
      numTurns: 3,
      source: 'agent',
    } as Parameters<typeof db.insertUsageRecord>[0]);

    const raw = new Database(path.join(tmpStoreDir, 'messages.db'), {
      readonly: true,
    });
    const allRows = raw
      .prepare(`SELECT * FROM usage_records WHERE user_id = ?`)
      .all(userId) as Array<Record<string, unknown>>;
    // 一次调用只能落一行。曾经这里是两行（旧 INSERT + upstream 的事件转发
    // 都保留了），导致用量页和日汇总全部翻倍。
    expect(allRows).toHaveLength(1);
    const row = allRows[0];
    const summary = raw
      .prepare(
        `SELECT * FROM usage_daily_summary WHERE user_id = ? AND model = ?`,
      )
      .get(userId, 'claude-probe') as Record<string, unknown>;
    raw.close();

    // 逐列断言：错位一格就有列拿到别人的值。
    expect(row.input_tokens).toBe(111);
    expect(row.output_tokens).toBe(222);
    expect(row.cache_read_input_tokens).toBe(333);
    expect(row.cache_creation_input_tokens).toBe(444);
    expect(row.reasoning_output_tokens).toBe(55);
    expect(row.cost_usd).toBe(1.25);
    expect(row.duration_ms).toBe(7000);
    expect(row.num_turns).toBe(3);
    expect(row.source).toBe('agent');
    expect(row.model).toBe('claude-probe');
    // 成本分列：provider 估算取 costUSD；billed 为 0 —— 这条路径
    // trackBillingUsage:false，不进计费聚合，计费由 billing.ts 独立入口负责。
    expect(row.provider_estimated_cost_usd).toBe(1.25);
    expect(row.billed_cost_usd).toBe(0);
    // 现在统一走批次事件路径，所以有 event_id（旧的双写实现里这行是 null）。
    expect(row.event_id).toBeTruthy();

    // 日汇总也要对上（这里是 RangeError 的现场）。
    expect(summary.total_input_tokens).toBe(111);
    expect(summary.total_output_tokens).toBe(222);
    expect(summary.total_cache_read_tokens).toBe(333);
    expect(summary.total_cache_creation_tokens).toBe(444);
    expect(summary.total_reasoning_tokens).toBe(55);
    expect(summary.total_cost_usd).toBe(1.25);
    expect(summary.request_count).toBe(1);
  });

  test('缺省字段按 0 / null 落库，不抛参数个数错误', () => {
    // 最小载荷：可选字段全不传。参数个数由实现补齐，不能因为缺省就少传占位符。
    expect(() =>
      db.insertUsageRecord({
        userId: 'u-usage-minimal',
        groupFolder: 'ws-legacy',
        model: 'minimal-probe',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      } as Parameters<typeof db.insertUsageRecord>[0]),
    ).not.toThrow();

    const raw = new Database(path.join(tmpStoreDir, 'messages.db'), {
      readonly: true,
    });
    const row = raw
      .prepare('SELECT * FROM usage_records WHERE user_id = ?')
      .get('u-usage-minimal') as Record<string, unknown>;
    raw.close();
    expect(row.reasoning_output_tokens).toBe(0);
    expect(row.num_turns).toBe(0);
    expect(row.source).toBe('agent');
  });

  test('同一天同模型再写一条走 upsert 累加而非新增汇总行', () => {
    db.insertUsageRecord({
      userId,
      groupFolder: 'ws-legacy',
      model: 'claude-probe',
      inputTokens: 9,
      outputTokens: 8,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 6,
      reasoningTokens: 5,
      costUSD: 0.75,
      source: 'agent',
    } as Parameters<typeof db.insertUsageRecord>[0]);

    const raw = new Database(path.join(tmpStoreDir, 'messages.db'), {
      readonly: true,
    });
    const rows = raw
      .prepare(
        'SELECT * FROM usage_daily_summary WHERE user_id = ? AND model = ?',
      )
      .all(userId, 'claude-probe') as Array<Record<string, unknown>>;
    raw.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].total_input_tokens).toBe(120);
    expect(rows[0].total_reasoning_tokens).toBe(60);
    expect(rows[0].total_cost_usd).toBe(2);
    expect(rows[0].request_count).toBe(2);
  });
});

describe('usage 事件幂等（同一事件重放不双计）', () => {
  test('同一 eventId 写两次只落一行', () => {
    const payload = {
      userId: 'u-idem',
      groupFolder: 'ws-idem',
      model: 'idem-probe',
      inputTokens: 50,
      outputTokens: 60,
      cacheReadInputTokens: 70,
      cacheCreationInputTokens: 0,
      costUSD: 0.5,
      eventId: 'evt-fixed-001',
    } as Parameters<typeof db.insertUsageRecord>[0];

    // 真实链路里同一个 usage 事件会被写两次：流式路径先算金额供实时展示，
    // 定稿路径再关联最终消息 id。幂等靠 usage_events 的 INSERT OR IGNORE，
    // 前提是两次传同一个 eventId —— 此前 insertUsageRecord 无条件
    // crypto.randomUUID()，幂等永不命中，每轮用量落两行、日汇总翻倍。
    db.insertUsageRecord(payload);
    db.insertUsageRecord(payload);

    const raw = new Database(path.join(tmpStoreDir, 'messages.db'), {
      readonly: true,
    });
    const rows = raw
      .prepare('SELECT * FROM usage_records WHERE user_id = ?')
      .all('u-idem') as Array<Record<string, unknown>>;
    const summary = raw
      .prepare(
        'SELECT * FROM usage_daily_summary WHERE user_id = ? AND model = ?',
      )
      .get('u-idem', 'idem-probe') as Record<string, unknown>;
    raw.close();

    expect(rows).toHaveLength(1);
    // 日汇总也不能翻倍。
    expect(summary.total_input_tokens).toBe(50);
    expect(summary.request_count).toBe(1);
  });

  test('不同 eventId 各自落一行（正常的多事件场景）', () => {
    for (const id of ['evt-a', 'evt-b']) {
      db.insertUsageRecord({
        userId: 'u-multi',
        groupFolder: 'ws-idem',
        model: 'multi-probe',
        inputTokens: 10,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        eventId: id,
      } as Parameters<typeof db.insertUsageRecord>[0]);
    }
    const raw = new Database(path.join(tmpStoreDir, 'messages.db'), {
      readonly: true,
    });
    const n = (
      raw
        .prepare('SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?')
        .get('u-multi') as { n: number }
    ).n;
    raw.close();
    expect(n).toBe(2);
  });

  test('缺省 eventId 时回退随机 id，两次写各自落一行', () => {
    // 没有上游事件 id 的调用方（脚本任务等）不该被误去重成一行。
    for (let i = 0; i < 2; i++) {
      db.insertUsageRecord({
        userId: 'u-noevent',
        groupFolder: 'ws-idem',
        model: 'noevent-probe',
        inputTokens: 3,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      } as Parameters<typeof db.insertUsageRecord>[0]);
    }
    const raw = new Database(path.join(tmpStoreDir, 'messages.db'), {
      readonly: true,
    });
    const n = (
      raw
        .prepare('SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?')
        .get('u-noevent') as { n: number }
    ).n;
    raw.close();
    expect(n).toBe(2);
  });
});
