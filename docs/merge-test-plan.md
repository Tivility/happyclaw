# 合并测试方案（可执行用例）

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 上位文档：`upstream-merge-plan.md`（93 条决策 + 六阶段方案）· `upstream-silent-changes.md`（静默变更）
> 编制：2026-07-26

本文把 `upstream-merge-plan.md` §5 的测试矩阵展开成可以照着执行的用例。矩阵回答"跑什么组合"，本文回答"具体怎么验、期望值是什么、失败长什么样"。

---

# 零、执行前提

## 0.1 环境基线快照（2026-07-26 实测）

所有期望值以这份快照为准。**冻结分支前必须重跑一次 `M0` 生成当日快照**，因为系统在跑，行数会漂。

| 对象 | 实测值 | 备注 |
|---|---|---|
| `router_state.schema_version` | `45` | upstream 目标 63 |
| `registered_groups` | **64** | web 35 · feishu 25 · wechat 3 · qq 1 |
| `registered_groups` distinct `folder` | **36** | 决策 8 的目标 `workspaces` 行数 |
| `execution_mode` | host 37 · container 27 | |
| `messages` | **13744** | 台账写 13741，系统在跑，以冻结快照为准 |
| `chats` | 68 | |
| `workspaces` | **64** | 每个 jid 一行（错的投影） |
| `conversation_runtime_state` | 33 | |
| `conversation_runtime_sessions` | 52 | 其中 **5 行**无对应 state（既有孤儿） |
| `conversation_handoff_summaries` | 137 | |
| `usage_records` | **7011** | runtime: null 4385 · claude 1868 · codex 737 · grok 21 |
| `group_members` | 32 | 决策 7 删 |
| `agent_channel_mounts` | 21 | 决策 9 重建为 10 列 |
| `scheduled_tasks` | 24 | |
| `sessions` | 17 | |
| `turn_events` | 310 | `runtime` 列**全部** = `claude` |
| `agent_profiles` | **0** | upstream backfill 会建 3 条 |
| `workspace_agent_profiles` | 0 | upstream backfill 会建 ~35 条 |
| `im_context_bindings` | **0** | |
| 无 `target_main_jid` 的 IM 会话 | **8** | feishu 4 · qq 1 · wechat 3 —— §1.1 fail-closed 的受害者 |
| 用户 | `tivility`(admin) · `cxx`(member) · `whz`(member) | |

凭据文件（`S1` 的验证对象）：

```
data/config/claude-provider.json                      version=4（明文头 + 加密块）
data/config/codex/b38c52c8315d4fc0/auth.json          + .happyclaw-auth-seed.json
data/config/codex/4d36f10341a17f6d/auth.json
data/config/grok/bffffd408e486a9e/auth.json           + .happyclaw-auth-seed.json
data/config/user-im/1b587104-…/{discord,wechat,feishu,qq}.json    admin
data/config/user-im/58a92f8e-…/{wechat,feishu}.json               cxx
data/config/user-im/0dce8aa4-…/wechat.json                        whz
```

测试文件规模：本地 `tests/*.test.ts` **119** · upstream **284** · 交集 74 · 本地独有 45 · upstream 独有 210。

## 0.2 用例编号

| 前缀 | 含义 | 节 |
|---|---|---|
| `S1`–`S6` | 六个静默杀手专项 | 一 |
| `P1`–`P12` × `{C,X,G}` | 对等矩阵（Claude / Codex / Grok） | 二 |
| `R01`–`R20` | 回归必跑集 · `RO*` 可选集 | 三 |
| `M0`–`M9` | 数据迁移验证 | 四 |
| `G0`–`G6` | 阶段准入/退出 | 五 |
| `T*` | 要新写的自动化测试 | 六 |

## 0.3 通用夹具

**夹具 F-SNAP（库快照）** —— 见 §四 `M0`，产出一份可 diff 的指纹文件。

**夹具 F-CRED（凭据指纹）**：

```bash
# 记录凭据文件的 mtime + size + sha256，用于任何"没被销毁"的断言
happyclaw_cred_fingerprint() {
  find data/config/claude-provider.json \
       data/config/codex data/config/grok data/config/user-im \
       -type f \( -name 'auth.json' -o -name '*.json' \) 2>/dev/null \
    | sort | while read -r f; do
        printf '%s|%s|%s\n' "$f" "$(stat -f %z "$f")" "$(shasum -a256 "$f" | cut -d' ' -f1)"
      done
}
happyclaw_cred_fingerprint > /tmp/cred-before.txt
```

**夹具 F-RUN（起一轮会话并拿到 turn_id）**：

```bash
# 发消息后取最近一轮的 turn_id / chat_jid，供后续 SQL 定位
sqlite3 data/db/messages.db \
  "SELECT turn_id, chat_jid, runtime, MAX(created_at)
     FROM turn_events GROUP BY turn_id ORDER BY 4 DESC LIMIT 1;"
```

**夹具 F-LOG（看后端日志）**：`make start` 前台运行时直接看终端；后台化时 `tail -f /tmp/happyclaw.log`。**禁止**用 `lsof -ti:3000 | xargs kill` 停服（会杀 Docker 代理），用 `lsof -ti:3000 -sTCP:LISTEN | xargs kill`。

---

# 一、六个静默杀手的专项用例

这六个 typecheck 不会拦。每个用例给：前置条件 / 操作步骤 / 期望结果 / 失败表现 / 验证命令。

---

## S1 · provider 凭据销毁

> 决策 3 · 静默变更 §2.7。两边都写 `version: 4` 但 schema 不同；upstream 的 v4 分支接管读写后，`secrets.codexAuthJson` / `secrets.grokAuthJson` 不在它的字段表里 → 下一次写盘（任何一次 provider 变更）把这两个键丢掉 → `writeCodexProviderAuthMaterial` / `writeGrokProviderAuthMaterial` 无料可写 → codex/grok 全线掉线。

**前置条件**

1. 阶段 0.2 已把 `src/runtime-config.ts` 的磁盘版本号推到 **5**（`version: 5` + `parsed.version === 5` 读分支 + v4→v5 升级路径）。
2. 服务停止状态下先做基线：

```bash
cp -a data/config /tmp/config-baseline-$(date +%s)
happyclaw_cred_fingerprint > /tmp/cred-before.txt
python3 -c "import json;d=json.load(open('data/config/claude-provider.json'));print('version=',d['version'],'providers=',len(d['providers']))"
```

**操作步骤**

1. `make start`，登录 Web。
2. 设置页 → **模型与提供商** → 找到一个 **codex** provider，点一次「启用」开关关掉，等 UI 回到 idle。
3. 再点一次开回来。（一关一开 = 两次写盘，覆盖 upstream 决策 53 的"全局判断"路径）
4. 对一个 **grok** provider 重复步骤 2–3。
5. 再触发一次批量应用：设置页 → Claude → 「应用到所有容器」。

**期望结果**

| 断言 | 期望 |
|---|---|
| A1 | `data/config/claude-provider.json` 的 `version` == **5** |
| A2 | `data/config/codex/b38c52c8315d4fc0/auth.json` 与 `4d36f10341a17f6d/auth.json` **存在**，`sha256` 与 `/tmp/cred-before.txt` **一致** |
| A3 | `data/config/grok/bffffd408e486a9e/auth.json` 同上 |
| A4 | 两个 `.happyclaw-auth-seed.json` 存在，其中 `authHash` 字段未变 |
| A5 | `claude-provider.json` 解密后 `secrets.codexAuthJson` / `secrets.grokAuthJson` **非空** |
| A6 | 7 份 `data/config/user-im/*/*.json` sha256 全部未变 |

**失败表现（长什么样）**

- 最直接：`data/config/codex/*/auth.json` 被清空或整目录消失。
- 更阴的：`auth.json` 还在（是 CLI 自己刷新写的），但 `claude-provider.json` 里的 `secrets.codexAuthJson` 没了 → **重启后**才崩，因为下次 spawn 时 seed 逻辑发现 hash 变了会用空值覆盖 `auth.json`。**所以 A5 比 A2 更早发现问题。**
- 用户侧现象：codex/grok 会话报 `401` / `Unauthorized` / `not logged in`，claude 正常。

**验证命令**

```bash
# A1
python3 -c "import json;print(json.load(open('data/config/claude-provider.json'))['version'])"
# A2/A3/A6 —— 逐字节比对
happyclaw_cred_fingerprint > /tmp/cred-after.txt
diff /tmp/cred-before.txt /tmp/cred-after.txt && echo "凭据完好" || echo "!! 凭据被改动"
# A5 —— 用后端的解密路径读，不要自己解
node -e "
const {loadProviderConfig}=require('./dist/runtime-config.js');
const c=loadProviderConfig();
for(const p of c.providers){
  if(p.runtime==='codex') console.log(p.id,'codexAuthJson len=',(p.secrets?.codexAuthJson||'').length);
  if(p.runtime==='grok')  console.log(p.id,'grokAuthJson  len=',(p.secrets?.grokAuthJson ||'').length);
}"
# 端到端确认：起一轮 codex / grok
```

**不通过怎么办**：`cp -a /tmp/config-baseline-*/. data/config/` 恢复；回到阶段 0.2 检查 v5 分支是否真的接管了写盘（在 `saveProviderConfig` 落盘处加临时 `console.trace` 确认走的是本地实现而非 upstream 的）。

---

## S2 · 计费与配额口径

> 决策 40 / 41 / 66。Anthropic 与 OpenAI/xAI 的 `inputTokens` 语义相反：Claude 的 `input` **不含** cacheRead，Codex/Grok 的 `input` **已含** cachedRead。用 Claude 的加法算 Codex，输入 token 直接膨胀 **1.85×**；再按 Sonnet 单价计费，历史 737 条 codex 记录会算出约 **$2160** 的假成本（实际订阅制 $0）。

**前置条件**

- 合并已完成，`usage_records` 未被清空。
- 至少一个 codex provider 与一个 grok provider 可用。

**基线（合并前实测，作为对照）**

| runtime | 行数 | `input_tokens` | `cache_read` | `cache_creation` | `output` | `cost_usd` |
|---|---|---|---|---|---|---|
| `claude` | 1868 | 15,506,707 | 1,509,751,485 | 132,827,471 | 9,049,742 | 1791.86 |
| `codex` | 737 | 637,069,178 | 543,278,042 | 179,526 | 5,673,984 | **0.59** |
| `grok` | 21 | 804,768 | 629,824 | 0 | 15,390 | **0.00** |
| `(null)` | 4385 | — | — | — | — | 5554.87 |

**判别不变量**（这是最好用的自动检测）：

```
Claude 口径：cache_read 与 input 不相交 → cache_read 可以远大于 input（实测 1509M ≫ 15.5M）
Codex/Grok 口径：cache_read 是 input 的子集 → cache_read ≤ input 必须恒成立
                （实测 codex 543M ≤ 637M · grok 0.63M ≤ 0.80M）
```

**操作步骤**

1. 在一个工作区 `/model` 切到 **grok**，发一条会产生若干轮工具调用的消息（例："列出当前目录下最大的 3 个文件并说明用途"）。记录 `chat_jid` 和时间戳。
2. 同一工作区 `/model` 切到 **claude**（Sonnet 或 Opus 均可），发同样的消息。
3. 再切到 **codex** 发一次。
4. 三轮都结束后跑下面的 SQL。

**期望结果**

| 断言 | 期望 |
|---|---|
| B1 | 三轮各自在 `usage_records` 留下 ≥1 行，`runtime` 分别为 `grok` / `claude` / `codex`，**不为 NULL** |
| B2 | grok / codex 的新行满足 `cache_read_input_tokens <= input_tokens` |
| B3 | grok / codex 的新行 `cost_usd = 0`（订阅制），`cost_status` 标记为订阅口径而非 `priced` |
| B4 | claude 的新行 `cost_usd > 0` |
| B5 | 配额增量：grok/codex 那轮消耗的**可计费输入** == `input_tokens`；claude 那轮 == `input + cache_read + cache_creation` |
| B6 | 全表回归：`SUM(cost_usd) WHERE runtime IN ('codex','grok')` 仍 ≈ **0.59**，**不得**跳到 ~2160 |
| B7 | 前端 `MessageBubble`：grok/codex 那两条回复**不显示**美元金额；claude 那条显示 |
| B8 | 前端 token 总数（决策 66）：grok/codex 那条不把 cacheRead 重复加一遍 —— 显示的输入数 == `input_tokens` |

**失败表现**

- B2 失效（`cache_read > input`）→ 说明写入侧用了 Claude 的拆分口径去填 codex 行，**归因已经错在入库那一刻**，事后无法修。
- B6 跳到 ~2160 → Kaboo 定价没有做运行时门控，非 Claude 被按 Sonnet 计价。用户侧现象：余额页一夜之间多出两千多美元消耗，配额被瞬间打穿。
- B3 为 `priced` → 计费开关关掉也照样扣（决策 41 明确"不受计费开关影响"）。

**验证命令**

```sql
-- B1/B2/B3/B4：只看本次三轮（把时间换成实际值）
SELECT runtime, model, input_tokens, cache_read_input_tokens,
       cache_creation_input_tokens, output_tokens, cost_usd, cost_status
  FROM usage_records
 WHERE created_at >= '2026-07-26T00:00:00'
 ORDER BY created_at DESC LIMIT 20;

-- B2 全表不变量（任何一行返回都是 bug）
SELECT id, runtime, input_tokens, cache_read_input_tokens
  FROM usage_records
 WHERE runtime IN ('codex','grok')
   AND cache_read_input_tokens > input_tokens;

-- B5 可计费输入的分口径计算
SELECT runtime,
       COUNT(*) n,
       SUM(input_tokens) inp,
       SUM(cache_read_input_tokens) cr,
       SUM(cache_creation_input_tokens) cc,
       CASE WHEN runtime='claude'
            THEN SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens)
            ELSE SUM(input_tokens) END AS billable_input,
       ROUND(SUM(cost_usd),4) cost
  FROM usage_records GROUP BY runtime;

-- B6 计费护栏
SELECT ROUND(SUM(cost_usd),4) FROM usage_records WHERE runtime IN ('codex','grok');
-- 期望 ≈ 0.5877（加上本次三轮仍应 ≈ 0.59）；若 ≈ 2160 → 立即停止合并
```

