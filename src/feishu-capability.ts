import { logger } from './logger.js';
import { describeFeishuError } from './feishu.js';

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
  | { success: true; data: unknown }
  | { success: false; error: string };

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
        const data = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(params.card),
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
