import catalog from './chat-catalog.json';
import writing from './chat-writing.json';

export const isChatModel = (value: unknown): value is string => typeof value === 'string' && catalog.models.some(model => model.id === value);

/** Validate user data only: no supplied system roles, URLs, tools or premium models. */
export function validateChatInput(input: any, requireModel = false) {
  if (!input || typeof input !== 'object') throw new Error('Enter a message.');
  if ((requireModel || input.model !== undefined) && !isChatModel(input.model)) throw new Error('Choose a supported chat model.');
  const source = input.messages === undefined ? [{ role: 'user', content: input.prompt }] : input.messages;
  if (!Array.isArray(source) || !source.length || source.length > catalog.maxMessages) throw new Error('Start a new chat to continue.');
  let total = 0, files = 0, images = 0;
  const messages = source.map((message, index) => {
    if (!message || message.role !== (index % 2 === 0 ? 'user' : 'assistant') || typeof message.content !== 'string' || message.content.length > catalog.maxMessageChars) throw new Error('Invalid chat message (maximum 10,000 characters).');
    const attachments = message.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > catalog.maxAttachmentsPerMessage || (message.role !== 'user' && attachments.length)) throw new Error('Attach up to four files to a user message.');
    if (!message.content.trim() && !attachments.length) throw new Error('Enter a message or attach a file.');
    total += message.content.length;
    const clean = attachments.map(file => {
      files++;
      if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 120 || /[\\/\x00-\x1f]/.test(file.name)) throw new Error('Invalid attachment name.');
      if (file.type === 'text' && typeof file.text === 'string' && file.text.trim() && file.text.length <= catalog.maxAttachmentChars) {
        total += file.text.length + file.name.length;
        return { type: 'text' as const, name: file.name, text: file.text };
      }
      if (file.type === 'image' && typeof file.data === 'string' && file.data.length <= Math.ceil(catalog.maxImageBytes / 3) * 4 + 40 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(file.data)) {
        const encoded = file.data.slice(file.data.indexOf(',') + 1);
        if (encoded.length % 4 || !(file.data.startsWith('data:image/jpeg;base64,/9j/') || file.data.startsWith('data:image/png;base64,iVBORw0KGgo') || (file.data.startsWith('data:image/webp;base64,UklGR') && atob(encoded.slice(0, 16)).slice(8, 12) === 'WEBP'))) throw new Error('Invalid image attachment.');
        images++;
        return { type: 'image' as const, name: file.name, data: file.data };
      }
      throw new Error('Invalid attachment. Choose a smaller image or readable document.');
    });
    return { role: message.role as 'user' | 'assistant', content: message.content, ...(clean.length && { attachments: clean }) };
  });
  if (messages.at(-1)?.role !== 'user' || total > catalog.maxConversationChars || files > catalog.maxConversationAttachments || images > catalog.maxConversationImages) throw new Error('This conversation is full. Start a new chat to continue (up to four images).');
  if (input.thinking !== undefined && typeof input.thinking !== 'boolean') throw new Error('Choose Thinking or Non-thinking.');
  const model = catalog.models.find(model => model.id === (input.model || catalog.defaultModel))!;
  const thinking = input.thinking ?? (model.supportsNonThinking ? catalog.defaultThinking : true);
  if (!thinking && !model.supportsNonThinking) throw new Error('This model requires Thinking. Choose Luna or DeepSeek for Non-thinking.');
  if (input.writingStyle !== undefined && (typeof input.writingStyle !== 'string' || !input.writingStyle.trim() || input.writingStyle.length > writing.maxPromptChars)) throw new Error('Writing instructions must contain 1 to 4,000 characters.');
  return { messages, ...(input.model !== undefined && { model: input.model as string }), thinking, ...(input.writingStyle !== undefined && { writingStyle: input.writingStyle.trim() as string }) };
}

/** Convert attachments to ordinary AI SDK text/image parts; document files stay local. */
export function providerChatMessages(messages: ReturnType<typeof validateChatInput>['messages']) {
  return messages.map(message => message.attachments?.length ? {
    role: 'user' as const,
    content: [
      ...(message.content.trim() ? [{ type: 'text' as const, text: message.content }] : []),
      ...message.attachments.map(file => file.type === 'text'
        ? { type: 'text' as const, text: `Attached document ${JSON.stringify(file.name)}:\n${file.text}` }
        : { type: 'image' as const, image: file.data }),
    ],
  } : { role: message.role, content: message.content });
}
