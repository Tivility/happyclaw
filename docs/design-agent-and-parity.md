# 设计：Agent-first 核心 与 运行时对齐八项

> 基线：本地 `main` = `aeeabbe` · `upstream/main` = `dba1e41` · merge-base = `39e651e`
> 上游依据：`docs/upstream-merge-plan.md`（93 条决策台账）· `docs/design-merge-internals.md`（已有六项设计，本文不重复）
> 本文只做**设计**：数据结构 / 函数签名 / 数据流 / 失败模式 / 验证方式。分析结论一律引用台账，不重述。
> 编制：2026-07-26

## 索引

| 节 | 内容 | 对应决策 | 落在哪个阶段 |
|---|---|---|---|
| 一 | Agent-first 核心 2400 行的具体构成 | 决策 56 / 57，接口到 27 / 28 | 阶段 2 后半（合并主体内的功能子系统） |
| 二 | 运行时对齐八项的可实施设计 | 决策 26 / 27 / 28 / 29 / 30 / 31 / 32 / 33 | 阶段 3 |

**与 `design-merge-internals.md` 的分工**：那份文档写的是六项**基础设施**设计（多账号、绑定解析、工作区投影、宿主机并发闸、会话表权威派生、用量分口径）。本文写的是**功能子系统**。两者的交叉点只有两处，都在本文里显式标注：

- 第一节 1.5 的 `workspace_agent_profiles` 与 `design-merge-internals.md` 设计 3（工作区投影按 folder）共用同一个 folder→jid 规范映射函数。
- 第二节 2.1 的主动模式依赖 `design-merge-internals.md` 设计 5（会话表权威 + 派生）已完成，否则 proactive 回合的会话归属会写进两张表。

---

# 第一节 · Agent-first 核心 2400 行的具体构成

## 1.0 起点不是零：先认清本地已有什么

**这一节最重要的前提**：本地不是从空白吸收 upstream，批次 5（`654b678`「功能: Agent 人格体系落地，三运行时统一注入」）已经搬过一轮。逐项核对后的实际状态：

| 能力 | 本地现状 | 证据 |
|---|---|---|
| 四张表 DDL | **已有**，`src/db.ts:934-1007`（schema 41→42） | `agent_profiles` / `agent_profile_prompt_versions` / `agent_builder_drafts` / `workspace_agent_profiles` 四张全建 |
| `sessions` 身份指纹三列 | **已有** | `agent_profile_id` / `identity_hash` / `agent_profile_version` |
| 四段人格的读写 | **部分**：`createAgentProfile` / `updateAgentProfilePrompts` / `archiveAgentProfile` / `getWorkspaceAgentProfile` / `setWorkspaceAgentProfile` / `clearWorkspaceAgentProfile` / `listAgentProfiles` / `getAgentProfile` / `computeAgentIdentityHash` / `hasSessionAgentProfileMismatch`（`src/db.ts:8388-8690`） | 9 个导出函数 |
| 人格渲染 | **已有**，`container/agent-runner/src/agent-persona.ts`（69 行，`buildPersonaBlock` / `personaPromptMode` / `describePersona`） | 但只有 Claude 分支调用，见第二节 2.7 |
| 人格进 ContainerInput | **已有**，`resolveAgentProfileForInput()`（`src/container-runner.ts:696-733`），两条 spawn 路径各调一次（1360 / 2247） | 派生新 input，不原地 mutate |
| **HTTP API** | **完全没有**。`src/routes/` 下无 `agent-profiles.ts` | — |
| **前端** | **完全没有**。`web/src/pages/` 无 `AgentProfilesPage`，`web/src/stores/` 无 `agent-profiles.ts` | — |
| **`runtime_policy`** | **死列**。表里有 `runtime_policy TEXT NOT NULL DEFAULT '{}'`，`mapAgentProfile()` 把它读成裸 `string`，**全仓零个解析点、零个消费点** | `grep -rn "runtimePolicy\|runtime_policy" src/ web/src/ container/` 只有 4 处命中：DDL 一处、类型声明一处、row 映射一处、INSERT 列名一处 |
| **授权 Skill / MCP** | **完全没有**。Skill 是全量挂载（`/workspace/project-skills` + `/workspace/user-skills` 只读卷，`src/container-runner.ts:884-897`），MCP 是 `loadUserMcpServers(ownerId)` 全量写进 settings.json（`src/container-runner.ts:848`） | — |
| `interaction_mode` 列 | **没有**。本地 `workspace_agent_profiles` 只有 4 列，upstream 有 5 列 | 决策 49 要补 |

**结论**：决策 56 的「核心四件事」里，「建 Agent」和「编辑四段人格」在数据层已就位、缺 API 和界面；「授权 Skill 与 MCP」**一行都没有**；「挂到工作区」有 DB 函数、缺 API。

所以这 2400 行不是"移植 upstream 的 2400 行"，而是"补齐本地缺的这 2400 行"，其中相当一部分是 upstream 代码的裁剪版，另一部分（精简页面）是新写的。

---

## 1.1 后端保留清单

### 1.1.1 直接吸收 / 裁剪吸收的模块

| upstream 路径 | 行数 | 处置 | 裁剪掉什么 | 落地约 |
|---|---:|---|---|---:|
| `src/agent-profile-prompts.ts` | 91 | **裁剪** | 删 `buildAgentProfilePrompt()`（本地已有 `agent-persona.ts:buildPersonaBlock` 做同一件事，两份渲染器必然漂移，且本地那份是 runtime-neutral 的、更符合 fork 目标）；删 `promptModeFromLegacyPreset()` / `includeClaudePresetForMode()` / `agentProfilePromptsFromLegacy()`（都是 upstream v48 前单段 `identity_prompt` 的迁移垫片，本地 42 版建表时就是四段，没有存量） | 45 |
| `src/agent-profile-policy.ts` | 134 | **全留** | 无。这是 Skill/MCP 授权校验的全部内容：`resolveHostSkillPolicy` / `requestsHostClaudeContext` / `isUnauthorizedHostClaudeContext` / `requestsHostSkills` / `isUnauthorizedHostSkills` / `hasEmptyCustomHostSkillSelection` / `validateRuntimePolicyReferences` / `hasInvalidRuntimePolicyReferences` | 134 |
| `src/agent-profile-runtime.ts` | 343 | **裁剪** | 保 `resolveEffectiveAgentProfile()`（运行时重算权限，角色降级立即生效——这是安全语义，不能省）、`listWorkspaceGroupsForAgentProfile()`、`getWorkspaceRuntimeJids()`、`withAgentProfileLocks()` + `acquireAgentProfileLock()`。**删** `quiesceWorkspaceRunnersAroundCommit()` / `WorkspaceRuntimeQuiesceError` / `collectWorkspaceRuntimeJids()` / `forceStopRuntimeJids()`——见 1.1.3 | 155 |
| `src/effective-mcp-manifest.ts` | 95 | **全留** | 无。95 行里 `buildEffectiveMcpManifest()` 是 MCP 白名单的 hash 出口（第二节 2.8 要用它做 ContainerInput 的 manifest），`loadPluginMcpDefinitions()` 在 `mcp.mode==='inherit'` 时补上 plugin 自带的 MCP，两者都在运行路径上，不是只服务预览面板 | 95 |
| `src/capability-lock.ts` | 60 | **全留** | 无。`withCapabilityScopeLocks(['system', 'user:{id}'], fn)` 是「改策略」与「改能力」互斥的唯一手段；没有它，用户一边删 Skill 一边保存引用该 Skill 的策略会写出一个引用不存在资源的档案 | 60 |
| `src/capability-runtime-mutation.ts` | 200 | **裁剪重写** | 保 `CapabilityMutationImpact` 类型、`profileUsesCapability()`、`listCapabilityMutationRuntimeTargets()`（这三段是「哪些工作区受这次能力变更影响」的判定，无替代）。**删** `mutateCapabilityAroundRuntimeQuiesce()` / `repairCapabilityRuntimeSafetyBlock()` / `CapabilityRuntimeCommitError`，换成 1.1.3 的轻量版 | 75 |
| `src/routes/agent-profiles.ts` | 831 | **裁剪** | 见 1.3 | 300 |
| `src/mcp-context.ts` | 89 | **全留** | 无。见 1.2.2 | 89 |

小计：**953 行**。

### 1.1.2 明确不吸收的模块

| upstream 路径 | 行数 | 为什么不要 |
|---|---:|---|
| `src/agent-builder.ts` | 580 | 决策 57：对话式 Builder 砍 |
| `src/agent-builder-turn-auth.ts` | 355 | 决策 57：防 Agent 自我提权，威胁模型是"多租户不可信用户"，本地三个用户全是熟人 |
| `src/agent-profile-generator.ts` | 265 | 决策 56：AI 辅助生成人格砍。它还硬依赖 `sdk-query` 风格的额外 Claude 调用，非 Claude 运行时下是空洞 |
| `src/agent-capability-preview.ts` | 364 | 决策 56：有效能力预览面板砍 |
| `src/run-context-snapshot.ts` | 239 | 决策 56：与最近运行对比砍。注意它还被 `src/web.ts` import，合并时要一并摘掉那个引用点 |
| `container/agent-runner/prompts/agent-builder.md` | — | 随 Builder 一起 |
| upstream 7 个 `agent_profile_*` MCP 工具 + `agent_capability_catalog` | — | 决策 24 名义上"吸收"，但它们的 handler 全部落在 `agent-builder.ts` 上；Builder 砍了之后这 8 个工具没有后端。**本节的处置：一并不吸收**，并在决策台账 24 上标注这一冲突（决策 24 与 57 互斥，57 优先） |

合计砍掉 **1803 行后端** + 前端（见 1.4）。

### 1.1.3 被裁掉的 quiesce 一族，用什么替代

upstream 的 `quiesceWorkspaceRunnersAroundCommit()` 解决的是一个真问题：**改人格/改策略时，正在跑的 runner 还持着旧策略**。但它的实现依赖一整套本地 `GroupQueue` 没有的 API：

```
deps.queue.pauseGroupsForMutation(jids) -> token     ← 本地无
deps.queue.resumeGroupsAfterMutation(token)          ← 本地无
deps.queue.blockGroupsForRuntimeSafety(jids, reason) ← 本地无
deps.queue.unblockGroupsForRuntimeSafety(jids)       ← 本地无
deps.queue.isGroupRuntimeSafetyBlocked(jid)          ← 本地无
deps.queue.stopGroup(jid, { force, preserveQueuedWork }) ← 本地只有 { force }（src/group-queue.ts:965）
```

补齐这六个是一个独立的 `GroupQueue` 改造，规模与本节相当，且会踩进决策 73（宿主机并发闸）正在改的同一段代码。

**替代设计**：策略变更走「停 + 失效会话」，不走「暂停 + 提交 + 再停」。

```ts
// src/capability-runtime-mutation.ts（裁剪版）
export interface CapabilityMutationImpact { /* 原样保留 */ }

/**
 * 提交能力/人格变更，然后停掉所有可能持有旧策略的 runner 并作废其 SDK 会话。
 *
 * 与 upstream 的两遍 quiesce 相比，这里接受一个更小的窗口：commit 与 stop 之间
 * 若恰好有新 runner 起来，它会带着新策略启动（因为 commit 已落库），只有 commit
 * *之前* 起来的 runner 才需要停。真正的 TOCTOU 缺口只剩「commit 与 listTargets
 * 之间新建工作区」，那需要一次工作区发布，不是消息驱动路径。
 */
export async function commitThenInvalidateRuntime<T>(
  impact: CapabilityMutationImpact,
  reason: string,
  commit: () => Promise<T> | T,
): Promise<{ value: T; stoppedJids: string[] }>;
```

数据流：

```
listCapabilityMutationRuntimeTargets(impact)   // 保留的 upstream 判定
  → commit()                                    // 同步落库
  → deleteWorkspaceSessions(folder) + delete deps.sessions[folder]   // 作废 SDK 会话
  → for jid of getWorkspaceRuntimeJids(...): deps.queue.stopGroup(jid, { force: true })
  → 返回 stoppedJids
```

**失败模式与取舍**：

| 失败 | upstream 行为 | 本设计行为 |
|---|---|---|
| commit 抛异常 | 装 runtime-safety 门，队列 fail-closed，等重试 | 直接抛给路由，返回 500，**策略未落库**，runner 继续跑旧策略（正确，因为什么都没变） |
| commit 成功、stop 失败 | 装门 + 503 retryable | 记 `logger.error`，返回 200 但带 `runtime_cleanup_failed: true`；前端提示"已保存，但有 N 个运行中会话仍在用旧配置，请手动重置" |
| stop 期间有新消息到达 | 被 pause 挡住，resume 后 drain | 会启动一个新 runner——但它读的是**已 commit 的新策略**，不是问题 |
| stop 期间有旧 runner 正在写文件 | 同 | 同 |

**唯一真实退化**：upstream 保证"策略变更后，队列里排着的那条消息一定用新策略跑"；本设计保证"策略变更后新起的 runner 一定用新策略跑，但正在跑的那一轮可能用旧策略跑完"。对三个熟人用户、单机部署，这个退化可接受，且**可逆**——将来补齐 `GroupQueue` 六个 API 后，把 `commitThenInvalidateRuntime` 的实现换成 upstream 版即可，调用方签名不变。

---

## 1.2 隐藏依赖要补多少

### 1.2.1 `src/mcp-utils.ts`：74 → 需要补到约 225

本地 74 行只有一个能力：`loadUserMcpServers(userId)` 读 `data/mcp-servers/{userId}/servers.json`，返回启用的 server map。upstream 474 行里，**只有约 150 行是 MCP 授权真正需要的**，其余 324 行是两件本地没有的事：secrets 分离存储（`secrets.json` + 跨进程迁移锁，约 260 行）和 system-scope MCP（约 64 行）。

**必须补的（按依赖倒推）**：

`agent-profile-policy.ts:validateRuntimePolicyReferences()` 直接依赖两个函数：

```ts
loadManagedMcpLayers(userId, { allowAdminOnlySystemMcp }): ManagedMcpLayers
resolveManagedMcpPolicy(layers, policy): { servers, missing }
```

它们各自依赖：

| 要补的符号 | upstream 行数 | 本地是否可简化 |
|---|---:|---|
| `type McpMemberAccess = 'admin_only' \| 'shared'` | 1 | 留（system scope 的门） |
| `interface StoredMcpServerDefinition` | ~14 | 留，但 `env`/`headers` 保持内联（不做 secrets 分离） |
| `interface StoredMcpServersFile` | 3 | 留 |
| `type ManagedMcpScope = 'system' \| 'user'` | 1 | 留 |
| `interface ManagedMcpLayers { system, user, restrictedSystemIds }` | 6 | 留 |
| `interface ManagedMcpAccessOptions` | 7 | 留 |
| `getUserMcpServersDir/FilePath` | 6 | 留 |
| `readStoredUserMcpServers(userId)` | ~75 | **简化到 ~25**：去掉 `requiresMigration` / `persistMigratedStoreSync` 整条链路，只保留「读 servers.json；`userId==='system'` 且 `memberAccess` 非法时在内存里 fail-closed 成 `admin_only`」这一段 |
| `loadUserMcpServers(userId)` | ~40 | **改写**：从 `readStoredUserMcpServers` 出发（当前是自己读文件），投影逻辑与本地 74 行版等价，签名不变 |
| `loadManagedMcpLayers(userId, opts)` | ~22 | 留 |
| `parseManagedMcpReference(ref)` | ~13 | 留（`system:` / `user:` / 裸 id 三种写法） |
| `resolveManagedMcpPolicy(layers, policy)` | ~28 | 留 |

