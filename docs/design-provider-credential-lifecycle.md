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

复制之后的两份**不是**一开始就独立的。刚复制的那一刻，两边握着**同一个**
refresh_token；谁先刷新，谁就把它换掉，另一边手里那份当场作废。只有当两边各自
成功刷新过至少一次之后，它们才各自持有独立的后代 token，此后互不干扰。

> 早期版本这里写的是「复制出来就是两条独立链，互不干扰」，并据此认为
> 「复制凭据去别处跑本身没问题」。**这个结论是错的**，2026-07-29 被生产实证推翻，
> 见下。

实证（2026-07-29）：

- 07-27 13:32 把 `~/.grok/auth.json` 拷进 HappyClaw 的 provider 配置
- 07-28 04:12 终端侧 `~/.grok` 自行刷新 → 拿到新 token，**原 token 作废**
- HappyClaw 此后每次 spawn：播种那份已作废的 token → CLI 刷新失败 → CLI **删掉
  auth.json** → 报 `Authentication required`

指纹比对会让人误判：两边的 refresh_token 当时**确实不同**（`f377ef…` vs
`2b2116…`），看起来像两条独立链。但不同的原因不是「各自演化」，而是**其中一条
已经被顶掉了**。判断独立与否不能只看指纹是否相同。

还有一个自锁效应：CLI 刷新失败会把 auth.json 删掉，于是回写逻辑
（`persistRefreshedProviderAuth`）读不到文件、无可回写，配置里那份死凭据就**永远
留着**。这条链不可能自愈，只能重新登录。

正确做法是**给 HappyClaw 单独登录一次**，从一开始就是两条各自独立的链：

```bash
GROK_HOME=data/config/grok/{providerId} grok login
```

登录后配置里的旧凭据会在下一次 spawn 的回写中被磁盘上的新凭据替换
（`writeGrokProviderAuthMaterial` 判定 `authStat` 存在且 metadata 匹配，
不会用旧配置覆盖新登录结果）。

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
