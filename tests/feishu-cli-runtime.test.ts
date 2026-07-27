import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  applyFeishuCliBindingToEnvLines,
  resolveFeishuCliBoundAccountId,
  resolveFeishuCliRuntimeBinding,
} from '../src/feishu-cli-runtime.js';
import type { ChannelAccount, ChannelTurnContext } from '../src/types.js';

function account(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'account-current',
    owner_user_id: 'owner-1',
    provider: 'feishu',
    name: 'Current Bot',
    secret_ref: 'channel-account:account-current',
    enabled: true,
    is_default: true,
    is_legacy_default: false,
    auth_mode: 'credentials',
    auth_status: 'authorized',
    transport_status: 'connected',
    status: 'connected',
    default_agent_profile_id: null,
    default_workspace_jid: null,
    last_error: null,
    connected_at: null,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function context(
  overrides: Partial<ChannelTurnContext> = {},
): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: 'account-current',
    sourceJid: 'feishu:chat#account:account-current#root:message',
    bot: { appId: 'cli_current' },
    chat: { id: 'chat' },
    message: { id: 'message' },
    ...overrides,
  };
}

function dependencies(
  current = account(),
  secret: Record<string, string | undefined> | null = {
    appId: 'cli_current',
    appSecret: 'secret-current',
  },
) {
  return {
    getChannelAccount: (id: string) =>
      id === current.id ? current : undefined,
    loadChannelAccountSecret: (secretRef: string) =>
      secretRef === current.secret_ref ? secret : null,
  };
}

describe('Feishu CLI runtime identity binding', () => {
  test('host mode leaves feishu-cli identity entirely to the host', () => {
    const source = fs.readFileSync(
      new URL('../src/container-runner.ts', import.meta.url),
      'utf8',
    );
    const hostRunner = source.slice(
      source.indexOf('export async function runHostAgent'),
      source.indexOf('export type AgentRunner'),
    );

    expect(hostRunner).not.toContain('resolveFeishuCliRuntimeBinding');
    expect(hostRunner).not.toContain('applyFeishuCliBinding');
    expect(hostRunner).not.toContain('FEISHU_APP_ID');
    expect(hostRunner).not.toContain('FEISHU_APP_SECRET');
  });

  test('prefers the exact turn account over the workspace account', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        channelContext: context(),
        workspaceChannelAccountId: 'account-workspace',
      },
      dependencies(),
    );

    expect(binding).toEqual({
      source: 'channel_account',
      accountId: 'account-current',
      appId: 'cli_current',
      appSecret: 'secret-current',
    });
  });

  test('uses the workspace account when the turn has no Feishu identity', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        workspaceChannelAccountId: 'account-current',
      },
      dependencies(),
    );

    expect(binding?.source).toBe('channel_account');
    expect(binding?.appId).toBe('cli_current');
  });

  test('leaves native container config untouched without a bound account', () => {
    const binding = resolveFeishuCliRuntimeBinding({});
    const lines = [
      'FEISHU_PROFILE=work',
      'FEISHU_OWNER_EMAIL=owner@example.com',
    ];

    expect(binding).toBeNull();
    applyFeishuCliBindingToEnvLines(lines, binding);
    expect(lines).toEqual([
      'FEISHU_PROFILE=work',
      'FEISHU_OWNER_EMAIL=owner@example.com',
    ]);
  });

  test('selects only a Feishu turn account before the workspace fallback', () => {
    // 工作区级回落现在要查账号 provider（本 fork 的 channel_account_id 可能指向
    // 微信/QQ 账号），所以这里必须注入 double —— 见下方「工作区级绑定的 provider
    // 判别」一节。turn 级命中时不查库，第一个断言不依赖注入。
    const deps = {
      getChannelAccount: (id: string) =>
        id === 'account-workspace'
          ? account({ id: 'account-workspace', name: 'Workspace Bot' })
          : undefined,
    };
    expect(
      resolveFeishuCliBoundAccountId(
        {
          channelContext: context(),
          workspaceChannelAccountId: 'account-workspace',
        },
        deps,
      ),
    ).toBe('account-current');
    expect(
      resolveFeishuCliBoundAccountId(
        {
          channelContext: context({
            provider: 'telegram',
            channelAccountId: 'telegram-account',
          }),
          workspaceChannelAccountId: 'account-workspace',
        },
        deps,
      ),
    ).toBe('account-workspace');
  });

  test.each([
    [
      'missing account',
      dependencies(account({ id: 'different' })),
      /no longer exists/,
    ],
    [
      'wrong owner',
      dependencies(account({ owner_user_id: 'owner-2' })),
      /does not belong/,
    ],
    ['disabled account', dependencies(account({ enabled: false })), /disabled/],
    [
      'incomplete secret',
      dependencies(account(), { appId: 'cli_current' }),
      /incomplete credentials/,
    ],
    [
      'stale context app',
      dependencies(account(), {
        appId: 'cli_other',
        appSecret: 'secret-other',
      }),
      /does not match/,
    ],
    [
      'unsafe secret',
      dependencies(account(), {
        appId: 'cli_current',
        appSecret: 'secret-current\nINJECTED=value',
      }),
      /invalid credential characters/,
    ],
  ])('fails closed for an explicitly bound %s', (_name, deps, error) => {
    expect(() =>
      resolveFeishuCliRuntimeBinding(
        {
          ownerUserId: 'owner-1',
          channelContext: context(),
        },
        deps,
      ),
    ).toThrow(error);
  });

  test('overlays the bound Bot and removes inherited user-token overrides', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        channelContext: context(),
      },
      dependencies(),
    );
    const lines = [
      'FEISHU_APP_ID=cli_workspace',
      'FEISHU_APP_SECRET=secret-workspace',
      'FEISHU_USER_ACCESS_TOKEN=stale-user-token',
      'FEISHU_PROFILE=workspace',
      'KEEP=yes',
    ];

    applyFeishuCliBindingToEnvLines(lines, binding);

    expect(lines).toEqual([
      'FEISHU_PROFILE=workspace',
      'KEEP=yes',
      'FEISHU_APP_ID=cli_current',
      'FEISHU_APP_SECRET=secret-current',
    ]);
  });
});

