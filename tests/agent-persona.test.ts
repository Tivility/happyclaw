import { describe, expect, test } from 'vitest';
import {
  buildPersonaBlock,
  describePersona,
  personaPromptMode,
} from '../container/agent-runner/src/agent-persona.js';
import type { ContainerInput } from '../container/agent-runner/src/types.js';

/**
 * The persona renderer is deliberately runtime-neutral: agent-runner builds the
 * block once into systemPromptAppend, and all three adapters inject that same
 * string through their own channel (Claude via the SDK system prompt, Codex via
 * CLI args, Grok via the ACP session's _meta.rules). If rendering lived in each
 * adapter they would drift, and one profile would behave differently depending
 * on which engine happened to serve the turn.
 */
const withProfile = (
  profile?: Partial<NonNullable<ContainerInput['agentProfile']>>,
): ContainerInput =>
  ({
    prompt: 'hi',
    groupFolder: 'w1',
    chatJid: 'web:w1',
    ...(profile
      ? {
          agentProfile: {
            id: 'p1',
            name: 'Scout',
            identityPrompt: '',
            soulPrompt: '',
            agentsPrompt: '',
            toolsPrompt: '',
            promptMode: 'append',
            identityHash: 'abcdef1234567890',
            version: 3,
            ...profile,
          },
        }
      : {}),
  }) as ContainerInput;

describe('buildPersonaBlock', () => {
  test('no profile yields no block — behaviour must match pre-profile builds', () => {
    expect(buildPersonaBlock(withProfile())).toBeNull();
  });

  test('renders each populated section under its own heading', () => {
    const block = buildPersonaBlock(
      withProfile({
        identityPrompt: 'You are a research scout.',
        soulPrompt: 'Blunt, no hedging.',
        agentsPrompt: 'Delegate wide sweeps.',
        toolsPrompt: 'Prefer ripgrep.',
      }),
    )!;
    expect(block).toContain('## Agent: Scout');
    expect(block).toContain('### Identity');
    expect(block).toContain('You are a research scout.');
    expect(block).toContain('### Voice and disposition');
    expect(block).toContain('Blunt, no hedging.');
    expect(block).toContain('### Sub-agent conventions');
    expect(block).toContain('### Tool conventions');
    expect(block.startsWith('<agent-persona>')).toBe(true);
    expect(block.endsWith('</agent-persona>')).toBe(true);
  });

  test('omits empty sections instead of emitting blank headings', () => {
    const block = buildPersonaBlock(
      withProfile({ identityPrompt: 'Only identity.' }),
    )!;
    expect(block).toContain('### Identity');
    expect(block).not.toContain('### Voice and disposition');
    expect(block).not.toContain('### Tool conventions');
  });

  test('whitespace-only sections count as empty', () => {
    const block = buildPersonaBlock(
      withProfile({ identityPrompt: 'Real.', soulPrompt: '   \n  ' }),
    )!;
    expect(block).not.toContain('### Voice and disposition');
  });

  test('a profile with every section blank yields no block', () => {
    // Nothing to say means nothing injected — not an empty wrapper the model
    // has to read past.
    expect(buildPersonaBlock(withProfile({ name: 'Empty' }))).toBeNull();
  });
});

describe('personaPromptMode', () => {
  test("defaults to append — the safe mode that keeps built-in guidelines", () => {
    expect(personaPromptMode(withProfile())).toBe('append');
    expect(personaPromptMode(withProfile({ promptMode: 'append' }))).toBe('append');
  });

  test('replace is honoured when explicitly set', () => {
    expect(personaPromptMode(withProfile({ promptMode: 'replace' }))).toBe(
      'replace',
    );
  });

  test('an unknown mode falls back to append rather than dropping guidelines', () => {
    // Silently dropping guidelines would strip tool conventions the agent needs.
    expect(personaPromptMode(withProfile({ promptMode: 'weird' }))).toBe('append');
  });
});

describe('describePersona', () => {
  test('summarises name, version and identity prefix for the log', () => {
    // Sessions are NOT reset on a persona change (decision O1-b), so this line
    // is how a later cache-cost investigation finds when the prefix changed.
    expect(describePersona(withProfile({ identityPrompt: 'x' }))).toBe(
      'persona=Scout v3 identity=abcdef12',
    );
  });

  test('falls back to the id when the profile has no name', () => {
    expect(describePersona(withProfile({ name: '' }))).toBe(
      'persona=p1 v3 identity=abcdef12',
    );
  });

  test('no profile yields no description', () => {
    expect(describePersona(withProfile())).toBeNull();
  });
});
