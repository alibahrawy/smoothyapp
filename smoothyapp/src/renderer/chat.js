import catalog from '../shared/chat-catalog.json';
import { renderChatReply } from './chat-format.js';
import { createWordReveal } from './chat-reveal.js';

export function initChat({ getUser, signIn, refreshCredits }) {
  const $ = id => document.getElementById(id), api = window.electronAPI;
  let thinking = catalog.defaultThinking;
  let turns = [], attachments = [], filesLoading = false, busy = false, stopping = false, active = null, account = null, generation = 0;
  let conversationId = null, historyView = false, historyLoading = false, historyError = '', historyItems = [], historyEpoch = 0;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const historyButton = document.createElement('button'); historyButton.id = 'chat-history'; historyButton.type = 'button'; historyButton.className = 'stock-text-button'; historyButton.textContent = 'History';
  $('chat-new').before(historyButton);
  const historyPanel = document.createElement('div'); historyPanel.id = 'chat-history-view'; historyPanel.className = 'chat-history-view hidden'; historyPanel.setAttribute('aria-label', 'Chat history');
  $('chat-signedin').insertBefore(historyPanel, $('chat-results'));
  const status = (message, error = false) => {
    const visible = Boolean(error && message);
    $('chat-status').textContent = visible ? message : '';
    $('chat-status').classList.toggle('hidden', !visible);
    $('chat-status').classList.toggle('photo-error', visible);
  };
  function availability() {
    $('chat-thinking').setAttribute('aria-checked', String(thinking));
    $('chat-thinking').disabled = busy || filesLoading;
    $('chat-thinking').title = 'Turn reasoning on or off';
    const signedIn = Boolean(getUser());
    $('chat-signin').classList.toggle('hidden', signedIn);
    $('chat-signedin').classList.toggle('hidden', !signedIn);
    $('chat-composer-dock').classList.toggle('hidden', !signedIn || historyView);
    historyButton.classList.toggle('hidden', !signedIn);
    historyButton.disabled = busy || filesLoading || historyLoading;
    historyButton.textContent = historyView ? 'Back to chat' : 'History';
    historyPanel.classList.toggle('hidden', !historyView);
    $('chat-results').classList.toggle('hidden', historyView);
    $('chat-send').disabled = stopping || filesLoading || !signedIn || (!busy && !$('chat-prompt').value.trim() && !attachments.length);
    $('chat-send').classList.toggle('is-generating', busy);
    $('chat-send').classList.toggle('is-stopping', stopping);
    $('chat-send').setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
    $('chat-send').title = busy ? 'Stop generating' : 'Send message';
    ['chat-prompt', 'chat-new', 'chat-add-image', 'chat-add-file'].forEach(id => { $(id).disabled = busy || filesLoading; });
    $('chat-add').disabled = busy || filesLoading || attachments.length >= catalog.maxAttachmentsPerMessage;
    document.querySelectorAll('.chat-attachment-remove').forEach(button => { button.disabled = busy || filesLoading; });
    ['chat-copy', 'chat-save'].forEach(id => { $(id).disabled = busy || historyView || !turns.some(turn => turn.reply || turn.visibleText); });
    $('chat-empty').classList.toggle('hidden', turns.length > 0 || historyView);
  }
  function attachmentChips(target, files, removable = false) {
    target.replaceChildren();
    files.forEach(file => {
      const chip = document.createElement('div'); chip.className = 'chat-attachment';
      if (file.preview) { const image = document.createElement('img'); image.src = file.preview; image.alt = ''; chip.append(image); }
      const name = document.createElement('span'); name.textContent = file.name; name.title = file.name; chip.append(name);
      if (removable) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'chat-attachment-remove'; remove.textContent = '×'; remove.ariaLabel = `Remove ${file.name}`; remove.addEventListener('click', () => { if (busy || filesLoading) return; attachments = attachments.filter(item => item.id !== file.id); api.chatRelease([file.id]).catch(() => {}); attachmentChips($('chat-attachments'), attachments, true); availability(); }); chip.append(remove); }
      target.append(chip);
    });
  }
  async function addFiles(kind) {
    if (busy || filesLoading || !getUser() || attachments.length >= catalog.maxAttachmentsPerMessage) return;
    const stamp = generation; filesLoading = true; $('chat-add-menu').hidePopover(); availability(); status('Reading attachments…');
    try {
      const result = await api.chatAttach(kind, catalog.maxAttachmentsPerMessage - attachments.length);
      if (stamp !== generation) return;
      if (!result.success) throw new Error(result.error || 'Could not read this file.');
      if (!result.canceled) attachments.push(...result.attachments);
      attachmentChips($('chat-attachments'), attachments, true); status('');
    } catch (error) { if (stamp === generation) status(error.message || 'Could not attach this file.', true); }
    finally { if (stamp === generation) { filesLoading = false; availability(); } }
  }
  $('chat-add-image').addEventListener('click', () => addFiles('image'));
  $('chat-add-file').addEventListener('click', () => addFiles('file'));
  const addMenu = $('chat-add-menu');
  function positionAddMenu() { const rect = $('chat-add').getBoundingClientRect(), width = Math.min(260, innerWidth - 24); addMenu.style.width = `${width}px`; addMenu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`; addMenu.style.bottom = `${innerHeight - rect.top + 6}px`; addMenu.style.maxHeight = `${Math.max(100, rect.top - 20)}px`; }
  addMenu.addEventListener('beforetoggle', event => { if (event.newState === 'open') positionAddMenu(); });
  addMenu.addEventListener('toggle', event => { const open = event.newState === 'open'; $('chat-add').setAttribute('aria-expanded', String(open)); if (open) $('chat-add-image').focus(); });
  addMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); addMenu.hidePopover(); $('chat-add').focus(); } });
  window.addEventListener('resize', () => { if (addMenu.matches(':popover-open')) positionAddMenu(); });
  function followBottom(force = false) {
    const panel = $('chat-view-panel');
    const follow = force || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 96;
    return () => { if (follow) panel.scrollTop = panel.scrollHeight; };
  }
  function paintTurn(turn) {
    const scroll = followBottom();
    const reply = turn.replyElement;
    reply.replaceChildren();
    renderChatReply(reply, turn.reply || turn.visibleText || '');
    if (busy && active?.turn === turn && !stopping && !reducedMotion()) {
      const now = performance.now(), walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT), nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      let index = 0;
      turn.wordBirth ||= [];
      nodes.forEach(node => {
        const fragment = document.createDocumentFragment();
        for (const word of node.textContent.match(/\s+|\S+/g) || []) {
          if (/^\s+$/.test(word)) { fragment.append(word); continue; }
          const born = turn.wordBirth[index] ??= now; index++;
          if (now - born >= 160) { fragment.append(word); continue; }
          const span = document.createElement('span'); span.className = 'chat-word'; span.textContent = word;
          span.style.animationDelay = `-${now - born}ms`; fragment.append(span);
        }
        node.replaceWith(fragment);
      });
    }
    turn.errorElement.textContent = turn.error || '';
    turn.errorElement.classList.toggle('hidden', !turn.error);
    const loading = busy && active?.turn === turn && !stopping;
    turn.loadingElement.classList.toggle('hidden', !loading);
    turn.responseElement.setAttribute('aria-busy', String(loading));
    scroll();
  }
  function render(scroll = false) {
    $('chat-results').replaceChildren();
    turns.forEach(turn => {
      const row = document.createElement('section'); row.className = 'photo-chat-turn chat-turn';
      const prompt = document.createElement('div'); prompt.className = 'photo-chat-prompt chat-user-message';
      const text = document.createElement('p'); text.textContent = turn.prompt; prompt.append(text);
      if (turn.attachments?.length) { const files = document.createElement('div'); files.className = 'chat-attachments'; attachmentChips(files, turn.attachments); prompt.append(files); }
      else if (turn.attachmentsCount) { const note = document.createElement('small'); note.className = 'chat-history-attachment-note'; note.textContent = `${turn.attachmentsCount} attachment${turn.attachmentsCount === 1 ? '' : 's'} not saved`; prompt.append(note); }
      const response = document.createElement('div'); response.className = 'chat-response';
      const label = document.createElement('small'); label.textContent = 'Chat';
      const reply = document.createElement('div'); reply.className = 'chat-reply';
      const loading = document.createElement('div'); loading.className = 'chat-loading'; loading.setAttribute('role', 'status'); loading.ariaLabel = turn.thinking ? 'Thinking and generating reply' : 'Generating reply';
      for (let i = 0; i < 3; i++) { const dot = document.createElement('span'); dot.setAttribute('aria-hidden', 'true'); loading.append(dot); }
      const error = document.createElement('p'); error.className = 'photo-error chat-reply-status';
      response.append(label, reply, loading, error); row.append(prompt, response); $('chat-results').append(row);
      Object.assign(turn, { replyElement: reply, loadingElement: loading, errorElement: error, responseElement: response });
      paintTurn(turn);
    });
    availability(); if (scroll) $('chat-view-panel').scrollTop = $('chat-view-panel').scrollHeight;
  }
  function renderHistory() {
    historyPanel.replaceChildren();
    const heading = document.createElement('div'); heading.className = 'chat-history-heading';
    const title = document.createElement('h2'); title.textContent = 'Chat history'; heading.append(title); historyPanel.append(heading);
    if (historyLoading) { const note = document.createElement('p'); note.className = 'help-text'; note.textContent = 'Loading history…'; historyPanel.append(note); return; }
    if (historyError) { const note = document.createElement('p'); note.className = 'help-text photo-error'; note.setAttribute('role', 'alert'); note.textContent = historyError; historyPanel.append(note); return; }
    if (!historyItems.length) { const note = document.createElement('p'); note.className = 'help-text'; note.textContent = 'No saved chats yet.'; historyPanel.append(note); return; }
    historyItems.forEach(item => {
      const card = document.createElement('article'); card.className = 'chat-history-item';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'chat-history-open';
      const name = document.createElement('strong'); name.textContent = item.title || 'Attachment chat';
      const details = document.createElement('small'); details.textContent = `${item.turnCount} repl${item.turnCount === 1 ? 'y' : 'ies'} · ${new Date(item.updatedAt).toLocaleString()}`;
      open.append(name, details); open.addEventListener('click', () => restoreHistory(item.id));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'chat-history-delete'; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete chat ${item.title}`); remove.addEventListener('click', () => deleteHistory(item.id));
      card.append(open, remove); historyPanel.append(card);
    });
  }
  async function loadHistory() {
    if (!getUser() || busy || filesLoading) return;
    const stamp = ++historyEpoch, ownerId = getUser()?.id;
    historyView = true; historyLoading = true; historyError = ''; historyItems = [];
    renderHistory(); availability();
    try {
      const result = await api.chatHistoryList();
      if (stamp !== historyEpoch || ownerId !== getUser()?.id) return;
      if (!result?.success) throw new Error(result?.error || 'Could not load Chat History.');
      historyItems = Array.isArray(result.items) ? result.items : [];
    } catch (error) { if (stamp === historyEpoch) historyError = error.message || 'Could not load Chat History.'; }
    finally { if (stamp === historyEpoch) { historyLoading = false; renderHistory(); availability(); } }
  }
  async function restoreHistory(id) {
    if (busy || filesLoading || historyLoading) return;
    const stamp = ++historyEpoch, ownerId = getUser()?.id;
    historyLoading = true; historyError = ''; renderHistory(); availability();
    try {
      const result = await api.chatHistoryLoad(id);
      if (stamp !== historyEpoch || ownerId !== getUser()?.id) return;
      if (!result?.success || !result.conversation) throw new Error(result?.error || 'Could not reopen this chat.');
      conversationId = result.conversation.id;
      turns = result.conversation.turns.map(turn => ({ ...turn, attachments: [], visibleText: turn.reply }));
      historyView = false; status(''); render(true);
    } catch (error) { if (stamp === historyEpoch) { historyError = error.message || 'Could not reopen this chat.'; historyView = true; } }
    finally { if (stamp === historyEpoch) { historyLoading = false; renderHistory(); availability(); } }
  }
  async function deleteHistory(id) {
    if (historyLoading) return;
    const stamp = ++historyEpoch;
    historyLoading = true; historyError = ''; renderHistory(); availability();
    try {
      const result = await api.chatHistoryDelete(id);
      if (stamp !== historyEpoch) return;
      if (!result?.success || !result.deleted) throw new Error(result?.error || 'Could not delete this chat.');
      historyItems = historyItems.filter(item => item.id !== id);
      if (conversationId === id) { conversationId = null; generation++; api.chatReset().catch(() => {}); turns = []; attachments = []; attachmentChips($('chat-attachments'), attachments, true); $('chat-prompt').value = ''; render(); }
    } catch (error) { if (stamp === historyEpoch) historyError = error.message || 'Could not delete this chat.'; }
    finally { if (stamp === historyEpoch) { historyLoading = false; renderHistory(); availability(); } }
  }
  async function saveHistory(stamp) {
    const completed = turns.filter(turn => turn.reply).map(turn => ({ prompt: turn.prompt, reply: turn.reply, thinking: Boolean(turn.thinking), attachmentsCount: turn.attachments?.length || turn.attachmentsCount || 0 }));
    if (!completed.length) return;
    try {
      const result = await api.chatHistorySave(conversationId, completed);
      if (stamp !== generation || getUser()?.id !== account) return;
      if (!result?.success) throw new Error(result?.error || 'Could not save Chat History.');
      conversationId = result.id;
    } catch (error) { if (stamp === generation) status(`Reply ready, but Chat History could not be saved: ${error.message || 'Please try again.'}`, true); }
  }
  api.onChatChunk(({ requestId, delta }) => {
    if (!busy || stopping || active?.requestId !== requestId || typeof delta !== 'string') return;
    if (delta && !active.received) { active.received = true; status('Generating reply…'); }
    active.reveal.feed(delta);
  });
  async function credits() {
    const stamp = generation;
    try { const result = await api.getStudioCredits(); if (stamp === generation) $('chat-credits').textContent = result.success && Number.isFinite(result.credits?.credits) ? `${Math.round(result.credits.credits).toLocaleString()} credits` : 'Balance unavailable'; }
    catch { if (stamp === generation) $('chat-credits').textContent = 'Balance unavailable'; }
  }
  async function send() {
    if (busy || filesLoading) return;
    if (!getUser()) return signIn();
    const prompt = $('chat-prompt').value.trim(); if (!prompt && !attachments.length) return;
    const messages = turns.filter(turn => turn.reply).flatMap(turn => [{ role: 'user', content: turn.prompt, ...(turn.attachments?.length && { attachments: turn.attachments.map(file => file.id) }) }, { role: 'assistant', content: turn.reply }]);
    messages.push({ role: 'user', content: prompt, ...(attachments.length && { attachments: attachments.map(file => file.id) }) });
    if (messages.length > catalog.maxMessages || messages.reduce((sum, message) => sum + message.content.length, 0) > catalog.maxConversationChars) return status('This conversation is full. Start a new chat to continue.', true);
    const stamp = generation, turn = { prompt, thinking, attachments: [...attachments], visibleText: '' };
    const request = { requestId: crypto.randomUUID(), turn, providerDone: false };
    request.reveal = createWordReveal({ reducedMotion, update(text) { if (stamp !== generation || active !== request || stopping) return; turn.visibleText = text; paintTurn(turn); } });
    active = request;
    attachments = []; attachmentChips($('chat-attachments'), attachments, true);
    turns.push(turn); busy = true; addMenu.hidePopover(); $('chat-prompt').value = ''; render(true); status(thinking ? 'Thinking…' : 'Replying…');
    try {
      const result = await api.chatRun({ requestId: request.requestId, messages, thinking: turn.thinking });
      if (stamp !== generation) return;
      request.providerDone = true;
      if (turn.stopped) { status('Reply stopped.'); return; }
      if (!result.success) throw new Error(result.error || 'Chat failed. Try again.');
      await request.reveal.finish(result.reply);
      if (stamp !== generation) return;
      if (turn.stopped) { status('Reply stopped.'); return; }
      turn.reply = result.reply; status('Reply ready.'); await saveHistory(stamp);
    } catch (error) {
      if (stamp !== generation) return;
      attachments = turn.attachments; attachmentChips($('chat-attachments'), attachments, true);
      turn.error = turn.stopped ? 'Reply stopped.' : error.message || 'Chat failed. Try again.'; $('chat-prompt').value = prompt; status(turn.error, !turn.stopped);
    } finally {
      request.reveal.cancel();
      if (stamp === generation) {
        if (turn.stopped) { turn.error = 'Reply stopped.'; attachments = turn.attachments; attachmentChips($('chat-attachments'), attachments, true); $('chat-prompt').value = prompt; }
        const scroll = followBottom(); busy = false; stopping = false; active = null; render(); scroll(); credits(); refreshCredits(); $('chat-prompt').focus();
      }
    }
  }
  function stop() {
    if (!active || stopping) return;
    active.turn.stopped = true; active.turn.error = 'Reply stopped.'; stopping = true;
    active.reveal.cancel(); paintTurn(active.turn); availability(); status('Stopping…');
    if (!active.providerDone) api.chatCancel().catch(() => {});
  }
  $('chat-thinking').addEventListener('click', () => { if ($('chat-thinking').disabled || busy) return; thinking = !thinking; availability(); });
  $('chat-send').addEventListener('click', () => busy ? stop() : send());
  $('chat-prompt').addEventListener('input', availability);
  $('chat-prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('chat-send').disabled) send(); } });
  $('chat-signin-btn').addEventListener('click', signIn);
  const transcript = () => turns.filter(turn => turn.reply || turn.visibleText).map(turn => `You: ${turn.prompt}${turn.attachments?.length ? '\nAttached: ' + turn.attachments.map(file => file.name).join(', ') : ''}\n\nChat: ${turn.reply || turn.visibleText}${!turn.reply ? '\n[Incomplete reply]' : ''}`).join('\n\n');
  for (const action of ['copy', 'save']) $('chat-' + action).addEventListener('click', async () => {
    const stamp = generation;
    try { const result = await api[action === 'copy' ? 'chatCopy' : 'chatSave'](transcript()); if (stamp !== generation) return; if (!result.success) throw new Error(result.error); if (!result.canceled) status(action === 'copy' ? 'Conversation copied.' : 'Conversation saved.'); }
    catch (error) { if (stamp === generation) status(error.message || 'Could not export this chat.', true); }
  });
  historyButton.addEventListener('click', () => {
    if (!historyView) return loadHistory();
    historyEpoch++; historyView = false; historyLoading = false; historyError = ''; render(); $('chat-prompt').focus();
  });
  $('chat-new').addEventListener('click', () => {
    if (busy || filesLoading) return;
    generation++; historyEpoch++; conversationId = null; historyView = false; historyLoading = false; historyError = '';
    api.chatReset().catch(() => {}); turns = []; attachments = []; attachmentChips($('chat-attachments'), attachments, true); $('chat-prompt').value = ''; status(''); render(); $('chat-prompt').focus();
  });
  function authChanged() {
    const next = getUser()?.id || null;
    if (next !== account) { generation++; historyEpoch++; conversationId = null; historyView = false; historyLoading = false; historyError = ''; historyItems = []; active?.reveal.cancel(); active = null; api.chatReset().catch(() => {}); turns = []; attachments = []; attachmentChips($('chat-attachments'), attachments, true); filesLoading = false; busy = false; stopping = false; account = next; $('chat-prompt').value = ''; $('chat-credits').textContent = 'Studio credits'; addMenu.hidePopover(); status(''); render(); }
    availability();
  }
  render();
  return { authChanged, activate: () => { authChanged(); if (getUser()) credits(); } };
}
