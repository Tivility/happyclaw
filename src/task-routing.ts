/**
 * Pure helpers used by the scheduled-task IM routing pipeline.
 *
 * Extracted from src/index.ts so unit tests can import them without booting
 * the main service (src/index.ts runs main() at module load). All external
 * lookups are injected via `deps`; this file has no side effects.
 */

/**
 * Scan a message list backwards and return the most recent non-empty `task_id`,
 * or undefined if none. Used to propagate the triggering task's id from
 * getMessagesSince() output into agent-runner via ContainerInput.messageTaskId.
 *
 * Mixed-batch semantics ("later wins"): when a batch contains both normal user
 * messages and task-prompt rows, the whole batch is attributed to the most
 * recent task_id in the batch. The batch is collapsed into a single agent
 * turn and cannot be split back apart; we accept a slightly conservative
 * misattribution (a user-initiated send may be routed through the task's
 * IM broadcast path) over losing task attribution entirely (which would cause
 * the task's configured notify_channels / chat_jid to be silently ignored).
 * See tests/container-input-taskid.test.ts for the locked-in cases.
 */
export function extractLastTaskId(
  messages: ReadonlyArray<{ task_id?: string | null }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]?.task_id;
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Inputs observable on an IPC message from agent-runner. Mirrors the fields
 * the real IPC consumer in src/index.ts inspects; keep this in sync if new
 * fields become load-bearing for routing.
 */
export interface IpcMessageInputs {
  /** Legacy isolated-run flag (tasks-run/{runId}/ IPC namespace). */
  isScheduledTask?: boolean;
  /** Per-message task attribution, emitted by group-mode task turns. */
  taskId?: string | null;
}

/** Task record fields consumed by the IPC router. */
export interface TaskRecordForRouting {
  notify_channels?: string[] | null;
  chat_jid?: string | null;
}

/**
 * Output of resolveTaskRoutingDecision. Describes how the IPC consumer should
 * route a scheduled-task output to IM channels.
 *
 * - `mode: 'none'`: not a task message; caller falls through to regular routing.
 * - `mode: 'direct'`: task has a configured chat_jid; caller sends to it
 *   directly (unless it was already sent via data.chatJid / ipcImRoute).
 * - `mode: 'broadcast'`: no direct chat_jid; caller fans out to the owner's
 *   connected IM channels, filtered by `notifyChannels` if present.
 */
export type TaskRoutingDecision =
  | { mode: 'none' }
  | {
      mode: 'direct';
      /** The IM JID the task is configured to reply into. */
      taskChatJid: string;
      /** notify_channels from the task record, forwarded for parity with broadcast branch. */
      notifyChannels: string[] | null | undefined;
      /** Echoed for logging / debugging. */
      effectiveTaskId: string;
    }
  | {
      mode: 'broadcast';
      notifyChannels: string[] | null | undefined;
      /** undefined when neither data.taskId nor ipcTaskId was available. */
      effectiveTaskId: string | undefined;
    };

export interface ResolveTaskRoutingDeps {
  getTaskById: (taskId: string) => TaskRecordForRouting | null | undefined;
  /** Should mirror src/im-channel.ts#getChannelType: non-null iff the jid belongs to an IM channel. */
  getChannelType: (jid: string) => string | null;
}

/**
 * Pure decision function capturing the "scheduled task output" branch of the
 * IPC consumer in src/index.ts (message + image variants). Separated out so
 * unit tests can exercise each codepath (`mode: 'none' | 'direct' | 'broadcast'`)
 * without booting the main service.
 *
 * Contract (locked by tests/task-routing-decision.test.ts):
 * - `hasCreatedBy` must be true for any non-none result (owner attribution is
 *   required to look up notify channels).
 * - A message is a task message iff `data.isScheduledTask || data.taskId`.
 * - `effectiveTaskId` prefers per-message `data.taskId` over the legacy
 *   `ipcTaskId` (the directory-derived id used by isolated-run tasks).
 * - Direct-mode requires the task record's `chat_jid` to be a valid IM JID
 *   (getChannelType non-null). A null/web/unknown chat_jid falls back to
 *   broadcast so tasks without a configured IM target still fan out.
 */
export function resolveTaskRoutingDecision(
  data: IpcMessageInputs,
  ipcTaskId: string | null | undefined,
  hasCreatedBy: boolean,
  deps: ResolveTaskRoutingDeps,
): TaskRoutingDecision {
  const isTaskMessage = !!(data.isScheduledTask || data.taskId);
  if (!isTaskMessage || !hasCreatedBy) {
    return { mode: 'none' };
  }

  const effectiveTaskId =
    typeof data.taskId === 'string' && data.taskId
      ? data.taskId
      : (ipcTaskId ?? undefined);

  let notifyChannels: string[] | null | undefined;
  let taskChatJid: string | null | undefined;
  if (effectiveTaskId) {
    const taskRecord = deps.getTaskById(effectiveTaskId);
    notifyChannels = taskRecord?.notify_channels;
    taskChatJid = taskRecord?.chat_jid;
  }

  if (taskChatJid && deps.getChannelType(taskChatJid)) {
    return {
      mode: 'direct',
      taskChatJid,
      notifyChannels,
      effectiveTaskId: effectiveTaskId as string, // non-empty per the branch above
    };
  }

  return {
    mode: 'broadcast',
    notifyChannels,
    effectiveTaskId,
  };
}

