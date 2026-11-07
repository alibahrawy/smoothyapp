/**
 * Agentic tab: Agent Bridge status, review preview, timecoded notes and markup.
 *
 * The tab is intentionally self-contained. The main process owns the MCP server,
 * frame extraction and review store; this module is the human surface.
 */

const api = window.electronAPI;

const byId = id => document.getElementById(id);

const state = {
  active: false,
  enabled: false,
  running: false,
  url: '',
  token: '',
  protocol: '',
  clients: 0,
  tools: [],
  activity: [],
  sequence: null,
  filePath: null,
  fileDuration: 0,
  fps: 30,
  duration: 0,
  time: 0,
  notes: [],
  openNotes: 0,
  tool: 'select',
  color: '#ff4d3d',
  strokes: [],
  draft: null,
  tokenVisible: false,
  frameRequest: 0,
  frameTimer: null,
  imageReady: false,
  approvals: [],
  videoPath: null,
  videoClip: null,
  videoMode: false,
  videoFailedPath: null,
  previewName: null,
  playing: false,
  muted: false,
  raf: 0,
  sequenceWidth: 0,
  sequenceHeight: 0,
  mediaWidth: 0,
  mediaHeight: 0
};

let els = {};
let cleanupEvents = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTimecode(seconds, fps = 30) {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const nominal = Math.max(1, Math.round(rate));
  const totalFrames = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * rate));
  const frames = totalFrames % nominal;
  const totalSeconds = Math.floor(totalFrames / nominal);
  return [Math.floor(totalSeconds / 3600), Math.floor(totalSeconds / 60) % 60, totalSeconds % 60, frames]
    .map(value => String(value).padStart(2, '0'))
    .join(':');
}

function basename(file) {
  return String(file || '').split(/[\\/]/).filter(Boolean).pop() || 'Media';
}

