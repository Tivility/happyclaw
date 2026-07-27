import {
  logger,
} from './logger.js';
import {
  describeFeishuError,
} from './feishu.js';

/**
 * Dispatch for the `feishu_capability` IPC request that backs the ten
 * feishu_* MCP tools (batch 3).
 *
 * Upstream routes these through a ChannelTurnContext carrying a
 * channelAccountId from its multi-account `channel_accounts` model, which this
 * fork deliberately did not adopt. Everything the tools actually need is the
 * chat id, which the agent already has via ctx.chatJid, so the operations are
 * expressed directly against a Feishu client instead.
 *
 * Every operation returns rather than throws: the agent is blocked on an IPC
 * round-trip waiting for this answer, and an unanswered request would hang the
 * turn until the 120s timeout. Errors come back as `{ success: false, error }`
 * so the tool can report them and the model can decide what to do.
 */

/** Minimal shape of the Feishu SDK client we depend on. */
export interface FeishuCapabilityClient {
  im: {
    message: {
      create(args: unknown): Promise<unknown>;
      patch(args: unknown): Promise<unknown>;
      delete(args: unknown): Promise<unknown>;
      list(args: unknown): Promise<unknown>;
    };
    messageReaction: {
      create(args: unknown): Promise<unknown>;
      delete(args: unknown): Promise<unknown>;
    };
    chat: { get(args: unknown): Promise<unknown> };
    chatMembers: { get(args: unknown): Promise<unknown> };
  };
  contact: { user: { get(args: unknown): Promise<unknown> } };
  request(args: unknown): Promise<unknown>;
}

export interface FeishuCapabilityRequest {
  operation: string;
  chatId: string;
  params: Record<string, unknown>;
}

export type FeishuCapabilityResult =
  | { success: true; data: unknown; operation?: string }
  | { success: false; error: string; operation?: string };

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Run one capability operation.
 *
 * `client` is injected rather than imported so this stays unit-testable without
 * a live Feishu connection — these calls have real side effects (recall deletes
 * a message for every participant), so they must be exercisable against a
 * double.
 */
export async function runFeishuCapability(
  client: FeishuCapabilityClient,
  req: FeishuCapabilityRequest,
): Promise<FeishuCapabilityResult> {
  const { operation, chatId, params } = req;
  try {
    switch (operation) {
      case 'send_card': {
        if (!params.card || typeof params.card !== 'object') {
          return { success: false, error: 'card must be an object' };
        }
        // 模型经常把旧版 interactive-card 的包装（action.actions[]、note、
        // header.theme.color_style）跟 schema 2.0 混着写，飞书对这种混合形状
        // 直接回 400，用户看到的是「卡片没发出去」。在这里做等价改写。
        const data = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(
              normalizeFeishuCardForSend(params.card as Record<string, unknown>),
            ),
          },
        });
        return { success: true, data };
      }

      case 'edit_message': {
        const messageId = str(params.messageId);
        const text = str(params.text);
        if (!messageId) return { success: false, error: 'messageId is required' };
        // Empty replacement text is rejected rather than treated as "clear":
        // blanking a message is far more often a mis-passed variable than an
        // intent, and an agent that really wants it gone has recall_message.
        if (!text) {
          return { success: false, error: 'text is required and must be non-empty' };
        }
        const data = await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text }) },
        });
        return { success: true, data };
      }

      case 'recall_message': {
        const messageId = str(params.messageId);
        if (!messageId) return { success: false, error: 'messageId is required' };
        const data = await client.im.message.delete({
          path: { message_id: messageId },
        });
        return { success: true, data };
      }

      case 'add_reaction': {
        const messageId = str(params.messageId);
        const emojiType = str(params.emojiType);
        if (!messageId) return { success: false, error: 'messageId is required' };
        if (!emojiType) return { success: false, error: 'emojiType is required' };
        const data = await client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        });
        return { success: true, data };
      }

      case 'remove_reaction': {
        const messageId = str(params.messageId);
        const reactionId = str(params.reactionId);
        if (!messageId) return { success: false, error: 'messageId is required' };
        if (!reactionId) return { success: false, error: 'reactionId is required' };
        const data = await client.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: reactionId },
        });
        return { success: true, data };
      }

      case 'get_chat': {
        const data = await client.im.chat.get({ path: { chat_id: chatId } });
        return { success: true, data };
      }

      case 'list_members': {
        const data = await client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: {
            member_id_type: 'open_id',
            // Feishu caps this at 100; asking for more is rejected outright.
            page_size: Math.min(num(params.pageSize) ?? 50, 100),
            ...(str(params.pageToken) ? { page_token: str(params.pageToken) } : {}),
          },
        });
        return { success: true, data };
      }

      case 'get_user': {
        const openId = str(params.openId);
        if (!openId) return { success: false, error: 'openId is required' };
        const data = await client.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        });
        return { success: true, data };
      }

      case 'get_history': {
        const data = await client.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            // Feishu caps history pages at 50.
            page_size: Math.min(num(params.pageSize) ?? 20, 50),
            ...(str(params.pageToken) ? { page_token: str(params.pageToken) } : {}),
            ...(str(params.startTime) ? { start_time: str(params.startTime) } : {}),
            ...(str(params.endTime) ? { end_time: str(params.endTime) } : {}),
          },
        });
        return { success: true, data };
      }

      case 'api_request': {
        const method = str(params.method);
        const apiPath = str(params.path);
        if (!method) return { success: false, error: 'method is required' };
        if (!apiPath) return { success: false, error: 'path is required' };
        // Refuse anything outside the OpenAPI namespace: this is a deliberate
        // escape hatch for Feishu endpoints, not a general-purpose HTTP client.
        if (!apiPath.startsWith('/open-apis/')) {
          return { success: false, error: 'path must start with /open-apis/' };
        }
        const data = await client.request({
          method,
          url: apiPath,
          ...(params.body ? { data: params.body } : {}),
          ...(params.query ? { params: params.query } : {}),
        });
        return { success: true, data };
      }

      default:
        return { success: false, error: `Unknown Feishu operation: ${operation}` };
    }
  } catch (err) {
    // describeFeishuError keeps the socket/agent object graph out of the log —
    // a raw AxiosError here previously produced a 48 KB entry (see F5).
    const described = describeFeishuError(err);
    logger.warn({ operation, chatId, err: described }, 'Feishu capability failed');
    const message =
      (described.feishuMsg as string) ||
      (described.message as string) ||
      'Feishu API call failed';
    const status = described.httpStatus ? ` (HTTP ${described.httpStatus})` : '';
    return { success: false, error: `${message}${status}` };
  }
}

