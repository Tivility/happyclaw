# 合并内部设计：六项待补详细设计

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 上游依据：`docs/upstream-merge-plan.md`（决策台账 + 方案骨架）· `docs/upstream-decision-tree.md` · `docs/upstream-silent-changes.md`
> 本文只做**设计**，不重复分析。每节给：数据结构 / 函数签名 / 迁移步骤 / 失败模式 / 回滚。
> 编制：2026-07-26

## 索引

| # | 设计 | 对应决策 | 落在哪个阶段 |
|---|---|---|---|
| 1 | 多账号 `channel_accounts` | 决策 18 / 19 | 阶段 5 |
| 2 | 绑定解析五出口 | 决策 16（D2.3 选项 D） | 阶段 2 前置 |
| 3 | 工作区投影按 folder | 决策 8（D1.4） | 阶段 2（数据库前置） |
| 4 | 宿主机并发闸 | 决策 73（D4.3b 选项 C） | 阶段 2 |
| 5 | 两张会话表的权威 + 派生 | 决策 12 / 13 | 阶段 2（数据库前置） |
| 6 | 用量与配额的运行时分口径 | 决策 40 / 41 / 42 / 66 | 阶段 2 静默杀手 #2 |

**依赖关系**：设计 3 必须先于设计 5（投影的 `workspace_jid` 取自 folder→jid 的规范映射，两处必须用同一个函数）。设计 2 必须先于阶段 2 的 merge（否则合并当天两个 member 失联）。设计 1 依赖设计 2（账号片段进入 JID 后，解析器必须已经区分「没覆盖」和「解不出来」）。

---

# 设计 1 · 多账号（`channel_accounts`）

## 1.0 设计约束（已定，不再讨论）

1. **不重写历史 JID。** 13741 条 `messages.chat_jid`、64 行 `registered_groups.jid` 一个字节不动。
2. **没有 `#account:` 片段的 JID ≡ 该渠道的默认账号**（`is_legacy_default = 1` 那一行）。
3. **凭据留在文件里**，继续用 `runtime-config.ts` 现有的 AES-256-GCM（`encryptChannelSecret` / `decryptChannelSecret` / `writeSecretFile`）。数据库只存元数据，**不存密钥、不存密文**。
4. 只有给某个渠道加**第二个**账号时，那个账号的新会话才带片段。

## 1.1 `channel_accounts` 表 schema

对 upstream 定义（`git show upstream/main:src/db.ts` 第 627–652 行）做三处适配：

| upstream | 本地 | 为什么 |
|---|---|---|
| `secret_ref` 指向 `data/config/channel-accounts/{id}.json`（新目录 + 新密钥文件 `claude-provider.key`） | `secret_ref` 是**寻址串**，解析到 `data/config/user-im/...` 下的现有布局 | 保留现有加密实现 = 风险面不变；不引入第二个密钥文件 |
| 无 | 追加 `secret_layout` 列 | 迁移期同时存在「旧路径」「新路径」两种寻址，需要显式记录而不是靠字符串前缀猜 |
| `UNIQUE(owner_user_id, provider, name)` | 同 | 保留 |

```sql
CREATE TABLE IF NOT EXISTS channel_accounts (
  id                       TEXT PRIMARY KEY,          -- crypto.randomUUID()
  owner_user_id            TEXT NOT NULL,
  provider                 TEXT NOT NULL,             -- ChannelProvider，值域以 shared/channel-prefixes.ts 为准
  name                     TEXT NOT NULL,             -- 用户可见名，默认 '默认账号'
  secret_ref               TEXT NOT NULL UNIQUE,      -- 见 §1.2
  secret_layout            TEXT NOT NULL DEFAULT 'legacy',  -- 'legacy' | 'per_account'
  enabled                  INTEGER NOT NULL DEFAULT 1,
  is_default               INTEGER NOT NULL DEFAULT 0,
  is_legacy_default        INTEGER NOT NULL DEFAULT 0,  -- 唯一一行「无片段 JID 归它」
  auth_mode                TEXT NOT NULL DEFAULT 'credentials',   -- credentials | bot_token | qr_session
  auth_status              TEXT NOT NULL DEFAULT 'draft',         -- draft | authorized | expired | error
  transport_status         TEXT NOT NULL DEFAULT 'disconnected',  -- disconnected | connecting | reconnecting | connected | error
  status                   TEXT NOT NULL DEFAULT 'disconnected',  -- @deprecated transport_status 的兼容投影
  default_agent_profile_id TEXT,
  default_workspace_jid    TEXT,
  last_error               TEXT,
  connected_at             TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE(owner_user_id, provider, name)
);
CREATE INDEX IF NOT EXISTS idx_channel_accounts_owner_provider
  ON channel_accounts(owner_user_id, provider, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_one_default
  ON channel_accounts(owner_user_id, provider) WHERE is_default = 1;
-- 本地新增：无片段 JID 的归属必须唯一，否则路由二义
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_one_legacy
  ON channel_accounts(owner_user_id, provider) WHERE is_legacy_default = 1;
```

`idx_channel_accounts_one_legacy` 是本地独有的、也是整个方案的**数据库级安全绳**：只要它存在，就不可能出现「两个账号都声称拥有无片段 JID」。upstream 靠代码保证，本地靠索引保证。

TypeScript 侧（`src/types.ts`，与 upstream 的 `ChannelAccount` 同名同形，只多 `secret_layout`）：

```ts
export type ChannelProvider =
  | 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord' | 'whatsapp';
export type ChannelAuthMode = 'credentials' | 'bot_token' | 'qr_session';
export type ChannelAuthStatus = 'draft' | 'authorized' | 'expired' | 'error';
export type ChannelTransportStatus =
  | 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error';
export type ChannelSecretLayout = 'legacy' | 'per_account';

export interface ChannelAccount {
  id: string;
  owner_user_id: string;
  provider: ChannelProvider;
  name: string;
  secret_ref: string;
  secret_layout: ChannelSecretLayout;
  enabled: boolean;
  is_default: boolean;
  is_legacy_default: boolean;
  auth_mode: ChannelAuthMode;
  auth_status: ChannelAuthStatus;
  transport_status: ChannelTransportStatus;
  status: ChannelTransportStatus;          // @deprecated
  default_agent_profile_id: string | null;
  default_workspace_jid: string | null;
  last_error: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 前端可见投影：绝不包含 secret_ref / secret_layout。 */
export type ChannelAccountPublic = Omit<
  ChannelAccount, 'secret_ref' | 'secret_layout'
> & {
  hasSecret: boolean;
  connected: boolean;
  boundChatCount: number;
};
```

DB 访问函数（`src/db.ts`，命名与 upstream 对齐，避免下次合并再改一遍）：

```ts
export function createChannelAccount(input: Omit<ChannelAccount,
  'created_at' | 'updated_at' | 'status' | 'transport_status'> &
  Partial<Pick<ChannelAccount, 'transport_status'>>): ChannelAccount;
export function getChannelAccount(id: string): ChannelAccount | undefined;
export function getChannelAccountForUser(id: string, ownerUserId: string): ChannelAccount | undefined;
export function getDefaultChannelAccount(ownerUserId: string, provider: ChannelProvider): ChannelAccount | undefined;
export function getLegacyChannelAccount(ownerUserId: string, provider: ChannelProvider): ChannelAccount | undefined;
export function listChannelAccountsForUser(ownerUserId: string): ChannelAccount[];
export function listEnabledChannelAccounts(): ChannelAccount[];
export function updateChannelAccount(id: string, ownerUserId: string,
  patch: Partial<Pick<ChannelAccount,
    'name' | 'enabled' | 'is_default' | 'default_agent_profile_id' | 'default_workspace_jid'>>
): ChannelAccount | undefined;
export function updateChannelAccountStatus(id: string,
  transport: ChannelTransportStatus, lastError?: string | null): void;
export function updateChannelAccountAuthStatus(id: string,
  auth: ChannelAuthStatus, lastError?: string | null): void;
export function countChannelAccountBindings(id: string): number;
export function deleteChannelAccount(id: string, ownerUserId: string): boolean;
```

`deleteChannelAccount` 内部一个事务：`DELETE FROM channel_accounts` + `UPDATE registered_groups SET channel_account_id = NULL WHERE channel_account_id = ?`。**不删 registered_groups 行、不删消息**——账号删掉不等于聊天历史删掉。若被删的是 `is_legacy_default` 行，事务内把同 provider 最早创建的另一个账号提升为 `is_legacy_default = 1`；没有其他账号则允许 legacy 位为空（此时无片段 JID 暂无归属，由 §1.6 的 fail-soft 分支兜底）。

## 1.2 凭据寻址：`secret_ref` 的两种布局

```
legacy       secret_ref = 'user-im-legacy:{userId}:{provider}'
             → data/config/user-im/{userId}/{provider}.json          ← 现存的 7 份文件，原地不动

per_account  secret_ref = 'user-im:{userId}:{accountId}'
             → data/config/user-im/{userId}/accounts/{accountId}/{provider}.json
```

WhatsApp 的 Baileys 登录态另有目录，同样两套：

```
legacy       data/config/user-im/{userId}/whatsapp-auth/{accountId|'default'}/   ← getWhatsAppAuthDir 现状
per_account  data/config/user-im/{userId}/accounts/{accountId}/whatsapp-auth/
```

**实现方式：不新写加解密，只把现有 7 组 getter/setter 加一个可选参数。** `src/runtime-config.ts`：

```ts
// 现在（第 3696 行）
function userImDir(userId: string): string;

// 改成
function userImDir(userId: string, accountId?: string | null): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid userId');
  if (accountId != null) {
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Invalid accountId');
    return path.join(USER_IM_CONFIG_DIR, userId, 'accounts', accountId);
  }
  return path.join(USER_IM_CONFIG_DIR, userId);
}
```

七组读写函数各加尾参（**尾参、可选**，所有现有调用点零改动、行为逐字节相同）：

```ts
export function getUserFeishuConfig(userId: string, accountId?: string | null): UserFeishuConfig | null;
export function saveUserFeishuConfig(userId: string, next: Omit<UserFeishuConfig,'updatedAt'>, accountId?: string | null): UserFeishuConfig;
// 同形：Telegram / QQ / WeChat / DingTalk / Discord / WhatsApp
```

新增一个薄的分派层（`src/channel-account-secrets.ts`，本地版）：

```ts
export interface ChannelAccountSecretRefParts {
  layout: ChannelSecretLayout;
  userId: string;
  /** layout==='per_account' 时有值 */
  accountId: string | null;
  /** layout==='legacy' 时有值 */
  provider: ChannelProvider | null;
}

export function legacyChannelSecretRef(userId: string, provider: ChannelProvider): string;
export function perAccountChannelSecretRef(userId: string, accountId: string): string;
export function parseChannelSecretRef(ref: string): ChannelAccountSecretRefParts;

/** 按 account 读取该渠道的配置对象（返回值是各 provider 自己的 UserXxxConfig）。 */
export function loadChannelAccountConfig(account: ChannelAccount): UserChannelConfig | null;
export function saveChannelAccountConfig(account: ChannelAccount, next: UserChannelConfig): void;
export function hasChannelAccountSecret(account: ChannelAccount): boolean;
/** 删除 per_account 目录；legacy 布局下**不删**原文件，只返回 false。 */
export function deleteChannelAccountSecret(account: ChannelAccount): boolean;
/** 迁移期：把 legacy 文件复制到 per_account 路径并返回新 ref；不删旧文件。 */
export function promoteLegacySecretToAccountPath(
  account: ChannelAccount,
): { promoted: boolean; newRef: string; newLayout: ChannelSecretLayout };

export type UserChannelConfig =
  | { provider: 'feishu';   config: UserFeishuConfig }
  | { provider: 'telegram'; config: UserTelegramConfig }
  | { provider: 'qq';       config: UserQQConfig }
  | { provider: 'wechat';   config: UserWeChatConfig }
  | { provider: 'dingtalk'; config: UserDingTalkConfig }
  | { provider: 'discord';  config: UserDiscordConfig }
  | { provider: 'whatsapp'; config: UserWhatsAppConfig };
```

**过渡期怎么保留旧路径**：`is_legacy_default = 1` 的账号**永久停留在 `secret_layout='legacy'`**，除非运维显式跑 §1.8 的 M5。也就是说合并当天，磁盘上什么都没动，7 份配置文件路径不变，`/api/config/user-im/*` 旧路由继续写同一个文件。

## 1.3 `registered_groups.channel_account_id` 迁移与回填

**迁移语句**（`src/db.ts` 的 `runMigrations`，本地新版本 v64 起）：

```ts
ensureColumn('registered_groups', 'channel_account_id', 'TEXT');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_rg_channel_account
    ON registered_groups(channel_account_id);
`);
```

`parseGroupRow` / `setRegisteredGroup` 的列清单同步加 `channel_account_id`（`RegisteredGroup` 接口加 `channel_account_id?: string | null`）。

**回填逻辑**（`src/channel-account-migration.ts`，启动时在 `loadState()` 里、**建立任何 IM 连接之前**执行）：

```ts
export interface LegacyAccountSeedResult {
  created: ChannelAccount[];
  backfilled: number;
  skipped: Array<{ jid: string; reason: 'already_scoped' | 'no_owner' | 'no_account' }>;
}

/**
 * 从 data/config/user-im/{userId}/*.json 投影出每个 (user, provider) 的默认账号，
 * 并回填 registered_groups.channel_account_id。幂等：已有 is_legacy_default 行则跳过创建。
 */
export function seedLegacyChannelAccounts(): LegacyAccountSeedResult;
```

单账号的建立（对标 upstream 的 `ensureLegacyDefaultChannelAccount`，但**不复制凭据**）：

```ts
function ensureLegacyDefaultChannelAccount(input: {
  ownerUserId: string;
  provider: ChannelProvider;
  name: string;          // 默认 '默认账号'
  enabled: boolean;
}): ChannelAccount {
  const existing = getLegacyChannelAccount(input.ownerUserId, input.provider);
  if (existing) return existing;
  const currentDefault = getDefaultChannelAccount(input.ownerUserId, input.provider);
  return createChannelAccount({
    id: crypto.randomUUID(),
    owner_user_id: input.ownerUserId,
    provider: input.provider,
    name: input.name,
    secret_ref: legacyChannelSecretRef(input.ownerUserId, input.provider),
    secret_layout: 'legacy',                      // ← 关键：指向现有文件，不搬运
    enabled: input.enabled,
    is_default: currentDefault == null,
    is_legacy_default: true,
    auth_mode:
      input.provider === 'wechat' || input.provider === 'whatsapp' ? 'qr_session'
      : input.provider === 'telegram' || input.provider === 'discord' ? 'bot_token'
      : 'credentials',
    auth_status: 'authorized',                    // 已在盘上的凭据视为已授权
  });
}
```

**回填 SQL**（每个 legacy 账号一条，事务内跑）：

```sql
UPDATE registered_groups
   SET channel_account_id = :accountId
 WHERE created_by = :ownerUserId
   AND channel_account_id IS NULL
   AND jid LIKE :prefixPattern           -- 'feishu:%' 等，取自 CHANNEL_PREFIXES
   AND instr(jid, '#account:') = 0;      -- 已带片段的不动
```

`instr(jid,'#account:') = 0` 而不是 JS 侧 `parseChannelAddress(jid)?.legacy` —— 一条 SQL 原子完成，不需要把 64 行拉进 JS，也不会在中途崩溃留下半回填状态。

本地会被投影出的 7 行（依据 `upstream-silent-changes.md` §2.7 的实测）：admin 的 discord / wechat / feishu / qq，cxx 的 wechat / feishu，whz 的 wechat。

**顺序陷阱（upstream 踩过的坑，必须避开）**：`listEnabledChannelAccounts()` 在投影之前返回空。所以 `loadState()` 的顺序必须是

```
① seedLegacyChannelAccounts()      ← 无 IO 依赖，纯 DB + 读配置文件
② connectUserIMChannels()          ← 才开始建连接
```

而不是反过来。写一条启动断言：若 `listEnabledChannelAccounts().length === 0` 而 `data/config/user-im/` 下存在启用的配置文件，`logger.error` 并**继续用 legacy 路径连**（fail-soft，不 fail-closed —— 见 §1.9 F3）。

## 1.4 JID 片段的生成与解析

直接移植 upstream 的 `src/channel-address.ts`（无改动，它已经是纯函数、无依赖、且 `legacy: !account` 语义正是我们要的）。要补的是**与本地既有片段体系的交互规则**。

本地 JID 上已经存在四种片段：

| 片段 | 产生处 | 消费处 |
|---|---|---|
| `#account:{id}` | 本设计新增 | `channel-address.ts` |
| `#thread:{id}` / `#root:{id}` | `buildFeishuThreadRouteJid`（`index.ts:9802`） | `parseFeishuRouteTarget`（`feishu.ts`） |
| `#agent:{id}` | `buildResolveEffectiveChatJid` / `resolveBoundChatTarget` | `GroupQueue.isVirtualJid` |
| `#task:{id}` | `GroupQueue` 任务虚拟 JID | `GroupQueue.isVirtualJid` |

**规则（三条，写进 `channel-address.ts` 的模块注释）**：

