import type { ContainerInput } from './types.js';

/**
 * Renders a workspace's agent profile into a prompt block.
 *
 * Kept runtime-neutral so all three adapters share one definition of what a
 * persona *is*: Claude injects the result through the SDK system prompt, Codex
 * through CLI args, Grok through the ACP session's `_meta.rules`. Without a
 * shared renderer the three would drift and the same profile would behave
 * differently depending on which engine happened to serve the turn.
 */

export type PersonaPromptMode = 'append' | 'replace';

/**
 * Whether the built-in guidelines survive alongside the persona.
 *
 * 'append' is the default and the safe one: the persona adds voice and
 * conventions on top of the runtime's own tool/safety guidance. 'replace' is for
 * a profile that deliberately takes over the whole system prompt, and callers
 * must handle it — dropping guidelines silently would remove tool conventions
 * the agent depends on.
 */
export function personaPromptMode(input: ContainerInput): PersonaPromptMode {
  return input.agentProfile?.promptMode === 'replace' ? 'replace' : 'append';
}

/**
 * The persona block, or null when the workspace has no profile.
 *
 * Sections are omitted rather than emitted empty — a profile that only sets an
 * identity should not ship three blank headings that the model has to read past.
 */
export function buildPersonaBlock(input: ContainerInput): string | null {
  const profile = input.agentProfile;
  if (!profile) return null;

  const sections: string[] = [];
  const push = (label: string, body: string | undefined): void => {
    const text = body?.trim();
    if (text) sections.push(`### ${label}\n${text}`);
  };

  push('Identity', profile.identityPrompt);
  push('Voice and disposition', profile.soulPrompt);
  push('Sub-agent conventions', profile.agentsPrompt);
  push('Tool conventions', profile.toolsPrompt);

  if (!sections.length) return null;

  // The name is worth stating even when every prompt section is empty-ish,
  // because IM replies are attributed to it in the UI.
  const header = profile.name ? `## Agent: ${profile.name}` : '## Agent';
  return `<agent-persona>\n${header}\n\n${sections.join('\n\n')}\n</agent-persona>`;
}

/**
 * One-line description for logs and the context audit.
 *
 * Includes the identity hash prefix so a persona edit is visible in the logs
 * without dumping the whole prompt: sessions are intentionally *not* reset on a
 * persona change (decision O1-b), so this line is how a later cache-cost
 * investigation finds the moment the prefix changed.
 */
export function describePersona(input: ContainerInput): string | null {
  const profile = input.agentProfile;
  if (!profile) return null;
  return `persona=${profile.name || profile.id} v${profile.version} identity=${profile.identityHash.slice(0, 8)}`;
}