export type FeishuCapabilityOperation =
  | 'get_chat'
  | 'list_members'
  | 'get_user'
  | 'get_history'
  | 'send_card'
  | 'add_reaction'
  | 'remove_reaction'
  | 'edit_message'
  | 'recall_message'
  | 'api_request';

/**
 * The broker or Feishu explicitly rejected a capability request before any
 * visible mutation could be accepted. The durable Outbox may safely record a
 * definitive failure or scheduled retry instead of fencing the whole turn as
 * uncertain.
 */
export class DefinitiveFeishuCapabilityError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DefinitiveFeishuCapabilityError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

// operation 在本地 FeishuCapabilityRequest 里是 string（比 upstream 的联合类型宽），
// 这里只做 has() 判定，按 string 建集即可。
const FEISHU_READ_OPERATIONS = new Set<string>([
  'get_chat',
  'list_members',
  'get_user',
  'get_history',
]);

/** Classify operations before they cross the durable side-effect boundary. */
export function isFeishuCapabilityMutation(
  request: FeishuCapabilityRequest,
): boolean {
  if (FEISHU_READ_OPERATIONS.has(request.operation)) return false;
  if (request.operation !== 'api_request') return true;
  const params =
    request.params &&
    typeof request.params === 'object' &&
    !Array.isArray(request.params)
      ? request.params
      : {};
  const method =
    typeof params.method === 'string' ? params.method.trim().toUpperCase() : '';
  return method !== '' && method !== 'GET';
}
// ── 以下取自 upstream 的能力执行器，但**只取与执行器实现无关的部分** ──
//
// upstream 在这里还有一整套 executeFeishuCapability（基于 ChannelTurnContext +
// 多账号 channel_accounts 模型）。本 fork 用上面的 runFeishuCapability 替代了它
// （理由见文件头注释），两套都留会变成同一件事做两遍，所以执行器本体丢弃。
//
// 但下面这三样与执行器无关，是独立的真修复，本地同样需要：
//   · normalizeFeishuCardForSend —— 模型常把旧版 interactive-card 包装混进
//     Schema 2.0，飞书直接 400。本地 send_card 原本是裸 JSON.stringify，有同样的洞。
//   · definitiveFeishuHttpRejection —— feishu-capability-outbox.ts 直接 import 它，
//     用来把 4xx 判成「确定性拒绝」而不是把整个 turn 围成不确定。
//   · feishuRetryAfterMs —— 429 的 Retry-After 解析，前者的依赖。

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function feishuRetryAfterMs(response: Record<string, unknown>): number {
  const headers = record(response.headers);
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text =
    typeof value === 'number' || typeof value === 'string'
      ? String(value).trim()
      : '';
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.min(300_000, Math.max(1_000, Number(text) * 1_000));
  }
  const retryAt = Date.parse(text);
  if (Number.isFinite(retryAt)) {
    return Math.min(300_000, Math.max(1_000, retryAt - Date.now()));
  }
  return 5_000;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Models frequently remember the legacy interactive-card wrappers while also
 * selecting Schema 2.0. Feishu rejects that mixed shape with HTTP 400 even
 * though the user-visible intent is unambiguous. Normalize only exact,
 * content-preserving legacy shapes at the trusted broker boundary:
 *
 * - `action.actions[]` -> standalone Schema 2.0 action elements
 * - `note` -> notation-sized markdown
 * - `header.theme.color_style` -> `header.template`
 *
 * Unknown elements remain untouched so the provider can return a definitive
 * validation error instead of the broker silently dropping content.
 */
