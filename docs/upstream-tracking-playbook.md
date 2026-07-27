# 追版本手册

fork 跟 upstream 合并的原则、流程与检查清单。**下次追版本前先读这份**。

内容全部来自实测，不是通用建议，是这个仓库踩过的坑：

| 轮次       | 规模                                 | 抓到                                                           |
| ---------- | ------------------------------------ | -------------------------------------------------------------- |
| 2026-07-25 | 121 提交 · 341 冲突块 · 147 本地提交 | **19 个真 bug**，其中 8 个上线后用户反馈才发现                 |
| 2026-07-27 | 7 提交 · 17 冲突块                   | **1 个生产阻断**（2 个用户的主容器起不来）+ 1 个既存的备份失效 |

第二轮规模只有第一轮的 1/20，但仍然出了一个能让用户直接停摆的问题 ——
**提交数少不等于风险低**。那个 bug 的形态是第一轮没见过的（同名字段语义漂移），
tsc 和 2927 个测试全绿，只有拿生产真实数据跑关键函数才暴露。

标了「2026-07-27 轮补」的段落是第二轮新增的。

---

## 一、不可协商的三条

### 1. 不用 `merge -s ours` / `-s theirs` 跳过冲突

341 个冲突块必须逐个看。跳过等于把「哪些本地能力被覆盖了」变成未知，而这次的伤
**绝大多数不是冲突标记里的内容**，是解冲突时判断错的地方 —— 连人工看都会漏，
机器一把梭必然是灾难。

### 2. 本地能力零丢失是硬约束

合并的目标是「拿到 upstream 的新东西」，不是「变成 upstream」。每一处
`git checkout --theirs` 都要问：本地这边被覆盖的是什么？它还有别的地方提供吗？

这次靠这条救回来的：`WorkspaceModelSelector`、`TurnTracePanel`、4 个被删的组件
文件、`stores/workspace-config.ts`、中断按钮、per-user AI 外观、`privacyMode`、
`onConfirmedGone`、`ChatProbe`、F1 完成债机制。

### 3. 产品判断上交，不自己拍板

冲突里凡是涉及「用户能感知的行为该是哪种」，写成决策项交给人，不替他决定。
这次形成了 `docs/upstream-decision-ledger.md`，决策编号直接写进代码注释
（如「决策 38：codex 只保留 CLI」），后来查残留时靠它定位。

---

## 二、合并伤的分类学

这次遇到的伤只有四种形态。**认得出形态，就知道该用哪种手段找。**

### 形态 A · 两侧实现都留下（最常见，tsc 完全干净）

本地和 upstream 各有一套实现，解冲突时两边都保留 → 同一件事做了两遍。

| 症状                             | 重复的两侧                                             |
| -------------------------------- | ------------------------------------------------------ |
| 每条回复发两次、DB 落两行        | 本地 `sendMessage` + upstream `sendMessageWithOutcome` |
| 用量入库双计、日汇总翻倍         | 本地 INSERT + upstream 的事件转发                      |
| Web 聊天区渲染两遍（两个输入框） | 本地的话题侧栏块 + upstream 的主对话画布块             |

**怎么找**：对每个大改动的文件，数一数「关键锚点」在两侧父提交里各有几个、合并后
有几个。数量变多就是信号。

```bash
for f in src/index.ts web/src/components/chat/ChatView.tsx; do
  for ref in $LOCAL_PARENT $UPSTREAM_PARENT HEAD; do
    printf '%s %s: ' "$f" "$ref"
    git show $ref:$f 2>/dev/null | grep -c "$ANCHOR"
  done
done
```

`ChatView.tsx` 从 1093/1284 行涨到 1583 行，就是这么发现的。

### 形态 B · 一侧的关键行没跟过来（tsc 也干净）

变量有声明、有读取、有清空，**唯独赋值那一行没了**。逻辑上永远走不到那条路。

这次实际发生 6 次：

- `pendingUsage` —— 主消息用量丢失
- `pendingAgentUsage` —— SubAgent 用量丢失
- `completedStreamingSessionForUsage` —— 卡片用量 patch 恒为 no-op
- `this.usageNote = usage` —— 定稿卡片拿不到用量
- `runtimeProfile` —— 卡片的 codex/grok 文案是死代码，从没被传过
- `web/package.json` 的 `@dnd-kit` 三行声明 —— 全新克隆构建失败