**不补的（324 行）**：

- `persistMigratedStoreSync` / `acquireMigrationLock` / `releaseMigrationLock` / `reclaimStaleMigrationLock` / `readMigrationLockSnapshot` / `parseMigrationLockOwner` / `isMigrationLockOwnerAlive` / `getProcessStartTime` / `sameMigrationLockSnapshot` / `MALFORMED_MIGRATION_LOCK_STALE_MS` / `migratingStores` / `StoredMcpSecretsFile` / `StoredMcpServerSecrets` / `getUserMcpSecretsFilePath`——整套 secrets 分离 + 跨进程迁移锁。本地 `servers.json` 目前 env 内联，没有分离需求；`getProcessStartTime` 还读 `/proc/{pid}/stat`，在 macOS 上永远返回 `undefined`。
  - **这是一个独立议题**，与决策 92（明文 API key 迁进加密块）同源。建议在阶段 6.5 一并处理，届时再决定是搬 upstream 这套还是复用本地已有的 AES-256-GCM。**本节明确不做**。

**新增的 system scope 是个真缺口**：本地 `src/routes/mcp-servers.ts` **零处提到 `system`**（`grep -c system` = 0），即本地根本没有系统级 MCP 的概念。`loadManagedMcpLayers` 会调 `readStoredUserMcpServers('system')`，文件不存在时返回空 map——**这是安全的降级**：`layers.system = {}`，`restrictedSystemIds = []`，策略里写 `system:xxx` 一律落进 `missing` 被 400 拒。

因此本节的处置：**保留 layers 的两层形状，但只填 user 层**。将来吸收 upstream 的系统级 MCP 时，`system` 层自然填上，`resolveManagedMcpPolicy` / `validateRuntimePolicyReferences` / 前端的 `system:` 前缀全都已经就位，不需要二次改造。

补齐规模：**约 150 行净增**（74 → 约 225）。

### 1.2.2 `src/mcp-context.ts`：本地无，全新 89 行

`agent-profile-policy.ts` 不依赖它，但 **MCP 策略要在运行时真生效** 就绕不开它。原因：

upstream 的 `resolveRuntimeMcpServers()`（`src/container-runner.ts:645-666`）把 MCP 分成两层：

```
context 层（Claude 原生 / 项目级）   ← loadClaudeContextMcpServers()  ← mcp-context.ts
managed 层（HappyClaw 管的）        ← resolveManagedMcpPolicy()      ← mcp-utils.ts
最终 = mergeMcpServerLayers(context, managed)   // managed 覆盖 context
```

**为什么必须分层**：`mcp.mode === 'custom'` 只应该收窄 HappyClaw 管理的 MCP，不应该把工作区里 `.mcp.json` 声明的项目级 MCP 也删掉——那是项目自己的东西，不是给某个 Agent 的授权。upstream 的注释说得很直白："strict Agent MCP filtering cannot hide it（and cannot accidentally re-enable unselected HappyClaw user servers）"。

本地现在只有 managed 一层（`loadUserMcpServers(ownerId)` 直接写 settings.json），一旦加上策略过滤，**项目级 `.mcp.json` 会跟着被过滤掉**——这是个静默的能力删除。

所以 `mcp-context.ts` 全量吸收（89 行），四个导出全用得上：

| 函数 | 用途 |
|---|---|
| `readMcpServersFile(path)` | 只读 `mcpServers` 字段，忽略 settings 其余部分 |
| `getHostClaudeMcpSourcePaths(externalClaudeDir)` | `settings.json` + 同级 `.claude.json`。**绝不读 `process.env.HOME`**——本地 admin 是宿主机模式，读 HOME 会把开发者自己的 MCP 混进去 |
| `loadHostClaudeMcpServers(dir)` | 上面两个文件的合并 |
| `loadClaudeContextMcpServers({ workspaceDir, externalClaudeDir, includeHostClaudeContext })` | 四层优先级：host → `{ws}/.mcp.json` → `{ws}/.claude/settings.json` → `{ws}/.claude/settings.local.json` |
| `mergeMcpServerLayers(context, managed)` | managed 是加性最终层 |

**这同时顺带修了一个本地现存问题**：本地 `ensureSettingsJson()`（`src/container-runner.ts:175-197`）是 **deep-merge** 写法（`merged.mcpServers = { ...existingMcp, ...mcpServers }`），意味着**用户删掉一个 MCP server 后，session 目录里的旧 settings.json 仍留着它**。upstream 已经改成 `replaceMcpServers: true`。策略生效后这个 bug 会变成安全问题（禁用的 server 从旧 settings 复活），所以必须一起改。

### 1.2.3 `src/claude-context-resolver.ts`：274 → 575，但**不计入本节预算**

upstream 多出的 301 行分成三块：

| 块 | 约行数 | 归属 |
|---|---:|---|
| `HOST_CLAUDE_NATIVE_DIRECTORIES` / `HOST_CLAUDE_NATIVE_FILES` / `HOST_CLAUDE_SETTINGS_FILES` + `ClaudeNativeConfigEntry` + `nativeConfigEntries` 计划 + `loadHostClaudeSettings` / `mergeSettings` / `countConfigEntries` / `lexists` | ~120 | **决策 74（技能挂载模型跟 upstream）+ host_claude context source**。属于合并主体 |
| `effectiveSkills: EffectiveSkillManifest` 字段 + `resolveEffectiveSkills` 调用 + `workspaceSkillsDir` + `pluginSkillLayers` 入参 + `reconcileSessionSkills` 调用 | ~140 | **决策 74**。属于合并主体 |
| `hostSkillPolicy` / `managedSkillPolicy` / `userSkillsDirOverride` / `includeHostClaudeContext` 四个入参的分支 | ~40 | **本节**（Agent 策略入口） |

`src/effective-skill-resolver.ts`（340 行）同理：它是决策 74 与决策 56 的**共同依赖**，随决策 74 整体进来。本节只负责给它喂两个入参：

```ts
resolveEffectiveSkills({
  layers,                                   // ← 决策 74 提供
  managedPolicy: agentProfile?.runtimePolicy?.skills,      // ← 本节
  hostPolicy: resolveHostSkillPolicy(agentProfile?.runtimePolicy), // ← 本节
})
```

**依赖顺序因此是硬的**：决策 74 的技能挂载模型必须先于本节落地，否则 `managedSkillPolicy` 没有消费方，`skills.mode='custom'` 是个假开关。

**签名变化清单**（本地 `ClaudeContextPlanArgs` 现在 8 个字段，要加 5 个）：

```ts
export interface ClaudeContextPlanArgs {
  // ── 本地已有 8 个，不变 ──
  executionMode; group; ownerHomeFolder; externalClaudeDir;
  projectRoot; dataDir; groupSessionsDir; mountUserSkills;
  // ── 决策 74 带进来 ──
  workspaceSkillsDirOverride?: string;
  pluginSkillLayers?: EffectiveSkillLayer[];
  happyclawMemoryActive?: boolean;
  // ── 本节带进来 ──
  includeHostClaudeContext?: boolean;      // ← agentProfile.runtimePolicy.context.source === 'host_claude'
  hostSkillPolicy?: ManagedSkillPolicy;    // ← resolveHostSkillPolicy(runtimePolicy)
  managedSkillPolicy?: ManagedSkillPolicy; // ← runtimePolicy.skills
  userSkillsDirOverride?: string;
}
```

**本地 `ClaudeContextPlan` 有一个 upstream 没有的隐性差异**：`ADMIN_HOME_FOLDER = 'main'` 常量（`src/claude-context-resolver.ts:36`）是本地的 admin 判定，upstream 改用角色（决策 54）。这个改动**在冲突区**，合并时会撞上；决策 54 已定"跟 upstream 用角色"，处置在合并主体，不在本节。

### 1.2.4 还有没有别的 stub

逐个核对本节涉及的每一个上游依赖：

| 依赖 | 本地状态 | 处置 |
|---|---|---|
| `src/skill-utils.ts` | **完全一致**（214 行 vs 214 行，5 个导出同名同序：`validateSkillId` / `validateSkillPath` / `parseFrontmatter` / `listFiles` / `scanSkillDirectory`） | 零工作 |
| `getEffectiveExternalDir()`（`runtime-config.ts:4479`） | **已有** | 零工作 |
| `SystemSettings.mainAgentContextSource` / `mainAgentAutoCompactWindow` / `mainAgentAutoCompactPercentage` | **本地无**（本地只有 `autoCompactWindow`） | `resolveEffectiveAgentProfile()` 读这三个字段。要在 `SystemSettings` 接口 + `getSystemSettings()` 三级 fallback + `saveSystemSettings()` 范围校验 + `SystemSettingsSchema` + 前端 `SystemSettingsSection` 各加一项。**约 40 行**，按 CLAUDE.md §11「将环境变量迁移为 Web 可配置」的五步做 |
| `src/http-upload-policy.ts`（26 行，`avatarUploadBodyLimit` / `AVATAR_MAX_FILE_BYTES`） | **本地无** | 决策 56 砍头像上传，**不需要** |
| `src/types.ts` 的 `AgentProfile` / `AgentProfilePrompts` / `AgentProfilePromptVersion` / `WorkspaceAgentProfileBinding` / `AgentProfileRuntimePolicy` / `AgentProfilePromptMode` / `InteractionMode` | **本地无**（本地把 `AgentProfile` 定义在 `db.ts` 里，且是 camelCase 字段） | 见 1.5.3 的命名冲突处理 |
| `src/schemas.ts` 的 5 个 Agent schema | **本地无** | 吸收 `AgentProfileRuntimePolicySchema`（54 行）+ `AgentProfileCreateSchema`（22）+ `AgentProfilePatchSchema`（22）+ `GroupAgentProfilePatchSchema`（3）+ `AgentPromptTextSchema` / `AgentPromptModeSchema`（2）。**不吸收** `AgentProfileGenerateSchema` / `AgentProfileRefinePromptSchema` / `AgentPromptSectionsSchema` / `validatePromptModeCompatibility`（都只服务被砍的 generate/refine 端点）。约 **105 行** |
| `deleteWorkspaceSessions(folder)`（`capability-runtime-mutation` 用） | 需核对本地是否有同名函数 | 若无，用本地既有的会话清理路径（`/clear` 命令走的那条）包一层 |
| `getAllUsers()` / `getUserById()` | **已有** | 零工作 |
| `deps.queue.listDescendantJids(jid)` | **已有**（`src/group-queue.ts:386`） | 零工作 |

---

## 1.3 路由裁剪

upstream `src/routes/agent-profiles.ts` 共 **11 个端点**：

| # | 方法 + 路径 | 行数 | 处置 | 理由 |
|---|---|---:|---|---|
| 1 | `GET /` 列表（带 `effective_runtime_policy`） | 15 | **保留** | 列表页必需。`effective_runtime_policy` 字段一起留——它是"你写的策略"和"实际生效的策略"的差异展示，非 admin 用户看 `host_claude` 被降级成 `managed` 就靠它 |
| 2 | `POST /` 创建 | 68 | **保留** | 「建 Agent」 |
| 3 | `POST /generate` AI 生成草稿 | 21 | **砍** | 决策 56：AI 辅助生成人格 |
| 4 | `POST /:id/effective-capabilities` 有效能力预览 | 105 | **砍** | 决策 56：有效能力预览面板。这也是 `agent-capability-preview.ts`(364) + `run-context-snapshot.ts`(239) 的唯一调用点，砍它等于砍掉 603 行 |
| 5 | `POST /:id/avatar` 头像上传 | 47 | **砍** | 决策 56：头像上传。emoji + 颜色仍可通过 `PATCH /:id` 设置 |
| 6 | `DELETE /:id/avatar` | 16 | **砍** | 同上 |
| 7 | `POST /:id/refine-prompt` AI 调整人格 | 48 | **砍** | 决策 56：AI 辅助生成人格 |
| 8 | `PATCH /:id` 改名 / 改四段人格 / 改策略 | 208 | **保留但重构** | 「编辑四段人格」+「授权 Skill 与 MCP」的唯一写入口。208 行里约 90 行是 quiesce 的 try/catch 分支（见 1.1.3 换掉）+ 约 35 行是 `legacyPromptTargetsIdentity` / `usesFourPartPromptPayload()` 的单段→四段兼容（本地无存量，删）。重构后约 **85 行** |
| 9 | `GET /:id/prompt-versions` 版本列表 | 8 | **砍** | 决策 56：人格版本历史与回滚 |
| 10 | `POST /:id/prompt-versions/:version/restore` 回滚 | 95 | **砍** | 同上 |
| 11 | `DELETE /:id` 归档 | 39 | **保留** | 四态返回（`not_found` / `is_default` / `has_workspaces` / `has_mounts`）全留。`has_mounts` 依赖 `listAgentChannelMountsForProfile`——本地批次 7 已有 `channel_mounts`，若该函数不存在则退化为只检查 `has_workspaces` |
| 12 | `GET /:id/workspaces` 该 Agent 挂了哪些工作区 | 55 | **保留但裁剪** | 「挂到工作区」的读侧。裁掉 `runtime_sessions[]`（那是 upstream 单张会话表的投影，本地是 `design-merge-internals.md` 设计 5 的两张表，形状不同）和 `channel_mounts[]` 的 8 个路由/回复策略字段（属阶段 5）。裁剪后约 **22 行** |

**「挂到工作区」的写侧不在这个文件里**——upstream 放在 `src/routes/groups.ts`：

| 端点 | upstream 位置 | 处置 |
|---|---|---|
| `POST /api/groups` 建工作区时带 `agent_profile_id` | `routes/groups.ts:497` | **保留**，用 `GroupAgentProfilePatchSchema` 校验 |
| `PATCH /api/groups/:jid/agent-profile` 改绑 | `routes/groups.ts:1207-1336` | **保留**。这一段带 quiesce（因为改绑 = 换人格 = 必须停 runner），按 1.1.3 换成 `commitThenInvalidateRuntime` |
| `GET /api/groups` 列表回 `agent_profile_id/name/version` | `routes/groups.ts:396` | **保留**。前端侧边栏按 Agent 分组要用 |

**新增一个 upstream 没有的端点**（决策 49 的前置）：

```
PATCH /api/groups/:jid/interaction-mode   body: { interaction_mode: 'assistant' | 'proactive' }
```

upstream 把 `interaction_mode` 混在别处改；本地按用户方案「每个东西一个开关」（决策 65 同精神）单开一个端点，约 20 行。

路由层小计：**约 300 行**（保留 6 个端点 + 新增 1 个 + groups.ts 三处接线）。

---

## 1.4 前端

### 1.4.1 处置表

