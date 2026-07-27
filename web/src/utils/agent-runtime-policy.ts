import {
  getAgentContextSource,
  type AgentProfileRuntimePolicy,
} from '../types';

export type RuntimePolicyMode = 'inherit' | 'custom' | 'disabled';

export interface SkillSourcePolicy {
  mode: RuntimePolicyMode;
  ids: string[];
}

export const DEFAULT_HOST_SKILL_POLICY: SkillSourcePolicy = {
  mode: 'disabled',
  ids: [],
};

/**
 * Profiles saved before host Skill governance was introduced inherited every
 * host Skill together with host Claude context. Preserve that behavior until
 * the profile is saved with an explicit host policy.
 */
export function getHostSkillPolicy(
  policy?: Partial<AgentProfileRuntimePolicy> | null,
): SkillSourcePolicy {
  const explicit = policy?.skills?.host;
  if (explicit) {
    return {
      mode: explicit.mode ?? 'disabled',
      ids: explicit.ids ?? [],
    };
  }
  return getAgentContextSource(policy) === 'host_claude'
    ? { mode: 'inherit', ids: [] }
    : { ...DEFAULT_HOST_SKILL_POLICY };
}

export function skillSelectionError(
  label: string,
  policy: SkillSourcePolicy,
): string | null {
  return policy.mode === 'custom' && policy.ids.length === 0
    ? `请至少选择一个${label}。`
    : null;
}

export function skillPolicySummary(
  policy: SkillSourcePolicy,
  allLabel = '全部已启用',
): string {
  if (policy.mode === 'disabled') return '不使用';
  if (policy.mode === 'inherit') return allLabel;
  return `选择 ${policy.ids.length} 项`;
}
