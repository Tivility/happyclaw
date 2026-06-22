import { describe, expect, test } from 'vitest';

import { decideHealthAction } from '../src/im-safety/health-action.js';
import type { ChatProbe } from '../src/types.js';

const THRESHOLD = 3;

/**
 * 健康检查纯决策逻辑测试。核心不变量：'unknown'（我方/传输故障）携带零信息量，
 * 永远 skip——既不累加计数也不触发善后。只有 'gone' 才计数，达阈值才确认失效。
 */
describe('decideHealthAction', () => {
  test("'unknown' ⇒ skip（不累加、不动作）", () => {
    const probe: ChatProbe = { status: 'unknown', reason: 'token jitter' };
    // 无论当前计数多高，unknown 都不应推进或触发动作
    for (const count of [0, 1, 2, 5, 100]) {
      expect(decideHealthAction(probe, count, THRESHOLD)).toEqual({
        kind: 'skip',
      });
    }
  });

  test("'unsupported' ⇒ skip", () => {
    const probe: ChatProbe = { status: 'unsupported' };
    expect(decideHealthAction(probe, 2, THRESHOLD)).toEqual({ kind: 'skip' });
  });

  test("'ok' ⇒ reset", () => {
    const probe: ChatProbe = { status: 'ok', info: { name: 'g' } };
    expect(decideHealthAction(probe, 2, THRESHOLD)).toEqual({ kind: 'reset' });
  });

  test("'gone' 未达阈值 ⇒ wait，计数 +1", () => {
    const probe: ChatProbe = { status: 'gone', reason: 'http 404' };
    expect(decideHealthAction(probe, 0, THRESHOLD)).toEqual({
      kind: 'wait',
      nextCount: 1,
    });
    expect(decideHealthAction(probe, 1, THRESHOLD)).toEqual({
      kind: 'wait',
      nextCount: 2,
    });
  });

  test("'gone' 达阈值 ⇒ confirmed_gone（携带 reason）", () => {
    const probe: ChatProbe = { status: 'gone', reason: 'http 403 forbidden' };
    expect(decideHealthAction(probe, 2, THRESHOLD)).toEqual({
      kind: 'confirmed_gone',
      reason: 'http 403 forbidden',
    });
  });

  test("'gone' 计数已超阈值仍 confirmed_gone（幂等）", () => {
    const probe: ChatProbe = { status: 'gone', reason: 'http 404 not found' };
    expect(decideHealthAction(probe, 5, THRESHOLD)).toMatchObject({
      kind: 'confirmed_gone',
    });
  });
});

/**
 * 回归断言：复现本次串台事故的场景。一次飞书 token 接口抖动让所有 bound 群的
 * probe 都变成 'unknown' —— 必须做到零计数累加、零善后调用。
 */
describe('回归：所有群 probe=unknown 时零破坏', () => {
  test('模拟 N 个 bound 群全部 unknown：计数 Map 不变、无 confirmed_gone', () => {
    const failCounts = new Map<string, number>();
    const confirmedGoneCalls: string[] = [];

    const jids = ['feishu:g1', 'feishu:g2', 'feishu:g3', 'feishu:g4', 'feishu:g5'];
    // token 接口抖动：所有群同时返回 unknown
    const probe: ChatProbe = {
      status: 'unknown',
      reason: 'transport error: EADDRNOTAVAIL',
    };

    for (const jid of jids) {
      const action = decideHealthAction(
        probe,
        failCounts.get(jid) ?? 0,
        THRESHOLD,
      );
      // 复刻 index.ts 健康检查 switch 的动作路由
      switch (action.kind) {
        case 'skip':
          break; // 关键：不碰 failCounts
        case 'reset':
          failCounts.delete(jid);
          break;
        case 'wait':
          failCounts.set(jid, action.nextCount);
          break;
        case 'confirmed_gone':
          failCounts.set(jid, THRESHOLD);
          confirmedGoneCalls.push(jid);
          break;
      }
    }

    // 根治点：零计数累加
    expect(failCounts.size).toBe(0);
    // 根治点：零善后调用（无群被解绑/删除）
    expect(confirmedGoneCalls).toEqual([]);
  });

  test('对比：若同样的群真失效（gone），跨阈值后才逐群确认', () => {
    const failCounts = new Map<string, number>();
    const confirmedGoneCalls: string[] = [];
    const jid = 'feishu:dead';
    const probe: ChatProbe = { status: 'gone', reason: 'http 404 not found' };

    // 连续 THRESHOLD 轮才确认一次
    for (let round = 0; round < THRESHOLD; round++) {
      const action = decideHealthAction(
        probe,
        failCounts.get(jid) ?? 0,
        THRESHOLD,
      );
      if (action.kind === 'wait') failCounts.set(jid, action.nextCount);
      else if (action.kind === 'confirmed_gone') {
        failCounts.set(jid, THRESHOLD);
        confirmedGoneCalls.push(jid);
      }
    }

    expect(confirmedGoneCalls).toEqual([jid]);
  });
});