export interface BroadcastToOwnerIMChannelsDeps {
  getConnectedChannelTypes: (userId: string) => string[];
  getGroupsByOwner: (
    userId: string,
  ) => Array<{
    jid: string;
    folder: string;
    /**
     * Set by ImBindingDialog when an IM group is explicitly bound to a
     * non-home workspace. Overrides the group's own `folder` for routing
     * purposes — see resolveImGroupEffectiveFolder.
     */
    target_main_jid?: string | null;
  }>;
  getChannelType: (jid: string) => string | null;
  /**
   * Resolve a `web:xxx` JID to the workspace folder it points to. Used to
   * follow `target_main_jid` bindings when matching broadcast targets.
   * Return null for unknown / unresolvable JIDs so the caller can fall
   * back to the IM group's own folder.
   */
  resolveJidFolder: (jid: string) => string | null;
}

export interface ResolveTaskSourceImJidDeps {
  groups: Record<
    string,
    {
      folder: string;
      target_main_jid?: string | null;
    }
  >;
  getChannelType: (jid: string) => string | null;
  resolveJidFolder: (jid: string) => string | null;
}

export interface ResolveTaskSourceImJidInput {
  taskChatJid: string;
  taskGroupFolder: string;
  targetGroupJid: string;
  notifyChannels?: string[] | null;
}

/**
 * Resolve the IM source for a group-mode scheduled task prompt.
 *
 * Group-mode tasks are injected into the bound web workspace so the message is
 * visible in Web, but they must keep the original IM source_jid when the task
 * was created from / bound to an IM group. processAgentConversation uses
 * source_jid to create the Feishu/DingTalk/etc. streaming card and to route
 * send_message tool calls back to the same IM conversation.
 */
export function resolveTaskSourceImJid(
  input: ResolveTaskSourceImJidInput,
  deps: ResolveTaskSourceImJidDeps,
): string | undefined {
  const targetFolder =
    deps.groups[input.targetGroupJid]?.folder || input.taskGroupFolder;
  const candidates = [
    input.taskChatJid,
    ...Object.keys(deps.groups).filter((jid) => jid !== input.taskChatJid),
  ];
  const seen = new Set<string>();

  for (const jid of candidates) {
    if (seen.has(jid)) continue;
    seen.add(jid);

    const channelType = deps.getChannelType(jid);
    if (!channelType) continue;
    const isConfiguredTaskTarget = jid === input.taskChatJid;
    if (
      !isConfiguredTaskTarget &&
      input.notifyChannels &&
      !input.notifyChannels.includes(channelType)
    ) {
      continue;
    }

    const group = deps.groups[jid];
    if (!group) continue;
    const effectiveFolder = resolveImGroupEffectiveFolder(
      group,
      deps.resolveJidFolder,
    );
    if (
      effectiveFolder === input.taskGroupFolder ||
      effectiveFolder === targetFolder
    ) {
      return jid;
    }
  }

  return undefined;
}

/**
 * Compute the workspace folder an IM group should be considered to "belong"
 * to when the scheduled-task broadcaster is looking for recipients.
 *
 * There are TWO ways a user can bind an IM group to a workspace:
 *
 * 1. **Shared folder** — the IM group's own `folder` matches the workspace's
 *    folder. Used for home workspaces (auto-registered via onNewChat) and
 *    some migration flows.
 * 2. **target_main_jid** — the IM group keeps its own `folder` (usually the
 *    home folder) but stores a pointer to the intended workspace via
 *    `target_main_jid`. Used by the ImBindingDialog UI.
 *
 * Both must be respected by the broadcast matcher; otherwise scheduled
 * tasks created in non-home workspaces will silently fail to reach
 * their bound IM groups when the binding is the (2) kind.
 *
 * Precedence: `target_main_jid` wins when present and resolvable, matching
 * the semantics used by `resolveOwnerHomeFolder` in src/index.ts.
 */
export function resolveImGroupEffectiveFolder(
  group: { folder: string; target_main_jid?: string | null },
  resolveJidFolder: (jid: string) => string | null,
): string {
  if (group.target_main_jid) {
    const resolved = resolveJidFolder(group.target_main_jid);
    if (resolved) return resolved;
  }
  return group.folder;
}

/**
 * Pick the folder used to fan out a scheduled-task message to the owner's IM
 * channels. This is a *deliberate decision* between two candidates — the
 * emitting workspace's own folder (`sourceFolder`), or the owner's home
 * workspace folder (`ownerHomeFolder`) — and the answer is always
 * `sourceFolder`.
 *
 * This encodes fix F: pre-fix code returned `ownerHomeFolder`, which broke
 * non-home workspaces bound to their own IM groups (replies were routed to
 * the home workspace's IM bindings instead of the emitting workspace's).
 *
 * Both candidates are accepted as parameters so the caller can't silently
 * revert to ownerHome by choosing a different expression — any regression
 * shows up as a functional change to this helper (locked by tests), not an
 * innocent-looking one-line edit at the call site.
 *
 * The `ownerHomeFolder` parameter is intentionally unused in the return
 * value; it exists purely as a "witness" that the caller considered both
 * options and chose sourceFolder. See tests/task-routing-decision.test.ts
 * for the locked contract.
 */
