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
