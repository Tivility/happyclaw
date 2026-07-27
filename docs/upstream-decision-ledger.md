# upstream 提交决策台账

> 生成时间：2026-07-25 · 基线 `upstream/main`

## 为什么需要这份台账

GitHub 显示本 fork「121 commits behind」，而 `git cherry` 判定**零个**
已应用——连本次 cherry-pick 过的 8 个也没被认出来。原因是 patch-id 依赖
上下文行，两边基线早已分叉，同一改动落在不同上下文就不构成等价补丁。

所以 git 无从知道哪些 upstream 提交已被吸收。没有这份台账，下次做合并的人
会面对 107 个无差别的提交，既分不清「已采纳」「已重写」「明确不要」，也认不出
「还没看过」——这正是重复劳动与误判的来源。

## 现状

| 状态 | 数量 | 含义 |
|---|---|---|
| ✅ 已采纳 | 8 | cherry-pick 进来，内容等价 |
| 🔄 已重写 | 1 | 意图采纳，按本地架构重新实现 |
| ❌ 不采纳 | 6 | 经决策明确不要，理由见行内 |
| ⏸ 暂缓 | 4 | 有条件采纳，待触发条件 |
| ⬜ 未评估 | 88 | 本次未逐条审查 |

**「未评估」不等于「不要」**——本次分析是按主题而非逐条做的，那些提交多数
落在已决策的主题内（如飞书流式质量、Docker 构建、前端观感），只是没有一一对照。
下次合并应从这一栏开始。

## 明细

