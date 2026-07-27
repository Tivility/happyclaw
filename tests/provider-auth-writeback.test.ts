import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'provider-auth-writeback-')),
);
// runtime-config 里 CLAUDE_CONFIG_DIR 是 `DATA_DIR/config` 的派生常量，
// 不是 config.js 的独立导出 —— 只 mock DATA_DIR 就够，路径跟着走。
const configDir = path.join(tmpDir, 'config');
const claudeConfigDir = configDir;
fs.mkdirSync(configDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
  };
});

const rc = await import('../src/runtime-config.js');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * codex / grok 的凭据是「种子 + CLI 自刷新」：spawn 前把 auth.json 播到
 * `CLAUDE_CONFIG_DIR/{runtime}/{providerId}/`，CLI 在那里用 refresh_token 换新
 * token 并就地回写。
 *
 * refresh_token 是**一次性**的 —— 用掉之后原快照作废，只有物化目录里那份有效。
 * 在补上回写之前，刷新结果从不回到加密的 provider 配置，所以那个目录一被清掉
 * （换机器 / 清缓存 / 手滑 rm），整条凭据链断裂且不可恢复，只能重新登录。
 * 这个洞实际发生过一次，所以这里逐条锁住行为。
 */
const AUTH_V1 = JSON.stringify({
  'https://auth.x.ai::acct': { refresh_token: 'rt-original', expires_at: '2026-07-07T00:00:00Z' },
});
const AUTH_V2 = JSON.stringify({
  'https://auth.x.ai::acct': { refresh_token: 'rt-rotated', expires_at: '2026-08-01T00:00:00Z' },
});

function grokHome(providerId: string): string {
  return path.join(claudeConfigDir, 'grok', providerId);
}

function seedProvider(authJson: string): string {
  const created = rc.createProvider({
    name: 'grok-test',
    type: 'third_party',
    runtime: 'grok',
    providerFamily: 'grok',
    providerPoolId: 'grok',
    authMode: 'grok_oauth',
    grokAuthJson: authJson,
  });
  // 播种：写出 auth.json + seed metadata
  rc.writeGrokProviderAuthMaterial(rc.getProviderById(created.id)!);
  return created.id;
}

describe('CLI 自刷新凭据回写', () => {
  // 每个用例用独立 provider（createProvider 生成新 id），所以 grok home
  // 目录天然互不干扰，不需要清理。清配置文件是为了不让 provider 越积越多。
  beforeEach(() => {
    fs.rmSync(path.join(configDir, 'claude-provider.json'), { force: true });
  });

  test('CLI 刷新过 → 回写进 provider 配置', () => {
    const id = seedProvider(AUTH_V1);
    expect(rc.getProviderById(id)?.grokAuthJson?.trim()).toBe(AUTH_V1);

    // 模拟 CLI 就地刷新
    fs.writeFileSync(path.join(grokHome(id), 'auth.json'), AUTH_V2 + '\n');

    expect(rc.persistRefreshedProviderAuth(id)).toBe(true);
    // 轮换后的 refresh_token 必须进配置 —— 否则物化目录一没就永久失效。
    expect(rc.getProviderById(id)?.grokAuthJson?.trim()).toBe(AUTH_V2);
  });

  test('回写后 metadata 同步，二次调用不重复回写', () => {
    const id = seedProvider(AUTH_V1);
    fs.writeFileSync(path.join(grokHome(id), 'auth.json'), AUTH_V2 + '\n');
    expect(rc.persistRefreshedProviderAuth(id)).toBe(true);

    // metadata 没跟上的话每次都判成「变了」，会反复写配置。
    expect(rc.persistRefreshedProviderAuth(id)).toBe(false);
  });

  test('回写后再播种不会用旧凭据覆盖磁盘上的新凭据', () => {
    const id = seedProvider(AUTH_V1);
    fs.writeFileSync(path.join(grokHome(id), 'auth.json'), AUTH_V2 + '\n');
    rc.persistRefreshedProviderAuth(id);

    // 下一轮 spawn 会重新播种。metadata 与配置都已是 V2，不该回退到 V1。
    rc.writeGrokProviderAuthMaterial(rc.getProviderById(id)!);
    expect(
      fs.readFileSync(path.join(grokHome(id), 'auth.json'), 'utf-8').trim(),
    ).toBe(AUTH_V2);
  });

  test('CLI 没刷新时不动配置', () => {
    const id = seedProvider(AUTH_V1);
    expect(rc.persistRefreshedProviderAuth(id)).toBe(false);
    expect(rc.getProviderById(id)?.grokAuthJson?.trim()).toBe(AUTH_V1);
  });

  test('磁盘内容不是合法 JSON 时拒绝回写', () => {
    const id = seedProvider(AUTH_V1);
    // CLI 写一半崩了。宁可不回写，也不能把损坏内容覆盖掉还能用的那份。
    fs.writeFileSync(path.join(grokHome(id), 'auth.json'), '{"broken":');
    expect(rc.persistRefreshedProviderAuth(id)).toBe(false);
    expect(rc.getProviderById(id)?.grokAuthJson?.trim()).toBe(AUTH_V1);
  });

  test('物化文件不存在 / 空文件时是 no-op', () => {
    const id = seedProvider(AUTH_V1);
    fs.rmSync(path.join(grokHome(id), 'auth.json'), { force: true });
    expect(rc.persistRefreshedProviderAuth(id)).toBe(false);

    fs.writeFileSync(path.join(grokHome(id), 'auth.json'), '   \n');
    expect(rc.persistRefreshedProviderAuth(id)).toBe(false);
    expect(rc.getProviderById(id)?.grokAuthJson?.trim()).toBe(AUTH_V1);
  });

  test('claude 运行时不参与回写（没有 auth.json 种子机制）', () => {
    const created = rc.createProvider({
      name: 'claude-test',
      type: 'third_party',
      runtime: 'claude',
      providerFamily: 'claude',
      providerPoolId: 'claude',
      authMode: 'oauth',
    });
    expect(rc.persistRefreshedProviderAuth(created.id)).toBe(false);
  });

  test('provider 不存在时是 no-op，不抛', () => {
    expect(rc.persistRefreshedProviderAuth('nonexistent-id')).toBe(false);
  });
});