| upstream 文件 | 行数 | 处置 | 落地约 |
|---|---:|---|---:|
| `web/src/pages/AgentProfilesPage.tsx` | 1876 | **不移植，新写精简页** | 420 |
| `web/src/components/agents/AgentPromptEditor.tsx` | 235 | **保留，裁剪** | 195 |
| `web/src/components/agents/AgentSkillsPolicyEditor.tsx` | 235 | **全留** | 235 |
| `web/src/components/agents/PolicyResourcePicker.tsx` | 148 | **全留** | 148 |
| `web/src/components/agents/AgentPromptAssistant.tsx` | 320 | **砍**（AI 辅助生成/调整人格） | 0 |
| `web/src/components/agents/AgentPromptVersionHistory.tsx` | 203 | **砍**（版本历史与回滚） | 0 |
| `web/src/components/agents/EffectiveCapabilitiesPreview.tsx` | 456 | **砍**（有效能力预览面板） | 0 |
| `web/src/components/agents/AgentGovernanceSection.tsx` | 256 | **砍**（治理页） | 0 |
| `web/src/stores/agent-profiles.ts` | 354 | **裁剪** | 150 |
| `web/src/utils/agent-prompts.ts` | 122 | **全留** | 122 |
| `web/src/utils/agent-runtime-policy.ts` | 54 | **全留** | 54 |
| `web/src/utils/agent-product.ts` | 123 | **裁剪** | 45 |
| `web/src/utils/unsaved-navigation.ts` | 52 | **全留** | 52 |
| `web/src/utils/mcp-servers.ts` | 113 | **裁剪** | 45 |
| `web/src/utils/capability-sources.ts` | 16 | **砍**（只服务预览面板） | 0 |

前端小计：**约 1466 行**。

### 1.4.2 为什么新写页面而不是裁 1876 行

`AgentProfilesPage.tsx` 的 1876 行里，有 4 个大区块（能力预览 / 治理 / 版本历史 / AI 助手）是我们要砍的，它们与保留区块通过共享的 `normalizeRuntimePolicy()` / `sameRuntimePolicy()` / 一个约 40 字段的 `useState` 集群 / 一个跨区块的 dirty-tracking 交织在一起。裁剪的话要在这 1876 行里做 40+ 处手术，改完既不好审也不好回滚；而保留下来的功能只有四块：

```
左栏  Agent 列表（默认 Agent 置顶 + 自定义 Agent） + 新建按钮
右栏  ├─ 基本信息      名称 / emoji / 颜色                    ← EmojiPicker + ColorPicker（本地已有）
      ├─ 人格四段      IDENTITY / SOUL / AGENTS / TOOLS + 追加/替换 ← AgentPromptEditor
      ├─ 能力授权      Skill 策略（managed + host）/ MCP 策略      ← AgentSkillsPolicyEditor + PolicyResourcePicker
      └─ 工作区        挂了哪些工作区（只读列表 + 跳转）           ← 新写 ~50 行
```

**新写页面的结构**（`web/src/pages/AgentProfilesPage.tsx`，约 420 行）：

```tsx
export function AgentProfilesPage() {
  const { profiles, loading, error, loadProfiles, createProfile,
          updateProfile, deleteProfile } = useAgentProfilesStore();
  const { skills } = useSkillsStore();          // 本地已有
  const { servers } = useMcpServersStore();     // 本地已有
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<AgentProfileDraft>();   // 四段 + mode + 策略
  const dirty = useMemo(() => !sameDraft(draft, selectedProfile), [draft, selectedProfile]);
  useEffect(() => createUnsavedNavigationGuard(dirty), [dirty]);  // ← utils/unsaved-navigation
  ...
}
```

保留 `unsaved-navigation.ts` 的理由很实际：四段人格是长文本，误触侧边栏丢失编辑内容是最容易被抱怨的一类回归。

### 1.4.3 store 裁剪

upstream `stores/agent-profiles.ts` 有 12 个 action，保留 5 个：

| action | 处置 |
|---|---|
| `loadProfiles()` | 留 |
| `createProfile(data)` | 留 |
| `updateProfile(id, data)` | 留 |
| `deleteProfile(id)` | 留 |
| `setWorkspaceAgentProfile(jid, profileId)` | 留 |
| `loadProfileGovernance(id)` | 砍（治理页） |
| `loadPromptVersions(id)` / `restorePromptVersion(id, v)` | 砍（版本历史） |
| `generateProfileDraft(desc)` / `refineProfilePrompt(id, data)` | 砍（AI 辅助） |
| `uploadProfileAvatar(id, file)` / `removeProfileAvatar(id)` | 砍（头像上传） |

新增 1 个：`setWorkspaceInteractionMode(jid, mode)`（决策 49 的前端入口）。

### 1.4.4 路由与导航

```
web/src/App.tsx    +  <Route path="/agent-profiles" element={<AgentProfilesPage />} />   // 懒加载
侧边栏             +  一个「Agent」入口（在 Skills / Plugins 同级）
```

`utils/agent-product.ts` 裁剪后保留的 4 个函数专门服务侧边栏「按 Agent 分组显示工作区」：`getAgentProfileDisplayName` / `getCustomAgentProfiles` / `groupWorkspacesByAgent` / `partitionAgentWorkspaceSections`。砍掉 `getAgentNavigationTargets` / `getPrimaryAgentWorkspaceRows` / `isAgentSectionCollapsible` / `buildAgentCapabilitiesHref`（指向被砍的能力面板锚点）/ `workspaceCreationBlockReason` / `getWorkspaceExecutionMode` / `buildWorkspaceAgentProfilePatch`。

`utils/mcp-servers.ts` 裁剪后保留 `mcpSourceKey` / `parseMcpSourceKey` / `normalizeMcpPolicyReferences` / `buildMcpPolicyOptions`——策略编辑器要把 `system:` / `user:` / 裸 id 三种历史写法归一化后再显示。砍 `mcpServerEndpoint`（本地路由无 `?source=` 参数）和 `normalizeMcpServers`（服务 system-scope 列表页）。

---

## 1.5 数据层

### 1.5.1 `agent_profiles`：18 列，全部用得上

本地 DDL（`src/db.ts:934-953`）与 upstream **逐列一致**，无需迁移。列的用途：

| 列 | 本节用途 |
|---|---|
| `id` / `owner_user_id` / `name` | 建 Agent |
| `identity_prompt` / `soul_prompt` / `agents_prompt` / `tools_prompt` / `prompt_mode` | 四段人格 |
| `include_claude_preset` | **留着不用**。upstream 自己已标 `@deprecated`（"Compatibility alias for prompt_mode === 'append'"）。本地建表即有，删列要 rebuild，收益为零；写入时恒等于 `prompt_mode === 'append'` |
| `avatar_emoji` / `avatar_color` | 保留（前端可编辑） |
| `avatar_url` | **留着不用**。头像上传砍了，此列恒为 NULL。**不删**——将来若恢复上传，加回来比 rebuild 表便宜 |
| `runtime_policy` | **从死列变活列**。这是本节最大的一处数据层改动，见 1.5.4 |
| `identity_hash` / `version` | 已在用（`hasSessionAgentProfileMismatch`） |
| `is_default` / `status` | 已在用 |
| `created_at` / `updated_at` | 已在用 |

### 1.5.2 `agent_profile_prompt_versions`：建着，不写，不读

砍了版本历史与回滚之后，这张表没有写入方（upstream 的写入点在 `updateAgentProfile` 里的 `INSERT OR IGNORE INTO agent_profile_prompt_versions`）也没有读取方。

**处置：保留 DDL，不实现写入。**

理由不是懒：`updateAgentProfile()` 里那一句 `INSERT OR IGNORE` 只有约 12 行，而它提供的是**人格误改的兜底**——四段人格是长文本，一次误粘贴覆盖掉精心调过的 SOUL 段，没有版本表就只能靠数据库备份找回。

**折中方案**：写入保留（12 行），只砍 UI 和两个端点。这样：

- 表在增长（每次人格变更一行，三个用户的量级完全可忽略）
- 将来想恢复版本历史，只要加回 `GET /:id/prompt-versions` 和一个组件
- 现在若要找回旧版本，`sqlite3` 一条 SELECT 就够

`change_source` 列的取值收窄为 `'create' | 'update'`（`'restore'` 无写入方，`'migration'` 本地无迁移场景），`restored_from_version` 恒为 NULL。

### 1.5.3 `agent_builder_drafts`：**砍掉建表**

Builder 砍了之后，这张表 13 列全部无主：`source_group` / `source_chat_jid` / `target_agent_profile_id` / `base_agent_version` / `revision` / `state` / `definition_json` / `assumptions_json` / `prepared_turn_id` / `confirmation_phrase` / `published_agent_profile_id`——每一列都是对话式 Builder 的会话状态机，没有任何其他用途。

**但本地批次 5 已经把它建出来了。** 所以处置不是"不建"，而是"删表"：

```sql
-- schema N: 移除对话式 Agent Builder（决策 57）
DROP INDEX IF EXISTS idx_agent_builder_drafts_owner;
DROP TABLE IF EXISTS agent_builder_drafts;
```

同时从 `src/db.ts` 的 `CREATE TABLE IF NOT EXISTS` 块里删掉这段 DDL——否则下次启动又建回来（CLAUDE.md §11「修改数据库 Schema」明确要求两处同改）。

**先验证再删**：`SELECT COUNT(*) FROM agent_builder_drafts` 必须是 0。本地从没有 Builder 代码，理应为 0；不是 0 说明有别的写入方，需要先查清。

这是本节唯一不可逆的数据层操作，与决策台账「回滚方案」里 `group_members` 那 32 行同类。

### 1.5.4 `workspace_agent_profiles`：加一列

本地 4 列，upstream 5 列。差的是 `interaction_mode`（决策 49）：

```sql
ALTER TABLE workspace_agent_profiles
  ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'assistant';
```

**不能照抄 upstream 的 DDL 内联 CHECK 约束**（`CHECK (interaction_mode IN ('assistant','proactive'))`）——SQLite 的 `ALTER TABLE ADD COLUMN` 支持带 CHECK 的列定义，但对存量行不做校验，且将来要放宽取值就得 rebuild。约束放在 `src/schemas.ts` 的 zod 层（`z.enum(['assistant','proactive'])`）+ `setWorkspaceInteractionMode()` 的入参类型。

配套两个 DB 函数（upstream `db.ts:7866-7887`，共 22 行，直接吸收）：

```ts
export function getWorkspaceInteractionMode(groupFolder: string): InteractionMode;
export function setWorkspaceInteractionMode(groupFolder: string, mode: InteractionMode): boolean;
```

`getWorkspaceInteractionMode` 依赖 `getWorkspaceAgentProfileBinding(folder)`——本地没有这个函数（本地是 `getWorkspaceAgentProfile` 直接 JOIN 回 profile 行，丢掉了 binding 自己的列）。要新增：

```ts
export function getWorkspaceAgentProfileBinding(
  groupFolder: string,
): WorkspaceAgentProfileBinding | null;   // { group_folder, agent_profile_id, interaction_mode, created_at, updated_at }
```

### 1.5.5 `runtime_policy` 从死列变活列

这是数据层的核心改动。当前 `mapAgentProfile()` 把它读成裸 `string`（`src/db.ts:8350`），需要改成解析后的对象。

**要新增的 db.ts 函数**（吸收 upstream，共约 180 行）：

| 函数 | upstream 行数 | 说明 |
|---|---:|---|
| `normalizeAgentProfileRuntimePolicy(input)` | 72 | 三个子策略的 mode 归一化 + 数值范围钳位（`auto_compact_window` ∈ {0} ∪ [100000, 1000000]，`auto_compact_percentage` ∈ {0} ∪ [50, 90]，且 percentage>0 时强制 window=0） |
| `mergeAgentProfileRuntimePolicy(current, patch)` | 47 | PATCH 语义：省略的兄弟字段不被重置。`null` 表示"恢复默认"，`undefined` 表示"不动"——这个区分是 PATCH 正确性的关键 |
| `serializeAgentProfileRuntimePolicy(input)` | 5 | 落库前 normalize + stringify |
| `DEFAULT_AGENT_PROFILE_RUNTIME_POLICY` 常量 | ~15 | |
| `normalizeIdList` / `normalizeMode` 辅助 | ~12 | |
| `getWorkspaceAgentProfileBinding` | ~20 | 1.5.4 |
| `getWorkspaceInteractionMode` / `setWorkspaceInteractionMode` | 22 | 1.5.4 |
| `updateAgentProfile()` 加 `runtimePolicy` 入参 | ~20 | 本地现在的写函数叫 `updateAgentProfilePrompts`，只改人格。要么扩展它、要么改名 `updateAgentProfile` 与 upstream 对齐（决策 50「五组函数改名对齐」的精神） |

**不吸收**：`removeLegacyAgentToolPolicies()`（清理 upstream 已下线的 `runtime_policy.tools` 字段，本地从没写过 tools）、`migrateAgentProfileAutoCompactWindow()`（upstream 老配置迁移）。

### 1.5.6 类型命名冲突

本地 `AgentProfile` 定义在 `src/db.ts` 内，字段是 **camelCase**（`identityPrompt` / `runtimePolicy` / `isDefault`）；upstream 定义在 `src/types.ts`，字段是 **snake_case**（`identity_prompt` / `runtime_policy` / `is_default`）。

`agent-profile-policy.ts` / `agent-profile-runtime.ts` / `capability-runtime-mutation.ts` 三个吸收模块**全部按 snake_case 写**。

**处置：类型移到 `src/types.ts` 并改成 snake_case，与 upstream 对齐。** 理由：

1. 三个吸收模块 + 前端 store + HTTP 响应体全是 snake_case，本地 camelCase 只有 `container-runner.ts:resolveAgentProfileForInput()` 一个转换点（它本来就在做 DB→ContainerInput 的字段改名，把 `profile.identityPrompt` 改成 `profile.identity_prompt` 是一行）。
2. 不对齐的话，每个吸收模块都要在边界上写一层 mapper，将来每次上游同步都要重写这层 mapper——这正是决策 50「五组函数改名对齐」要避免的成本。

**唯一保留本地语义的地方**（对应决策台账 2.1「Agent 档案查询的三处语义」）：

| 语义 | 本地做法 | 不改的理由 |
|---|---|---|
| 归档过滤 | 所有查询都带 `status = 'active'` | 已验证 |
| 身份指纹不含引擎 | `computeAgentIdentityHash()` 只 hash 四段 + mode，**不含 runtime/model/provider**（决策 A5） | 换引擎不该让全部会话集体失效。**注意 upstream 的 `computeAgentProfileIdentityHash(profile, runtimePolicy, name)` 把 `runtime_policy` 也 hash 进去了**——若照抄，改一次 Skill 授权就会让所有会话身份漂移。本节**保持本地实现**，`runtime_policy` 变更走 1.1.3 的显式停 runner，不走指纹 |
| 工作区兜底 | `getWorkspaceAgentProfile(folder, ownerUserId)` 未绑定时回落 owner 的 default profile | upstream 的 `getAgentProfileForWorkspace` 语义相同，签名对齐即可 |

### 1.5.7 与 `design-merge-internals.md` 设计 3 的接口

`listWorkspaceGroupsForAgentProfile()` 里有一句 `if (!jid.startsWith('web:')) return false;`——这是 upstream 用 jid 前缀判断"哪个 jid 代表工作区"。设计 3 已定「工作区投影按 folder（36 行），不是按 jid（64）也不是按前缀（35）」，并会给出一个规范的 folder→jid 映射函数。

