# 静默变更的防护设计

> 配套 `merge-conflict-guide.md`（逐块处置）· `merge-test-plan.md`（S1–S6 用例）
> 编制：2026-07-26

---

## 为什么单独一份

前两份文档对静默项的处理都是**「记得去确认」**的形式：合并时看清单、上线后手工核对。

这不够。静默项的定义就是「不看就发现不了」——而依赖人在 329 个冲突块里记得回头查 7 个特定的点，本身就是不可靠的。

**这份文档的目标：把每一个静默失败改造成响亮失败。** 让编译器、测试、启动检查替你记住。

设计原则：

| | |
|---|---|
| **优先编译期** | 能让 typecheck 拦下的，绝不留给运行时 |
| **其次启动期** | 拦不住的，在服务启动时断言，宁可起不来也不要带病运行 |
| **再次测试期** | 前两者都不行的，写成会失败的测试 |
| **最后才是人工** | 只有真正无法自动化的才进人工清单，且必须有签字位 |

---

## 一、七个静默杀手的防护设计

### S1 · provider 凭据被销毁

**静默原因**：本地和 upstream 都写 `version: 4`，schema 不同。upstream 的写盘函数用显式对象字面量重建，多出的字段和三个密钥被丢弃。7 个入口触发写盘。

**防护：编译期 + 启动期双保险**

```
① 编译期 —— 版本号做成字面量类型
   type ProviderFileVersion = 5;
   读取时 parsed.version === 5 才走本地解析器；
   遇到 4 → 走一次性升级函数，绝不让 upstream 的 v4 分支接管

② 启动期 —— 断言密钥完整性
   服务启动时对每个 runtime !== 'claude' 的 provider 检查：
     authMode 是 chatgpt_oauth  → secrets.codexAuthJson 必须非空
     authMode 是 grok_oauth     → secrets.grokAuthJson 必须非空
   不满足 → 启动失败并打印「provider {id} 的凭据缺失，可能被 v4 写盘覆盖，
            请从 data/config/backups/ 恢复」
```

第二条是关键：即使第一条被绕过，任何一次错误写盘都会在**下次启动时立刻暴露**，而不是等到你去用 codex 才发现。

**残余人工项**：无。

---

### S2 · 用量成本列被写错

**静默原因**：upstream 的用量服务不读 runner 报的成本，用只含 Claude 型号的价格表重算，匹配不上落 Sonnet 兜底。

> 注：配额口径已决定不动（计费不开）。这里只防「成本列写错数据」。

**防护：编译期**

```
在计价函数入口要求传 runtime，且做成必填参数：
   priceUsage(model: string, usage: Usage, runtime: AgentRuntime)

函数体第一行：
   if (runtime !== 'claude') return { costUSD: 0, costStatus: 'unavailable',
                                       costSource: 'subscription' };
```

必填参数意味着**所有调用点不传就编译不过**。不用担心漏掉某条路径。

**再加一道测试期断言**：价格表匹配失败时不再落 Sonnet 兜底，而是返回 `undefined` + `costStatus: 'unavailable'`。配一个测试：喂一个 `grok-build`，断言结果是 `unavailable` 而不是某个美元数。

---

### S3 · codex/grok 重试轮的流事件被围栏丢弃

**静默原因**：围栏用 `queryRunId` 精确匹配，codex/grok 不产出该字段，退回按 `turnId` 匹配；单轮重启模型重试时 turnId 相同 runId 不同 → 判定「这个 turn 属于别的 run」→ 整轮丢弃，无日志。

**防护：编译期 + 可观测性**

```
① 编译期 —— queryRunId 在事件发射处做成必填
   emitStreamEvent 的入参类型要求 queryRunId: string
   → runOneTurnRuntime 不传就编译不过

② 可观测性 —— 围栏丢弃时必须打日志
   现在 accepted: false 是静默 return。改成 logger.warn，
   带上 jid / turnId / knownOwner / activeRunId 四个字段
```

第二条即使第一条失效也能让问题在日志里可见 —— 「转圈不出字」至少有迹可循。

---

### S4 · 容器挂载函数的位置参数错配

**静默原因**：第 8 个位置参数本地是模型覆盖、upstream 是通信标识，**两个都是字符串**，TS 兜不住。

**防护：编译期（改掉参数形态）**

```
buildVolumeMounts(opts: {
  group: RegisteredGroup;
  isAdminHome: boolean;
  resolvedProvider?: UnifiedProvider;
  modelOverride?: string | null;
  ipcAgentId?: string;
  agentProfile?: RunnerAgentProfile;
  codexAuthMaterial?: CodexProviderAuthMaterial;
  grokAuthMaterial?: GrokProviderAuthMaterial;
})
```

改成命名参数后，**传错就是字段名不存在，编译期报错**。这是把一个类型系统的盲区直接消除掉，比任何检查都可靠。

---

### S5 · docker 路径的凭据挂载丢失

**静默原因**：本地的原生 CLI 环境变量分流和两个可写挂载，落在 upstream 改了 1117 行的那段里。取 upstream 那侧 → 容器拿到一堆 Anthropic 变量、没有自己的凭据目录 → 认证失败。而 host 路径不经过这段 → **非对称**。

**防护：编译期 + 测试期**

```
① 编译期 —— 挂载构建的返回值做成判别联合
   type ContainerEnvPlan =
     | { kind: 'claude'; envLines: string[] }
     | { kind: 'native'; runtime: 'codex' | 'grok';
         envLines: string[]; homeMount: VolumeMount };

   native 分支强制要求 homeMount 存在 → 漏了就编译不过

② 测试期 —— 双路径对称性测试
   同一个 codex 工作区，分别构造 host 和 docker 的启动参数，
   断言两者的 CODEX_HOME 都指向有效路径、都不含 ANTHROPIC_BASE_URL
```