**误算金额的手算对照**（用来确认"错了会错成什么样"）：codex 若按 Sonnet 计价
`637.07M×$3 + 5.67M×$15 + 543.28M×$0.30 + 0.18M×$3.75 ≈ $1911 + $85 + $163 + $0.7 ≈ $2160`。

---

## S3 · 流事件围栏丢事件

> 静默杀手 #3 · upstream `src/run-stream-fence.ts`。围栏按 `runId` 判定"这条事件属不属于当前这一轮"，晚到的旧轮事件被丢弃。Claude 是常驻进程、一个 run 贯穿多轮所以不受影响；**Codex/Grok 是单 turn re-spawn**，resume 失败重试会开新进程 —— 如果重试轮的事件不带新的 `queryRunId`，或者带的还是旧 runId，围栏会把**整个重试轮**判成 stale 全部丢掉。用户看到的是：转圈 → 停 → **一个字都没有**。

**前置条件**

1. 合并完成，`RunStreamFence` 已接入。
2. 确认 `shared/stream-event.ts` 的 `StreamEvent` 带 `queryRunId`（或等价字段），且 `make sync-types` 已同步四份副本。
3. 准备一个能稳定触发 resume 失败的手法（三选一，优先 a）：
   - **(a) 篡改 native session id**：起一轮 codex，拿到 `conversation_runtime_sessions.native_session_id`，用 SQL 改成一个不存在的值，再发下一条消息 → codex `session/load` 失败 → 走 `resumeMode` fallback 重试。
   - (b) 删掉 `data/config/codex/{providerId}/sessions/` 下对应的会话文件。
   - (c) 在 `codex-cli-runner.ts` 临时插一次性抛错（**不推荐**，改了代码测的就不是合并后的代码）。

**操作步骤**

```bash
# 1. 起一轮 codex，让它产生 native session
#    Web 里 /model 切 codex，发 "你好，记住暗号 ALPHA-7731"

# 2. 破坏 resume 锚点
sqlite3 data/db/messages.db "
UPDATE conversation_runtime_sessions
   SET native_session_id = 'deadbeef-does-not-exist'
 WHERE runtime='codex'
 ORDER BY updated_at DESC LIMIT 1;"

# 3. 发第二条消息："刚才的暗号是什么？"
# 4. 全程盯 Web 端 + 后端日志
```

**期望结果**

| 断言 | 期望 |
|---|---|
| C1 | Web 端**有字出来** —— 无论是正常回答还是「会话已重置」的说明，**不能是空白** |
| C2 | 后端日志出现 resume 失败 → fallback 的记录，且**新一轮**带一个**新的** `queryRunId` |
| C3 | `turn_events` 里这次交互留下 ≥1 行，`runtime='codex'` |
| C4 | 围栏日志里不出现「丢弃 N 条 stale 事件」，或即便出现，被丢的只是旧轮而非重试轮 |
| C5 | 对 grok 重复一遍（改 `runtime='grok'` 那行），结论相同 |

**失败表现**

- **典型形态**：前端 StreamingDisplay 显示打字动画 → 十几秒后动画消失 → 消息列表**没有新气泡**，或有一个完全空的气泡。数据库里 `messages` 也没有对应的 agent 回复行。
- 日志侧：`run-stream-fence` 打出 `accepted: false` 且 `runId` 是上一轮的值。
- **最危险的变体**：Claude 一切正常，只有 Codex/Grok 静默。因为回归只跑 Claude 就会漏掉。**所以 C5 必须做。**

**验证命令**

```bash
# C1 —— 从数据库确认真的落了一条回复，而不是只在前端闪了一下
sqlite3 data/db/messages.db "
SELECT id, chat_jid, is_from_me, substr(content,1,60), created_at
  FROM messages WHERE chat_jid='<你的 chat_jid>'
 ORDER BY created_at DESC LIMIT 4;"

# C3
sqlite3 data/db/messages.db "
SELECT turn_id, runtime, event_type, COUNT(*)
  FROM turn_events WHERE created_at >= datetime('now','-10 minutes')
 GROUP BY 1,2,3;"

# C2/C4 —— 日志
grep -E "runId|stream.?fence|resume.*fallback|stale" /tmp/happyclaw.log | tail -40
```

**收尾**：测完把 `native_session_id` 恢复或直接 `/clear` 该会话。

---

## S4 · 容器挂载函数参数错配

> 静默杀手 #4 · `src/container-runner.ts:752` `buildVolumeMounts(...)`。upstream 把它改成命名参数（对象）形态。位置参数改命名参数时，**多传一个、少传一个、顺序错一位，TypeScript 在 `any`/可选参数的地方是不报错的**，结果是某个挂载点或某个覆盖值静默变成 `undefined`。模型覆盖（`modelOverride`）走的正是这条路径。

**前置条件**

1. Docker 可用，镜像已按阶段 2.6 用 `./container/build.sh` 重建（Skills 挂载模型变了，不重建容器内 skills 全空）。
2. 选一个 `execution_mode='container'` 的工作区（本地有 27 个）。
3. 先把调用点数出来：

```bash
grep -n "buildVolumeMounts" src/container-runner.ts
# 合并前：定义 752 · 调用 1293（单一调用点）+ 注释 674/942/1551
# 合并后必须重数：每个调用点逐字段核对参数名，不能只看编译过
```

**操作步骤**

1. 在该工作区用 `/model` 设一个**与工作区默认不同**的模型（例如工作区默认 Sonnet，切成 Opus 5；或切到 codex 的一个具体模型）。
2. 发一条消息："用一句话说明你是什么模型。"
3. 容器起来后，**在容器还活着的时候**抓它的实际参数：

```bash
CID=$(docker ps --filter "ancestor=happyclaw-agent:latest" --format '{{.ID}}' | head -1)
docker inspect "$CID" --format '{{json .Mounts}}' | python3 -m json.tool
docker inspect "$CID" --format '{{json .Config.Env}}' | python3 -m json.tool | grep -iE "model|anthropic|codex|grok"
```

**期望结果**

| 断言 | 期望 |
|---|---|
| D1 | `usage_records` 新行的 `selected_model` / `resolved_model` == 你切的那个模型，**不是**工作区默认 |
| D2 | `docker inspect` 的 Mounts 至少包含：`/workspace/group`(rw) · `/workspace/global`(rw) · `/home/node/.claude`(rw) · `/workspace/ipc`(rw) · `/workspace/env-dir`(ro) · `/workspace/extra`(rw) |
| D3 | plugins 目录挂在 `/workspace/plugins`（**只读**），容器内路径带 `snapshots/` 前缀 |
| D4 | 没有任何 Mount 的 Source 是空串或 `undefined` 字面量 |
| D5 | 换 host 模式的工作区做同样的模型覆盖，`selected_model` 同样正确（双路径对称，决策见 §8.14「双路对称」） |

**失败表现**

- **最常见**：覆盖被吞，agent 用工作区默认模型回答。用户视角是「我明明切了 Opus，它还是 Sonnet 的语气/速度」，而 `/model` 界面显示的是 Opus —— **UI 与实际不一致，且没有任何报错**。
- 挂载错配：容器起来了但 agent 说"找不到 CLAUDE.md" / 写文件写到了容器临时层（重启即丢）。
- 只读/可写弄反：agent 报 `EACCES` 写不进工作区，或反过来 plugins catalog 被写穿污染（见 CLAUDE.md §10 的 catalog immutable 约束）。

**验证命令**

```sql
SELECT created_at, runtime, selected_model, resolved_model, model
  FROM usage_records ORDER BY created_at DESC LIMIT 3;
```

```bash
# D4 —— 空 Source 检测
docker inspect "$CID" --format '{{json .Mounts}}' \
 | python3 -c "import json,sys;m=json.load(sys.stdin);
bad=[x for x in m if not x.get('Source')];print('BAD:',bad or 'none')"
```

---

## S5 · docker 凭据挂载丢失

> 静默杀手 #5。codex 与 grok 在 Docker 模式下靠两个**可写**挂载拿凭据并自刷新 token：`CODEX_HOME` → `/workspace/codex-home`、`GROK_HOME` → `/workspace/grok-home`（CLAUDE.md §8.14："GROK_HOME 目录 RW 挂载 … 长会话不会因 access_token 过期掉线"）。upstream 的挂载重构里没有这两条；合并后如果丢了，**host 模式一切正常、docker 模式认证全挂** —— 而回归如果只在 admin 主容器（host）上跑就完全测不到。

**前置条件**

1. `S4` 已通过（挂载函数参数正确）。
2. 至少一个 member 用户的主容器（`home-{userId}`，强制 container 模式）可用，或临时把某个工作区切成 container。
3. codex/grok provider 均已配置且 `auth.json` 完好（`S1` 已验）。

**操作步骤**

对 **codex** 和 **grok** 各做一遍：

1. 在一个 **container 模式**的工作区 `/model` 切到该运行时。
2. 发一条需要真正调用模型的消息（不要用 `/status` 这类本地命令）。
3. 容器活着时抓挂载与环境变量：

```bash
CID=$(docker ps --filter "ancestor=happyclaw-agent:latest" --format '{{.ID}}' | head -1)
docker inspect "$CID" --format '{{range .Mounts}}{{.Destination}} rw={{.RW}} src={{.Source}}{{"\n"}}{{end}}'
docker inspect "$CID" --format '{{json .Config.Env}}' | tr ',' '\n' | grep -iE "CODEX_HOME|GROK_HOME|ANTHROPIC|CLAUDE_CONFIG_DIR"
docker exec "$CID" sh -c 'ls -l $CODEX_HOME/auth.json 2>/dev/null; ls -l $GROK_HOME/auth.json 2>/dev/null'
```

**期望结果**

| 断言 | 期望 |
|---|---|
| E1 | codex 轮：存在 Destination 含 `codex-home` 的挂载，**`rw=true`** |
| E2 | grok 轮：存在 Destination 含 `grok-home` 的挂载，**`rw=true`** |
| E3 | 容器内 `$CODEX_HOME/auth.json` / `$GROK_HOME/auth.json` 可读，size > 0 |
| E4 | 环境变量分流正确：codex 容器有 `CODEX_HOME`，grok 容器有 `GROK_HOME`；**Claude 专用的 `ANTHROPIC_*` 不应污染 codex/grok 的原生 CLI 认证路径** |
| E5 | 两轮都拿到真实回复，不报 `401` / `Unauthorized` / `not logged in` |
| E6 | **回写验证**：轮次结束后，host 侧 `data/config/grok/{id}/auth.json` 的 mtime **可以变**（CLI 自刷新回写是预期行为），但内容仍是合法 JSON 且 `access_token` 非空 |
| E7 | 对照组：同样两个运行时在 **host** 模式各起一轮，也正常 —— 确认不是凭据本身坏了 |

**失败表现**

- 挂载整个丢失：容器内 `$CODEX_HOME` 不存在 → codex CLI 报 `not logged in` / 直接退出码非 0 → agent-runner 把它包装成运行时错误 → 用户看到「运行时启动失败」。
- 挂载存在但 **`rw=false`**：**第一轮正常，几十分钟后突然掉线** —— access_token 过期时 CLI 想回写刷新结果 `EROFS`。这是最难查的形态，因为它不是立刻失败。**E1/E2 一定要断言 `rw=true`，不能只断言"挂了"。**
- 环境变量串台（E4 失效）：grok 容器里塞了 `ANTHROPIC_BASE_URL`，grok CLI 忽略它没事，但 codex 容器里若 `CODEX_HOME` 指向 grok 目录，会读到 schema 不匹配的 auth.json → 报解析错误。

---

## S6 · 三处前端静默消失

> 决策 63 / 64 · 静默变更 §8（51 个前端文件被静默删除）· §12（PWA 退役）。前端组件被删不会让 typecheck 失败（引用方一起被删了），只会让界面上少一块东西。这三处是本地自研或明确决定保留的，**必须逐个打开界面用眼睛确认**。

**前置条件**：合并完成，`make build` 通过，`make start` 起服务，浏览器**硬刷新**（Cmd+Shift+R，避开 PWA/SW 缓存）。

### S6-a 模型切换下拉

**文件锚点**：`web/src/components/chat/WorkspaceModelSelector.tsx`（挂载点在 `ChatView.tsx`）

| 步骤 | 期望 |
|---|---|
| 1. 打开任一会话 | 顶栏出现模型选择器 |
| 2. 点开下拉 | 同时列出 **claude / codex(GPT) / grok** 三条运行时的可选模型，不是只有 Claude |
| 3. 选一个跨运行时的模型 | 出现交接提示；WS 收到 `model_changed` |
| 4. 发一条消息 | 回复由新运行时产生（`usage_records.runtime` 变了） |

**失败表现**：顶栏什么都没有 / 只有 Claude 模型 / 下拉能点但选完不生效（`conversation_runtime_state` 不变）。

```bash
test -f web/src/components/chat/WorkspaceModelSelector.tsx && echo OK || echo "!! 组件被删"
grep -n "WorkspaceModelSelector" web/src/components/chat/ChatView.tsx || echo "!! 挂载点被删"
```

### S6-b 执行轨迹面板

**文件锚点**：`web/src/components/chat/TurnTracePanel.tsx`（挂载点在 `MessageBubble.tsx`；数据源 `turn_events` 表，本地独有，310 行）

> 风险点：`turn_events` 表是**本地独有**的，upstream 零命中，表不会丢；但**面板的挂载点落在 `MessageBubble.tsx` 的冲突区**，按 upstream 侧解冲突就会把入口摘掉 —— 表还在写，界面看不到。

| 步骤 | 期望 |
|---|---|
| 1. 发一条会调工具的消息（"看看 data 目录多大"） | 回复气泡下方出现「执行轨迹」入口 |
| 2. 展开 | 按 seq 列出 tool_use_start / tool_use_end / 结果摘要 |
| 3. 切到 codex 再发一次 | 同样有轨迹，且 `runtime` 列 == `codex`（见 P7） |

**失败表现**：气泡下方入口消失，但 SQL 查 `turn_events` 有新行 —— **写得进去、看不出来**。

```bash
test -f web/src/components/chat/TurnTracePanel.tsx && echo OK || echo "!! 面板被删"
grep -n "TurnTracePanel" web/src/components/chat/MessageBubble.tsx || echo "!! 挂载点被删"
sqlite3 data/db/messages.db "SELECT COUNT(*) FROM turn_events WHERE created_at>=datetime('now','-10 minutes');"
```

