export type AgentMcpPolicyMode = 'inherit' | 'custom' | 'disabled';

export interface ResolvedAgentMcpPolicy {
  loadUserPlugins: boolean;
  skipPluginMcpDiscovery: boolean;
  includeUserMcpServers: boolean;
  strictMcpConfig: boolean;
  settingSources: Array<'project' | 'user' | 'local'>;
}

export function parseAgentMcpPolicyMode(
  raw: string | undefined,
): AgentMcpPolicyMode {
  return raw === 'custom' || raw === 'disabled' ? raw : 'inherit';
}

/**
 * MCP selection remains a user-controlled capability choice. Exact selections
 * keep plugins loaded for their commands/agents/skills/hooks while asking the
 * SDK to skip only their MCP discovery. Every mode keeps the normal Claude
 * tool surface and project/user settings available.
 */
export function resolveAgentMcpPolicy(
  mode: AgentMcpPolicyMode,
): ResolvedAgentMcpPolicy {
  const exactUserMcpSet = mode !== 'inherit';
  return {
    loadUserPlugins: true,
    skipPluginMcpDiscovery: exactUserMcpSet,
    includeUserMcpServers: true,
    strictMcpConfig: exactUserMcpSet,
    settingSources: ['project', 'user', 'local'],
  };
}

/**
 * Agent 档案是否允许加载外部（用户 / 工作区自配）MCP server。
 *
 * 阶段 3 对齐：Claude 侧走 activeAgentMcpPolicy.includeUserMcpServers，
 * Codex/Grok 各自直接读 settings.json，此前完全绕过档案策略 —— 档案里把
 * MCP 设成 disabled，这两条运行时照样把用户的 server 全挂上。
 *
 * runtimePolicy 在 ContainerInput 里是 unknown（宿主机归一化后的不透明对象），
 * 这里只做最小结构探测，形状不符时按 inherit 处理（保持既有行为）。
 */
export function allowsExternalMcpServers(runtimePolicy: unknown): boolean {
  if (!runtimePolicy || typeof runtimePolicy !== 'object') return true;
  const mcp = (runtimePolicy as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object') return true;
  return (mcp as { mode?: unknown }).mode !== 'disabled';
}