**接口约定**：`listWorkspaceGroupsForAgentProfile` 改成调那个函数，不自己判前缀：

```ts
// 改前（upstream）
.filter(([jid, group]) => jid.startsWith('web:') && group.created_by === ownerUserId && ...)
// 改后
.filter(([jid, group]) => jid === canonicalWorkspaceJid(group.folder) && group.created_by === ownerUserId && ...)
```

否则同一个 folder 的多个渠道 jid 会各算一个"工作区"，`GET /:id/workspaces` 会重复列出。

---

## 1.6 与决策 27 / 28 的接口

这一节明确 Agent-first 核心**向第二节交付什么**，第二节只消费、不重复定义。

### 1.6.1 决策 27（人格补进 codex/grok）的接入点

Agent-first 核心交付的是**内容**，不是注入机制：

```
DB: agent_profiles 四段 + prompt_mode
  → src/container-runner.ts: resolveAgentProfileForInput(group, agentId)   【本地已有】
  → ContainerInput.agentProfile { id, name, identityPrompt, soulPrompt,
                                  agentsPrompt, toolsPrompt, promptMode,
                                  identityHash, version }                  【本地已有】
  → container/agent-runner/src/agent-persona.ts: buildPersonaBlock(input)  【本地已有】
  ────────────────── 以上全部就位，唯一的洞在下面 ──────────────────
  → 只有 Claude 分支调 buildPersonaBlock（index.ts:1470，在 runQuery 内）
    codex/grok 分支（index.ts:2361-2415，在 main 内）自建 systemPromptAppend，
    不含人格
```

**Agent-first 核心不需要为此做任何改动。** 第二节 2.7 只在 agent-runner 里改约 25 行。

**唯一需要本节配合的一点**：新建 Agent 时若 `runtime_policy.context.source = 'host_claude'`，`resolveEffectiveAgentProfile()` 会在 owner 非 admin 时把它降级成 `'managed'`。这个降级发生在**主进程**，`resolveAgentProfileForInput()` 必须调用 `resolveEffectiveAgentProfile()` 而不是直接用 DB 行，否则 member 用户存的 `host_claude` 会在 runner 侧生效。

```ts
// src/container-runner.ts:696
function resolveAgentProfileForInput(group, agentId) {
  const profile = resolveEffectiveAgentProfile(       // ← 新增这一层
    getWorkspaceAgentProfile(group.folder, group.created_by),
  );
  ...
}
```

### 1.6.2 决策 28（MCP 权限策略对三条运行时生效）的接入点

Agent-first 核心负责**算出白名单**，第二节负责**让三条运行时都用它**。

主进程侧（本节）：

```ts
// src/container-runner.ts，两条 spawn 路径各调一次
function resolveRuntimeMcpServers(
  group: RegisteredGroup,
  agentProfile?: RunnerAgentProfile,
): Record<string, Record<string, unknown>> {
  const layers = group.created_by
    ? loadManagedMcpLayers(group.created_by, {
        allowAdminOnlySystemMcp: getUserById(group.created_by)?.role === 'admin',
      })
    : { system: {}, user: {}, restrictedSystemIds: [] };
  const managed = resolveManagedMcpPolicy(layers, agentProfile?.runtimePolicy?.mcp
    ?? { mode: 'inherit', ids: [] }).servers;
  const context = loadClaudeContextMcpServers({
    workspaceDir: path.join(GROUPS_DIR, group.folder),
    externalClaudeDir: getEffectiveExternalDir(),
    includeHostClaudeContext: requestsHostClaudeContext(agentProfile?.runtimePolicy),
  });
  return mergeMcpServerLayers(context, managed);
}
```

交付给第二节的两个字段（加进 `ContainerInput`）：

```ts
/** 主进程算好的、本轮允许使用的 MCP server 全集（含 context 层 + managed 层）。
 *  三条运行时都必须以它为准，不得自行读 settings.json 兜底。 */
resolvedMcpServers?: Record<string, Record<string, unknown>>;
/** 上面这份 map 的内容 hash + 排序后的 id 列表，用于执行轨迹归因与"策略是否生效"排查。 */
mcpManifest?: { hash: string; serverIds: string[] };
```

`mcpManifest` 由 `buildEffectiveMcpManifest()`（`effective-mcp-manifest.ts`）产出，这就是 1.1.1 里那 95 行"不只是服务预览面板"的具体依据。

**为什么放 ContainerInput 而不是环境变量**：现在 codex 和 grok 读的是 `HAPPYCLAW_USER_MCP_SERVERS_JSON` 环境变量（`codex-cli-runner.ts:167`、`grok-cli-runner.ts:82`），而且**只在 `disableMemoryLayer` 为真时才注入**（`container-runner.ts:2085-2095`）——也就是说常规路径下这个环境变量根本不存在，两个 runner 会 fallback 到读 `CLAUDE_CONFIG_DIR/settings.json`。这条 fallback 路径是策略绕过的口子：settings.json 由主进程写、但写的是全量（1.2.2 提到的 deep-merge bug），策略过滤在这里失效。放进 ContainerInput 是唯一能同时关掉这两条旁路的位置。

**Skill 侧的对称接口**（决策 74 提供，本节只标注）：

```ts
skillManifest?: { hash: string; selectedSkillIds: string[] };
```

---

## 1.7 第一节规模合计

| 部分 | 约行数 |
|---|---:|
| 后端吸收/裁剪模块（1.1.1） | 953 |
| `mcp-utils.ts` 补齐（1.2.1） | 150 |
| `SystemSettings` 三字段（1.2.4） | 40 |
| `schemas.ts`（1.2.4） | 105 |
| `db.ts` 增量（1.5.5） | 180 |
| `types.ts` 类型 + camelCase→snake_case 迁移（1.5.6） | 90 |
| `container-runner.ts` 接线（1.6） | 120 |
| `routes/groups.ts` 三处接线 + 新端点（1.3） | 60 |
| 前端（1.4） | 1466 |
| **合计** | **≈ 3164** |

比决策 56 的"2400"多约 760 行。差额来源已定位清楚：

- 前端新写精简页 420 行 + 保留组件 578 行 + store/utils 468 行 = 1466，比"移植 upstream 前端"的估算高——因为 upstream 前端 3546 行里我们要留的比例（约 41%）比后端（约 30%）高。
- `mcp-utils.ts` 补齐 150 + `SystemSettings` 40 = 190 行是"隐藏依赖"，决策 56 做估算时未展开。

**不计入的**（归其他决策）：`effective-skill-resolver.ts` 340 + `claude-context-resolver.ts` 补齐 260（决策 74），共 600 行。

---

# 第二节 · 运行时对齐八项的可实施设计

## 2.0 八项的共同前置与依赖顺序

### 2.0.1 两个跨项的共同改动

**共同前置 A：`ContainerOutput` 要能承载控制面信号。**

本地 `container/agent-runner/src/types.ts` 的 `ContainerOutput` **没有 `providerFailure` 字段**，也没有 `errorClass`。主进程的 `src/container-runner.ts:292` 那边倒是有 `providerFailure?: boolean`，但唯一的赋值点是 `agent-output-parser.ts:246` 的**文本模式匹配**（`isProviderFailureResult()` 匹配 Claude 的额度提示措辞）。

```ts
// container/agent-runner/src/types.ts
export interface ContainerOutput {
  // ...既有字段不变
  /** 本轮因 provider 侧原因失败（额度/鉴权/限流/长时间无响应）。主进程据此
   *  把当前 provider 标记为不健康并换号重试，不当作 Agent 的正常回答。 */
  providerFailure?: boolean;
  /** 失败分类。runtime-adapter.ts 的 RuntimeErrorClass 同名取值。 */
  errorClass?: RuntimeErrorClass;
}
```

同步改 `src/container-runner.ts` 的 `ContainerOutput` 声明（两处必须一致，否则 host 侧读不到 runner 写的字段）。

**共同前置 B：`runOneTurnRuntime()` 是 codex/grok 的唯一出口，四项对齐都要改它。**

`container/agent-runner/src/index.ts:2060-2229`。它现在：

- 丢弃 `result.errorClass`（2217-2227 的 `writeOutput` 不带这个字段）
- 无条件写 `result: result.result`（2219）
- 不知道 `interactionMode`
- 没有首响应计时

对齐 1 / 2 / 3 全部落在这个函数上，**必须一次改完**，分次改会出现"三种半成品状态"。

### 2.0.2 依赖顺序

```
共同前置 A（ContainerOutput 两处加字段）
  ├─→ 对齐 3（provider 降级分类）
  └─→ 对齐 2（首响应看门狗，超时后要发 providerFailure）

决策 49（workspace_agent_profiles.interaction_mode，见 1.5.4）
  └─→ 对齐 1（主动模式）

第一节 1.6.2（ContainerInput.resolvedMcpServers）
  └─→ 对齐 8（MCP 权限策略）

第一节 1.6.1（resolveEffectiveAgentProfile 接进 resolveAgentProfileForInput）
  └─→ 对齐 7（人格注入）

无前置：对齐 4（渠道上下文）、5（Grok 水位）、6（工具结果事件）
```

对齐 6 应该**先做**——它是其余七项的观察工具。没有工具结果进执行轨迹，验证对齐 1/7/8 时你看不到 codex/grok 到底调了什么、返回了什么。

---

## 2.1 主动模式接上 codex/grok（决策 29）

### 2.1.1 现状

Claude 侧本地也**没有**主动模式（`grep -rn "proactive" container/agent-runner/src/` 零命中，`src/` 只有 4 处不相关的英文注释）。所以这一项对三条运行时都是新增，不是"补齐 codex/grok"。

upstream 的主动模式由五部分组成：

| 部分 | upstream 位置 | 行数 |
|---|---|---:|
| `workspace_agent_profiles.interaction_mode` 列 + 两个 DB 函数 | `db.ts` | 22 |
| `src/workspace-interaction-runtime.ts` 六个纯函数 | 独立文件 | 153 |
| `ContainerInput.interactionMode` | `types.ts:203` | 1 |
| 两个提示词文件 | `prompts/output.proactive.md` + `prompts/delivery-contract.proactive.md` | — |
| 主进程侧的回答发布逻辑（约 20 处 `publishesFrameworkAnswer()` 判断） | `src/index.ts` | ~120 |

### 2.1.2 改哪些文件

| 文件 | 改动 |
|---|---|
| `src/db.ts` | 1.5.4 已列（`interaction_mode` 列 + 两个函数） |
| `src/workspace-interaction-runtime.ts` | **新增，吸收 upstream 153 行全部六个函数**。它们是纯函数、零依赖、有单测价值，是这一项的语义中心 |
| `src/types.ts` | `export type InteractionMode = 'assistant' \| 'proactive';` |
| `src/container-runner.ts` | `ContainerInput.interactionMode?: InteractionMode`；两条 spawn 路径的 `resolveAgentProfileForInput` 旁边加一句 `interactionMode: resolveRuntimeInteractionMode(getWorkspaceInteractionMode(group.folder), { agentKind, scheduledTask })` |
| `container/agent-runner/src/types.ts` | `interactionMode?: 'assistant' \| 'proactive'` |
| `container/agent-runner/prompts/` | 新增 `output.proactive.md`（吸收 upstream，中文，已成稿）+ `delivery-contract.proactive.md`（吸收）+ `delivery-contract.assistant.md`（吸收，`assistant` 模式也需要显式契约，否则两模式的差异只由"有没有一段提示词"体现，模型分不清） |
| `container/agent-runner/src/index.ts` | 三处：`usesProactiveInteractiveContract()` 判定函数、Claude 分支 `promptPieces` 加两个 piece、**codex/grok 分支的 `systemPromptAppend` 加同样两个 piece 并替换硬编码的 runtimeNote** |
| `container/agent-runner/src/index.ts:2217` | `runOneTurnRuntime` 的终稿裁决 |
| `src/index.ts` | 回答发布侧（见 2.1.5） |

### 2.1.3 函数签名

```ts
// src/workspace-interaction-runtime.ts（吸收 upstream 全文）
export type PublicAgentKind = 'main' | 'conversation' | 'spawn';
export function resolveRuntimeInteractionMode(
  workspaceMode: InteractionMode | null | undefined,
  input: { agentKind: PublicAgentKind; scheduledTask?: boolean },
): InteractionMode;
export function publishesFrameworkAnswer(mode: InteractionMode): boolean;
export function isProactiveControlPlaneSuccess(input: {...}): boolean;
export function shouldResolveFrameworkPrimaryAnswer(input: {...}): boolean;
export function isInteractionTurnSettled(input: {...}): boolean;
export function usesNativeMessagePresentation(mode: InteractionMode): boolean;
```

```ts
// container/agent-runner/src/index.ts（新增，与 upstream 逐字相同）
function usesProactiveInteractiveContract(ci: ContainerInput): boolean {
  return ci.interactionMode === 'proactive'
    && !ci.isScheduledTask
    && !ci.messageTaskId;
}
```

### 2.1.4 那句硬编码假话

`container/agent-runner/src/index.ts:2368-2371`：

```ts
const runtimeNote =
  runtime === 'grok'
    ? '当前运行时是 Grok。HappyClaw 会把你的最终文本作为本轮回复发送给用户；请直接完成用户当前请求。'
    : '当前运行时是 Codex。HappyClaw 会把你的最终文本作为本轮回复发送给用户；请直接完成用户当前请求。';
```

主动模式下这句是**假的**：框架不会发布最终文本，只发布 `send_message` 送出去的话。模型信了这句话就会把答案只写在最终文本里，用户看到全空白。

改成按模式分叉：

```ts
const runtimeName = runtime === 'grok' ? 'Grok' : 'Codex';
const runtimeNote = proactiveInteractiveContract
  ? `当前运行时是 ${runtimeName}。你的最终文本不会发送给用户；用户能看到的每一句话都必须通过 mcp__happyclaw__send_message 送出。`
  : `当前运行时是 ${runtimeName}。HappyClaw 会把你的最终文本作为本轮回复发送给用户；请直接完成用户当前请求。`;
```

并在 `systemPromptAppend` 数组里插入：

```ts
proactiveInteractiveContract ? PROACTIVE_OUTPUT_GUIDELINES : ASSISTANT_OUTPUT_GUIDELINES,
!containerInput.isScheduledTask && !containerInput.messageTaskId
  ? (proactiveInteractiveContract ? PROACTIVE_DELIVERY_CONTRACT : ASSISTANT_DELIVERY_CONTRACT)
  : null,
```

注意本地现有 `prompts/output.md` 是单份、不分模式的（`OUTPUT_GUIDELINES` 常量），要拆成 `output.assistant.md` / `output.proactive.md` / `output.task.md` 三份——**这会同时影响 Claude 分支**，是一次三运行时同步改动。

### 2.1.5 数据流与终稿裁决