1. **`#account:` 永远排第一**。`scopeChannelJid` 的实现已经是 `fragments.unshift(...)`，保持。
2. **`#agent:` / `#task:` 是主进程内部虚拟片段，永远排最后**，且**绝不出现在发给 provider 的 JID 上**。`extractProviderTarget()` 只剥 `#account:`，所以 `#agent:` 必须在更外层就已经被 `resolveBoundChatTarget` 拆掉——现状已经如此，不需要改。
3. `parseFeishuRouteTarget(raw)` 对未知片段是**忽略**语义（只挑 `thread:` / `root:`），`chatId` 取第一个 `#` 之前的部分。加了 `#account:` 之后：
   - `parseFeishuRouteTarget('oc_xxx#account:A#thread:T#root:R').chatId === 'oc_xxx'` ✔ 出站正确
   - `.raw === 'oc_xxx#account:A#thread:T#root:R'` ✔ 作为 `ackReactionByChat` 的键**天然按账号分槽**，是想要的
   - **无需改动**。写一条单测钉住这个行为。

`buildFeishuThreadRouteJid` 需要一处改动：

```ts
// index.ts:9802 现状
function buildFeishuThreadRouteJid(chatJid, threadId, rootMessageId) {
  return `feishu:${extractChatId(chatJid)}#thread:${threadId}#root:${rootMessageId}`;
}
// 改后：extractChatId 会把 '#account:' 一起带过来（它只剥前缀），
// 结果自然是 feishu:oc_xxx#account:A#thread:T#root:R —— 片段顺序正确，无需额外代码。
// 但要加断言：若 chatJid 带 #agent:/#task:，抛错（那种 jid 不该走到这里）。
```

出站路径的唯一硬改动：`src/im-channel.ts` 的 `extractChatId()`。它现在只剥 `provider:` 前缀，会把 `#account:` 原样传给 provider SDK。

```ts
// im-channel.ts 现状
export function extractChatId(jid: string): string {
  for (const prefix of Object.values(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) return jid.slice(prefix.length);
  }
  return jid;
}
// 改后：转发到 channel-address 的 extractProviderTarget（它剥前缀 + 剥 #account:，
// 保留 #thread:/#root: 给飞书自己解析）
export { extractProviderTarget as extractChatId } from './channel-address.js';
```

这一处是**整个设计里唯一「改错就全渠道发不出消息」的地方**，配套单测：七个渠道 ×（带片段 / 不带片段）= 14 个断言。

## 1.5 `IMConnectionManager` 的键从 `(userId, channel)` 改成 `(userId, channel, accountId)`

### 1.5.1 键与私有状态

```ts
class IMConnectionManager {
  private connections = new Map<string, UserIMConnection>();   // 不变，key = userId
  // UserIMConnection.channels 的 key 从 channelType 改成 channelKey
  private channelLocks = new Map<string, Promise<unknown>>();  // key 从 `${userId}:${channelType}` 改成 `${userId}:${channelKey}`
  private lastWhatsAppState = new Map<string, WhatsAppConnectionStateSnapshot>(); // key 改成 whatsAppStateKey()

  /** accountId 为空 ⇒ 退化成现在的 channelType，legacy 行为逐字节不变。 */
  private channelKey(channelType: string, accountId?: string | null): string {
    return accountId ? `${channelType}\u0000${accountId}` : channelType;
  }
  private whatsAppStateKey(userId: string, accountId?: string | null): string {
    return `${userId}\u0000${accountId || 'legacy'}`;
  }
}
```

`\u0000` 作分隔符（同 upstream）：`channelType` 与 UUID 都不可能含 NUL，键不会二义。

### 1.5.2 受影响的方法

**签名要改的（10 个）**

| 方法 | 现签名 | 新签名 |
|---|---|---|
| `connectChannel` | `(userId, channelType, channel, opts)` | `(userId, channelType, channel, opts, accountId?: string \| null)` |
| `disconnectChannel` | `(userId, channelType)` | `(userId, channelType, accountId?: string \| null)` |
| `disconnectChannelLocked` | `(userId, channelType)` | `(userId, channelKey)` ← 内部直接收组合键 |
| `connectUserFeishu` … `connectUserWhatsApp`（7 个） | `(userId, config, onNewChat, …)` | 各自的 `config` 类型加 `accountId?: string` 字段（**不加位置参数**，避免 7 处调用点全改形状） |
| `logoutUserWhatsApp` | `(userId, accountId?)` | 已有 `accountId`，语义从「目录名」变成「账号 id」 |
| `getUserWhatsAppState` | `(userId)` | `(userId, accountId?: string \| null)` |
| `disconnectAllUserChannels` | `(userId)` | 不变（遍历 `conn.channels.keys()`，键已含 accountId） |
| `getConnectedChannelTypes` | `(userId): string[]` | `(userId): Array<{ channelType: string; accountId: string \| null }>` |
| `isXxxConnected(userId)`（7 个） | `(userId)` | `(userId, accountId?: string \| null)`；不传 ⇒「该用户该渠道**任一**账号已连」 |
| `getXxxConnection(userId)`（3 个） | `(userId)` | `(userId, accountId?: string \| null)`；不传 ⇒ 返回 legacy 默认账号的连接 |

**签名不变、内部要改的（6 个）**

- `sendMessage` / `sendImage` / `sendFile` / `setTyping` / `clearAckReaction` / `createStreamingSession`：都走 `findChannelForJid(jid, channelType)` + `extractChatId(jid)`。前者见 §1.5.3，后者见 §1.4。**这六个方法的代码一行不用改**——修 `extractChatId` 与 `findChannelForJid` 就够了。这是这套设计最大的省力点。

### 1.5.3 `findChannelForJid` 的新解析顺序

```ts
private findChannelForJid(jid: string, channelType: string): IMChannel | undefined {
  // 1. 规范化到会话 JID（剥 #thread:/#root:/#agent:，保留 #account:）
  const baseJid = channelConversationJid(parseFeishuRouteTarget(jid).chatId
    ? jid : jid);            // 实际实现：channelConversationJid(jid)
  const scopedAccountId = parseChannelAddress(jid)?.channelAccountId ?? null;

  const group = registeredGroups[baseJid] ?? getRegisteredGroup(baseJid);
  if (!group?.created_by) return this.legacySiblingFallback(jid, channelType); // 见下

  // 2. 账号解析：JID 片段 > 注册记录的列 > 该 (user, provider) 的 legacy 默认账号
  const accountId =
    scopedAccountId
    ?? group.channel_account_id
    ?? getLegacyChannelAccount(group.created_by, channelType as ChannelProvider)?.id
    ?? null;

  const ch = this.connections.get(group.created_by)
    ?.channels.get(this.channelKey(channelType, accountId));
  if (ch?.isConnected()) return ch;

  // 3. accountId 解出来了但那条连接没起来：不要退到别的账号
  //    （会串台：用 A 号的 socket 往 B 号的群里发）
  if (accountId) return undefined;

  return this.legacySiblingFallback(jid, channelType);
}
```

**关键差异（本地保留、upstream 已删）**：现有的 sibling fallback（同 folder 的兄弟群 owner 的连接）**只在 `accountId === null` 时保留**。一旦能解出账号，宁可发不出去也不能借别人的 socket ——那是串台事故。upstream 直接把 fallback 整段删了；本地保留是因为 `wechat` folder 那一行 `created_by` 存在但历史上依赖过 fallback，直接删是行为回归。

### 1.5.4 渠道模块不感知账号：`normalizeIncomingJid`

入站方向**不改七个渠道的工厂签名**，而是在 `IMChannelConnectOpts` 加一个回调，由 manager 注入：

```ts
// src/im-channel.ts，IMChannelConnectOpts 新增
export interface IMChannelConnectOpts {
  // …现有 18 个字段不变…
  /** 把渠道自己拼出来的裸 JID 打上账号片段。未提供 = 恒等函数（legacy 默认账号）。 */
  normalizeIncomingJid?: (jid: string) => string;
}
```

manager 侧包装（对标 upstream 的 `scopeConnectOpts`）：

```ts
private scopeConnectOpts(
  opts: IMChannelConnectOpts,
  accountId?: string | null,
  userId?: string,
): IMChannelConnectOpts {
  const scope = (jid: string) => (accountId ? scopeChannelJid(jid, accountId) : jid);
  return {
    ...opts,
    normalizeIncomingJid: scope,
    onNewChat: (jid, name) => opts.onNewChat(scope(jid), name),
    // onCommand / onBotAddedToGroup / onBotRemovedFromGroup / onAgentMessage
    // 同样包一层 scope（它们的第一参都是 chatJid）
  };
}
```

七个渠道模块要改的**只有 JID 构造点**，每处形如：

```ts
const jid = opts.normalizeIncomingJid?.(`qq:c2c:${userOpenId}`) ?? `qq:c2c:${userOpenId}`;
```

实测构造点数量（`grep -cE "\`{provider}:"`）：

| 模块 | 构造点 | 备注 |
|---|---|---|
| `src/feishu.ts` | 6 | 含 `feishuRouteToJid`；`buildFeishuThreadRouteJid` 在 `index.ts` 侧，见 §1.4 |
| `src/telegram.ts` | 4 | |
| `src/qq.ts` | 5 | c2c / group 各一条主路径 |
| `src/wechat.ts` | 2 | |
| `src/dingtalk.ts` | 11 | 最多，含多处日志与下载目录拼接——**只改真正当 chatJid 用的那几处** |
| `src/discord.ts` | 5 | |
| `src/whatsapp.ts` | 用 `CHANNEL_PREFIX` 常量拼（第 45 行），构造点靠 `CHANNEL_PREFIX +` 定位 | |

`dingtalk.ts` 的 11 处要逐个判：拼给 `saveDownloadedFile()` 的路径**不能**带账号片段（会在磁盘上造出 `#account:` 目录名），拼给 `storeMessageDirect()` / `onNewChat()` 的**必须**带。这是七个模块里唯一需要人工分辨的。

### 1.5.5 热重连与状态广播

**热重连**（`PUT /api/config/user-im/{channel}` 与新的 `PATCH /api/channel-accounts/:id`）：粒度从「断开该用户该渠道」变成「断开该 accountId」。

```ts
// routes/config.ts 现状
await imManager.disconnectUserFeishu(userId);
await imManager.connectUserFeishu(userId, cfg, onNewChat, options);

// 改后
await imManager.disconnectChannel(userId, 'feishu', account.id);
await imManager.connectUserFeishu(userId, { ...cfg, accountId: account.id }, onNewChat, options);
```

`ignoreMessagesBefore` 仍设当前时间戳，但**只影响被重连的那个账号**——同渠道另一个账号的堆积消息不受影响。这是从「按渠道」到「按账号」最直接的用户可见收益。

**状态广播**：`whatsapp_status` WS 事件（`src/types.ts:587`、`src/web.ts:2543`）payload 加 `accountId`：

```ts
// WsMessageOut
| {
    type: 'whatsapp_status';
    userId: string;
    accountId: string | null;      // ← 新增；legacy 默认账号为 null
    state: WhatsAppConnectionState;
  }
export function broadcastWhatsAppStatus(
  userId: string,
  state: WhatsAppConnectionState,
  accountId?: string | null,       // ← 新增尾参，缺省 null
): void;
```

前端 `WhatsAppChannelCard.tsx`（第 93–96 行的订阅）改成按 `accountId` 过滤；`accountId === null` 的事件路由到 legacy 默认账号的卡片。

同时新增一个通用事件替代按渠道的一次性事件（后续 QR 类渠道复用）：

```ts
| {
    type: 'channel_account_status';
    accountId: string;
    ownerUserId: string;
    provider: ChannelProvider;
    transportStatus: ChannelTransportStatus;
    authStatus: ChannelAuthStatus;
    qrDataUrl?: string;
    lastError?: string | null;
  }
```

`whatsapp_status` 保留一个发布周期（双发），前端切完再删。

## 1.6 加第二个账号时会发生什么（端到端）

```
① 前端「新增账号」→ POST /api/channel-accounts {provider, name, credentials}
② 后端 createChannelAccount(is_legacy_default=0, is_default=0, secret_layout='per_account')
      → saveChannelAccountConfig 写 data/config/user-im/{u}/accounts/{id}/{provider}.json
③ imManager.connectChannel(userId, provider, ch, opts, accountId)
      scopeConnectOpts 注入 normalizeIncomingJid = jid => scopeChannelJid(jid, accountId)
④ 新账号收到第一条消息 → jid = 'feishu:oc_yyy#account:{id}'
      onNewChat 注册 registered_groups 行：jid 带片段、channel_account_id = accountId
⑤ 回复：findChannelForJid 从片段直接解出 accountId → 命中新账号的 socket
      extractChatId('feishu:oc_yyy#account:{id}') === 'oc_yyy' → 发给飞书
```

**第一个账号（legacy）在这个流程里完全没被触碰**：它的 JID 无片段、`secret_layout='legacy'`、文件路径原样、`normalizeIncomingJid` 是恒等函数。

**两个账号同时在同一个外部群里**：两条 `registered_groups` 行（`feishu:oc_zzz` 和 `feishu:oc_zzz#account:{id}`），各自独立的 folder / 会话 / 绑定。这是想要的语义，不是缺陷。

## 1.7 前端：统一账号管理页取代 8 个卡片

**删除**（8 个文件，`web/src/components/settings/`）：
`FeishuChannelCard.tsx` · `TelegramChannelCard.tsx` · `QQChannelCard.tsx` · `DingTalkChannelCard.tsx` · `DiscordChannelCard.tsx` · `WeChatChannelCard.tsx` · `WhatsAppChannelCard.tsx` · `WeChatQRDialog.tsx`

**新增**（取 upstream 同名文件，按本地渠道全集调整）：
- `web/src/components/settings/ChannelAccountsManager.tsx` —— 主界面：按 provider 分组、每组 N 个账号、每个账号一行（名称 / 连接状态 / 认证状态 / 默认标记 / 操作）
- `web/src/components/settings/channel-accounts/ProviderConnectionFields.tsx` —— 七个 provider 的凭据表单（从被删的 7 个卡片里把字段定义搬过来：feishu appId/appSecret、telegram botToken/proxyUrl、qq appId/appSecret、wechat botToken/ilinkBotId/baseUrl/cdnBaseUrl、dingtalk clientId/clientSecret/streamingMode、discord botToken/streamingMode、whatsapp phoneNumber）
- `web/src/components/settings/channel-accounts/QrOnboardingPanel.tsx` —— WhatsApp / WeChat 的二维码面板
- `web/src/stores/channel-accounts.ts` —— Zustand store（第 16 个）
- `web/src/utils/channel-accounts.ts` —— 纯函数：状态文案映射、默认账号判定

**改动**：
- `web/src/components/settings/UserChannelsSection.tsx` —— 从「渲染 8 个卡片」改成「渲染 `<ChannelAccountsManager/>`」
- `web/src/components/settings/channel-meta.tsx` —— 保留（provider 图标 / 名称 / 颜色），加 `authMode` 字段驱动表单类型
- `web/src/pages/SetupChannelsPage.tsx` —— 引导流程改成「选 provider → 建第一个账号」
- `web/src/hooks/useConnectedChannels.ts` —— 返回值从 `string[]` 改成 `Array<{provider, accountId, connected}>`
- `web/src/components/settings/PairingSection.tsx` —— 配对码从 per-user 变成 per-account（`POST /api/channel-accounts/:id/pairing-code`）
- `web/src/components/settings/BindingsSection.tsx` / `ImBindingRow.tsx` —— 绑定行显示所属账号

**后端路由**：新增 `src/routes/channel-accounts.ts`（取 upstream 结构，15 个端点），`/api/config/user-im/{channel}` 七组旧路由**保留**并改为「写 legacy 默认账号」的兼容层（对标 upstream 的 `syncDefaultChannelAccountCredentials`）。旧路由不删是因为 `SetupChannelsPage` 的老链接、以及任何脚本化调用不该在这一步断掉。

## 1.8 迁移步骤（M1–M6，每步独立可回滚）

| 步 | 做什么 | 可观测的验收 |
|---|---|---|
| **M1** | 建 `channel_accounts` 表 + 3 个索引；`registered_groups` 加 `channel_account_id` 列 + 索引 | `PRAGMA table_info` 有列；`SELECT COUNT(*) FROM channel_accounts` = 0；服务照常起，行为零变化 |
| **M2** | `seedLegacyChannelAccounts()`：从 7 份配置文件投影 7 行，全部 `is_legacy_default=1 / secret_layout='legacy'` | `SELECT COUNT(*) FROM channel_accounts` = 7；`SELECT COUNT(*) FROM channel_accounts WHERE secret_layout!='legacy'` = 0；磁盘 `data/config/user-im/` 无任何变化（`find -newer` 为空） |
| **M3** | 回填 `registered_groups.channel_account_id`（7 条 UPDATE） | `SELECT COUNT(*) FROM registered_groups WHERE channel_account_id IS NOT NULL` > 0；`SELECT COUNT(*) FROM messages` 仍 13741；`SELECT COUNT(DISTINCT chat_jid) FROM messages` 不变 |
| **M4** | `IMConnectionManager` 换键 + `extractChatId` 换实现 + 七渠道注入 `normalizeIncomingJid`（此时全部 accountId 为 legacy ⇒ 恒等） | 回归矩阵：7 渠道各收发一条，JID 无片段 |
| **M5**（可选，可无限期推迟） | `promoteLegacySecretToAccountPath`：把 legacy 文件**复制**到 `accounts/{id}/`，翻 `secret_layout='per_account'`，旧文件重命名为 `{provider}.json.migrated` 保留 | 复制后能解密出与旧文件逐字段相同的配置；连接照常 |
| **M6** | 前端换页 + `/api/channel-accounts` 上线 + 允许创建第二个账号 | 加第二个飞书账号能连上，且第一个账号的会话不受影响 |

**M2/M3 是同一个事务**。M1 与 M2 分开是为了让「表建好但没数据」成为一个可停留的稳定态。

