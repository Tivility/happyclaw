import { loadChannelAccountSecret } from './channel-account-secrets.js';
import { getChannelAccount } from './db.js';
import type { ChannelAccount, ChannelTurnContext } from './types.js';

const FEISHU_CLI_CREDENTIAL_ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  // feishu-cli document commands prefer an explicit user token over the App
  // credentials. A token inherited through provider/custom env must therefore
  // not survive an exact container Bot binding.
  'FEISHU_USER_ACCESS_TOKEN',
] as const;

export class FeishuCliCredentialBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuCliCredentialBindingError';
  }
}

export interface FeishuCliRuntimeBinding {
  source: 'channel_account';
  accountId: string;
  appId: string;
  appSecret: string;
}

interface FeishuCliBindingDependencies {
  getChannelAccount: (id: string) => ChannelAccount | undefined;
  loadChannelAccountSecret: (
    secretRef: string,
  ) => Record<string, string | undefined> | null;
}

export interface ResolveFeishuCliRuntimeBindingInput {
  ownerUserId?: string | null;
  channelContext?: ChannelTurnContext;
  workspaceChannelAccountId?: string | null;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasUnsafeCredentialCharacters(value: string): boolean {
  return /[\u0000\r\n]/.test(value);
}

/**
 * Select the Bot identity a container run must use without reading secrets.
 * Host mode deliberately never calls this helper: feishu-cli on the host owns
 * its complete native environment/config resolution.
 *
 * 工作区级回落必须先看 provider。upstream 那边 `channel_account_id` 语义上就是
 * 「这个工作区绑的飞书 Bot」，本 fork 里它是**任意渠道**的账号 —— 微信 / QQ 绑定
 * 同样写在这一列。不加判断地回落，会把一个微信账号当成飞书 Bot 交给下游，而
 * `resolveFeishuCliRuntimeBinding()` 是 fail-closed 的，直接抛
 * 「wrong provider」让整个工作区起不来（实测命中 2 个用户的微信主容器）。
 *
 * 语义上「工作区绑的是微信账号」等于「没有绑飞书 Bot」，与无绑定同样返回 null。
 * turn 级账号不走这条豁免：飞书 turn 带来的账号 id 若 provider 不对，那是真的
 * 配置错乱或越权信号，仍然由下游 fail-closed 拦住。
 */
export function resolveFeishuCliBoundAccountId(
  input: Pick<
    ResolveFeishuCliRuntimeBindingInput,
    'channelContext' | 'workspaceChannelAccountId'
  >,
  dependencies?: Pick<FeishuCliBindingDependencies, 'getChannelAccount'>,
): string | null {
  const isFeishuTurn = input.channelContext?.provider === 'feishu';
  const turnAccountId = isFeishuTurn
    ? optionalTrimmed(input.channelContext?.channelAccountId)
    : null;
  if (turnAccountId) return turnAccountId;

  const workspaceAccountId = optionalTrimmed(input.workspaceChannelAccountId);
  if (!workspaceAccountId) return null;
  // 依赖在这里才解析，不写成默认参数：默认参数每次调用都会求值，而多数调用方
  // （如 group-queue 只传 channelContext）根本走不到查库这一步。提前引用会让
  // 那些只 mock 了部分 db 导出的测试无谓地炸。
  const account = (dependencies?.getChannelAccount ?? getChannelAccount)(
    workspaceAccountId,
  );
  // 账号查不到时保留原样返回：那是「绑定悬空」，应由 resolveFeishuCliRuntimeBinding
  // 报 "no longer exists"，而不是在这里静默退化成「未绑定」。
  if (account && account.provider !== 'feishu') return null;
  return workspaceAccountId;
}

/**
 * Resolve the Feishu CLI identity for one Agent run.
 *
 * An exact inbound Feishu turn is authoritative. A workspace-level account is
 * used only when no turn-scoped account exists. With no bound account this
 * returns null and feishu-cli resolves any native container profile/config
 * without HappyClaw parsing it. Host-mode execution must not call this
 * resolver at all.
 *
 * Once a Feishu account is explicitly bound, failures are closed rather than
 * silently falling back to a different Bot identity.
 */
export function resolveFeishuCliRuntimeBinding(
  input: ResolveFeishuCliRuntimeBindingInput,
  dependencies: FeishuCliBindingDependencies = {
    getChannelAccount,
    loadChannelAccountSecret,
  },
): FeishuCliRuntimeBinding | null {
  const isFeishuTurn = input.channelContext?.provider === 'feishu';
  const turnAccountId = isFeishuTurn
    ? optionalTrimmed(input.channelContext?.channelAccountId)
    : null;
  // 依赖必须往下传：工作区级回落现在要查 provider，不转发的话注入的 double 会
  // 被绕过、穿透到真实 DB。
  const candidateAccountId = resolveFeishuCliBoundAccountId(
    input,
    dependencies,
  );

  if (!candidateAccountId) return null;

  const account = dependencies.getChannelAccount(candidateAccountId);
  if (!account) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this turn no longer exists',
    );
  }
  if (account.provider !== 'feishu') {
    throw new FeishuCliCredentialBindingError(
      'The channel account bound to this Feishu turn has the wrong provider',
    );
  }
  if (!input.ownerUserId || account.owner_user_id !== input.ownerUserId) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run does not belong to the workspace owner',
    );
  }
  if (!account.enabled) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run is disabled',
    );
  }

  const secret = dependencies.loadChannelAccountSecret(account.secret_ref);
  const appId = optionalTrimmed(secret?.appId);
  const appSecret = optionalTrimmed(secret?.appSecret);
  if (!appId || !appSecret) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run has incomplete credentials',
    );
  }
  if (
    hasUnsafeCredentialCharacters(appId) ||
    hasUnsafeCredentialCharacters(appSecret)
  ) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run has invalid credential characters',
    );
  }

  const contextAppId = optionalTrimmed(input.channelContext?.bot?.appId);
  if (turnAccountId && contextAppId && contextAppId !== appId) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu Bot identity for this turn does not match the bound account',
    );
  }

  return {
    source: 'channel_account',
    accountId: account.id,
    appId,
    appSecret,
  };
}

function bindingEnvironment(
  binding: FeishuCliRuntimeBinding,
): Record<string, string> {
  return {
    FEISHU_APP_ID: binding.appId,
    FEISHU_APP_SECRET: binding.appSecret,
  };
}

export function applyFeishuCliBindingToEnvLines(
  lines: string[],
  binding: FeishuCliRuntimeBinding | null,
): void {
  if (!binding) return;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      FEISHU_CLI_CREDENTIAL_ENV_KEYS.some((key) =>
        lines[index]?.startsWith(`${key}=`),
      )
    ) {
      lines.splice(index, 1);
    }
  }
  for (const [key, value] of Object.entries(bindingEnvironment(binding))) {
    lines.push(`${key}=${value}`);
  }
}