### S6-c 设置页三个入口

**文件锚点**：`web/src/pages/SettingsPage.tsx` 的 tabs 数组 + `web/src/components/settings/{ModelSettingsSection,GptProviderSection,GrokProviderSection}.tsx`

决策 65：GPT / Grok 并进「模型与提供商」，模型页单开。合并前 admin 可见 tab 顺序实测为：
`profile · my-channels · security · models · claude · gpt · grok · registration · appearance · system · groups · memory · skills · mcp-servers · agent-definitions · bindings · usage · monitor · users · about`

| 步骤 | 期望 |
|---|---|
| 1. admin 登录 → 设置页 | **models / claude / gpt / grok** 四个入口都在（或按决策 65 合并后的形态，但 GPT 与 Grok 的配置面必须可达） |
| 2. 点 gpt | codex provider 列表可见、可编辑、可测连通性 |
| 3. 点 grok | grok provider 同上 |
| 4. 点 models | 系统默认 / 工作区默认模型可设 |
| 5. member 登录 | 这四个 tab **不可见**（admin-only 判定按决策 54 改用角色） |

**失败表现**：tab 数组里的 `gpt` / `grok` 两行被静默删掉 → codex/grok provider **再也无法从 UI 配置**，只能改文件。用户视角：「新装一台机器没法接 Grok」。

```bash
grep -nE "key: '(models|claude|gpt|grok)'" web/src/pages/SettingsPage.tsx
for f in ModelSettingsSection GptProviderSection GrokProviderSection; do
  test -f "web/src/components/settings/$f.tsx" && echo "OK $f" || echo "!! 缺 $f"
done
```

### S6-d PWA 离线能力（决策 64，附带确认）

upstream 删了 `vite-plugin-pwa` 并加了自毁 SW。决策 64 保本地。

```bash
grep -n "VitePWA" web/vite.config.ts || echo "!! PWA 插件被删"
test -f web/public/sw.js && echo "!! upstream 自毁 SW 被带进来了，需删除"
grep -n "vite-plugin-pwa" web/package.json || echo "!! 依赖被删"
```

肉眼确认：Chrome DevTools → Application → Service Workers，注册的是 workbox 生成的 SW 而不是 `sw.js` 自毁脚本；离线（DevTools → Network → Offline）后刷新，历史消息仍能出来。

---

# 二、三条运行时对等矩阵的逐格用例

阶段 3 之后逐格验。`C` = Claude · `X` = Codex · `G` = Grok。`—` 是结构性不可能，不是缺陷。

**统一前置**：准备三个工作区（或一个工作区切三次），每次 `/model` 切换后**先 `/clear`** 再开始，避免上一轮上下文干扰。

| # | 能力 | C | X | G |
|---|---|---|---|---|
| P1 | 人格注入生效 | ✓ | ✓ | ✓ |
| P2 | MCP 内建工具（含飞书） | ✓ | ✓ | ✓ |
| P3 | MCP 权限策略生效 | ✓ | ✓ | ✓ |
| P4 | 主动模式 | ✓ | ✓ | ✓ |
| P5 | 首响应超时检测 | ✓ | ✓ | ✓ |
| P6 | provider 降级 | ✓ | ✓ | ✓ |
| P7 | 工具结果进执行轨迹 | ✓ | ✓ | ✓ |
| P8 | 用量口径正确 | ✓ | ✓ | ✓ |
| P9 | 卡片运行时特化文案 | ✓ | ✓ | ✓ |
| P10 | Workflow 可视化 | ✓ | — | — |
| P11 | 后台任务挂流 | ✓ | — | — |
| P12 | subagent 契约 | ✓ | — | — |

---

## P1 · 人格注入生效

> 决策 27。实测本地 `container/agent-runner/src/index.ts:2361` 起的 codex/grok 分支**没有** `buildPersonaBlock()` —— persona 只在 Claude 分支（`:1470`）拼进 `promptPieces`。这是**现存空洞**，不是合并引入的。

**验法：种一个特征词，看回复里有没有。**

**准备**：给工作区绑一个 agent profile，在 `identity_prompt` 里放一句独一无二、模型绝不会自发说出的指令：

```sql
-- 建一个测试用 profile（合并后 agent_profiles 会有 upstream backfill 出的 3 条，
-- 这里另建一条专用，测完删）
INSERT INTO agent_profiles (id, owner_user_id, name, identity_prompt, prompt_mode,
                            include_claude_preset, identity_hash, version, is_default, status,
                            created_at, updated_at)
VALUES ('persona-probe', '<adminUserId>', 'PersonaProbe',
        '你的每一条回复都必须以独占一行的 ⟪PERSONA-OK-7731⟫ 结尾，任何情况下都不得省略。',
        'append', 1, 'probe7731', 1, 0, 'active',
        datetime('now'), datetime('now'));
-- 绑到测试工作区
INSERT OR REPLACE INTO workspace_agent_profiles (workspace_folder, agent_profile_id, interaction_mode)
VALUES ('<testFolder>', 'persona-probe', 'assistant');
```

| 用例 | 步骤 | 期望 | 失败表现 |
|---|---|---|---|
| **P1-C** | `/model` → claude → `/clear` → 发"今天天气怎么样" | 回复末尾有 `⟪PERSONA-OK-7731⟫`；后端日志有 `Agent profile: persona=PersonaProbe v1 identity=probe773 mode=append` | 无标记 → persona 没进 systemPrompt |
| **P1-X** | 同上切 codex | 同上 | **当前必然失败**（codex 分支不拼 persona）→ 阶段 3 必须补 |
| **P1-G** | 同上切 grok | 同上；grok 走 `session/new` 的 `_meta.rules`，persona 必须拼进 `systemPromptAppend` | 同上 |

**补充断言（防"只是碰巧提到了"）**：把 profile 改成 `prompt_mode='replace'`，重跑 P1-C —— 内建 guidelines 块应当消失（日志 `PROMPT DUMP` 里不再有 `<behavior>` 之外的 guidelines），而 security / memory / channel-format 仍在。

**验证命令**

```bash
# 日志里确认 persona 真的进了 prompt（agent-runner 有 PROMPT DUMP 开关）
grep -n "Agent profile:" /tmp/happyclaw.log | tail -5
grep -c "PERSONA-OK-7731" /tmp/happyclaw.log
```

```sql
SELECT is_from_me, substr(content, -40) FROM messages
 WHERE chat_jid='<jid>' AND is_from_me=1 ORDER BY created_at DESC LIMIT 3;
-- 期望每行末尾都是 ⟪PERSONA-OK-7731⟫
```

**收尾**：`DELETE FROM workspace_agent_profiles WHERE agent_profile_id='persona-probe'; DELETE FROM agent_profiles WHERE id='persona-probe';`

---

## P2 · MCP 内建工具（含飞书）

> 决策 22 / 25。工具 catalog 在 `container/agent-runner/src/mcp-tools.ts` 的 `createMcpToolCatalog()`（运行时中立）；Claude 走 SDK 同进程注册，Codex/Grok 走独立进程 `happyclaw-mcp-server.js`。取 upstream 版会切断 Codex/Grok 的内建工具（飞书工具历史被调用 1045 次）。

**验法：让 agent 显式调用三类工具，从 `turn_events` 确认真的调到了。**

| 用例 | 提示词 | 期望调用的工具 | 期望结果 |
|---|---|---|---|
| P2-*-a | "把这句话记到记忆里：合并测试基线 7731" | `memory_append` | `turn_events` 有 `tool_name='memory_append'` 且有 `tool_use_end` |
| P2-*-b | "搜索记忆里有没有 7731" | `memory_search` | 返回上一条 |
| P2-*-c | "给这个会话发一条消息：TOOLCHECK" | `send_message` | IM/Web 侧收到独立一条 `TOOLCHECK` |
| P2-*-d（飞书） | 在**飞书**会话里："把当前工作区的 README 发到这个群" | `send_file` / 飞书能力工具 | 群里收到文件 |
| P2-*-e | "列一下现在有哪些定时任务" | `list_task` | 返回 24 条中属于本工作区的 |

三条运行时各跑一遍 a–c 与 e；d 只在飞书会话里跑（本地有 25 个 feishu 注册会话）。

**期望结果（通用）**

```sql
SELECT runtime, tool_name, event_type, COUNT(*)
  FROM turn_events
 WHERE created_at >= datetime('now','-15 minutes')
   AND tool_name IS NOT NULL
 GROUP BY 1,2,3 ORDER BY 1,2;
-- 期望：claude / codex / grok 三个 runtime 都出现，且每个 tool_name
--       同时有 tool_use_start 与 tool_use_end
```

**失败表现**

- Codex/Grok 侧 agent 回答"我没有这个工具" / "无法访问记忆" → 独立进程 MCP server 没挂上（检查 `session/new` 的 `mcpServers` 数组、context 文件里的 `workspaceIpc` 绝对路径）。
- Grok 特有：grok 把 MCP 工具包成 `use_tool`，真实工具名在 `rawInput.tool_name`。若 `turn_events.tool_name` 记成 `use_tool` 而不是 `memory_append`，是 `grok-event-normalizer.ts` 的解包丢了。
- 飞书工具在 Codex/Grok 上每次调用必抛 → 说明误取了 upstream 的飞书工具实现（决策 25 明确不吸收）。

---

## P3 · MCP 权限策略生效

> 决策 28。权限收窄若只对 Claude 生效，是**安全问题**：管理员在 UI 上把某工具禁掉了，codex/grok 照样能用。

**验法：禁一个工具，看三条运行时是否都被挡。**

**准备**：给测试工作区把 `send_message` 加进 disallow（走 `/api/groups/:jid/workspace-config` 或 MCP 策略 UI；具体入口以合并后的设置页为准）。

| 用例 | 步骤 | 期望 |
|---|---|---|
| P3-C/X/G | 切到该运行时 → "给这个会话发一条消息：SHOULD-NOT-APPEAR" | agent 明确说它不能调这个工具；`turn_events` **无** `tool_name='send_message'`；IM/Web **收不到** `SHOULD-NOT-APPEAR` |

**失败表现**：`SHOULD-NOT-APPEAR` 真的发出来了 —— 且**只在 codex/grok 上发出来**。这是最典型的"权限收窄静默失效"：管理员以为禁了，实际只禁住了 Claude。

```sql
SELECT COUNT(*) FROM messages
 WHERE content LIKE '%SHOULD-NOT-APPEAR%' AND created_at >= datetime('now','-15 minutes');
-- 期望 0
```

**反向对照**：把 `send_message` 放回白名单，重跑 P2-*-c 确认能发 —— 证明挡住的是策略不是别的故障。

---

## P4 · 主动模式

> 决策 29。不接的形态是：**转圈 → 停 → 全空白**。

**验法：触发一次不由用户消息驱动的输出，看它有没有落地成一条真实回复。**

| 用例 | 步骤 | 期望 |
|---|---|---|
| P4-C/X/G | 1. 把工作区 `interaction_mode` 设为主动模式<br>2. 建一个 1 分钟后触发的 once 定时任务，内容"向本会话报告当前时间"<br>3. 等触发 | 到点后会话里出现一条 agent 消息；`messages.is_from_me=1`；`turn_events` 有该轮；IM 绑定的渠道也收到 |

**失败表现**

- Web 端转圈几十秒后什么都没有，`messages` 无新行 —— 主动轮的输出没有出口。
- 有 `turn_events` 但没有 `messages` → 产出了但投递没接上（对照 §5 `delivery_status` 语义撞车，决策 46）。
- 只有 Claude 成功 → codex/grok 的单 turn re-spawn 模型下主动轮没被 drain 驱动。

```sql
SELECT chat_jid, is_from_me, substr(content,1,60), created_at
  FROM messages WHERE created_at >= datetime('now','-3 minutes') ORDER BY created_at DESC;
SELECT * FROM task_run_logs ORDER BY id DESC LIMIT 3;
```

---

## P5 · 首响应超时检测

> 决策 30 · 静默变更 §10「新增的硬闸」`SDK_FIRST_RESPONSE_TIMEOUT_MS = 60_000`。本地无 watchdog，Grok 的 ACP 卡死只能等 30 分钟 `CONTAINER_TIMEOUT`。

**验法：人为让首个响应永远不来，掐秒表。**

**制造挂起的手法**（择一，不改产品代码）：

- **(a) 断网法**：给 provider 配一个不可达的 baseURL（例如 `http://127.0.0.1:9`），或临时用 `pfctl`/防火墙挡掉出网。
- **(b) grok 专用**：把 `GROK_HOME` 下的 `auth.json` 换成一个语法合法但 token 无效的文件，ACP `initialize` 会握手后静默不回 —— 这正是 CLAUDE.md §8.14 提到的「Grok 的 ACP 卡死现在无检测」的真实形态。

| 用例 | 步骤 | 期望 |
|---|---|---|
| P5-C/X/G | 1. 记录开始时刻<br>2. 用 (a) 或 (b) 制造挂起<br>3. 发一条消息，掐秒表 | **60±10 秒**内前端出现明确的失败/超时提示（不是一直转圈）；后端日志有首响应超时记录；容器/进程被回收 |

**失败表现**

- 转圈超过 2 分钟仍无提示 → watchdog 没接上该运行时。**判定线：超过 90 秒即算失败**，不用真等 30 分钟。
- 出了提示但容器没回收（`docker ps` 还在、`activeHostProcessCount` 不降）→ watchdog 只报不杀，槽位泄漏（与决策 73 的并发闸相互放大）。

```bash
date +%s > /tmp/p5-start
# 发消息…
docker ps --filter "ancestor=happyclaw-agent:latest"      # 应在 60s 后清空
grep -iE "first.?response|watchdog|timeout" /tmp/happyclaw.log | tail -20
curl -s localhost:3000/api/health | python3 -m json.tool   # 队列/进程数应回落
```

**收尾**：恢复 provider 配置 / 防火墙 / auth.json。

---

## P6 · provider 降级分类

> 决策 31。顺带修「runner 从不上报 provider 失败」—— 本地 `container-runner.ts:1415` 有 `output.providerFailure` 的消费方，但 codex/grok 的 runner 侧不产生这个信号。

