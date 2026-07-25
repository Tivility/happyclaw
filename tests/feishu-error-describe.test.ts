import { describe, expect, test } from 'vitest';
import { describeFeishuError } from '../src/feishu.js';

/**
 * Guards the 2026-07-19 incident: a 503 on Feishu image upload was logged as a
 * raw AxiosError, whose `request` / `response` / `config` fields transitively
 * reference the TLS socket and http agent. pino serialized the whole graph into
 * a single 48 KB / 1403-line entry, and the process died moments later on
 * `write EPIPE` with that payload in flight to the pino-pretty transport.
 *
 * describeFeishuError must keep only the fields we diagnose from, and must not
 * let socket-shaped objects through by any path.
 */

/** Stand-in for the AxiosError shape that blew up, including a cyclic socket. */
function buildAxiosLikeError(): Error {
  const socket: Record<string, unknown> = {
    _tlsOptions: { host: 'open.feishu.cn' },
    _writableState: { buffered: new Array(256).fill('x').join('') },
    servername: 'open.feishu.cn',
    authorized: true,
  };
  socket.self = socket; // cyclic, like a real socket graph

  const err = new Error('Request failed with status code 503') as Error & {
    code?: string;
    response?: unknown;
    request?: unknown;
    config?: unknown;
  };
  err.name = 'AxiosError';
  err.response = {
    status: 503,
    statusText: 'Service Temporarily Unavailable',
    data: { code: 230001, msg: 'service unavailable' },
    request: { socket },
  };
  err.request = { socket, agent: { sockets: { 'open.feishu.cn:443': [socket] } } };
  err.config = { headers: { Authorization: 'Bearer secret-token' } };
  return err;
}

describe('describeFeishuError', () => {
  test('extracts the fields we actually diagnose from', () => {
    expect(describeFeishuError(buildAxiosLikeError())).toEqual({
      name: 'AxiosError',
      code: undefined,
      httpStatus: 503,
      feishuCode: 230001,
      feishuMsg: 'service unavailable',
      message: 'Request failed with status code 503',
    });
  });

  test('drops the socket / agent / config graph entirely', () => {
    const described = describeFeishuError(buildAxiosLikeError());
    const keys = Object.keys(described);
    expect(keys).not.toContain('response');
    expect(keys).not.toContain('request');
    expect(keys).not.toContain('config');
    // Serializing must stay small and must not throw on the cyclic source.
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain('open.feishu.cn');
    expect(serialized).not.toContain('secret-token');
    expect(serialized.length).toBeLessThan(500);
  });

  test('reads transport codes off the error or its cause', () => {
    const direct = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    expect(describeFeishuError(direct).code).toBe('ECONNRESET');

    const nested = Object.assign(new Error('fetch failed'), {
      cause: { code: 'EPIPE' },
    });
    expect(describeFeishuError(nested).code).toBe('EPIPE');
  });

  test('truncates oversized message and Feishu msg', () => {
    const err = Object.assign(new Error('x'.repeat(5000)), {
      response: { status: 500, data: { code: 1, msg: 'y'.repeat(5000) } },
    });
    const described = describeFeishuError(err);
    expect((described.message as string).length).toBe(500);
    expect((described.feishuMsg as string).length).toBe(200);
  });

  test('tolerates non-object and empty inputs', () => {
    expect(describeFeishuError(null)).toEqual({ message: 'null' });
    expect(describeFeishuError(undefined)).toEqual({ message: 'undefined' });
    expect(describeFeishuError('boom')).toEqual({ message: 'boom' });
    expect(describeFeishuError(42)).toEqual({ message: '42' });
  });

  test('a bare Error still yields its message', () => {
    expect(describeFeishuError(new Error('plain failure'))).toMatchObject({
      name: 'Error',
      message: 'plain failure',
      httpStatus: undefined,
    });
  });
});
