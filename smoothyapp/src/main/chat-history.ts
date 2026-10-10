import { randomUUID } from 'node:crypto';

export type ChatHistoryTurnInput = { prompt: string; reply: string; thinking?: boolean; attachmentsCount?: number };
export type ChatHistoryTurn = Required<ChatHistoryTurnInput>;
export type ChatHistoryConversation = { id: string; title: string; createdAt: number; updatedAt: number; turns: ChatHistoryTurn[] };
export const CHAT_HISTORY_MAX_CONVERSATIONS = 30;
export const CHAT_HISTORY_MAX_TURNS = 20;
export const CHAT_HISTORY_MAX_CHARS = 64_000;

/** Server is the source of truth. The settings store is read only to transfer
 * histories created by the earlier local preview, then clear the transferred account. */
export function createChatHistoryService(deps: {
  owner: () => string | null | undefined;
  request: (body?: unknown) => Promise<any>;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  createId?: () => string;
}) {
  let epoch = 0;
  const transfers = new Map<string, Promise<void>>();
  const current = (owner: string, stamp: number) => {
    if (!owner || deps.owner() !== owner || stamp !== epoch) throw new Error('Account changed. Chat History request canceled.');
  };
  async function ready(owner: string, stamp: number) {
    current(owner, stamp);
    let transfer = transfers.get(owner);
    if (!transfer) {
      transfer = (async () => {
        const stored = deps.get('chatHistory');
        const account = Array.isArray(stored) ? stored.find(item => item?.owner === owner && Array.isArray(item.conversations)) : null;
        if (!account?.conversations.length) return;
        // Bound and allowlist old snapshots; attachment content is never uploaded.
        const conversations = account.conversations.slice(0, CHAT_HISTORY_MAX_CONVERSATIONS).map((item: any) => ({
          id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt,
          turns: item.turns.map((turn: any) => ({ prompt: turn.prompt, reply: turn.reply, thinking: turn.thinking === true, attachmentsCount: turn.attachmentsCount || 0 })),
        }));
        const result = await deps.request({ action: 'migrate', conversations });
        if (result?.migrated !== true) throw new Error('Chat History transfer was not confirmed. Please try again.');
        current(owner, stamp);
        const latest = deps.get('chatHistory');
        // Clear only this account, only after the server confirms durable storage.
        if (Array.isArray(latest)) deps.set('chatHistory', latest.filter(item => item?.owner !== owner));
      })();
      transfers.set(owner, transfer);
    }
    try { await transfer; } finally { if (transfers.get(owner) === transfer) transfers.delete(owner); }
    current(owner, stamp);
  }
  async function run(owner: string, body?: unknown) {
    const stamp = epoch;
    await ready(owner, stamp);
    current(owner, stamp);
    const result = await deps.request(body);
    current(owner, stamp);
    return result;
  }
  return {
    async list(owner: string) { return (await run(owner)).items; },
    save(owner: string, id: unknown, turns: unknown) { return run(owner, { action: 'save', conversationId: id || (deps.createId || randomUUID)(), create: !id, turns }); },
    async load(owner: string, id: unknown) { return (await run(owner, { action: 'load', conversationId: id })).conversation; },
    remove(owner: string, id: unknown) { return run(owner, { action: 'delete', conversationId: id }); },
    reset() { epoch++; },
  };
}
