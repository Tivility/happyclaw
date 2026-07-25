import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runFeishuCapability } = await import('../src/feishu-capability.ts');

/**
 * These operations have real, externally visible side effects — recall deletes a
 * message for every participant in the chat — so they are exercised against a
 * double rather than a live tenant.
 *
 * The invariant that matters most: every path must RETURN a result, never throw.
 * The agent is blocked on an IPC round-trip waiting for this answer, so an
 * unanswered request hangs the turn until the 120s timeout.
 */
function makeClient() {
  const calls: Array<{ op: string; args: unknown }> = [];
  const rec =
    (op: string, result: unknown = { ok: true }) =>
    async (args: unknown) => {
      calls.push({ op, args });
      return result;
    };
  return {
    calls,
    client: {
      im: {
        message: {
          create: rec('message.create'),
          patch: rec('message.patch'),
          delete: rec('message.delete'),
          list: rec('message.list', { items: [] }),
        },
        messageReaction: {
          create: rec('reaction.create'),
          delete: rec('reaction.delete'),
        },
        chat: { get: rec('chat.get', { name: 'Team' }) },
        chatMembers: { get: rec('chatMembers.get', { items: [] }) },
      },
      contact: { user: { get: rec('user.get', { name: 'Alice' }) } },
      request: rec('request'),
    },
  };
}

const run = (op: string, params: Record<string, unknown> = {}, chatId = 'oc_1') => {
  const { client, calls } = makeClient();
  return runFeishuCapability(client as never, { operation: op, chatId, params }).then(
    (r) => ({ result: r, calls }),
  );
};

describe('message operations', () => {
  test('send_card posts an interactive message to the current chat', async () => {
    const { result, calls } = await run('send_card', { card: { schema: '2.0' } });
    expect(result.success).toBe(true);
    const args = calls[0].args as { data: Record<string, string> };
    expect(calls[0].op).toBe('message.create');
    expect(args.data.msg_type).toBe('interactive');
    expect(args.data.receive_id).toBe('oc_1');
    expect(JSON.parse(args.data.content)).toEqual({ schema: '2.0' });
  });

  test('send_card rejects a non-object card instead of stringifying garbage', async () => {
    const { result } = await run('send_card', { card: 'not an object' });
    expect(result).toEqual({ success: false, error: 'card must be an object' });
  });

  test('edit_message patches by message id', async () => {
    const { result, calls } = await run('edit_message', {
      messageId: 'om_1',
      text: 'revised',
    });
    expect(result.success).toBe(true);
    const args = calls[0].args as { path: { message_id: string }; data: { content: string } };
    expect(args.path.message_id).toBe('om_1');
    expect(JSON.parse(args.data.content)).toEqual({ text: 'revised' });
  });

  test('edit_message requires both arguments', async () => {
    expect((await run('edit_message', { text: 'x' })).result).toEqual({
      success: false,
      error: 'messageId is required',
    });
    expect((await run('edit_message', { messageId: 'om_1' })).result).toEqual({
      success: false,
      error: 'text is required and must be non-empty',
    });
  });

  test('edit_message rejects empty text rather than blanking the message', async () => {
    // Far more often a mis-passed variable than an intent; recall_message is the
    // tool for actually removing a message.
    const { result, calls } = await run('edit_message', { messageId: 'om_1', text: '' });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('non-empty');
    expect(calls).toHaveLength(0);
  });

  test('recall_message deletes by id', async () => {
    const { result, calls } = await run('recall_message', { messageId: 'om_9' });
    expect(result.success).toBe(true);
    expect(calls[0].op).toBe('message.delete');
    expect((calls[0].args as { path: { message_id: string } }).path.message_id).toBe(
      'om_9',
    );
  });

  test('recall_message without an id does not call the API at all', async () => {
    // Guessing a target here would delete the wrong message for everyone.
    const { result, calls } = await run('recall_message', {});
    expect(result).toEqual({ success: false, error: 'messageId is required' });
    expect(calls).toHaveLength(0);
  });
});

describe('reactions', () => {
  test('add_reaction sends the emoji type', async () => {
    const { result, calls } = await run('add_reaction', {
      messageId: 'om_1',
      emojiType: 'THUMBSUP',
    });
    expect(result.success).toBe(true);
    expect(
      (calls[0].args as { data: { reaction_type: { emoji_type: string } } }).data
        .reaction_type.emoji_type,
    ).toBe('THUMBSUP');
  });

  test('remove_reaction needs both message and reaction id', async () => {
    expect((await run('remove_reaction', { messageId: 'om_1' })).result).toEqual({
      success: false,
      error: 'reactionId is required',
    });
  });
});