**验法：给 provider 一个必然失败的凭据，看池子有没有把它标成不健康并切走。**

**准备**：同一 `provider_pool_id` 下配**两个** provider（A 正常、B 凭据无效）。若只有一个，临时复制一份改坏。

| 用例 | 步骤 | 期望 |
|---|---|---|
| P6-C/X/G | 1. 把 B 的凭据改成无效<br>2. 反复发消息直到命中 B（round-robin）<br>3. 观察 | 第一次命中 B 时该轮失败或**自动切到 A 完成**；日志出现 provider 失败分类（`quota` / `rate_limit` / `auth` / `unknown`）；连续 3 次后 B 被标不健康（`UNHEALTHY_THRESHOLD=3`）；后续请求不再打 B |

**分类词表**（`classifyRuntimeError`，`container/agent-runner/src/runtime-adapter.ts:108`）：

| 运行时 | quota 关键词 | rate_limit 关键词 |
|---|---|---|
| claude | `credit balance` / `quota` | `rate_limit` / `429` |
| codex | `insufficient_quota` / `billing` | `429` / `TPM` / `RPM` |
| grok | `out of credits` / `monthly limit` / `402` | `per minute` / `RPM` / `TPM` |

**期望结果**：三条运行时都要出现分类日志，且**分类不是 `unknown`**。

**失败表现**

- codex/grok 轮直接把错误当普通失败上报 → 池子永远不标不健康 → 每次 round-robin 都有 1/N 概率打到坏账号，用户随机失败。这是**间歇性**故障，最容易被当成"偶尔抽风"放过。
- 分类成 `unknown` → 额度墙（决策 85）触发不了「同模型换账号」。

```sql
SELECT runtime, provider_id, cost_status, COUNT(*)
  FROM usage_records WHERE created_at >= datetime('now','-20 minutes')
 GROUP BY 1,2,3;
```

```bash
grep -iE "provider.*(unhealthy|degrad|fail|classif)" /tmp/happyclaw.log | tail -30
```

---

## P7 · 工具结果进执行轨迹

> 决策 33。现在 Codex/Grok 的轨迹里看不到工具**返回了什么**（只有调用没有结果）。实测 `turn_events` 310 行 `runtime` **全部是 `claude`**（决策 93 还要查清这一列到底谁在写）。

**验法：跑一个工具调用，数 start/end 配对。**

| 用例 | 步骤 | 期望 |
|---|---|---|
| P7-C/X/G | 切运行时 → "统计当前工作区有几个 .md 文件" | `turn_events` 出现该运行时的行；`tool_use_start` 与 `tool_use_end` **成对**；`tool_use_end` 行的 `summary`/`payload_json` 含真实返回内容（文件数），不是空 |

```sql
-- 配对检查：start 数应等于 end 数
SELECT runtime,
       SUM(event_type='tool_use_start') starts,
       SUM(event_type='tool_use_end')   ends,
       SUM(event_type='tool_use_end' AND COALESCE(summary,'')='' AND payload_json IS NULL) empty_ends
  FROM turn_events WHERE created_at >= datetime('now','-15 minutes')
 GROUP BY runtime;
-- 期望：三个 runtime 各一行；starts == ends；empty_ends == 0
```

**失败表现**

- `runtime` 列仍然只有 `claude` → codex/grok 的轨迹压根没写库（决策 93 的来源问题没解决）。
- `starts > ends` → 只记了调用没记结果，面板上工具永远显示"进行中"。
- `empty_ends > 0` → 记了 end 但内容是空的，面板展开一片空白。

---

## P8 · 用量口径正确

见 **S2**（同一件事的运行时视角）。逐格断言：

| 用例 | 断言 |
|---|---|
| P8-C | 新行 `runtime='claude'`，`cache_read` 与 `input` 不相交（可以 `cache_read > input`），`cost_usd > 0` |
| P8-X | 新行 `runtime='codex'`，`cache_read <= input`，`cost_usd = 0` |
| P8-G | 新行 `runtime='grok'`，`cache_read <= input`，`cost_usd = 0` |

外加决策 42：`usage_records` 导出（`/api/usage` 的导出）必须带 `runtime` 列。

```bash
curl -s -b cookie.txt "localhost:3000/api/usage/export?..." | head -1
# 期望表头含 runtime
```

---

## P9 · 卡片运行时特化文案

> 决策 34。门从 `=== 'claude'` 改成 `!== 'claude'` 的反面 —— 现存缺陷是 **Grok 发 todo 却没面板**。

| 用例 | 步骤 | 期望 |
|---|---|---|
| P9-C/X/G | 在**飞书**会话切该运行时 → 发一个需要多步的任务（"分三步整理这个目录并逐步汇报"） | 飞书流式卡片出现；卡片头部/状态区的运行时标识与实际运行时一致；**todo 面板出现**（三条运行时都要有） |

**失败表现**

- Grok 轮：`todo_update` 事件发了（可在 WS 里看到），但飞书卡片上没有 todo 区块 → 门还卡在 `=== 'claude'`。
- 文案写死 "Claude 正在思考"，切到 grok 也这么显示 → 运行时特化没做。

```bash
# 从 WS 侧确认事件确实发了（用浏览器 DevTools → Network → WS → Messages 过滤 todo_update）
grep -c "todo_update" /tmp/happyclaw.log
```

---

## P10–P12 · Claude-only 三项

这三项是**结构性不可能**，用例的目的是确认「Claude 上有」+「Codex/Grok 上优雅缺席而不是崩溃」。

| 用例 | Claude 侧断言 | Codex/Grok 侧断言 |
|---|---|---|
| **P10 Workflow 可视化** | 触发一个 workflow，前端出现可视化 | 切到 codex/grok 发同样请求：**不报错**，正常走普通轮；UI 不显示 workflow 入口（不是显示了点不动） |
| **P11 后台任务挂流** | 起一个长后台子 Agent，5 秒后不被关流杀死（F1），完成后结果追加到同一轮 | codex/grok 无后台任务概念：请求被当普通任务同步做完，**不能**卡死或产生空回复 |
| **P12 subagent 契约** | SDK `agents` 选项被 0.3.220 接受；预定义 subagent 可用 | 走 grok 内置 `spawn_subagent`（当普通 top-level 工具显示）/ codex 无 subagent：**不能**因为传了不认识的选项而启动失败 |

**P12 的运行时探测断言**（决策 37）：SDK 将来不认 `agents` 选项时是**静默忽略**，所以要有探测。

```bash
grep -rn "agents:" container/agent-runner/src/index.ts | head
node -e "const s=require('@anthropic-ai/claude-agent-sdk');console.log(Object.keys(s));" 2>/dev/null
# 能力矩阵（决策 86）落地后应有一处集中的探测结果输出
grep -iE "capabilit(y|ies).*(matrix|probe|detect)" /tmp/happyclaw.log | tail
```

---

# 三、回归用例

组合空间是 5 个运行时×模式 × 7 个渠道 × 10 个核心流程 = 350 格。全跑不现实。下面按「哪些组合能覆盖最多风险」挑出 **20 个必跑用例**，其余列可选。

## 3.1 挑选逻辑

三条覆盖原则：

1. **每个运行时×模式至少一次真实轮次** —— 覆盖 spawn 路径（host/docker 双路对称是 §8.14 的硬约束）。
2. **渠道分两类**：
   - **验存量**（feishu 25 / wechat 3 / qq 1 已注册）→ 验「原有会话继续能收发」，重点是 §1.1 的 fail-closed 路由和 8 个无 `target_main_jid` 的会话。
   - **验新接入**（discord / whatsapp / dingtalk **各 0 个已注册**）→ 验「能注册上」，重点是 §1.2 的 `onNewChat` 被挪到路由解析之后导致自动注册永久失效。**这三个渠道的存量回归不存在，别浪费时间造存量。**
3. **核心流程按"失败最贵"排序**：丢消息 > 凭据/计费 > 流式显示 > 交互细节。

## 3.2 必跑集（20 个）

| # | 组合 | 步骤 | 期望 | 关联风险 |
|---|---|---|---|---|
| **R01** | Claude / host / Web | admin 主会话（`folder=main`）发一条普通消息 | 有回复；`usage_records` 新行 `runtime='claude'` | 基线，最常用路径 |
| **R02** | Claude / container / Web | member（cxx）主会话发一条 | 有回复；容器起停正常 | 容器路径基线 |
| **R03** | Codex / host / Web | `/model` 切 codex，发一条 | 有回复；`runtime='codex'`；`cache_read<=input` | S2 + S5 host 对照 |
| **R04** | Codex / container / Web | 同上在 container 工作区 | 有回复；`codex-home` 挂载 rw=true | **S5 主用例** |
| **R05** | Grok / host / Web | `/model` 切 grok，发一条 | 有回复；ACP 正常；`runtime='grok'` | S5 host 对照 |
| **R06** | 长回复流式 / Claude | 让它写 3000 字 | 前端逐字出；不被 30000 上限截断（决策 68 上限从 100000 降到 30000，仅影响打字过程，**定稿必须完整**） | 决策 68 |
| **R07** | 长回复流式 / Codex | 同上 | 同上；重试轮也有字（**S3**） | S3 |
| **R08** | 工具调用 / 三运行时各一 | "统计工作区 .md 文件数" | `turn_events` start/end 配对，三个 runtime 都有 | P7 |
| **R09** | 子 Agent / Claude | 触发 `web-researcher`（历史用了 61 次） | 子 agent 起、有结果、结果并回主轮 | 决策 60（转成定义文件后仍可用） |
| **R10** | 文件上传下载 / Web | 上传一个 3MB 文件，让 agent 读它，再让它产出一个文件下载 | 上传成功（限 50MB）；agent 读到内容；下载正常 | `MAX_FILE_SIZE_MB` |
| **R11** | 定时任务触发 | 建 1 分钟后的 once 任务 | 到点执行；`task_run_logs` 新行；**默认上下文仍是 `group` 不是 `isolated`**（决策 82） | §三「静默的行为反转」 |
| **R12** | 定时任务 · 暂停后手动触发 | 暂停一个任务，点手动触发 | **被拒绝**（决策 83；upstream 改成允许，会真发飞书消息/真跑脚本） | §三 |
| **R13** | 定时任务 · 秒级间隔 | 存量任务里若有 <60s interval 的，重启后观察 | 不因 `MIN_INTERVAL_MS=60_000` throw 而集体 missed+pause | §三 |
| **R14** | 模型切换 · 同运行时 | Sonnet → Opus 5 | 切换成功；下一轮用新模型；上下文保留 | S4 |
| **R15** | 模型切换 · 跨运行时 | claude → grok | 生成交接摘要（`conversation_handoff_summaries` +1）；grok 侧能引用之前的内容 | 决策 12；本地 137 行基线 |
| **R16** | 工作区重置 | `/clear` 一个**IM 绑定的**会话 | 只清该会话；**不炸主会话**（决策 16 的"三行修法"）；其他工作区的运行中轮次不被误杀（F3） | **§1.1 + 决策 16** |
| **R17** | 中断 | 长任务进行中点中断 | 当前轮停止；被中断的那条输入的处置有明确回执（决策 47，不重放但有 IPC 回执）；**不丢消息** | 决策 47 |
| **R18** | 会话恢复 | 重启服务后在同一会话继续对话 | 上下文延续；`sessions` / `conversation_runtime_sessions` 未产生新孤儿（基线 5） | 决策 12/13 |
| **R19** | **存量渠道收发** | feishu 群 + feishu 私聊 + wechat + qq 各发一条 | **全部有回复**。特别是 8 个无 `target_main_jid` 的会话（feishu 4 / qq 1 / wechat 3） | **§1.1 fail-closed** |
| **R20** | **新接入渠道注册** | 把 bot 拉进一个新 dingtalk 群 / discord 频道 / whatsapp 群，各发一条 | 侧边栏**冒出新会话**且有回复 | **§1.2 onNewChat 失效** |

### R19 的执行细则（最容易漏）

这 8 个会话是 fail-closed 路由的直接受害者，且横跨两个 member 用户。**逐个发，不要抽样。**

```sql
-- 先列出这 8 个，测试时逐个对照
SELECT jid, name, folder, created_by
  FROM registered_groups
 WHERE jid NOT LIKE 'web:%'
   AND (target_main_jid IS NULL OR target_main_jid = '')
 ORDER BY jid;
```

每个会话发一条 `PING-<jid后6位>`，然后：

```sql
SELECT chat_jid, is_from_me, substr(content,1,40), created_at
  FROM messages
 WHERE created_at >= datetime('now','-10 minutes')
   AND chat_jid IN (SELECT jid FROM registered_groups
                     WHERE jid NOT LIKE 'web:%'
                       AND (target_main_jid IS NULL OR target_main_jid=''))
 ORDER BY chat_jid, created_at;
-- 期望：每个 chat_jid 下 is_from_me=0 的 PING 之后，必须有 is_from_me=1 的回复
```

**失败表现**：消息进来了（`is_from_me=0` 有行），但没有任何回复行，日志只有一条 warn。**两个 member 用户（cxx / whz）会被完全切断且不报错。**

### R20 的执行细则

这三个渠道本地零存量，所以只验「能注册上」。

```sql
-- 测试前
SELECT COUNT(*) FROM registered_groups WHERE jid LIKE 'dingtalk:%' OR jid LIKE 'discord:%' OR jid LIKE 'whatsapp:%';
-- 期望 0（基线）
-- 拉群/发消息后应变成 1~3
```

**失败表现**（§1.2 的精确形态）：admission 放行 → resolver 查不到 group → 返回 null → `return` → `onNewChat` **永不被调用**。用户视角：**发消息毫无反应，侧边栏也不冒新会话**，日志里连错误都没有。

若三个渠道无法都造出真实环境，**至少造 dingtalk 一个**（Stream 协议最容易本地起），另两个用单测替代（见 `T-CH`）。

## 3.3 可选集（时间允许时补）

