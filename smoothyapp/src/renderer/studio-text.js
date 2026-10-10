import catalog from '../shared/studio-catalog.json';
import { renderStudioResult, formatStudioResult } from './studio-results.js';
import { createPhotoPicker } from './photo-picker.js';
const proModes = ['thumbnail', 'broll', 'twitter', 'blog', 'sfx'];
const screens = {
  condense: { result: 'Your condense plan', run: 'Suggest edit ranges', help: 'Review the suggested ranges, then arrange and cut the footage in your editor.' },
  hook: { result: 'Your hook ideas', run: 'Suggest openings', help: 'Choose an opening that fits your video, then build it in your editor.' },
  title: { result: 'Your title options', run: 'Draft titles', help: 'Edit your favorite title and check it accurately represents your video.' },
  description: { result: 'Your description draft', run: 'Draft description', help: 'Check the facts, timestamps and links before publishing your description.' },
  thumbnail: { result: 'Your thumbnail concepts', run: 'Suggest thumbnail concepts', help: 'Use these concepts as a starting point to design your finished thumbnail.' },
  broll: { result: 'Your B-roll suggestions', run: 'Suggest B-roll', help: 'Find suitable footage and place it on your timeline. Check its license.' },
  twitter: { result: 'Your social post drafts', run: 'Draft social posts', help: 'Review each post, adjust the tone and publish it yourself.' },
  blog: { result: 'Your blog draft', run: 'Draft blog post', help: 'Edit the article, check the facts and add your links before publishing.' },
  sfx: { result: 'Your sound-effect cues', run: 'Suggest sound cues', help: 'Choose licensed audio and place each effect on your timeline.' },
};
const colors = ['#ffc99a', '#ffe08c', '#9edbf8', '#abc8ff', '#d3b5ff', '#a5e4c9', '#ffc0df', '#9de2df', '#bfb8ff'];