**怎么找**：写个检查，找「只被读和清空、从没被赋值」的变量。

```bash
# 对可疑变量，看赋值点在两侧父与 HEAD 的数量
git show $LOCAL_PARENT:src/index.ts | grep -c "pendingUsage = "
grep -c "pendingUsage = " src/index.ts
```

### A 与 B 的机械检测：三方计数公式（2026-07-27 轮补）

上面两条都是「挑可疑对象再去数」，依赖先猜对。有个不用猜的做法 —— 对合并涉及的
每个文件、每个标识符，算一遍：

```
预期出现次数 = HEAD + upstream − base
```

**超量 = 形态 A**（两侧都留下），**欠量 = 形态 B**（一侧没跟过来）。全仓跑一遍，
把结果里「你主动增删过的文件」剔掉，剩下的**应该是空的**。不空就逐个看。

2026-07-27 轮实测：偏差全部落在两个刻意增删的文件上，其余文件零偏差 —— 几秒钟
就把「有没有漏/重」这个问题变成了确定答案，不用再逐文件肉眼比对。

实现要点：token 取 `[A-Za-z_$][A-Za-z0-9_$]{5,}`（长度门槛滤掉 `if`/`for` 之类的
噪声），`git show base:f` / `git show head:f` / 读工作区文件三方各算一个
`Counter`，比较即可。三十行 Python 足够。

**局限**：只看标识符出现次数，测不出「顺序错了」「条件反了」。它回答的是
「有没有东西多了或少了」，不回答「对不对」。

### 形态 C · 决策残留

做了「删掉 X」的决策，但 X 在别处还被引用。

决策 38（codex 只留 CLI）删了 `@openai/codex-sdk`，三处没跟上：

- `container-runner.ts` 的 preflight `requiredDeps` —— **所有宿主机会话报缺依赖，完全跑不起来**
- `Makefile` 的 `ensure-latest-codex-sdk` / `update-codex-sdk` —— 每次 `make start` 都去更新不存在的包
- `check-container-sdk` 的版本比对 —— 死代码

**怎么找**：每条「删除类」决策落地后，全仓 grep 被删的符号名，包括
Makefile / CI / 字符串数组 / 注释。

**第二轮（2026-07-27）又扫出四处**，全在主进程侧——第一轮只清了 agent-runner：

- 根 `package.json` + `package-lock.json` 仍声明 `@openai/codex-sdk`
- `src/codex-runtime.ts` 的 `probeSdk()` —— 动态 import 探测该包是否可用
- `web/.../GptProviderSection.tsx` 把探测结果渲染成「SDK：已安装」
- `scripts/launchd-start.sh` 还在调 `make ensure-latest-codex-sdk`（target 已删，
  每次 launchd 启动都报 `No rule to make target`，被 `||` 兜住所以没人注意）

这轮的教训是**「有消费方」不等于「该保留」**。表面上探测有完整调用链
（probe → HTTP 路由 → 前端展示），看着像真实用途；但被探测的包是我们自己
根 `package.json` 里的硬依赖，所以探测结果恒为 `true`，那行 UI 只能渲染出
「已安装」一种状态。**一个由自己的依赖声明决定的常量，被包装成诊断信息展示**
——它不是消费方，是同一条残留往上多爬了两层。

判据：顺着调用链找到消费方之后，再问一句「这个值有没有可能取到另一个分支？」
取不到，就是常量，就还是残留。

**同一条决策要在所有 workspace 里各清一遍**：monorepo 的每个 `package.json`、
每个 `node_modules` 解析根都是独立的现场，清了一个不等于清了其余。

### 形态 D · 前提被另一侧取消

一侧的代码依赖某个前提，另一侧把前提改掉了。

- 卡片新建时是 `idle`，`isActive()` 为 false → upstream 的清理分支把它当过期卡丢弃
  → 第一个 stream event 就把卡片扔掉，本轮再无卡片。本地父在同样位置**丢弃后会
  立刻重建**，所以不成问题；upstream 换成了不重建。
