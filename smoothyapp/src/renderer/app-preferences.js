import writing from '../shared/chat-writing.json';

export function initAppPreferences({ applyStudio }) {
  const api = window.electronAPI, $ = id => document.getElementById(id);
  let preferences = { studioEnabled: true, chatWritingPrompt: writing.defaultPrompt }, writingBusy = false;
  const editor = $('chat-writing-prompt');
  editor.value = writing.defaultPrompt; editor.maxLength = writing.maxPromptChars;
  function writingControls() {
    const valid = editor.value.length <= writing.maxPromptChars;
    $('chat-writing-count').textContent = `${editor.value.length.toLocaleString()} / ${writing.maxPromptChars.toLocaleString()} characters`;
    $('chat-writing-save').disabled = writingBusy || !valid || editor.value.trim() === preferences.chatWritingPrompt;
    $('chat-writing-reset').disabled = writingBusy || (editor.value === writing.defaultPrompt && preferences.chatWritingPrompt === writing.defaultPrompt);
    editor.disabled = writingBusy;
  }
  function apply(value, replacePrompt = false) {
    if (!value || typeof value.studioEnabled !== 'boolean') return;
    const changed = preferences.studioEnabled !== value.studioEnabled;
    const cleanEditor = editor.value === preferences.chatWritingPrompt;
    preferences = { ...preferences, ...value }; $('studio-enabled-toggle').checked = value.studioEnabled;
    if (cleanEditor || replacePrompt) editor.value = preferences.chatWritingPrompt;
    writingControls();
    applyStudio(value.studioEnabled, changed);
  }
  async function updateWriting(action, savedMessage, replacePrompt = false) {
    if (writingBusy) return;
    writingBusy = true; writingControls();
    try {
      const result = await action();
      if (!result?.success) throw Error(result?.error || 'Could not save writing preferences.');
      apply(result, replacePrompt); $('chat-writing-status').textContent = savedMessage;
    } catch (error) {
      $('chat-writing-status').textContent = error.message;
    } finally { writingBusy = false; writingControls(); }
  }
  editor.addEventListener('input', () => { writingControls(); $('chat-writing-status').textContent = 'Unsaved changes.'; });
  $('chat-writing-save').addEventListener('click', () => updateWriting(() => api.saveChatWritingPrompt(editor.value), 'Saved.', true));
  $('chat-writing-reset').addEventListener('click', () => updateWriting(() => api.resetChatWritingPrompt(), 'Cleared.', true));
  $('studio-enabled-toggle').addEventListener('change', async event => {
    const toggle = event.target; toggle.disabled = true;
    try { const result = await api.setStudioEnabled(toggle.checked); if (!result?.success) throw Error(result?.error || 'Could not save this preference.'); apply(result); $('studio-preference-status').textContent = result.studioEnabled ? 'Studio AI is enabled.' : 'Studio AI is off. Your free local tools are ready.'; }
    catch (error) { toggle.checked = preferences.studioEnabled; $('studio-preference-status').textContent = error.message; }
    finally { toggle.disabled = false; }
  });
  api.onAppPreferencesChanged(apply);
  writingControls();
  return { load: async () => { try { apply(await api.getAppPreferences()); } catch {} }, enabled: () => preferences.studioEnabled };
}