## 1.9 失败模式

| # | 失败 | 症状 | 防线 |
|---|---|---|---|
| F1 | 两行 `is_legacy_default=1` | 无片段 JID 路由二义，消息随机去两个 bot 之一 | `idx_channel_accounts_one_legacy` 唯一索引，插入直接失败 |
| F2 | `extractChatId` 忘了剥 `#account:` | **全渠道发不出消息**（provider 报 chat 不存在） | 14 个断言的单测；且这是 M4 回归矩阵第一条 |
| F3 | `seedLegacyChannelAccounts()` 抛异常，`listEnabledChannelAccounts()` 返回空 | 启动早期**所有渠道都不连** | 连接层不依赖 `channel_accounts`：`connectUserIMChannels()` 仍以配置文件为准，账号表只提供 accountId；解不出账号时传 `null`（= legacy 行为） |
| F4 | 同一份凭据被两个账号同时连（用户复制粘贴建了重复账号） | 两条 socket 收同一条消息 → 双回复 | 移植 upstream 的 `claimCredential()`：按 `sha256(provider\0credentialIdentity)` 指纹登记，第二个连接抛 `The same {provider} credential is already connected by another channel account` |
| F5 | `dingtalk.ts` 11 处构造点改错，账号片段进了下载路径 | 磁盘上出现 `downloads/dingtalk/2026-.../#account:xxx` 目录 | `saveDownloadedFile()` 入口加 `assert(!folder.includes('#'))` |
| F6 | 删掉 legacy 账号后无片段 JID 无归属 | 老会话回复失败 | `deleteChannelAccount` 事务内自动提升下一个账号为 legacy；无下一个时 `findChannelForJid` 的 `accountId=null` 分支仍走 sibling fallback |
| F7 | M5 复制凭据后旧文件被误删，新路径解密失败 | 该账号连不上，且无法恢复 | M5 只 `rename` 不 `unlink`；`.migrated` 后缀文件保留到下一次备份周期之后 |
| F8 | WhatsApp `authDir` 在 M5 前后不一致，Baileys 要求重新扫码 | 用户被迫重扫 | `getWhatsAppAuthDir` 按 `secret_layout` 分派；M5 对 whatsapp **默认跳过**（`--include-whatsapp` 显式开启） |

## 1.10 回滚（逐步）

| 步 | 回滚方式 | 是否有损 |
|---|---|---|
| M1 | `DROP TABLE channel_accounts`；`registered_groups.channel_account_id` 列**留着**（SQLite 删列代价高且无必要，NULL 列对旧代码不可见） | 无损 |
| M2 | `DELETE FROM channel_accounts`。配置文件从未被触碰 | 无损 |
| M3 | `UPDATE registered_groups SET channel_account_id = NULL` | 无损 |
| M4 | `git revert` 该 commit。键退回 `channelType`，`extractChatId` 退回原实现 | 无损（此时盘上没有任何带片段的 JID） |
| M5 | 把 `{provider}.json.migrated` 改回 `{provider}.json`，`UPDATE channel_accounts SET secret_layout='legacy', secret_ref=…` | 无损 |
| M6 | revert 前端 + 下线 `/api/channel-accounts`。**已经建出来的第二个账号**：先在 UI 里删（走 `deleteChannelAccount`），再回滚 | **仅此一步有损**：第二个账号产生的会话、消息会失去路由（JID 带片段但没人认领）。所以 M6 上线后加第二个账号之前，必须先跑一次备份 |
| JID 格式 | **不涉及** —— 这就是 §1.0 约束 1 的价值 | — |

---

# 设计 2 · 绑定解析五出口

## 2.0 问题重述

`buildResolveEffectiveChatJid()`（`src/index.ts:9945-10020`）有**五个返回 `null` 的出口**，它们语义完全不同，但返回同一个值：

| # | 行 | 条件 | 真实含义 |
|---|---|---|---|
| E1 | 9951–9954 | `!group` | 这个聊天**没注册** |
| E2 | 9959–9962 | `target_agent_id` 有值但 `getAgent()` 查不到 | 绑定**悬空** |
| E3 | 9979 / 9986 / 9990 | thread_map 分支：无 threadContextId / `resolveWorkspaceJid` 返回 null / 工作区不存在 | 绑定**悬空** |
| E4 | 10004–10010 | `target_main_jid` 有值但 `resolveWorkspaceJid` 返回 null | 绑定**悬空** |
| E5 | 10014–10018 | 两个绑定列都为空 | **没有覆盖**（正常默认态，21 有绑定 / 8 无绑定） |

现在下游一律 `agentRouting?.effectiveJid ?? jid`，五种都回落到聊天自己的 jid —— 所以 E2/E3/E4 的悬空绑定被静默当成「没绑定」处理。合并 upstream 的 `resolveAdmittedChannelRoute` 后，`null ⇒ 丢消息`，**E5 那 8 个正常会话会被一起丢掉**。

## 2.1 返回类型的变化

```ts
// src/channel-admission.ts（本地新建，与 upstream 同名文件合并时保留这段）
export interface ChannelRouteTarget {
  effectiveJid: string;
  agentId: string | null;
  sourceJid?: string;
}

/**
 * 绑定解析的三态结果。
 *
 * 'routed'      解出了显式的绑定目标
 * 'unbound'     这个聊天没有配置任何覆盖 —— 应当在它自己的 jid 上跑（正常默认态）
 * 'unresolved'  配置了覆盖但目标不存在（悬空）—— 必须拦，不能静默降级成 unbound
 */
export type ChannelRouteResolution =
  | { kind: 'routed'; target: ChannelRouteTarget }
  | { kind: 'unbound'; reason: 'no_binding' | 'group_not_registered' }
  | {
      kind: 'unresolved';
      reason: 'agent_missing' | 'workspace_missing' | 'thread_context_missing';
      detail: { targetAgentId?: string | null; targetMainJid?: string | null };
    };
```

**E1 归入 `unbound`**，不归 `unresolved`。理由是自动注册死锁（`upstream-decision-tree.md` D5.1）：`onNewChat` 排在路由解析之后，未注册 → 解析失败 → 丢消息 → `onNewChat` 永远跑不到。把 E1 判成 `unbound` 让消息在自己的 jid 上落地，`onNewChat` 才有机会跑。这一条也是 D2.3 选项 D 的落点。

## 2.2 改后的完整函数

```ts
/**
 * Build callback that resolves an IM chatJid to a bound target JID.
 *
 * 三态而非 nullable：调用方必须能区分「这个聊天本来就没配覆盖」（正常，回落到
 * 它自己的 jid）和「配了覆盖但目标没了」（悬空，必须拦住而不是静默送到别处）。
 * 合并 upstream 的 fail-closed 路由时，前者若被当成后者会让 8 个现有会话失联，
 * 且此后每个不跑 /new 的新会话一注册就是死的。
 */
function buildResolveEffectiveChatJid(): (
  chatJid: string,
  messageMeta?: FeishuMessageMeta,
) => ChannelRouteResolution {
  return (chatJid: string, messageMeta): ChannelRouteResolution => {
    const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) {
      // E1：未注册。unbound 而不是 unresolved —— onNewChat 排在解析之后，
      // 这里返回 unresolved 会让自动注册永远跑不到（D5.1 的死锁）。
      logger.debug({ chatJid }, 'resolveEffectiveChatJid: group not registered');
      return { kind: 'unbound', reason: 'group_not_registered' };
    }

    // Agent binding takes priority
    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      if (!agent) {
        // E2
        logger.warn(
          { chatJid, targetAgentId: group.target_agent_id },
          'resolveEffectiveChatJid: dangling target_agent_id',
        );
        return {
          kind: 'unresolved',
          reason: 'agent_missing',
          detail: { targetAgentId: group.target_agent_id },
        };
      }
      return {
        kind: 'routed',
        target: {
          effectiveJid: `${agent.chat_jid}#agent:${group.target_agent_id}`,
          agentId: group.target_agent_id,
        },
      };
    }

    if (
      group.binding_mode === 'thread_map' &&
      group.target_main_jid &&
      getChannelType(chatJid) === 'feishu' &&
      messageMeta &&
      (messageMeta.threadId || messageMeta.rootId || messageMeta.messageId)
    ) {
      const threadContextId =
        messageMeta.threadId || messageMeta.rootId || messageMeta.messageId;
      if (!threadContextId) {
        // E3-a：thread_map 配了但这条消息没有任何 thread 锚点。
        // 这是消息形状问题不是配置问题 —— 降级成 unbound 让它在源 jid 上跑，
        // 比拦掉更接近用户预期（那条消息本来也不属于任何 thread）。
        return { kind: 'unbound', reason: 'no_binding' };
      }
      const workspaceJid = resolveWorkspaceJid(group.target_main_jid);
      if (!workspaceJid) {
        // E3-b
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'thread_map resolveWorkspaceJid returned null — stale target_main_jid',
        );
        return {
          kind: 'unresolved',
          reason: 'workspace_missing',
          detail: { targetMainJid: group.target_main_jid },
        };
      }
      const workspace =
        registeredGroups[workspaceJid] ?? getRegisteredGroup(workspaceJid);
      if (!workspace) {
        // E3-c：resolveWorkspaceJid 说有、二次查询说没有 —— 竞态或数据损坏
        return {
          kind: 'unresolved',
          reason: 'workspace_missing',
          detail: { targetMainJid: group.target_main_jid },
        };
      }
      return {
        kind: 'routed',
        target: resolveOrCreateThreadAgent(chatJid, workspaceJid, workspace, group, {
          ...messageMeta,
          threadId: threadContextId,
        }),
      };
    }

    if (group.target_main_jid) {
      const effectiveJid = resolveWorkspaceJid(group.target_main_jid);
      if (!effectiveJid) {
        // E4
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'resolveEffectiveChatJid: dangling target_main_jid',
        );
        return {
          kind: 'unresolved',
          reason: 'workspace_missing',
          detail: { targetMainJid: group.target_main_jid },
        };
      }
      return { kind: 'routed', target: { effectiveJid, agentId: null } };
    }

    // E5：正常默认态（没跑过 /new 的聊天）。8 个现有会话走这里。
    return { kind: 'unbound', reason: 'no_binding' };
  };
}
```

**「三行修法」落在哪三行**：E1 的 `return null` → `{kind:'unbound',…}`、E5 的 `return null` → `{kind:'unbound',…}`、其余 `return null` → `{kind:'unresolved',…}`。函数体的其余部分逐字保留，包括日志。

## 2.3 渠道侧的适配器（保住现有 `?? jid` 语义）

七个渠道模块的 `IMChannelConnectOpts.resolveEffectiveChatJid` 契约**不变**（仍返回 `{effectiveJid, agentId, sourceJid} | null`），由 manager 侧做三态→二态的收敛，好处是渠道模块零改动、且 upstream 的 `resolveAdmittedChannelRoute` 可以原样接进来：

```ts
// src/channel-admission.ts
/**
 * A configured resolver owns routing authority. Its null means stale/invalid
 * binding and therefore fail-closed; only standalone connectors without a
 * resolver may persist directly under the source JID.
 */
export function resolveAdmittedChannelRoute<TContext = undefined>(
  sourceJid: string,
  resolver?: (jid: string, context?: TContext) => ChannelRouteTarget | null,
  context?: TContext,
): { targetJid: string; routing: ChannelRouteTarget | null } | null {
  if (!resolver) return { targetJid: sourceJid, routing: null };
  const routing = resolver(sourceJid, context);
  return routing ? { targetJid: routing.effectiveJid, routing } : null;
}

/** 三态 → upstream 期望的 nullable。unbound 显式回落到源 jid。 */
export function narrowChannelRoute(
  sourceJid: string,
  resolution: ChannelRouteResolution,
): ChannelRouteTarget | null {
  switch (resolution.kind) {
    case 'routed':
      return resolution.target;
    case 'unbound':
      // 显式回落，不是「解析失败」—— 这一行就是 8 个会话的生死线
      return { effectiveJid: sourceJid, agentId: null, sourceJid };
    case 'unresolved':
      return null;   // fail-closed，交给 resolveAdmittedChannelRoute 拦掉
  }
}
```

`index.ts:10241` 与 9 处 `resolveEffectiveChatJid: buildResolveEffectiveChatJid()` 的注入点全部改成：

```ts
const resolveRoute = buildResolveEffectiveChatJid();
const resolveEffectiveChatJid = (chatJid: string, meta?: FeishuMessageMeta) =>
  narrowChannelRoute(chatJid, resolveRoute(chatJid, meta));
```

一处 helper，10 个注入点共用。渠道文件里 `agentRouting?.effectiveJid ?? jid` 这些行**一行不改**（`unbound` 已经在上游变成了非 null 的源 jid，`?? jid` 变成永不触发的死分支，留着当安全网）。

**upstream 渠道代码接进来后**（qq.ts:1592 等 7 处 `if (!resolvedRoute) { warn; return; }`）：只有 `unresolved` 会走到那个 `return`。给它加一条用户可见的反馈，避免「发消息毫无反应」：

```ts
if (!resolvedRoute) {
  logger.warn({ jid }, 'Channel route rejected: dangling binding');
  // 不静默：悬空绑定是配置问题，用户必须能看到
  void opts.onRouteRejected?.(jid);   // → 回一条「当前绑定目标不存在，请重新绑定（/list 查看）」
  return;
}
```

`onRouteRejected` 加进 `IMChannelConnectOpts`，实现挂在 `index.ts`，带 per-jid 5 分钟节流（避免刷屏）。

## 2.4 三个 `resolveBoundChatTarget` 调用点

这三处走的是**另一条路**（`src/im-command-utils.ts:165` 的 `resolveBoundChatTarget`，纯函数、无 `resolveWorkspaceJid`），它的兜底分支正是 D3.5 那颗雷：悬空时 `folder` 回落成源群自己的 folder（21 条绑定的源群 folder **全是 `main`**）→ `/clear` 清掉 admin 主会话，且回复「已清除对话上下文 ✓」。

**改法：给 `resolveBoundChatTarget` 加一个失败态，三个调用点各自处理。**

```ts
// src/im-command-utils.ts
export type BoundChatTargetResult =
  | { kind: 'ok'; target: BoundChatTarget }
  | {
      kind: 'dangling';
      reason: 'agent_missing' | 'workspace_missing';
      detail: { targetAgentId?: string | null; targetMainJid?: string | null };
    };