- `usage_records` 三列只写进 `CREATE TABLE`，没有对应 `ensureColumn` → 新装库正常，
  **存量库升级时 v51 回填抛 `no such column`，服务起不来**。

**怎么找**：只有实跑。见第四节。

#### D 的两个高频子类（2026-07-27 轮补）

**D1 · 同名字段语义漂移**

同一个列在 upstream 和 fork 里含义不同，upstream 新增的使用方式就会踩空。

`registered_groups.channel_account_id`：upstream 语义是「本工作区绑的**飞书 Bot**」，
本 fork 里存的是**任意渠道**的账号（微信 / QQ 同用这一列）。upstream 新增的
feishu-cli 工作区级回落不加判断地取它 → 把微信账号当飞书 Bot 交给 fail-closed 的
校验 → 抛 `wrong provider` → **该工作区完全无法 spawn**。生产实测命中 2 个用户的
主容器。typecheck 干净，2927 个测试全过 —— 没有任何测试覆盖「绑了非飞书账号」这个
本地独有的数据形状。

**怎么找**：列出本轮 upstream 新读取的**持久化字段**，逐个问「这一列在 fork 里
是不是同一个意思」。

**D2 · fail-closed 收紧**

upstream 把「坏了就降级」改成「坏了就拒绝」。动机通常正当（损坏的授权边界不该被
静默当成安全），但存量数据里但凡有一条不合新规，对应实体就直接停摆。

这一轮一次来了四处：`container_config` 解析（还**拒绝未知字段**）、mount 白名单
严格化、`assertValidWorkspaceFolderName`、feishu-cli 账号绑定。

**怎么找**：机械扫本轮新增的 throw，逐条对生产数据验证。

```bash
git diff $LOCAL_PARENT -- src/ | grep -E '^\+.*throw new' | sed 's/^+ *//' | sort -u
```

---

## 三、门禁的能力边界

**按检出难度排序，越往下越需要真跑。**

| 手段                | 能抓                         | 抓不到                      |
| ------------------- | ---------------------------- | --------------------------- |
| `tsc`               | 语法破坏、重复声明、类型不符 | 形态 A/B/C 全部             |
| `make test`         | 参数错位、逻辑分支、契约     | 未连接的组件、镜像/环境状态 |
| 全量 test（非单跑） | 共享路径的连带影响           | —                           |
| `build:all`         | 构建期的类型与依赖           | node_modules 残留掩盖的缺失 |
| `npm ci` 后构建     | 依赖声明缺失                 | —                           |
| 空库启动            | 全新安装路径                 | **存量库迁移路径**          |
| **存量库副本迁移**  | schema 演进、回填、幂等      | 运行时行为                  |
| **真实 spawn 一轮** | 归因、事件链、渲染           | 渠道实际收发                |
| **生产切换**        | 镜像、launchd、渠道          | —                           |

### 三条硬教训

**① 单跑目标测试不算数。** 改共享路径后必须跑全量。这次两次踩到：footer 渲染
改动通过了目标测试却破坏了两个既有契约；新设置项漏了 config 路由投影，只有全量
才被 `system-settings-projection.test.ts` 拦下。

**② 空库绿灯 ≠ 整体绿灯。** 新装库由 `CREATE TABLE` 一次性建全部列，存量库靠
`ensureColumn` 逐列补 —— **两条完全不同的分支**。我用全新安装的绿灯当成整体绿灯，
漏了 schema 45→63，直到拿生产库副本跑才炸出三个 bug。

**③ node_modules 残留会掩盖依赖缺失。** typecheck 和 test 都跑在已有依赖的环境
里，`@dnd-kit` 声明丢了照样通过，只有 `npm ci` 剪掉残留后才暴露。

---

## 四、验证分层（照这个顺序做）

### 第 0 层 · 静态门禁

```bash
make typecheck    # 三项目 + 类型副本同步 + prompt 存在性 + 文档一致性
make test         # 全量，不要单跑
npm run build:all # 三项目构建
```

### 第 1 层 · 依赖真实性

```bash
npm ci && npm --prefix web ci
npm --prefix container/agent-runner install --no-package-lock
npm run build:all
```

`agent-runner` 必须用 `install --no-package-lock`（§10 的「始终最新」契约，它没有
lock file，`npm ci` 直接报 EUSAGE）。