第二条直接把 CLAUDE.md §8.14 那条「两条 spawn 路径必须对称」的约束变成可执行的测试。

---

### S6 · 三处前端功能静默消失

**静默原因**：取 upstream 侧零报错但东西没了。模型切换下拉最危险 —— import 和挂载点在同一个大冲突块里，删掉完全无声。

**防护：测试期（渲染断言）**

```
写三个最小渲染测试：
  ChatView 渲染后，DOM 里必须存在模型切换下拉的测试 id
  MessageBubble 渲染一条 agent 消息后，必须存在执行轨迹面板的入口
  SettingsNav 渲染后，导航项里必须包含「模型」「GPT」「Grok」三个 key

任一缺失 → 测试失败
```

这三个测试很短，但它们把「合并时记得看一眼界面」变成了「不看也会红」。

**PWA 附带**：加一个断言 `vite.config.ts` 里含 PWA 插件的配置。它不在冲突列表里，会静默消失。

---

### S7 · 工作区投影被 upstream 的规则覆盖（新增）

**静默原因**：`DELETE FROM workspaces WHERE …web:%` 落在冲突区**之外**，合并时没有任何标记。而我们决定按 folder 投影 36 行，upstream 按前缀留 35 行 —— 两个重建函数互相拆台。

**防护：启动期断言**

```
一致性校验函数改成硬断言：
  workspaces 的行数必须等于 registered_groups 的 distinct folder 数
  不等 → 启动时 logger.error + 拒绝启动
        （或者至少：拒绝服务消息，只允许管理接口）

配一个迁移断言：阶段 2 之后 workspaces 必须是 36 行
```

现在这个校验函数只是打日志。改成硬断言之后，upstream 的规则一旦生效就会立刻撞上。

---

## 二、静默删除的防护

51 个文件 + 20 个导出符号会被 git 干净删除。已决定保住的那些，靠什么防？

### 2.1 编译期天然保护（不用额外做）

只要有代码在 import 它，删了就编译不过。这类包括：`runtime-owner.ts` 的三个函数 · 微信代理绕过的两个函数 · 三个提示词文件的符号 · agent-runner 的四个 npm 依赖。

**这类不用管** —— typecheck 会拦。

### 2.2 需要额外防护的（无人引用但要保）

| 要保的 | 为什么没有编译期保护 | 防护 |
|---|---|---|
| PWA 配置 | 配置文件，没人 import | 加断言测试（见 S6） |
| 预定义 SubAgent | 已决定转成定义文件，不是保代码 | 转文件后加断言：`.claude/agents/` 下必须有 `web-researcher.md` |
| 执行轨迹面板 | 挂载点在冲突区 | 渲染测试（见 S6） |
| 容器挂载策略表（文档） | 文档 | 文档检查脚本会验路径存在 |

### 2.3 已决定放行的（不用防）

`group_members` 六个函数 · 自定义 SubAgent 页面与路由 · 关闭记忆层开关 · 隐私模式相关。**这些是有意删的**，编译错误出现时直接删调用点即可。

---

## 三、静默行为反转的防护

这类最难 —— 代码编译过、测试也过，但行为变了。

| 反转项 | 防护 |
|---|---|
| 定时任务默认上下文 `group` → `isolated` | 断言测试：不传 `context_mode` 建任务，结果必须是 `group` |
| 暂停任务可手动触发 | 断言测试：对 `paused` 任务调触发，必须被拒 |
| 首屏主题默认 | 断言测试：localStorage 无 key 时 `readTheme()` 返回 `'system'` |
| 流式卡片上限 30000 | 已决定跟 upstream，不用防 |
| 消息轮询的投递状态过滤 | 断言测试：`getNewMessages` 对本地值域的行不过滤 |
| 会话有效性判定不含引擎 | 断言测试：只改模型时 `evaluateSessionValidity` 不返回 discard |
| 最后一个 provider 的保护 | 已决定跟 upstream 全局判断，不用防 |

每条一个测试，都很短。**共约 6 个断言测试**，换来这一整类反转不会悄悄发生。

---

## 四、汇总：新增的防护代码量

| 类型 | 数量 | 规模 |
|---|---|---|
| 编译期改造（类型收紧 / 参数具名化 / 必填参数） | 5 处 | 约 80 行 |
| 启动期断言 | 2 处 | 约 40 行 |
| 断言测试 | 约 15 个 | 约 300 行 |
| 日志补强 | 1 处 | 约 5 行 |
| **合计** | | **约 425 行** |

换来的是：**7 个静默杀手里 5 个变成编译期或启动期失败，2 个变成测试失败。人工清单从 7 项降到 0 项。**

---

## 五、执行时机

| 防护 | 什么时候加 |
|---|---|
| S1 版本号字面量类型 | **阶段 0.2**，在推版本号的同时 |
| S4 参数具名化 | **阶段 2 解冲突时**，就在那个文件里 |
| S2 / S3 编译期约束 | 阶段 2 解冲突时 |
| S5 判别联合 | 阶段 2 解冲突时 |
| S1 启动断言 · S7 一致性断言 | 阶段 2 完成后、上线前 |
| 全部断言测试 | 阶段 2 完成后，作为阶段 2 的退出条件 |

**关键**：编译期的那几项要在**解冲突的过程中**加，不能等合并完了再回头改 —— 那时候已经错过了它们本该拦住的东西。
