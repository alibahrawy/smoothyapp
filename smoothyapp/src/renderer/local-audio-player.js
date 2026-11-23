const paths = {
  play: '<path d="m9 5 11 7-11 7Z"/>',
  pause: '<path d="M9 5v14M16 5v14"/>',
  volume: '<path d="m11 5-6 4H2v6h3l6 4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="m11 5-6 4H2v6h3l6 4ZM16 9l6 6m0-6-6 6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const formatTime = value => {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const MODE_COPY = {
  denoise: {
    cleanTab: 'Clean Audio',
    removedTab: 'Removed Noise',
    saveClean: 'Save Clean Audio (WAV)',
    saveRemoved: 'Save Removed Noise',
    strengthLabel: 'Noise reduction strength',
    strengthHint: 'What you hear is what gets saved. Lower to keep a touch of natural room tone.',
    idlePrompt: 'Press Play to preview your original file, or click Remove Noise above.',
    removedHint: 'Listening only to the noise being removed. Check that no speech was cut.',
  },
  isolate: {
    cleanTab: 'Clean Voice',
    removedTab: 'Removed Background',
    saveClean: 'Save Clean Voice (WAV)',
    saveRemoved: 'Save Music & Noise',
    strengthLabel: 'Background removal strength',
    strengthHint: 'What you hear is what gets saved. Lower slightly if you want a hint of room ambience.',
    idlePrompt: 'Press Play to preview your original file, or click Isolate Clean Voice above.',
    removedHint: 'Listening only to the removed music and background noise.',
  },
  separate: {
    idlePrompt: 'Press Play to preview your original file, or click Separate Tracks above.',
  },
};

