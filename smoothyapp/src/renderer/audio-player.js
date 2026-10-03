export const formatDuration = value => Number.isFinite(value) && value > 0 ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '—';
export const licenseLabel = track => ({ 'youtube-standard': 'YouTube', 'cc-by': 'CC BY', unverified: 'Not supplied' })[track.license] || 'Not supplied';
export const favoriteId = track => track.archiveId || (track.id.length === 36 && /^[0-9a-f-]+$/.test(track.id) ? 'local:' + track.id : track.id);
const playbackIcons = {
  play: '<path d="M9 5.5v13l10-6.5z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  previous: '<path d="M7 5h2v14H7zm12 0v14l-10-7z"/>',
  next: '<path d="M15 5h2v14h-2zM5 5v14l10-7z"/>',
  loading: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="36 15"/>',
};
function playbackIcon(button, kind) {
  if (button.dataset.icon === kind) return;
  button.dataset.icon = kind;
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">${playbackIcons[kind]}</svg>`;
}
export function trackRow(track, { select, favorite, selected, busy = false, starred = false }) {
  const row = document.createElement('tr'); row.className = 'audio-track'; row.dataset.id = track.id;
  row.dataset.favoriteId = favoriteId(track);
  row.classList.toggle('selected', selected);
  const cell = (text, name = '') => { const td = document.createElement('td'); td.className = name; td.textContent = text; row.append(td); return td; };
  const play = document.createElement('button'); play.type = 'button'; play.className = 'audio-row-play'; play.dataset.title = track.title; playbackIcon(play, 'play'); play.setAttribute('aria-label', 'Play ' + track.title); play.disabled = busy; play.addEventListener('click', () => select(track)); cell('', 'audio-play-cell').append(play);
  const star = document.createElement('button'); star.type = 'button'; star.className = 'audio-star'; star.textContent = starred ? '★' : '☆'; star.setAttribute('aria-pressed', String(starred)); star.setAttribute('aria-label', (starred ? 'Remove favorite: ' : 'Favorite: ') + track.title); star.title = `${track.favoriteCount || 0} community favorites`; star.disabled = busy; star.addEventListener('click', () => favorite(track)); cell('', 'audio-star-cell').append(star);
  const title = document.createElement('button'); title.type = 'button'; title.className = 'audio-track-title'; title.disabled = busy;
  const name = document.createElement('strong'); name.textContent = track.title; title.append(name);
  if (track.staffPick) { const badge = document.createElement('span'); badge.className = 'audio-pick-badge'; badge.textContent = 'Staff pick'; title.append(badge); }
  title.addEventListener('click', () => select(track)); cell('', 'audio-title-cell').append(title);
  cell(track.genre || '—'); cell(track.mood || '—'); cell(track.artist || '—', 'audio-artist-cell'); cell(formatDuration(track.duration), 'audio-duration-cell');
  const license = cell(licenseLabel(track), 'audio-license-cell'); license.title = track.license === 'cc-by' ? 'Attribution required. See saved track details.' : track.license === 'youtube-standard' ? 'No attribution required, as entered in saved track details.' : 'Track license was not supplied by the archive.';
  return row;
}

export function refreshTrackCommunity(container, data) {
  const favorites = new Set(data.favorites || []), staff = new Set(data.staffPicks || []);
  container.querySelectorAll('.audio-track').forEach(row => {
    const id = row.dataset.favoriteId, starred = favorites.has(id), star = row.querySelector('.audio-star');
    star.textContent = starred ? '★' : '☆'; star.setAttribute('aria-pressed', String(starred));
    star.setAttribute('aria-label', (starred ? 'Remove favorite: ' : 'Favorite: ') + row.querySelector('.audio-row-play').dataset.title);
    star.title = `${data.counts?.[id] || 0} community favorites`;
    const title = row.querySelector('.audio-track-title'), badge = title.querySelector('.audio-pick-badge');
    if (staff.has(id) && !badge) {
      const pick = document.createElement('span'); pick.className = 'audio-pick-badge'; pick.textContent = 'Staff pick'; title.append(pick);
    } else if (!staff.has(id)) badge?.remove();
  });
}