export function resolveBroadcastFolder(
  sourceFolder: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ownerHomeFolder: string | null | undefined,
): string {
  return sourceFolder;
}

/**
 * Broadcast a message to all connected IM channels of a user that haven't
 * already received it. Used by scheduled tasks to fan out to all IM channels.
 * `sourceFolder` filters to groups whose folder matches the emitting workspace,
 * so IM bindings on unrelated workspaces are ignored.
 */
export function broadcastToOwnerIMChannels(
  userId: string,
  sourceFolder: string,
  alreadySentJids: Set<string>,
  sendFn: (jid: string) => void,
  notifyChannels: string[] | null | undefined,
  deps: BroadcastToOwnerIMChannelsDeps,
): void {
  const sentChannelTypes = new Set<string>();
  for (const jid of alreadySentJids) {
    const ct = deps.getChannelType(jid);
    if (ct) sentChannelTypes.add(ct);
  }
  const connectedTypes = deps.getConnectedChannelTypes(userId);
  const ownerGroups = deps.getGroupsByOwner(userId);
  for (const channelType of connectedTypes) {
    if (sentChannelTypes.has(channelType)) continue;
    if (notifyChannels && !notifyChannels.includes(channelType)) continue;
    const target = ownerGroups.find((g) => {
      if (deps.getChannelType(g.jid) !== channelType) return false;
      // Match on the group's *effective* routing folder so both "shared
      // folder" and "target_main_jid" bindings reach this broadcaster.
      // Without this, ImBindingDialog-bound IM groups (whose own folder
      // stays at 'main') silently miss scheduled-task broadcasts from
      // non-home workspaces.
      const effectiveFolder = resolveImGroupEffectiveFolder(g, deps.resolveJidFolder);
      return effectiveFolder === sourceFolder;
    });
    if (target) {
      sendFn(target.jid);
      sentChannelTypes.add(channelType);
    }
  }
}

/**
 * Minimal shape of a registered-group row needed for serialization routing.
 * Declared locally (instead of importing RegisteredGroup) so this stays a pure
 * module that tests can exercise with plain object literals.
 */
export interface GroupRoutingRow {
  folder: string;
  target_main_jid?: string | null;
}

/**
 * Folder in which the agent serving `groupJid` actually executes.
 *
 * `registered_groups.folder` answers a different question: "which folder was
 * this row registered under". IM chats auto-register to their owner's home
 * folder (§8.2) and keep that value even after `target_main_jid` is later
 * pointed at a dedicated workspace. On this deployment folder='main' collects
 * 24 JIDs, 21 of which actually execute in their own workspace folder.
 *
 * Falls back to the row's own folder when there is no routing pointer, and to
 * the JID itself when the row is unknown (mirrors the pre-existing behaviour of
 * keying an unregistered JID by itself).
 */
export function resolveExecutingFolder(
  groupJid: string,
  groups: Record<string, GroupRoutingRow | undefined>,
): string {
  const group = groups[groupJid];
  if (!group) return groupJid;
  const target = group.target_main_jid
    ? groups[group.target_main_jid]
    : undefined;
  return target?.folder || group.folder || groupJid;
}

/**
 * Serialization key for the group queue: one key = one serialized runner.
 *
 * Virtual JIDs get their own key so a sub-agent or scheduled task does not
 * serialize against (or get stopped alongside) the main conversation:
 *   {chatJid}#agent:{agentId} → {executingFolder}#{agentId}
 *   {chatJid}#task:{taskId}   → {executingFolder}#task:{taskId}
 *
 * Plain chat JIDs key on their executing folder, so sibling JIDs that share a
 * folder column but route elsewhere no longer resolve to the same runner. This
 * is what keeps `stopGroup` / `interruptQuery` from reaching across workspaces.
 */
export function resolveSerializationKey(
  groupJid: string,
  groups: Record<string, GroupRoutingRow | undefined>,
): string {
  const agentSep = groupJid.indexOf('#agent:');
  if (agentSep >= 0) {
    const baseJid = groupJid.slice(0, agentSep);
    const agentId = groupJid.slice(agentSep + '#agent:'.length);
    return `${resolveExecutingFolder(baseJid, groups)}#${agentId}`;
  }
  const taskSep = groupJid.indexOf('#task:');
  if (taskSep >= 0) {
    const baseJid = groupJid.slice(0, taskSep);
    const taskId = groupJid.slice(taskSep + '#task:'.length);
    return `${resolveExecutingFolder(baseJid, groups)}#task:${taskId}`;
  }
  return resolveExecutingFolder(groupJid, groups);
}
