import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * device-code 登录必须自动落库，不能依赖用户回来点确认。
 *
 * codex / grok 的一键登录是同一套形状：后端 `/oauth/start` spawn CLI 的
 * `login --device-auth`，CLI 在临时 HOME 里完成授权并写下 auth.json；前端必须再
 * 调一次 `/oauth/complete`，后端才会把它存进加密的 provider 配置。
 *
 * 前端不轮询的话，整条链路就是「点登录 → 浏览器授权 → **回来再点一次确认**」。
 * 但浏览器授权成功后那边就提示完成了，没人会想到还要回到 HappyClaw 再点一下。
 * 于是 auth.json 躺在 flow 目录里没人取，15 分钟后 TTL 清理 `rmSync` 掉整个目录，
 * **连同那份有效凭据一起删掉** —— 全程零报错，用户只看到「设置里还是旧凭据」。
 *
 * 生产实测（2026-07-29，grok）：02:34 的 flow 目录里 auth.json 确实生成了，
 * provider 配置的 updatedAt 还停在两天前，02:49 被 TTL 清理，凭据永久丢失。
 *
 * Claude 不在此列 —— 它要求用户把授权码**粘贴**回来，不粘贴就什么都不会发生，
 * 不存在「以为完成了其实没有」，也没有 CLI 往磁盘写下、可被删掉的凭据。
 */
const DEVICE_FLOW_SECTIONS = [
  ['grok', 'web/src/components/settings/GrokProviderSection.tsx'],
  ['codex', 'web/src/components/settings/GptProviderSection.tsx'],
] as const;

describe('device-code 登录的自动落库', () => {
  for (const [runtime, file] of DEVICE_FLOW_SECTIONS) {
    test(`${runtime}: 授权后自动轮询 /oauth/complete`, () => {
      const source = read(file);
      expect(source).toContain(`/api/config/${runtime}/oauth/complete`);
      expect(
        /setInterval\(/.test(source),
        '没有轮询 = 用户授权成功后凭据会被 TTL 静默删掉',
      ).toBe(true);
      // 轮询必须能停：成功 / 硬错误 / flow 过期。
      expect(source).toMatch(/clearInterval\(/);
      expect(source).toMatch(/expiresAt/);
    });

    test(`${runtime}: 轮询把 409 当「尚未完成」而不是错误`, () => {
      const source = read(file);
      // 后端在授权未完成时返回 409。轮询里若把它当错误弹出来，用户每 3 秒看到
      // 一次「登录尚未完成」——等于把可用的自动流程变成噪音。
      expect(source).toContain('409');
      expect(source).toMatch(/'pending'/);
    });

    test(`${runtime}: 保留手动确认入口`, () => {
      // 轮询是兜底，不是替代：网络抖动或轮询被卡住时，用户仍要能自己触发一次。
      expect(read(file)).toContain('我已完成授权');
    });
  }

  test('Claude 走粘贴授权码，不需要轮询', () => {
    const source = read('web/src/components/settings/ProviderEditor.tsx');
    expect(source).toContain('/api/config/claude/oauth/callback');
    // 粘贴式流程的凭据只存在于用户剪贴板，后端不会先落一份到磁盘再等确认，
    // 所以没有「授权成功但凭据被删」这条路径。
    expect(source).toMatch(/oauthCode/);
  });
});