describe('reads', () => {
  test('get_chat targets the current chat', async () => {
    const { result, calls } = await run('get_chat');
    expect(result).toEqual({ success: true, data: { name: 'Team' } });
    expect((calls[0].args as { path: { chat_id: string } }).path.chat_id).toBe('oc_1');
  });

  test('list_members clamps page size to the platform maximum', async () => {
    const { calls } = await run('list_members', { pageSize: 5000 });
    expect((calls[0].args as { params: { page_size: number } }).params.page_size).toBe(
      100,
    );
  });

  test('get_history clamps page size and passes the time window through', async () => {
    const { calls } = await run('get_history', {
      pageSize: 999,
      startTime: '1700000000',
      endTime: '1700003600',
    });
    const params = (calls[0].args as { params: Record<string, unknown> }).params;
    expect(params.page_size).toBe(50);
    expect(params.start_time).toBe('1700000000');
    expect(params.end_time).toBe('1700003600');
    expect(params.container_id).toBe('oc_1');
  });

  test('optional pagination fields are omitted rather than sent as undefined', async () => {
    const { calls } = await run('get_history', {});
    const params = (calls[0].args as { params: Record<string, unknown> }).params;
    expect('page_token' in params).toBe(false);
    expect('start_time' in params).toBe(false);
  });

  test('get_user looks up by open id', async () => {
    const { result, calls } = await run('get_user', { openId: 'ou_1' });
    expect(result).toEqual({ success: true, data: { name: 'Alice' } });
    expect((calls[0].args as { path: { user_id: string } }).path.user_id).toBe('ou_1');
  });
});

describe('api_request escape hatch', () => {
  test('passes method, path, body and query through', async () => {
    const { result, calls } = await run('api_request', {
      method: 'POST',
      path: '/open-apis/im/v1/chats',
      body: { name: 'x' },
      query: { page: 1 },
    });
    expect(result.success).toBe(true);
    expect(calls[0].args).toMatchObject({
      method: 'POST',
      url: '/open-apis/im/v1/chats',
      data: { name: 'x' },
      params: { page: 1 },
    });
  });

  test('refuses a path outside the OpenAPI namespace', async () => {
    // This is a Feishu escape hatch, not a general-purpose HTTP client.
    const { result, calls } = await run('api_request', {
      method: 'GET',
      path: 'https://evil.example/steal',
    });
    expect(result).toEqual({
      success: false,
      error: 'path must start with /open-apis/',
    });
    expect(calls).toHaveLength(0);
  });

  test('requires method and path', async () => {
    expect((await run('api_request', { path: '/open-apis/x' })).result).toEqual({
      success: false,
      error: 'method is required',
    });
  });
});

describe('failure handling', () => {
  test('an unknown operation is reported, not silently ignored', async () => {
    const { result } = await run('teleport');
    expect(result).toEqual({
      success: false,
      error: 'Unknown Feishu operation: teleport',
    });
  });

  test('an API rejection returns an error result rather than throwing', async () => {
    // Throwing would leave the agent waiting out the full IPC timeout.
    const client = {
      im: {
        chat: {
          get: async () => {
            throw Object.assign(new Error('Request failed with status code 403'), {
              response: { status: 403, data: { code: 99991672, msg: 'no permission' } },
            });
          },
        },
      },
    };
    const result = await runFeishuCapability(client as never, {
      operation: 'get_chat',
      chatId: 'oc_1',
      params: {},
    });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('no permission');
    expect((result as { error: string }).error).toContain('403');
  });

  test('the error message stays compact — no socket graph leaks into it', async () => {
    const socket: Record<string, unknown> = { host: 'open.feishu.cn' };
    socket.self = socket;
    const client = {
      im: {
        chat: {
          get: async () => {
            throw Object.assign(new Error('boom'), { request: { socket }, config: {} });
          },
        },
      },
    };
    const result = await runFeishuCapability(client as never, {
      operation: 'get_chat',
      chatId: 'oc_1',
      params: {},
    });
    expect((result as { error: string }).error.length).toBeLessThan(200);
  });
});