export function resolveBoundChatTarget(
  sourceChatJid: string,
  group: RegisteredGroupLike,
  getRegisteredGroup: (jid: string) => RegisteredGroupLike | undefined,
  getAgent: (id: string) => AgentLike | undefined,
  findGroupNameByFolder: (folder: string) => string,
): BoundChatTargetResult;
```

判定：`target_agent_id` 有值而 `getAgent()` 空 → `dangling/agent_missing`；`target_main_jid` 有值而 `getRegisteredGroup()` 空 → `dangling/workspace_missing`；两列都空 → `ok`（源 jid 自身，现有的第三分支）。

| 调用点 | 位置 | 现状 | 改后 |
|---|---|---|---|
| **C1** | `index.ts:1821`（`resolveModelCommandTarget` 尾部，为 `/model` 解析目标） | 直接 return `resolveBoundChatTarget(...)` | `dangling` → 向上抛 `BindingDanglingError`，`handleModelCommand` catch 后回复「当前绑定目标不存在，请先用 `/list` 查看并重新绑定」；**不改任何模型绑定** |
| **C2** | `index.ts:2006`（`handleClearCommand`） | 拿 `target.baseChatJid` / `target.folder` 去 `executeSessionReset` | `dangling` → **直接 return** 提示串，`executeSessionReset` 一次都不调。这是 D3.5 雷的拆除点 |
| **C3** | `index.ts:2764`（`resolveSpawnWorkspace`） | 拿 `target.baseChatJid` 查 `targetGroup`，查不到才报错 | `dangling` → 返回错误串（该函数返回类型已经是 `SpawnWorkspace \| string`，直接返回 `'绑定的工作区不存在，请先重新绑定'`）。原来那层「查不到 targetGroup」的检查保留当第二道 |

C3 现在其实**已经**有部分保护（`if (!targetGroup) return '绑定的工作区不存在'`），但它检查的是兜底之后的 `baseChatJid`，悬空时那个值等于源 jid、`getRegisteredGroup` 查得到 → 检查通过 → spawn 落到源群的 folder。改后由 `dangling` 提前拦掉。

## 2.5 `resolveLocationInfo` 要不要跟着改

**要，但只改文案，不改类型。**

`resolveLocationInfo`（`im-command-utils.ts:127`）只产生 `/status`、`/list` 的显示串，不驱动任何执行。它现在对悬空绑定的显示是 `${group.target_main_jid} / 主对话` —— 把一个死 jid 当地名打出来，用户看不出异常。

改法（三处 `??` 分支）：

```ts
if (group.target_agent_id) {
  const agent = getAgent(group.target_agent_id);
  if (!agent) {
    return {
      locationLine: `⚠️ 绑定的 Agent 已不存在 (${group.target_agent_id.slice(0, 8)})`,
      folder: group.folder,
      replyPolicy: null,           // 悬空时不报 replyPolicy，避免下游按绑定态处理
    };
  }
  …
}
```

`LocationInfo` 结构不变（`{locationLine, folder, replyPolicy}`），所以 `formatSystemStatus` / `formatWorkspaceList` 零改动。`folder` 在悬空时回落到 `group.folder` 是**安全的**——它只用于显示，不用于 reset。

## 2.6 迁移步骤

| 步 | 做什么 | 验收 |
|---|---|---|
| S1 | 加 `ChannelRouteResolution` 类型 + `narrowChannelRoute`；改 `buildResolveEffectiveChatJid` 返回三态；10 个注入点包一层 | 行为**完全不变**（`unbound` 回落 = 原 `?? jid`；`unresolved` 回落 = 原 `?? jid`）。这一步是纯重构，可单独 commit + 单独验证 |
| S2 | `narrowChannelRoute` 的 `unresolved` 分支从「回落」改成 `return null`；加 `onRouteRejected` 反馈 | 悬空绑定的消息不再落到错误的工作区；本地现状 0 悬空，所以**外部行为仍不变**，靠单测覆盖 |
| S3 | `resolveBoundChatTarget` 改三态 + 三个调用点 | `/clear` 在悬空时不再清 admin 主会话 |
| S4 | `resolveLocationInfo` 三处文案 | `/status` 在悬空时显示 ⚠️ |
| S5 | 合并 upstream 的 `channel-admission.ts` / 七渠道 fail-closed 分支 | 8 个无绑定会话照常收发（回归矩阵） |

S1–S4 都在合并**之前**做，S5 在合并当天。这样 S5 那天如果出问题，可以确定是 upstream 侧引入的，不是本地解析器。

## 2.7 失败模式

| # | 失败 | 症状 | 防线 |
|---|---|---|---|
| G1 | 漏改某个注入点，仍直接把三态对象喂给渠道 | 渠道拿到 `{kind:'routed',…}`，`.effectiveJid` 是 `undefined` → `targetJid` 变 `undefined` → 消息写进 `chat_jid='undefined'` | 三态类型与 `ChannelRouteTarget` **没有结构重叠**（前者有 `kind`，后者没有），TS 直接报错。10 个注入点全在 `index.ts`，`grep -c 'resolveEffectiveChatJid:'` 应为 10 |
| G2 | 把 E1 判成 `unresolved` | 自动注册死锁（D5.1）：新群发消息毫无反应 | 单测：未注册 jid → `kind === 'unbound'` |
| G3 | `unresolved` 静默丢消息，用户不知道 | 「发消息没反应」的投诉 | `onRouteRejected` 回一条；且 `logger.warn` 带 `targetMainJid` |
| G4 | `onRouteRejected` 无节流 → 悬空绑定的活跃群被刷屏 | 每条消息回一条错误 | per-jid 5 分钟节流 Map |
| G5 | S3 改完后某个 `dangling` 分支忘了 return，继续往下走 | `/clear` 仍炸主会话 | 三个调用点各一个单测：悬空时 `executeSessionReset` 的 mock **零次调用** |

## 2.8 回滚

S1–S4 各自独立 commit，`git revert` 即可，无数据变更。S5 若出问题，回滚方式是把 `narrowChannelRoute` 的 `unresolved` 分支临时改回 `{ effectiveJid: sourceJid, agentId: null }`（一行），即恢复 fail-open —— 不需要 revert 整个合并。

**这一行就是设计 2 的紧急阀门**，注释里要写明。

---

# 设计 3 · 工作区投影按 folder

## 3.0 三个方案的实测差异

| 方案 | 行数 | 问题 |
|---|---|---|
| 本地现状：`registered_groups` 全投影，PK = jid | 64 | 把 25 个飞书群 / 1 个 QQ / 3 个微信当成 29 个独立「工作区」。它们其实是**渠道挂载点**，不是工作区 |
| upstream：只投 `jid LIKE 'web:%'`，PK = jid | 35 | 漏掉 `wechat` folder（它没有 web: 行，只有一条 `wechat:o9cq8089-…@im.wechat`） |
| **本设计**：按 distinct folder，PK = folder | **36** | 正确 |

实测（本机库）：`SELECT COUNT(DISTINCT folder) FROM registered_groups` = 36；其中 35 个 folder 恰有 1 条 `web:%` 行、0 个 folder 有 >1 条；唯一没有 web: 行的是 `wechat`（1 条 IM jid、owner 唯一）。

## 3.1 表结构：主键从 jid 改 folder

```sql
-- 目标形态
CREATE TABLE IF NOT EXISTS workspaces (
  folder          TEXT PRIMARY KEY,     -- ← 主键换成它
  jid             TEXT NOT NULL,        -- 规范 jid（见 §3.2），仍然唯一
  owner_user_id   TEXT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  is_home         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_jid   ON workspaces(jid);
CREATE INDEX        IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id, status);
```

`jid` 列**保留且保持 UNIQUE**：upstream 的全部读路径（`getWorkspaceRecord(jid)`、`deleteWorkspaceMirror(jid)`、`DELETE FROM workspaces WHERE jid = ?`）按 jid 查，改主键不能顺带改掉它们的查询键，否则那些函数全要重写。主键换成 folder 只是**换了唯一性约束的对象**：从「一个 jid 一行」变成「一个 folder 一行」。

SQLite 不能 `ALTER TABLE … DROP PRIMARY KEY`，所以是建新表 + 搬 + 换名（见 §3.4 步骤 W2）。

## 3.2 「规范 jid」怎么选

```ts
/**
 * 一个 folder 的规范 workspace JID。
 *
 * 规则（按优先级）：
 *   R1 该 folder 下唯一的 web: 行 → 用它
 *   R2 多条 web: 行（本机 0 例，但不能假设永远为 0）→ 取 is_home DESC, added_at ASC 的第一条
 *   R3 没有 web: 行，但该 folder 下所有行的 created_by 是同一个人 → 取 added_at ASC 的第一条
 *   R4 没有 web: 行且 owner 不唯一 → 不投影，记一条 problem
 *
 * R3 是为 `wechat` folder 存在的：它只有一条 IM jid，owner 唯一，
 * 语义上确实是一个工作区。upstream 的 web:% 过滤会把它整个丢掉。
 * R4 拒绝投影而不是猜：owner 不唯一时选谁都是错的，宁可让校验函数报出来。
 */
export function resolveCanonicalWorkspaceJid(folder: string): {
  jid: string | null;
  rule: 'R1' | 'R2' | 'R3' | 'R4';
} {
  const rows = db
    .prepare(
      `SELECT jid, created_by, is_home, added_at
         FROM registered_groups
        WHERE folder = ?
        ORDER BY (jid LIKE 'web:%') DESC, is_home DESC, added_at ASC, jid ASC`,
    )
    .all(folder) as Array<{
      jid: string; created_by: string | null; is_home: number; added_at: string;
    }>;
  if (rows.length === 0) return { jid: null, rule: 'R4' };

  const webRows = rows.filter((r) => r.jid.startsWith('web:'));
  if (webRows.length === 1) return { jid: webRows[0].jid, rule: 'R1' };
  if (webRows.length > 1) return { jid: webRows[0].jid, rule: 'R2' };

  const owners = new Set(rows.map((r) => r.created_by ?? ''));
  if (owners.size === 1 && !owners.has('')) return { jid: rows[0].jid, rule: 'R3' };
  return { jid: null, rule: 'R4' };
}
```

`ORDER BY (jid LIKE 'web:%') DESC, is_home DESC, added_at ASC, jid ASC` 把四条规则压进一条 SQL —— **确定性排序**（末尾的 `jid ASC` 是 tie-breaker），同一份数据每次跑结果相同。这一点很重要：投影每次启动全量重建，不确定的排序会让 `jid` 列在两次启动之间跳变，进而让 `workspace_runtime_sessions.workspace_jid`（设计 5）跟着跳。

**这个函数是设计 3 与设计 5 的唯一共享点**，两边都必须调它，不能各写一份。

## 3.3 重建函数

替换 `src/db.ts:8702` 的 `rebuildWorkspaceProjection()`：

```ts
export interface WorkspaceProjectionResult {
  workspaces: number;
  runtimeSessions: number;
  /** 按规则分布，用于启动日志：{R1: 35, R3: 1, R4: 0} */
  ruleCounts: Record<'R1' | 'R2' | 'R3' | 'R4', number>;
  /** R4（无法确定规范 jid）的 folder 列表 */
  unprojectable: string[];
}