### 第 2 层 · 存量库迁移（**不能跳**）

拿**生产库的副本**放隔离沙箱跑迁移。沙箱只放数据库，**不放 IM 凭据** —— 否则会
连真实渠道、还可能触发定时任务。

```bash
mkdir -p /tmp/migtest/data/db
cp data/db/messages.db /tmp/migtest/data/db/
# 只调 initDatabase()，不起 web / IM / 调度器
```

断言：不抛异常、逐表零丢行、目标 schema 版本、二次启动幂等、迁移后能读真实消息、
能写用量。

### 第 3 层 · 沙箱实跑

独立端口 + 独立 `data/`，复制 provider 凭据但**不复制 `user-im/`**（同一份 IM
凭据双连会出现两个 bot 抢答）。

三条运行时各真跑一轮，验证：有回复、用量入库且归因正确、工具结果进执行轨迹、
卡片文案对应运行时。多轮对话验证上下文延续（Codex/Grok 是单 turn re-spawn，
靠 native resume，最容易断）。

### 第 4 层 · 生产切换

见第六节。

### 第 5 层 · 用户实测

**这一层不可替代。** 这次 8 个问题是上线后用户反馈才发现的：Web 双渲染、飞书卡片
不出现、两处用量 bar、微信路由、微信历史、三处通知刷屏。沙箱能覆盖数据与协议，
覆盖不了「界面看起来对不对」和「渠道实际体验」。

---

## 五、方法论纪律

这些是**我在这次合并里犯的错**，写下来是为了下次不重复。

### 先取证，再动手

连续几轮靠推断改代码，每次都要用户再反馈一次才前进。正确做法：**加诊断日志、
查库、读实际报错**，拿到确切数据再改。

反例：飞书卡片问题上，我先后猜过「patch 目标丢了」「usage 时序」「provider identity
围栏」，全错。最后加了 `[TEMP-DIAG]` 日志，发现是**零调用** —— 卡片控制器根本没被
驱动，问题在更上游。

### 改之前先确认改的是哪个组件

用户说「底 bar 没了」，我改了 Web 的 `MessageBubble`，而截图是**飞书**。白做一轮。
**看清截图/日志来自哪条链路再动手。**

### 不发明概念

查不出根因时我编了个「渠道自身即工作区」的兜底，被本地的对账机制当场抓出来
（`unexpected mount not backed by a binding` × 5），只能 revert。
**查不出来就继续查，不要造一个能让代码跑通的解释。**

### 大文件用 AST，不数缩进

`ChatView.tsx` 1583 行，肉眼数缩进两次取错块边界。用 TypeScript AST 拿精确
起止行，一次就对。

```js
import ts from 'typescript';
const sf = ts.createSourceFile(
  f,
  src,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
// 遍历找目标 JSX 元素，getStart(sf) / getEnd() → 精确行号
```

### 删代码前先看清边界

- 按大括号计数删函数，只删掉了签名，留下孤儿 body
- 用贪婪正则撤销插入，`[\s\S]*?` 跨行吃掉了 3 个 `MessageInput`

**先 `repr()` 打印要删的每一行确认，再删。**

### 改完立刻验证，不要连改多处

每处改动后跑 tsc；涉及渲染的立刻构建 + 浏览器截图。这次用沙箱浏览器实测
`ChatView` 的修复，一次就确认了「输入框 1 个、横幅 1 条」。

---

## 六、生产切换流程

```bash
# 1. 备份（必须）
make backup                    # 全量 tar.gz
cp data/db/messages.db /tmp/pre-switch.db

# 2. 确认可 fast-forward
git merge-base --is-ancestor HEAD <merge-branch>

# 3. 切分支
git merge --ff-only <merge-branch>

# 4. 依赖 + 构建（三项目都要）
npm ci && npm --prefix web ci
npm --prefix container/agent-runner install --no-package-lock
npm run build:all              # 不能只 npm run build（那只有后端）

# 5. 重建容器镜像（container 模式的会话需要）
./container/build.sh

# 6. 重启（launchd 托管，不要 kill 进程）
make launchd-restart

# 7. 验证
curl -s localhost:3000/api/health
# 迁移是否成功、行数是否守恒、渠道是否连上、有无新 ERROR
```

