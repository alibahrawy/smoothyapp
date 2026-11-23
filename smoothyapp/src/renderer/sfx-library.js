import { editorName, editorText } from './editor-context';
import { formatDuration, favoriteIcon } from './audio-player.js';

const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><path d="M9 5.5v13l10-6.5z"/></svg>';
const STOP = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';
const SFX_FAV_KEY = 'smoothyedit:sfx:favorites';

/** Sound effects: a bundled, redistribution-safe library. Search, preview, save as WAV, or send to the editor. */
export function initSfxLibrary({ isConnected }) {
  const api = window.electronAPI, el = id => document.getElementById('sfx-' + id);
  const tab = document.getElementById('audio-view-sfx'), panel = el('panel'), root = document.getElementById('tab-audio');
  const dock = document.querySelector('.audio-player-dock'), music = document.getElementById('audio-dock-player');
  const favorites = new Set((() => { try { return JSON.parse(localStorage.getItem(SFX_FAV_KEY) || '[]'); } catch { return []; } })());
  const saveFavorites = () => { try { localStorage.setItem(SFX_FAV_KEY, JSON.stringify([...favorites])); } catch {} };
  const state = { sounds: [], categories: [], category: 'all', favoritesOnly: false, total: 0, hasMore: false, searching: false, busy: false, busyId: '', playing: '', selectedId: '', generation: 0, loaded: false };
  const player = new Audio(); player.preload = 'auto';
  let timer;
  const message = (text, error = false) => { el('status').textContent = text; el('status').classList.toggle('stock-error', error); };
  const visibleSounds = () => state.favoritesOnly ? state.sounds.filter(s => favorites.has(s.id)) : state.sounds;

  function stop() { player.pause(); player.removeAttribute('src'); player.load(); state.playing = ''; markPlaying(); }
  function markPlaying() {
    for (const row of el('results').children) {
      const playing = row.dataset.id === state.playing, button = row.querySelector('.audio-row-play');
      row.classList.toggle('selected', playing || row.dataset.id === state.selectedId);
      button.innerHTML = playing ? STOP : PLAY;
      button.setAttribute('aria-label', (playing ? 'Stop ' : 'Play ') + row.dataset.title);
    }
  }
  function toggle(sound) {
    state.selectedId = sound.id;
    if (state.playing === sound.id) { stop(); return; }
    player.src = sound.previewUrl; state.playing = sound.id; markPlaying();
    // One count per sound the user starts, not per replay buffer or seek.
    player.play().then(() => { if (state.playing === sound.id) api.trackMediaPreview('sfx').catch(() => {}); })
      .catch(() => { if (state.playing === sound.id) { state.playing = ''; markPlaying(); message('This sound could not be played. Try another one.', true); } });
  }
  player.addEventListener('ended', () => { state.playing = ''; markPlaying(); });

  function toggleFavorite(sound, button) {
    if (favorites.has(sound.id)) favorites.delete(sound.id);
    else favorites.add(sound.id);
    saveFavorites();
    const active = favorites.has(sound.id);
    favoriteIcon(button, active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', (active ? 'Remove favorite ' : 'Favorite ') + sound.title);
    render(state.categories);
  }

  function row(sound) {
    const tr = document.createElement('tr'); tr.className = 'audio-track'; tr.dataset.id = sound.id; tr.dataset.title = sound.title;
    const cell = (text, name = '') => { const td = document.createElement('td'); td.className = name; td.textContent = text; tr.append(td); return td; };
    const play = document.createElement('button'); play.type = 'button'; play.className = 'audio-row-play'; play.innerHTML = PLAY; play.setAttribute('aria-label', 'Play ' + sound.title);
    play.addEventListener('click', () => toggle(sound)); cell('', 'audio-play-cell').append(play);
    const fav = document.createElement('button'); fav.type = 'button'; fav.className = 'sfx-fav-btn';
    const isFav = favorites.has(sound.id);
    favoriteIcon(fav, isFav);
    fav.setAttribute('aria-pressed', String(isFav));
    fav.setAttribute('aria-label', (isFav ? 'Remove favorite ' : 'Favorite ') + sound.title);
    fav.addEventListener('click', () => toggleFavorite(sound, fav));
    cell('', 'sfx-fav-cell').append(fav);
    const name = document.createElement('button'); name.type = 'button'; name.className = 'audio-track-title';
    const strong = document.createElement('strong'); strong.textContent = sound.title; name.append(strong);
    const tags = document.createElement('small'); tags.className = 'sfx-tags'; tags.textContent = sound.tags.slice(0, 4).join(' · '); name.append(tags);
    name.addEventListener('click', () => toggle(sound)); cell('', 'audio-title-cell').append(name);
    cell(sound.category, 'sfx-category-cell');
    cell(sound.duration < 10 ? sound.duration.toFixed(2).replace(/0$/, '') + ' s' : formatDuration(sound.duration), 'audio-duration-cell');
    const license = cell(sound.license, 'audio-license-cell');
    license.title = sound.origin === 'cc0' ? `By ${sound.author}. CC0: no attribution needed.${sound.sourceUrl ? ' Source: ' + sound.sourceUrl : ''}` : 'Created for SmoothyApp. Free to use in your videos.';
    const actions = document.createElement('div'); actions.className = 'sfx-actions'; cell('', 'sfx-actions-cell').append(actions);
    const save = document.createElement('button'); save.type = 'button'; save.className = 'audio-row-download'; save.innerHTML = SAVE;
    save.title = 'Save as WAV to your Sound Effects folder'; save.setAttribute('aria-label', 'Save ' + sound.title + ' as WAV');
    save.addEventListener('click', () => put(sound, false));
    const send = document.createElement('button'); send.type = 'button'; send.className = 'stock-text-button sfx-send'; send.textContent = 'Send to ' + editorName();
    send.dataset.sfxSend = '1'; send.addEventListener('click', () => put(sound, true));
    actions.append(save, send);
    return tr;
  }

  function update() {
    el('more').classList.toggle('hidden', !state.hasMore); el('more').disabled = state.searching || state.busy;
    for (const button of el('results').querySelectorAll('button[data-sfx-send], .audio-row-download')) button.disabled = state.busy;
    for (const button of el('results').querySelectorAll('[data-sfx-send]')) {
      const rowId = button.closest('tr')?.dataset.id;
      button.textContent = state.busy && rowId === state.busyId ? 'Working…' : 'Send to ' + editorName();
    }
  }
  function render(categories) {
    if (categories) {
      state.categories = categories;
      const chips = categories.map(category => {
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'sfx-chip'; chip.setAttribute('aria-pressed', String(!state.favoritesOnly && category.id === state.category));
        chip.textContent = `${category.label} · ${category.count}`;
        chip.addEventListener('click', () => {
          if (!state.favoritesOnly && state.category === category.id) return;
          state.favoritesOnly = false;
          state.category = category.id;
          search();
        });
        return chip;
      });
      const favChip = document.createElement('button');
      favChip.type = 'button';
      favChip.className = 'sfx-chip';
      favChip.setAttribute('aria-pressed', String(state.favoritesOnly));
      favChip.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" fill="currentColor"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>Favorites · ${favorites.size}`;
      favChip.addEventListener('click', () => {
        state.favoritesOnly = !state.favoritesOnly;
        render(state.categories);
      });
      el('categories').replaceChildren(favChip, ...chips);
    }
    const list = visibleSounds();
    el('results').replaceChildren(...list.map(row));
    el('empty').classList.toggle('hidden', Boolean(list.length) || state.searching);
    if (state.favoritesOnly) el('count').textContent = `${list.length} favorite sound${list.length === 1 ? '' : 's'}`;
    else if (state.loaded) el('count').textContent = `${state.sounds.length} of ${state.total} sounds`;
    markPlaying(); update();
  }
  async function search(more = false) {
    clearTimeout(timer);
    const generation = ++state.generation, query = el('query').value.trim();
    const offset = more ? state.sounds.length : 0;
    state.searching = true; if (!more) el('count').textContent = 'Loading sounds…'; update();
    try {
      const result = await api.sfxSearch({ query, category: state.category, offset, background: !state.loaded });
      if (generation !== state.generation) return;
      if (!result.success) throw new Error(result.error);
      state.sounds = more ? [...state.sounds, ...result.sounds] : result.sounds; state.total = result.total; state.hasMore = result.hasMore; state.loaded = true;
      el('count').textContent = `${state.sounds.length} of ${result.total} sounds`;
      render(result.categories);
    } catch (error) {
      if (generation !== state.generation) return;
      el('count').textContent = error.message || 'Could not load sounds. Search again to retry.'; state.hasMore = false;
    } finally { if (generation === state.generation) { state.searching = false; update(); } }
  }

  async function put(sound, send) {
    if (state.busy) return;
    if (send && !isConnected()) { message(editorText('Connect Premiere first, then send this sound.'), true); return; }
    state.busy = true; state.busyId = sound.id; update(); message(send ? editorText('Sending to Premiere…') : 'Saving WAV…');
    try {
      const result = await api.sfxSave({ id: sound.id, send });
      if (!result.success) throw new Error(result.error);
      message(send ? editorText(`“${result.title}” is in Premiere’s Project panel. Drag it onto your timeline.`) : `Saved “${result.title}” to your Sound Effects folder.`);
    } catch (error) { message(error.message || 'Could not save this sound. Please retry.', true); }
    finally { state.busy = false; state.busyId = ''; update(); }
  }

  function show() {
    document.getElementById('audio-archive-panel').classList.add('hidden'); document.getElementById('audio-saved-panel').classList.add('hidden');
    document.querySelectorAll('.audio-library-tabs [role="tab"]').forEach(button => { const active = button === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
    music.pause(); dock.style.display = 'none'; panel.classList.remove('hidden'); root.dataset.sfx = 'on';
    if (!state.loaded && !state.searching) search();
  }
  function hide() { stop(); tab.setAttribute('aria-selected', 'false'); tab.tabIndex = -1; panel.classList.add('hidden'); dock.style.display = ''; delete root.dataset.sfx; }

  tab.addEventListener('click', show);
  // The music tabs own their panels; this only gets out of their way and silences previews.
  document.querySelectorAll('[data-audio-view]').forEach(button => button.addEventListener('click', hide, true));
  document.querySelectorAll('.nav-item').forEach(nav => nav.addEventListener('click', () => { if (nav.dataset.tab !== 'audio') stop(); }));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('.audio-library-tabs [role="tab"]')], index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return; event.preventDefault(); tabs[next].focus(); tabs[next].click();
  });
  el('form').addEventListener('submit', event => { event.preventDefault(); search(); });
  el('query').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(), 200); });
  el('more').addEventListener('click', () => search(true));
  el('folder').addEventListener('click', async () => {
    const result = await api.sfxShowFolder().catch(() => ({ success: false }));
    if (!result.success) message('Could not open the Sound Effects folder.', true);
  });
  // Keyboard auditioning: ArrowUp/ArrowDown steps through sounds and plays them; Space toggles play/stop.
  document.addEventListener('keydown', event => {
    if (!root?.classList.contains('active') || panel.classList.contains('hidden')) return;
    if (document.querySelector('dialog[open], .overlay:not(.hidden), .agentic-approval:not(.hidden)')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
    const list = visibleSounds();
    if (!list.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const idx = list.findIndex(s => s.id === (state.selectedId || state.playing));
      const nextIdx = event.key === 'ArrowDown'
        ? (idx < 0 ? 0 : (idx + 1) % list.length)
        : (idx <= 0 ? list.length - 1 : idx - 1);
      const nextSound = list[nextIdx];
      state.selectedId = nextSound.id;
      if (state.playing === nextSound.id) stop();
      toggle(nextSound);
      el('results').querySelector(`tr[data-id="${CSS.escape(nextSound.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.code === 'Space' && event.target?.tagName !== 'BUTTON') {
      event.preventDefault();
      const current = list.find(s => s.id === (state.playing || state.selectedId)) || list[0];
      if (current) toggle(current);
    }
  });
  api.onConnectionChange(update);
  return { stop };
}
