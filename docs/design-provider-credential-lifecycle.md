# Provider 凭据生命周期（codex / grok）

Claude 用 API key 或 OAuth token，无状态。codex / grok 不同：它们的凭据是
**可轮换的 refresh_token 链**，由各自的 CLI 自己维护。这带来一个容易踩的坑，
本文说清机制与边界。

## 机制

```
加密配置                物化目录                        CLI
claude-provider.json   CLAUDE_CONFIG_DIR/              codex / grok
secrets.grokAuthJson  →  {runtime}/{providerId}/     →  用 refresh_token
（AES-256-GCM）          auth.json (0600)               换新 access_token
       ↑                      │                         并**就地回写**
       └──── 回写 ────────────┘
        persistRefreshedProviderAuth()
```

- **播种**：spawn 前 `writeCodexProviderAuthMaterial()` /
  `writeGrokProviderAuthMaterial()` 把 auth.json 写到物化目录，设
  `CODEX_HOME` / `GROK_HOME` 指过去。
- **自刷新**：物化目录是 **RW**（host 直接读写；docker 是 RW bind-mount），
  CLI 在里面自己换 token 并回写。长会话不会因 access_token 过期掉线。
- **去重**：seed metadata（`.happyclaw-auth-seed.json`）记
  `providerId` + `authProfileGeneration` + `authHash`，只在凭据真变了才重播，
  避免覆盖 CLI 刚刷新出来的 token。
- **回写**：agent 进程结束后（两条路的 `finally` 里）比对磁盘 auth.json 的
  hash 与 metadata 里的 hash，不同就写回加密配置并同步 metadata。

## 为什么必须有回写

**refresh_token 是一次性的**：用掉之后旧的立刻作废，只有刚换出来的那份有效。

没有回写时，刷新结果只活在物化目录里。那个目录一被清掉（换机器、清缓存、
手工 `rm`），整条凭据链就断了，而且**不可恢复** —— 加密配置里存的是已作废的
旧快照，只能重新 `grok login` / `codex login`。

这个洞实际发生过：测试时把生产的 auth.json 复制到沙箱运行，沙箱那次成功刷新
（新 token 写进沙箱的物化目录），清理沙箱时把它删了，生产里留着的旧快照已被
消耗 → `Authentication required`。

## 重要边界

### 一份凭据不能两处同时用

同一个 auth.json 复制到两处分别运行，会形成**两条独立的链**：

- 各自持有不同的 refresh_token，互不干扰（实测：一份 20 天前的快照，在另一条
  链刷新过无数次之后，依然能成功刷新）
- 但**任一条链自己刷新后，它原来的那份快照就废了**

所以「复制凭据去别处跑」本身没问题 —— 副本会接管那条链并自我维护；
**危险的是刷新之后把副本丢掉**，那条链就没了。

推论：终端里的 `~/.grok` 与 HappyClaw 的物化目录是两条独立链，互不影响；
终端能用不代表 HappyClaw 能用，反之亦然。

### 并发使用同一个 provider

同一个 provider 被多个会话并发使用时，几个 CLI 共享同一个物化目录。谁先刷新，
另一个手里的 refresh_token 就废了 → 那个 agent 报认证失败。

这是**播种机制的固有性质**，不是回写引入的。回写只是把最终落盘的那份持久化，
不会让并发问题变严重。单服务实例下不存在跨进程写配置的竞争。

真要彻底避免，得给每个并发会话独立的物化目录 + 独立凭据（等于多账号），
那是 provider pool 层面的事。

### Docker 与 host 对称

回写只看宿主机文件系统，不关心是谁刷新的：

- host 模式：CLI 直接写 `CLAUDE_CONFIG_DIR/{runtime}/{providerId}/auth.json`
- docker 模式：同一个宿主机目录 RW bind-mount 进容器，容器内 CLI 写的就是它

两条路的 `finally` 各自调用回写，行为一致。

### 回写的安全条件

- 磁盘内容**不是合法 JSON 就不回写** —— CLI 写一半崩了的话，宁可保留配置里
  那份还能用的，也不能用损坏内容覆盖
- 空文件 / 文件不存在是 no-op（没配该 runtime，或还没 spawn 过）
- claude 运行时不参与（没有 auth.json 种子机制）
- 回写失败只记日志，不影响本轮 agent 结果（best-effort）
- 放在 `finally` 里：**即使本轮 spawn 抛异常也要回写** —— CLI 可能已经刷新过，
  那份才是唯一有效的凭据

## 相关代码

| 位置 | 职责 |
|---|---|
| `src/runtime-config.ts` · `writeCodexProviderAuthMaterial` / `writeGrokProviderAuthMaterial` | 播种 + seed metadata |
| `src/runtime-config.ts` · `persistRefreshedProviderAuth` | 回写 |
| `src/container-runner.ts` · 两处 `finally` | 调用回写（docker / host） |
| `src/runtime-config.ts` · `deleteProvider` | 删 provider 时 GC 物化目录 |
| `tests/provider-auth-writeback.test.ts` | 回写的 8 条不变量 |
