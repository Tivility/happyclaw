import { getJidsByFolder, getRegisteredGroup } from './db.js';

const allowedUserIdsCache = new Map<
  string,
  { ids: Set<string> | null; expiry: number }
>();
const ALLOWED_CACHE_TTL = 10_000;

export function getGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const virtualSeparator = ['#agent:', '#task:']
    .map((separator) => chatJid.indexOf(separator))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const baseChatJid =
    virtualSeparator === undefined
      ? chatJid
      : chatJid.slice(0, virtualSeparator);
  const now = Date.now();
  const cached = allowedUserIdsCache.get(baseChatJid);
  if (cached && cached.expiry > now) return cached.ids;

  const group = getRegisteredGroup(baseChatJid);
  if (!group) return null;
  let ownerId: string | null = group.created_by ?? null;
  if (!ownerId && !baseChatJid.startsWith('web:')) {
    for (const siblingJid of getJidsByFolder(group.folder)) {
      if (!siblingJid.startsWith('web:')) continue;
      const sibling = getRegisteredGroup(siblingJid);
      if (sibling?.is_home && sibling.created_by) {
        ownerId = sibling.created_by;
        break;
      }
    }
  }
  if (!ownerId) return null;

  const allowed = new Set<string>([ownerId]);
  allowedUserIdsCache.set(baseChatJid, {
    ids: allowed,
    expiry: now + ALLOWED_CACHE_TTL,
  });
  return allowed;
}
