import { beforeEach, describe, expect, test, vi } from 'vitest';

const storeDeps = vi.hoisted(() => ({
  loadChatGroups: vi.fn(async () => undefined),
  loadGroups: vi.fn(async () => undefined),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiFetch: vi.fn(),
}));
vi.mock('../web/src/stores/chat', () => ({
  useChatStore: {
    getState: () => ({ loadGroups: storeDeps.loadChatGroups }),
    setState: vi.fn(),
  },
}));
vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: {
    getState: () => ({ loadGroups: storeDeps.loadGroups }),
    setState: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import { useAgentProfilesStore } from '../web/src/stores/agent-profiles';
import type { AgentProfile } from '../web/src/types';

const profile: AgentProfile = {
  id: 'profile-1',
  owner_user_id: 'user-1',
  name: 'Reviewer',
  identity_prompt: 'identity',
  soul_prompt: 'soul',
  agents_prompt: 'agents',
  tools_prompt: 'tools',
  prompt_mode: 'append',
  include_claude_preset: true,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  runtime_policy: {
    context: { source: 'managed' },
    skills: { mode: 'inherit', ids: [] },
    mcp: { mode: 'inherit', ids: [] },
  },
  identity_hash: 'hash',
  version: 1,
  is_default: false,
  status: 'active',
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
};

describe('Agent profile frontend write contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentProfilesStore.setState({
      profiles: [],
      governanceByProfile: {},
      governanceLoading: {},
      governanceErrors: {},
      promptVersionsByProfile: {},
      loading: false,
      profilesError: null,
      error: null,
    });
  });

  test('marks create payloads as the modern four-part prompt schema', async () => {
    vi.mocked(api.post).mockResolvedValue({ profile });
    vi.mocked(api.get).mockResolvedValue({ profiles: [profile] });

    await useAgentProfilesStore.getState().createProfile({
      name: 'Reviewer',
      identity_prompt: 'identity',
      soul_prompt: 'soul',
      agents_prompt: 'agents',
      tools_prompt: 'tools',
      prompt_mode: 'append',
    });

    expect(api.post).toHaveBeenCalledWith(
      '/api/agent-profiles',
      expect.objectContaining({ prompt_schema_version: 2 }),
    );
  });

  test('marks every modern update payload before sending it', async () => {
    useAgentProfilesStore.setState({ profiles: [profile] });
    vi.mocked(api.patch).mockResolvedValue({
      profile: { ...profile, soul_prompt: 'updated', version: 2 },
    });

    await useAgentProfilesStore.getState().updateProfile(profile.id, {
      soul_prompt: 'updated',
    });

    expect(api.patch).toHaveBeenCalledWith('/api/agent-profiles/profile-1', {
      soul_prompt: 'updated',
      prompt_schema_version: 2,
    });
  });
});