// Provider output is rendered as text only; Markdown/HTML is never executed.
export function readableDraft(raw) {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const data = JSON.parse(cleaned);
    const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    function lines(value, depth = 0) {
      if (depth > 12) return JSON.stringify(value);
      if (Array.isArray(value)) return value.map((item, i) => `${i + 1}. ${lines(item, depth + 1)}`).join('\n\n');
      if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${label(key)}: ${typeof item === 'object' && item !== null ? '\n' : ''}${lines(item, depth + 1)}`).join('\n');
      return value == null ? '' : String(value);
    }
    return lines(data);
  } catch { return raw; }
}

export function initStudioText({ getUser, enabled, signIn, refreshCredits, getInputConfig, getWorkspace, onSource, runShorts, selectChannel, onStateChange }) {
  const $ = id => document.getElementById(id), api = window.electronAPI;
  $('studio-text-empty').querySelector('span:last-child')?.remove();
  let mode = catalog[0].id, busy = false, loading = false, historyView = false, page = 1, pages = 1;
  let editAsText = false;
  let account = null, epoch = 0, sourceName = 'TXT, SRT or VTT · up to 5 MB', raw = '', resultMode = null;
  const drafts = new Map();
  let preparedMedia = null;
  const status = (message, error = false) => { $('studio-text-status').textContent = message; $('studio-text-status').classList.toggle('photo-error', error); $('studio-text-status').classList.toggle('studio-status-visible', error || busy || loading); };
  const videoTypePicker = createPhotoPicker('studio-broll-type', { onChange: () => availability() });
  videoTypePicker.setItems(['Talking head', 'Interview', 'Educational', 'Vlog', 'Documentary'].map(value => ({ value, label: value })));
  function closeMenus() {
    videoTypePicker.close();
    ['studio-options-popup'].forEach(id => { if ($(id).matches(':popover-open')) $(id).hidePopover(); });
  }
  function availability() {
    const signedIn = Boolean(getUser()) && enabled(), workspace = getWorkspace(), shorts = workspace.mode === 'shorts', hiddenComposer = shorts ? workspace.history : historyView, working = busy || loading || workspace.busy;
    $('studio-compose-footer').classList.toggle('hidden', !signedIn || hiddenComposer);
    $('studio-text-status').classList.toggle('hidden', shorts && !loading && !$('studio-text-status').classList.contains('photo-error'));
    $('studio-text-status').classList.toggle('studio-status-visible', $('studio-text-status').classList.contains('photo-error') || busy || loading);
    $('studio-shorts-options').classList.toggle('hidden', !shorts);
    $('analyze-shorts-btn').classList.toggle('hidden', !shorts);
    $('studio-text-source-heading').textContent = 'Input';
    $('studio-text-signin').classList.toggle('hidden', signedIn);
    $('studio-text-workspace').classList.toggle('hidden', !signedIn || historyView);
    $('studio-text-history').classList.toggle('hidden', !signedIn || !historyView);
    $('studio-text-composer').classList.toggle('hidden', !signedIn || hiddenComposer);
    $('studio-text-empty').classList.toggle('hidden', !$('studio-text-result-section').classList.contains('hidden'));
    $('studio-text-run').classList.toggle('hidden', shorts || historyView || !signedIn);
    const locked = proModes.includes(mode) && getUser()?.tier !== 'pro';
    $('studio-text-pro').classList.toggle('hidden', !locked);
    const config = getInputConfig();
    const ready = config.source === 'sequence' ? Boolean(preparedMedia?.source === 'sequence') || workspace.connected : config.source === 'audio' ? Boolean(config.audioPath) : Boolean(config.subtitleText?.trim());
    $('studio-text-run').disabled = working || locked || !ready;
    $('analyze-shorts-btn').disabled = working || !signedIn || !ready;
    $('studio-text-options').classList.toggle('hidden', !shorts && !['condense','broll'].includes(mode));
    $('studio-condense-options').classList.toggle('hidden', shorts || mode !== 'condense'); $('studio-broll-options').classList.toggle('hidden', shorts || mode !== 'broll');
    $('studio-text-run').textContent = busy ? 'Working…' : screens[mode].run;
    $('studio-text-cancel').classList.toggle('hidden', !(loading || (!shorts && busy)));
    $('studio-text-history-toggle').disabled = busy || loading || !signedIn;
    $('studio-text-history-toggle').textContent = historyView ? '← Back to tools' : 'History';
    ['studio-text-options', 'studio-text-upload', 'shorts-audio-browse', 'shorts-youtube-url', 'shorts-youtube-load', 'bestshorts-refresh-btn', 'studio-condense-duration', 'studio-broll-type', 'studio-text-refine-btn', 'studio-result-edit'].forEach(id => { $(id).disabled = working; });
    document.querySelectorAll('[data-shorts-source], input[name=shorts-mode]').forEach(el => { el.disabled = working; });
    document.querySelectorAll('#studio-result-cards [contenteditable]').forEach(el => { el.contentEditable = busy ? 'false' : 'plaintext-only'; });
    document.querySelectorAll('#studio-result-cards button').forEach(el => { el.disabled = busy; });
    document.querySelectorAll('.studio-broll-categories input').forEach(input => { input.disabled = busy || loading; });
    $('studio-text-result').disabled = busy;
    $('studio-text-refine-btn').disabled ||= !raw || locked;
    $('studio-text-history-prev').disabled = loading || page <= 1;
    $('studio-text-history-next').disabled = loading || page >= pages;
    onStateChange?.();
  }
  function renderResult() {
    $('studio-text-result').value = formatStudioResult(raw, mode);
    renderStudioResult($('studio-result-cards'), raw, mode, {
      onChange: value => { raw = value; $('studio-text-result').value = formatStudioResult(value, mode); },
      onCopy: async text => { try { const result = await api.studioToolsCopy(text); if (!result.success) throw new Error(result.error); status('Section copied.'); } catch (error) { status(error.message, true); } },
    });
    $('studio-result-cards').classList.toggle('hidden', editAsText); $('studio-text-result').hidden = !editAsText;
    $('studio-result-edit').textContent = editAsText ? 'Formatted view' : 'Edit as text'; $('studio-result-edit').setAttribute('aria-pressed', String(editAsText));
  }
  function showResult(value, forMode = mode) { raw = value; resultMode = forMode; editAsText = false; renderResult(); $('studio-text-result-section').classList.remove('hidden'); availability(); }
  $('studio-result-edit').addEventListener('click', () => { editAsText = !editAsText; renderResult(); availability(); });
  function remember() {
    drafts.set(mode, {
      result: $('studio-text-result').value,
      raw, resultMode, editAsText, refine: $('studio-text-refine').value,
      duration: $('studio-condense-duration').value,
      videoType: $('studio-broll-type').value,
      categories: [...document.querySelectorAll('.studio-broll-categories input:checked')].map(item => item.value),
      resultVisible: !$('studio-text-result-section').classList.contains('hidden'),
      scroll: document.querySelector('.studio-text-scroll').scrollTop,
      status: $('studio-text-status').textContent, error: $('studio-text-status').classList.contains('photo-error'),
    });
  }
  function activate(next) {
    if (!catalog.some(tool => tool.id === next) || busy || !enabled()) { selectChannel(mode); return; }
    const changed = next !== mode;
    if (changed) remember();
    closeMenus();
    mode = next;
    const tool = catalog.find(tool => tool.id === mode), description = tool.description.replaceAll('transcript', 'subtitles'), color = colors[catalog.indexOf(tool)], screen = screens[mode];
    $('tab-studio-text').style.setProperty('--tab-accent', color);
    $('tab-studio-text').dataset.tool = mode;
    $('studio-text-heading').textContent = tool.label; $('studio-text-description').textContent = description;
    $('studio-workspace-description').textContent = description;
    document.querySelectorAll('[data-studio-mode]').forEach(button => { const item = catalog.find(tool => tool.id === button.dataset.studioMode); if (item) button.title = `${item.label}: ${item.description.replaceAll('transcript', 'subtitles')}`; });
    $('studio-text-result-heading').textContent = screen.result;
    $('studio-text-result-help').textContent = screen.help;
    $('studio-text-result').setAttribute('aria-label', screen.result);
    $('studio-condense-options').classList.toggle('hidden', mode !== 'condense'); $('studio-broll-options').classList.toggle('hidden', mode !== 'broll');
    $('studio-text-options').classList.toggle('hidden', !['condense', 'broll'].includes(mode));
    if (changed) {
      epoch++; loading = false; historyView = false; page = pages = 1;
      const saved = drafts.get(mode);
      raw = saved?.raw || ''; resultMode = saved?.resultMode || null; editAsText = saved?.editAsText || false;
      $('studio-text-result').value = saved?.result || '';
      $('studio-text-refine').value = saved?.refine || '';
      $('studio-condense-duration').value = saved?.duration || ''; videoTypePicker.select(saved?.videoType || 'Talking head');
      document.querySelectorAll('.studio-broll-categories input').forEach(item => { item.checked = (saved?.categories || ['stock footage', 'graphics', 'screen recordings']).includes(item.value); });
      $('studio-text-source-name').textContent = sourceName;
      $('studio-text-result-section').classList.toggle('hidden', !saved?.resultVisible);
      $('studio-text-history-items').replaceChildren(); renderResult();
      document.querySelector('.studio-text-scroll').scrollTop = saved?.scroll || 0;
      status(saved?.status || `Add subtitles to ${screen.run.toLowerCase()}.`, saved?.error || false);
    }
    selectChannel(mode); availability();
  }
  function setSource(text, name) { if (!enabled()) return; $('studio-text-input').value = text; sourceName = name; $('studio-text-source-name').textContent = name; closeMenus(); onSource(text, name); availability(); status('Subtitles ready. Choose a tool to get ideas.'); }
  $('studio-text-signin-btn').addEventListener('click', signIn);
  $('studio-text-upgrade').addEventListener('click', () => api.openExternal('https://smoothyedit.com/pricing'));
  $('studio-text-composer').addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing && !(getWorkspace().mode === 'shorts' ? $('analyze-shorts-btn') : $('studio-text-run')).disabled) { event.preventDefault(); if (getWorkspace().mode === 'shorts') runShorts(); else run(); }
  });
  async function importSource(config = getInputConfig()) {
    const stamp = epoch; loading = true; closeMenus(); availability(); status('Reading your source locally…');
    try { const result = await api.studioSourceImport(config); if (stamp !== epoch) return false; if (!result.success) throw new Error(result.error); if (result.canceled) return false; loading = false; if (config.source === 'transcript') setSource(result.subtitleText, result.fileName); else { preparedMedia = { source: config.source, audioPath: config.audioPath, subtitleText: result.subtitleText, fileName: result.fileName }; status('Subtitles ready.'); } return true; }
    catch (error) { if (stamp === epoch) status(error.message || 'Could not read this source.', true); return false; }
    finally { if (stamp === epoch) { loading = false; availability(); } }
  }
  api.onStudioSourceProgress(data => { if (loading) status(data.message); });
  $('studio-text-upload').addEventListener('click', () => importSource({ source: 'transcript' }));
  async function prepareSource() {
    const config = getInputConfig();
    if (!['sequence','audio'].includes(config.source)) return true;
    if (preparedMedia?.source === config.source && preparedMedia.audioPath === config.audioPath) return true;
    return await importSource(config);
  }
  function preparedInput() {
    const config = getInputConfig();
    return ['sequence','audio'].includes(config.source) ? { source: 'transcript', subtitleText: preparedMedia?.subtitleText || '', fileName: preparedMedia?.fileName || '' } : config;
  }
  function input() {
    const config = preparedInput();
    const data = { mode, subtitleText: config.subtitleText || '', fileName: config.fileName || sourceName };
    if (mode === 'condense' && $('studio-condense-duration').value.trim()) data.duration = Number($('studio-condense-duration').value);
    if (mode === 'broll') { data.videoType = $('studio-broll-type').value; data.brollCategories = [...document.querySelectorAll('.studio-broll-categories input:checked')].map(item => item.value); }
    return data;
  }
  async function run(refine = false) {
    if (busy || loading || !enabled()) return;
    if (!getUser()) return signIn();
    if (!await prepareSource()) return;
    const data = input(); if (refine) { if (!raw || resultMode !== mode || !$('studio-text-refine').value.trim()) return status('Add a refinement request below your draft.', true); data.followUp = $('studio-text-refine').value.trim(); data.currentResult = raw; }
    const stamp = epoch; busy = true; closeMenus(); availability(); status(refine ? 'Refining your draft…' : 'Finding ideas in your subtitles…');
    try {
      const result = await api.studioToolsRun(data); if (stamp !== epoch) return;
      if (!result.success) throw new Error(result.error);
      showResult(result.raw); status(result.warning || 'Draft ready. Review it and make your edit.'); $('studio-text-refine').value = ''; refreshCredits();
      $('studio-text-result-section').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } catch (error) { if (stamp === epoch) status(error.message || 'Studio request failed.', true); }
    finally { if (stamp === epoch) { busy = false; availability(); } }
  }
  $('studio-text-run').addEventListener('click', () => run()); $('studio-text-refine-btn').addEventListener('click', () => run(true));
  $('studio-text-cancel').addEventListener('click', () => { epoch++; busy = false; api.studioToolsCancel().catch(() => {}); api.studioSourceCancel().catch(() => {}); loading = false; availability(); status('Request canceled. Work already accepted by Studio may use credits.'); });
  $('studio-text-result').addEventListener('input', () => { raw = JSON.stringify({ draft: $('studio-text-result').value }); });
  ['copy', 'save'].forEach(action => $(`studio-text-${action}`).addEventListener('click', async () => {
    const stamp = epoch;
    try { const text = $('studio-text-result').value; const result = action === 'copy' ? await api.studioToolsCopy(text) : await api.studioToolsSave({ mode, text }); if (stamp !== epoch) return; if (!result.success) throw new Error(result.error); if (!result.canceled) status(action === 'copy' ? 'Draft copied.' : 'Text draft saved.'); }
    catch (error) { if (stamp === epoch) status(error.message, true); }
  }));
  async function loadHistory() {
    if (!getUser() || !enabled()) return;
    const stamp = ++epoch; loading = true; availability(); $('studio-text-history-items').replaceChildren(); status('Loading shared history…');
    try {
      const result = await api.studioToolsHistory({ mode, page }); if (stamp !== epoch) return;
      if (!result.success) throw new Error(result.error); pages = Math.max(1, result.totalPages || 1);
      result.items.forEach(item => {
        if (typeof item.result !== 'string') return;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'studio-history-item'; button.textContent = `${item.fileName || 'Subtitles'} · ${new Date(item.createdAt).toLocaleDateString()}`;
        button.addEventListener('click', () => { historyView = false; showResult(item.result); status('History draft loaded. Add its subtitles to refine it, or copy/save the draft.'); }); $('studio-text-history-items').append(button);
      });
      if (!result.items.length) $('studio-text-history-items').textContent = 'No saved drafts for this tool yet.';
      $('studio-text-history-page').textContent = `Page ${page} of ${pages}`; status('Shared history loaded.');
    } catch (error) { if (stamp === epoch) status(error.message, true); }
    finally { if (stamp === epoch) { loading = false; availability(); } }
  }
  $('studio-text-history-toggle').addEventListener('click', () => { historyView = !historyView; availability(); if (historyView) { page = 1; loadHistory(); } });
  $('studio-text-history-refresh').addEventListener('click', loadHistory);
  $('studio-text-history-prev').addEventListener('click', () => { if (page > 1) { page--; loadHistory(); } });
  $('studio-text-history-next').addEventListener('click', () => { if (page < pages) { page++; loadHistory(); } });
  function authChanged() {
    const next = enabled() ? getUser()?.id || null : null;
    if (next !== account) {
      account = next; preparedMedia = null; drafts.clear(); epoch++; busy = loading = false; historyView = false; raw = ''; resultMode = null; page = pages = 1;
      closeMenus();
      api.studioToolsCancel().catch(() => {}); api.studioSourceCancel().catch(() => {});
      ['studio-text-input', 'studio-text-result', 'studio-text-refine'].forEach(id => { $(id).value = ''; });
      $('studio-text-history-items').replaceChildren(); $('studio-result-cards').replaceChildren(); $('studio-text-result-section').classList.add('hidden'); sourceName = 'TXT, SRT or VTT · up to 5 MB'; $('studio-text-source-name').textContent = sourceName; status('Choose a tool and add subtitles.');
    }
    availability();
  }
  authChanged(); activate(mode);
  return { activate, authChanged, setSource, prepareSource, preparedInput, hasPreparedSource: () => preparedMedia?.source === getInputConfig().source, invalidateSource: () => { preparedMedia = null; }, refresh: availability, getSource: () => ({ text: $('studio-text-input').value, name: sourceName }), isBusy: () => busy || loading };
}
