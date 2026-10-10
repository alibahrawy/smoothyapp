import { initAudioArchive } from './audio-archive.js';
import { initAudioPlayer, trackRow, favoriteId, refreshTrackCommunity } from './audio-player.js';

export function initAudioLibrary({ isConnected }) {
  const api = window.electronAPI;
  const el = id => document.getElementById('audio-' + id);
  const state = { tracks: [], candidates: [], watching: false, busy: false, selected: null, kind: '' };
  let community = { favorites: [], counts: {}, staffPicks: [], sharing: true, online: false };
  let archive;
  let savedViewActive = false;
  let sharingBusy = false, sharingReady = false;
  function updateSharing() {
    if (!sharingBusy) el('share-favorites').checked = Boolean(community.sharing);
    el('share-favorites').disabled = !sharingReady || sharingBusy || Boolean(community.sharingLocked);
    el('sharing-status').textContent = community.sharingLocked ? 'Sharing is disabled for this installation. Local favorites still work.' : community.sharing ? 'One vote per installation. No sign-in needed.' : 'New favorite changes stay on this device. Previously shared votes remain counted.';
  }
  function infoTrack() {
    const current = player.current();
    return state.tracks.find(track => current && (track.id === current.id || track.archiveId === current.id)) || current;
  }
  function renderInfo() {
    const track = infoTrack(), archived = Boolean(track && (track.archiveId || !track.license));
    el('info-title').textContent = track?.title || 'Choose a track to see its details';
    el('info-artist').textContent = track ? track.artist || 'Artist not supplied' : '';
    el('info-source').textContent = track ? archived ? 'Unofficial YouTube archive' : 'Added on this device' : '—';
    el('info-license').textContent = track ? track.license === 'cc-by' ? 'Creative Commons · saved by you' : track.license === 'youtube-standard' ? 'YouTube · saved by you' : 'Not supplied' : '—';
    el('info-license-note').textContent = track?.license && track.license !== 'unverified' ? 'License details are saved as entered. Verify the original source and its terms.' : 'Check the original source for the current license and required credit.';
    const credit = track?.license === 'cc-by' ? track.credit?.trim() || '' : '';
    el('info-attribution').classList.toggle('hidden', !credit);
    el('info-credit').textContent = credit; el('info-copy').disabled = !credit;
    el('info-studio').classList.toggle('hidden', Boolean(track && !archived && track.license !== 'youtube-standard'));
    updateSharing();
  }
  const toggling = new Set();
  async function favorite(track) {
    const id = favoriteId(track); if (toggling.has(id)) return; toggling.add(id);
    try { const result = await api.audioFavoriteSet({ id, active: !community.favorites.includes(id) }); if (!result.success) throw new Error(result.error); acceptCommunity(result); }
    catch (error) { message(error.message || 'Could not save favorite. Please retry.', true); }
    finally { toggling.delete(id); }
  }
  function showArtist(artist) { if (!state.busy && !archive?.isBusy()) archive?.showArtist(artist); }
  const player = initAudioPlayer({ isConnected, onFavorite: favorite, onArtist: showArtist });
  function acceptCommunity(data) {
    const previous = community; community = { ...community, ...data }; player.favorites(community.favorites || []);
    sharingReady = true; updateSharing();
    el('community-note').textContent = community.sharing ? (community.pending ? 'Favorites saved on this device. Community sharing will retry when online.' : 'Community favorites help us choose Staff picks. No sign-in needed.') : 'New favorite changes stay on this device. Community sharing is off.';
    refreshTrackCommunity(el('results'), community); archive?.communityChanged(previous, community);
  }
  const message = (text, error = false) => { el('status').textContent = text; el('status').classList.toggle('stock-error', error); };
  function update() {
    el('open').disabled = state.busy;
    el('open').textContent = 'Open YouTube Studio ↗';
    el('stop').classList.toggle('hidden', !state.watching);
    el('watch-status').textContent = state.watching ? 'Watching for new MP3 downloads. Keep the tracks you want below.' : 'Start a session to pick up new MP3 downloads automatically.';
    el('save').disabled = state.busy;
    el('pick').disabled = state.busy;
    el('folder').disabled = state.busy || state.watching;
    el('send').disabled = state.busy || state.kind !== 'track' || !isConnected();
    el('send').classList.toggle('hidden', state.kind !== 'track');
    el('copy-credit').disabled = !el('credit').value.trim();
    player.busy(state.busy || Boolean(archive?.isBusy()));
    el('save').textContent = state.busy ? 'Saving…' : state.kind === 'track' ? 'Save details' : 'Keep in my library';
  }
  function select(item, kind) {
    state.selected = item.id; state.kind = kind;
    el('editor').classList.remove('hidden');
    el('editor-title').textContent = kind === 'track' ? 'Track details' : 'Keep this download';
    el('title').value = kind === 'track' ? item.title : item.name.replace(/\.mp3$/i, '');
    el('artist').value = item.artist || '';
    el('genre').value = item.genre || ''; el('mood').value = item.mood || '';
    el('license').value = item.license || 'unverified';
    el('credit').value = item.credit || '';
    if (kind === 'track') preview(item, false);
    el('editor').scrollIntoView({ behavior: 'instant', block: 'start' }); update();
  }
  function render() {
    el('pending').classList.toggle('hidden', !state.candidates.length);
    el('pending-list').replaceChildren(...state.candidates.map(item => {
      const row = document.createElement('div'); row.className = 'audio-download';
      const name = document.createElement('span'); name.textContent = item.name;
      const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'btn btn-secondary btn-small'; keep.textContent = 'Review & keep'; keep.disabled = state.busy;
      keep.addEventListener('click', () => select(item, 'candidate'));
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'stock-text-button'; dismiss.textContent = 'Dismiss'; dismiss.disabled = state.busy;
      dismiss.addEventListener('click', () => action(() => api.audioLibraryDismiss(item.id), 'Download dismissed.'));
      row.append(name, keep, dismiss); return row;
    }));
    const tracks = visibleTracks();
    el('results').replaceChildren(...tracks.map(track => trackRow(track, { select: preview, favorite, artist: showArtist, selected: player.current()?.id === track.id, busy: state.busy, starred: community.favorites.includes(favoriteId(track)) })));
    refreshTrackCommunity(el('results'), community);
    player.refresh();
    if (savedViewActive) { const actions = navigation(player.current()); player.navigation(actions.previous, actions.next); }
    else archive?.refreshNavigation();
    el('empty').classList.toggle('hidden', Boolean(tracks.length));
    el('empty').textContent = state.tracks.length ? 'No saved tracks match your search.' : 'Your saved tracks will appear here. Choose a track in Music and save its MP3.';
    update();
  }
  function visibleTracks() {
    const query = el('query').value.trim().toLowerCase(), filter = el('filter').value;
    return state.tracks.filter(track => (!filter || track.license === filter) && [track.title, track.artist, track.credit].join(' ').toLowerCase().includes(query));
  }
  function navigation(track) {
    const tracks = visibleTracks(), index = tracks.findIndex(item => item.id === track?.id);
    return { previous: index > 0 ? () => preview(tracks[index - 1]) : undefined,
      next: index >= 0 && index < tracks.length - 1 ? () => preview(tracks[index + 1]) : undefined };
  }
  function preview(track, autoplay = true, queue) {
    if (!track || state.busy) return;
    player.show(track, { send: () => action(() => api.audioLibraryImport(track.id), 'Audio imported into Premiere’s Project panel.'), details: () => select(track, 'track'), ...(queue || navigation(track)), error: () => message('Could not preview this MP3. Check the library folder.', true) }, autoplay);
    if (!savedViewActive) archive?.refreshNavigation();
    update();
  }
  function accept(data) {
    if (data.tracks) state.tracks = data.tracks;
    if (data.candidates) state.candidates = data.candidates;
    if (typeof data.watching === 'boolean') state.watching = data.watching;
    if (data.watchFolder) el('watch-folder').textContent = data.watchFolder;
    if (data.folder) el('library-folder').textContent = data.folder;
    if (data.error) message(data.error, true);
    const current = state.tracks.find(track => track.id === player.current()?.id);
    if (current) preview(current, false);
    render();
  }
  async function action(work, success) {
    if (state.busy) return;
    state.busy = true; render();
    try {
      const result = await work();
      if (result.canceled) return;
      if (!result.success) throw new Error(result.error);
      if (result.tracks) accept(result);
      else if (success === 'Download dismissed.') accept(await api.audioLibraryState());
      if (success) message(success);
      return result;
    } catch (error) { message(error.message || 'The audio action failed. Please retry.', true); }
    finally { state.busy = false; render(); }
  }
  el('open').addEventListener('click', () => action(() => api.audioLibraryOpen(), 'Search, preview, and download in YouTube Studio. Return here to keep the MP3.'));
  el('stop').addEventListener('click', () => action(() => api.audioLibraryStop(), 'Download session stopped.'));
  el('folder').addEventListener('click', () => action(() => api.audioLibrarySelectFolder()));
  el('pick').addEventListener('click', () => action(() => api.audioLibraryPick(), 'Choose a download below to save its track details.'));
  el('show-folder').addEventListener('click', () => action(() => api.audioLibraryShowFolder()));
  el('query').addEventListener('input', render); el('filter').addEventListener('change', render);
  el('credit').addEventListener('input', update);
  el('close').addEventListener('click', () => { el('editor').classList.add('hidden'); state.selected = null; state.kind = ''; update(); });
  el('details-form').addEventListener('submit', async event => {
    event.preventDefault();
    const kind = state.kind;
    const options = { id: state.selected, title: el('title').value, artist: el('artist').value, genre: el('genre').value, mood: el('mood').value, license: el('license').value, credit: el('credit').value };
    const result = await action(() => kind === 'track' ? api.audioLibraryUpdate(options) : api.audioLibraryKeep(options), kind === 'track' ? 'Track details saved.' : 'MP3 saved permanently in your audio library.');
    if (result && kind === 'candidate') { el('editor').classList.add('hidden'); state.selected = null; state.kind = ''; update(); }
  });
  el('send').addEventListener('click', () => action(() => api.audioLibraryImport(state.selected), 'Audio imported into Premiere’s Project panel. Drag it onto your timeline.'));
  el('copy-credit').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el('credit').value); message('Attribution copied.'); }
    catch { message('Select the attribution text and copy it.', true); }
  });
  el('info-open').addEventListener('click', () => {
    renderInfo(); el('info-status').textContent = '';
    if (!el('info-dialog').open) el('info-dialog').showModal();
  });
  el('info-close').addEventListener('click', () => el('info-dialog').close());
  el('info-dialog').addEventListener('close', () => el('info-open').focus({ preventScroll: true }));
  el('info-dialog').addEventListener('click', event => {
    const bounds = el('info-dialog').getBoundingClientRect();
    if (event.target === el('info-dialog') && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) el('info-dialog').close();
  });
  el('info-studio').addEventListener('click', () => api.openExternal('https://studio.youtube.com/channel/UC/music'));
  el('info-copy').addEventListener('click', async () => {
    if (el('info-copy').disabled) return;
    try { await navigator.clipboard.writeText(el('info-credit').textContent); el('info-status').textContent = 'Attribution copied.'; el('info-status').classList.remove('stock-error'); }
    catch { el('info-status').textContent = 'Select the attribution text and copy it.'; el('info-status').classList.add('stock-error'); }
  });
  el('share-favorites').addEventListener('change', async () => {
    if (sharingBusy || !sharingReady || community.sharingLocked) return;
    const enabled = el('share-favorites').checked; sharingBusy = true; el('info-status').textContent = ''; updateSharing();
    try {
      const result = await api.audioFavoriteSharing(enabled); if (!result.success) throw new Error(result.error);
      acceptCommunity(result);
    } catch (error) { el('info-status').textContent = error.message || 'Could not save this setting. Please retry.'; el('info-status').classList.add('stock-error'); }
    finally { sharingBusy = false; updateSharing(); }
  });
  document.getElementById('tab-audio').addEventListener('click', event => {
    const link = event.target.closest('a[data-audio-external]');
    if (link) { event.preventDefault(); api.openExternal(link.href); }
  });
  api.onConnectionChange(update);
  api.onAudioLibraryChanged(accept);
  api.onAudioCommunityChanged(acceptCommunity);
  archive = initAudioArchive({ player, community: () => community, onFavorite: favorite, onArtist: showArtist,
    onViewChange: view => { savedViewActive = view === 'saved'; render(); }, isLibraryBusy: () => state.busy,
    onSaved: accept, localTracks: () => state.tracks, previewSaved: preview });
  api.audioCommunityState().then(result => { if (result.success) acceptCommunity(result); }).catch(() => {});
  api.audioLibraryState().then(result => { if (!result.success) throw new Error(result.error); accept(result); }).catch(() => message('Could not load the audio library. Restart the app and retry.', true));
  return { isBusy: () => state.busy || archive?.isBusy() };
}
