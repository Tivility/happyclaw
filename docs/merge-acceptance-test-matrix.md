# 合并验收测试表

覆盖 `upstream/main` 合并（阶段 2–6，六个提交）的验收。分三类：

- **A 类 · 自动化门禁** —— 每次改动都跑，已固化在 `make typecheck` / `make test`
- **B 类 · 沙箱实测** —— 需要真实凭据但不碰生产实例，用隔离沙箱 + 独立端口
- **C 类 · 生产实测** —— 需要真实 IM 群 / 真实凭据独占，只能在生产实例上做

## 环境

| 项 | 值 |
|---|---|
| 分支 | `happyclaw-merge` worktree（`/Users/tivility/happyclaw-merge`） |
| 沙箱端口 | 3399（生产实例仍在 3000，互不影响） |
| 沙箱凭据 | 复制生产的 `claude-provider.json` + codex/grok 的 auth seed；**不复制 `user-im/`** —— 同一份 IM 凭据双连会出现两个 bot 抢答 |
| 沙箱数据 | 独立 `data/`，管理员 `mergeverify` |
| 已配置 runtime | claude（OAuth）· codex（chatgpt_oauth）· grok（grok_oauth）三条全可用 |
| 已配置渠道 | feishu · discord · qq · wechat（telegram / dingtalk / whatsapp 未配置，无法测） |

---

## A 类 · 自动化门禁

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| A1 | `make typecheck`（后端 + 前端 + agent-runner） | 0 错误 | ✅ 0 错误 |
| A2 | 类型副本同步校验（`shared/` → 三处） | 一致 | ✅ 一致 |
| A3 | prompt 文件存在性校验 | 14 个全部解析 | ✅ 14 个全部解析 |
| A4 | 文档一致性校验（`check-docs.mjs`） | 通过 | ✅ 通过 |
| A5 | `make test` 全量 | 全过 | ✅ 330 文件 / 2777 测试全过 |
| A6 | `npm run build:all`（三项目） | 全部退出码 0 | ✅ 三项目退出码 0 |
| A7 | `npm run self-test:agent-runner` | 通过 | ✅ 通过 |
| A8 | `bash scripts/rotate-logs.sh --if-due` | 通过 | ✅ 通过 |
| A9 | 残留冲突标记扫描 | 0 处 | ✅ 0 处 |
| A10 | `git log HEAD..upstream/main` | 0 条（upstream 全合入） | ✅ 0 条 |

## B 类 · 沙箱实测

### B-1 启动与基础面

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B1.1 | 空库冷启动 | 无 FATAL / 无未捕获异常 | ✅ FATAL 0 |
| B1.2 | `GET /api/health` | 200 + `database:true` `queue:true` | ✅ 200 + 全 true |
| B1.3 | 未认证访问 `/api/config/system` | 401 | ✅ 401 |
| B1.4 | 未认证访问 `/api/groups` | 401 | ✅ 401 |
| B1.5 | 前端首页 | 200 | ✅ 200 |
| B1.6 | 首装向导 `/api/auth/status` | `initialized:false` | ✅ `initialized:false` |

### B-2 存量库迁移（阶段 2 最高风险）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B2.1 | 生产库副本 schema 45 → 63 | 不抛异常 | ✅ 不抛（修复前抛 `no such column`） |
| B2.2 | 迁移后行数（messages / groups / tasks / users / sessions / usage / chats） | 零丢行 | ✅ 七表零丢行，耗时 356ms |
| B2.3 | 三个补列存在（`provider_estimated_cost_usd` / `billed_cost_usd` / `event_id`） | 全部存在 | ✅ 三列全部补上 |
| B2.4 | v51 回填把 `cost_usd` 搬进 `provider_estimated_cost_usd` | 值一致 | ✅ 2.5 → 2.5 |
| B2.5 | 二次启动幂等 | 版本与行数不变 | ✅ 版本行数不变（78ms） |
| B2.6 | 迁移后读真实消息（飞书 / Web 会话各一） | 能读到，新列取值合理 | ✅ 飞书 2275 条 / Web 2137 条均可读，`delivery_status`·`source_kind` 取值合理 |
| B2.7 | 迁移后写用量 | 成功且只落一行（不双计） | ✅ 单行，不双计 |

### B-3 三条运行时实跑（阶段 3 核心）

每条都要真正 spawn 出进程、走完一轮、拿到回复。

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B3.1 | Claude 运行时回一轮 | 有回复文本 | ✅ 回 `pong`，claude-sonnet-5，$0.093 |
| B3.2 | Codex 运行时回一轮 | 有回复文本 | ✅ 回 `pong`，7.2s |
| B3.3 | Grok 运行时回一轮 | 有回复文本 | ✅ 回 `pong`，3.8s |
| B3.4 | 切换运行时（`/api/model`）后下一轮生效 | 实际 runtime 与绑定一致 | ✅ 新会话后生效（`runtime=grok` + 「Grok 正在处理...」） |
| B3.5 | 三条各自产生 `usage` 记录 | `usage_records` 有对应 runtime 行 | ✅ 三条各自入库，`runtime` 列有值（修复前全 NULL） |
| B3.6 | Codex/Grok 的 `inputTokens` 口径标记 | `inputTokensIncludeCacheRead` 落到用量元数据 | ✅ Codex/Grok 实跑事件里 `inputTokensIncludeCacheRead:true`，Claude 缺省 |
| B3.7 | 工具结果进执行轨迹（三条都有 `tool_use_end` 带结果） | 轨迹里能看到返回值 | ✅ Grok `run_terminal_command` 13B、Codex `Bash` 14B 都带结果 |
| B3.8 | 人格注入对 Codex/Grok 生效 | 回复体现人格约束 | ⏳ 未单独验（靠单测 + 代码核对） |
| B3.9 | 渠道上下文对 Codex/Grok 生效 | prompt 含来源信息 | ⏳ 未单独验（靠单测 + 代码核对） |

