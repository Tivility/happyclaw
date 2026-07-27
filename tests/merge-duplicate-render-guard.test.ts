import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * 合并伤的护栏：**两侧实现都留下**。
 *
 * upstream 合并里反复出现同一种形态 —— 本地和 upstream 各有一套实现，解冲突时
 * 两边都保留下来，于是同一件事做了两遍。tsc 完全干净（两套都是合法代码），
 * 测试也不一定覆盖，往往要等用户反馈才发现：
 *
 * | 症状 | 重复的两侧 |
 * |---|---|
 * | Web 聊天区渲染两遍（两个输入框、两条横幅） | 本地的话题侧栏块 + upstream 的主对话画布块 |
 * | 每条回复发两次、DB 落两行 | 本地 `sendMessage` + upstream `sendMessageWithOutcome` |
 * | 用量入库双计、日汇总翻倍 | 本地 INSERT + upstream 的事件转发 |
 *
 * 这里盯住可以静态检查的那几处。
 */
describe('合并去重护栏', () => {
  test('ChatView 只有一套聊天主体容器', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    // 这个 className 组合是「消息区 + 右侧面板」的外层容器，出现两次就意味着
    // 整个聊天区（含 MessageInput）被渲染了两遍。
    const bodies = chatView.match(
      /flex-1 flex overflow-hidden min-h-0/g,
    );
    expect(bodies?.length ?? 0).toBe(1);
  });

  test('ChatView 的输入框数量与消息列表一致（每个视图各一套）', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const inputs = chatView.match(/<MessageInput\b/g)?.length ?? 0;
    const lists = chatView.match(/<MessageList\b/g)?.length ?? 0;
    // 三个视图：话题工作区会话 / 普通会话 tab / 主对话。
    expect(inputs).toBe(3);
    expect(lists).toBe(3);
    expect(inputs).toBe(lists);
  });

  test('每个 MessageInput 都带齐跟进卡与运行态参数', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    // 这些参数原本只挂在被删掉的那一块上。删块时漏搬 = 静默丢功能：
    // 跟进卡交互消失、停止按钮状态失准、上下文标签不显示。
    for (const prop of [
      'queuedFollowUps={queuedFollowUps}',
      'onFollowUpAction={',
      'isRunning={currentContextWaiting}',
      'contextLabel={currentContextName}',
    ]) {
      const n = chatView.split(prop).length - 1;
      expect(n, `${prop} 应出现 3 次（每个 MessageInput 一次），实际 ${n}`).toBe(
        3,
      );
    }
  });

  test('主回复只有一个 sdk_final 落库点', () => {
    const index = read('src/index.ts');
    // 本地 sendMessage 与 upstream sendMessageWithOutcome 都保留时，同一条回复
    // 会发两次、DB 落两行（Web 聊天记录每句显示两遍）。
    const n = index.split("sourceKind: result.sourceKind || 'sdk_final'").length - 1;
    expect(n).toBe(1);
  });

  test('流式卡片的 idle 态不被当成过期卡片丢弃', () => {
    const index = read('src/index.ts');
    // idle = 新建但还没被事件驱动过。丢弃它会形成鸡生蛋：第一个 stream event
    // 就把卡片扔掉 → 本轮再无卡片 → 飞书不发处理中卡片、metaRow 用量行也没载体。
    expect(index).toMatch(/sessionIdleUnused/);
    expect(index).toMatch(/!sessionIdleUnused/);
  });
});

describe('通知刷屏防护', () => {
  test('系统通知的幂等键按会话而非 turnId', () => {
    const index = read('src/index.ts');
    // 用 turnId 时每张出问题的卡片都是独立 turn，重启对账会各发一条 ——
    // 频繁重启后用户在群里看到一串同样的「异常中断」。
    expect(index).toMatch(
      /externalMessageId: `\$\{input\.route\.sourceJid\}:system-notice:/,
    );
    expect(index).not.toMatch(
      /externalMessageId: `\$\{input\.originalInputTurnId\}:system-notice:/,
    );
  });

  test('入库失败提醒有节流，不按每次重试发', () => {
    const feishu = read('src/feishu.ts');
    // durable Inbox 实测对同一条消息重试过 131 次，每次一条会刷满整屏。
    expect(feishu).toMatch(/shouldNotifyIntakeRetry\(chatId, messageId\)/);
    expect(feishu).toMatch(/INTAKE_RETRY_NOTICE_STEPS_MS/);
  });

  test('流式内容推送经过图片键过滤', () => {
    const card = read('src/feishu-streaming-card.ts');
    // Agent 常在正文写本地路径当图片，CardKit 只认 img_ 开头的 image_key，
    // 收到本地路径会整张卡片拒绝（code=200570）→ 卡片进 error 冻结 →
    // 后续内容推送与用量行 patch 全部打不进去。
    const live = card.slice(
      card.indexOf('private liveDisplayText()'),
      card.indexOf('private liveDisplayText()') + 800,
    );
    expect(live).toMatch(/optimizeMarkdownStyle\(/);
  });

  test('工作区消息合并不再要求 is_home', () => {
    const groups = read('src/routes/groups.ts');
    // 用户手动建的带专属 folder 的工作区 is_home=0，历史消息全在渠道 jid 下，
    // 只查自己的 web jid 会显示成「没有历史记录」。
    expect(groups).not.toMatch(/const queryJids = \[jid\];\s*\n\s*if \(group\.is_home\)/);
  });
});