export function initAudioPlayer({ isConnected, onFavorite }) {
  const el = id => document.getElementById('audio-dock-' + id), audio = el('player');
  let track = null, actions = {}, busy = false, favorites = new Set(), loading = false, failed = false, generation = 0;
  const update = () => {
    const playing = !audio.paused;
    const kind = loading ? 'loading' : playing ? 'pause' : 'play';
    el('play').disabled = !track;
    playbackIcon(el('play'), kind); el('play').setAttribute('aria-label', loading ? 'Cancel loading' : playing ? 'Pause' : failed ? 'Retry playback' : 'Play');
    el('play').setAttribute('aria-busy', String(loading));
    el('status').textContent = failed ? 'Could not play. Press play to retry.' : loading ? 'Loading audio…' : '';
    document.querySelectorAll('.audio-track').forEach(row => {
      const current = row.dataset.id === track?.id, button = row.querySelector('.audio-row-play');
      row.classList.toggle('selected', current); playbackIcon(button, current ? kind : 'play');
      button.setAttribute('aria-label', `${current && loading ? 'Cancel loading' : current && playing ? 'Pause' : current && failed ? 'Retry' : 'Play'} ${button.dataset.title}`);
      button.setAttribute('aria-busy', String(current && loading));
    });
    el('previous').disabled = busy || !actions.previous; el('next').disabled = busy || !actions.next;
    el('save').disabled = busy || !actions.save; el('save').classList.toggle('hidden', !actions.save);
    el('send').disabled = busy || !actions.send || !isConnected();
    el('details').classList.toggle('hidden', !actions.details); el('details').disabled = busy;
    el('star').disabled = !track; const starred = track && favorites.has(favoriteId(track));
    el('star').textContent = starred ? '★' : '☆'; el('star').setAttribute('aria-pressed', String(Boolean(starred)));
    el('star').setAttribute('aria-label', starred ? 'Remove favorite' : 'Favorite track');
    const duration = Number.isFinite(audio.duration) ? audio.duration : track?.duration || 0;
    el('seek').max = String(duration); el('seek').value = String(audio.currentTime || 0); el('seek').disabled = !Number.isFinite(audio.duration);
    el('elapsed').textContent = audio.currentTime ? formatDuration(audio.currentTime) : '0:00'; el('duration').textContent = formatDuration(duration);
  };
  function fail() {
    if (!track || failed) return;
    failed = true; loading = false; audio.pause(); actions.error?.(); update();
  }
  function start() {
    if (!track) return;
    if (failed || audio.error) {
      generation++;
      // Chromium can reuse a failed media response even after load(). Give a
      // retry a new internal URL so it actually requests the track again.
      if (track.previewUrl.startsWith('smoothy-audio://')) {
        const retry = new URL(track.previewUrl); retry.searchParams.set('retry', String(generation)); audio.src = retry.href;
      }
      audio.load();
      document.getElementById('audio-status').textContent = ''; document.getElementById('audio-archive-status').textContent = '';
    }
    failed = false; loading = true; const request = generation; update();
    void audio.play().catch(error => { if (request === generation && error.name !== 'AbortError') fail(); });
  }
  function toggle() { if (audio.paused) start(); else audio.pause(); }
  for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'ended']) audio.addEventListener(event, update);
  for (const event of ['play', 'waiting']) audio.addEventListener(event, () => { loading = !audio.paused; update(); });
  audio.addEventListener('playing', () => { loading = false; failed = false; update(); });
  audio.addEventListener('pause', () => { loading = false; update(); });
  el('play').addEventListener('click', toggle);
  playbackIcon(el('previous'), 'previous'); playbackIcon(el('next'), 'next');
  el('seek').addEventListener('input', () => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(Number(el('seek').value), audio.duration); });
  el('volume').addEventListener('input', () => { audio.volume = Number(el('volume').value); });
  el('star').addEventListener('click', () => { if (track) onFavorite(track); });
  for (const action of ['previous', 'next', 'save', 'send', 'details']) el(action).addEventListener('click', () => actions[action]?.());
  audio.addEventListener('error', fail);
  document.querySelectorAll('.nav-item').forEach(nav => nav.addEventListener('click', () => { if (nav.dataset.tab !== 'audio') audio.pause(); }));
  window.electronAPI.onConnectionChange(update); update();
  return {
    show(next, nextActions, autoplay = true) {
      const same = track?.previewUrl === next.previewUrl && track?.id === next.id; track = next; actions = nextActions;
      if (!same) { document.getElementById('audio-status').textContent = ''; document.getElementById('audio-archive-status').textContent = ''; }
      el('title').textContent = next.title; el('artist').textContent = next.artist || 'Artist not supplied'; el('license').textContent = licenseLabel(next);
      if (!same) { generation++; audio.pause(); failed = false; loading = false; audio.src = next.previewUrl; audio.load(); }
      update(); if (autoplay) toggle();
    },
    favorites(ids) { favorites = new Set(ids); update(); },
    navigation(previous, next) { actions.previous = previous; actions.next = next; update(); },
    busy(value) { busy = value; update(); },
    refresh() { update(); },
    pause() { audio.pause(); },
    current() { return track; },
  };
}