| # | 组合 | 说明 |
|---|---|---|
| RO01 | Grok / container | 本地 grok 主要在 host 用；container 路径由 R04 的对称性覆盖，风险次一级 |
| RO02 | 各渠道 × 图片消息 | feishu/qq/wechat 的图片下载 + Vision base64 |
| RO03 | 各渠道 × 文件消息 | `downloads/{channel}/{date}/` 落盘 + 路径安全 |
| RO04 | 群聊 mention 门控 | `/require_mention true` 后只响应 @；决策 15 的 v58 owner_only 迁移会改 10 个飞书会话的 `audience_mode`，需确认与用户预期一致 |
| RO05 | 斜杠命令全集 | `/list` `/status` `/recall` `/clear` `/model` `/require_mention` 各一次 |
| RO06 | 脚本任务 | 决策 77：日报脚本内部调 `claude --print`，需要 OAuth → 验证环境变量**全量继承**而不是白名单 |
| RO07 | Web 终端 | `terminal_start` → 输入 → `terminal_stop` |
| RO08 | 并发压测 | 同时向 6 个 host 工作区发消息，验决策 73 的「数进行中的轮次 + 最久空闲逐出」而不是被暖进程占满槽位 |
| RO09 | Plugins | 启用一个 plugin → 新会话生效、旧会话不变（snapshot 版本化） |
| RO10 | Skills | 项目级 + 用户级 skill 在容器内可见（**镜像必须已重建**，§7 挂载模型变更） |

---

# 四、数据迁移的验证脚本

## M0 · 快照脚本（迁移前后都跑）

把下面这段存成 `scripts/db-snapshot.sh`（新增文件，chmod +x）：

```bash
#!/usr/bin/env bash
# 用法: scripts/db-snapshot.sh [db路径] [输出文件]
set -euo pipefail
DB="${1:-data/db/messages.db}"
OUT="${2:-/tmp/dbsnap-$(date +%Y%m%d-%H%M%S).txt}"
q() { sqlite3 -noheader -separator '|' "$DB" "$1"; }

{
  echo "### db=$DB at=$(date -u +%FT%TZ)"

  echo "## schema_version"
  q "SELECT value FROM router_state WHERE key='schema_version';"

  echo "## table_counts"
  for t in $(q "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"); do
    printf '%s|%s\n' "$t" "$(q "SELECT COUNT(*) FROM \"$t\";")"
  done

  echo "## registered_groups_by_channel"
  q "SELECT CASE WHEN instr(jid,':')>0 THEN substr(jid,1,instr(jid,':')-1) ELSE '?' END, COUNT(*)
       FROM registered_groups GROUP BY 1 ORDER BY 1;"

  echo "## registered_groups_distinct_folder"
  q "SELECT COUNT(DISTINCT folder) FROM registered_groups;"

  echo "## registered_groups_jid_digest"
  q "SELECT jid||'|'||folder||'|'||COALESCE(execution_mode,'')||'|'||COALESCE(is_home,'')
       FROM registered_groups ORDER BY jid;" | shasum -a256 | cut -d' ' -f1

  echo "## messages_chat_jid_histogram_digest"
  q "SELECT chat_jid||'='||COUNT(*) FROM messages GROUP BY chat_jid ORDER BY chat_jid;" \
    | shasum -a256 | cut -d' ' -f1
  echo "## messages_total_and_distinct_jid"
  q "SELECT COUNT(*)||'|'||COUNT(DISTINCT chat_jid) FROM messages;"

  echo "## conversation_runtime_triplet"
  q "SELECT (SELECT COUNT(*) FROM conversation_runtime_state)||'|'||
            (SELECT COUNT(*) FROM conversation_runtime_sessions)||'|'||
            (SELECT COUNT(*) FROM conversation_handoff_summaries);"

  echo "## conversation_session_orphans"
  q "SELECT COUNT(*) FROM conversation_runtime_sessions crs
      WHERE NOT EXISTS (SELECT 1 FROM conversation_runtime_state s
                         WHERE s.group_folder=crs.group_folder
                           AND COALESCE(s.agent_id,'')=COALESCE(crs.agent_id,''));"

  echo "## usage_records_attribution_notnull"
  for c in runtime provider_family provider_pool_id provider_id selected_model \
           resolved_model billing_scope cost_status cost_source auth_profile_generation agent_id; do
    printf '%s|%s|%s\n' "$c" \
      "$(q "SELECT SUM($c IS NOT NULL) FROM usage_records;")" \
      "$(q "SELECT COUNT(*) FROM usage_records;")"
  done

  echo "## usage_by_runtime"
  q "SELECT COALESCE(runtime,'(null)'), COUNT(*), SUM(input_tokens), SUM(cache_read_input_tokens),
            SUM(cache_creation_input_tokens), SUM(output_tokens), ROUND(SUM(cost_usd),4)
       FROM usage_records GROUP BY 1 ORDER BY 1;"

  echo "## unbound_im_groups"
  q "SELECT COUNT(*) FROM registered_groups
      WHERE jid NOT LIKE 'web:%' AND (target_main_jid IS NULL OR target_main_jid='');"

  echo "## fk_violations"
  q "PRAGMA foreign_key_check;" | wc -l | tr -d ' '

  echo "## integrity"
  q "PRAGMA integrity_check;"
} > "$OUT"
echo "$OUT"
```

用法：

```bash
BEFORE=$(scripts/db-snapshot.sh data/db/messages.db)
# …执行迁移…
AFTER=$(scripts/db-snapshot.sh data/db/messages.db)
diff -u "$BEFORE" "$AFTER" | tee /tmp/migration-diff.txt
```

**所有后续断言都是在读这份 diff。**

---

## M1 · `registered_groups` 64 行不变

```sql
SELECT COUNT(*) FROM registered_groups;                 -- 期望 64
SELECT COUNT(DISTINCT folder) FROM registered_groups;   -- 期望 36
```

外加 digest 比对（M0 的 `registered_groups_jid_digest`）：**阶段 0.5 / 1 / 2 / 3 / 4 必须完全一致**。阶段 5 允许变（新增 `channel_account_id` 列不进 digest，但若 digest 变了说明动了 jid/folder/execution_mode/is_home，**这是红线**）。

**失败表现**：数字变小 → 有 DELETE 跑过；digest 变而数字不变 → 某一列被批量改写（例如 v58 的 `audience_mode` 不在 digest 里所以不会误报；若 digest 变了，是 `execution_mode` 或 `folder` 被改）。

---

## M2 · `messages` 13744 行 `chat_jid` 不变（多账号方案的关键点）

> §3.3「不重写历史 JID」的整个价值就压在这一条上。

```sql
-- a. 总数与 distinct jid 数
SELECT COUNT(*), COUNT(DISTINCT chat_jid) FROM messages;
-- 冻结时基线：13744 | <distinct 值，以 M0 快照为准>

-- b. 逐 jid 直方图 digest（最强断言）
--    M0 的 messages_chat_jid_histogram_digest 必须**完全相同**

-- c. 任何 jid 含账号片段 = 立即失败
SELECT COUNT(*) FROM messages WHERE chat_jid LIKE '%#account:%';   -- 期望 0

-- d. 孤儿检查（FK 保持 ON 后写入会抛错，先确认存量干净）
SELECT COUNT(*) FROM messages m
 WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.jid = m.chat_jid);  -- 期望 0
```

**注意**：`messages` 总数在跑的系统上**会增长**（测试本身就在产生消息）。所以断言是：

- **b（直方图 digest）** 只在「停服 → 迁移 → 立刻快照」的窗口里做严格相等；
- 若中间有正常业务写入，改为断言 **c（零账号片段）** + **每个既有 jid 的计数只增不减、且没有 jid 消失**：

```sql
-- 允许增长的弱化版：没有任何 jid 的计数变小、没有 jid 消失
-- 把 before 快照的直方图导成表再比
```

```bash
sqlite3 -noheader -separator '|' "$BEFORE_DB" \
  "SELECT chat_jid, COUNT(*) FROM messages GROUP BY 1;" | sort > /tmp/hist-before.txt
sqlite3 -noheader -separator '|' data/db/messages.db \
  "SELECT chat_jid, COUNT(*) FROM messages GROUP BY 1;" | sort > /tmp/hist-after.txt
join -t'|' -a1 -e MISSING -o 0,1.2,2.2 /tmp/hist-before.txt /tmp/hist-after.txt \
 | awk -F'|' '$3=="MISSING" || $3+0 < $2+0 {print "!! 回退或消失: "$0}'
# 无输出 = 通过
```

---

## M3 · `conversation_runtime_*` 三张表行数不变

```sql
SELECT (SELECT COUNT(*) FROM conversation_runtime_state)      AS state,        -- 33
       (SELECT COUNT(*) FROM conversation_runtime_sessions)   AS sessions,     -- 52
       (SELECT COUNT(*) FROM conversation_handoff_summaries)  AS handoffs;     -- 137
```

> 这三张表 upstream **零命中**（决策 12），所以迁移后应当**一行不变**。任何变化都说明有意料之外的代码在动它们。

**同时验孤儿不增加**（决策 12 的「权威 + 单向派生投影」，决策 13 的「补 7 处级联」）：

```sql
SELECT COUNT(*) FROM conversation_runtime_sessions crs
 WHERE NOT EXISTS (SELECT 1 FROM conversation_runtime_state s
                    WHERE s.group_folder=crs.group_folder
                      AND COALESCE(s.agent_id,'')=COALESCE(crs.agent_id,''));
-- 基线 5。迁移后必须 <= 5。
-- 决策 13 落地后（补齐 7 处级联），期望降到 0。
```

**失败表现**：孤儿数从 5 涨上去 → 级联删除没补齐，会话失效时 sessions 行留在原地，下次 resume 用到一个已作废的 `native_session_id` → 表现为「切换模型后 codex 报 session not found」。

---

## M4 · `usage_records` 归因列非 NULL 比例不下降

基线（7011 行）：

| 列 | 非 NULL | 比例 |
|---|---|---|
| `runtime` | 2626 | 37.5% |
| `provider_family` | 2626 | 37.5% |
| `cost_status` | 2674 | 38.1% |
| `billing_scope` | **0** | 0% |

```bash
# 比对脚本：after 的每一列非 NULL 数不得低于 before
python3 - <<'PY'
import re,sys
def load(p):
    d={}; sec=None
    for line in open(p):
        line=line.rstrip('\n')
        if line.startswith('## '): sec=line[3:]; continue
        if sec=='usage_records_attribution_notnull' and '|' in line:
            c,nn,tot=line.split('|'); d[c]=(int(nn),int(tot))
    return d
b=load(sys.argv[1]); a=load(sys.argv[2]); bad=0
for c,(nn,tot) in b.items():
    nn2,tot2=a.get(c,(0,0))
    rb = nn/tot if tot else 0
    ra = nn2/tot2 if tot2 else 0
    flag = '!!' if ra + 1e-9 < rb else 'ok'
    if flag=='!!': bad+=1
    print(f"{flag} {c}: {nn}/{tot} ({rb:.1%}) -> {nn2}/{tot2} ({ra:.1%})")
sys.exit(1 if bad else 0)
PY
```

**为什么用比例不用绝对数**：决策 10 会往 `usage_events` 复制 7011 行，`usage_records` 本身也可能因为测试新增行。绝对数会误报，比例才是「新写入的行有没有继续填归因列」的指标。

**失败表现**：`runtime` 比例从 37.5% 掉下去 → 新行走了 upstream 的写入路径（决策 11 的 11 个归因列在 upstream 模型里不存在，会全 NULL）。**这是不可逆的**：归因信息在入库那一刻就没了，事后补不回来。

**加一条前瞻断言**（决策 42）：迁移后新产生的行，`runtime` 应当 **100%** 非 NULL：

```sql
SELECT SUM(runtime IS NULL), COUNT(*) FROM usage_records
 WHERE created_at >= '<迁移完成时刻>';
-- 期望 0 | N
```

---

## M5 · 凭据文件能解密

```bash
set -e
# a. 结构完整性
python3 -c "import json;d=json.load(open('data/config/claude-provider.json'));\
print('version',d['version'],'providers',len(d['providers']))"

# b. codex/grok 的 auth.json 是合法 JSON 且有 token
for f in data/config/codex/*/auth.json data/config/grok/*/auth.json; do
  python3 -c "
import json,sys
d=json.load(open('$f'))
keys=[k for k in d if 'token' in k.lower() or 'key' in k.lower()]
print('$f', 'ok keys=', keys or list(d)[:5])" || echo "!! $f 解析失败"
done

# c. 用后端解密路径读加密块（比自己解更可信）
node -e "
const {loadProviderConfig}=require('./dist/runtime-config.js');
const c=loadProviderConfig();
console.log('providers', c.providers.length);
for(const p of c.providers) console.log(p.id, p.runtime, p.enabled,
  'secretKeys=', Object.keys(p.secrets||{}));
"

# d. 7 份 IM 配置能解密
node -e "
const fs=require('fs');
const base='data/config/user-im';
for(const u of fs.readdirSync(base)){
  for(const f of fs.readdirSync(\`\${base}/\${u}\`)){
    if(!f.endsWith('.json')) continue;
    // 走后端的解密函数，而不是 JSON.parse
    console.log(u, f, fs.statSync(\`\${base}/\${u}/\${f}\`).size);
  }
}"

# e. CLI 端到端：拿真凭据起一轮（最终裁决）
#    Web 里对 codex / grok 各发一条消息，能拿到回复即通过
```

**期望**：a 的 `version` == 5（阶段 0.2 之后）；b 全部 ok；c 的每个 codex provider 有 `codexAuthJson`、每个 grok provider 有 `grokAuthJson`；d 七份都在；e 两条都有回复。

---

## M6 · 各阶段的行数变化预期

**这是最有用的一张表** —— 每个阶段跑完后 diff M0 快照，变化必须落在下表内，**多一行少一行都要能解释**。

### 阶段 0.5（数据库**副本**上跑完整 upstream 迁移，不加门控）

目的是摸清"不干预会变成什么样"，为阶段 2 的门控清单提供依据。**在副本上做，不碰生产库。**

```bash
cp data/db/messages.db /tmp/probe.db
cp data/db/messages.db-wal /tmp/probe.db-wal 2>/dev/null || true
sqlite3 /tmp/probe.db "PRAGMA wal_checkpoint(TRUNCATE);"
scripts/db-snapshot.sh /tmp/probe.db /tmp/snap-probe-before.txt
# 用合并分支的 db.ts 指向 /tmp/probe.db 跑一次 runMigrations
scripts/db-snapshot.sh /tmp/probe.db /tmp/snap-probe-after.txt
diff -u /tmp/snap-probe-before.txt /tmp/snap-probe-after.txt
```