### 切换时踩到的坑

| 坑                                             | 后果                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| 只跑 `npm run build`                           | 前端还是旧构建，用户看到的还是旧界面              |
| 忘了 `./container/build.sh`                    | container 模式会话报 `/tmp/prompts/xxx.md` ENOENT |
| `kill` 进程                                    | launchd 会自动拉起，等于没停                      |
| worktree 的 `node_modules` 符号链接被 git 跟踪 | merge 时把真实目录替换成链接文件，**依赖被毁**    |

最后一条已经用 `.gitignore` 加了不带斜杠的 `node_modules` 规则堵住（带斜杠只匹配
目录，匹配不到符号链接文件）。

---

## 七、契约测试

### 写对方向，否则比没有更糟

`reproducible-build-contract.test.ts` 的 `lockfiles` 常量正确排除了 agent-runner
（注释也写明例外），但下面的 Makefile / CI 断言仍要求它用 `npm ci` ——
**两半自相矛盾，把 bug 钉在原地**。全新克隆装不上却一直绿。

写契约测试时问自己：**这条断言锁住的是「期望的行为」还是「当前的实现」？**

### 每个修复都补反向验证

改完之后，**把修复注掉，确认测试变红**。这次每个新增测试都做了这一步，
其中 `schema-v45-to-v63-migration` 反向验证时报出原始的
`no such column: provider_estimated_cost_usd`，证明测试真的能拦。

### 这次新增的护栏

| 文件                                   | 盯什么                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `merge-duplicate-render-guard.test.ts` | 形态 A：聊天主体容器只有一个、MessageInput 与 MessageList 数量一致、关键 prop 各出现 3 次、主回复只有一个 sdk_final 落库点 |
| `schema-v45-to-v63-migration.test.ts`  | 存量库升级路径（起点 DDL 从真实生产库导出，不是人造场景）                                                                  |
| `usage-insert-legacy-path.test.ts`     | 逐列断言值不错位、一次调用只落一行、幂等键有效                                                                             |
| `usage-deferred-until-reply.test.ts`   | usage 早于回复到达时必须缓存                                                                                               |
| `runtime-parity-phase3.test.ts`        | 三条运行时的口径与权限对齐                                                                                                 |
| `provider-auth-writeback.test.ts`      | CLI 自刷新凭据的回写                                                                                                       |

---

## 八、凭据的特殊性

codex / grok 用**可轮换的 refresh_token**，与 API key 完全不同。

- **复制凭据去测试没问题** —— 副本会接管那条链并自我维护
- **危险的是刷新之后把副本丢掉** —— refresh_token 一次性，用掉后原快照作废，
  只有刚换出来的那份有效

这次实际踩到：把生产 auth.json 复制到沙箱运行，沙箱成功刷新（新 token 写进沙箱
目录），清理沙箱时把它删了，生产里留着的旧快照已被消耗 → `Authentication required`。

已补 `persistRefreshedProviderAuth()` 把刷新结果回写进加密配置，详见
`docs/design-provider-credential-lifecycle.md`。

**同一账号可以有多条独立链**（实测：一份 20 天前的快照，在另一条链刷新过无数次
之后依然能成功刷新）。所以终端的 `~/.grok` 与 HappyClaw 的物化目录互不影响。

---

## 九、检查清单

### 合并前

- [ ] `git fetch upstream`，统计提交数与冲突文件
- [ ] `git merge-tree --write-tree --name-only HEAD upstream/main` 预演，先知道冲突面
- [ ] 逐个读 upstream 提交的意图（`git log -1 --format='%s%n%b'` + `--stat`），
      解冲突前就知道对方在解决什么问题
- [ ] 建独立 worktree，不在主仓库上做
- [ ] **`make backup` 真的跑通**，不是「敲了这条命令」。门禁自己也会腐坏 ——
      2026-07-27 轮第一步就被守卫误拦，查下来是 `make backup` 已经失效了一段时间
- [ ] worktree 里 `git reset` 之后复查三个 `node_modules`：旧分支若跟踪过这些符号
      链接，reset 会把它们删掉，之后 typecheck 会以「找不到 react」形式炸出 9000+
      个假错误
