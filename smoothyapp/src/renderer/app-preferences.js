import writing from '../shared/chat-writing.json';

export function initAppPreferences({ applyStudio }) {
  const api = window.electronAPI, $ = id => document.getElementById(id);
  let preferences = { studioEnabled: true, appearance: 'system', chatWritingPrompt: writing.defaultPrompt }, writingBusy = false;
  const editor = $('chat-writing-prompt');
  editor.value = writing.defaultPrompt; editor.maxLength = writing.maxPromptChars;
  let autosaveTimer = null;
  function writingControls() {
    const valid = editor.value.length <= writing.maxPromptChars;
    $('chat-writing-count').textContent = `${editor.value.length.toLocaleString()} / ${writing.maxPromptChars.toLocaleString()} characters`;
    $('chat-writing-save').disabled = writingBusy || !valid || editor.value.trim() === preferences.chatWritingPrompt;
    $('chat-writing-reset').disabled = writingBusy || (editor.value === writing.defaultPrompt && preferences.chatWritingPrompt === writing.defaultPrompt);
  }
  function apply(value, replacePrompt = false) {
    if (!value || typeof value.studioEnabled !== 'boolean') return;
    const changed = preferences.studioEnabled !== value.studioEnabled;
    const cleanEditor = editor.value === preferences.chatWritingPrompt;
    preferences = { ...preferences, ...value }; $('studio-enabled-toggle').checked = value.studioEnabled;
    showAppearance(preferences.appearance);
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
      apply(result, replacePrompt);
      const status = $('chat-writing-status');
      status.textContent = savedMessage;
      status.classList.add('settings-autosave-hint');
    } catch (error) {
      const status = $('chat-writing-status');
      status.textContent = error.message;
      status.classList.remove('settings-autosave-hint');
    } finally { writingBusy = false; writingControls(); }
  }
  editor.addEventListener('input', () => {
    writingControls();
    clearTimeout(autosaveTimer);
    const status = $('chat-writing-status');
    status.classList.remove('settings-autosave-hint');
    if (editor.value.length > writing.maxPromptChars) { status.textContent = 'Too long to save.'; return; }
    status.textContent = 'Saving…';
    autosaveTimer = setTimeout(() => {
      if (editor.value.trim() === preferences.chatWritingPrompt) {
        status.textContent = 'Saved';
        status.classList.add('settings-autosave-hint');
        return;
      }
      updateWriting(() => api.saveChatWritingPrompt(editor.value), 'Saved', false);
    }, 500);
  });
  $('chat-writing-save').addEventListener('click', () => { clearTimeout(autosaveTimer); updateWriting(() => api.saveChatWritingPrompt(editor.value), 'Saved', true); });
  $('chat-writing-reset').addEventListener('click', () => { clearTimeout(autosaveTimer); updateWriting(() => api.resetChatWritingPrompt(), 'Cleared', true); });
  $('studio-enabled-toggle').addEventListener('change', async event => {
    const toggle = event.target; toggle.disabled = true;
    try { const result = await api.setStudioEnabled(toggle.checked); if (!result?.success) throw Error(result?.error || 'Could not save this preference.'); apply(result); $('studio-preference-status').textContent = result.studioEnabled ? 'Studio AI is enabled.' : 'Studio AI is off. Your free local tools are ready.'; }
    catch (error) { toggle.checked = preferences.studioEnabled; $('studio-preference-status').textContent = error.message; }
    finally { toggle.disabled = false; }
  });
  function showAppearance(value) {
    document.querySelectorAll('#appearance-control [data-appearance]').forEach(button => {
      const on = button.dataset.appearance === value;
      button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1;
    });
  }
  const appearanceControl = $('appearance-control');
  async function chooseAppearance(value) {
    if (!value || value === preferences.appearance) return;
    const before = preferences.appearance; showAppearance(value);
    try {
      const result = await api.setAppearance(value);
      if (!result?.success) throw Error(result?.error || 'Could not save this preference.');
      apply(result); $('appearance-status').textContent = '';
    } catch (error) { showAppearance(before); $('appearance-status').textContent = error.message; }
  }
  appearanceControl?.addEventListener('click', event => chooseAppearance(event.target.closest('[data-appearance]')?.dataset.appearance));
  appearanceControl?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...appearanceControl.querySelectorAll('[data-appearance]')];
    const index = buttons.findIndex(b => b.dataset.appearance === preferences.appearance);
    const next = buttons[(index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? buttons.length - 1 : 1)) % buttons.length];
    next.focus(); chooseAppearance(next.dataset.appearance);
  });
  api.onAppPreferencesChanged(apply);
  writingControls();
  return { load: async () => { try { apply(await api.getAppPreferences()); } catch {} }, enabled: () => preferences.studioEnabled };
}