function previewUrl(file) {
  const bytes = new TextEncoder().encode(file);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `smoothy-preview://media/${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function mediaKind(file) {
  const extension = String(file || '').split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].includes(extension)) return 'image';
  if (['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff'].includes(extension)) return 'audio';
  return 'video';
}

function activeClipAt(rawTime = state.time) {
  const time = Math.min(Number(rawTime) || 0, Math.max(0, (state.duration || 0) - 0.001));
  if (state.filePath) {
    if (mediaKind(state.filePath) === 'audio') return null;
    return {
      path: state.filePath,
      name: basename(state.filePath),
      start: 0,
      end: state.fileDuration || state.duration || 0,
      inPoint: 0,
      outPoint: state.fileDuration || state.duration || 0,
      reversed: false,
      disabled: false,
      trackIndex: 0
    };
  }
  if (!state.sequence?.hasSequence) return null;
  const tracks = [...(state.sequence.videoTracks || [])].sort((a, b) => Number(b.index) - Number(a.index));
  for (const track of tracks) {
    for (const clip of track.clips || []) {
      if (!clip?.path || clip.disabled) continue;
      const start = Number(clip.start) || 0;
      const end = Number(clip.end) || 0;
      if (time + 0.0001 < start || time >= end) continue;
      return { ...clip, trackIndex: Number(track.index) || 0 };
    }
  }
  return null;
}

function sourceTimeFor(clip, time) {
  const offset = clamp(time - Number(clip.start || 0), 0, Math.max(0, Number(clip.end || 0) - Number(clip.start || 0)));
  return clip.reversed
    ? Math.max(0, Number(clip.outPoint || 0) - offset)
    : Math.max(0, Number(clip.inPoint || 0) + offset);
}

function timelineTimeFor(clip, sourceTime) {
  const offset = clip.reversed
    ? Math.max(0, Number(clip.outPoint || 0) - sourceTime)
    : Math.max(0, sourceTime - Number(clip.inPoint || 0));
  return Number(clip.start || 0) + offset;
}

function setPreviewAspect(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return;
  state.mediaWidth = w;
  state.mediaHeight = h;
  if (els.frame) els.frame.style.setProperty('--preview-aspect', String(w / h));
  layoutCanvas();
}

function layoutCanvas() {
  if (!els.frame || !els.markup) return;
  const rect = els.frame.getBoundingClientRect();
  const media = state.videoMode && els.video?.videoWidth
    ? { width: els.video.videoWidth, height: els.video.videoHeight }
    : state.imageReady && els.image?.naturalWidth
      ? { width: els.image.naturalWidth, height: els.image.naturalHeight }
      : null;
  if (!media || !rect.width || !rect.height) {
    els.markup.style.inset = '0';
    els.markup.style.width = '100%';
    els.markup.style.height = '100%';
    return;
  }
  const aspect = media.width / media.height;
  const containerAspect = rect.width / rect.height;
  let width = rect.width;
  let height = rect.height;
  if (aspect > containerAspect) height = width / aspect;
  else width = height * aspect;
  els.markup.style.inset = 'auto';
  els.markup.style.left = `${(rect.width - width) / 2}px`;
  els.markup.style.top = `${(rect.height - height) / 2}px`;
  els.markup.style.width = `${width}px`;
  els.markup.style.height = `${height}px`;
  if (els.markup.width !== media.width || els.markup.height !== media.height) {
    els.markup.width = media.width;
    els.markup.height = media.height;
    redraw(); // resizing a canvas clears it
  }
}

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = value;
}

function flash(message) {
  const toast = byId('agentic-flash');
  if (toast) {
    toast.textContent = message;
    toast.classList.remove('hidden');
  }
  window.clearTimeout(flash.timer);
  flash.timer = window.setTimeout(() => toast?.classList.add('hidden'), 3200);
}

function setEnabledUi(enabled) {
  state.enabled = Boolean(enabled);
  if (els.enabled) els.enabled.checked = state.enabled;
  if (els.dot) els.dot.dataset.state = state.running && state.enabled ? 'on' : 'off';
}

function renderStatus() {
  const dot = els.dot;
  if (!dot) return;
  dot.dataset.state = state.running && state.enabled ? 'on' : 'off';
  if (!state.enabled) {
    setText('agentic-status-text', 'Agent access is off');
    setText('agentic-status-meta', 'Turn it on to let an MCP client connect.');
  } else if (state.running) {
    setText('agentic-status-text', `Listening on ${state.url.replace(/^https?:\/\//, '').replace(/\/mcp$/, '')}`);
    setText('agentic-status-meta', `${state.clients} client${state.clients === 1 ? '' : 's'} · ${state.tools.length} tools · protocol ${state.protocol}`);
  } else {
    setText('agentic-status-text', 'Agent Bridge is starting…');
    setText('agentic-status-meta', 'The local server is not ready yet.');
  }
  setText('agentic-url', state.url || '—');
  setText('agentic-client-count', `${state.clients} client${state.clients === 1 ? '' : 's'}`);
  if (els.token) {
    els.token.textContent = state.tokenVisible ? state.token : (state.token ? '••••••••••••' : '—');
    els.token.title = state.tokenVisible ? state.token : 'Hidden';
  }
  if (els.tokenToggle) els.tokenToggle.textContent = state.tokenVisible ? 'Hide' : 'Show';
  if (els.enabled) {
    els.enabled.checked = state.enabled;
    els.enabled.disabled = false;
  }
}

function renderTools(tools = state.tools) {
  if (!els.tools) return;
  els.tools.innerHTML = '';
  if (!tools.length) {
    els.tools.innerHTML = '<p class="help-text">Tools appear when the bridge starts.</p>';
    return;
  }
  for (const tool of tools) {
    const row = document.createElement('div');
    row.className = 'agentic-tool';
    const name = document.createElement('code');
    name.textContent = tool.name.replace(/^smoothy_/, '');
    const description = document.createElement('span');
    description.textContent = tool.description || '';
    row.append(name, description);
    els.tools.append(row);
  }
}

function renderJob(job) {
  if (!job || !els.job) return;
  const done = job.status === 'done';
  const failed = job.status === 'error' || job.status === 'canceled';
  els.job.classList.remove('hidden');
  setText('agentic-job-title', job.kind === 'audio.setup' ? 'Audio engine setup' : (job.kind || 'Job'));
  setText('agentic-job-pct', `${Math.round(Number(job.progress) || 0)}%`);
  setText('agentic-job-message', job.error || job.message || '');
  const bar = byId('agentic-job-bar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`;
  window.clearTimeout(renderJob.timer);
  if (done || failed) {
    renderJob.timer = window.setTimeout(() => {
      els.job?.classList.add('hidden');
    }, failed ? 8000 : 4000);
  }
}

function renderActivity(activity = state.activity) {
  if (!els.activity) return;
  els.activity.innerHTML = '';
  const rows = [...activity].reverse().slice(0, 30);
  if (!rows.length) {
    els.activity.innerHTML = '<p class="help-text">No agent calls yet.</p>';
    return;
  }
  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'agentic-activity-row';
    row.dataset.ok = String(item.ok !== false);
    const dot = document.createElement('i');
    const label = document.createElement('strong');
    label.textContent = `${item.tool || 'tool'} · ${item.summary || ''}`;
    label.title = label.textContent;
    const time = document.createElement('time');
    time.textContent = item.ms ? `${item.ms}ms` : '';
    row.append(dot, label, time);
    els.activity.append(row);
  }
}

let markerDuration = -1;
function updateScrubUi() {
  const fps = state.fps || 30;
  if (markerDuration !== (state.duration || 0)) { markerDuration = state.duration || 0; renderMarkers(); }
  if (els.scrub) {
    els.scrub.max = String(Math.max(0, state.duration || 0));
    els.scrub.value = String(clamp(state.time, 0, state.duration || 0));
  }
  const tc = formatTimecode(state.time, fps);
  const duration = formatTimecode(state.duration || 0, fps);
  setText('agentic-timecode', tc);
  setText('agentic-note-time', tc);
  setText('agentic-time-readout', `${tc} / ${duration}`);
  if (els.play) {
    els.play.setAttribute('aria-pressed', String(state.playing));
    els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    els.play.querySelector('.agentic-play-icon')?.classList.toggle('hidden', state.playing);
    els.play.querySelector('.agentic-pause-icon')?.classList.toggle('hidden', !state.playing);
  }
  if (els.mute) {
    els.mute.dataset.muted = String(state.muted);
    els.mute.setAttribute('aria-pressed', String(state.muted));
    els.mute.setAttribute('aria-label', state.muted ? 'Unmute preview' : 'Mute preview');
  }
  if (els.frame) els.frame.classList.toggle('is-playing', state.playing);
}

function setTime(value, { load = true } = {}) {
  state.time = clamp(Number(value) || 0, 0, state.duration || 0);
  updateScrubUi();
  if (!state.videoMode) {
    if (load) scheduleFrame();
    return;
  }
  const clip = activeClipAt(state.time);
  if (!clip) {
    void preparePreview({ autoplay: false });
    return;
  }
  if (state.videoPath && clip.path === state.videoPath && els.video?.readyState >= 1) {
    try { els.video.currentTime = sourceTimeFor(clip, state.time); } catch {}
    state.videoClip = clip;
  } else {
    void preparePreview({ autoplay: state.playing });
  }
}

async function refreshState() {
  try {
    const next = await api.agentState();
    if (!next) return;
    state.enabled = Boolean(next.enabled);
    state.running = Boolean(next.running);
    state.url = next.url || '';
    state.token = next.token || '';
    state.protocol = next.protocolVersion || '';
    state.clients = Number(next.clients) || 0;
    state.tools = Array.isArray(next.tools) ? next.tools : [];
    state.activity = Array.isArray(next.activity) ? next.activity : [];
    if (next.editor?.sequence && !state.filePath) {
      state.fps = Number(next.editor.sequence.fps) || state.fps;
      state.duration = Number(next.editor.sequence.duration) || state.duration;
    }
    setEnabledUi(state.enabled);
    renderStatus();
    renderTools();
    renderActivity();
    if (next.preview?.path && next.preview.path !== state.filePath) applyAgentPreview(next.preview);
  } catch (error) {
    setText('agentic-status-text', 'Agent Bridge unavailable');
    setText('agentic-status-meta', error?.message || 'The local server did not start.');
  }
}

async function refreshProject() {
  try {
    const result = await api.agentProject({ action: 'inspect' });
    if (!result?.ok) {
      state.sequence = null;
      state.duration = state.filePath ? state.fileDuration : 0;
      setText('agentic-sequence-name', state.filePath
        ? (state.previewName ? `Agent preview · ${state.previewName}` : basename(state.filePath))
        : 'No sequence');
      updateSequenceButton();
      updateScrubUi();
      return;
    }
    const sequence = result.data?.sequence;
    if (sequence?.hasSequence) {
      state.sequence = sequence;
      state.sequenceWidth = Number(sequence.width) || 0;
      state.sequenceHeight = Number(sequence.height) || 0;
      state.fps = Number(sequence.fps) || 30;
      if (!state.filePath) state.duration = Number(sequence.duration) || 0;
      setText('agentic-sequence-name', state.filePath
        ? (state.previewName ? `Agent preview · ${state.previewName}` : basename(state.filePath))
        : (sequence.name || 'Current sequence'));
      state.time = clamp(state.time, 0, Math.max(0, state.duration - 1 / (state.fps || 30)));
      if (!state.filePath) setPreviewAspect(state.sequenceWidth, state.sequenceHeight);
      updateSequenceButton();
      updateScrubUi();
      if (state.active && !state.filePath) await preparePreview();
    } else {
      state.sequence = null;
      state.sequenceWidth = 0;
      state.sequenceHeight = 0;
      state.duration = state.filePath ? state.fileDuration : 0;
      setText('agentic-sequence-name', state.filePath
        ? (state.previewName ? `Agent preview · ${state.previewName}` : basename(state.filePath))
        : 'No sequence');
      updateSequenceButton();
      updateScrubUi();
      if (state.active && state.filePath) await preparePreview();
    }
  } catch (error) {
    setText('agentic-sequence-name', 'Could not read the sequence');
  }
}

function scheduleFrame() {
  window.clearTimeout(state.frameTimer);
  state.frameTimer = window.setTimeout(() => { void loadFrame(); }, 90);
}

function exitVideoMode() {
  state.videoMode = false;
  if (els.frame) {
    els.frame.classList.remove('video-mode');
    if (!state.imageReady) els.frame.classList.remove('has-frame');
  }
  layoutCanvas();
}

async function ensureVideo(path) {
  if (!els.video) return false;
  if (state.videoFailedPath === path) return false;
  if (els.video.dataset.path === path && els.video.readyState >= 1) return true;
  els.video.pause();
  els.video.dataset.path = path;
  els.video.muted = state.muted;
  els.video.src = previewUrl(path);
  els.video.load();
  const loaded = await new Promise(resolve => {
    let timer = null;
    const done = value => {
      if (timer) window.clearTimeout(timer);
      els.video.removeEventListener('loadedmetadata', onLoaded);
      els.video.removeEventListener('error', onError);
      resolve(value);
    };
    const onLoaded = () => done(true);
    const onError = () => done(false);
    els.video.addEventListener('loadedmetadata', onLoaded, { once: true });
    els.video.addEventListener('error', onError, { once: true });
    timer = window.setTimeout(() => done(false), 10000);
  });
  if (!loaded) {
    state.videoFailedPath = path;
    return false;
  }
  return true;
}

async function preparePreview({ autoplay = false } = {}) {
  const clip = activeClipAt(state.time);
  if (!clip) {
    pauseVideo();
    state.imageReady = false;
    exitVideoMode();
    if (els.frame) els.frame.classList.remove('has-frame');
    if (els.empty) els.empty.textContent = 'No video at this time.';
    return false;
  }
  const kind = mediaKind(clip.path);
  if (kind !== 'video') {
    pauseVideo();
    exitVideoMode();
    if (kind === 'image') await loadFrame();
    else if (els.empty) els.empty.textContent = 'This clip has no video frame.';
    return false;
  }
  const ready = await ensureVideo(clip.path);
  if (!ready) {
    exitVideoMode();
    if (els.empty) {
      els.empty.textContent = 'This codec cannot play inline. Frame stepping still works.';
      if (els.frame) els.frame.classList.remove('has-frame');
    }
    await loadFrame();
    return false;
  }
  state.videoClip = clip;
  state.videoPath = clip.path;
  const sequenceAspect = !state.filePath && state.sequence?.hasSequence && Number(state.sequence.width) > 0 && Number(state.sequence.height) > 0;
  setPreviewAspect(
    sequenceAspect ? Number(state.sequence.width) : els.video.videoWidth,
    sequenceAspect ? Number(state.sequence.height) : els.video.videoHeight
  );
  state.videoMode = true;
  if (els.frame) {
    els.frame.classList.add('video-mode');
    els.frame.classList.add('has-frame');
  }
  try { els.video.currentTime = sourceTimeFor(clip, state.time); } catch {}
  if (autoplay) await playVideo();
  else updateScrubUi();
  return true;
}

async function playVideo() {
  if (!state.videoMode || !state.videoClip) {
    const ready = await preparePreview({ autoplay: false });
    if (!ready) return;
  }
  try {
    els.video.muted = state.muted;
    await els.video.play();
    state.playing = true;
    updateScrubUi();
    startTick();
  } catch {
    state.playing = false;
    updateScrubUi();
  }
}

function pauseVideo() {
  state.playing = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  if (els.video && !els.video.paused) els.video.pause();
  if (state.videoMode && state.videoClip && els.video?.readyState >= 1) {
    state.time = clamp(timelineTimeFor(state.videoClip, els.video.currentTime), 0, state.duration || 0);
  }
  updateScrubUi();
}

function togglePlay() {
  if (state.playing) pauseVideo();
  else void playVideo();
}

function advancePlayback() {
  const current = state.videoClip;
  if (!current) { pauseVideo(); return; }
  if (state.filePath) {
    state.time = Math.min(state.duration, Number(current.end) || state.duration);
    pauseVideo();
    return;
  }
  const end = Number(current.end) || state.duration;
  const next = activeClipAt(end + 0.001);
  if (next && Number(next.start) <= end + 0.5) {
    state.time = Number(next.start) + 0.001;
    void preparePreview({ autoplay: true });
    return;
  }
  state.time = Math.min(state.duration, end);
  pauseVideo();
}

function syncPlayback() {
  if (!state.playing || !state.videoMode || !state.videoClip || !els.video) return;
  const clip = state.videoClip;
  const end = Number(clip.end) || state.duration;
  const timeline = timelineTimeFor(clip, els.video.currentTime);
  if (timeline >= end - 0.025 || els.video.ended) {
    advancePlayback();
    return;
  }
  state.time = clamp(timeline, 0, state.duration || 0);
  updateScrubUi();
}

function startTick() {
  if (state.raf) cancelAnimationFrame(state.raf);
  const tick = () => {
    if (!state.playing) return;
    syncPlayback();
    if (state.playing) state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

async function loadFrame() {
  if (!state.active) return;
  const request = ++state.frameRequest;
  if (els.empty && !state.imageReady) els.empty.textContent = 'Loading frame…';
  const input = {
    action: 'frame',
    time: state.time,
    width: 1280,
    ...(state.filePath ? { path: state.filePath } : {})
  };
  try {
    const result = await api.agentMedia(input);
    if (request !== state.frameRequest) return;
    if (!result?.ok || !result.imageDataUrl) {
      state.imageReady = false;
      if (els.frame) els.frame.classList.remove('has-frame');
      if (els.empty) els.empty.textContent = result?.error?.message || 'No frame at this time.';
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (request !== state.frameRequest) return;
      state.imageReady = true;
      els.image.src = image.src;
      if (els.frame) els.frame.classList.add('has-frame');
      const sequenceAspect = !state.filePath && state.sequence?.hasSequence && Number(state.sequence.width) > 0 && Number(state.sequence.height) > 0;
      setPreviewAspect(
        sequenceAspect ? Number(state.sequence.width) : image.naturalWidth,
        sequenceAspect ? Number(state.sequence.height) : image.naturalHeight
      );
      layoutCanvas();
      redraw();
    };
    image.src = result.imageDataUrl;
    if (result.data?.timecode) setText('agentic-timecode', result.data.timecode);
  } catch (error) {
    if (request !== state.frameRequest) return;
    state.imageReady = false;
    if (els.frame) els.frame.classList.remove('has-frame');
    if (els.empty) els.empty.textContent = error?.message || 'Could not load a frame.';
  }
}

function pointFromEvent(event) {
  const rect = els.markup.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
  };
}

function drawStroke(ctx, stroke) {
  if (!stroke?.points?.length) return;
  const width = Math.max(2, els.markup.width * 0.0045);
  ctx.save();
  ctx.strokeStyle = stroke.color || state.color;
  ctx.fillStyle = stroke.color || state.color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const points = stroke.points.map(point => ({
    x: point.x * els.markup.width,
    y: point.y * els.markup.height
  }));
  if (stroke.tool === 'rect') {
    const start = points[0];
    const end = points[points.length - 1];
    ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (stroke.tool === 'arrow') {
    const start = points[0];
    const end = points[points.length - 1];
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const head = Math.max(10, width * 4);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
    ctx.stroke();
  }
  ctx.restore();
}

function redraw() {
  if (!els.markup) return;
  const ctx = els.markup.getContext('2d');
  ctx.clearRect(0, 0, els.markup.width, els.markup.height);
  for (const stroke of state.strokes) drawStroke(ctx, stroke);
  if (state.draft) drawStroke(ctx, state.draft);
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('[data-agentic-tool]').forEach(button => {
    button.classList.toggle('active', button.dataset.agenticTool === tool);
  });
  if (els.frame) els.frame.dataset.tool = tool;
}

/** True when there is a picture under the markup layer to draw on. */
function canMarkUp() {
  const videoReady = state.videoMode && els.video && els.video.readyState >= 2 && els.video.videoWidth;
  return Boolean(videoReady || state.imageReady);
}

function drawLoaded(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  if (els.markup?.width) ctx.drawImage(els.markup, 0, 0, width, height);
  return canvas.toDataURL('image/png'); // throws if the source tainted the canvas
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the frame.'));
    image.src = src;
  });
}

/**
 * The current frame with the markup drawn on top, as a PNG data URL for the agent.
 * The playing video comes from a custom protocol, so reading its pixels can be blocked;
 * in that case we ask the main process for the same frame and draw the markup on it.
 */
async function compositeScreenshot() {
  if (!els.markup) return null;
  const videoReady = state.videoMode && els.video && els.video.readyState >= 2 && els.video.videoWidth;
  try {
    if (videoReady) return drawLoaded(els.video, els.video.videoWidth, els.video.videoHeight);
    if (state.imageReady && els.image?.naturalWidth) return drawLoaded(els.image, els.image.naturalWidth, els.image.naturalHeight);
  } catch (error) {
    console.warn('[Agentic] Falling back to an extracted frame for the screenshot:', error?.message || error);
  }
  try {
    const result = await api.agentMedia({ action: 'frame', time: state.time, width: 1920, ...(state.filePath ? { path: state.filePath } : {}) });
    if (!result?.ok || !result.imageDataUrl) return null;
    const image = await loadImage(result.imageDataUrl);
    return drawLoaded(image, image.naturalWidth, image.naturalHeight);
  } catch (error) {
    console.warn('[Agentic] Could not capture the marked frame:', error?.message || error);
    return null;
  }
}

async function refreshNotes() {
  try {
    const result = await api.agentReviewList({ includeResolved: true });
    if (!result?.ok) return;
    state.notes = Array.isArray(result.data?.threads) ? result.data.threads : [];
    state.openNotes = state.notes.filter(note => note.status === 'open').length;
    setText('agentic-notes-count', `${state.openNotes} open`);
    renderNotes();
    // The editor writes the notes, so open notes are not an alert; the badge is for agent activity.
    byId('agentic-nav-badge')?.classList.add('hidden');
  } catch {}
}

function relativeAge(value) {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderMarkers() {
  const strip = byId('agentic-markers');
  if (!strip) return;
  strip.innerHTML = '';
  const duration = state.duration || 0;
  if (!duration) return;
  for (const note of state.notes) {
    if (!Number.isFinite(note.time)) continue;
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'agentic-marker';
    dot.dataset.author = note.author;
    dot.dataset.status = note.status;
    dot.style.left = `${clamp(note.time / duration, 0, 1) * 100}%`;
    dot.title = `${note.timecode || formatTimecode(note.time, state.fps)} · ${note.body.slice(0, 80)}`;
    dot.textContent = note.author === 'agent' ? 'AI' : 'Y';
    dot.addEventListener('click', () => { pauseVideo(); setTime(note.time); });
    strip.append(dot);
  }
}

function renderNotes() {
  if (!els.notes) return;
  els.notes.innerHTML = '';
  // Oldest first, like a review thread; the number is the order they were written.
  const ordered = [...state.notes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (els.notesEmpty) els.notesEmpty.classList.toggle('hidden', ordered.length > 0);
  ordered.forEach((note, index) => {
    const card = document.createElement('article');
    card.className = 'agentic-note';
    card.dataset.status = note.status;

    const head = document.createElement('div');
    head.className = 'agentic-note-head';
    const avatar = document.createElement('span');
    avatar.className = 'agentic-avatar';
    avatar.dataset.author = note.author;
    avatar.textContent = note.author === 'agent' ? 'AI' : 'You'.slice(0, 1);
    const author = document.createElement('strong');
    author.className = 'agentic-note-author';
    author.textContent = note.author === 'agent' ? 'Agent' : 'You';
    const age = document.createElement('span');
    age.className = 'agentic-note-age';
    age.textContent = relativeAge(note.createdAt);
    const number = document.createElement('span');
    number.className = 'agentic-note-number';
    number.textContent = `#${index + 1}`;
    head.append(avatar, author, age, number);

    const body = document.createElement('p');
    body.className = 'agentic-note-body';
    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'agentic-tc-chip agentic-note-time';
    time.textContent = note.timecode || formatTimecode(note.time, state.fps);
    time.title = 'Go to this frame';
    time.addEventListener('click', () => { pauseVideo(); setTime(note.time); els.preview?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    body.append(time, document.createTextNode(` ${note.body}`));

    card.append(head, body);

    if (note.replies?.length) {
      const replies = document.createElement('div');
      replies.className = 'agentic-note-replies';
      for (const reply of note.replies) {
        const row = document.createElement('div');
        row.className = 'agentic-note-reply';
        const strong = document.createElement('strong');
        strong.textContent = reply.author === 'agent' ? 'Agent' : 'You';
        row.append(strong, document.createTextNode(` ${reply.body}`));
        replies.append(row);
      }
      card.append(replies);
    }

    const footer = document.createElement('div');
    footer.className = 'agentic-note-footer';
    const replyToggle = document.createElement('button');
    replyToggle.type = 'button';
    replyToggle.className = 'agentic-note-link';
    replyToggle.textContent = 'Reply';
    const resolve = document.createElement('button');
    resolve.type = 'button';
    resolve.className = 'agentic-resolve';
    resolve.setAttribute('aria-label', note.status === 'resolved' ? 'Reopen note' : 'Mark as fixed');
    resolve.title = note.status === 'resolved' ? 'Fixed · click to reopen' : 'Mark as fixed';
    resolve.dataset.done = String(note.status === 'resolved');
    resolve.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>';
    resolve.addEventListener('click', async () => {
      const result = await api.agentReviewResolve({ id: note.id, resolved: note.status !== 'resolved' });
      if (result?.ok) await refreshNotes();
    });
    footer.append(replyToggle, resolve);

    const reply = document.createElement('div');
    reply.className = 'agentic-note-reply-form hidden';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 6000;
    input.placeholder = 'Reply…';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'agentic-text-btn';
    send.textContent = 'Send';
    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      const result = await api.agentReviewReply({ id: note.id, body: text });
      send.disabled = false;
      if (result?.ok) { input.value = ''; await refreshNotes(); }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } });
    replyToggle.addEventListener('click', () => { reply.classList.toggle('hidden'); if (!reply.classList.contains('hidden')) input.focus(); });
    reply.append(input, send);
    card.append(footer, reply);
    els.notes.append(card);
  });
  renderMarkers();
}

async function addNote() {
  const body = (els.noteBody?.value || '').trim();
  if (state.playing) pauseVideo();
  // Markup always goes to the agent as a picture; otherwise follow "Attach frame".
  const marked = state.strokes.length > 0;
  if (els.addNote) els.addNote.disabled = true;
  const screenshotDataUrl = marked || els.capture?.checked ? await compositeScreenshot() : null;
  if (els.addNote) els.addNote.disabled = false;
  if (marked && !screenshotDataUrl) {
    flash('Could not capture the marked frame. Try again, or step to the frame first.');
    return;
  }
  if (!body && !screenshotDataUrl) {
    flash('Write a note or attach a marked frame first.');
    els.noteBody?.focus();
    return;
  }
  const before = state.strokes.length;
  if (els.addNote) els.addNote.disabled = true;
  let result;
  try {
    result = await api.agentReviewAdd({
      time: state.time,
      body: body || `Note at ${formatTimecode(state.time, state.fps)}`,
      screenshotDataUrl,
      drawing: before ? state.strokes : []
    });
  } catch (error) {
    result = { ok: false, error: { message: error?.message || 'Could not add the note.' } };
  } finally {
    if (els.addNote) els.addNote.disabled = false;
  }
  if (!result?.ok) {
    flash(result?.error?.message || 'Could not add the note.');
    return;
  }
  if (els.noteBody) els.noteBody.value = '';
  state.strokes = [];
  state.draft = null;
  redraw();
  await refreshNotes();
  flash('Note added. The agent can see it now.');
}

function resetVideoState() {
  state.videoPath = null;
  state.videoClip = null;
  state.videoFailedPath = null;
  state.sequenceWidth = 0;
  state.sequenceHeight = 0;
  pauseVideo();
  exitVideoMode();
  if (els.video) {
    els.video.removeAttribute('src');
    delete els.video.dataset.path;
    els.video.load();
  }
  updateSequenceButton();
}

function updateSequenceButton() {
  const button = byId('agentic-use-sequence');
  if (button) button.classList.toggle('hidden', !(state.sequence?.hasSequence && state.filePath));
  const chip = byId('agentic-premiere-chip');
  if (chip) {
    const linked = Boolean(state.sequence?.hasSequence);
    chip.dataset.linked = String(linked);
    chip.textContent = linked ? 'Premiere linked' : 'Premiere not linked';
    chip.title = linked ? 'Your open Premiere sequence is shared with the AI. Switch the editor to Premiere for final touches.' : 'Open a sequence in Premiere to share it with the AI.';
  }
}

function applyAgentPreview(preview) {
  if (!preview?.path) return;
  state.filePath = preview.path;
  state.previewName = String(preview.name || basename(preview.path));
  state.fileDuration = Number(preview.duration) || 0;
  state.fps = Number(preview.fps) || 30;
  state.duration = state.fileDuration || 0;
  state.time = clamp(Number(preview.time) || 0, 0, state.duration || 0);
  resetVideoState();
  setText('agentic-sequence-name', `Agent preview · ${preview.name || basename(preview.path)}`);
  updateSequenceButton();
  updateScrubUi();
  if (Number(preview.width) > 0 && Number(preview.height) > 0) {
    setPreviewAspect(Number(preview.width), Number(preview.height));
  }
  void preparePreview();
  if (!state.active) {
    const badge = byId('agentic-nav-badge');
    if (badge) badge.classList.remove('hidden');
  }
}

async function openFile() {
  try {
    const result = await api.agentPickFile();
    if (result?.canceled || !result?.path) return;
    await api.agentPreviewClear();
    state.filePath = result.path;
    state.previewName = null;
    const probe = await api.agentProbe({ path: result.path });
    if (!probe?.ok) {
      flash(probe?.error?.message || 'Could not read that file.');
      return;
    }
    state.fileDuration = Number(probe?.data?.probe?.duration) || 0;
    state.fps = Number(probe?.data?.probe?.video?.fps) || 30;
    state.duration = state.fileDuration || 0;
    state.time = 0;
    resetVideoState();
    setText('agentic-sequence-name', basename(result.path));
    updateSequenceButton();
    updateScrubUi();
    const width = Number(probe?.data?.probe?.video?.width) || 0;
    const height = Number(probe?.data?.probe?.video?.height) || 0;
    if (width && height) setPreviewAspect(width, height);
    await preparePreview();
  } catch (error) {
    flash(error?.message || 'Could not open that file.');
  }
}

function renderApproval() {
  const next = state.approvals[0];
  if (!next) {
    els.approval?.classList.add('hidden');
    return;
  }
  const label = next.tool === 'smoothy_audio' && next.args?.action === 'setup'
    ? 'Install the local audio engine?'
    : next.tool === 'smoothy_timeline'
      ? 'Run this timeline action?'
      : `Run ${next.tool.replace(/^smoothy_/, '')}?`;
  setText('agentic-approval-title', label);
  if (els.approvalDetail) els.approvalDetail.textContent = JSON.stringify(next.args || {}, null, 2);
  els.approval?.classList.remove('hidden');
}

function showApproval(approval) {
  if (!approval?.id) return;
  if (!state.approvals.some(item => item.id === approval.id)) state.approvals.push(approval);
  if (els.approval?.classList.contains('hidden')) renderApproval();
}

async function decideApproval(allow) {
  const current = state.approvals.shift();
  if (current) {
    await api.agentApprove(current.id, allow);
    flash(allow ? 'Timeline action approved.' : 'Timeline action denied.');
  }
  renderApproval();
}

function handleAgentEvent(event) {
  const type = event?.type;
  const data = event?.data;
  if (type === 'activity' && data) {
    state.activity.push(data);
    if (state.activity.length > 100) state.activity.shift();
    renderActivity();
    return;
  }
  if (type === 'review') {
    void refreshNotes();
    return;
  }
  if (type === 'preview' && data) {
    applyAgentPreview(data);
    return;
  }
  if (type === 'seek' && data) {
    pauseVideo();
    setTime(Number(data.time) || 0);
    if (!state.active) {
      const badge = byId('agentic-nav-badge');
      if (badge) badge.classList.remove('hidden');
    }
    return;
  }
  if (type === 'approval') {
    showApproval(data);
    const badge = byId('agentic-nav-badge');
    if (badge && !state.active) badge.classList.remove('hidden');
    return;
  }
  if (type === 'status') {
    void refreshState();
    return;
  }
  if (type === 'job' && data) {
    renderJob(data);
    flash(`${data.kind || 'Job'} · ${data.progress || 0}% · ${data.message || ''}`);
    if (data.status === 'done' && data.result?.ready) void refreshState();
  }
}

function copy(value) {
  if (!value) return;
  void api.agentCopy(value);
}

async function copyClaude() {
  const url = state.url || 'http://127.0.0.1:3778/mcp';
  const token = state.token || '<token>';
  copy(`claude mcp add --transport http smoothy ${url} --header "Authorization: Bearer ${token}"`);
  flash('Claude Code command copied.');
}

function copyJson() {
  const config = {
    mcpServers: {
      smoothy: {
        type: 'http',
        url: state.url || 'http://127.0.0.1:3778/mcp',
        headers: { Authorization: `Bearer ${state.token || '<token>'}` }
      }
    }
  };
  copy(JSON.stringify(config, null, 2));
  flash('MCP JSON copied.');
}

async function copySkill() {
  const markdown = await api.agentSkill();
  copy(markdown);
  flash('Agent skill copied.');
}

function bind() {
  els = {
    enabled: byId('agentic-enabled'),
    dot: byId('agentic-dot'),
    frame: byId('agentic-preview-frame'),
    image: byId('agentic-preview-image'),
    video: byId('agentic-video'),
    markup: byId('agentic-markup'),
    empty: byId('agentic-preview-empty'),
    scrub: byId('agentic-scrub'),
    play: byId('agentic-play'),
    mute: byId('agentic-mute'),
    noteBody: byId('agentic-note-body'),
    capture: byId('agentic-note-capture'),
    addNote: byId('agentic-note-add'),
    notes: byId('agentic-notes'),
    notesEmpty: byId('agentic-notes-empty'),
    tools: byId('agentic-tools'),
    activity: byId('agentic-activity'),
    token: byId('agentic-token'),
    tokenToggle: byId('agentic-token-toggle'),
    approval: byId('agentic-approval'),
    approvalDetail: byId('agentic-approval-detail'),
    job: byId('agentic-job'),
    preview: byId('agentic-preview-frame')
  };

  els.enabled?.addEventListener('change', async event => {
    const enabled = Boolean(event.target.checked);
    setEnabledUi(enabled);
    const result = await api.agentSetEnabled(enabled);
    state.enabled = Boolean(result?.enabled ?? enabled);
    state.running = Boolean(result?.running);
    state.url = result?.url || state.url;
    state.token = result?.token || state.token;
    state.protocol = result?.protocolVersion || state.protocol;
    state.clients = Number(result?.clients) || 0;
    state.tools = Array.isArray(result?.tools) ? result.tools : state.tools;
    renderStatus();
    renderTools();
    if (state.enabled && !state.running) window.setTimeout(() => void refreshState(), 500);
  });

  els.tokenToggle?.addEventListener('click', () => {
    state.tokenVisible = !state.tokenVisible;
    renderStatus();
  });

  byId('agentic-copy-claude')?.addEventListener('click', copyClaude);
  byId('agentic-copy-json')?.addEventListener('click', copyJson);
  byId('agentic-copy-skill')?.addEventListener('click', () => void copySkill());
  byId('agentic-open-file')?.addEventListener('click', () => void openFile());
  byId('agentic-use-sequence')?.addEventListener('click', async () => {
    await api.agentPreviewClear();
    state.filePath = null;
    state.previewName = null;
    state.fileDuration = 0;
    resetVideoState();
    void refreshProject();
  });
  byId('agentic-refresh-frame')?.addEventListener('click', () => { void preparePreview(); });
  els.scrub?.addEventListener('input', event => {
    const value = Number(event.target.value);
    pauseVideo();
    setTime(value);
  });
  els.play?.addEventListener('click', togglePlay);
  els.mute?.addEventListener('click', () => {
    state.muted = !state.muted;
    if (els.video) els.video.muted = state.muted;
    updateScrubUi();
  });
  byId('agentic-fullscreen')?.addEventListener('click', () => {
    if (!document.fullscreenElement) void els.frame?.requestFullscreen?.();
    else void document.exitFullscreen?.();
  });
  byId('agentic-prev-frame')?.addEventListener('click', () => {
    pauseVideo();
    setTime(state.time - 1 / (state.fps || 30));
  });
  byId('agentic-next-frame')?.addEventListener('click', () => {
    pauseVideo();
    setTime(state.time + 1 / (state.fps || 30));
  });
  els.addNote?.addEventListener('click', () => void addNote());
  els.video?.addEventListener('loadedmetadata', () => layoutCanvas());
  els.video?.addEventListener('timeupdate', syncPlayback);
  els.video?.addEventListener('play', () => { state.playing = true; updateScrubUi(); startTick(); });
  els.video?.addEventListener('pause', () => { if (!state.playing) updateScrubUi(); });
  els.video?.addEventListener('ended', () => advancePlayback());
  els.video?.addEventListener('error', () => {
    if (state.videoPath) state.videoFailedPath = state.videoPath;
    exitVideoMode();
    if (els.empty) els.empty.textContent = 'This codec cannot play inline. Frame stepping still works.';
    void loadFrame();
  });
  document.addEventListener('fullscreenchange', () => layoutCanvas());
  window.addEventListener('resize', layoutCanvas);
  if (els.frame && 'ResizeObserver' in window) new ResizeObserver(layoutCanvas).observe(els.frame);
  document.addEventListener('keydown', event => {
    if (!state.active || event.code !== 'Space') return;
    if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(event.target?.tagName || '')) return;
    event.preventDefault();
    togglePlay();
  });

  document.querySelectorAll('[data-agentic-tool]').forEach(button => {
    button.addEventListener('click', () => setTool(button.dataset.agenticTool));
  });
  byId('agentic-markup-color')?.addEventListener('input', event => { state.color = event.target.value || '#ff4d3d'; });
  byId('agentic-markup-undo')?.addEventListener('click', () => { state.strokes.pop(); state.draft = null; redraw(); });
  byId('agentic-markup-clear')?.addEventListener('click', () => { state.strokes = []; state.draft = null; redraw(); });

  els.markup?.addEventListener('pointerdown', event => {
    if (state.tool === 'select' || event.button !== 0) return;
    if (!canMarkUp()) { flash('Load a frame or play the video first, then draw on it.'); return; }
    if (state.playing) pauseVideo(); // mark a still frame, not a moving one
    els.markup.setPointerCapture?.(event.pointerId);
    const point = pointFromEvent(event);
    state.draft = { tool: state.tool, color: state.color, points: [point] };
    redraw();
  });
  els.markup?.addEventListener('pointermove', event => {
    if (!state.draft) return;
    const point = pointFromEvent(event);
    if (state.tool === 'pen') state.draft.points.push(point);
    else state.draft.points[1] = point;
    redraw();
  });
  const finish = event => {
    if (!state.draft) return;
    const point = state.draft.points[state.draft.points.length - 1] || pointFromEvent(event);
    if (state.draft.tool !== 'pen') state.draft.points[1] = point;
    if (state.draft.points.length > 1) state.strokes.push(state.draft);
    state.draft = null;
    redraw();
  };
  els.markup?.addEventListener('pointerup', finish);
  els.markup?.addEventListener('pointercancel', finish);
  els.markup?.addEventListener('pointerleave', event => { if (event.buttons === 0) finish(event); });

  byId('agentic-approval-allow')?.addEventListener('click', () => void decideApproval(true));
  byId('agentic-approval-deny')?.addEventListener('click', () => void decideApproval(false));

  cleanupEvents = api.onAgentEvent(handleAgentEvent);
  setTool('select');
  updateScrubUi();
}

export function initAgentic() {
  if (!byId('tab-agentic')) return { activate() {} };
  bind();
  void refreshState();
  void refreshNotes();
  return {
    activate() {
      state.active = true;
      const badge = byId('agentic-nav-badge');
      if (badge) badge.classList.add('hidden');
      void refreshState();
      void refreshNotes();
      void refreshProject();
    },
    deactivate() {
      state.active = false;
      pauseVideo();
    }
  };
}