/**
 * 工作区级绑定必须先看 provider。
 *
 * upstream 的模型里 `registered_groups.channel_account_id` 就是「这个工作区绑的
 * 飞书 Bot」；本 fork 里这一列存的是**任意渠道**的账号 —— 微信 / QQ 绑定同样写在
 * 这里。upstream 4367fd0 引入工作区级回落后，不看 provider 就把微信账号当飞书 Bot
 * 交给 fail-closed 的 resolveFeishuCliRuntimeBinding，直接抛 "wrong provider"。
 *
 * 后果是**容器模式下绑了微信账号的工作区完全起不来**（合并当天在生产实测命中
 * 两个用户的微信主容器）。typecheck 与全量测试都不报 —— 只有拿真实数据跑挂载
 * 构建才会暴露。
 *
 * 下面同时钉住两个方向：工作区级的非飞书账号视同未绑定放行，turn 级的错配仍然
 * 拦住（那是真的配置错乱/越权信号，不能一起放宽）。
 */
describe('工作区级绑定的 provider 判别', () => {
  const wechatAccount = account({
    id: 'account-wechat',
    provider: 'wechat',
    name: 'WeChat Bot',
    secret_ref: 'channel-account:account-wechat',
  });

  test('工作区绑的是微信账号 —— 视同未绑定飞书 Bot，返回 null', () => {
    expect(
      resolveFeishuCliBoundAccountId(
        { workspaceChannelAccountId: 'account-wechat' },
        { getChannelAccount: () => wechatAccount },
      ),
    ).toBeNull();
  });

  test('同一场景下完整解析不抛错，容器可正常启动', () => {
    expect(
      resolveFeishuCliRuntimeBinding(
        {
          ownerUserId: 'owner-1',
          workspaceChannelAccountId: 'account-wechat',
        },
        {
          getChannelAccount: () => wechatAccount,
          loadChannelAccountSecret: () => null,
        },
      ),
    ).toBeNull();
  });

  test('工作区绑的是飞书账号 —— 正常返回该 id', () => {
    expect(
      resolveFeishuCliBoundAccountId(
        { workspaceChannelAccountId: 'account-current' },
        { getChannelAccount: () => account() },
      ),
    ).toBe('account-current');
  });

  test('绑定悬空（账号已删）不静默退化为未绑定，留给下游报 not exists', () => {
    expect(
      resolveFeishuCliBoundAccountId(
        { workspaceChannelAccountId: 'account-gone' },
        { getChannelAccount: () => null },
      ),
    ).toBe('account-gone');
    expect(() =>
      resolveFeishuCliRuntimeBinding(
        { ownerUserId: 'owner-1', workspaceChannelAccountId: 'account-gone' },
        {
          getChannelAccount: () => null,
          loadChannelAccountSecret: () => null,
        },
      ),
    ).toThrow('no longer exists');
  });

  test('飞书 turn 带来的账号 provider 错配 —— 仍然 fail-closed，不受本次放宽影响', () => {
    expect(() =>
      resolveFeishuCliRuntimeBinding(
        {
          ownerUserId: 'owner-1',
          channelContext: context({ channelAccountId: 'account-wechat' }),
        },
        {
          getChannelAccount: () => wechatAccount,
          loadChannelAccountSecret: () => null,
        },
      ),
    ).toThrow('wrong provider');
  });

  test('turn 级账号优先于工作区级，且不做 provider 豁免', () => {
    // 微信工作区里来了一条飞书消息：应当用 turn 上的飞书账号，而不是工作区那个。
    expect(
      resolveFeishuCliBoundAccountId(
        {
          channelContext: context({ channelAccountId: 'account-turn' }),
          workspaceChannelAccountId: 'account-wechat',
        },
        { getChannelAccount: () => wechatAccount },
      ),
    ).toBe('account-turn');
  });
});