```
用户消息
  → src/index.ts: interactionMode = resolveRuntimeInteractionMode(
        getWorkspaceInteractionMode(folder), { agentKind: 'main' })
  → ContainerInput.interactionMode
  → agent-runner:
       Claude 分支   promptPieces 换成 proactive 版本
       codex/grok    systemPromptAppend 换成 proactive 版本 + runtimeNote 改口径
  → Agent 每说一句就调 mcp__happyclaw__send_message
       → IPC data/ipc/{folder}/messages/*.json → 主进程投递（既有路径，不改）
  → turn 结束
       Claude:      publishResultCandidate 里 result = proactive ? null : finalText
       codex/grok:  runOneTurnRuntime 的 writeOutput 里同样裁决  ← 【关键】
  → 主进程 src/index.ts:
       publishesFrameworkAnswer(mode) === false ⇒ 不把 result 当成回复入库/发 IM
       isInteractionTurnSettled({ mode, healthyInputTurnCompleted, utteranceDelivered })
         proactive: 只要送出过一句话就算结算（不要求 SDK 正常终止）
         assistant: 两者都要
```

`runOneTurnRuntime` 的改动（`index.ts:2217-2227`）：

```ts
const proactive = usesProactiveInteractiveContract(containerInput);
writeOutput({
  status: result.status === 'success' ? 'success' : 'error',
  // 主动模式下最终文本是内部控制面，不是用户可见回复。
  result: proactive && result.status === 'success' ? null : result.result,
  error: result.error,
  errorClass: result.errorClass,              // ← 对齐 3 一起加
  providerFailure: isProviderFailure(result), // ← 对齐 3 一起加
  newSessionId: result.newSessionId,
  turnId: containerInput.turnId,
  sessionId: result.newSessionId || sessionId,
  sourceKind: result.status === 'success' ? 'sdk_final' : 'legacy',
  finalizationReason: result.status === 'success' ? 'completed' : 'error',
  runtimeContext: result.runtimeContext,
});
```

### 2.1.6 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| 工作区设了 proactive 但 Agent 一句 `send_message` 都不发 | 用户看到全空白，且 `isInteractionTurnSettled` 判为未结算 → 输入被重放 → **同一条消息无限重跑** | `isInteractionTurnSettled` 的 proactive 分支写成 `healthyInputTurnCompleted \|\| utteranceDelivered`——SDK 正常终止就算结算，即使没说话。这正是 upstream 那个 `\|\|` 的用意，**不能写成 `&&`** |
| codex/grok 单 turn re-spawn，`send_message` 的 IPC 结果在进程退出后才被主进程读到 | 消息丢失 | 既有 IPC 路径已经是"写文件 + 主进程 fs.watch"，进程退出不影响文件。但 `runOneTurnRuntime` 结束前要确保 `send_message` 的 IPC 回执已收到——它本来就是 `pollIpcResult` 同步等待的，无需改 |
| 定时任务落进 proactive | 任务结果不入库 | `resolveRuntimeInteractionMode` 的 `scheduledTask` 分支强制 `'assistant'`；`usesProactiveInteractiveContract` 再查一次 `isScheduledTask \|\| messageTaskId`。**两道门都要有**，因为 IPC 注入的任务消息会在 turn 中途改变 `messageTaskId` |
| spawn 子 Agent 落进 proactive | 子 Agent 的结论回不到父 Agent | `resolveRuntimeInteractionMode` 的 `agentKind === 'spawn'` 分支强制 `'assistant'` |

### 2.1.7 怎么验证

```
1. 建两个工作区，A=assistant，B=proactive，都绑同一个 Agent
2. 三条运行时 × 两个工作区 = 6 组，各发一条「查一下今天日期，然后告诉我」
   期望 A：Web 出现一条 Agent 回复（框架发布的最终文本）
   期望 B：Web 出现一条 Agent 回复（send_message 发的），且执行轨迹里
           最终 result 为 null
3. 在 B 里发「什么都别说」 → 期望：无回复，无重放，turn 正常结束
   （检查 logs 里同一 message id 不出现第二次）
4. 在 B 里建一个定时任务 → 期望：任务结果照常入库、照常发 IM
5. 在 B 里让 Agent 跑一个耗时工具 → 期望：先出现一条"我看一下"，
   再出现结果（两条独立消息，不是一条）
```

---

## 2.2 首响应看门狗接上（决策 30）

### 2.2.1 upstream 那个类为什么能直接搬

`container/agent-runner/src/sdk-control.ts` 73 行，里面 `SdkFirstResponseWatchdog` **与 SDK 零耦合**：

```ts
const FIRST_RESPONSE_MESSAGE_TYPES = new Set(['assistant', 'result', 'stream_event']);
export class SdkFirstResponseWatchdog {
  constructor(readonly timeoutMs: number, onTimeout: () => void)
  observe(messageType: string): void   // 只做 Set.has 判断
  clear(): void
}
```

唯一的 SDK 耦合是那个硬编码的 `FIRST_RESPONSE_MESSAGE_TYPES` 常量——它是 Claude SDK 的消息类型名。改成构造参数即可对三条运行时通用。

### 2.2.2 改哪些文件

| 文件 | 改动 |
|---|---|
| `container/agent-runner/src/sdk-control.ts` | **新增**（吸收 73 行），但把消息类型集合改成构造参数 |
| `container/agent-runner/src/index.ts` | Claude 分支按 upstream 接（`SDK_FIRST_RESPONSE_TIMEOUT_MS = 60_000`）；`runOneTurnRuntime` 新增一个 watchdog |
| `container/agent-runner/src/codex-cli-runner.ts` / `grok-cli-runner.ts` | 各暴露一个"已观察到首响应"的回调，或改由 `runOneTurnRuntime` 在 `emit` 拦截里判断 |

### 2.2.3 函数签名

```ts
// container/agent-runner/src/sdk-control.ts
export class FirstResponseWatchdog {
  constructor(
    readonly timeoutMs: number,
    /** 判定"模型已经开始响应"的消息/事件类型。Claude 传 SDK message.type，
     *  codex/grok 传归一化后的 StreamEvent.eventType。 */
    readonly responseTypes: ReadonlySet<string>,
    onTimeout: () => void,
  );
  observe(type: string): void;
  clear(): void;
}

/** Claude 侧的取值，与 upstream 一致 */
export const SDK_FIRST_RESPONSE_TYPES = new Set(['assistant', 'result', 'stream_event']);
/** codex / grok 侧：归一化 StreamEvent 里"模型真的开始产出了"的类型 */
export const RUNTIME_FIRST_RESPONSE_EVENT_TYPES = new Set([
  'text_delta', 'thinking_delta', 'tool_use_start', 'usage', 'init',
]);
```

`runSdkControlWithTimeout()`（同文件另一个导出）也一起吸收——它是"控制请求不得阻塞消息流"的通用包装，codex/grok 的 `session/new` 和 `initialize` 握手用得上。

### 2.2.4 codex 与 grok 的接法不同

**grok**：ACP 握手是三步（`initialize` → `session/new` → `session/prompt`），任何一步卡死都表现为"没有首响应"。在 `grok-cli-runner.ts` 的 `run()` 里，spawn 之后立刻起表；`GrokEventNormalizer` 每 emit 一个 StreamEvent 就 `observe(eventType)`。

**codex**：单进程 exec，事件从 stdout 的 JSONL 流出。在 `codex-cli-runner.ts` 里 spawn 后起表，`CodexEventNormalizer` 每 emit 一次 `observe`。

**统一接法（推荐）**：不改两个 runner，改 `runOneTurnRuntime` —— 它已经有 `emit` 的包装函数（`index.ts:2075-2096`），在里面拦一下就行：

```ts
// runOneTurnRuntime 内，adapter.run 之前
const watchdog = new FirstResponseWatchdog(
  RUNTIME_FIRST_RESPONSE_TIMEOUT_MS,      // grok/codex 冷启动慢，取 90_000
  RUNTIME_FIRST_RESPONSE_EVENT_TYPES,
  () => {
    log(`No ${adapter.runtime} response event within ${RUNTIME_FIRST_RESPONSE_TIMEOUT_MS}ms; marking provider unhealthy`);
    writeOutput({
      status: 'success', result: null, providerFailure: true,
      errorClass: 'network', finalizationReason: 'error',
      turnId: containerInput.turnId, sessionId,
    });
    abortController.abort();
  },
);
const emit = (output: ContainerOutput): void => {
  if (output.streamEvent?.eventType) watchdog.observe(output.streamEvent.eventType);
  // ...既有逻辑
};
// adapter.run(...).finally(() => { controlWatcher.close(); watchdog.clear(); })
```

**好处**：一处改动覆盖 codex + grok 两条，且不侵入两个结构不同的 runner。**代价**：只能观察到已 emit 的 StreamEvent，观察不到"CLI 进程还没起来"这种更早的阶段——但那一段由既有的 spawn 错误路径（`ENOENT` → `runtime_unavailable`）覆盖，不是盲区。

### 2.2.5 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| 超时值取小了，长 prompt 的冷启动被误杀 | 正常请求被当成 provider 故障、换号重试 | Claude 60s（upstream 已验证），codex/grok **取 90s**：两者都要 spawn CLI 进程 + 首次网络握手，观测到的冷启动尾部明显长于 SDK 常驻进程 |
| 超时后 `abort()` 但 CLI 进程不退 | 僵尸进程 | 既有 `abortController` 已经串到两个 runner 的 spawn kill 路径上（`grok-cli-runner.ts:367`、`codex-cli-runner.ts:737` 都有 cancelled 分支），不需额外改 |
| 超时与正常完成竞态 | 双份 output | `FirstResponseWatchdog` 内部的 `observed` 布尔 + `providerFailurePublished` 幂等标志双保险（后者要在 `runOneTurnRuntime` 里加一个局部变量） |

### 2.2.6 怎么验证

```
1. 人为制造卡死：把 grok 的 GROK_HOME/auth.json 换成过期 token 且不可刷新，
   或用 iptables/pf 把 x.ai 的出向丢包（不 reject，让它 hang）
   期望：90s 后日志出现 "No grok response event within 90000ms"，
        provider 被标不健康，池里有第二个号则自动换号重跑
2. 正常长任务：让 codex 跑一个 5 分钟的任务
   期望：首个 text_delta 在 90s 内到达 → watchdog clear → 后续不受影响
3. 池里只有一个 provider 时超时
   期望：终态是可见的失败提示，不是无限转圈（对齐 3 的 terminal 判定）
```

---

## 2.3 provider 降级分类接上（决策 31）

### 2.3.1 两个洞

**洞一：runner 从不上报 provider 失败。**

```
$ grep providerFailure container/agent-runner/src/
（零命中）
```

主进程侧唯一的判定是 `agent-output-parser.ts:244` 的 `isProviderFailureResult(parsed.result)`——**对 Claude 的额度提示措辞做正则匹配**。codex 撞额度、grok 撞额度，最终文本是别的措辞，永远匹配不上。结果：`providerPool.reportFailure()` 从不为 codex/grok 触发，池永远认为所有号健康，撞额度的号会被反复选中。

**洞二：`errorClass` 算了但丢了。**

两个 adapter 都调 `classifyRuntimeError()` 并把 `errorClass` 放进 `RuntimeRunResult`（`codex-cli-runner.ts:709/724/776`，`grok-cli-runner.ts:203/373/391`），`classifyRuntimeError` 甚至已经为 grok/x.ai 的措辞专门补了 quota / rate_limit 词表（`runtime-adapter.ts:130-147`）。但 `runOneTurnRuntime` 的三个 `writeOutput` 全都不带这个字段——**算完就扔**。

### 2.3.2 改哪些文件

| 文件 | 改动 | 约行 |
|---|---|---:|
| `container/agent-runner/src/types.ts` | `ContainerOutput` 加 `providerFailure` / `errorClass`（共同前置 A） | 4 |
| `container/agent-runner/src/runtime-adapter.ts` | 新增 `isProviderLevelFailure(errorClass)` | 12 |
| `container/agent-runner/src/index.ts` | `runOneTurnRuntime` 三处 `writeOutput` 带上两个字段 | 10 |
| `src/container-runner.ts` | `ContainerOutput` 声明加 `errorClass`；`providerFailure` 的处理分支加"分类日志" | 8 |
| `src/agent-output-parser.ts` | `parsed.providerFailure` 改成"runner 显式上报 **或** 文本匹配"，不再只靠文本 | 6 |
| `src/provider-failure.ts` | **新增**，吸收 upstream 36 行全部 | 36 |
| `src/container-runner.ts` | provider 失败后调 `resolveProviderFailureDisposition()` 决定"换号重试"还是"终态失败" | 25 |

### 2.3.3 函数签名

```ts
// container/agent-runner/src/runtime-adapter.ts
/**
 * 哪些错误类别应当把当前 provider 标记为不健康。
 *
 * 刻意排除 unsupported_model / permission / cancelled：换个号跑同样会失败，
 * 把号打成不健康只会白白耗尽池子。runtime_unavailable 也排除——那是本机
 * CLI 没装，与 provider 无关。
 */
export function isProviderLevelFailure(errorClass?: RuntimeErrorClass): boolean {
  return errorClass === 'quota'
      || errorClass === 'rate_limit'
      || errorClass === 'auth'
      || errorClass === 'network';
}
```

```ts
// src/provider-failure.ts（吸收 upstream 全文）
export const PROVIDER_FAILURE_USER_NOTICE: string;
export interface ProviderFailureHealth { profileId: string; healthy: boolean }
export interface ProviderFailureDisposition { retryElsewhere: boolean; terminal: boolean }
export function resolveProviderFailureDisposition(
  selectedProfileId: string | null,
  health: ProviderFailureHealth[],
): ProviderFailureDisposition;
```

### 2.3.4 数据流

```
codex/grok CLI 报错
  → adapter 内 classifyRuntimeError(err) → errorClass
  → RuntimeRunResult { status:'error', errorClass, error }
  → runOneTurnRuntime.writeOutput({
       status:'error', errorClass,
       providerFailure: isProviderLevelFailure(errorClass),   ← 新增
    })
  → stdout OUTPUT_MARKER
  → src/agent-output-parser.ts
       parsed.providerFailure ||= isProviderFailureResult(parsed.result)   ← 文本匹配降级为兜底
  → src/container-runner.ts onOutput 分支（1415 / 2284）
       providerPool.reportFailure(selectedProfileId, true)
       ↓ 新增
       const disp = resolveProviderFailureDisposition(
         selectedProfileId,
         providerPool.listHealth(poolIdForRuntime(input.runtime)),
       );
       disp.retryElsewhere → 换号重跑（既有路径）
       disp.terminal       → 向用户发 PROVIDER_FAILURE_USER_NOTICE，结束
```

**注意池的选择要按运行时分**：`providerPool` 是 `ProviderPoolManager`，`reportFailure(profileId, immediate)` 已经按 `providerPoolId` 分池（`src/provider-pool.ts:306`）。codex 池是 `'codex'`，grok 池是 `'grok'`（CLAUDE.md §8.14 已定"family / pool / runtime 全仓单一字符串 `grok`"）。`listHealth()` 若不存在需新增一个只读方法。

**决策 85（额度墙：同模型换账号，无则报错不降级）在这里落地**：`resolveProviderFailureDisposition` 只在**同一个池**里找健康候选，不跨池找 —— 也就是 grok 撞额度不会降级到 codex。这正是那 36 行的语义，不用额外写。