export function normalizeFeishuCardForSend(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const card = { ...input };
  if (card.schema !== '2.0') return card;

  const header = record(card.header);
  if (Object.keys(header).length > 0) {
    const normalizedHeader = { ...header };
    const theme = record(normalizedHeader.theme);
    const legacyTemplate = optionalString(theme.color_style);
    if (
      !optionalString(normalizedHeader.template) &&
      legacyTemplate &&
      hasOnlyKeys(theme, ['color_style'])
    ) {
      normalizedHeader.template = legacyTemplate;
      delete normalizedHeader.theme;
    }
    card.header = normalizedHeader;
  }

  const body = record(card.body);
  if (Object.keys(body).length === 0 || !Array.isArray(body.elements)) {
    return card;
  }

  const elements: Record<string, unknown>[] = [];
  for (const value of body.elements) {
    const element = record(value);
    const tag = optionalString(element.tag);

    if (tag === 'action') {
      const actions = Array.isArray(element.actions) ? element.actions : [];
      const buttons = actions.map(record);
      const canFlatten =
        hasOnlyKeys(element, ['tag', 'actions']) &&
        buttons.length > 0 &&
        buttons.every(
          (button) =>
            optionalString(button.tag) === 'button' &&
            Object.keys(button).length > 1,
        );
      if (canFlatten) {
        elements.push(...buttons.map((button) => ({ ...button })));
        continue;
      }
    }

    if (tag === 'note') {
      const notes = Array.isArray(element.elements) ? element.elements : [];
      const plainTexts = notes.map(record);
      const canConvert =
        hasOnlyKeys(element, ['tag', 'elements']) &&
        plainTexts.length > 0 &&
        plainTexts.every(
          (text) =>
            optionalString(text.tag) === 'plain_text' &&
            Boolean(optionalString(text.content)) &&
            hasOnlyKeys(text, ['tag', 'content']),
        );
      if (canConvert) {
        elements.push({
          tag: 'markdown',
          content: plainTexts
            .map((text) => optionalString(text.content)!)
            .join(' · '),
          text_size: 'notation',
        });
        continue;
      }
    }

    elements.push({ ...element });
  }

  card.body = { ...body, elements };
  return card;
}

/**
 * The Lark SDK throws Axios-style errors for HTTP-level 4xx responses before
 * the Feishu body can be inspected. A received 4xx response is still
 * authoritative evidence that the provider rejected the mutation; only
 * timeouts/disconnects without a response remain uncertain.
 */
export function definitiveFeishuHttpRejection(
  error: unknown,
): DefinitiveFeishuCapabilityError | null {
  if (error instanceof DefinitiveFeishuCapabilityError) return error;
  const response = record(record(error).response);
  const status =
    typeof response.status === 'number' ? response.status : undefined;
  // HTTP 408 is commonly synthesized by an intermediary after the upstream
  // may already have accepted the request, so it retains the uncertain fence.
  if (status === undefined || status < 400 || status >= 500 || status === 408) {
    return null;
  }

  const data = record(response.data);
  const code =
    typeof data.code === 'number' || typeof data.code === 'string'
      ? String(data.code)
      : 'unknown';
  const detail = (optionalString(data.msg) || 'request rejected').slice(
    0,
    1000,
  );
  return new DefinitiveFeishuCapabilityError(
    `Feishu rejected the request (http=${status}, code=${code}, msg=${detail})`,
    {
      cause: error,
      ...(status === 429 ? { retryAfterMs: feishuRetryAfterMs(response) } : {}),
    },
  );
}