export function createLocalAudioPlayer(host, { preview, save, error, onCleanVoiceFromSeparated }) {
  host.innerHTML = `
    <div class="cleanup-transport">
      <button type="button" class="cleanup-play" aria-label="Play audio">${icon('play')}</button>
      <span class="cleanup-current">0:00</span>
      <input class="cleanup-seek" type="range" min="0" max="0" step="0.01" value="0" aria-label="Playback position" disabled>
      <span class="cleanup-duration">0:00</span>
    </div>
    <div class="cleanup-panel cleanup-panel-idle hidden">
      <p class="cleanup-idle-copy"></p>
    </div>
    <div class="cleanup-panel cleanup-panel-clean hidden">
      <div class="cleanup-ab" role="tablist" aria-label="Listen comparison">
        <button type="button" class="cleanup-ab-btn" role="tab" data-listen="original" aria-selected="false">Original</button>
        <button type="button" class="cleanup-ab-btn" role="tab" data-listen="clean" aria-selected="true">Clean Audio</button>
        <button type="button" class="cleanup-ab-btn" role="tab" data-listen="removed" aria-selected="false">Removed Noise</button>
      </div>
      <div class="cleanup-strength-card">
        <div class="cleanup-strength-head">
          <label class="cleanup-strength-label" for="cleanup-strength-slider">Noise reduction strength</label>
          <div class="cleanup-strength-presets" role="group" aria-label="Strength presets">
            <button type="button" class="cleanup-preset" data-strength="70">Natural 70%</button>
            <button type="button" class="cleanup-preset" data-strength="85">Balanced 85%</button>
            <button type="button" class="cleanup-preset" data-strength="100">Full 100%</button>
          </div>
          <output class="cleanup-strength-value" for="cleanup-strength-slider">100%</output>
        </div>
        <input id="cleanup-strength-slider" class="cleanup-strength-slider" type="range" min="0" max="100" step="1" value="100">
        <p class="cleanup-strength-note"></p>
      </div>
      <div class="cleanup-export-row">
        <button type="button" class="btn btn-primary cleanup-save-primary">${icon('download')}<span>Save Clean Audio (WAV)</span></button>
        <button type="button" class="btn btn-secondary cleanup-save-secondary">${icon('download')}<span>Save Removed Noise</span></button>
      </div>
    </div>
    <div class="cleanup-panel cleanup-panel-separate hidden">
      <div class="cleanup-ab" role="tablist" aria-label="Listen comparison">
        <button type="button" class="cleanup-ab-btn" role="tab" data-listen="original" aria-selected="false">Original</button>
        <button type="button" class="cleanup-ab-btn" role="tab" data-listen="stems" aria-selected="true">Separated Stems</button>
      </div>
      <div class="cleanup-tracks"></div>
      <div class="cleanup-next-step">
        <span>Voice still has background hiss or hum?</span>
        <button type="button" class="stock-text-button cleanup-follow-isolate">Remove noise from Voice →</button>
      </div>
    </div>
    <div class="cleanup-media" hidden></div>`;

  const $ = selector => host.querySelector(selector);
  const playButton = $('.cleanup-play');
  const seek = $('.cleanup-seek');
  const mediaHost = $('.cleanup-media');
  const stemRows = new Map();
  const previewed = new Set();

  let all = [];
  let source = null;
  let activeMode = 'denoise';
  let outputs = [];
  let listen = 'original'; // 'original' | 'clean' | 'removed' | 'stems'
  let strength = 100;
  let solo = null;
  let playing = false;
  let starting = false;
  let busy = false;
  let time = 0;
  let duration = 0;
  let version = 0;
  let frame = 0;
  let lastSync = 0;

  const findTrack = kind => outputs.find(track => track.output.kind === kind) || null;
  const residualTrack = () => findTrack('noise') || findTrack('background');
  const speechTrack = () => findTrack('speech');
  const musicTrack = () => findTrack('music');
  const hasResults = () => outputs.length > 0;

  function activeTracks() {
    if (!hasResults() || listen === 'original') return source ? [source] : [];
    if (activeMode === 'separate') return outputs;
    const clean = speechTrack();
    const res = residualTrack();
    if (listen === 'removed') return res ? [res] : [];
    return [clean, res].filter(Boolean);
  }

  const clock = () => activeTracks()[0]?.media || null;
  const isAudible = track => !track.media.muted && track.media.volume > 0.001;

  function reportPreview(track) {
    if (!track || track.reported || track.media.paused || !isAudible(track)) return;
    track.reported = true;
    previewed.add(track.output.id);
    Promise.resolve().then(() => preview(track.output.id)).catch(() => {});
  }

  function applyAudioRouting() {
    const active = new Set(activeTracks());
    for (const track of all) {
      if (!active.has(track)) {
        track.media.muted = true;
        track.media.volume = 0;
        continue;
      }
      if (!hasResults() || listen === 'original') {
        track.media.muted = false;
        track.media.volume = 1;
      } else if (activeMode === 'separate') {
        const muted = track.muted || track.level === 0 || (solo && solo !== track.output.kind);
        track.media.muted = Boolean(muted);
        track.media.volume = muted ? 0 : track.level / 100;
      } else if (listen === 'removed') {
        track.media.muted = false;
        track.media.volume = 1;
      } else {
        // Real-time strength blend: clean at 1.0 + residual at (100 - strength) / 100.
        if (track.output.kind === 'speech') {
          track.media.muted = false;
          track.media.volume = 1;
        } else {
          const keep = Math.max(0, Math.min(1, (100 - strength) / 100));
          track.media.muted = keep <= 0.001;
          track.media.volume = keep;
        }
      }
      if (playing) reportPreview(track);
    }
  }

  function refreshDuration() {
    const durations = activeTracks()
      .map(track => track.media.duration)
      .filter(value => Number.isFinite(value) && value > 0);
    duration = durations.length ? Math.min(...durations) : 0;
    if (duration) time = Math.min(time, duration);
    renderTransport();
  }

  function renderTransport() {
    playButton.innerHTML = icon(playing || starting ? 'pause' : 'play');
    playButton.setAttribute('aria-label', playing || starting ? 'Pause audio' : 'Play audio');
    playButton.setAttribute('aria-busy', String(starting));
    playButton.disabled = !activeTracks().length || busy;
    seek.max = String(duration);
    seek.value = String(Math.min(time, duration));
    seek.disabled = !duration || busy;
    seek.style.setProperty('--position', `${duration ? (time / duration) * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `${formatTime(time)} of ${formatTime(duration)}`);
    $('.cleanup-current').textContent = formatTime(time);
    $('.cleanup-duration').textContent = formatTime(duration);
  }

  function renderPanels() {
    const idlePanel = $('.cleanup-panel-idle');
    const cleanPanel = $('.cleanup-panel-clean');
    const separatePanel = $('.cleanup-panel-separate');
    const copy = MODE_COPY[activeMode] || MODE_COPY.denoise;

    idlePanel.classList.toggle('hidden', hasResults());
    cleanPanel.classList.toggle('hidden', !hasResults() || activeMode === 'separate');
    separatePanel.classList.toggle('hidden', !hasResults() || activeMode !== 'separate');

    if (!hasResults()) {
      $('.cleanup-idle-copy').textContent = copy.idlePrompt;
    } else if (activeMode === 'separate') {
      for (const btn of separatePanel.querySelectorAll('.cleanup-ab-btn')) {
        const selected = btn.dataset.listen === listen;
        btn.setAttribute('aria-selected', String(selected));
        btn.classList.toggle('is-active', selected);
        btn.disabled = busy;
      }
      const inOriginal = listen === 'original';
      for (const [kind, row] of stemRows) {
        const track = findTrack(kind);
        const muted = !track || inOriginal || track.muted || track.level === 0 || (solo && solo !== kind);
        row.classList.toggle('is-muted', muted && !inOriginal);
        row.classList.toggle('is-dimmed', inOriginal);
        const slider = row.querySelector('input');
        slider.disabled = !track || busy || inOriginal;
        slider.value = String(track ? track.level : 100);
        row.style.setProperty('--level', `${track ? track.level : 100}%`);
        row.querySelector('output').textContent = track ? `${track.level}%` : '—';
        const muteBtn = row.querySelector('.cleanup-mute');
        muteBtn.disabled = !track || busy || inOriginal;
        muteBtn.innerHTML = icon(muted && !inOriginal ? 'muted' : 'volume');
        muteBtn.setAttribute('aria-pressed', String(Boolean(track?.muted || track?.level === 0)));
        muteBtn.setAttribute('aria-label', `${track?.muted ? 'Unmute' : 'Mute'} ${row.dataset.label.toLowerCase()}`);
        const soloBtn = row.querySelector('.cleanup-solo');
        soloBtn.disabled = !track || busy || inOriginal;
        soloBtn.setAttribute('aria-pressed', String(solo === kind));
        soloBtn.setAttribute('aria-label', solo === kind ? 'Listen to both tracks' : `Listen to ${row.dataset.label.toLowerCase()} only`);
        const saveBtn = row.querySelector('.cleanup-save');
        saveBtn.disabled = !track || busy;
      }
      $('.cleanup-follow-isolate').disabled = busy || !speechTrack();
    } else {
      const cleanTab = cleanPanel.querySelector('[data-listen="clean"]');
      const removedTab = cleanPanel.querySelector('[data-listen="removed"]');
      cleanTab.textContent = copy.cleanTab;
      removedTab.textContent = copy.removedTab;
      for (const btn of cleanPanel.querySelectorAll('.cleanup-ab-btn')) {
        const selected = btn.dataset.listen === listen;
        btn.setAttribute('aria-selected', String(selected));
        btn.classList.toggle('is-active', selected);
        btn.disabled = busy;
      }
      const sliderCard = $('.cleanup-strength-card');
      const slider = $('.cleanup-strength-slider');
      sliderCard.classList.toggle('is-dimmed', listen !== 'clean');
      $('.cleanup-strength-label').textContent = copy.strengthLabel;
      $('.cleanup-strength-value').textContent = `${strength}%`;
      slider.value = String(strength);
      slider.disabled = busy || listen !== 'clean';
      slider.style.setProperty('--level', `${strength}%`);
      for (const preset of cleanPanel.querySelectorAll('.cleanup-preset')) {
        const value = Number(preset.dataset.strength);
        preset.classList.toggle('is-active', value === strength);
        preset.disabled = busy;
      }
      $('.cleanup-strength-note').textContent = listen === 'removed' ? copy.removedHint : copy.strengthHint;
      const savePrimary = $('.cleanup-save-primary');
      const saveSecondary = $('.cleanup-save-secondary');
      savePrimary.querySelector('span').textContent = strength < 100 ? `${copy.saveClean.replace(' (WAV)', '')} · ${strength}% (WAV)` : copy.saveClean;
      savePrimary.disabled = busy || !speechTrack();
      saveSecondary.querySelector('span').textContent = copy.saveRemoved;
      saveSecondary.disabled = busy || !residualTrack();
    }

    applyAudioRouting();
  }

  function render() {
    renderPanels();
    renderTransport();
  }

  function tick(now) {
    if (!playing) return;
    const leader = clock();
    if (leader) time = Math.min(leader.currentTime, duration || leader.currentTime);
    if (now - lastSync > 350) {
      for (const track of activeTracks()) {
        if (track.media !== leader && Math.abs(track.media.currentTime - time) > 0.12) {
          track.media.currentTime = time;
        }
      }
      lastSync = now;
    }
    renderTransport();
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    if (playing && clock()) time = clock().currentTime;
    version++;
    playing = false;
    starting = false;
    cancelAnimationFrame(frame);
    all.forEach(track => track.media.pause());
    renderTransport();
  }

  async function play() {
    const tracks = activeTracks();
    if (!tracks.length || busy) return;
    const current = ++version;
    if (duration && time >= duration - 0.02) time = 0;
    starting = true;
    applyAudioRouting();
    renderTransport();
    try {
      all.forEach(track => {
        if (!tracks.includes(track)) track.media.pause();
      });
      tracks.forEach(track => { track.media.currentTime = time; });
      await Promise.all(tracks.map(track => track.media.play()));
      if (current !== version) return;
      starting = false;
      playing = true;
      tracks.forEach(reportPreview);
      renderTransport();
      frame = requestAnimationFrame(tick);
    } catch {
      if (current !== version) return;
      pause();
      error('Could not play the audio preview. Try again or save the WAV to listen.');
    }
  }

  function switchListen(next) {
    if (busy || !hasResults() || next === listen) return;
    const wasPlaying = playing || starting;
    if (wasPlaying && clock()) time = clock().currentTime;
    pause();
    listen = next;
    refreshDuration();
    render();
    if (wasPlaying) void play();
  }

  playButton.addEventListener('click', () => (playing || starting ? pause() : void play()));
  seek.addEventListener('input', () => {
    time = Number(seek.value);
    activeTracks().forEach(track => { track.media.currentTime = time; });
    renderTransport();
  });

  for (const btn of host.querySelectorAll('.cleanup-ab-btn')) {
    btn.addEventListener('click', () => switchListen(btn.dataset.listen));
  }

  $('.cleanup-strength-slider').addEventListener('input', event => {
    strength = Math.max(0, Math.min(100, Math.round(Number(event.target.value))));
    if (listen !== 'clean') switchListen('clean');
    else renderPanels();
  });

  for (const preset of host.querySelectorAll('.cleanup-preset')) {
    preset.addEventListener('click', () => {
      strength = Number(preset.dataset.strength);
      if (listen !== 'clean') switchListen('clean');
      else renderPanels();
    });
  }

  $('.cleanup-save-primary').addEventListener('click', async event => {
    const track = speechTrack();
    if (!track || busy) return;
    const button = event.currentTarget;
    button.disabled = true;
    try { await save(track.output, { strength }); }
    catch (cause) { error(cause.message || 'Could not save this audio.'); }
    finally { button.disabled = busy || !speechTrack(); }
  });

  $('.cleanup-save-secondary').addEventListener('click', async event => {
    const track = residualTrack();
    if (!track || busy) return;
    const button = event.currentTarget;
    button.disabled = true;
    try { await save(track.output, { strength: 100 }); }
    catch (cause) { error(cause.message || 'Could not save this track.'); }
    finally { button.disabled = busy || !residualTrack(); }
  });

  $('.cleanup-follow-isolate').addEventListener('click', () => {
    if (busy) return;
    onCleanVoiceFromSeparated?.(getState());
  });

  for (const [kind, label, caption] of [
    ['speech', 'Voice', 'Isolated speech / vocals from your recording.'],
    ['music', 'Music', 'Background music and everything outside the voice.'],
  ]) {
    const row = document.createElement('section');
    row.className = `cleanup-track cleanup-track-${kind}`;
    row.dataset.kind = kind;
    row.dataset.label = label;
    row.innerHTML = `
      <div class="cleanup-track-heading">
        <div>
          <h3>${label}</h3>
          <p class="cleanup-track-caption">${caption}</p>
        </div>
        <div class="cleanup-track-actions">
          <button type="button" class="cleanup-solo">Solo</button>
          <button type="button" class="cleanup-mute"></button>
          <button type="button" class="btn btn-secondary btn-small cleanup-save">${icon('download')}<span>Save WAV</span></button>
        </div>
      </div>
      <div class="cleanup-track-mix">
        <input type="range" min="0" max="100" step="1" value="100" aria-label="${label} preview volume">
        <output aria-live="off">100%</output>
      </div>`;
    row.querySelector('input').addEventListener('input', event => {
      const track = findTrack(kind);
      if (!track || busy) return;
      track.level = Number(event.target.value);
      if (track.level > 0) track.lastLevel = track.level;
      track.muted = false;
      renderPanels();
    });
    row.querySelector('.cleanup-mute').addEventListener('click', () => {
      const track = findTrack(kind);
      if (!track || busy) return;
      if (solo && solo !== kind) { solo = null; track.muted = false; renderPanels(); return; }
      if (track.muted || track.level === 0) {
        if (!track.level) track.level = track.lastLevel || 100;
        track.muted = false;
      } else {
        track.muted = true;
      }
      renderPanels();
    });
    row.querySelector('.cleanup-solo').addEventListener('click', () => {
      const track = findTrack(kind);
      if (!track || busy) return;
      solo = solo === kind ? null : kind;
      if (solo) track.muted = false;
      renderPanels();
      if (!playing && !starting) void play();
    });
    row.querySelector('.cleanup-save').addEventListener('click', async event => {
      const track = findTrack(kind);
      if (!track || busy) return;
      const button = event.currentTarget;
      button.disabled = true;
      try { await save(track.output, { strength: 100 }); }
      catch (cause) { error(cause.message || 'Could not save this track.'); }
      finally { button.disabled = busy || !findTrack(kind); }
    });
    stemRows.set(kind, row);
    $('.cleanup-tracks').append(row);
  }

  const tab = host.closest('.tab-content');
  if (tab) {
    new MutationObserver(() => {
      if (!tab.classList.contains('active')) pause();
    }).observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  function load(data = {}, options = {}) {
    const controls = new Map(all.map(track => [track.output.id, { level: track.level, lastLevel: track.lastLevel, muted: track.muted }]));
    const sameSource = source && data.source && source.output.id === data.source.id;
    if (!sameSource) { solo = null; strength = 100; }
    pause();
    all.splice(0).forEach(track => { track.media.removeAttribute('src'); track.media.load(); });
    mediaHost.replaceChildren();

    activeMode = data.mode || 'denoise';
    time = Number.isFinite(options.time) ? Math.max(0, options.time) : 0;
    duration = 0;
    source = null;
    outputs = [];
    lastSync = 0;

    const addTrack = (output, variant) => {
      const media = document.createElement('audio');
      media.preload = 'metadata';
      media.src = output.url;
      media.dataset.kind = output.kind;
      media.dataset.variant = variant;
      media.setAttribute('aria-hidden', 'true');
      const track = {
        output,
        variant,
        media,
        level: 100,
        lastLevel: 100,
        muted: false,
        ...controls.get(output.id),
        reported: previewed.has(output.id),
      };
      all.push(track);
      media.addEventListener('loadedmetadata', () => {
        if (!all.includes(track)) return;
        if (activeTracks().includes(track)) refreshDuration();
        else renderTransport();
      });
      media.addEventListener('playing', () => {
        if (activeTracks().includes(track)) reportPreview(track);
      });
      media.addEventListener('ended', () => {
        if (media === clock()) { pause(); time = duration; renderTransport(); }
      });
      mediaHost.append(media);
      return track;
    };

    if (data.source) source = addTrack(data.source, 'source');
    if (Array.isArray(data.outputs) && data.outputs.length) {
      outputs = data.outputs.map(item => addTrack(item, 'output'));
    }

    if (!outputs.length) {
      listen = 'original';
    } else if (options.listen) {
      listen = options.listen;
    } else {
      listen = activeMode === 'separate' ? 'stems' : 'clean';
    }

    host.classList.toggle('hidden', !source);
    refreshDuration();
    render();
  }

  function getState() {
    return { time: playing && clock() ? clock().currentTime : time, resume: playing || starting, listen, strength };
  }

  function setBusy(value) {
    if (busy === value) return;
    if (value) pause();
    busy = value;
    host.setAttribute('aria-busy', String(busy));
    render();
  }

  return { load, pause, play, getState, setBusy };
}