### 2.3.5 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| `classifyRuntimeError` 把一个业务错误误判成 `quota` | 好号被打成不健康 | 词表里的 `credit` / `subscription` 这类宽词有误伤风险。缓解：`ProviderPool.reportFailure(id, immediate=false)` 走"连续错误计数"而不是 `immediate=true` 一次即判；只有 `errorClass === 'quota'` 且消息里同时出现明确的额度措辞（现有 `isProviderFailureResult` 的逻辑）才 `immediate=true` |
| 池里所有号都被打成不健康 | 全线不可用 | 本地 `ProviderPool` 的健康状态是**纯内存**（CLAUDE.md §2.1），重启即恢复。另外 `resolveProviderFailureDisposition` 在无健康候选时返回 `terminal:true` → 用户看到明确提示，不是静默转圈 |
| runner 上报了 providerFailure，同时文本里也有 Claude 的额度措辞 | 双重触发 | `providerFailureReported` 布尔幂等（`src/container-runner.ts:1234`）已有 |
| `errorClass = 'network'` 被当成 provider 失败，但其实是本机断网 | 所有号轮流被打成不健康 | 这是可接受的：本机断网时任何号都跑不了，池全灭与实际相符；恢复网络后重启进程即恢复。**不加特殊处理**，避免为极端情况引入状态机 |

### 2.3.6 怎么验证

```
1. 单元：classifyRuntimeError 的 quota / rate_limit / auth 三类各造 3 条
   真实措辞（从 codex / grok 的实际错误日志里取），断言分类正确
2. 单元：resolveProviderFailureDisposition
   - 池 2 个号、当前号失败、另一个健康 → { retryElsewhere:true, terminal:false }
   - 池 1 个号 → { retryElsewhere:false, terminal:true }
3. 端到端：把 grok 的 auth.json 改坏（401）
   期望：一轮内出现 errorClass='auth' + providerFailure=true，
        provider_pool 里该号 healthy=false，
        有第二个号则自动重跑成功
4. 回归：Claude 撞额度的既有行为不变（文本匹配路径仍然有效）
5. 反例：让 codex 跑一个必然失败的模型名（unsupported_model）
   期望：providerFailure=false，号不被打成不健康
```

---

## 2.4 渠道上下文工具补齐（决策 26）

### 2.4.1 缺什么

upstream 的 MCP 工具集里有 `get_channel_context`，本地没有（本地 24 个工具里无此项）。

upstream 的 9 个飞书工具全部通过 `ChannelTurnContext` 拿身份（`ctx.channelContext.provider` / `.chat.id` / `.sender.openId`）；**本地是自己实现的**（决策 25「不吸收 upstream 飞书工具，保本地实现」），从 `ctx.chatJid` 反解（`mcp-tools.ts:1728-1735` 的 `feishuChatId()`）。这个选择本身没问题——`feishu:oc_xxx` 确实同时编码了 provider 和 chat id。

**但 Agent 拿不到的东西是**：

| 信息 | 本地能拿到吗 |
|---|---|
| 当前渠道是什么 | 能（从 chatJid 前缀，但要 Agent 自己解析字符串） |
| 当前 chat id | 能（同上） |
| **发言者是谁**（open_id / user_id / 名字） | **不能**。飞书群里 Agent 不知道刚才说话的是谁 |
| **消息 id / 线程 id / 父消息 id** | **不能**。想回复某条消息、想 @ 某人都做不到 |
| **bot 自己是谁**（app_id / open_id / 名字） | **不能**。`require_mention` 的判断在主进程做，Agent 侧无感知 |
| **本轮有哪些 @ 提及** | **不能** |
| **这个渠道支持什么能力** | **不能**。Agent 只能试了才知道 `feishu_send_card` 在 Telegram 会失败 |

这些正是决策 26「对齐原则」要补的。

### 2.4.2 改哪些文件

| 文件 | 改动 | 约行 |
|---|---|---:|
| `src/types.ts` | 新增 `ChannelTurnContext` 接口（吸收 upstream `types.ts:52` 那份） | 45 |
| `container/agent-runner/src/types.ts` | 同上 + `normalizeChannelTurnContext()`（吸收 upstream 89-130，约 60 行）+ `ContainerInput.channelContext` | 105 |
| `src/container-runner.ts` | `ContainerInput.channelContext?: ChannelTurnContext` | 2 |
| `src/index.ts` | 消息入队时构造 `ChannelTurnContext` 并塞进 input | 40 |
| 各渠道模块（`feishu.ts` / `telegram.ts` / `qq.ts` / `dingtalk.ts` / `wechat.ts` / `discord.ts` / `whatsapp.ts`） | 各自把已有的原始消息字段映射成 `ChannelTurnContext`（**这是主要工作量**：七个渠道各约 25 行） | 175 |
| `container/agent-runner/src/mcp-tools.ts` | 新增 `get_channel_context` 工具（吸收 upstream 324-346，23 行） | 23 |
| `container/agent-runner/src/index.ts` | IPC 注入的后续消息也要更新 `channelContext`（对应现在 2344-2347 更新 `mcpToolsConfig.chatJid` 那段） | 12 |

### 2.4.3 三条运行时全通的原因

`get_channel_context` 定义在 `createMcpToolCatalog()`（`mcp-tools.ts` 的运行时中立层，CLAUDE.md §2.3 明确 "Claude 经 SDK `createSdkMcpServer()` 同进程注册，Codex/Grok 经独立进程 `happyclaw-mcp-server.js` 复用同一 catalog"）。所以**加一个 `defineTool` 就三条全有**，不需要各写一份。

但 `ctx.channelContext` 的传递路径两条不同：

```
Claude:      ContainerInput → createMcpTools(ctx) 同进程闭包            【已有机制】
codex/grok:  ContainerInput → writeMcpContext(input) 写 context JSON 文件
             → happyclaw-mcp-server.js 从 argv 读文件                    【已有机制】
```

所以 `writeMcpContext()`（`codex-cli-runner.ts:94`）要把 `channelContext` 一起写进 context 文件。这是 3 行。

### 2.4.4 安全边界

`normalizeChannelTurnContext()` 那 60 行**不是样板代码**，它是凭据边界：

> "Enforce the credential-free runner boundary ... Unknown keys (including token/secret-like data) are intentionally discarded instead of being forwarded to the model."

它用白名单重建对象（`optionalString()` 逐字段取），任何未列出的 key 一律丢弃。这意味着渠道模块即使不小心把 `tenant_access_token` 塞进上下文对象，也到不了模型手里。**这 60 行必须原样吸收，不能简化成 `{...raw}`。**

配套的一条约束写进 CLAUDE.md §10：**渠道模块构造 `ChannelTurnContext` 时只填白名单字段；新增字段必须同时改 `normalizeChannelTurnContext`，否则会被静默丢弃**（这是 fail-closed，正确方向）。

### 2.4.5 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| 某渠道没实现映射 | `channelContext` 为 undefined | `currentChannelContext()` 里 `normalizeChannelTurnContext(undefined, ctx.chatJid)` 会用 chatJid 兜出 `{ provider, sourceJid }` 最小对象。工具返回的 JSON 里 `capabilities: []` —— Agent 看到空能力列表就不会去调渠道专用工具。**降级是安全的** |
| Agent 拿到 `sender.openId` 后去调不该调的 API | 越权 | `feishu_get_user` 等工具的目标由主进程固定（"The host fixes the target to the verified sender"），Agent 传什么 open_id 都不生效 |
| IPC 注入的后续消息来自另一个渠道（主容器 Web+IM 混用） | 上下文串台 | 与现有 `mcpToolsConfig.chatJid` 的更新逻辑（`index.ts:2344`）对称处理：取最后一条带 `sourceJid` 的消息，同时更新 `channelContext` |

### 2.4.6 怎么验证

```
1. 七渠道各发一条消息，让 Agent 调 get_channel_context 并把结果原样回显
   期望：provider / chat.id / sender 三项非空（Web 渠道 sender 可空）
2. 凭据边界：在 feishu.ts 里临时塞一个 { secret: 'x' } 进上下文对象
   期望：工具返回的 JSON 里没有 secret 字段（normalize 丢弃）
3. 三运行时对称：同一个飞书群，Claude / Codex / Grok 各调一次
   期望：三次返回的 JSON 结构相同（值可不同，字段集必须相同）
4. 降级：Web 渠道调用
   期望：返回 { provider:'web', sourceJid:'web:main', capabilities:[] }，不报错
```

---

## 2.5 Grok 上下文水位接上（决策 32）

### 2.5.1 现状

`container/agent-runner/src/grok-event-normalizer.ts:307-309`：

```ts
case 'usage_update':
  // 上下文水位，绝不落库（用量真身在 session/prompt 响应 _meta）
  return {};
```

这个注释的**前半句是对的**（不能落库，否则 `usage_update` 的累积值会和 `session/prompt` 响应的 `_meta` 重复计费），**后半句遗漏了**：ACP 的 `UsageUpdate` 除了成本还带上下文水位，那部分与计费无关。

ACP SDK 的定义（`@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:3894`）：

```ts
export type UsageUpdate = {
  used: number;   // Tokens currently in context.
  size: number;   // Total context window size in tokens.
  cost?: Cost | null;   // Cumulative session cost (optional).
  _meta?: {...} | null;
};
```

`used` / `size` 就是水位，`cost` 才是要避开的那部分。

### 2.5.2 Claude 侧的对照：水位现在去哪了

Claude 通过 SDK 的 `getContextUsage()` 拿到 `SdkContextUsage { totalTokens, maxTokens, percentage, memoryFiles, skills, systemPromptSections }`（`index.ts:151-163`），但：

- `percentage` 只进了**日志**（`index.ts:1794`），没进 StreamEvent
- `enrichContextAudit()` 把 `memoryFiles` / `skills` 塞进 `ClaudeContextAudit`，但 `ClaudeContextAudit`（`shared/stream-event.ts:66-76`）**没有 totalTokens/maxTokens/percentage 字段**

所以「Claude 有水位、Grok 没有」这个说法不完全准确——**Claude 的水位也只进了日志**。要"接上"就得两边一起接，否则 Grok 接上了反而比 Claude 多。

### 2.5.3 设计：给 `ClaudeContextAudit` 加一个 `window` 子对象

```ts
// shared/stream-event.ts（单一真相源，改完跑 make sync-types 同步四份副本）
export interface ClaudeContextWindowAudit {
  /** 当前上下文占用 token 数。 */
  usedTokens: number;
  /** 上下文窗口总量。0 表示运行时未上报。 */
  maxTokens: number;
  /** usedTokens / maxTokens，0-100。maxTokens 为 0 时也是 0。 */
  percentage: number;
}

export interface ClaudeContextAudit {
  // ...既有字段
  /** 上下文水位。三条运行时都可上报：Claude 取自 SDK getContextUsage，
   *  Grok 取自 ACP usage_update，Codex 暂无来源（保持 undefined）。 */
  window?: ClaudeContextWindowAudit;
}
```

**为什么放进 `context_audit` 而不是新增一个 StreamEventType**：`context_audit` 已经在 `turn-trace.ts:50` 的持久化白名单里、已经在 `web.ts:2449` 的快照里、已经在 `TurnTracePanel` 里有「上下文」标签（`TurnTracePanel.tsx:55`）。加字段是零新增管道；加事件类型要动四个文件 + 前端 store 两个 switch（CLAUDE.md §11「新增 StreamEvent 类型」四步）。

**类型名保留 `Claude` 前缀**是刻意的：这个接口已被三处副本引用，改名会撞进 `make typecheck` 的同步校验，收益为零。在注释里写清它是三运行时通用的。

### 2.5.4 改哪些文件

| 文件 | 改动 | 约行 |
|---|---|---:|
| `shared/stream-event.ts` | 加 `ClaudeContextWindowAudit` + `ClaudeContextAudit.window` | 14 |
| （`make sync-types`） | 自动同步到 `src/` / `web/src/` / `container/agent-runner/src/` 三份副本 | 0 |
| `container/agent-runner/src/grok-event-normalizer.ts` | `usage_update` 分支改成上报水位、仍不上报 cost | 22 |
| `container/agent-runner/src/index.ts` | Claude 分支：`enrichContextAudit()` 里把 `ctxUsage.totalTokens/maxTokens/percentage` 填进 `audit.window` | 8 |
| `web/src/components/chat/TurnTracePanel.tsx` | 「上下文」行显示 `62% (124k/200k)` | 10 |

### 2.5.5 grok 侧的具体改法

```ts
// grok-event-normalizer.ts
case 'usage_update': {
  // cost 是累计计费，用量真身在 session/prompt 响应的 _meta，此处绝不上报，
  // 否则同一个 turn 会被计两遍。但 used/size 是上下文水位，与计费无关。
  const used = Number(u.used ?? 0) || 0;
  const size = Number(u.size ?? 0) || 0;
  if (size <= 0) return {};
  emit({
    status: 'stream',
    result: null,
    streamEvent: {
      eventType: 'context_audit',
      contextAudit: {
        ...state.contextAuditBase,        // 由 run() 从 ContainerInput.contextAudit 传入
        window: {
          usedTokens: used,
          maxTokens: size,
          percentage: Math.round((used / size) * 1000) / 10,
        },
      },
    },
  });
  return {};
}
```

`GrokEventNormalizerState` 加一个 `contextAuditBase: ClaudeContextAudit`，由 `grok-cli-runner.ts` 的 `run()` 从 `input.input.contextAudit` 取。若 `contextAudit` 为 undefined（主进程没算），就构造一个最小对象只带 `window`——`ClaudeContextAudit` 的必填字段（`executionMode` / `claudeMd` / `rules` / `skills` / `happyclawPrompt` / `warnings`）都可以给空值。

**节流**：ACP 的 `usage_update` 可能每个 chunk 来一次。加一个"只在 percentage 变化 ≥ 1 或距上次 emit ≥ 5s 才发"的门，否则一个长 turn 会往执行轨迹里塞几百行（`turn_events` 会持久化 `context_audit`）。

```ts
// state 里加
lastWindowPercentage: number;
lastWindowEmitAt: number;
```

### 2.5.6 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| grok 上报 `size: 0` | 除零 | `if (size <= 0) return {}` 直接跳过 |
| `usage_update` 高频 | `turn_events` 表暴涨 | 上面的节流门。另外可以考虑把 `context_audit` 从 `PERSISTED_EVENT_TYPES` 里降级成"每 turn 只留最后一条"——但那要改 `turn-trace.ts` 的去重逻辑，**本项不做**，节流已经够 |
| `cost` 字段被误上报 | 重复计费 | 代码里根本不读 `u.cost`。加一条单测断言："给 usage_update 塞 cost，emit 出来的事件里不含任何 usage 字段" |
| Codex 没有水位来源 | 三运行时不对称 | `window` 是可选字段，Codex 保持 undefined。前端「上下文」行在无 window 时不显示百分比。**这不是缺陷**——codex CLI 的 JSONL 事件流确实没有窗口水位，硬造一个估算值比留空更糟 |

### 2.5.7 怎么验证

```
1. 单测（grok-event-normalizer.test.ts，现有 21 个用例的第 22-25 条）：
   - usage_update { used:1000, size:10000 } → emit 一条 context_audit，
     window = { usedTokens:1000, maxTokens:10000, percentage:10 }
   - usage_update { used:1000, size:0 } → 不 emit
   - usage_update { used:1000, size:10000, cost:{...} } → emit 的事件里
     不含 usage 字段（断言 streamEvent.usage === undefined）
   - 连续 10 条 percentage 差 <1 的 usage_update → 只 emit 1 条
2. 端到端：grok 跑一个长对话，Web 执行轨迹的「上下文」行应随对话增长
3. 对称：Claude 同一个工作区跑同样长的对话，「上下文」行也应显示
4. 回归：用量入库不变（grok 的 usage_records 行数与改前一致，
   input/cacheRead 分列值不变）
```

