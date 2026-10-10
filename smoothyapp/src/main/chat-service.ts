import catalog from '../shared/chat-catalog.json';
import { validateChatInput as validate } from '../shared/chat-validation';
export const validateChatInput = (input: any) => validate(input);

export function createChatService(deps: {
  owner: () => string | null; enabled: () => boolean;
  request: (route: string, body: any, signal: AbortSignal, onChunk?: (delta: string) => void) => Promise<string>;
  track: (id: string) => void;
  attachment?: (id: string) => any;
  writingStyle?: () => string | undefined;
}) {
  let controller: AbortController | null = null, epoch = 0;
  const cancel = () => { epoch++; controller?.abort(); };
  const run = async (input: any, onChunk?: (delta: string) => void) => {
    if (!deps.enabled()) throw new Error('Studio AI is turned off. Enable it in Settings.');
    const owner = deps.owner(); if (!owner) throw new Error('Sign in to use Chat.');
    if (controller) throw new Error('Wait for the current reply to finish.');
    const resolved = deps.attachment && Array.isArray(input?.messages) ? { ...input, messages: input.messages.map((message: any) => ({ ...message, ...(message?.attachments !== undefined && { attachments: Array.isArray(message.attachments) ? message.attachments.map((id: unknown) => { if (typeof id !== 'string') throw new Error('Reattach this file.'); return deps.attachment!(id); }) : message.attachments }) })) } : input;
    // Model selection belongs to the web Admin; style comes from persisted native preferences.
    const body = validateChatInput({ ...resolved, model: undefined, writingStyle: deps.writingStyle?.() || undefined }), stamp = epoch;
    const signal = (controller = new AbortController()).signal;
    let finished = false, streamedChars = 0;
    const assertCurrent = () => { if (finished || signal.aborted || stamp !== epoch || deps.owner() !== owner || !deps.enabled()) throw new Error('Chat canceled.'); };
    try {
      const reply = await deps.request('/api/chat', body, signal, delta => {
        assertCurrent();
        if (typeof delta !== 'string' || (streamedChars += delta.length) > catalog.maxMessageChars) throw new Error('No usable reply was returned. Try again.');
        if (delta) onChunk?.(delta);
      });
      assertCurrent();
      if (typeof reply !== 'string' || !reply.trim() || reply.length > catalog.maxMessageChars) throw new Error('No usable reply was returned. Try again.');
      try { deps.track('chat_reply'); } catch { /* Analytics never blocks a reply. */ }
      if (body.writingStyle) { try { deps.track('chat_natural_reply'); } catch { /* Independent subset counter, no extra request. */ } }
      return { reply, model: body.model };
    } finally { finished = true; controller = null; }
  };
  return { run, cancel };
}
