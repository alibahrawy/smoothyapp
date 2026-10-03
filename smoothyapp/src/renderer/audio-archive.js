import { trackRow, refreshTrackCommunity } from './audio-player.js';

export function initAudioArchive({ onSaved, player, community, onFavorite, localTracks, previewSaved }) {
  const api = window.electronAPI, el = id => document.getElementById('audio-archive-' + id);
  const freshSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const state = { tracks: [], category: 'all', mood: '', view: 'all', signature: '', shuffleSeed: freshSeed(), offset: 0, total: 0, hasMore: false, searching: false, downloading: false, selected: null, generation: 0, cancelable: false };
  const message = (text, error = false) => { el('status').textContent = text; el('status').classList.toggle('stock-error', error); };
  let searchTimer;
  function update() {
    el('search').disabled = state.searching;
    el('more').disabled = state.searching || state.downloading; el('more').classList.toggle('hidden', !state.hasMore);
    el('cancel').classList.toggle('hidden', !state.cancelable);
    el('results').querySelectorAll('button').forEach(button => { button.disabled = state.downloading; });
    if (player.current()?.id === state.selected?.id) player.busy(state.downloading);
  }
  function select(track) {
    if (!track || state.downloading) return;
    state.selected = track;
    const index = state.tracks.findIndex(item => item.id === track.id);
    player.show(track, {
      save: () => save(false), send: () => save(true),
      previous: index > 0 ? () => select(state.tracks[index - 1]) : undefined,
      next: index < state.tracks.length - 1 ? () => select(state.tracks[index + 1]) : undefined,
      error: () => message('This archived track is unavailable right now. Choose another track or retry later.', true),
    });
    message(''); update();
  }
  function render(preserveRows = false) {
    const data = community(), favorites = new Set(data.favorites || []), staff = new Set(data.staffPicks || []);
    const query = el('query').value.trim().toLowerCase();
    const locals = state.view === 'favorites' ? localTracks().filter(track => !track.archiveId && favorites.has('local:' + track.id) && (!state.mood || track.mood === state.mood) && (state.category === 'all' || el('genre').selectedOptions[0]?.textContent === track.genre) && [track.title, track.artist].join(' ').toLowerCase().includes(query)) : [];
    const rows = [...state.tracks, ...locals];
    const results = el('results'), scroll = results.closest('.content-scroll'), scrollTop = scroll.scrollTop;
    const existing = preserveRows ? new Map([...results.children].map(row => [row.dataset.id, row])) : new Map();
    const nextRows = rows.map(track => existing.get(track.id) || trackRow({ ...track, staffPick: staff.has(track.id), favoriteCount: data.counts?.[track.id] || 0 }, {
      select: locals.includes(track) ? previewSaved : select, favorite: onFavorite, selected: player.current()?.id === track.id, busy: state.downloading, starred: favorites.has(locals.includes(track) ? 'local:' + track.id : track.id),
    }));
    if (preserveRows) {
      const retained = new Set(nextRows);
      for (const row of [...results.children]) if (!retained.has(row)) row.remove();
      let cursor = results.firstElementChild;
      for (const row of nextRows) { if (row !== cursor) results.insertBefore(row, cursor); cursor = row.nextElementSibling; }
      while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
      refreshTrackCommunity(results, data); scroll.scrollTop = scrollTop;
    } else results.replaceChildren(...nextRows);
    player.refresh();
    if (locals.length && !state.searching) el('count').textContent = `${rows.length} of ${state.total + locals.length} tracks`;
    if (state.selected && player.current()?.id === state.selected.id) {
      const index = state.tracks.findIndex(item => item.id === player.current()?.id);
      player.navigation(index > 0 ? () => select(state.tracks[index - 1]) : undefined, index >= 0 && index < state.tracks.length - 1 ? () => select(state.tracks[index + 1]) : undefined);
    }
    el('empty').classList.toggle('hidden', Boolean(rows.length) || state.searching);
    el('empty').textContent = state.view === 'favorites' ? 'No favorites match. Star a track in Music to keep it here.' : state.view === 'staff' ? 'No Staff picks match. Picks will appear here as the library is curated.' : 'No matching tracks. Try another filter or search.';
    update();
  }
  function filters(result) {
    const genres = result.categories || [];
    el('genre').replaceChildren(...genres.map(category => { const option = document.createElement('option'); option.value = category.id; option.textContent = category.id === 'all' ? 'All genres' : category.label; return option; }));
    el('genre').value = state.category;
    const all = document.createElement('option'); all.value = ''; all.textContent = 'All moods';
    el('mood').replaceChildren(all, ...(result.moods || []).map(mood => { const option = document.createElement('option'); option.value = mood.label; option.textContent = mood.label; return option; }));
    el('mood').value = state.mood;
  }
  async function search(more = false, refresh = false) {
    if (state.view === 'saved') return;
    clearTimeout(searchTimer);
    const generation = ++state.generation, query = el('query').value.trim();
    const signature = JSON.stringify([state.category, state.mood, state.view, query, state.shuffleSeed]);
    const append = more && signature === state.signature, offset = append ? state.offset + 40 : 0;
    const retain = refresh && signature === state.signature, lastOffset = retain ? state.offset : offset;
    state.searching = true; if (!append && !retain) { state.tracks = []; state.hasMore = false; render(); }
    if (!retain) el('count').textContent = 'Loading tracks…'; update();
    try {
      const input = { query, offset, category: state.category, mood: state.mood, view: state.view, shuffleSeed: state.shuffleSeed };
      let result = await api.audioArchiveSearch(input), pageOffset = offset;
      if (generation !== state.generation) return;
      if (!result.success) throw new Error(result.error);
      const tracks = [...result.tracks];
      while (retain && result.hasMore && pageOffset < lastOffset) {
        pageOffset += 40; result = await api.audioArchiveSearch({ ...input, offset: pageOffset });
        if (generation !== state.generation) return;
        if (!result.success) throw new Error(result.error);
        tracks.push(...result.tracks.filter(track => !tracks.some(item => item.id === track.id)));
      }
      state.signature = signature; state.offset = pageOffset; state.total = result.total; state.hasMore = result.hasMore;
      state.tracks = append ? [...state.tracks, ...tracks.filter(track => !state.tracks.some(item => item.id === track.id))] : tracks;
      el('count').textContent = `${state.tracks.length.toLocaleString()} of ${result.total.toLocaleString()} tracks`;
      filters(result);
    } catch (error) { if (generation === state.generation) { el('count').textContent = error.message || 'Could not load tracks. Search again to retry.'; state.hasMore = false; } }
    finally { if (generation === state.generation) { state.searching = false; render(retain); } }
  }
  async function save(premiere) {
    if (!state.selected || state.downloading) return;
    const track = state.selected; state.downloading = true; state.cancelable = true; update(); message('Downloading MP3…');
    try {
      const result = await api.audioArchiveDownload({ id: track.id, premiere });
      if (result.canceled) { message('Download canceled.'); return; }
      if (!result.success) throw new Error(result.error);
      onSaved(result); message(result.imported ? 'Saved and imported into Premiere’s Project panel.' : 'MP3 saved to Saved MP3s.');
    } catch (error) { message(error.message || 'Could not save this track. Please retry.', true); }
    finally { state.downloading = false; state.cancelable = false; update(); }
  }
  function setView(view) {
    if (state.downloading) return;
    if (view === 'all') state.shuffleSeed = freshSeed();
    state.view = view;
    document.querySelectorAll('[data-audio-view]').forEach(button => { const active = button.dataset.audioView === view; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
    document.getElementById('audio-archive-panel').classList.toggle('hidden', view === 'saved'); document.getElementById('audio-saved-panel').classList.toggle('hidden', view !== 'saved');
    if (view !== 'saved') {
      document.getElementById('audio-archive-panel').setAttribute('aria-labelledby', 'audio-view-' + view);
      state.category = 'all'; state.mood = ''; el('query').value = ''; search();
    } else { state.generation++; state.searching = false; }
  }
  const tabs = [...document.querySelectorAll('[data-audio-view]')];
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => setView(button.dataset.audioView));
    button.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0 || state.downloading) return; event.preventDefault(); tabs[next].focus(); setView(tabs[next].dataset.audioView);
    });
  });
  el('form').addEventListener('submit', event => { event.preventDefault(); search(); });
  el('genre').addEventListener('change', () => { state.category = el('genre').value; state.mood = ''; search(); });
  el('mood').addEventListener('change', () => { state.mood = el('mood').value; search(); });
  el('query').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(), 250); });
  el('more').addEventListener('click', () => search(true));
  el('cancel').addEventListener('click', async () => {
    state.cancelable = false; update(); message('Canceling download…');
    try { await api.audioArchiveCancel(); } catch { message('Could not cancel the download. Please wait for it to finish.', true); }
  });
  api.onAudioArchiveProgress(data => {
    if (!state.downloading || data.id !== state.selected?.id) return;
    if (data.phase === 'importing') state.cancelable = false;
    message(data.phase === 'validating' ? 'Checking the MP3…' : data.phase === 'importing' ? 'Importing into Premiere…' : data.total ? `Downloading MP3… ${Math.min(100, Math.round(data.received / data.total * 100))}%` : `Downloading MP3… ${(data.received / 1048576).toFixed(1)} MB`); update();
  });
  let libraryActive = false;
  document.querySelectorAll('.nav-item:not(.disabled)').forEach(nav => nav.addEventListener('click', () => {
    const entering = nav.dataset.tab === 'audio';
    if (entering && !libraryActive && !state.downloading) { state.shuffleSeed = freshSeed(); search(); }
    libraryActive = entering;
  }));
  update();
  return { communityChanged(previous, next) {
    const key = state.view === 'favorites' ? 'favorites' : state.view === 'staff' ? 'staffPicks' : '';
    refreshTrackCommunity(el('results'), next);
    if (key && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) search(false, true);
  }, savedView: () => setView('saved') };
}