---

## 2.6 codex/grok 补工具结果事件（决策 33）

### 2.6.1 现状：两条运行时各缺一半

**codex**（`codex-cli-runner.ts:425-486`）识别四种 item type，全部映射成通用工具事件：

```
command_execution → toolName 'Bash'
mcp_tool_call     → toolName 'mcp__{server}__{tool}'
file_change       → toolName 'apply_patch'
web_search        → toolName 'web_search'
```

三个生命周期：`started` → `tool_use_start`、`updated` → `tool_progress`、其余 → `tool_use_end`。

**问题在 `tool_use_end`（478-486）**：

```ts
streamEvent: {
  eventType: 'tool_use_end',
  toolName, toolUseId,
  toolInputSummary: codexToolSummary(item),   // ← 这是【输入】的回显，不是结果
}
```

`codexToolSummary()`（`codex-cli-runner.ts:313-333`）返回的是命令行 / 文件路径 / 查询词——**输入**。工具真正返回了什么（stdout、diff、MCP 响应）在 `updated` 阶段以 `tool_progress` 流过，但 `tool_progress` **不在** `turn-trace.ts` 的 `PERSISTED_EVENT_TYPES`… 实际上它在（第 38 行）。但它的 payload 只带 `toolInputSummary`，前端 `TurnTracePanel.tsx:73-74` 读的是 `toolResultSummary` / `toolResult`。所以刷新页面后，codex 的执行轨迹显示"Bash 执行了 `ls -la`"，看不到输出。

**grok**（`grok-event-normalizer.ts:243-256`）好一些：`tool_call_update` 在 `completed`/`failed` 时发 `tool_use_end` 并带 `toolResult: contentBlocksToText(u.content)`。但**没有发 `tool_result` 事件**，而 Claude 侧是发的（`stream-processor.ts:1157` / `1269`）。

于是三条运行时的执行轨迹形状不一致：

| | `tool_use_start` | `tool_progress` | `tool_use_end` | `tool_result` |
|---|---|---|---|---|
| Claude | ✓ | ✓ | ✓ | ✓（带 toolResult） |
| Codex | ✓ | ✓（内容在 toolInputSummary 里，字段名错） | ✓（toolResult **缺失**） | ✗ |
| Grok | ✓ | ✓ | ✓（带 toolResult） | ✗ |

### 2.6.2 设计原则：统一在 `tool_use_end` 之后补发 `tool_result`

不改 `tool_use_end` 的既有语义（它是"工具调用结束"的生命周期信号），而是在它之后补一条 `tool_result`，与 Claude 侧对齐。

```ts
// container/agent-runner/src/runtime-adapter.ts（新增共享辅助，两个 runner 都用）
/**
 * 在 tool_use_end 之后补发 tool_result。
 *
 * Claude 侧由 StreamEventProcessor 从 SDK 的 tool_result block 提取；
 * codex/grok 的事件流没有独立的 result block，结果混在生命周期事件的
 * content 里，所以由 normalizer 显式补发。两条路径产出的 StreamEvent
 * 形状必须一致，否则执行轨迹面板要为运行时写分支。
 */
export function emitToolResult(
  emit: RuntimeEmit,
  args: { toolUseId: string; toolName: string; result: string; isError?: boolean },
): void {
  const shown = truncateToolResult(args.result);   // 与 stream-processor 同一个上限
  if (!shown) return;
  emit({
    status: 'stream',
    result: null,
    streamEvent: {
      eventType: 'tool_result',
      toolUseId: args.toolUseId,
      toolName: args.toolName,
      toolResult: shown,
      ...(args.isError ? { displayLevel: 'error' as const } : {}),
    },
  });
}
```

`truncateToolResult` 的上限要与 `stream-processor.ts` 里 Claude 侧用的那个常量取同一个值——不同上限会让"同一个工具在不同运行时下截断位置不同"，排查时很误导。查出 Claude 侧的常量后提到 `utils.ts` 共用。

### 2.6.3 codex 的改法

`codex-cli-runner.ts` 需要**攒结果**：`command_execution` 的输出在 `updated` 事件的 `aggregated_output` 里累积，`completed` 事件不一定重复带全量。

```ts
// CodexEventNormalizerState 加
toolResults: Map<string, { toolName: string; text: string }>;
```

```
started   → tool_use_start；toolResults.set(id, { toolName, text: '' })
updated   → tool_progress（保持现状）
            + toolResults.get(id).text = <本次的完整聚合输出>
              command_execution: item.aggregated_output（累积量，直接覆盖）
              mcp_tool_call:     contentBlocksToText(item.result?.content)
              file_change:       codexToolSummary(item)（diff 摘要）
              web_search:        item.results 摘要
completed → tool_use_end（保持现状）
            + emitToolResult(emit, { toolUseId: id, toolName,
                result: toolResults.get(id)?.text ?? '',
                isError: item.status === 'failed' })
            + toolResults.delete(id)
```

`web_search` 现在的 `updated` 分支走 `codexToolSummary(item)` 返回 `item.query`——也是输入。要补一个 `results` 摘要提取。

### 2.6.4 grok 的改法

grok 已经有 `toolResult`，只需在 `tool_use_end` 之后补一条：

```ts
// grok-event-normalizer.ts，tool_call_update 的 completed/failed 分支
if (st === 'completed' || st === 'failed') {
  const resultText = contentBlocksToText(u.content);
  emit({ /* tool_use_end，保持现状 */ });
  emitToolResult(emit, {
    toolUseId: id, toolName, result: resultText, isError: st === 'failed',
  });
  state.toolCalls.delete(id);
}
```

**grok 的一个额外坑**：它把 MCP / 间接工具包成 `use_tool`，真名在 `rawInput.tool_name`（CLAUDE.md §8.14），`unwrapTool()` 已经解包。补发 `tool_result` 时要用解包后的 `toolName`（`state.toolCalls.get(id).toolName`），不是 `'use_tool'`——否则轨迹里所有 MCP 调用都显示成同一个名字。

### 2.6.5 改哪些文件

| 文件 | 改动 | 约行 |
|---|---|---:|
| `container/agent-runner/src/utils.ts` | `truncateToolResult()` 从 `stream-processor.ts` 提出来共用 | 8 |
| `container/agent-runner/src/runtime-adapter.ts` | `emitToolResult()` | 24 |
| `container/agent-runner/src/codex-cli-runner.ts` | `toolResults` map + 三个生命周期分支 + `web_search` 结果提取 | 45 |
| `container/agent-runner/src/grok-event-normalizer.ts` | completed/failed 分支补发 | 10 |
| `container/agent-runner/src/stream-processor.ts` | 改用共用的 `truncateToolResult` | 3 |

### 2.6.6 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| 大输出（一次 `find /` 几 MB）进 `turn_events` | 数据库暴涨 | `turn-trace.ts` 已有两道：`INLINE_PAYLOAD_LIMIT = 8KB` 超出溢写文件（第 62 行），以及 `truncateToolResult` 在 runner 侧先截。两道都要有——溢写文件也占盘 |
| `updated` 事件不来（工具秒完） | `toolResults` 里是空串，`emitToolResult` 直接 return | 正确降级：轨迹里只有 start/end，没有 result 行。比发一条空 result 好 |
| `completed` 之后又来 `updated` | map 已删，`get` 返回 undefined | `?? ''` 兜底，不抛 |
| 同一个 toolUseId 被复用 | 串台 | codex 的 `item.id` 和 grok 的 `toolCallId` 都是单 turn 内唯一。单 turn re-spawn 模型下进程也不跨 turn，map 天然清空 |

### 2.6.7 怎么验证

```
1. 单测（codex + grok 各 4 条）：
   - started/updated/completed 三事件 → 恰好一条 tool_result，内容 = 聚合输出
   - started/completed（无 updated）→ 零条 tool_result
   - completed 且 status=failed → tool_result 带 displayLevel='error'
   - grok 的 use_tool 包装 → tool_result 的 toolName 是解包后的真名
2. 端到端：三条运行时各跑一次「读 package.json 并告诉我版本号」
   期望：执行轨迹里都能看到 Read 的返回内容，且三者形状一致
3. 刷新页面（走 turn_events 回放）后内容仍在
4. 大输出：跑 `find / -name '*.ts' | head -100000`
   期望：轨迹里是截断后的内容 + 截断标记，数据库单行不超 8KB
```

---

## 2.7 人格注入补进 codex/grok（决策 27）

### 2.7.1 现状

批次 5 的 commit message 写的是"接入 promptPieces 首位，而 systemPromptAppend 由 promptPieces 拼成并同时传给 Claude / Codex / Grok —— 一处改动三条运行时全覆盖"。**这个描述与代码不符。**

代码事实：

```
container/agent-runner/src/index.ts
  1237  async function runQuery(...)            ← Claude 专用
  1470    const personaBlock = buildPersonaBlock(containerInput);   ← 唯一调用点
  1475    const promptPieces = [ ...(personaBlock ? [...] : []), ... ]
  1500    const systemPromptAppend = promptPieces.map(p => p.text).join('\n')

  2231  async function main()
  2361    if (runtime === 'codex' || runtime === 'grok') {
  2372      const systemPromptAppend = [ ...另一个数组，不含 persona... ]
  2405      await runOneTurnRuntime(adapter, { systemPromptAppend, ... })
  2414      return;                                                  ← 提前 return
```

两个 `systemPromptAppend` 是**两份独立的数组**，codex/grok 那份从来没有 persona。`grep -rn "buildPersonaBlock"` 全仓两处命中：定义 1 处，调用 1 处（1470）。

### 2.7.2 设计：抽一个共享的 prompt piece 构造器

不是"在 codex/grok 分支也调一次 `buildPersonaBlock`"——那样两个数组还是各自维护，下次加 piece 又会漏一边。

```ts
// container/agent-runner/src/index.ts（或提到新文件 prompt-plan.ts）
interface PromptPiece { name: string; text: string }

/**
 * 三条运行时共享的 prompt piece 序列。
 *
 * 差异由 runtime 参数表达，不由调用点各自拼数组 —— 上一轮就是因为两个调用点
 * 各拼一份，persona 只进了 Claude 那份。
 */
function buildPromptPieces(
  containerInput: ContainerInput,
  opts: {
    runtime: 'claude' | 'codex' | 'grok';
    memoryRecall: string | null;
    memoryPromptName: string | null;
    disableMemoryLayer: boolean;
    isHome: boolean;
  },
): PromptPiece[];
```

序列（`runtime` 只影响标注 ⚙ 的几项）：

| # | piece | claude | codex | grok |
|---|---|---|---|---|
| 1 | `agent-persona`（`buildPersonaBlock`） | ✓ | ✓ | ✓ |
| 2 | `interaction.md` | ✓ | ✓ | ✓ |
| 3 | `skill-routing.md` ⚙ | 基础版 | + `CODEX_SKILL_FILE_GUIDELINES` + `buildCodexSkillContext()` | 同 codex |
| 4 | `security-rules.md` | ✓ | ✓ | ✓ |
| 5 | `global-memory` | ✓ | ✓ | ✓ |
| 6 | `memory-system.{home,guest}.md` | ✓ | ✓ | ✓ |
| 7 | `codex-memory-lifecycle` ⚙ | — | ✓ | ✓ |
| 8 | `guidelines`（`buildGuidelinesBlock(runtime)`）⚙ | 除非 persona replace | 除非 persona replace | 同 |
| 9 | `happyclaw-tools` ⚙ | — | ✓ | ✓ |
| 10 | `channels/{ch}.md` | ✓ | ✓ | ✓ |
| 11 | `agent-override.md`（有 agentId 时） | ✓ | ✓ | ✓ |
| 12 | `output.{assistant,proactive,task}.md` ⚙ | ✓ | ✓ | ✓ |（对齐 1 带进来） |
| 13 | `delivery-contract.{assistant,proactive}.md` ⚙ | ✓ | ✓ | ✓ |（对齐 1 带进来） |
| 14 | `runtime-note` ⚙ | — | ✓ | ✓ |

**关键：第 8 项的 `replace` 语义要在三条运行时都成立。** 本地 Claude 分支已经实现（`index.ts:1490-1492`），codex/grok 分支现在无条件 `buildGuidelinesBlock(runtime)`（2385）。抽出来之后自动对齐。

### 2.7.3 改哪些文件

| 文件 | 改动 | 约行 |
|---|---|---:|
| `container/agent-runner/src/index.ts` | 新增 `buildPromptPieces()`；`runQuery` 里 1475-1499 替换成一次调用；codex/grok 分支 2372-2396 替换成一次调用 | 净增约 25（新函数约 75，删掉两个数组约 50） |

**只改一个文件。** 这是八项里最小的一项，也是收益最直接的一项——`agent-persona.ts`、`ContainerInput.agentProfile`、`resolveAgentProfileForInput` 全部已就位，纯粹是接线漏了。

### 2.7.4 三条运行时的注入通道

`systemPromptAppend` 拼好后：

| 运行时 | 注入方式 | 位置 |
|---|---|---|
| Claude | SDK `options.systemPrompt`（`{ type:'preset', append }`）或整体替换 | `index.ts` runQuery 内 |
| Codex | CLI 参数（`runOneTurnRuntime` → `codexCliAdapter.run({ systemPromptAppend })`） | `codex-cli-runner.ts` |
| Grok | ACP `session/new` 的 `_meta.rules`（**追加**，不用 `systemPromptOverride`，见 CLAUDE.md §8.14） | `grok-cli-runner.ts` |

三条都已存在，不需要改。

### 2.7.5 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| `promptMode='replace'` 时 grok 丢掉了自己的原生工具/sandbox 提示 | grok 不会用自己的工具 | grok 的注入是 `_meta.rules` **追加**，本来就不覆盖原生提示（§8.14 已定）。`replace` 只让 HappyClaw 自己的 `guidelines` 块让位，不影响 grok 原生。**这一点要写进 `buildPromptPieces` 的注释**，否则将来有人会误以为 `replace` 在 grok 上失效 |
| 抽函数时漏了某个 piece | 某条运行时静默少一段提示 | 抽完后加一个单测：对同一个 `ContainerInput`，三次调用 `buildPromptPieces` 的 `name` 序列做快照断言。少了哪一段一眼看出 |
| persona 加长了 prompt，codex/grok 撞上下文 | 首轮就 overflow | 四段各 20000 字符上限（`AGENT_PROMPT_SECTION_MAX_LENGTH`）→ 最坏 80k 字符 ≈ 20k~30k token。codex/grok 的窗口都远大于此。**但要在 `buildPromptPieces` 里加一句 `log()` 报告总字节数**，与现有 `HAPPYCLAW_DUMP_PROMPT` 配合排查 |
| 决策 89（仓库文档污染人格）未修就先接人格 | 人格块之后紧跟着一堆项目 README 内容，模型更困惑 | 阶段 1.1 已经安排在合并之前修。**顺序不能倒**：先修污染，再接人格 |