| 对象 | 预期变化 | 依据 |
|---|---|---|
| `schema_version` | 45 → **63** | |
| `group_members` | 32 → **表被 DROP** | §2.1 无条件 |
| `workspaces` | 64 → **35** | §2.1 `DELETE … NOT web:%` |
| `agent_channel_mounts` | 21 → 全删重建（列数 13 → 10） | §2.1 |
| `channel_mounts` | 不存在 → 新建 + 从 registered_groups 重建 | §2.1 |
| `agent_profiles` | 0 → **3** | §2.1 backfill |
| `workspace_agent_profiles` | 0 → **~35**，全部 `interaction_mode='assistant'` | §2.1 + §2.3 |
| `usage_events` | 不存在 → **7011 行**（从 usage_records 复制） | §2.2 `<51` |
| `scheduled_tasks` | 24 行不变，`delivery_route_jid` / `updated_at` 回填 24 | §2.3 |
| `registered_groups` | **64 行不变**；`owner_claim_source='explicit'` 12 行；`audience_mode='owner_only'` **10 个 feishu** | §2.2 `<58` + §2.3 |
| `usage_records` | 7011 行不变，`usage_date` 回填 7011 | §2.3 |
| `messages` | **必须完全不变** | 红线 |
| `conversation_runtime_*` | **必须完全不变**（33/52/137） | upstream 零命中 |
| 磁盘 | `data/db/migration-backups/` 出现 ~130MB 文件 | §2.5 |

**必查的两个副作用**：

```bash
du -sh data/db/migration-backups/ data/db/backups/ 2>/dev/null
# backups/ 基线已 1.2GB / 15 个文件。migration-backups/ 每次失败重启 +130MB 且无 GC。
ls -la data/db/migration-backups/ 2>/dev/null | tail -5
```

### 阶段 1（三个活 bug）

| 对象 | 预期变化 |
|---|---|
| 全部表行数 | **零变化**（纯代码修复） |
| `data/db/backups/` | 决策 4「版本要变就备份」改完后，**版本没变就不该新增备份** |

### 阶段 2（合并主体，**带本地决策门控**）

| 对象 | 预期变化 | 与 0.5 的差别 | 依据 |
|---|---|---|---|
| `group_members` | 32 → **0 / 表删** | 同 | 决策 7 |
| `workspaces` | 64 → **36** | **不是 35** | **决策 8：按 folder** |
| `agent_channel_mounts` | 21 → 10 列重建 | 同 | 决策 9 |
| `usage_events` | 0 → **7011** | 同（决策 10 明确要） | 决策 10 |
| `registered_groups` | 64 不变；`audience_mode` 10 个 feishu 设 owner_only | 同（决策 15 放行） | 决策 15 |
| `usage_records` | 7011 不变，**31 列**，11 个归因列继续写 | upstream 路径会让这些列全 NULL | 决策 11 |
| `messages` / `conversation_runtime_*` | **零变化** | 同 | 红线 |
| `agent_profiles` / `workspace_agent_profiles` | 3 / ~35 | 同 | |

> **`workspaces` 64 → 36 是阶段 2 最好认的单一指标。** 得到 35 说明门控没生效（走了 upstream 的按前缀规则）；得到 64 说明投影根本没跑。

### 阶段 3（运行时对齐）

| 对象 | 预期变化 |
|---|---|
| 表行数 | 零变化 |
| `turn_events.runtime` | 跑完对等矩阵后应出现 `codex` / `grok` 值（基线全 `claude`） |
| `usage_records.runtime` | 新行 100% 非 NULL |

### 阶段 4（任务运行租约）

| 对象 | 预期变化 |
|---|---|
| `task_runs` | 新表，**0 行** |
| `scheduled_tasks` | 24 行**不变** |
| `task_run_logs` | 只增（每次任务执行 +1） |
| 其余 | 零变化 |

### 阶段 5（多账号 + 渠道挂载）

| 对象 | 预期变化 | 依据 |
|---|---|---|
| `channel_accounts` | 0 → **7**（admin discord/wechat/feishu/qq · cxx wechat/feishu · whz wechat），全部 `is_default=1` | §3.3 |
| `registered_groups` | 64 行**不变**；新增 `channel_account_id` 列回填 **29 行**（非 web 的 25+3+1） | §3.3 |
| `registered_groups` digest | **允许变**（新列不进 digest，但 jid/folder 必须一致） | |
| `messages` | **一个字节都不动** | §3.3 红线 |
| `channel_mounts` | 成为权威表，行数 = 挂载关系数 | 决策 19 |
| 凭据文件 | `user-im/{userId}/accounts/{accountId}/{channel}.json` 出现，**原路径保留副本** | §3.4 |

```sql
-- 阶段 5 专项
SELECT COUNT(*) FROM channel_accounts;                                  -- 7
SELECT channel, COUNT(*) FROM channel_accounts GROUP BY 1;              -- discord1 feishu2 qq1 wechat3
SELECT COUNT(*) FROM channel_accounts WHERE is_default=0;               -- 0
SELECT COUNT(*) FROM registered_groups WHERE jid NOT LIKE 'web:%'
   AND (channel_account_id IS NULL OR channel_account_id='');           -- 0
SELECT COUNT(*) FROM messages WHERE chat_jid LIKE '%#account:%';        -- 0
SELECT COUNT(*) FROM registered_groups WHERE jid LIKE '%#account:%';    -- 0
```

**加第二个账号的验证**（§3.3 的核心承诺）：

1. 给 feishu 加第二个账号 → `channel_accounts` 变 8，新行 `is_default=0`。
2. 用第二个账号接一个新群 → 新的 `registered_groups.jid` **带** `#account:{id}` 片段。
3. 原有 25 个 feishu 会话的 jid **一个字符都没变**，收发照常（重跑 R19）。

---

## M7 · 外键与完整性

```sql
PRAGMA foreign_key_check;   -- 期望零行
PRAGMA integrity_check;     -- 期望 ok
```

> §2.4：本地当前 `foreign_key_check` 干净，所以 FK 强制会保持 ON。此后往 `messages` 写 `chats` 里不存在的 `chat_jid` 会**直接抛错**而不是静默成功。带 FK 的表：`messages` / `task_run_logs` / `invite_codes` / `user_sessions` / `user_subscriptions` / `user_balances`。

**新增的运行时风险**：R20（新渠道注册）如果先写 `messages` 后写 `chats`，FK ON 之后会抛错。R20 必须覆盖到这条。

---

## M8 · 备份可恢复性（阶段 0 的准入）

```bash
make backup                                    # 产出 happyclaw-backup-{date}.tar.gz
F=$(ls -t happyclaw-backup-*.tar.gz | head -1)

# a. 确认覆盖面（plan §0.1 担心的四项）
tar -tzf "$F" | grep -cE '^data/db/messages\.db$'
tar -tzf "$F" | grep -cE '^data/config/claude-provider\.json$'
tar -tzf "$F" | grep -cE '^data/config/codex/'
tar -tzf "$F" | grep -cE '^data/config/grok/'
tar -tzf "$F" | grep -cE '^data/config/user-im/'
# 五项全部 >0 才算过；任何一项为 0 → 补进 Makefile 的 backup target

# b. 恢复到临时目录并验证数据库可查询
mkdir -p /tmp/restore-test && tar -xzf "$F" -C /tmp/restore-test
sqlite3 /tmp/restore-test/data/db/messages.db "PRAGMA integrity_check; SELECT COUNT(*) FROM registered_groups;"
# 期望 ok / 64

# c. 验证凭据可解密（把 restore 出来的 config 指给 M5 的 node 脚本）
```

---

## M9 · 磁盘炸弹护栏（§2.5）

```bash
# 迁移前
du -sh data/db/backups data/db/migration-backups 2>/dev/null
df -h . | tail -1

# 迁移后每次启动都查一遍
ls -1 data/db/migration-backups 2>/dev/null | wc -l
```

**断言**：正常一次成功迁移只应产生 **1 个** migration backup。若数量随重启次数线性增长 → 说明迁移在中途抛异常、`schema_version` 停在 45，**每次重启 +130MB**。

**护栏**（决策 4）：把触发条件从写死区间 `>= 39 && < 63` 改成「版本要变就备份」，并加保留策略（最多 N 份）+ 恢复本地的 `HAPPYCLAW_ALLOW_DB_MIGRATION_WITHOUT_BACKUP` env 逃生门（upstream 删了这个，失败即中止启动且无法绕过）。

---

# 五、每个阶段的准入与退出条件

每行三问：**开始前要满足什么 / 结束时验什么 / 不通过怎么办**。

---

## G0 · 阶段 0（准备）

| | |
|---|---|
| **准入** | 服务可停机；磁盘剩余 ≥ 20GB（`data/db/backups/` 已占 1.2GB，migration backup 每份 130MB） |
| **退出** | **① `M8` 五项覆盖全通过**，且 restore 出的库 `integrity_check=ok` + `registered_groups=64`<br>**② `claude-provider.json` version == 5**，`S1` 的 A1/A5 通过<br>**③ codex 依赖 `^0.125.0` → `*`**，重装后 `codex --version` ≥ 0.145.0 且不被 XProtect 删<br>**④ 扫完其余被 `^` 钉住的依赖**（`npm outdated` 全表）<br>**⑤ `M6` 阶段 0.5 在副本上跑通**，六类数据变换逐项核对完，产出「要加门控的操作清单」（至少 §15 的四项）<br>**⑥ `M0` 生产库冻结快照已存档** |
| **不通过** | 无代码改动，直接重做。②不通过（v5 分支没接管写盘）**绝对不能进阶段 2** —— 这是 `S1` 的唯一防线。⑤跑不通说明对 upstream 迁移阶梯的理解有误，回去重读 `upstream-silent-changes.md` §2 |

```bash
# G0 一键自查
scripts/db-snapshot.sh > /tmp/G0-baseline.txt && echo "快照 OK"
python3 -c "import json;v=json.load(open('data/config/claude-provider.json'))['version'];assert v==5,v;print('version 5 OK')"
codex --version
happyclaw_cred_fingerprint > /tmp/G0-cred.txt && wc -l /tmp/G0-cred.txt
```

---

## G1 · 阶段 1（三个跟合并无关的活 bug）

| | |
|---|---|
| **准入** | G0 全绿；工作在独立分支上（决策 6） |
| **退出** | **① 仓库文档不再污染人格**：三条运行时各起一轮，问"你看到了哪些项目文档？"，回答**不得**提到 `CLAUDE.md` 之外的仓库开发文档（`docs/upstream-*.md` 等）。Grok 最严重（还扫每一级 rules 目录），必须单独确认<br>**② 长任务不再挂死**：起一个后台子 Agent 跑 >5 分钟的活，确认不被 5 秒关流杀死、完成后结果追加到同一轮（F1 的四个洞：电平信号 / shouldQuery / 完成债 / 首条 result 不当终稿）<br>**③ 迁移前备份触发条件已改**：版本不变时启动**不产生**新 backup<br>**④ `make test` 全绿**（119 个测试文件）<br>**⑤ `M0` diff 显示表行数零变化** |
| **不通过** | 三个改动各自独立 commit，`git revert` 单个即可。①的 Grok 分支是新写的代码（本地现在没有写 grok 配置的代码），风险最高，优先单独验 |

**①的具体验法**：

```
提示词："逐条列出你在系统提示里读到的所有文件名。"
期望：只有 CLAUDE.md / 全局记忆 / persona / guidelines 这类。
失败：出现 docs/upstream-merge-plan.md、docs/execution-log.md 等仓库开发文档
      → 人格被 6000+ 行合并分析污染，模型会开始"扮演在做合并的人"。
```

---

## G2 · 阶段 2（合并主体）

**最大的一段** —— 329 个冲突 hunk，其中 75 个在单个文件里。

| | |
|---|---|
| **准入** | G1 全绿；`git fetch upstream` 已做；**格式基线已统一**（2.1：先跑 upstream 版格式化，缩小纯折行冲突）；数据库已按 G0-⑥ 冻结快照 |
| **退出** | **① `make typecheck` 零错**（含 `check-stream-event-sync.sh`）<br>**② `make test` 全绿**<br>**③ 9 个响亮失败逐项解完**（推理 token 字段必填 / 投递状态重复成员 / Agent 档案字段形状 / 流事件 runtime 字段 / 工具白名单重复声明 / 三个提示词符号消失 / 记忆层开关引用失联 / agent-runner 四个 npm 依赖 / Dockerfile 装 grok 那行）<br>**④ 六个静默杀手 `S1`–`S6` 逐项签字**（本文第一节，每项都要有人写下"验过、通过"）<br>**⑤ `make sync-types` 已跑，四份副本一致**<br>**⑥ `./container/build.sh` 已重建镜像**（Skills 挂载模型变了 + 去重逻辑必须一起搬，否则 7 个重名技能会让容器起不来）<br>**⑦ `M6` 阶段 2 行数表逐项符合**，尤其 `workspaces` == **36**<br>**⑧ `M1`/`M2`/`M3`/`M4`/`M7` 全通过<br>**⑨ 回归必跑集 R01–R20 全绿** |
| **不通过** | 合并在独立分支上做，**不合就丢弃整个分支**；数据库从 G0 快照恢复。**唯一不可逆的**是 `group_members` 那 32 行（已决定删且验证过运行时零影响） |

**签字表（④）—— 建议直接贴进 PR 描述**：

```
[ ] S1 provider 凭据销毁      验证人:____ 日期:____ A1-A6 全过
[ ] S2 计费与配额口径         验证人:____ 日期:____ B1-B8 全过，B6 ≈0.59 未跳 2160
[ ] S3 流事件围栏丢事件       验证人:____ 日期:____ C1-C5 全过，codex+grok 都验了
[ ] S4 容器挂载参数错配       验证人:____ 日期:____ D1-D5 全过
[ ] S5 docker 凭据挂载        验证人:____ 日期:____ E1-E7 全过，rw=true 已确认
[ ] S6 三处前端消失           验证人:____ 日期:____ a/b/c/d 肉眼确认
```