export function rebuildWorkspaceProjection(): WorkspaceProjectionResult;
```

实现（全量重建，不做增量 —— 理由保留现有注释：投影只有几十行，重建不会漂；增量要在每个 `registered_groups` 写入点挂钩子，漏一个就是静默陈旧）：

```ts
const tx = db.transaction(() => {
  db.prepare('DELETE FROM workspaces').run();

  const folders = db
    .prepare('SELECT DISTINCT folder FROM registered_groups ORDER BY folder')
    .all() as Array<{ folder: string }>;

  const insert = db.prepare(
    `INSERT INTO workspaces
       (folder, jid, owner_user_id, name, status, is_home, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  );

  for (const { folder } of folders) {
    const { jid, rule } = resolveCanonicalWorkspaceJid(folder);
    ruleCounts[rule]++;
    if (!jid) { unprojectable.push(folder); continue; }
    const g = registeredGroups[jid] ?? getRegisteredGroup(jid)!;
    insert.run(
      folder,
      jid,
      g.created_by ?? null,
      g.name?.trim() || folder,
      g.is_home ? 1 : 0,
      g.added_at?.trim() || now,
      now,
    );
  }

  // workspace_runtime_sessions 的重建见设计 5 §5.5，同一个事务内
});
```

`name` 的兜底从 upstream 的 `COALESCE(NULLIF(name,''), folder)` 保留（本地现状已如此）。

## 3.4 迁移步骤

| 步 | 做什么 | 验收 |
|---|---|---|
| **W1** | 加 `resolveCanonicalWorkspaceJid()`（纯新增，无人调用） | 单测：R1/R2/R3/R4 四条各一个用例；对本机数据跑一遍应得 `{R1:35, R3:1}` |
| **W2** | 表结构换主键：`CREATE TABLE workspaces_new (…folder PRIMARY KEY…)` → `INSERT INTO workspaces_new SELECT …（按 folder 去重，取规范 jid）` → `DROP TABLE workspaces` → `ALTER TABLE workspaces_new RENAME TO workspaces` → 重建两个索引。**整个在一个事务里** | `PRAGMA table_info(workspaces)` 的 pk 落在 folder；`SELECT COUNT(*) FROM workspaces` = 36 |
| **W3** | 换掉 `rebuildWorkspaceProjection()` 实现 + `verifyWorkspaceProjection()`（§3.5） | 启动日志 `Workspace projection rebuilt {workspaces:36, ruleCounts:{R1:35,R3:1,R4:0}, unprojectable:[]}` |
| **W4** | 合并 upstream 后，覆盖 `syncAllWorkspacesFromRegisteredGroups()`（§3.6） | `grep -n "jid LIKE 'web:%'" src/db.ts` 在 workspaces 相关处零命中 |

W2 的 SQLite 事务里 `DROP TABLE` + `RENAME` 是安全的（WAL 模式下 DDL 也在事务内）。但要注意：本地已开 `PRAGMA foreign_keys = ON`（决策 14），若将来有表外键引用 `workspaces(jid)`，`DROP TABLE` 会级联。当前 `foreign_key_check` 干净且没有指向 `workspaces` 的外键，W2 前跑一次 `PRAGMA foreign_key_list` 逐表确认。

## 3.5 一致性校验函数

替换 `src/db.ts:8771` 的 `verifyWorkspaceProjection()`：

```ts
export interface WorkspaceProjectionProblem {
  kind:
    | 'count_mismatch'         // workspaces 行数 != distinct folder 数
    | 'missing_folder'         // 某 folder 没有对应 workspaces 行
    | 'orphan_workspace'       // workspaces 行的 folder 在 registered_groups 里不存在
    | 'non_canonical_jid'      // workspaces.jid != resolveCanonicalWorkspaceJid(folder)
    | 'drifted_field'          // owner/name/is_home 与规范 jid 所在的 registered_groups 行不一致
    | 'unprojectable_folder';  // R4
  folder: string;
  detail?: string;
}

export function verifyWorkspaceProjection(): {
  ok: boolean;
  problems: WorkspaceProjectionProblem[];
};
```

六项检查：

```sql
-- 1. count_mismatch
SELECT (SELECT COUNT(DISTINCT folder) FROM registered_groups) AS src,
       (SELECT COUNT(*) FROM workspaces) AS proj;

-- 2. missing_folder
SELECT DISTINCT g.folder FROM registered_groups g
 WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.folder = g.folder) LIMIT 5;

-- 3. orphan_workspace
SELECT w.folder FROM workspaces w
 WHERE NOT EXISTS (SELECT 1 FROM registered_groups g WHERE g.folder = w.folder) LIMIT 5;

-- 5. drifted_field（4 non_canonical_jid 在 JS 里逐 folder 比对 resolveCanonicalWorkspaceJid）
SELECT w.folder FROM workspaces w JOIN registered_groups g ON g.jid = w.jid
 WHERE g.folder != w.folder
    OR COALESCE(w.owner_user_id,'') != COALESCE(g.created_by,'')
    OR w.is_home != COALESCE(g.is_home, 0) LIMIT 5;
```

`ok === false` **不阻止启动**（保留现有语义：`registered_groups` 是真相源，投影坏了不该拖垮服务），但要 `logger.error` 而不是 `logger.warn`（现状是 warn，太轻）。

## 3.6 怎么覆盖 upstream 的 `syncAllWorkspacesFromRegisteredGroups`

这是**整个合并里唯一一处我们主动覆盖 upstream 迁移行为的地方**，必须让下一个人一眼认出来，否则下次合并会被 upstream 的版本悄悄换回去。

upstream 的三个相关函数（`git show upstream/main:src/db.ts`）：

```
8575  syncAllWorkspacesFromRegisteredGroups()       ← 遍历 jid LIKE 'web:%'
8305  syncWorkspaceFromRegisteredGroup(jid, group)  ← 首行 if (!jid.startsWith('web:')) return;
8296  getWorkspaceJidForFolder(groupFolder)         ← "…AND jid LIKE 'web:%' ORDER BY is_home DESC, added_at ASC LIMIT 1"
8595  reconcileCanonicalRuntimeProjections()        ← DELETE FROM workspaces WHERE 非 web: 行，再调 syncAll
```

**三层标记，缺一不可：**

**① 代码层 —— 保留函数名，换实现，注释写死为什么。**

```ts
/**
 * ⚠️ 本地覆盖 upstream 实现（决策 8 / D1.4）。合并时**不要**取 upstream 侧。
 *
 * upstream 版按 `jid LIKE 'web:%'` 逐条投影，主键是 jid。那会漏掉没有 web: 行的
 * folder —— 本机的 `wechat` folder 就是一例（只有一条 wechat:… jid，owner 唯一，
 * 语义上确实是一个工作区）。本地版按 distinct folder 投影，规范 jid 由
 * resolveCanonicalWorkspaceJid() 决定（R1..R4）。
 *
 * 行数对照（本机实测）：本地旧版 64（把 29 个渠道挂载点当工作区）· upstream 35
 * （漏 1）· 本版 36（正确）。
 *
 * 同名保留是为了让 upstream 的 30 个新文件能直接链接到符号；语义**不同**。
 * 下次合并遇到这个函数的冲突：一律选本地侧，并核对 upstream 是否新增了
 * 本函数的调用点（新增点也要按 folder 语义复核）。
 *
 * @see docs/design-merge-internals.md §3
 */
export function syncAllWorkspacesFromRegisteredGroups(): void {
  rebuildWorkspaceProjection();
}
```

`syncWorkspaceFromRegisteredGroup(jid, group)`（单行 upsert）**删掉**，改成 `rebuildWorkspaceProjection()` 的全量重建；upstream 里 4 个调用点全部改指向重建。理由：单行 upsert 在「一个 folder 多条 jid」的模型下会写出多行，与新主键冲突（`UNIQUE(jid)` 会先炸，但错误信息指不到根因）。

`getWorkspaceJidForFolder(folder)` **保留函数名，实现委托给 `resolveCanonicalWorkspaceJid(folder).jid`**。upstream 有 3 处调用它，全部自动获得新语义。

**② 门禁层 —— 加一条契约测试。**

```ts
// tests/workspace-projection-folder-contract.test.ts
it('workspaces 投影按 folder，不按 web: 前缀', () => {
  // 造一个只有 IM jid 的 folder（模拟 wechat）
  // 断言：rebuildWorkspaceProjection() 之后它有一行
  // 断言：src/db.ts 中 workspaces 相关语句不含 "jid LIKE 'web:%'"
});
```

第二条断言是**源码级**的（读 `src/db.ts` 文本、截取 workspaces 相关区段做 grep）。它的作用是：下次有人按 upstream 侧解冲突，测试立刻红，而不是等到某个 folder 静默消失。这条测试与 `upstream-merge-plan.md` 决策 71「CI 去掉三个契约测试」不矛盾 —— 那三个是 upstream 强加的禁本地做法，这一条是我们自己的。

**③ 台账层 —— 在 `docs/upstream-decision-ledger.md` 加一行**，状态 🔄 已重写，说明「workspaces 投影按 folder，覆盖 upstream 的 web: 前缀语义」。

## 3.7 失败模式

| # | 失败 | 症状 | 防线 |
|---|---|---|---|
| H1 | W2 建新表时按 jid 搬（没去重），`folder PRIMARY KEY` 冲突 | 迁移事务回滚，服务起不来 | W2 的 INSERT 必须 `SELECT DISTINCT folder` 驱动，不是 `SELECT * FROM workspaces` |
| H2 | `resolveCanonicalWorkspaceJid` 排序不确定，两次启动 `jid` 列不同 | 设计 5 的 `workspace_jid` 跟着跳变，投影看起来一直在变 | `ORDER BY` 末尾的 `jid ASC` tie-breaker；单测跑两次断言结果相同 |
| H3 | 合并时按 upstream 侧解了 `syncAllWorkspacesFromRegisteredGroups` | `wechat` folder 从投影里消失（且没人会注意到，因为没有读取方报错） | §3.6 的三层标记；契约测试是硬门 |
| H4 | R4 folder 出现（owner 不唯一且无 web: 行） | 该 folder 不在投影里 | `verifyWorkspaceProjection` 报 `unprojectable_folder`；启动日志 error |
| H5 | upstream 的 `reconcileCanonicalRuntimeProjections()` 里那句 `DELETE FROM workspaces WHERE …rg.jid LIKE 'web:%'` 被静默采纳 | 每次启动删掉非 web: 的投影行 | 该函数落在 `db.ts` 冲突区外（静默变更 §2.1），**必须在阶段 2.4「静默杀手清单」里加第 7 项**：确认这句 DELETE 已改成按 folder 的版本 |

**H5 是这一节最需要盯的一条** —— 它是静默的，typecheck 不会提醒，且症状（少一个工作区）不会报错。

## 3.8 回滚

| 步 | 回滚 |
|---|---|
| W1 | revert，函数无人调用 |
| W2 | 反向 DDL：建回 `jid PRIMARY KEY` 的表，从 `registered_groups` 全量重投 64 行 |
| W3 | revert 到旧 `rebuildWorkspaceProjection()`（配合 W2 回滚） |
| W4 | 取 upstream 侧的 `syncAllWorkspacesFromRegisteredGroups`（只有在 W2/W3 也回滚了才有意义） |

`workspaces` 是**纯派生表、零写入方、零读取方**（`upstream-decision-tree.md` D1.4 已穷举确认：只在 `db.ts` 内部 5 处出现），所以任何一步的回滚都是无损的 —— 重建一次就回来了。

---

# 设计 4 · 宿主机并发闸

## 4.0 两边各解一半

```
本地      hasCapacityFor → activeHostProcessCount < maxConcurrentHostProcesses
          activeHostProcessCount-- 在 runForGroup 的 finally（= 进程退出路径）
          Claude 常驻 → 槽位被暖进程占到 IDLE_TIMEOUT（30 分钟）
          症状：37 个 host 工作区抢 5 个槽位，一个空闲的暖会话堵死不相干的飞书群

upstream  hasCapacityFor 对 host 直接 return true
          症状：37 个工作区无应用层上限；maxConcurrentHostProcesses 变成
                「存在、可修改、完全无效」的幽灵设置
```

## 4.1 计数改法：从「活着的进程」到「进行中的轮次」

`GroupState` 已经有 `queryInFlight: boolean`（第 29 行），它的语义正是「runner 是否在一个 query turn 里面」：

- `runForGroup` 起头置 `true`（第 1187 行）
- `markRunnerQueryIdle()` 置 `false`（第 434 行，由 `index.ts:5363` / `:7945` 在 result 到达时调）
- `sendMessage()` IPC 注入后重置 `true`（第 735 行）
- `runForGroup` finally 置 `false`（第 1268 行）

也就是说 `queryInFlight` **已经是「进行中的轮次」的准确信号**，只是没人拿它当准入门。

**改法（三处）：**

```ts
// ① 新增派生计数器，替代 activeHostProcessCount 在 hasCapacityFor 里的角色
/**
 * 进行中的宿主机轮次数。
 *
 * 不是「活着的宿主机进程数」—— Claude 运行时常驻，两轮之间进程不退出，
 * 用进程数当准入门会让一个空闲了 29 分钟的暖会话继续占着槽位，直到
 * IDLE_TIMEOUT 才释放（upstream 注释描述的正是这个）。
 * 轮次数只在 query 真正在跑时计入，暖而空闲的 runner 不占额度。
 */
private countHostTurnsInFlight(): number {
  let n = 0;
  for (const [jid, s] of this.groups) {
    if (!s.active || !s.queryInFlight) continue;
    if (!this.isHostMode(jid)) continue;
    n++;
  }
  return n;
}
```

遍历而不是增减计数器：`queryInFlight` 有 4 个写点、分布在 3 个文件的回调里（`index.ts` 两处经 `markRunnerQueryIdle`），维护一个增减计数器必然漏。`this.groups` 的规模是注册会话数量级（本机 64），一次遍历 O(64)，`hasCapacityFor` 的调用频率是「每次 drain」——完全不需要优化。

```ts
// ② hasCapacityFor
private hasCapacityFor(groupJid: string): boolean {
  const isHost = this.isHostMode(groupJid);
  if (isHost) {
    const limit = getSystemSettings().maxConcurrentHostProcesses;
    if (this.countHostTurnsInFlight() >= limit) {
      // 满额：先尝试逐出最久空闲的暖 runner，让出一个槽位（§4.2）
      if (!this.evictIdlestWarmHostRunner(groupJid)) return false;
    }
  } else {
    if (this.activeContainerCount >= getSystemSettings().maxConcurrentContainers) {
      return false;
    }
  }
  if (this.userConcurrentLimitFn && !this.userConcurrentLimitFn(groupJid).allowed) {
    return false;
  }
  return true;
}
```

```ts
// ③ activeHostProcessCount 保留，但降级为「纯展示」
//    它仍在 runForGroup/runTask 的 ++/-- 处维护，只是不再进 hasCapacityFor。
//    getStatus() 同时暴露两个数（§4.4）。
```

**为什么保留 `activeHostProcessCount`**：它回答的是另一个真实问题「现在有几个 node 进程活着」，运维要看。删掉它等于把两个不同的量合并成一个 —— 那正是当前 bug 的成因。

## 4.2 逐出策略

```ts
interface WarmHostRunner {
  jid: string;
  idleMs: number;
  folder: string;
}

/**
 * 满额时挑一个「暖而空闲」的宿主机 runner 关掉，把槽位让给 requesterJid。
 *
 * 选择条件（全部满足才是候选）：
 *   - state.active && !state.queryInFlight    暖着但没在跑
 *   - !state.activeRunnerIsTask               不动定时任务（它没有用户在等，但重跑代价高）
 *   - state.agentId === null                  不动 sub-agent runner
 *   - !state.pendingMessages                  没有待处理消息（有的话它马上要变忙）
 *   - state.pendingTasks.length === 0
 *   - !state.restarting && !state.retryTimer
 *   - this.getSerializationKey(jid) !== this.getSerializationKey(requesterJid)
 *                                             不能把自己要用的那条链关掉
 *   - idleMs >= EVICTION_MIN_IDLE_MS          刚空闲下来的不动（见下）
 *
 * 排序：idleMs DESC —— 最久没动的先走。
 * 返回是否成功让出了一个槽位。
 */
private evictIdlestWarmHostRunner(requesterJid: string): boolean;

private static EVICTION_MIN_IDLE_MS = 30_000;
```

`EVICTION_MIN_IDLE_MS = 30_000` 的作用：一轮刚结束、用户很可能马上追问的窗口内不逐出。没有这个下限，两个用户交替发消息会互相踢对方的暖会话，每条消息都要冷启动。30 秒是「人类连续追问」的典型间隔上界。

**怎么关（优雅，不 kill）**：

```ts
// evictIdlestWarmHostRunner 内部，对选中的 victim
this.closeStdin(victim.jid);           // 写 _close sentinel → agent-runner 的会话循环自然退出
logger.info(
  { evicted: victim.jid, idleMs: victim.idleMs, requester: requesterJid,
    hostTurnsInFlight: this.countHostTurnsInFlight() },
  'Evicted idlest warm host runner to free a turn slot',
);
```

用 `closeStdin` 而不是 `stopGroup`：

- `_close` 是 agent-runner 已有的优雅关闭协议（`data/ipc/{folder}/input/_close`），会话循环读到它就正常收尾，不丢正在写的输出
- `stopGroup` 会 `SIGTERM`/`docker kill`，还会写 `recentlyStoppedFolders`（30 秒内抑制 drain），把逐出误标成「用户点了停止」，后续 `pendingMessages` 会被吞
- `closeStdin` **不清 `pendingMessages` / `pendingTasks`**，victim 退出后 `runForGroup` 的 finally 照常 `drainGroup()`，它自己排队重来

**逐出是异步的，槽位不会立刻空出来**。所以 `evictIdlestWarmHostRunner` 返回 `true` 的语义是「已发出让位信号」，而不是「槽位已就绪」。`hasCapacityFor` 返回 `true` 后 `drainGroup` 会立刻 `runForGroup`，此刻计数会短暂 = limit + 1。**这是可接受的**：超额只有一个、且只持续到 victim 的 `_close` 生效（毫秒到秒级）。要避免的是无界超额，所以加一条硬顶：

```ts
private static EVICTION_OVERSHOOT_ALLOWANCE = 1;
// hasCapacityFor 里：
if (this.countHostTurnsInFlight() >= limit + GroupQueue.EVICTION_OVERSHOOT_ALLOWANCE) {
  return false;   // 已经有一个在让位中，不再连锁逐出
}
```

**逐出后排队的怎么进来**：不需要额外机制。victim 的 `runForGroup` finally 已经调 `drainGroup(victim.jid)`，它内部走到 `drainWaiting()`（第 1519 行），遍历 `waitingGroups` 重新分配槽位。requester 在 `hasCapacityFor` 返回 true 后已经启动，其余等待者由 `drainWaiting` 接手。

## 4.3 与 `IDLE_TIMEOUT` 的关系

两者是**同一个问题的两个时间尺度**，逐出不取代空闲超时：

| 机制 | 触发 | 时长 | 目的 |
|---|---|---|---|
| `IDLE_TIMEOUT`（默认 30 分钟，`index.ts:3740` 的 `resetIdleTimer`） | 无条件、每个 runner 各自计时 | 30 min | 回收长期不用的暖会话，释放内存 / 文件句柄 |
| 逐出（本设计） | **仅在满额且有人在等时** | ≥ 30 s | 让位。有需求才发生 |

关系上三条要写进注释：

1. **逐出用的是同一个 `closeStdin(jid)`**（`resetIdleTimer` 的超时回调第 3739 行就是 `queue.closeStdin(chatJid)`），所以行为路径完全一致，不引入第二种关闭语义。
2. **`IDLE_TIMEOUT` 不需要调小。** 现在很多人想调小它其实是为了绕过槽位堵塞；有了逐出，`IDLE_TIMEOUT` 可以回归它本来的语义（资源回收），保持 30 分钟。文档要说明这一点，否则用户会继续按老经验调它。
3. 逐出用的 `idleMs` 取自 `state.lastActivityAt`（`markRunnerActivity` 维护，第 413 行），与 `resetIdleTimer` 的计时器是**两套独立的时间源**。`lastActivityAt` 记的是「最后一次有可观测输出」，`resetIdleTimer` 记的是「最后一次 result」。前者更保守（工具调用中途也算活跃），正是逐出想要的。

## 4.4 `getStatus()` 暴露什么

```ts
getStatus(): {
  activeCount: number;
  activeContainerCount: number;
  /** 活着的宿主机进程数（含暖而空闲的）。展示用，不再是准入门。 */
  activeHostProcessCount: number;
  /** 进行中的宿主机轮次数 —— 这才是与 maxConcurrentHostProcesses 比较的量。 */
  hostTurnsInFlight: number;
  /** 暖着但没在跑的宿主机 runner（= 可被逐出的候选池大小）。 */
  warmIdleHostRunners: number;
  /** 自进程启动以来的逐出次数，按原因分。 */
  hostEvictions: { total: number; lastEvictedAt: string | null };
  waitingCount: number;
  waitingGroupJids: string[];
  groups: Array<{
    jid: string;
    active: boolean;
    /** 新增：区分「在跑」和「暖着」。 */
    queryInFlight: boolean;
    idleMs: number | null;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
    groupFolder: string | null;
    selectedProviderId: string | null;
    runtime: AgentRuntime | null;
  }>;
}
```

`src/routes/monitor.ts:296` 的响应体相应加：

```ts
activeHostProcesses: isAdmin ? queueStatus.activeHostProcessCount : undefined,
hostTurnsInFlight:   isAdmin ? queueStatus.hostTurnsInFlight : undefined,
warmIdleHostRunners: isAdmin ? queueStatus.warmIdleHostRunners : undefined,
hostEvictions:       isAdmin ? queueStatus.hostEvictions : undefined,
maxConcurrentHostProcesses: isAdmin ? getSystemSettings().maxConcurrentHostProcesses : undefined,
```

`src/index.ts:2232-2234` 构造 `QueueStatusInfo`（供 `/status` 斜杠命令的 `formatSystemStatus`）的地方同步加字段。`im-command-utils.ts:210` 的 `QueueStatusInfo` 接口加 `hostTurnsInFlight`。

## 4.5 前端监控页文案

`web/src/stores/monitor.ts` 的 `SystemStatus` 加四个可选字段。

**`web/src/components/monitor/ContainerStatus.tsx`** —— 现在只显示容器（`活跃工作区 {activeContainers}/{max}`）。宿主机模式的用户看不到自己的负载。改成两条进度条：

```
┌──────────────────────────────────────┐
│ 🖥  活跃工作区（容器）    3 / 20      │
│ ████░░░░░░░░░░░░░░░░  工作区资源充足 │
│                                      │
│ ⚡ 进行中的轮次（宿主机） 2 / 5       │
│ ████████░░░░░░░░░░░░                 │
│ 另有 4 个会话暖着待命，需要时自动让位  │
└──────────────────────────────────────┘
```

三段文案（按 `hostTurnsInFlight / max` 的比例，与容器条同一套阈值 60% / 80%）：

| 条件 | 文案 |
|---|---|
| `warmIdleHostRunners > 0` | `另有 {n} 个会话暖着待命，需要时自动让位` |
| `hostTurnsInFlight >= max` | `宿主机轮次已满，新消息会先让最久空闲的会话退出` |
| `hostEvictions.total > 0`（悬浮提示） | `本次启动以来让位 {n} 次，最近一次 {相对时间}` |

**关键是「暖着待命」这四个字**：现在用户看到 5/5 会以为系统卡了，实际上其中 4 个只是没关。文案必须让「暖」和「忙」在视觉上分开。

**`web/src/components/settings/SystemSettingsSection.tsx`** 第 75–84 行的字段描述要改，否则它继续描述一个已经不存在的量：

```ts
{
  key: 'maxConcurrentHostProcesses',
  label: '最大并发宿主机轮次',                          // 「进程数」→「轮次」
  description:
    '同时进行中的宿主机 Agent 轮次上限。' +
    '空闲但未关闭的会话不计入 —— 满额时系统会让最久空闲的会话先退出，' +
    '再启动新的。',
  unit: '个',
  min: 1, max: 50, step: 1,
},
```

## 4.6 迁移步骤

| 步 | 做什么 | 验收 |
|---|---|---|
| **Q1** | 加 `countHostTurnsInFlight()`（无人调用）+ `getStatus()` 暴露它 | 监控页能同时看到「进程数」和「轮次数」；观察一段时间，确认「进程 > 轮次」在暖会话存在时成立 |
| **Q2** | `hasCapacityFor` 的 host 分支改用轮次数（**先不加逐出**） | 5 个槽位现在按轮次算，暖会话不再占位。这一步就已经解决了主要症状 |
| **Q3** | 加 `evictIdlestWarmHostRunner` + `EVICTION_MIN_IDLE_MS` + overshoot 硬顶 | 单测：构造 6 个暖 runner + 1 个 requester，断言逐出 idleMs 最大的那个、且序列化键相同的不被逐出 |
| **Q4** | 前端两条进度条 + 设置页文案 | 肉眼确认 |

Q1→Q2 之间**观察至少一个工作日**：如果 Q1 观察到「进程数长期等于轮次数」（即根本没有暖会话），说明前提判断有误，Q2/Q3 不必做。

## 4.7 失败模式

| # | 失败 | 症状 | 防线 |
|---|---|---|---|
| J1 | `queryInFlight` 在某条路径上漏置 `false`（例如 Codex/Grok 单轮 re-spawn 的退出路径） | 该 runner 永久占一个轮次额度 → 槽位被吃光 | `runForGroup`/`runTask` 的 finally 无条件置 false（现状已如此）；加一条 `getStuckPendingGroups` 式的诊断：`active && queryInFlight && lastActivityAt 超过 CONTAINER_TIMEOUT` 时 `logger.error` |
| J2 | 逐出把 requester 自己的序列化兄弟关掉 | requester 起来后又立刻被 drain 掉，抖动 | 候选条件里的 `getSerializationKey(jid) !== getSerializationKey(requesterJid)` |
| J3 | 连锁逐出：A 逐出 B，B 重排队又逐出 C | 全体互相踢，谁都跑不完 | `EVICTION_MIN_IDLE_MS`（刚活跃过的不动）+ `EVICTION_OVERSHOOT_ALLOWANCE = 1`（同时只允许一个在让位） |
| J4 | 逐出用了 `stopGroup(force)` | `recentlyStoppedFolders` 被写 → 30 秒内 victim 的 `pendingMessages` 被吞 → 丢消息 | 只用 `closeStdin`，绝不用 `stopGroup`。加单测断言 `recentlyStoppedFolders` 在逐出后为空 |
| J5 | victim 的 `_close` 没生效（进程卡死） | 槽位永远不释放，且没人报警 | 逐出时记 `evictionRequestedAt`；`countHostTurnsInFlight` 之外加一条 60 秒后的检查：仍在 `queryInFlight` 则升级为 `stopGroup({force:true})` 并 `logger.error` |
| J6 | 用户把 `maxConcurrentHostProcesses` 调到 1 | 每条消息都逐出上一个会话，冷启动地狱 | 设置页 `min: 1` 保留，但描述里写明含义已变；`hostEvictions.total` 在监控页可见，异常高时用户能自己发现 |

## 4.8 回滚

Q1–Q4 各自独立 commit。

- 回滚 Q3（只去逐出，保留轮次计数）：删 `evictIdlestWarmHostRunner` 调用，`hasCapacityFor` 满额直接 `return false`。这是一个**安全的中间态** —— 比现状好（暖会话不占位），比完整方案保守（满了就排队）。
- 回滚 Q2：`hasCapacityFor` 的 host 分支改回 `this.activeHostProcessCount < limit`。一行。
- 回滚 Q1/Q4：纯展示，revert 即可。

无数据变更，全程无损。

---

# 设计 5 · 两张会话表的权威 + 派生

## 5.0 现状与目标

```
conversation_runtime_sessions   本地独有 · 52 行 · 25 个 (folder, agent_id) 作用域
  PK (group_folder, agent_id, runtime, provider_id, auth_profile_generation, model_key)
  = 每个作用域下「每个 运行时 × provider × 认证代 × 模型」一行 native session

workspace_runtime_sessions      upstream 形态 · 16 行
  PK (group_folder, runtime_agent_id)
  = 每个作用域一行，投影自 legacy 的 sessions 表（17 行）
```

两张表**粒度不同、不能合并**（决策 12）。现在各自独立写：`sessions` → `workspace_runtime_sessions`（本地 `rebuildWorkspaceProjection` 全量重建）、`model-runtime.ts` → `conversation_runtime_sessions`。级联删除本地 4 处、upstream 11 处，导致孤儿。

**目标形态：**

```
conversation_runtime_sessions  ← 权威（authoritative）。所有写入走 setRuntimeNativeSession()
                    │
                    │  syncWorkspaceRuntimeSessionProjection()   ← 唯一的投影写入函数
                    ▼
workspace_runtime_sessions     ← 只读投影。零业务读取方，只为 upstream 的 30 个新文件提供符号形状
```

## 5.1 同步函数签名与触发点

```ts
/**
 * 把一个 (folder, agentId) 作用域的**当前激活运行时绑定**投影到
 * workspace_runtime_sessions。
 *
 * 该表是只读投影：本函数是它唯一的写入者（除全量重建）。任何其他地方
 * INSERT/UPDATE 它都是 bug —— 两个写入者是当前孤儿数据的成因。
 *
 * 无对应权威行（或作用域已删）时删除投影行，不留空壳。
 */
export function syncWorkspaceRuntimeSessionProjection(
  groupFolder: string,
  agentId?: string | null,
): void;

/** 全量重建（启动时 + 迁移后）。返回写了几行。 */
export function rebuildWorkspaceRuntimeSessionProjection(): number;
```

**触发点（5 个，全在 `src/db.ts` 内部，对外零新增 API）：**

| # | 位置 | 时机 |
|---|---|---|
| T1 | `setRuntimeNativeSession()` 尾部（`db.ts:4395` 拿到 row 之后） | 写权威行之后 |
| T2 | `deleteRuntimeNativeSessionsForScope()` 尾部（`db.ts:4416`） | 删作用域之后 |
| T3 | `deleteRuntimeNativeSessionsForFolder()` 尾部（`db.ts:4424`） | 删 folder 之后（对该 folder 的每个 agentId 各调一次） |
| T4 | `setConversationRuntimeBinding()` 尾部（`db.ts:4195` 之后） | 激活绑定变了 → 投影选的那一行可能换了（**这一条是最容易漏的**） |
| T5 | `rebuildWorkspaceProjection()` 内（设计 3 §3.3 的同一事务） | 启动全量重建 |

T1/T2/T3 **必须在与权威写同一个 `db.transaction()` 内**。现状 `setRuntimeNativeSession` 不在事务里（第 4341–4394 行是裸 `db.prepare().run()`），要包一层：

```ts
export function setRuntimeNativeSession(session: …): RuntimeNativeSession {
  …
  const result = db.transaction(() => {
    db.prepare(`INSERT INTO conversation_runtime_sessions (…) …`).run(…);
    const row = getRuntimeNativeSession({…});
    if (!row) throw new Error('conversation_runtime_sessions write failed');
    syncWorkspaceRuntimeSessionProjection(session.group_folder, session.agent_id || '');
    return row;
  })();
  return result;
}
```

## 5.2 52 行里选哪一行投影：「当前激活的运行时绑定」的判定

投影表 PK 是 `(group_folder, runtime_agent_id)` —— 一个作用域**只能有一行**。52 行 → 25 个作用域，最多的一个作用域有 7 行（`task-1fa16ce0-642`：claude 5 个 model_key + codex 2 个）。

**判定链（三级，逐级收窄）：**

```ts
function pickProjectedRuntimeSession(
  groupFolder: string,
  agentId: string,
): RuntimeNativeSession | undefined {
  // L1 读激活绑定。conversation_runtime_state 是「当前该用哪个运行时/模型」的
  //    真相源，与 model-runtime.ts 的 activeBindingFromState() 逐字段同构：
  //    active_* 优先，为空回落到基础列。
  const state = getConversationRuntimeState(groupFolder, agentId);   // 33 行，可能不存在
  if (!state) {
    // L3 兜底（见下）
    return pickMostRecentlyUpdated(groupFolder, agentId);
  }
  const binding: ModelBinding = {
    runtime:           state.active_runtime           ?? state.runtime,
    provider_family:   state.active_provider_family   ?? state.provider_family,
    provider_pool_id:  state.active_provider_pool_id  ?? state.provider_pool_id,
    selected_model:
      state.active_model_kind === 'provider_default'
        ? null
        : state.active_selected_model ?? state.selected_model,
    model_kind:        state.active_model_kind        ?? state.model_kind,
    resolved_model:    state.active_resolved_model    ?? state.resolved_model,
  };
  const modelKey = modelKeyForBinding(binding) || LEGACY_CLAUDE_MODEL_KEY;

  // L2 在权威表里找该绑定的 native session。
  //    provider_id / auth_profile_generation 不参与选择 —— 它们是 sticky 选路的
  //    产物，同一个 (runtime, model_key) 下换账号会产生多行，投影只要一行，
  //    取 updated_at 最新的那个账号（= 最后真正用过的）。
  const row = db.prepare(
    `SELECT * FROM conversation_runtime_sessions
      WHERE group_folder = ? AND agent_id = ? AND runtime = ? AND model_key = ?
      ORDER BY updated_at DESC, provider_id ASC
      LIMIT 1`,
  ).get(groupFolder, agentId, binding.runtime, modelKey);
  if (row) return mapRuntimeNativeSession(row);

  // L2' 同 runtime 换了 model（opus → sonnet）：与 model-runtime.ts 的
  //     getCarryOverNativeSession() 同一条兜底规则，保持两处一致。
  const carry = db.prepare(
    `SELECT * FROM conversation_runtime_sessions
      WHERE group_folder = ? AND agent_id = ? AND runtime = ?
      ORDER BY updated_at DESC LIMIT 1`,
  ).get(groupFolder, agentId, binding.runtime);
  if (carry) return mapRuntimeNativeSession(carry);

  // L3 该 runtime 从没跑过（刚切过来）：投影最近用过的任意一行，
  //    好过投一个空壳。
  return pickMostRecentlyUpdated(groupFolder, agentId);
}

function pickMostRecentlyUpdated(groupFolder: string, agentId: string) {
  return db.prepare(
    `SELECT * FROM conversation_runtime_sessions
      WHERE group_folder = ? AND agent_id = ?
      ORDER BY updated_at DESC LIMIT 1`,
  ).get(groupFolder, agentId);
}
```

**L1 与 `model-runtime.ts:78` 的 `activeBindingFromState()` 是同一段逻辑。** 不能各写一份 —— 两处漂移会让投影指向一个运行中根本没在用的会话。**把 `activeBindingFromState` 从 `model-runtime.ts` 提到 `db.ts` 并导出**，两处 import 同一个函数。（`model-runtime.ts` 已经 import `db.ts`，反向 import 会成环，所以搬到 `db.ts` 而不是反过来。）

`ORDER BY updated_at DESC, provider_id ASC` 的第二排序键是确定性 tie-breaker（同毫秒写入两行时结果稳定），同设计 3 §3.2 的理由。

**投影行的字段映射：**

```ts
db.prepare(
  `INSERT INTO workspace_runtime_sessions
     (group_folder, runtime_agent_id, workspace_jid, sdk_session_id,
      provider_id, agent_profile_id, agent_profile_version, identity_hash,
      created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(group_folder, runtime_agent_id) DO UPDATE SET
     workspace_jid   = excluded.workspace_jid,
     sdk_session_id  = excluded.sdk_session_id,
     provider_id     = excluded.provider_id,
     agent_profile_id      = excluded.agent_profile_id,
     agent_profile_version = excluded.agent_profile_version,
     identity_hash   = excluded.identity_hash,
     updated_at      = excluded.updated_at`,
).run(
  groupFolder,
  agentId,
  resolveCanonicalWorkspaceJid(groupFolder).jid,   // ← 设计 3 的函数，唯一来源
  picked.native_session_id,
  picked.provider_id,
  sessionIdentity?.agent_profile_id ?? null,       // 来自 legacy sessions 表（agent profile 三列）
  sessionIdentity?.agent_profile_version ?? null,
  sessionIdentity?.identity_hash ?? null,
  existing?.created_at ?? now,
  now,
);
```

`workspace_jid` 用设计 3 的 `resolveCanonicalWorkspaceJid(folder).jid`。若返回 `null`（R4），**不投影这一行**并删掉可能存在的旧行 —— 一个 `workspace_jid = NULL` 的投影行正是现有 `verifyWorkspaceProjection` 报的 `danglingSessions` 问题。

`agent_profile_*` / `identity_hash` 三列在权威表里**没有**，来自 legacy `sessions` 表（7 列，含 `agent_profile_id` / `identity_hash` / `agent_profile_version`）。这三列是 upstream 的 AgentProfile 体系用的，本地不消费，照抄即可。

## 5.3 现有 4 处级联怎么改

| # | 位置 | 现状 | 改后 |
|---|---|---|---|
| K1 | `db.ts:3678`（`deleteSession()`） | `DELETE FROM sessions …` + `deleteRuntimeNativeSessionsForScope(folder, agentId)` | 两句包进 `db.transaction()`；`deleteRuntimeNativeSessionsForScope` 尾部（T2）自动同步投影 |
| K2 | `db.ts:3723`（`deleteAllSessionsForFolder()`） | `DELETE FROM sessions WHERE group_folder=?` + `deleteRuntimeNativeSessionsForFolder(folder)` | 同上，T3 同步 |
| K3 | `db.ts:5114`（`deleteGroupData()` 的第 4 步） | 裸 `DELETE FROM conversation_runtime_sessions WHERE group_folder=?` + `conversation_runtime_state` | 改成调 `deleteRuntimeNativeSessionsForFolder(folder)`（走 T3），再删 state；`DELETE FROM workspace_runtime_sessions WHERE group_folder=?` 由 T3 完成，**不再手写** |
| K4 | `db.ts:6684`（`deleteAgent()`） | 裸 `DELETE FROM conversation_runtime_sessions WHERE agent_id=?` | 改成先查 `SELECT DISTINCT group_folder FROM conversation_runtime_sessions WHERE agent_id=?`，删完对每个 folder 调 `syncWorkspaceRuntimeSessionProjection(folder, agentId)`。`deleteAgent` 已在 `db.transaction()` 内（要加，现状不是） |

**通则：任何 `DELETE FROM conversation_runtime_sessions` 都必须经过三个导出函数之一**（`deleteRuntimeNativeSessionsForScope` / `…ForFolder` / `deleteAgent` 的新分支），裸 SQL 一律禁止。加一条源码级契约测试：`src/` 下 `DELETE FROM conversation_runtime_sessions` 的出现次数 ≤ 3，且全在 `db.ts` 的这三个函数体内。

## 5.4 upstream 那 11 处删投影表的调用怎么改

upstream 有 12 条 `DELETE FROM workspace_runtime_sessions`（`git show upstream/main:src/db.ts` 行 6658 / 6683 / 6735 / 7990 / 8337 / 8354 / 8382 / 8389 / 8617 / 9718 / 9800 / 11241；其中 8382/8389 同属 `syncWorkspaceRuntimeSessionProjection`）。它们全部把投影表当权威删。逐条处置：

| upstream 行 | 所在函数 | 处置 |
|---|---|---|
| 6658 | `deleteSession(folder, agentId)` | **删这句**，改调 `deleteRuntimeNativeSessionsForScope(folder, agentId)`（= 本地 K1，删权威 → T2 自动清投影） |
| 6683 | `deleteWorkspaceSessions(folder)` | 同上，改调 `deleteRuntimeNativeSessionsForFolder(folder)` |
| 6735 | `deleteAllSessionsForFolder(folder)` | 本地 K2 已有；删 upstream 这句 |
| 7990 | `deleteSessionsForProvider(providerId, …)` | **改成删权威**：`DELETE FROM conversation_runtime_sessions WHERE provider_id = ?{unboundClause}`，再对受影响的 `affectedFolders` 逐个 `syncWorkspaceRuntimeSessionProjection`。这一条**语义最要紧** —— provider 协议字段变更后必须作废该 provider 的 resume token，只删投影等于没删 |
| 8337 | `deleteWorkspaceMirror(jid)` | 保留（它删的是「某个 jid 的投影」，是投影层自己的清理）；但 `workspace_jid` 现在由 `resolveCanonicalWorkspaceJid` 决定，删完要对该 folder 重新投一次 |
| 8354 | `deleteWorkspaceMirror` 的 folder 分支 | 同上，改成调 `syncWorkspaceRuntimeSessionProjection(folder, agentId)` 逐个重投 |
| 8382 / 8389 | `syncWorkspaceRuntimeSessionProjection`（upstream 版，源是 `sessions` 表） | **整个函数替换成本地版**（源改成 `conversation_runtime_sessions`，见 §5.2）。这两句 DELETE 在本地版里保留 —— 它们是「无权威行 ⇒ 删投影」的正确行为 |
| 8617 | `reconcileCanonicalRuntimeProjections()` 里的 `DELETE … WHERE NOT EXISTS (sessions …)` | **改条件**：`NOT EXISTS (SELECT 1 FROM conversation_runtime_sessions crs WHERE crs.group_folder = … AND crs.agent_id = …)`，且第二个 `NOT EXISTS`（校验 `registered_groups … jid LIKE 'web:%' AND folder = …`）改成校验 `workspaces` 表的 folder（设计 3 之后 `workspaces` 才是 folder→jid 的规范映射） |
| 9718 | `deleteImGroupRecord()` 里 `WHERE runtime_agent_id IN (SELECT id FROM agents WHERE chat_jid=?)` | 改成先删权威：`DELETE FROM conversation_runtime_sessions WHERE agent_id IN (SELECT id FROM agents WHERE chat_jid=?)`，再对涉及的 folder 重投 |
| 9800 | `deleteGroupData()` 的 3b | 本地 K3 已覆盖；删 upstream 这句 |
| 11241 | `deleteAgent(id)` | 本地 K4 已覆盖；删 upstream 这句 |

**结果：`src/` 里 `DELETE FROM workspace_runtime_sessions` 只剩 3 处**，全部在 `syncWorkspaceRuntimeSessionProjection` / `rebuildWorkspaceRuntimeSessionProjection` / `deleteWorkspaceMirror` 内。同样加源码级契约测试钉死这个数字。

## 5.5 初次迁移怎么重建投影

在设计 3 的 `rebuildWorkspaceProjection()` **同一个事务**里（这就是为什么设计 3 必须先做）：

```ts
const tx = db.transaction(() => {
  // …设计 3 §3.3 的 workspaces 重建…

  db.prepare('DELETE FROM workspace_runtime_sessions').run();

  // 权威表的全部作用域（25 个），不是 sessions 表的 17 个
  const scopes = db.prepare(
    `SELECT DISTINCT group_folder, agent_id
       FROM conversation_runtime_sessions
      ORDER BY group_folder, agent_id`,
  ).all() as Array<{ group_folder: string; agent_id: string }>;

  let written = 0;
  for (const s of scopes) {
    if (syncWorkspaceRuntimeSessionProjectionInTx(s.group_folder, s.agent_id)) written++;
  }
  runtimeSessions = written;
});
```

**预期结果（本机数据）**：52 行权威 → 25 个作用域 → 至多 25 行投影（减去 `resolveCanonicalWorkspaceJid` 返回 null 的作用域）。当前是 16 行，因为它投的是 17 行的 legacy `sessions` 表。**行数会从 16 涨到约 25，这是预期的**，验收时不要当成异常。

`verifyWorkspaceProjection()`（设计 3 §3.5）追加两项检查：

```ts
// 7. 投影行没有对应的权威作用域（孤儿投影）
SELECT w.group_folder, w.runtime_agent_id FROM workspace_runtime_sessions w
 WHERE NOT EXISTS (
   SELECT 1 FROM conversation_runtime_sessions c
    WHERE c.group_folder = w.group_folder AND c.agent_id = w.runtime_agent_id
 ) LIMIT 5;

// 8. 权威作用域没有投影行，且该 folder 能解出规范 jid（本该有投影却没有）
SELECT DISTINCT c.group_folder, c.agent_id FROM conversation_runtime_sessions c
  JOIN workspaces ws ON ws.folder = c.group_folder
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_runtime_sessions w
    WHERE w.group_folder = c.group_folder AND w.runtime_agent_id = c.agent_id
 ) LIMIT 5;
```

## 5.6 迁移步骤

| 步 | 做什么 | 验收 |
|---|---|---|
| **P0** | （前置）设计 3 的 W1–W3 已完成 | `resolveCanonicalWorkspaceJid` 可用 |
| **P1** | `activeBindingFromState` 从 `model-runtime.ts` 搬到 `db.ts` 并导出，`model-runtime.ts` 改 import | `make typecheck` 通过；`/model` 行为不变 |
| **P2** | 加 `pickProjectedRuntimeSession` + `syncWorkspaceRuntimeSessionProjection`（新实现），暂不挂触发点 | 单测：7 行的那个作用域（`task-1fa16ce0-642`）在不同 `active_runtime` 下选出不同的行 |
| **P3** | `rebuildWorkspaceRuntimeSessionProjection()` 接进设计 3 的事务；启动全量重建 | `SELECT COUNT(*) FROM workspace_runtime_sessions` 从 16 → 约 25；`verifyWorkspaceProjection().ok === true` |
| **P4** | 挂 T1–T4 五个触发点；`setRuntimeNativeSession` / `deleteAgent` 包事务 | 手动跑一次 `/model use codex`，确认投影行跟着换 |
| **P5** | 改 K1–K4 四处级联 | 删一个 agent，投影行同步消失（不留孤儿） |
| **P6** | 合并后处理 upstream 的 12 条 DELETE（§5.4） | 源码级契约测试：`DELETE FROM workspace_runtime_sessions` ≤ 3 处、`DELETE FROM conversation_runtime_sessions` ≤ 3 处 |

## 5.7 失败模式

| # | 失败 | 症状 | 防线 |
|---|---|---|---|
| L1 | T4 漏挂（切模型后不同步投影） | 投影指向一个已经不在用的 native session。**本地零消费方，所以完全不报错**，直到某天 upstream 的某个新文件开始读它 | `verifyWorkspaceProjection` 第 7/8 项检查抓不到这种（行在、内容错）。补第 9 项：逐作用域比对 `sdk_session_id` 与 `pickProjectedRuntimeSession()` 的结果 |
| L2 | `pickProjectedRuntimeSession` 与 `activeBindingFromState` 漂移 | 同 L1 | P1 强制两处共用同一个导出函数；加一条断言测试 |
| L3 | `setRuntimeNativeSession` 包事务后与外层已有事务嵌套 | better-sqlite3 的 `db.transaction()` 支持嵌套（内层变 savepoint），**不会报错**；但若外层回滚，投影和权威一起回滚——正确 | 无需额外防线，写进注释说明是有意为之 |
| L4 | upstream 第 7990 行（`deleteSessionsForProvider`）只改了投影没改权威 | provider 协议字段变更后 resume token 没作废 → thinking block 签名失效 → 该 provider 的所有会话报错 | §5.4 明确标注这一条「语义最要紧」；单测：改 provider 后 `conversation_runtime_sessions` 中该 provider 的行数为 0 |
| L5 | `workspace_jid` 为 null 的投影行 | 现有 `verifyWorkspaceProjection` 的 `danglingSessions` 检查会报 | §5.2 明确：解不出规范 jid 就不投影 + 删旧行 |
| L6 | P3 之后行数从 16 涨到 25，被误判成 bug 而回滚 | 无谓的回滚 | 本文档 §5.5 写明预期值；启动日志打 `{before, after, scopes}` 三个数 |

## 5.8 回滚

| 步 | 回滚 | 有损？ |
|---|---|---|
| P1 | revert（纯搬函数） | 无 |
| P2 | revert（新函数无人调用） | 无 |
| P3 | 把 `rebuildWorkspaceRuntimeSessionProjection()` 换回旧的「从 sessions 表投影」版本，跑一次重建 → 回到 16 行 | 无（投影表零消费方） |
| P4 | 摘掉五个触发点 | 无 |
| P5 | revert 四处级联 | 无 |
| P6 | 取 upstream 侧 | 有损：会重新产生孤儿，但不影响运行时 |

**整节全程无损**，因为 `workspace_runtime_sessions` 有零个业务读取方。权威表 `conversation_runtime_sessions` 的 52 行**在任何一步里都不被删除或改写**（P4/P5 只是把删除路径收敛到三个函数，删除条件本身不变）。

---

# 设计 6 · 用量与配额的运行时分口径

## 6.0 已定的两条口径

1. **订阅制运行时（codex / grok）记 0 成本，不进扣费。** 它们的 `costUSD` 本来就是 0（`upstream-decision-tree.md` D4.4a），引入 Kaboo 定价后如果不门控，会按 Claude Sonnet 的 $3/$15 per Mtok fallback **真的从 `user_balances` 扣款**，测算 $2162。
2. **可计费输入按各自口径算。** 实测（本机 `usage_records`）：

```
runtime   rows   input_tokens   cache_read     cost_usd
(null)    4385     96,827,436  2,003,445,030   5554.87    ← runtime 列上线前的历史
claude    1868     15,506,707  1,509,751,485   1791.86    ← input 不含 cacheRead（Anthropic 口径）
codex      737    637,069,178    543,278,042      0.59    ← input 含 cacheRead（OpenAI 口径，85% 是缓存）
grok        21        804,768        629,824      0.00    ← 同 OpenAI 口径
```

codex 的 `input_tokens` 里 85% 是 cachedRead。配额按 `input + output` 算（`billing.ts:915`、`db.ts:7568`），所以 codex 的配额消耗被膨胀 1.85 倍、grok 1.78 倍 —— **且这与计费开关无关**（`updateUsage` 在 `costUSD > 0` 时才调，但 codex 的 `costUSD` 是 0，所以现在其实**根本没进配额**；一旦 Kaboo 定价让它变成非 0，膨胀立刻生效）。

## 6.1 `billableInput` 的分支逻辑

```ts
// src/usage-accounting.ts（新文件，纯函数，可单测）

export type UsageInputConvention = 'excludes_cache_read' | 'includes_cache_read';

/**
 * 各运行时的 inputTokens 口径。
 *
 * Anthropic 的 usage.input_tokens **不含** cache_read_input_tokens，三者相加才是
 * 总输入。OpenAI / xAI 的 prompt_tokens **含** cached_tokens，cached 只是其中一个
 * 拆分项。两种口径混算会让 codex/grok 的缓存部分被计两遍
 * （CLAUDE.md §8.14 的「分列 SUM 不相减」说的就是这件事）。
 */
export const RUNTIME_INPUT_CONVENTION: Record<AgentRuntime, UsageInputConvention> = {
  claude: 'excludes_cache_read',
  codex:  'includes_cache_read',
  grok:   'includes_cache_read',
};

export interface RawTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens?: number;
}

export interface NormalizedTokenCounts extends RawTokenCounts {
  /**
   * 「真正付钱 / 真正占配额的输入」，两种口径归一后的同一个量：
   *   excludes_cache_read → inputTokens                （cacheRead 单列，不加）
   *   includes_cache_read → inputTokens - cacheRead    （减掉，避免算两遍）
   * 下限 0：provider 偶发返回 cachedRead > input 时不产生负数。
   */
  billableInput: number;
  /** 归一后的 cacheRead，始终单列，永不并进 billableInput。 */
  billableCacheRead: number;
  convention: UsageInputConvention;
}

export function normalizeTokenCounts(
  runtime: AgentRuntime | null | undefined,
  raw: RawTokenCounts,
): NormalizedTokenCounts {
  const convention = RUNTIME_INPUT_CONVENTION[runtime ?? 'claude'] ?? 'excludes_cache_read';
  const cacheRead = Math.max(0, raw.cacheReadInputTokens || 0);
  const rawInput = Math.max(0, raw.inputTokens || 0);
  const billableInput =
    convention === 'includes_cache_read'
      ? Math.max(0, rawInput - cacheRead)
      : rawInput;
  return {
    ...raw,
    inputTokens: rawInput,
    cacheReadInputTokens: cacheRead,
    billableInput,
    billableCacheRead: cacheRead,
    convention,
  };
}

/** 配额消耗量。三条运行时统一：billableInput + cacheRead + cacheCreation + output。 */
export function quotaTokens(n: NormalizedTokenCounts): number {
  return (
    n.billableInput +
    n.billableCacheRead +
    Math.max(0, n.cacheCreationInputTokens || 0) +
    Math.max(0, n.outputTokens || 0)
  );
}
```

**`runtime` 缺失时按 `excludes_cache_read`（Claude 口径）** —— 那 4385 行历史数据全是 Claude 时代的，这个默认值让历史查询的口径与当时一致。

**`normalizeTokenCounts` 不改写 `inputTokens`**：入库仍存 provider 原样上报的值，`billableInput` 是另加的一列。原始值必须留着，否则口径判断错了之后无法回溯重算。

**成本门控：**

```ts
/** 订阅制运行时：成本恒 0，不进扣费。 */
export const SUBSCRIPTION_RUNTIMES: ReadonlySet<AgentRuntime> = new Set(['codex', 'grok']);

export interface CostDecision {
  costUSD: number;
  costStatus: 'exact' | 'estimated' | 'unavailable';
  costSource: 'runtime' | 'pricing_table' | 'zero_fallback' | 'legacy' | 'subscription';
  /** 是否进 deductUsageCost（扣余额）。 */
  billable: boolean;
}

export function decideCost(input: {
  runtime: AgentRuntime | null | undefined;
  model: string;
  runtimeReportedCostUSD: number | undefined;   // SDK 上报的
  normalized: NormalizedTokenCounts;
}): CostDecision {
  // ① 订阅制：恒 0，不扣费。Kaboo 的 Sonnet fallback 绝不能走到这里。
  if (input.runtime && SUBSCRIPTION_RUNTIMES.has(input.runtime)) {
    return { costUSD: 0, costStatus: 'exact', costSource: 'subscription', billable: false };
  }
  // ② 运行时自报（Claude SDK 的 total_cost_usd）优先
  if (typeof input.runtimeReportedCostUSD === 'number') {
    return {
      costUSD: input.runtimeReportedCostUSD,
      costStatus: 'exact',
      costSource: 'runtime',
      billable: input.runtimeReportedCostUSD > 0,
    };
  }
  // ③ Kaboo 价格表估算（决策 40）。matchKabooModelPricing 命中不了就是
  //    KABOO_SONNET_FALLBACK —— 只对 Claude 系可接受。
  const pricing = matchKabooModelPricing(input.model);
  if (!pricing) {
    return { costUSD: 0, costStatus: 'unavailable', costSource: 'zero_fallback', billable: false };
  }
  return {
    costUSD: kabooCostCentsToUSD(
      estimateKabooModelCostCents(input.model, toKabooUsage(input.normalized, pricing)),
    ),
    costStatus: 'estimated',
    costSource: 'pricing_table',
    billable: true,
  };
}
```

**③ 里 `matchKabooModelPricing` 返回 undefined 就不估价**，不用 `KABOO_SONNET_FALLBACK`。这是对 upstream 的一处刻意偏离：upstream 把 Sonnet fallback 当兜底，那在纯 Claude 环境是合理的，在三运行时环境是错扣的直接来源。`costStatus='unavailable'` 让「没算出来」和「算出来是 0」在数据上可分。

## 6.2 价格表加 `inputIncludesCacheRead` 后 13 条规则怎么补

Kaboo 的 `estimateKabooModelCostUSD` 把五类 token **分别乘价再相加**：

```
input × inputPrice + output × outputPrice + cacheRead × cacheReadPrice
  + cacheCreation × cacheCreationPrice + reasoning × reasoningPrice
```

它隐含假设 `inputTokens` 与 `cacheReadInputTokens` **不重叠**（Anthropic 口径）。喂 OpenAI 口径的数进去，缓存部分被算两遍。

**改法：给 `KabooModelPricing` 加一个字段，并在入口处归一。**

```ts
export interface KabooModelPricing {
  pattern: string;
  displayName: string;
  family: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number;
  cacheCreationPricePerMTok: number;
  reasoningPricePerMTok: number;
  /**
   * 该 family 上报的 inputTokens 是否已经包含 cacheRead。
   * true 时 estimateKabooModelCostUSD 先做 input -= cacheRead 再计价，
   * 否则缓存部分会被 inputPrice 和 cacheReadPrice 各算一次。
   * anthropic 全部 false；openai / xai 为 true。
   */
  inputIncludesCacheRead: boolean;
}
```

**13 条现有规则全部补 `inputIncludesCacheRead: false`** —— 它们 `family` 都是 `'anthropic'`，口径是「input 不含 cacheRead」，加这个字段是**显式化既有行为，零语义变化**。

改 `price()` 工厂让它默认 false，13 处调用点一行不动：

```ts
const price = (
  pattern: string, displayName: string, family: string,
  inputPricePerMTok: number, outputPricePerMTok: number,
  cacheReadPricePerMTok: number, cacheCreationPricePerMTok: number,
  reasoningPricePerMTok: number,
  inputIncludesCacheRead = false,        // ← 只加这一个带默认值的尾参
): KabooModelPricing => ({ …, inputIncludesCacheRead });
```

`KABOO_SONNET_FALLBACK` 同样加 `inputIncludesCacheRead: false`（它是 Claude Sonnet class）。

**计价入口归一：**

```ts
export function estimateKabooModelCostUSD(
  modelName: string,
  rawUsage: Partial<KabooTokenUsage>,
): number {
  const usage = normalizeKabooTokenUsage(rawUsage);
  const pricing = matchKabooModelPricing(modelName) ?? KABOO_SONNET_FALLBACK;
  // 口径归一：把 input 统一成「不含 cacheRead」再分项计价。
  const billableInput = pricing.inputIncludesCacheRead
    ? Math.max(0, usage.inputTokens - usage.cacheReadInputTokens)
    : usage.inputTokens;
  return (
    (billableInput / 1_000_000) * pricing.inputPricePerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPricePerMTok +
    (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPricePerMTok +
    (usage.cacheCreationInputTokens / 1_000_000) * pricing.cacheCreationPricePerMTok +
    (usage.reasoningTokens / 1_000_000) * pricing.reasoningPricePerMTok
  );
}
```

**将来补 codex / grok 价格规则时**（决策 40 选项 A 是先门控，不补表；选项 B 是补表），新增条目写 `inputIncludesCacheRead: true`，其余逻辑无需再改。这个字段的价值就是把「未来补表」从一次重构降级成一次追加。

**`reasoningPricePerMTok` 的注意事项**：Kaboo 迁移 000030 把 reasoning 按 output 价计，而 OpenAI 口径的 `outputTokens` **已经包含** reasoning（CLAUDE.md §8.14：「outputTokens 已含 reasoning，不另加」）。所以补 codex/grok 规则时 `reasoningPricePerMTok` 必须填 **0**，否则 reasoning 也被算两遍。这一条写进 `kaboo-pricing.ts` 的模块注释。

## 6.3 `usage_records` 31 列的完整 INSERT

三方合并：本地 26 列 + upstream 21 列，交集 15。

**15 列共有**（列名两边一致，直接留）：

```
id · user_id · group_folder · agent_id · message_id · model
input_tokens · output_tokens · cache_read_input_tokens · cache_creation_input_tokens
cost_usd · duration_ms · num_turns · source · created_at
```

**11 列本地独有**（决策 11：继续写，走 upstream 路径会全 NULL）：

```
runtime · provider_family · provider_pool_id · provider_id · auth_profile_generation
selected_model · resolved_model · billing_scope · cost_status · cost_source
usage_metadata_json
```

**5 列 upstream 独有**（决策 10/42：要，upstream 用量页与 CSV 依赖）：

```
event_id                        幂等键，'legacy:'||id 回填历史
reasoning_output_tokens         推理 token（响亮失败清单第 1 项：字段必填）
provider_estimated_cost_usd     价格表估算值
billed_cost_usd                 实际扣费值（订阅制恒 0）
usage_date                      date(created_at,'localtime')，用量页按本地日期分组
```

**新增 2 列**（本设计，用于口径可追溯）：

```
billable_input_tokens  INTEGER NOT NULL DEFAULT 0   -- normalizeTokenCounts 的 billableInput
input_convention       TEXT                          -- 'excludes_cache_read' | 'includes_cache_read'
```

`input_convention` 落库而不是每次从 `runtime` 反推：将来某个 provider 改了口径，历史行仍能按当时的口径重算。**这一列是整节唯一的「将来不后悔」投资。**

合计 **15 + 11 + 5 + 2 = 33 列**（口径表里说的 31 是不含新增 2 列的合并数）。

完整 INSERT（替换 `src/db.ts:165` 的 `insertUsageInsert`）：

```sql
INSERT INTO usage_records (
  id, event_id, user_id, group_folder, agent_id, message_id, model,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  reasoning_output_tokens, billable_input_tokens, input_convention,
  cost_usd, provider_estimated_cost_usd, billed_cost_usd,
  duration_ms, num_turns, source, usage_date, created_at,
  runtime, provider_family, provider_pool_id, provider_id, auth_profile_generation,
  selected_model, resolved_model, billing_scope, cost_status, cost_source,
  usage_metadata_json
) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?)
```

`insertUsageRecord()` 的参数对象相应加：

```ts
export function insertUsageRecord(record: {
  // …现有 25 个字段…
  eventId?: string | null;                    // 缺省 `${messageId ?? id}:${model}`
  reasoningTokens?: number;
  billableInputTokens?: number;               // 缺省 = inputTokens（Claude 口径）
  inputConvention?: UsageInputConvention | null;
  providerEstimatedCostUSD?: number;
  billedCostUSD?: number;                     // 订阅制恒 0
  usageDate?: string | null;                  // 缺省 toLocalDateString()
}): void;
```

**`event_id` 的生成规则**：`${messageId}:${model}`。同一条消息的 per-model 拆行天然不同，重放（重试轮、恢复路径）会命中同一个 id。加唯一索引让重复插入变成显式失败而不是静默重复计费：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_event ON usage_records(event_id)
  WHERE event_id IS NOT NULL;
```

历史 7008 行回填 `'legacy:' || id`（与 upstream v51 迁移一致），彼此唯一，不会冲突。

**调用侧改动**（`src/index.ts:1287` / `:1307` 的 `writeUsageRecords`）：

```ts
const normalized = normalizeTokenCounts(runtimeResolution?.binding.runtime, {
  inputTokens: mu.inputTokens,
  outputTokens: mu.outputTokens,
  cacheReadInputTokens: mu.cacheReadInputTokens || 0,
  cacheCreationInputTokens: mu.cacheCreationInputTokens || 0,
  reasoningTokens: mu.reasoningTokens || 0,
});
const cost = decideCost({
  runtime: runtimeResolution?.binding.runtime,
  model,
  runtimeReportedCostUSD: mu.costUSD,
  normalized,
});
insertUsageRecord({
  …,
  inputTokens: normalized.inputTokens,             // 原样，不改写
  billableInputTokens: normalized.billableInput,
  inputConvention: normalized.convention,
  reasoningTokens: normalized.reasoningTokens ?? 0,
  costUSD: cost.costUSD,
  providerEstimatedCostUSD: cost.costSource === 'pricing_table' ? cost.costUSD : 0,
  billedCostUSD: cost.billable ? cost.costUSD : 0,
  costStatus: cost.costStatus,
  costSource: cost.costSource,
});
```

**配额与扣费侧**（`src/index.ts:3807` 的 `persistUsageForReply`）：

```ts
// 现状：只有 costUSD 非 0 才进配额 → codex/grok 的配额从来没被记过
if (ownerGroup?.created_by && normalizedUsage.costUSD) { … }

// 改后：配额与成本解耦。token 配额三条运行时都记，成本只在 billable 时扣。
if (ownerGroup?.created_by) {
  const n = normalizeTokenCounts(activeRuntimeResolution?.binding.runtime, normalizedUsage);
  const effective = updateUsage(
    ownerGroup.created_by,
    cost.billable ? cost.costUSD : 0,      // 订阅制记 0 成本
    n.billableInput + n.billableCacheRead + n.cacheCreationInputTokens,  // 输入侧配额
    n.outputTokens,
  );
  if (cost.billable) {
    deductUsageCost(ownerGroup.created_by, cost.costUSD, messageId, effective);
  }
}
```

`updateUsage` 的第三参从 `inputTokens` 改成 `billableInput + cacheRead + cacheCreation`：

- claude：`input + cacheRead + cacheCreation`（原来只有 `input`，**配额会变严**——这是修 bug，缓存读取本来就占上下文）
- codex/grok：`(input - cacheRead) + cacheRead + cacheCreation = input + cacheCreation`，与原来的 `input` 几乎一致，**膨胀消失**

`upstream-merge-plan.md` §5.4 的验证式相应固定为：

```
codex  会话：billable_input_tokens == input_tokens - cache_read_input_tokens
claude 会话：billable_input_tokens == input_tokens
两者   配额输入 == billable_input + cache_read + cache_creation
```

## 6.4 `usage_daily_summary` 要不要加 runtime 维度

**要，主键从 `(user_id, model, date)` 加到 `(user_id, model, date, runtime)`。**

三个理由：

1. **`model` 列不足以区分运行时。** 本地 `writeUsageRecords` 在无 `modelUsage` 时用 `fallbackModel = ${runtime}:${modelOverride…}` 拼名字（含 runtime 前缀），但有 `modelUsage` 时用 SDK 上报的裸模型名。同一份日汇总里两种命名混着，按 model 分组算不出「codex 今天用了多少」。
2. **口径不同的行不能相加。** claude 的 `total_input_tokens` 与 codex 的语义不同（前者不含 cacheRead），聚合到同一行之后无法拆开重算 —— 这正是决策 66「token 总数显示按运行时分口径」在数据层的前提。
3. **代价极小。** 现有行数是 `用户 × 模型 × 天`；加一维后基本不变（一个模型只属于一个运行时）。

```sql
-- 新表结构
CREATE TABLE IF NOT EXISTS usage_daily_summary (
  id                          INTEGER PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  model                       TEXT NOT NULL,
  runtime                     TEXT NOT NULL DEFAULT 'claude',   -- ← 新增
  date                        TEXT NOT NULL,
  total_input_tokens          INTEGER NOT NULL DEFAULT 0,
  total_billable_input_tokens INTEGER NOT NULL DEFAULT 0,       -- ← 新增
  total_output_tokens         INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_reasoning_tokens      INTEGER NOT NULL DEFAULT 0,       -- ← 新增
  total_cost_usd              REAL    NOT NULL DEFAULT 0,
  total_billed_cost_usd       REAL    NOT NULL DEFAULT 0,       -- ← 新增
  request_count               INTEGER NOT NULL DEFAULT 0,
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_uds_scope
  ON usage_daily_summary(user_id, model, runtime, date);
```

`runtime` 默认 `'claude'`：历史行（runtime 列上线前的 4385 条明细汇总出来的）确实全是 Claude 时代的。

**迁移**：加列 + 建新唯一索引 + 从 `usage_records` 全量重算一次（历史 7000+ 行，一次 `INSERT … SELECT … GROUP BY`，秒级）。重算而不是原地补 `runtime` 列，因为原来按 model 聚合的行可能跨运行时（`fallbackModel` 命名混用），只能拆开重来。

```sql
DELETE FROM usage_daily_summary;
INSERT INTO usage_daily_summary
  (user_id, model, runtime, date,
   total_input_tokens, total_billable_input_tokens, total_output_tokens,
   total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens,
   total_cost_usd, total_billed_cost_usd, request_count, updated_at)
SELECT user_id, model, COALESCE(runtime,'claude'),
       COALESCE(usage_date, date(created_at,'localtime')),
       SUM(input_tokens), SUM(billable_input_tokens), SUM(output_tokens),
       SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
       SUM(COALESCE(reasoning_output_tokens,0)),
       SUM(cost_usd), SUM(COALESCE(billed_cost_usd,0)), COUNT(*), datetime('now')
  FROM usage_records
 GROUP BY 1,2,3,4;
```

`getUsageDailyStats()`（`db.ts:3029`）返回值加 `runtime` / `billable_input_tokens` / `reasoning_tokens` / `billed_cost_usd`，并加一个可选 `runtimeFilter` 参数。

**前端（决策 66）**：`UsagePage` 的「总 token」卡片从「五类相加」改成按运行时分组后再相加：

```
claude   input + cacheRead + cacheCreation + output
codex    billableInput + cacheRead + cacheCreation + output   （= input + cacheCreation）
grok     同 codex
```

用 `total_billable_input_tokens` 就能三条统一成 `billableInput + cacheRead + cacheCreation + output`，不需要前端判断口径。**这是加 `billable_input_tokens` 列最直接的回报。**

## 6.5 CSV 导出加哪几列

upstream 的 `GET /api/usage/export.csv`（`src/routes/usage.ts:193`）17 列：

```
eventId · createdAt · userId · agentId · groupFolder · source · model
inputTokens · outputTokens · cacheReadTokens · cacheCreationTokens · reasoningTokens
providerEstimatedCostUSD · billedCostUSD · durationMs · numTurns · messageId
```

**加 6 列**（决策 42「用量导出加 runtime 列，现在导出后无法按运行时归因」）：

```ts
const columns = [
  'eventId', 'createdAt', 'usageDate',            // ← usageDate 新增（本地时区日期，跨时区对账用）
  'userId', 'agentId', 'groupFolder', 'source',
  'runtime',                                       // ← 新增：claude | codex | grok
  'providerPoolId',                                // ← 新增：区分同运行时下的不同池
  'providerId',                                    // ← 新增：区分同池下的不同账号（额度墙排查）
  'model', 'selectedModel', 'resolvedModel',       // ← selectedModel/resolvedModel 新增
  'inputTokens',
  'billableInputTokens',                           // ← 新增
  'inputConvention',                               // ← 新增：口径标记，让 CSV 自解释
  'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'reasoningTokens',
  'providerEstimatedCostUSD', 'billedCostUSD',
  'costStatus', 'costSource',                      // ← 新增：'subscription' 一眼可辨
  'durationMs', 'numTurns', 'messageId',
];
```

共 27 列。`inputConvention` 与 `costSource` 两列让 CSV **自解释**：拿到文件的人不需要读代码就知道 codex 那些行的 input 为什么要减 cacheRead、为什么成本是 0。

`csvCell()` 的公式注入防护（`/^[=+\-@]/` 前缀加 `'`）原样保留 —— 那是 upstream 做对的地方。

导出上限 `exportLimit = 10_000` 保留。本地 `usage_records` 7011 行，一次导得完；加了 runtime 筛选后更少。

## 6.6 迁移步骤

| 步 | 做什么 | 验收 |
|---|---|---|
| **U1** | 新建 `src/usage-accounting.ts`（`normalizeTokenCounts` / `quotaTokens` / `decideCost` / `RUNTIME_INPUT_CONVENTION` / `SUBSCRIPTION_RUNTIMES`），无人调用 | 单测：三条运行时 × （有缓存 / 无缓存 / cacheRead > input）9 个用例 |
| **U2** | `usage_records` 加 8 列（5 upstream + 2 本设计 + reasoning）；`event_id` 唯一索引；历史回填 `'legacy:'\|\|id`、`usage_date`、`billable_input_tokens = input_tokens`、`input_convention = 'excludes_cache_read'` | `SELECT COUNT(*) FROM usage_records WHERE event_id IS NULL` = 0；行数仍 7011 |
| **U3** | `kaboo-pricing.ts` 加 `inputIncludesCacheRead`（13 条 + fallback 全 false）+ `estimateKabooModelCostUSD` 归一 | 单测：Anthropic 模型的计价结果与改动前**逐位相同** |
| **U4** | `insertUsageRecord` 换新 INSERT；`writeUsageRecords` 接 `normalizeTokenCounts` + `decideCost` | 跑一轮 grok：新行的 `cost_usd`=0、`cost_source`='subscription'、`billable_input_tokens` = `input_tokens - cache_read` |
| **U5** | `persistUsageForReply` 的配额分支解耦（token 配额三条都记，成本只在 billable 时扣） | 跑一轮 codex：`daily_usage.total_input_tokens` 的增量 ≈ `input + cacheCreation`，不是 `input`（膨胀消失） |
| **U6** | `usage_daily_summary` 加 4 列 + 换唯一索引 + 全量重算 | 重算前后 `SUM(total_cost_usd)` 相等（分组变细不改总和） |
| **U7** | CSV 导出 27 列；前端 token 卡片按运行时分口径 | 导出一份，肉眼确认 codex 行的 `inputConvention` = `includes_cache_read` |

**U3 必须在 U4 之前**，否则 U4 一上线，codex/grok 走 `decideCost` 的 ③ 分支之前那一瞬间（如果 ① 的门控写错）就会按 Sonnet 计价扣费。加一条保险：U4 上线的同一个 commit 里，`deductUsageCost()` 入口加

```ts
if (runtime && SUBSCRIPTION_RUNTIMES.has(runtime)) {
  logger.error({ runtime, costUSD, msgId }, 'BUG: subscription runtime reached deductUsageCost');
  return;
}
```

—— 双保险，且出问题时是响亮的 error 而不是静默扣款。

## 6.7 失败模式

| # | 失败 | 症状 | 防线 |
|---|---|---|---|
| M1 | `decideCost` 的订阅制门控在某条路径上被绕过 | codex/grok 按 Sonnet fallback 扣费，测算 $2162 | `deductUsageCost` 入口的二次门控（§6.6）；单测：`decideCost({runtime:'codex', runtimeReportedCostUSD: undefined, model:'gpt-5.5'}).billable === false` |
| M2 | `inputIncludesCacheRead` 给 anthropic 规则误填 true | Claude 成本被少算（input 减掉了不该减的 cacheRead） | U3 的「逐位相同」回归测试；13 条规则的 `family === 'anthropic'` 断言 |
| M3 | 补 codex/grok 价格规则时忘了 `reasoningPricePerMTok: 0` | reasoning 算两遍（outputTokens 已含） | `kaboo-pricing.ts` 模块注释 + 一条断言：`family !== 'anthropic'` 的规则必须 `reasoningPricePerMTok === 0` |
| M4 | `event_id` 唯一索引导致重试轮插入失败并抛异常，中断回复流程 | 一条消息重试后整轮失败 | `insertUsageRecord` 用 `INSERT OR IGNORE`（不是裸 INSERT）；重复时 `logger.debug` 而非抛错 |
| M5 | `billable_input_tokens` 回填时对历史 codex 行也填了 `= input_tokens` | 历史 codex 行的口径标成 Claude → 用量页历史数字虚高 | U2 的回填按 `runtime` 分支：`CASE WHEN runtime IN ('codex','grok') THEN MAX(0, input_tokens - cache_read_input_tokens) ELSE input_tokens END`，`input_convention` 同理 |
| M6 | U5 之后 Claude 用户的配额突然变严（多算了 cacheRead） | 用户投诉「今天怎么这么快就到额度了」 | 这是有意的修正（缓存读取确实占上下文），但**必须在 U5 上线前**看一眼现有 plan 的 `daily_token_quota` 是否需要按新口径上调；否则等投诉来就晚了 |
| M7 | `usage_daily_summary` 重算时 `usage_date` 为 NULL 的历史行落到错误的日期 | 日汇总与明细对不上 | 重算 SQL 里 `COALESCE(usage_date, date(created_at,'localtime'))`；重算后跑一次 `SUM` 对账 |
| M8 | 前端 token 卡片仍五类相加 | codex/grok 缓存算两遍，数字虚高 1.85 倍 | 改用 `total_billable_input_tokens`；决策 66 的验收点 |

## 6.8 回滚

| 步 | 回滚 | 有损？ |
|---|---|---|
| U1 | revert（纯函数无调用） | 无 |
| U2 | 8 个新列留着（NULL 对旧代码不可见），删唯一索引 | 无 |
| U3 | revert（默认值 false，行为等价） | 无 |
| U4 | revert 到旧 `insertUsageInsert`（26 列）。新列停止写入，已写的留着 | 无 |
| U5 | revert 配额分支。**注意**：U5 期间已计入的配额不会退回 | **有损**：`daily_usage` / `monthly_usage` 里 U5 期间的增量按新口径记。若要精确回滚，用 `reconcileMonthlyUsage()`（`billing.ts:846`）按 `daily_usage` 重算月表 —— 但 `daily_usage` 本身也是新口径，只能靠 `usage_records` 全量重算 |
| U6 | 反向：删 4 列 + 换回旧唯一索引 + 全量重算（`usage_records` 是真相源，随时可重算） | 无 |
| U7 | revert（纯展示） | 无 |

**U5 是唯一有损的一步**，所以它的顺序排在最后（U6/U7 是展示层，可与 U5 换序）。上线前先 `VACUUM INTO` 一份 `usage_records` 快照 —— 有它就能把任何口径重算回来。

---

# 附：六项设计的实施顺序

```
阶段 0（合并前）
  设计 2 的 S1–S4        绑定解析三态 + 三个调用点 + 文案
  设计 4 的 Q1           轮次计数（只观测）

阶段 2（合并期，数据库前置）
  设计 3 的 W1–W3        workspaces 换主键 + 规范 jid
  设计 5 的 P0–P5        权威 + 派生（依赖设计 3）
  设计 6 的 U1–U4        口径分离 + 列合成（静默杀手 #2）
  设计 2 的 S5           接 upstream 的 fail-closed
  设计 3 的 W4           覆盖 syncAllWorkspacesFromRegisteredGroups（三层标记）
  设计 5 的 P6           处理 upstream 12 条 DELETE

阶段 2 之后
  设计 4 的 Q2–Q4        并发闸换算法 + 逐出 + 前端
  设计 6 的 U5–U7        配额解耦 + 日汇总 + CSV

阶段 5
  设计 1 的 M1–M6        多账号（依赖设计 2 已落地）
```

**跨设计的三个共享点**（各只允许有一份实现）：

| 共享物 | 定义在 | 使用者 |
|---|---|---|
| `resolveCanonicalWorkspaceJid(folder)` | `src/db.ts`（设计 3 §3.2） | 设计 3 的投影 · 设计 5 的 `workspace_jid` · upstream 的 `getWorkspaceJidForFolder` |
| `activeBindingFromState(state)` | `src/db.ts`（设计 5 §5.2 从 `model-runtime.ts` 搬来） | `model-runtime.ts:210` 的 `resolveRuntimeForScope` · 设计 5 的 `pickProjectedRuntimeSession` |
| `normalizeTokenCounts(runtime, raw)` | `src/usage-accounting.ts`（设计 6 §6.1） | `writeUsageRecords` 入库 · `persistUsageForReply` 配额 · `usage_daily_summary` 重算 · CSV 导出 |

三者任何一个出现第二份实现，就会产生一个「看起来对、实际漂移」的静默 bug —— 与这次合并里我们花最多力气对付的那类问题同源。