### 2.7.6 怎么验证

```
1. 单测：三条运行时的 piece name 序列快照（含 persona 在首位）
2. 单测：promptMode='replace' 时，三条运行时的序列都不含 'guidelines'
3. 单测：无 agentProfile 时，三条运行时的序列都不含 'agent-persona'，
   且与改动前逐字相同（回归保护）
4. 端到端：建一个 SOUL 段写「你只用文言文回答」的 Agent，挂到工作区，
   三条运行时各问一句 → 三条都应该用文言文
5. 端到端：HAPPYCLAW_DUMP_PROMPT=true 跑一次 codex，
   在 logs 里肉眼确认 <agent-persona> 块存在且在最前
```

---

## 2.8 MCP 权限策略对三条运行时生效（决策 28）

### 2.8.1 现状：三条独立代码路径，两条完全不读策略

```
Claude:
  主进程 ensureSettingsJson(settingsFile, loadUserMcpServers(ownerId))   ← 全量，无策略
    → SDK 读 CLAUDE_CONFIG_DIR/settings.json

Codex:
  codex-cli-runner.ts:167 loadUserMcpServers()
    ← env HAPPYCLAW_USER_MCP_SERVERS_JSON（只在 disableMemoryLayer 时才注入！）
    ← fallback: CLAUDE_CONFIG_DIR/settings.json
    + loadWorkspaceMcpServers(cwd)  ← {cwd}/.claude/settings.json
    → buildCodexConfigObject() 的 mcp_servers

Grok:
  grok-cli-runner.ts:82 loadExternalMcpServers(cwd)  ← 同上两个来源
    → buildAcpMcpServers() → ACP session/new 的 mcpServers[]
```

**三个问题**：

1. 策略在任何一条上都不生效（第一节 1.0 已确认 `runtime_policy` 是死列）。
2. `HAPPYCLAW_USER_MCP_SERVERS_JSON` 只在 `disableMemoryLayer === true` 时注入（`container-runner.ts:2085-2095`），常规路径下 codex/grok 走 settings.json fallback。
3. `ensureSettingsJson` 是 **deep-merge**（`container-runner.ts:196`：`merged.mcpServers = { ...existingMcp, ...mcpServers }`），删掉的 server 在 session 目录的旧 settings.json 里**永久残留**。策略生效后这会变成安全洞：策略把 server 移出白名单，settings.json 里那份还在，codex/grok 的 fallback 照读不误。

### 2.8.2 设计：主进程算白名单，放进 ContainerInput，三条运行时都以它为准

第一节 1.6.2 已经交付了 `resolveRuntimeMcpServers()` 和两个 ContainerInput 字段。本项负责让三条运行时消费它。

```ts
// container/agent-runner/src/types.ts
export interface ContainerInput {
  // ...
  /** 主进程按 AgentProfile.runtime_policy.mcp 算好的、本轮允许的 MCP server 全集。
   *  存在时它是唯一真相：运行时不得再读 settings.json / .mcp.json 兜底。
   *  为 undefined 时（老主进程 / 单测）保持既有 fallback 行为。 */
  resolvedMcpServers?: Record<string, Record<string, unknown>>;
  /** 上面那份 map 的 hash + 排序 id 列表，进执行轨迹用于排查"策略是否生效"。 */
  mcpManifest?: { hash: string; serverIds: string[] };
}
```

三条运行时的改法：

| 运行时 | 改哪 | 改法 |
|---|---|---|
| Claude | `container-runner.ts` 主进程侧 | `ensureSettingsJson(settingsFile, resolveRuntimeMcpServers(group, agentProfile), { replaceMcpServers: true })`。**`replaceMcpServers` 是本项的必需品**，见 2.8.1 问题 3 |
| Codex | `codex-cli-runner.ts:248-257`（`buildCodexConfigObject`）+ `buildCodexConfigArgs` | `const external = input.input.resolvedMcpServers ?? { ...loadUserMcpServers(), ...loadWorkspaceMcpServers(cwd) };` 两个装配点（`-c` 参数版和 config 对象版）都要改 |
| Grok | `grok-cli-runner.ts:126`（`buildAcpMcpServers`） | 同上：`const external = resolvedMcpServers ?? loadExternalMcpServers(cwd);` |

两个装配函数的签名都要加一个参数：

```ts
export function buildCodexConfigObject(
  contextPath: string,
  cwd: string,
  resolvedMcpServers?: Record<string, Record<string, unknown>>,
): Record<string, unknown>;

export function buildAcpMcpServers(
  contextPath: string,
  cwd: string,
  resolvedMcpServers?: Record<string, Record<string, unknown>>,
): McpServer[];
```

`happyclaw` 这个 first-class server **永远不受策略约束**——它是框架自己的桥（`send_message` / 任务工具 / 记忆工具全在里面），策略管的是用户自配的外部 MCP。三处装配代码里已有的 `if (name === 'happyclaw') continue;` 去重保持不变，最后无条件 push 一个 happyclaw。

### 2.8.3 数据流

```
AgentProfile.runtime_policy.mcp = { mode:'custom', ids:['user:notion','system:github'] }
  → 主进程 resolveRuntimeMcpServers(group, agentProfile)
       loadManagedMcpLayers(ownerId, { allowAdminOnlySystemMcp: role==='admin' })
         layers.user   = 用户自配的全部 enabled server
         layers.system = 系统级 server（本地暂空，见 1.2.1）
       resolveManagedMcpPolicy(layers, policy)
         custom → 只取 ids 命中的；missing 记录不存在的引用
       loadClaudeContextMcpServers({ workspaceDir, externalClaudeDir, includeHostClaudeContext })
         → 项目级 .mcp.json / .claude/settings.json 【不受策略约束】
       mergeMcpServerLayers(context, managed)
  → ContainerInput.resolvedMcpServers
  → Claude:  写进 session settings.json（replace 语义）
     Codex:  buildCodexConfigObject 的 mcp_servers
     Grok:   ACP session/new 的 mcpServers[]
  → mcpManifest.hash 进 context_audit（对齐 5 已经把 context_audit 打通）
```

**为什么项目级 MCP 不受策略约束**：见 1.2.2。`.mcp.json` 是工作区自己的东西，不是给某个 Agent 的授权；策略只收窄 HappyClaw 管理的那一层。

### 2.8.4 缺失引用的处置

`resolveManagedMcpPolicy` 返回 `{ servers, missing }`。`missing` 非空说明策略引用了不存在的 server（用户删了它但没改策略）。

upstream 在 `container-runner.ts:636` 的做法是 **抛错**：

```
`agent_profile_unavailable: AgentProfile ${id} requires unavailable MCP server(s): ${missing.join(', ')}`
```

**本节沿用抛错，不降级为警告。** 理由：MCP 策略是权限收窄，`mode: 'custom'` 表达的是"这个 Agent 只能用这几个"。如果其中一个不存在就静默跳过，用户以为授权了 3 个、实际生效 2 个，且没有任何提示——这正是决策 28 归类为"安全问题"的原因。

抛错的落点在 `resolveAgentProfileForInput()` 的外层，即两条 spawn 路径。turn 直接失败，Web 端显示明确原因。同时 `PATCH /api/agent-profiles/:id` 已经在保存时用 `validateRuntimePolicyReferences()` 拦了一道（1.1.1），所以运行时抛错只会发生在"保存之后 server 被删"这一种情况。

### 2.8.5 改哪些文件

| 文件 | 改动 | 约行 |
|---|---|---:|
| `container/agent-runner/src/types.ts` | 两个字段 | 6 |
| `src/container-runner.ts` | `ContainerInput` 两个字段；`ensureSettingsJson` 加 `replaceMcpServers` 选项；两条 spawn 路径注入 | 35（其中 `resolveRuntimeMcpServers` 已计入第一节 1.6.2） |
| `container/agent-runner/src/codex-cli-runner.ts` | 两个装配点 | 14 |
| `container/agent-runner/src/grok-cli-runner.ts` | 一个装配点 | 8 |
| `container/agent-runner/src/index.ts` | codex/grok 分支把 `resolvedMcpServers` 传给 `runOneTurnRuntime` → adapter | 6 |

### 2.8.6 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| `resolvedMcpServers` 为 `{}`（策略 `disabled`） | codex/grok 只剩 happyclaw | 这是正确行为。但要区分 `{}`（策略禁用全部）和 `undefined`（主进程没算）——**用 `??` 而不是 `\|\|`**，`{}` 是 truthy 但 `\|\| ` 对 `{}` 不生效…… 实际上 `{} \|\| x` 返回 `{}`，两者行为相同。仍然写 `??`，语义更准 |
| 主进程算了、runner 版本旧（不认这个字段） | 静默走 fallback，策略失效 | 容器镜像与主进程同版本部署（`./container/build.sh`）。加一条防御：主进程注入 `resolvedMcpServers` 时同时在 `contextAudit.warnings` 里不写东西，但 runner 侧消费到之后 `log()` 一行 `MCP policy applied: {n} servers ({hash})`。部署后在日志里能确认 |
| session 目录的旧 settings.json 残留 | 策略被绕过 | `replaceMcpServers: true`。**这一条是本项的关键，不能省** |
| 用户自配了一个叫 `happyclaw` 的 server | 覆盖框架桥 | 三处装配都有 `if (name === 'happyclaw') continue`，已防 |
| 项目 `.mcp.json` 声明了一个危险 server | 策略管不到 | 设计如此（见 2.8.3）。工作区目录本来就是 Agent 可写的，它能自己写 `.mcp.json`——真正的边界在容器隔离和挂载白名单，不在 MCP 策略 |

### 2.8.7 怎么验证

```
1. 建两个 Agent：A 的 mcp.mode='inherit'，B 的 mcp.mode='custom' ids=['user:X']
   （前提：用户配了 X 和 Y 两个 MCP server）
2. 三条运行时 × 两个 Agent = 6 组，各让 Agent 列出自己可用的 MCP 工具
   期望 A：X 和 Y 的工具都在
   期望 B：只有 X 的工具，Y 的完全看不见
3. mode='disabled' 的第三个 Agent
   期望：三条运行时都只剩 mcp__happyclaw__* 工具
4. 绕过检查：在 B 的 session 目录手动往 settings.json 塞回 Y，再跑一轮
   期望：replaceMcpServers 把它冲掉，Y 仍然不可见
5. 缺失引用：删掉 X 这个 server，再用 B 跑一轮
   期望：turn 失败，错误信息含 'agent_profile_unavailable' 和 'user:X'
6. 项目级不受约束：在工作区放一个 .mcp.json 声明 server Z，用 B 跑
   期望：Z 可见（策略只管 managed 层）
7. 三运行时一致性：同一个 Agent 在三条运行时下，
   mcpManifest.hash 必须相同（同一个主进程算的，必然相同 —— 这条是
   验证"三条都在用主进程算的那份"，hash 不同说明某条走了 fallback）
```

---

## 2.9 第二节规模合计与落地顺序

| # | 对齐项 | 约行数 | 主要落点 |
|---|---|---:|---|
| 6 | 工具结果事件 | 90 | agent-runner ×4 文件 |
| 3 | provider 降级分类 | 101 | agent-runner ×3 + 主进程 ×3 |
| 2 | 首响应看门狗 | 95 | agent-runner ×2 |
| 7 | 人格注入 | 25 | agent-runner ×1 |
| 8 | MCP 权限策略 | 69 | agent-runner ×3 + 主进程 ×1 |
| 5 | Grok 上下文水位 | 54 | shared + agent-runner ×2 + 前端 ×1 |
| 4 | 渠道上下文 | 402 | 七个渠道模块是大头 |
| 1 | 主动模式 | 约 420 | 提示词 + 主进程发布逻辑是大头 |
| | **合计** | **≈ 1256** | |

比决策台账 2.4 写的"约 110 行"大一个数量级。差额的来源是清楚的：

- 台账的 110 行估的是"接线"（把已有能力接到 codex/grok 上）。这个估算对 **7（25 行）** 完全准确，对 **3 / 5 / 6 / 8** 大体准确（合计 314 行，量级相符）。
- **4（渠道上下文，402 行）** 和 **1（主动模式，420 行）** 不是接线，是**本地也没有的新功能**——`ChannelTurnContext` 要七个渠道各写一遍映射，主动模式的三条运行时都是从零加。台账把它们归进"对齐"是分类问题，不是估算错误。

**建议的落地顺序**（与 2.0.2 的依赖图一致）：

```
第一批（观察工具 + 共同前置）   6 → 3 → 2        约 286 行
  做完就能看到 codex/grok 到底在干什么，且 provider 失败不再静默

第二批（接线，收益立竿见影）     7 → 8            约 94 行
  人格和权限对三条生效，第一节的 Agent-first 才真的"活"

第三批（新功能）                 5 → 4 → 1        约 876 行
  水位最小先做；渠道上下文七渠道可以分批；主动模式最后，
  因为它依赖决策 49 的 interaction_mode 列和设计 5 的会话表
```

第一批和第二批共 380 行，可以与阶段 2 的合并主体一起上线（决策台账 5.5.2 已定"阶段 2+3 一起上线"）。第三批 876 行建议单独一批，因为它引入用户可感知的行为变化（主动模式改变了"Agent 怎么说话"），需要单独观察期。

---

# 附：两节的交叉依赖

```
决策 74（技能挂载模型）
  └─→ effective-skill-resolver.ts + claude-context-resolver 补齐
        └─→ 第一节 1.2.3（Skill 策略入参）

design-merge-internals 设计 3（工作区投影按 folder）
  └─→ 第一节 1.5.7（listWorkspaceGroupsForAgentProfile 的 jid 判定）

design-merge-internals 设计 5（会话表权威 + 派生）
  └─→ 第二节 2.1（主动模式的会话归属）

第一节 1.5.4（interaction_mode 列，决策 49）
  └─→ 第二节 2.1（主动模式）

第一节 1.6.1（resolveEffectiveAgentProfile 接进 spawn 路径）
  └─→ 第二节 2.7（人格注入）

第一节 1.6.2（resolvedMcpServers 进 ContainerInput）
  └─→ 第二节 2.8（MCP 权限策略）

第二节 2.0.1 共同前置 A（ContainerOutput 加字段）
  └─→ 第二节 2.2 + 2.3

阶段 1.1（仓库文档污染人格）
  └─→ 第二节 2.7（先修污染再接人格，顺序不可倒）
```

**决策台账需要补记的两处冲突**：

1. **决策 24 与决策 57 互斥**。24 说"upstream 7 个 Agent Builder MCP 工具吸收"，但它们的 handler 全在 `agent-builder.ts`（580 行），57 已把该文件砍掉。本文按 57 优先，8 个工具（7 个 `agent_profile_*` + `agent_capability_catalog`）一并不吸收。
2. **决策 A5（身份指纹不含引擎）与 upstream 的 `computeAgentProfileIdentityHash` 冲突**。upstream 把 `runtime_policy` 也 hash 进身份指纹，意味着改一次 Skill 授权就让所有会话身份漂移。本文保持本地 `computeAgentIdentityHash`（只 hash 四段 + mode），`runtime_policy` 变更走显式停 runner（1.1.3）。这一条在合并主体的冲突区，需要主动确认，属于「静默杀手」类型。