| commit | 标题 | 状态 | 说明 |
|---|---|---|---|
| `c1ee516` | 优化: 提示词去冗余 + host ~/.claude 桥接可观测增强 | ⬜ 未评估 |  |
| `1d02716` | 修复: Windows 宿主机模式找不到 claude CLI 导致 Agent 无响应 (#571) | ❌ 不采纳 | macOS 部署零收益，且与 container-runner 的 Grok 注入分支纠缠 |
| `0a08fd9` | 改进: resolveBundledClaudeCli 增加 stub 体积甄别 (#571) | ⬜ 未评估 |  |
| `fbb37b1` | 修复: claude bundled 解析门控到 win32，避免改 Linux/macOS 既有行为 (#576) | ⬜ 未评估 |  |
| `2408d73` | 修复: Windows host 模式路径兼容三处(PROMPTS_DIR/PATH分隔符/~展开) (#570) | ❌ 不采纳 | macOS 部署零收益，且与 container-runner 的 Grok 注入分支纠缠 |
| `9262274` | 修复: better-sqlite3 ^11.8.1→^12.10.0 兼容 Node 26 原生编译 (#578) | ✅ 已采纳 | cherry-pick，批次 1 |
| `3371b95` | 修复: 后端 server-side fetch 走系统代理,解决官方 OAuth 交换大陆 IP 被 403 | ⬜ 未评估 |  |
| `e49b55a` | 改进: load-env 代理守卫去掉 ALL_PROXY + 日志脱敏 (#569 review) | ⬜ 未评估 |  |
| `7caa820` | 新增: Dockerfile 内置 Headroom (token 压缩工具, 默认不启用) | ⬜ 未评估 |  |
| `aa06057` | 改进: headroom-ai pin 到 ~=0.27.0 (#575 review) | ⬜ 未评估 |  |
| `eabc1f3` | 改进: 飞书 IM 配置加 appId 格式校验 + 保存前连通性测试 | ✅ 已采纳 | cherry-pick，批次 1 |
| `c4ad5c0` | 修复: 定时任务时区——给 agent 注入带时区的当前时间 + list_tasks 本地展示 (#563) | ✅ 已采纳 | cherry-pick，批次 4 |
| `065e874` | 修复: 定时任务创建/取消改阻塞确认 + 新增 update_task + 幂等去重 (#560) | ✅ 已采纳 | cherry-pick，批次 4 |
| `ec62d7c` | 修复: 定时任务触发加框定,堵住递归增殖 (#564) | ✅ 已采纳 | cherry-pick，批次 4 |
| `ae42183` | 修复: 定时任务三 commit 的对抗审查发现(CR) | ✅ 已采纳 | cherry-pick，批次 4 |
| `d8c76c8` | test: cover IPC send retry dedup | ⬜ 未评估 |  |
| `072e608` | 修复: 大文件上传/下载易失败(超时误杀 + 50MB 上限写死) | ✅ 已采纳 | cherry-pick，批次 1 |
| `cf23dd2` | 修复: Makefile 的 sed 命令在 Linux 上失效 | ⬜ 未评估 |  |
| `d9d0548` | 改进: agent-runner 缺模型配置时 fail-fast 而非兜底 opus | ⬜ 未评估 |  |
| `fa15f76` | 功能: 聊天窗口支持拖拽上传图片/文件/文件夹 | ⬜ 未评估 |  |
| `0cc9993` | 修复: 后台任务被过早关流杀死、resume 重放误判、usage 重复计费 | 🔄 已重写 | F1 挂流机制按本地三运行时架构重写 |
| `c1b6351` | 修复: 拖拽上传目录读取 hang、跨浏览器丢文件、大图静默跳过 | ⬜ 未评估 |  |
| `c4fb789` | 修复: 上游断流截断的回复自动续写（零 usage 指纹检测） | ⏸ 暂缓 | C-2d 暂缓——收益推测性，多运行时 usage 口径不同易误判 |
| `5f04246` | 功能: 流式卡片挂起完成——后台任务结束前不定稿、内容同卡追加 | ❌ 不采纳 | 与 F2 决策冲突——过程放挂起卡、结果发新消息 |
| `81f0b5a` | 修复: 挂起序列全渠道合并为一条回复（Web 不再分段） | ❌ 不采纳 | 与 F2 决策冲突——过程放挂起卡、结果发新消息 |
| `453eed3` | 修复: 定稿回复剔除工具调用间的过程旁白，只保留最终结果 | ❌ 不采纳 | B 决策保留本地全量拼接 + 折叠面板 |
| `3040523` | 功能: Web 默认浅色主题，不再跟随系统深色模式 | ⬜ 未评估 |  |
| `9d92f15` | Implement agent-first workspace architecture | ⬜ 未评估 |  |
| `6958ded` | Show all IM channels in binding UI | ⬜ 未评估 |  |
| `7f0d2f8` | Improve workspace channel binding entry points | ⬜ 未评估 |  |
| `5bf3d16` | Refine scheduled task workspace execution | ⬜ 未评估 |  |
| `62b3441` | agent-runner: guard stale background task summaries | ⬜ 未评估 |  |
| `3a0b988` | agent-runner: support sdk interrupt receipts | ⬜ 未评估 |  |
| `ccf94e4` | agent-first: harden workspace runtime architecture | ⬜ 未评估 |  |
| `b9756d1` | agent-first: align workspace ownership and agent capabilities | ⬜ 未评估 |  |
| `a8a6d94` | agent-first: streamline settings and agent identity | ⬜ 未评估 |  |
| `2902130` | feat: refine agent capabilities and workspace runtime | ⬜ 未评估 |  |
| `8a3cade` | fix: harden skill imports and merge gates | ⬜ 未评估 |  |
| `54572cb` | ci: pin prettier for deterministic checks | ⬜ 未评估 |  |
| `de48adb` | feat: 完成 Agent 优先架构与合并质量加固 | ⬜ 未评估 |  |
| `db0b6e3` | fix: harden portable runtime backup restore | ⬜ 未评估 |  |
| `0e6fff5` | 修复: 官方 Claude(OAuth) provider 未配置模型时被误报无法使用 | ⬜ 未评估 |  |
| `76a93fa` | fix: harden agent workflows and refine settings UI | ⬜ 未评估 |  |
| `2dbb553` | feat: harden scheduled task execution and recovery | ⬜ 未评估 |  |
| `8f0262f` | docs: rewrite README for current architecture | ⬜ 未评估 |  |
| `f06c5f1` | fix(provider): support official default models safely | ⬜ 未评估 |  |
| `596da2a` | 修复: 切换 provider 模型后 agent 子进程仍使用旧模型 | ⬜ 未评估 |  |
| `bc14d41` | 修复: 注释更正 descendant 包含 agent 和 task 子进程 | ⬜ 未评估 |  |
| `b0c6c90` | 格式: prettier 修正 db.ts 行宽 | ⬜ 未评估 |  |
| `010aea3` | Improve follow-up steering and usage accounting | ⬜ 未评估 |  |
| `c24be78` | feat: add conversational agent builder | ⏸ 暂缓 | 批次 5 只落地数据层与注入；builder 子系统待议 |
| `e57c606` | fix: keep runtime context diagnostics internal | ⬜ 未评估 |  |
| `072079b` | feat: enable agent builder across main agent sessions | ⏸ 暂缓 | 批次 5 只落地数据层与注入；builder 子系统待议 |
| `a5937b6` | 修复: Markdown 图片中文文件名无法加载 | ⬜ 未评估 |  |
| `6e43464` | 格式: prettier 修正 MarkdownRenderer.tsx | ⬜ 未评估 |  |
| `d18795c` | feat: improve agent runtime governance and workflow UX | ⬜ 未评估 |  |
| `537d596` | fix: make WeChat connections resilient and observable | ⬜ 未评估 |  |
| `5fd2b5f` | feat: govern host skills per agent | ⬜ 未评估 |  |
| `dfa53ff` | fix: isolate managed agents from host memory | ⬜ 未评估 |  |
| `0fbf142` | fix: isolate managed agents from project memory | ⬜ 未评估 |  |
| `015ee18` | fix: anchor agent profiles for custom providers | ⏸ 暂缓 | 批次 5 只落地数据层与注入；builder 子系统待议 |
| `631e465` | fix: robustly decode markdown image paths | ✅ 已采纳 | cherry-pick，批次 1 |
| `4333b1c` | fix: apply provider changes without dropping queued work | ⬜ 未评估 |  |
| `17d6b6b` | fix: fail closed on partial provider apply | ⬜ 未评估 |  |
| `674955e` | fix: make provider recovery idempotent | ⬜ 未评估 |  |
| `60addd3` | fix: recover pending provider removal | ⬜ 未评估 |  |
| `4165b86` | fix: isolate runtime safety block owners | ⬜ 未评估 |  |
| `a034541` | fix workspace IM discovery and binding consistency | ⬜ 未评估 |  |
| `e59f4c8` | 功能: 撞账号额度墙自动切换到回退模型（同一轮无缝重跑） | ⬜ 未评估 |  |
| `b2cc72f` | fix(runtime): make model fallback turn-safe | ⬜ 未评估 |  |
| `c848ab4` | Improve channel routing and Agent config inheritance | ⬜ 未评估 |  |
| `76d2109` | feat: enhance agent creation and Feishu capabilities | ⬜ 未评估 |  |
| `bcbb66b` | fix: route agent files to Feishu topics | ⬜ 未评估 |  |
| `2b74473` | fix: accept Feishu upload acknowledgements | ⬜ 未评估 |  |
| `68c1d5c` | fix: allow concurrent host sessions | ⬜ 未评估 |  |
| `7ede8c1` | fix: preserve Feishu audience mode across restarts | ⬜ 未评估 |  |
| `a858ba3` | fix: preserve channel policies across binding flows | ⬜ 未评估 |  |
| `76e6ed9` | feat: harden channel sessions and delivery reliability | ⬜ 未评估 |  |
| `2f81229` | fix: expose home channel bindings | ⬜ 未评估 |  |
| `dd987a8` | fix: separate workspace and session channel bindings | ⬜ 未评估 |  |
| `ba5aa71` | 修复: 识别带限定词的 Claude session limit 横幅并摘除撞墙账号 | ⬜ 未评估 |  |
| `406724c` | 修复: 官方账号模型下拉框缺少 opus 和 fable 选项 | ⬜ 未评估 |  |
| `652000f` | chore: align docs and remove unused assets | ⬜ 未评估 |  |
| `64fc77a` | fix: make Feishu streaming output turn-safe | ⬜ 未评估 |  |
| `e7677b9` | fix(provider): address rate-limit review findings | ⬜ 未评估 |  |
| `1093dd9` | fix(settings): address official model review findings | ⬜ 未评估 |  |
| `9a4998a` | feat(settings): add Fable official model option | ⬜ 未评估 |  |
| `d81950e` | feat: automate channel cleanup on workspace deletion | ⬜ 未评估 |  |
| `500825c` | fix: retire stale PWA cache lifecycle | ⬜ 未评估 |  |
| `09493d7` | feat: add workspace interaction modes | ⬜ 未评估 |  |
| `26ae950` | fix: migrate interaction mode before workspace backfill | ⬜ 未评估 |  |
| `b0e2fdb` | fix: surface provider failures without stuck turns | ⬜ 未评估 |  |
| `a55de01` | fix: align proactive agents with native messaging | ⬜ 未评估 |  |
| `329620e` | fix: harden proactive turn lifecycle | ⬜ 未评估 |  |
| `9306251` | fix: harden proactive message delivery lifecycle | ⬜ 未评估 |  |
| `0272e15` | feat: allow web sessions alongside native topics | ⬜ 未评估 |  |
| `57766e4` | fix: refine hybrid session navigation | ⬜ 未评估 |  |
| `1455c7e` | fix: close scheduled-task ACL bypass and lease settlement loss | ❌ 不采纳 | 任务执行保留本地——承载脚本任务/IM 回投/逾期窗口 |
| `15b5c4c` | fix: bound and close the per-turn output window | ⬜ 未评估 |  |
| `3d826d5` | fix: bind scheduled tasks and Feishu routes to a concrete delivery target | ⬜ 未评估 |  |
| `1ecc6fc` | fix: deliver scheduled-task notices to their recorded binding | ⬜ 未评估 |  |
| `15abaad` | fix: add scheduling capacity fuses and align the proactive tool contract | ⬜ 未评估 |  |
| `540f29a` | fix: expose new system settings through the config API | ⬜ 未评估 |  |
| `a224e1c` | fix: close the reply fuse, prompt cap and uncertain-outbox gaps | ⬜ 未评估 |  |
| `8a4bd82` | fix: restore prompt rules lost in the variant split and close the guard | ⬜ 未评估 |  |
| `60e1145` | fix: bound indicator/typing state and restore queued + orphan cleanup | ⬜ 未评估 |  |
| `aaf3201` | fix: harden scheduled task capacity and routing | ⬜ 未评估 |  |

## 执行期补录的决策

### D4.10a · F1 洞 2（首条 result 不当终稿）的落点 —— 定为「分两步」

决策树里这是开放项，执行阶段 1.2 时定：**洞 ①③④（电平信号 / 完成债 /
`resultReceivedAt` 清零导致的挂死）在阶段 1 做完，洞 ②（首条 result 不当终稿）
推到阶段 2 合并 `feishu-streaming-card.ts` 时一次做。**

理由：洞 ② 要同时动 `ContainerOutput` 契约 + `agent-output-parser` + 前端定稿
逻辑 + 飞书卡片渲染，而 `feishu-streaming-card.ts` 在阶段 2 有 34 个冲突块。
现在改等于先写一版、合并时再跟 upstream 的改动对账一遍同一片代码 —— 工作量翻倍
且平添冲突。代价是「双终稿」现象保留到阶段 2。

洞 ①③④ 已落地并锁进测试（`tests/pending-sdk-tasks.test.ts`，24 例）。

## 维护约定

- 采纳一个 upstream 提交后，在此标 ✅ 并注明批次
- 明确不要的标 ❌ 并写**理由**——理由比结论更值钱，将来判断是否该翻案靠它
- **不要用 `git merge -s ours` 抹掉 behind 计数**：那会告诉 git「upstream 的
  内容我们都有了」，此后任何真实合并都会跳过这 121 个，包括那 90 多个从未采纳的。
  想拿其中任何一个时，git 会说你已经有了