**⑨ 的最低门槛**：R16（`/clear` 不炸主会话）+ R19（8 个无绑定会话）+ R20（三渠道注册）**必须全过**，这三个直接对应 §1.1 / §1.2 两个"线上会直接哑掉"的问题。

---

## G3 · 阶段 3（运行时对齐，约 110 行）

| | |
|---|---|
| **准入** | G2 全绿且已合并到分支主线；三条运行时各自能起一轮（R03/R04/R05 通过） |
| **退出** | **① 对等矩阵 P1–P9 的 27 格（9×3）全绿**<br>**② P10–P12 的 Claude 侧有、Codex/Grok 侧优雅缺席**（不崩溃、不空回复）<br>**③ `turn_events.runtime` 出现 `codex` / `grok`**（基线全 `claude`）<br>**④ `usage_records` 新行 `runtime` 100% 非 NULL**<br>**⑤ `M0` 表行数零变化** |
| **不通过** | 八项对齐（主动模式 / 看门狗 / 降级分类 / 渠道上下文 / Grok 水位 / 工具结果事件 / 人格注入 / MCP 权限策略）各自独立 commit，逐个 revert。**P3（MCP 权限策略）不过必须阻断发布** —— 那是安全问题（管理员以为禁了工具，codex/grok 照样能用） |

---

## G4 · 阶段 4（任务运行租约，约 800 行）

| | |
|---|---|
| **准入** | G3 全绿。选在这里做是因为**风险最低**，用来验证整套「合并 + 迁移 + 验证」流程走得通 |
| **退出** | **① 任务能建**（三条运行时各建一个）<br>**② 能跑**（到点触发，`task_run_logs` 有行）<br>**③ 能看历史**（执行日志 API 返回）<br>**④ 能重试**（失败任务可重跑，租约不卡死）<br>**⑤ 4 个 upstream 任务管理工具真的能用**（决策 23，纯 IPC，三条运行时通用）<br>**⑥ `M6` 阶段 4 表：`task_runs` 新表 0 行，`scheduled_tasks` 仍 24 行**<br>**⑦ R11/R12/R13 复跑通过**（默认上下文仍 `group`、暂停任务仍拒绝手动触发、秒级任务不集体 pause） |
| **不通过** | 删 `task_runs` 表 + revert commit。不动历史数据、不改 JID，所以回滚干净 |

**租约的专项**（`TASK_RUN_LEASE_MS = 60_000`）：

```sql
-- 持租约的任务不该被重复拉出
SELECT id, status, running_until FROM scheduled_tasks WHERE running_until IS NOT NULL;
-- 进程被 kill 后，租约到期应能被重新领取（不是永久卡死）
```

---

## G5 · 阶段 5（多账号 + 渠道挂载，约 3400 行）

| | |
|---|---|
| **准入** | **G4 稳定运行至少一个完整工作日**（plan §4：「阶段 4 验证稳定后再开始」）；`M0` 快照重取一次作为阶段 5 基线 |
| **退出** | **① `M6` 阶段 5 行数表逐项符合**（`channel_accounts`=7 全 default · `channel_account_id` 回填 29 · `messages` 零变化）<br>**② `M2` 的 c/d 断言：`messages` 和 `registered_groups` 都零个 `#account:` 片段**<br>**③ 七渠道收发正常**（feishu/wechat/qq 验存量 = R19；discord/whatsapp/dingtalk 验新接入 = R20）<br>**④ 加第二个账号能连上且不影响第一个**：`channel_accounts` 变 8、新账号的新会话 jid 带片段、原 25 个 feishu 会话 jid 一字未变且照常收发<br>**⑤ 凭据按账号 id 寻址后仍可解密**（`M5` 复跑），且原路径副本保留<br>**⑥ 前端统一渠道账号管理页**：每个渠道下可挂多账号，各自有连接状态 / 配对码 / QR（WhatsApp）/ 断开 |
| **不通过** | 见 plan §3.7，**全程可逆**：删表 → 删行 → 列置 NULL → 凭据路径回退（原路径副本还在）。**JID 不涉及**，这就是不重写历史 JID 换来的 |

**④ 的失败表现**：加第二个账号后，第一个账号的会话开始收不到消息，或收到的消息路由到了第二个账号的工作区。这说明 `IMConnectionManager` 的键从 `(userId, channel)` 改成 `(userId, channel, accountId)` 时有路径没改全，默认账号的隐式 accountId 解析不一致。

---

## G6 · 阶段 6（收尾）

| | |
|---|---|
| **准入** | G5 全绿 |
| **退出** | **① `npm run docs:check` 零错**（合并时实测 39 条：CLAUDE.md 19 条路径失效、其中 §11 测试表 17 条指向不存在的 `tests/units/`；`docs/API.md` 未索引 19 个路由模块）<br>**② CLAUDE.md 重写完成**（904 → 约 420 行），且**新写的每一条路径都真实存在**<br>**③ CI 绿**：结构取 upstream，装依赖改成不锁版本（决策 70：lockfile 不提交），**不引入三个契约测试**<br>**④ 日志轮转生效**：跑满一天后单个日志文件不超过阈值，旧文件被归档<br>**⑤ 孤儿凭据目录已清理**：`data/config/{codex,grok}/` 下没有对应不上任何 provider 的目录<br>**⑥ 明文 API key 已迁进加密块**：`data/config/claude-custom-env.json` 里不再有 ARK / VOLC 的裸 key<br>**⑦ 决策 93 结案**：查清 `turn_events.runtime` 是谁写的（阶段 3 之后该列已有 codex/grok 值，此时最容易追） |
| **不通过** | 文档与 CI 不阻断功能，可以带着 TODO 发布；但 ⑤⑥ 是安全项，**必须在合并分支进 main 之前完成** |

```bash
# ⑤ 孤儿凭据目录
node -e "
const {loadProviderConfig}=require('./dist/runtime-config.js');
const fs=require('fs');
const ids=new Set(loadProviderConfig().providers.map(p=>p.id));
for(const rt of ['codex','grok']){
  const d='data/config/'+rt;
  if(!fs.existsSync(d)) continue;
  for(const x of fs.readdirSync(d)) if(!ids.has(x)) console.log('孤儿:', d+'/'+x);
}"
# ⑥ 明文 key
grep -oE '(ARK|VOLC)[A-Z_]*' data/config/claude-custom-env.json 2>/dev/null && echo "!! 仍有明文" || echo "OK"
```

---

# 六、自动化测试的补充

现状：本地 `tests/*.test.ts` **119** · upstream **284** · 交集 74 · 本地独有 45 · **upstream 独有 210**。

## 6.1 要引入的 upstream 测试（对三条运行时有意义的）

按主题分组。引入时**必须逐个跑**，因为很多断言写死了 upstream 的架构假设（单运行时、`WebDeps.sessions`、agent-first 产品面），跑不过的要么改要么不引。

### A 组 · 运行时与流控（直接支撑阶段 2/3）— 优先级最高

| 文件 | 为什么要 | 引入注意 |
|---|---|---|
| `run-stream-fence.test.ts` | **S3 的单测形态**。围栏的 late-event / stale-finish 语义 | 必须补 codex/grok 的 re-spawn 场景（upstream 版只覆盖常驻模型） |
| `agent-runner-sdk-control.test.ts` | 首响应 60s watchdog（P5） | 要扩到 codex/grok |
| `agent-runner-result-usage.test.ts` | 结果轮的 usage 归集（P8/S2） | **必须改**：加 codex/grok 的口径分支 |
| `agent-runner-provider-runtime.test.ts` | provider ↔ runtime 绑定 | |
| `agent-runner-runtime-policy.test.ts` | 运行时策略（P3 的基础） | |
| `agent-runner-channel-context.test.ts` | 渠道上下文补齐（决策 26） | 三条运行时都要覆盖 |
| `agent-runner-context-budget.test.ts` / `-context-window.test.ts` | 上下文水位（决策 32，Grok 的 ACP 通知现在被丢弃） | 加 grok 分支 |
| `agent-runner-ipc-delivery.test.ts` | IPC 投递回执（决策 47） | |
| `provider-failure-policy.test.ts` | 降级分类（P6） | 加 grok/x.ai 措辞 |
| `provider-pool-recovery.test.ts` | `UNHEALTHY_THRESHOLD=3` / `RECOVERY_INTERVAL=300s` | |
| `provider-model-fallback.test.ts` / `-contract.test.ts` | 额度墙换账号（决策 85） | |
| `turn-outcome.test.ts` / `turn-output-coordinator.test.ts` / `turn-reply-fuse.test.ts` | 轮次产出边界 | |
| `background-task-summary-guard.test.ts` | F1 挂流的 upstream 侧防线 | 与本地 F1 实现对齐后引 |
| `steering-transition.test.ts` | 主动模式转场（P4） | |
| `proactive-output-boundary.test.ts` | 主动轮输出边界（P4） | |

### B 组 · 计费与用量（支撑 S2）

| 文件 | 为什么要 |
|---|---|
| `kaboo-pricing.test.ts` | 决策 40 引入 Kaboo 定价。**必须加运行时门控的测试**：非 Claude 不得走 Sonnet fallback |
| `usage-accounting.test.ts` | 用量归集 |
| `routes-usage.test.ts` | 用量 API |
| `usage-display-formatting.test.ts` | 前端展示（决策 66 的分口径） |
| `schema-v51-usage.test.ts` | `usage_events` 复制 7011 行（决策 10） |

### C 组 · 渠道与路由（支撑 R19/R20 与阶段 5）

| 文件 | 为什么要 |
|---|---|
| `channel-admission.test.ts` | **§1.1 fail-closed 的正面** —— 引入后必须加「resolver 返回 null 时回落而非丢弃」的用例 |
| `channel-address.test.ts` / `channel-mounts-db.test.ts` / `channel-mount-service.test.ts` | 挂载权威表（决策 19） |
| `channel-account-*.test.ts`（12 个） | **阶段 5 的主要安全网**：legacy-compat / routing / jid-e2e / pairing / startup-contract / status-ws 等 |
| `im-manager-channel-accounts.test.ts` / `im-manager-legacy-account-routing.test.ts` | 连接池按账号粒度 |
| `channel-outbox-delivery.test.ts` / `channel-reliability-store.test.ts` | 投递可靠性（决策 43/44） |
| `qq-protocol-safety.test.ts` | SSRF 防护（§14 反向增量） |
| `telegram-channel-readiness.test.ts` | getMe 预检 + 长轮询看门狗 |
| `dingtalk-group-message-ack.test.ts` | **R20 的单测替身**（如果造不出真实钉钉群） |
| `schema-v49-channel-accounts.test.ts` | 阶段 5 的迁移契约 |

### D 组 · 任务与租约（支撑阶段 4）

`task-runs-v2.test.ts` · `task-lease-settlement.test.ts` · `task-run-idempotency.test.ts` · `task-notification-receipt.test.ts` · `task-notification-wake.test.ts` · `task-definition-fingerprint.test.ts` · `task-acl.test.ts` · `task-scheduler-{contract,startup,shutdown}.test.ts` · `schema-v54-task-runs.test.ts` · `mcp-task-v2-contract.test.ts` · `routes-tasks-contract.test.ts` · `isolated-task-ipc.test.ts`

> **注意**：`task-acl.test.ts` 对应 upstream 的 `1455c7e`，台账标 ❌ 不采纳（任务执行保留本地）。引入时只取租约与幂等部分，**不取 ACL 收紧**。

### E 组 · 数据库与迁移（支撑第四节）

`db-upgrade-safety.test.ts` · `backup-restore-safety.test.ts` · `canonical-workspace-mirrors.test.ts`（**决策 8 要改成 36 而不是 35**）· `owner-claim-provenance-migration.test.ts` · `agent-tool-policy-removal-migration.test.ts` · `schema-v46/v60/v61/v62/v63-*.test.ts` · `native-context-db.test.ts` · `channel-session-owner-db.test.ts`

### F 组 · 安全与并发

| 文件 | 为什么要 |
|---|---|
| `group-queue-host-session-concurrency.test.ts` | **决策 73**。upstream 版断言「`maxConcurrentHostProcesses` 不再治理 host 准入」—— 本地决策是「数进行中的轮次 + 最久空闲逐出」，**这个测试要改写，不能照抄**（照抄等于承认设置项变哑，正是 §1.3 的问题） |
| `group-queue-ipc-receipts.test.ts` | 决策 47 |
| `group-queue-close-retry.test.ts` / `group-queue-mutation-pause.test.ts` | 停机/变更期间抑制重试 |
| `mcp-runtime-secret-boundary.test.ts` | MCP 密钥不外泄（§14） |
| `routes-mcp-server-secrets.test.ts` / `routes-mcp-server-isolation.test.ts` | `GET /api/mcp-servers` 不回传明文 env |
| `safe-git-proxy.test.ts` | DNS rebinding 防护 |
| `http-upload-policy.test.ts` | 上传策略 |
| `routes-system-settings-security.test.ts` | 设置项越权 |
| `script-runner-abort.test.ts` / `script-runner-revocation.test.ts` | 决策 77 相关（**保本地全量环境变量继承**，测试要相应调整） |
| `graceful-shutdown-order.test.ts` | 优雅关闭顺序 |
| `user-home-isolation.test.ts` | 用户隔离 |

### G 组 · 前端契约（支撑 S6）

`frontend-settings-information-architecture.test.ts`（决策 65 的三个入口）· `frontend-usage-experience.test.ts`（决策 66）· `frontend-task-run-status.test.ts` · `frontend-dropdown-interaction.test.ts` · `frontend-channel-onboarding.test.ts` · `mcp-servers-frontend.test.ts` · `channel-accounts-frontend.test.ts`（阶段 5）

## 6.2 明确**不**引入的

### 三个契约测试（决策 71，硬性）

