import fs from 'node:fs';
import path from 'node:path';
import { check as prettierCheck, resolveConfig } from 'prettier';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

// 主服务与 Web 前端仍要求 lockfile + npm ci（可复现）。
// container/agent-runner 例外：CLAUDE.md §10 要求 Claude Agent SDK 始终最新
// （"*" + 无 lock file + CACHEBUST）。留着 lock 会锁死版本，"*" 直接失效。
const lockfiles = ['package-lock.json', 'web/package-lock.json'];

const streamEventFiles = [
  'shared/stream-event.ts',
  'src/stream-event.types.ts',
  'web/src/stream-event.types.ts',
  'container/agent-runner/src/stream-event.types.ts',
];

describe('reproducible build contract', () => {
  test('lockfile projects use npm ci; agent-runner stays on always-latest install', () => {
    const gitignore = read('.gitignore');
    for (const lockfile of lockfiles) {
      expect(fs.existsSync(path.join(root, lockfile))).toBe(true);
      expect(gitignore).not.toMatch(
        new RegExp(
          `^${lockfile.replaceAll('/', '\\/').replace('.', '\\.')}\$`,
          'm',
        ),
      );

      const lock = JSON.parse(read(lockfile)) as {
        packages: Record<string, { resolved?: string }>;
      };
      for (const dependency of Object.values(lock.packages)) {
        expect(dependency.resolved ?? '').not.toMatch(/^git\+ssh:/);
      }
    }

    const makefile = read('Makefile');
    const installTarget = makefile
      .split(/\n(?=\S)/)
      .find((target) => target.startsWith('install:'));
    expect(installTarget).toContain('$(PKG) ci');
    expect(installTarget).toContain('web && $(PKG) ci');
    // agent-runner 是「始终最新」的例外：它没有 lock file，`npm ci` 会直接报
    // EUSAGE（全新克隆装不上）。这里断言它**必须**走 install --no-package-lock，
    // 反过来锁住这个例外，防止有人为了「统一」把它改回 ci。
    expect(installTarget).toContain(
      'container/agent-runner && $(PKG) install --no-package-lock',
    );
    expect(installTarget).not.toContain('container/agent-runner && $(PKG) ci');

    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm ci');
    expect(ci).toContain('npm --prefix web ci');
    // 同上：CI 也必须用 install --no-package-lock，且不得把 agent-runner 的
    // lock 列进 setup-node 的 cache-dependency-path（文件不存在会让缓存 key
    // 算不出来）。
    expect(ci).toContain(
      'npm --prefix container/agent-runner install --no-package-lock',
    );
    expect(ci).not.toContain('npm --prefix container/agent-runner ci');
    expect(ci).not.toContain('container/agent-runner/package-lock.json');
    // 裸 install（不带 --no-package-lock）会生成 lock，等于悄悄锁死版本。
    expect(ci).not.toMatch(/^\s+npm(?: --prefix \S+)? install\s*$/m);
    expect(ci).toMatch(/uses: actions\/checkout@[a-f0-9]{40}/);
    expect(ci).toMatch(/uses: actions\/setup-node@[a-f0-9]{40}/);
  });

  test('generated StreamEvent copies stay synchronized and formatted', async () => {
    const canonical = read(streamEventFiles[0]);
    for (const file of streamEventFiles) {
      const source = read(file);
      expect(source).toBe(canonical);
      const filepath = path.join(root, file);
      expect(
        await prettierCheck(source, {
          ...(await resolveConfig(filepath)),
          filepath,
        }),
      ).toBe(true);
    }
  });

  // 决策（用户拍板）：保本地「始终最新」策略，不采用 upstream 的全量可复现构建。
  //
  // upstream 把基础镜像 / uv / feishu-cli / headroom-ai 全部钉死，禁 latest、
  // 禁 CACHEBUST、禁 npm install -g。本地 CLAUDE.md §10 的明文约束相反：
  // Claude Agent SDK 用 "*" + 无 lock file + CACHEBUST 保证每次构建都拿最新版，
  // feishu-cli 走 releases/latest 的 302 redirect 取最新 tag。两者不可兼得。
  //
  // 仍然守住与「最新」不冲突的那部分完整性要求：第三方下载必须校验 sha256、
  // Python 依赖必须钉版本（headroom-ai 仍是 PyPI Beta）。
  test('container build keeps the always-latest SDK contract intact', () => {
    const dockerfile = read('container/Dockerfile');
    const agentRunnerPkg = read('container/agent-runner/package.json');

    // CLAUDE.md §10：Agent SDK 用 "*" + 无 lock file + CACHEBUST，保证每次构建
    // 都解析到最新版。这三者缺一不可 —— 少了 CACHEBUST，Docker 层缓存会让
    // `npm install` 直接命中旧层，"*" 就形同虚设。
    expect(JSON.parse(agentRunnerPkg).dependencies['@anthropic-ai/claude-agent-sdk']).toBe('*');
    expect(dockerfile).toMatch(/ARG CACHEBUST=/);

    // feishu-cli 走 releases/latest 的 302 redirect 取 tag（不打 api.github.com
    // 以规避 rate limit），binary 与 skills 共享同一 $VERSION 确保版本一致。
    expect(dockerfile).toContain('releases/latest');
    const versionUses = dockerfile.match(/\$\{VERSION\}/g) ?? [];
    expect(versionUses.length).toBeGreaterThanOrEqual(2);
  });

  test('决策 38 无残留：codex 只保留 CLI，不得再要求 @openai/codex-sdk', () => {
    // 删了 SDK 适配器和依赖，但 preflight 的 requiredDeps 还留着这个包 ——
    // 结果所有宿主机会话报「缺少 agent-runner 依赖」完全跑不起来。
    // typecheck / test 都抓不到（那只是个字符串数组），切生产才炸。
    const agentRunnerPkg = JSON.parse(
      read('container/agent-runner/package.json'),
    ) as { dependencies?: Record<string, string> };
    expect(
      Object.keys(agentRunnerPkg.dependencies ?? {}),
    ).not.toContain('@openai/codex-sdk');

    // preflight 的必需依赖列表不得引用它，否则恒定失败。
    const runner = read('src/container-runner.ts');
    const requiredDepsBlock = runner.slice(
      runner.indexOf('const requiredDeps'),
      runner.indexOf('const requiredDeps') + 400,
    );
    expect(requiredDepsBlock).not.toContain('@openai/codex-sdk');

    // SDK 适配器文件不该复活。
    expect(
      fs.existsSync(
        path.join(root, 'container/agent-runner/src/codex-sdk-runner.ts'),
      ),
    ).toBe(false);
  });

  test('web 声明了源码实际 import 的所有 @dnd-kit 包', () => {
    // AgentTabBar 用 @dnd-kit，但 package.json 的声明在合并解冲突时丢了。
    // node_modules 里的历史残留让 typecheck/test 照常通过，只有 npm ci 之后
    // （全新克隆 / CI）才暴露。
    const webPkg = JSON.parse(read('web/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(webPkg.dependencies ?? {}));
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          for (const m of read(path.relative(root, full)).matchAll(
            /from '(@dnd-kit\/[a-z-]+)'/g,
          )) {
            used.add(m[1]);
          }
        }
      }
    };
    walk(path.join(root, 'web/src'));
    for (const pkg of used) {
      expect(declared, `web/package.json 缺少 ${pkg}`).toContain(pkg);
    }
  });

});
