/**
 * IM 绑定健康检查的纯决策逻辑。
 *
 * 抽成纯函数是为了可单测，也为了把"破坏性自动化只能基于针对该群的确定性否定
 * 证据"这条根治原则集中在一处表达清楚：
 *
 * - 'unknown'（我方/传输故障：token 抖动、网络错误、超时、429、5xx、client 未就绪）
 *   携带零信息量 → 既不累加失败计数，也不触发任何善后动作。这是本次串台事故的
 *   根治点：一次飞书 token 接口抖动会让所有 bound 群 probe='unknown'，必须全部
 *   走 'skip'，零计数累加、零善后调用。
 * - 'gone'（针对该群的确定性否定：404 / 403）→ 累加该群自身的失败计数；达到阈值
 *   才确认失效（'confirmed_gone'），否则继续等待（'wait'）。判断纯 per-group，
 *   不掺入任何"多群/数量"信号。
 * - 'ok' → 重置该群的失败计数。
 * - 'unsupported'（渠道不支持 getChatInfo，如 Telegram/QQ）→ skip。
 */
import type { ChatProbe } from '../types.js';

export type HealthAction =
  | { kind: 'skip' } // 不做任何事（unknown / unsupported）
  | { kind: 'reset' } // 重置失败计数（ok）
  | { kind: 'wait'; nextCount: number } // gone 但未达阈值，累加计数后等待
  | { kind: 'confirmed_gone'; reason: string }; // gone 且达阈值，确认失效

/**
 * 给定一次探测结果、该群当前失败计数、阈值，返回应执行的动作。
 *
 * 关键不变量：probe.status === 'unknown' 永远返回 { kind: 'skip' }，绝不读取或
 * 改变 currentCount。
 */
export function decideHealthAction(
  probe: ChatProbe,
  currentCount: number,
  threshold: number,
): HealthAction {
  switch (probe.status) {
    case 'unsupported':
      return { kind: 'skip' };
    case 'unknown':
      // 我方/传输故障，零信息量 —— 绝不累加、绝不动绑定（根治点）
      return { kind: 'skip' };
    case 'ok':
      return { kind: 'reset' };
    case 'gone': {
      const nextCount = currentCount + 1;
      if (nextCount >= threshold) {
        return { kind: 'confirmed_gone', reason: probe.reason };
      }
      return { kind: 'wait', nextCount };
    }
  }
}