### B-4 定时任务与租约（阶段 4）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B4.1 | 创建定时任务（`once`，立即到期） | 创建成功 | ⏳ 未执行 |
| B4.2 | 任务被调度并执行 | 产生 `task_runs` 行 + 执行日志 | ⏳ 未执行 |
| B4.3 | 任务执行期间持有租约 | `listHeldTaskLeases()` 非空 | ⏳ 未执行 |
| B4.4 | 模拟崩溃（残留死进程租约）后重启 | 租约被回收，任务重新变 due | ✅ 单测覆盖（pid 存活判定） |
| B4.5 | 活进程租约不被误清 | 持有者不匹配时不释放 | ✅ 单测覆盖（持有者不匹配不释放） |
| B4.6 | 四个任务管理工具（list/pause/resume/cancel） | 各自生效 | ⏳ 仅核对 IPC 链路闭合 |

### B-5 软删除与回收（阶段 5）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B5.1 | 软删除任务 | 从活列表消失，出现在已删列表 | ⏳ 未执行 |
| B5.2 | `/restore` 恢复 | 回到活列表 | ⏳ 未执行 |
| B5.3 | 保留期内不被回收 | `getPurgeableTasks` 不含它 | ✅ 单测覆盖 |
| B5.4 | 超保留期后回收 | 任务行 + flow 工作区一并清除 | ⏳ 未执行 |
| B5.5 | 保留期设为 0 时不自动回收 | purge 不做事 | ✅ 默认 0，代码短路 |

### B-6 设置项与投影（阶段 5/6）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B6.1 | 读 `/api/config/system` 含 `deletedTaskRetentionDays` | 字段存在 | ✅ 字段存在 |
| B6.2 | 写入并回读 | 值一致 | ✅ 14 → 14 |
| B6.3 | 落盘 `system-settings.json` | 值一致 | ✅ 落盘一致 |
| B6.4 | 越界值（999 天） | 400 | ✅ 400 |

### B-7 构建与依赖契约（阶段 6）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| B7.1 | 全新克隆 `make install` | 成功（agent-runner 走 `install --no-package-lock`） | ✅ 改为 `install --no-package-lock` 后可用 |
| B7.2 | agent-runner 目录里 `npm ci` | 复现 EUSAGE（证明必须用 install） | ✅ 临时目录实测复现 EUSAGE |
| B7.3 | CI 不引用已删除的 lock | `ci.yml` 无 `agent-runner/package-lock.json` | ✅ 已移除 |

---

## C 类 · 生产实测（需独占凭据 / 真实 IM 群）

无法在沙箱做的原因写在「阻塞原因」列。

| # | 用例 | 期望 | 阻塞原因 |
|---|---|---|---|
| C1.1 | 飞书私聊收发 | 正常回复 | 凭据被生产实例占用，双连会两个 bot 抢答 |
| C1.2 | 飞书群聊 @机器人 | 仅被 @ 时响应 | 同上 + 需真实群 |
| C1.3 | 飞书流式卡片 | 增量更新、定稿带用量 | 同上 |
| C1.4 | 飞书卡片运行时文案（Codex/Grok） | 显示对应运行时口径 | 同上 |
| C1.5 | QQ 私聊 / 群聊 | 正常回复 | 同上 |
| C1.6 | Discord | 正常回复 + 流式编辑 | 同上 |
| C1.7 | 微信 | 正常回复 | 同上 |
| C1.8 | Telegram / 钉钉 / WhatsApp | — | **未配置凭据，无法测** |
| C2.1 | 多账号：同渠道加第二个账号 | 两个账号独立收发、互不影响 | 需第二套真实凭据 |
| C2.2 | 三个真实用户（admin + 2 member）互不串台 | 会话隔离 | 需生产数据 |
| C3.1 | 日志轮转真的转一个大文件 | 生成 `.1` 且原文件截断 | 需真实 launchd 托管 + 文件涨到阈值 |

---

## 执行记录

| 轮次 | 时间 | 范围 | 结论 |
|---|---|---|---|
| 1 | 2026-07-27 | A 类全部 + B1 + B6 | 通过；B6 暴露「新设置项没进 config 路由投影」 |
| 2 | 2026-07-27 | B2 存量库迁移 | **抓到 3 个 bug**：迁移崩溃 / 日汇总 RangeError / 用量双写 |
| 3 | 2026-07-27 | B3 三条运行时实跑 | **抓到 2 个 bug**：`runtime` 列全 NULL（4 处漏传 resolution）/ 用量幂等键失效每轮落两行 |
| 4 | 2026-07-27 | B7 构建契约 | **抓到 1 个 bug**：`npm ci` 打在无 lock 的 agent-runner 上 |

## 结论

- **A + B 类关键项全部通过**，过程中抓出 6 个真 bug，全部已修 + 补回归测试。
- **B3.8 / B3.9**（人格注入、渠道上下文对 Codex/Grok 生效）只有单测和代码核对，没有单独的端到端断言 —— 它们是 prompt 内容层面的，需要构造带人格的工作区才能验，留待需要时补。
- **B4 / B5 的执行类用例**（真跑定时任务、真删真恢复真回收）未执行，核心不变量已由单测覆盖。
- **C 类全部未执行**：IM 凭据被生产实例独占，沙箱双连会出现两个 bot 抢答；Telegram / 钉钉 / WhatsApp 根本没配凭据。这部分必须在生产实例上做。