- [ ] 记录两侧父提交 hash（后面反复要用 `git show $PARENT:$FILE` 对比）

### 解冲突时

- [ ] 每个 `--theirs` 都问：本地被覆盖的是什么
- [ ] 每个 `--ours` 反过来问：upstream 这块里有没有与实现无关的**独立真修复**。
      整块丢弃时容易连带丢掉。按**函数**取舍，不按块
- [ ] 产品判断写进决策台账，不自己拍板
- [ ] 决策编号写进代码注释
- [ ] 冲突边界切穿函数体时，去两侧父取完整定义再拼；「看起来是重复」可能是
      「upstream 那侧是更新版」—— 靠 tsc 兜底，别只靠计数下结论

### 解完之后

- [ ] `make typecheck` 0 错误
- [ ] `make test` 全量通过（**不是单跑**）
- [ ] 三方计数公式全仓跑一遍（形态 A + B 一次覆盖），偏差只应落在你主动增删的文件上
- [ ] 残留冲突标记扫描：`grep -rlE '^(<<<<<<<|>>>>>>>)' $(git ls-files)`
- [ ] `git diff --name-only --diff-filter=U` 为空（改完内容别忘了 `git add`）
- [ ] `git log HEAD..upstream/main` 为空
- [ ] 每条删除类决策全仓 grep 残留符号（形态 C 检测）

### 上线前

- [ ] 依赖是否真变了：`git diff $LOCAL_PARENT -- '*/package.json'`。变了才需要
      `npm ci`；没变就不用，但要确认新增源文件没引入未声明的外部包
- [ ] 生产库副本跑迁移（**不能跳**）。无 schema 变更也要跑 —— 这一步同时验证
      新的行解析逻辑能不能吃下真实数据
- [ ] **扫本轮新增的 throw，逐条对生产数据验证**（形态 D2）：
      `git diff $LOCAL_PARENT -- src/ | grep -E '^\+.*throw new' | sort -u`
- [ ] **列出 upstream 新读取的持久化字段，逐个核对 fork 里是不是同一个语义**
      （形态 D1）。这是 2026-07-27 轮唯一真正的生产阻断的来源
- [ ] 拿真实生产数据实跑关键函数（不只是迁移）。那一轮的 bug 是
      `buildVolumeMounts` 在真实 group 上抛错，迁移本身完全干净
- [ ] 沙箱实跑三条运行时 + 多轮对话
- [ ] 通读一遍 `docs/merge-acceptance-test-matrix.md`

### 上线时

- [ ] `make backup`
- [ ] 记录基线：消息 / 工作区 / 用户行数，ERROR 累计数
- [ ] `npm run build:all`（三项目）
- [ ] 镜像是否真需要重建：`container/agent-runner/src` 是 bind-mount 进容器的，
      只改源码不用重建；动了 Dockerfile / entrypoint / 镜像内装的包才要
- [ ] **重启前确认没有进行中的对话** —— 中途重启会给用户留一条「异常中断」提示。
      查最近几分钟有没有新消息 / 活跃 runner
- [ ] `make launchd-restart`（不要 kill）
- [ ] 查迁移日志、行数守恒、渠道连接、新增 ERROR

### 上线后

- [ ] 每条渠道实际发一条消息
- [ ] 看 Web 界面（**截图对比，不要只看 API**）
- [ ] 盯 ERROR 计数增量，不是绝对值；区分新旧 pid，重启瞬间旧进程的报错是预期的
- [ ] 确认真有一轮 agent 完整跑通（收到消息 → 产出回复），不要只看「服务起来了」

---

## 十、相关文档

| 文档                                      | 内容                                     |
| ----------------------------------------- | ---------------------------------------- |
| `upstream-decision-ledger.md`             | 决策台账，代码注释里的「决策 N」指向这里 |
| `upstream-decision-tree.md`               | 冲突分类与判定树                         |
| `upstream-silent-changes.md`              | upstream 的静默行为变更                  |
| `merge-conflict-guide.md`                 | 逐文件的冲突处理记录                     |
| `merge-acceptance-test-matrix.md`         | 验收测试表，67 个用例                    |
| `design-provider-credential-lifecycle.md` | codex/grok 凭据的种子 + 自刷新 + 回写    |