| 文件 | 为什么不要 |
|---|---|
| `reproducible-build-contract.test.ts` | 三条断言全和本地做法冲突：① lockfile 不得 gitignore（本地 `.gitignore:34-37` 忽略三个 lockfile，决策 70 明确**不提交**）② `install:` 必须 `npm ci`（本地用 `npm install`）③ Dockerfile 必须 pin digest / 禁 `npm install -g` / 禁 `releases/latest` / `build.sh` 禁 `CACHEBUST` —— 而 CLAUDE.md §10 明确要求「Claude SDK / CLI 和容器内置工具**始终使用最新版本**」，`CACHEBUST` 和 `releases/latest` 是这条约束的实现手段 |
| `makefile-runtime-contract.test.ts` | 禁 `pm2` / `_start-direct` / `PM2_GUARD` 并要求多个本地没有的 target。决策 72 已删 pm2，但这个测试还要求一堆 upstream 特有 target |
| `builtin-skill-bootstrap-contract.test.ts` | 要求 Makefile 含 `_ensure-builtin-skills` / `install-host-tools.sh skills` / `builtin-skill-catalog.mjs validate`，`entrypoint.sh` 含 `/workspace/effective-skills`。**实测本地 builtin-skills 验证失败**（有 8+ 个 skill 目录但没有 `.catalog.json` marker）→ 引入后每次 `make start` 都会 curl 下载 tarball 整体替换 `data/builtin-skills/`，**自定义改动被覆盖** |

### 其他不引入

| 文件/组 | 为什么不要 |
|---|---|
| `frontend-pwa-retirement.test.ts` | **决策 64 保本地 PWA**。这个测试要求 `vite.config.ts` 无 VitePWA、devDeps 无 `vite-plugin-pwa`、存在自毁 `sw.js` —— 引入等于强制退役 |
| `agent-builder*.test.ts`（3 个）· `agent-profile-generator.test.ts` · `agent-capability-preview.test.ts` | 决策 57 砍对话式 Agent Builder（1200 行，355 行防自我提权，威胁模型是多租户不可信用户，本地不适用）；决策 2.5 砍 AI 辅助生成人格、有效能力预览面板 |
| `agent-profiles-frontend.test.ts` 中的治理页/头像上传部分 | 决策 2.5 砍治理页、头像上传 |
| `capability-lock.test.ts` / `capability-runtime-mutation.test.ts` | 依赖 `WebDeps.sessions`（本地已删，正是 §1.4 那条唯一解冲突也修不掉的编译断裂）。要引先决定 `capability-runtime-mutation.ts` 的去留 |
| `legacy-paired-chat-isolation-contract.test.ts` | 与决策 16 的「三行修法」语义相反（它固化 fail-closed），引入会锁死错误行为 |

## 6.3 本地要新写的测试（覆盖这次的自研设计）

六项自研设计（plan §2.3 + 决策 8/12/16/73 + 阶段 5），**每一项都是"两边都不取、自己设计"，所以 upstream 没有对应测试，必须自己写**。

### T1 · 绑定解析五出口（决策 16）

**文件**：`tests/binding-resolution-exits.test.ts`

核心是**区分「没有覆盖」和「解不出来」** —— 前者显式回落到聊天自己的 jid，后者才拦。

| 用例 | 输入 | 期望出口 |
|---|---|---|
| T1-1 | 有绑定、绑定有效 | `resolved`，返回绑定的 `effectiveJid` |
| T1-2 | **无绑定**（`target_main_jid` 为 NULL/空） | **`no_override` → 回落到 `jid` 本身**，继续处理 ← 这条对应本地 8 个会话 |
| T1-3 | 有绑定但目标工作区已删 | `unresolvable` → 拦截 + warn |
| T1-4 | 有绑定但目标不属于同一 owner | `unresolvable` → 拦截 |
| T1-5 | jid 格式不合法/未知渠道前缀 | `invalid` → 拦截 |

**必须同时断言**：T1-2 的路径下，`/clear` 作用于**该会话自己**，**不会**落到主会话（`web:main`）上把主会话炸掉。这是决策 16 的第二个收益，比第一个更隐蔽。

**数据夹具**：直接用本地那 8 个的形状 —— feishu 4 / qq 1 / wechat 3，跨 admin / cxx / whz 三个 owner。

### T2 · 工作区 folder 投影（决策 8）

**文件**：`tests/workspace-folder-projection.test.ts`

| 用例 | 输入 | 期望 |
|---|---|---|
| T2-1 | 本地 64 行 `registered_groups`（36 个 distinct folder） | 投影出 **36** 行 `workspaces` |
| T2-2 | 同一 folder 有多个 jid（多个飞书群映射同一 folder） | 只产生 **1** 行 |
| T2-3 | upstream 规则对照 | 按 `jid LIKE 'web:%'` 会得 35 —— **断言我们不是 35** |
| T2-4 | 按 jid 的旧规则对照 | 会得 64 —— **断言我们不是 64** |
| T2-5 | 幂等性 | 连跑两次投影，结果一致，不产生重复行 |
| T2-6 | 归属 | 每行 `owner_user_id` 取该 folder 下 `created_by` 的一致值；冲突时有确定的决胜规则 |

> T2-3/T2-4 是"负向断言"，作用是把决策 8 的结论钉死 —— 将来谁改回 upstream 或旧规则，测试立刻红。

### T3 · 并发闸轮次计数（决策 73）

**文件**：`tests/host-concurrency-turn-based.test.ts`

现行 bug：`activeHostProcessCount--` 在 `runForGroup` 的 finally，那是**进程退出**路径；Claude 常驻，两轮之间不退出 → 槽位在暖进程空闲期间一直被占，直到 `IDLE_TIMEOUT`（30 分钟）。

| 用例 | 场景 | 期望 |
|---|---|---|
| T3-1 | `maxConcurrentHostProcesses=2`，起 2 个 host 轮次 | 第 3 个排队 |
| T3-2 | 前 2 个**轮次结束但进程仍暖着** | 计数**降到 0**，第 3 个立刻放行 ← 核心 |
| T3-3 | 3 个暖进程都空闲、来第 4 个请求 | **逐出最久空闲的那个**，不是无限等 |
| T3-4 | 设置项真的是准入门 | 把 `maxConcurrentHostProcesses` 从 5 改成 1，第 2 个必须排队（**反 §1.3 的"设置存在、可修改、完全无效"**） |
| T3-5 | container 与 host 独立计数 | 20 容器 + 5 host 互不挤占 |
| T3-6 | 异常退出 | 进程被 kill，计数不泄漏 |

> **不要照抄 upstream 的 `group-queue-host-session-concurrency.test.ts`** —— 它断言的是「`maxConcurrentHostProcesses` 不再治理 host 准入」，与 T3-4 直接矛盾。

### T4 · 会话表派生（决策 12/13）

**文件**：`tests/conversation-session-projection.test.ts`

设计：`conversation_runtime_state` 是**权威**，`conversation_runtime_sessions` 是**单向派生投影**，**只有一个同步函数**写投影。

| 用例 | 场景 | 期望 |
|---|---|---|
| T4-1 | 写 state | 投影自动跟上，不产生孤儿 |
| T4-2 | 删 state | 级联删对应 sessions（决策 13 的 7 处补齐） |
| T4-3 | 只写 sessions（模拟旧代码路径） | **被拒绝** / 或有唯一同步函数之外的写入检测 |
| T4-4 | 存量 5 个孤儿 | 迁移后清零或明确保留并有说明 |
| T4-5 | 会话失效判定**不含引擎**（保 A5 决策） | 换引擎（provider 换但 runtime 不变）**不作废**所有会话 |
| T4-6 | 换 runtime | 生成交接摘要，`conversation_handoff_summaries` +1；`native_session_id` 按新 runtime 重建 |

**断言的 SQL 形态**（也是 `M3` 的自动化版）：

```sql
SELECT COUNT(*) FROM conversation_runtime_sessions crs
 WHERE NOT EXISTS (SELECT 1 FROM conversation_runtime_state s
                    WHERE s.group_folder=crs.group_folder
                      AND COALESCE(s.agent_id,'')=COALESCE(crs.agent_id,''));
```

### T5 · 用量分口径（决策 41/66，S2 的自动化版）

**文件**：`tests/usage-runtime-billing-scope.test.ts`

| 用例 | 输入 | 期望 |
|---|---|---|
| T5-1 | claude 行：`input=100, cacheRead=900, cacheCreate=50` | 可计费输入 = **1050** |
| T5-2 | codex 行：`input=1000, cacheRead=900`（cacheRead ⊂ input） | 可计费输入 = **1000**，不是 1900 |
| T5-3 | grok 行：同 codex 口径 | 同 T5-2 |
| T5-4 | **不变量**：codex/grok 行 `cacheRead > input` | **抛错/拒绝入库**（这是口径搞反的唯一早期信号） |
| T5-5 | Kaboo 定价运行时门控 | codex/grok 不走 Sonnet fallback，`cost_usd = 0` |
| T5-6 | 计费开关关闭 | 配额口径**仍按运行时分支**（决策 41：不受计费开关影响） |
| T5-7 | 历史回归（用真实基线做 golden） | 全表 codex+grok `SUM(cost_usd)` ≈ **0.5877**，**不是 ~2160** |
| T5-8 | 膨胀系数 | 若误用 claude 口径，codex 输入膨胀 **1.853×**、grok **1.783×** —— 用这两个数做反向断言 |
| T5-9 | 前端总数（决策 66） | codex/grok 的输入显示 == `input_tokens`，不把 cacheRead 加两遍 |

### T6 · 多账号迁移（阶段 5，§3.3 的红线）

**文件**：`tests/channel-account-migration-jid-stability.test.ts`

| 用例 | 场景 | 期望 |
|---|---|---|
| T6-1 | 从 7 份 legacy 配置投影 | `channel_accounts` 建 7 行，全部 `is_default=1` |
| T6-2 | 回填 `registered_groups.channel_account_id` | 29 行非 web 会话全部填上；**`jid` 一个字节不改** |
| T6-3 | **`messages` 零变化** | 逐 `chat_jid` 直方图 digest 前后完全相同 |
| T6-4 | 隐式默认账号解析 | 无 `#account:` 片段的 jid ≡ 该渠道默认账号 |
| T6-5 | 加第二个账号 | 新账号 `is_default=0`；**只有它的新会话**带 `#account:{id}` 片段 |
| T6-6 | 第一个账号不受影响 | 原 25 个 feishu 会话继续路由到原工作区 |
| T6-7 | 幂等性 | legacy 投影跑两次不产生重复行 |
| T6-8 | **顺序陷阱**（§2.7） | `listEnabledChannelAccounts()` 在投影**之前**返回空 → 断言启动顺序保证投影先完成，否则启动早期没有渠道会连上 |
| T6-9 | 回滚 | 删表 / 删行 / 列置 NULL 后，系统回到迁移前行为 |
| T6-10 | 凭据路径迁移 | `accounts/{accountId}/{channel}.json` 可解密，**原路径副本仍在** |

### 新测试的运行约定

```bash
make test                      # 全量（119 + 新增）
npx vitest run tests/binding-resolution-exits.test.ts   # 单个
```

六个新测试文件建议在**对应阶段开工前**先写（红），实现完转绿：

| 测试 | 在哪个阶段之前写 |
|---|---|
| T1 绑定解析 | 阶段 2 之前（§1.1 的前置条件） |
| T2 工作区投影 | 阶段 2 之前 |
| T3 并发闸 | 阶段 1 或 2（§1.3） |
| T4 会话表派生 | 阶段 2 |
| T5 用量分口径 | 阶段 2 之前（S2 的自动化防线） |
| T6 多账号迁移 | 阶段 5 之前 |

---

# 附录 A · 一轮完整验证的执行顺序

```bash
# ── 0. 冻结基线 ────────────────────────────────────────────
scripts/db-snapshot.sh > /tmp/snap-before.txt
happyclaw_cred_fingerprint > /tmp/cred-before.txt
du -sh data/db/backups data/db/migration-backups 2>/dev/null

# ── 1. 静态门 ──────────────────────────────────────────────
make typecheck            # 含 check-stream-event-sync.sh
make test                 # 119 + 新增
make format               # 或 npm run format:check

# ── 2. 构建 ────────────────────────────────────────────────
make build
./container/build.sh      # 阶段 2 必须（Skills 挂载模型变了）

# ── 3. 起服务 + 迁移 ───────────────────────────────────────
make start                # 前台，盯日志
scripts/db-snapshot.sh > /tmp/snap-after.txt
diff -u /tmp/snap-before.txt /tmp/snap-after.txt | tee /tmp/migration-diff.txt
# 逐项对照 §四 M6 的阶段表；每一行变化都要能解释

# ── 4. 六个静默杀手（人工，逐项签字）─────────────────────
#     S1 S2 S3 S4 S5 S6

# ── 5. 对等矩阵（阶段 3 之后）─────────────────────────────
#     P1..P9 × {C,X,G} = 27 格 + P10..P12 的缺席确认

# ── 6. 回归必跑集 ─────────────────────────────────────────
#     R01..R20，其中 R16 / R19 / R20 是硬门槛

# ── 7. 收尾核对 ───────────────────────────────────────────
diff /tmp/cred-before.txt <(happyclaw_cred_fingerprint)   # 凭据未被改
sqlite3 data/db/messages.db "PRAGMA foreign_key_check; PRAGMA integrity_check;"
ls -1 data/db/migration-backups 2>/dev/null | wc -l        # 应为 1
```

---

# 附录 B · 快速判定表（出问题时先查哪个）

| 用户报的现象 | 先查 |
|---|---|
| codex/grok 报 401 / not logged in | **S1**（凭据被销毁）→ **S5**（docker 挂载丢失或只读） |
| 某个运行时"转圈后一片空白" | **S3**（流事件围栏）→ **P4**（主动模式）→ **P5**（首响应超时） |
| 余额/配额突然暴增 | **S2**（Kaboo 定价没做运行时门控） |
| 切了模型但没生效 | **S4**（挂载函数参数错配） |
| 界面上少了东西 | **S6**（前端静默消失） |
| 某些 IM 会话不回消息了 | **R19** / **T1**（fail-closed 路由，8 个无绑定会话） |
| 拉进新群没反应、侧边栏不冒新会话 | **R20**（`onNewChat` 被挪到路由解析之后） |
| 长会话跑一半突然掉线 | **S5-E1/E2**（凭据挂载 `rw=false`，token 刷新写不回） |
| 并发上不去、设置项改了没用 | **T3**（并发闸数的是进程不是轮次） |
| 切模型后 codex 报 session not found | **M3/T4**（会话表孤儿，级联没补齐） |
| 磁盘被撑爆 | **M9**（migration backup 每次失败重启 +130MB，无 GC） |
| 容器内 skills 全空 | 忘了 `./container/build.sh`（Skills 挂载模型变更） |
