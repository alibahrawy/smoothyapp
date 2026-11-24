// Animated captions (Premiere only). Sends the generated captions with the
// chosen template and style; the main process places one Motion Graphics
// Template clip per caption on a new top video track. Outline in its default
// look (with any position on screen) is free; Box, Rise, Slide and other
// changes to the look need Pro. The main process enforces this too.
//
// The preview plays each style the way its After Effects template animates it
// (scripts/pro-captions/*.jsx): same frame counts, easing and design units
// (1920x1080 at Size 100), scaled to the preview frame.

const FPS = 30;
const LIME = '#92f388', INK = '#151515', WHITE = '#ffffff';

// Defaults match each template (src/main/captions/pro-captions.ts).
const TEMPLATES = {
  'box-highlight': {
    font: "800 65px/1 'Plus Jakarta Sans', sans-serif", letterSpacing: -0.03, wordSpacing: 0,
    positions: { bottom: 93.1, lower: 71.55, centre: 50 },
    defaults: { textColor: INK, boxColor: LIME, upcomingOpacity: 42, boxRadius: 7, shadowOpacity: 0, size: 100, position: 'bottom' },
  },
  'word-rise': {
    font: "700 70px/1 'Inter Display', 'SF Pro Display', system-ui, sans-serif", letterSpacing: -0.02, wordSpacing: 0,
    positions: { bottom: 85, lower: 67.5, centre: 50 }, from: [0, 34], frames: 7,
    defaults: { textColor: WHITE, shadowOpacity: 45, size: 100, position: 'bottom' },
  },
  'word-slide': {
    font: "700 70px/1 'Inter Display', 'SF Pro Display', system-ui, sans-serif", letterSpacing: -0.02, wordSpacing: 0,
    positions: { bottom: 85, lower: 67.5, centre: 50 }, from: [46, 0], frames: 7,
    defaults: { textColor: WHITE, shadowOpacity: 45, size: 100, position: 'bottom' },
  },
  'stroke-highlight': {
    font: "800 72px/1 'Inter Display', system-ui, sans-serif", letterSpacing: -0.01, wordSpacing: 0,
    positions: { bottom: 85, lower: 67.5, centre: 50 },
    defaults: { textColor: WHITE, highlightColor: LIME, strokeColor: INK, strokeWidth: 9, shadowOpacity: 35, size: 100, position: 'bottom' },
  },
};

// Sample lines with word start times in seconds, looped over the 6 s footage
// montage (assets/caption-preview.mp4), which drives the clock while it plays.
const SAMPLE = [
  { start: 0.3, end: 2.5, words: [['Cut', 0], ['the', 0.28], ['silence,', 0.5], ['keep', 1.15], ['the', 1.4], ['flow.', 1.6]] },
  { start: 2.9, end: 5.4, words: [['Every', 0], ['word', 0.36], ['lands', 0.7], ['right', 1.1], ['on', 1.42], ['time.', 1.6]] },
];
const LOOP = 6;
const STORAGE_KEY = 'smoothy.proCaptions.styles.v1';
const FREE_TEMPLATE = 'stroke-highlight';
const NAMES = { 'box-highlight': 'Box', 'word-rise': 'Rise', 'word-slide': 'Slide', 'stroke-highlight': 'Outline' };

const easeOutCubic = u => 1 - Math.pow(1 - u, 3);
const easeOutQuart = u => 1 - Math.pow(1 - u, 4);
const clamp01 = u => Math.max(0, Math.min(1, u));
const POP = [0, 0.55, 0.85, 1];

function hexToRgba(hex, alpha) {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
  return `rgba(${parseInt(value.slice(1, 3), 16)}, ${parseInt(value.slice(3, 5), 16)}, ${parseInt(value.slice(5, 7), 16)}, ${alpha})`;
}

export function initProCaptions({ getCaptions, canSend, onStatus }) {
  const $ = id => document.getElementById(id);
  const section = $('pro-captions-section');
  const preview = $('pro-captions-preview');
  const line = $('pro-captions-line');
  const playBtn = $('pro-captions-play');
  const footage = $('pro-captions-footage');
  const progress = $('pro-captions-progress');
  const clock = $('pro-captions-time');
  const sendBtn = $('pro-captions-btn');
  const upgradeBtn = $('pro-captions-upgrade');
  const freeBtn = $('pro-captions-free');
  const status = $('pro-captions-status');
  const inputs = {
    textColor: $('pro-captions-text-color'),
    boxColor: $('pro-captions-box-color'),
    highlightColor: $('pro-captions-highlight-color'),
    strokeColor: $('pro-captions-stroke-color'),
    upcomingOpacity: $('pro-captions-upcoming'),
    boxRadius: $('pro-captions-radius'),
    strokeWidth: $('pro-captions-stroke-width'),
    shadowOpacity: $('pro-captions-shadow'),
    size: $('pro-captions-size'),
  };
  const templateButtons = Array.from($('pro-captions-template').querySelectorAll('.toggle-btn'));
  const positionButtons = Array.from($('pro-captions-position').querySelectorAll('.toggle-btn'));
  let allowed = true;
  let busy = false;

  // Settings per style, remembered on this computer.
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { saved = {}; }
  const settings = {};
  for (const [id, template] of Object.entries(TEMPLATES)) settings[id] = { ...template.defaults, ...(saved.settings?.[id] || {}) };
  let template = TEMPLATES[saved.template] ? saved.template : FREE_TEMPLATE;
  const persist = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ template, settings })); } catch { /* preference only */ } };

  const current = () => settings[template];

  function loadInputs() {
    const s = current();
    for (const [key, input] of Object.entries(inputs)) {
      const value = s[key] ?? TEMPLATES[template].defaults[key];
      if (value !== undefined) input.value = String(value);
    }
    templateButtons.forEach(button => {
      const on = button.dataset.template === template;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    });
    positionButtons.forEach(button => {
      const on = button.dataset.position === s.position;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    });
    section.querySelectorAll('[data-for]').forEach(element => element.classList.toggle('hidden', element.dataset.for !== template));
    preview.dataset.template = template;
    buildLine(sampleAt(time).caption);
  }

  function readInputs() {
    const s = current();
    for (const [key, input] of Object.entries(inputs)) {
      if (TEMPLATES[template].defaults[key] === undefined && key !== 'textColor') continue;
      s[key] = input.type === 'range' ? Number(input.value) : input.value;
    }
  }

  const style = () => {
    const s = current();
    return {
      template,
      textColor: s.textColor,
      size: s.size,
      verticalPosition: TEMPLATES[template].positions[s.position] ?? TEMPLATES[template].positions.bottom,
      shadowOpacity: s.shadowOpacity,
      ...(template === 'box-highlight' ? { boxColor: s.boxColor, upcomingOpacity: s.upcomingOpacity, boxRadius: s.boxRadius } : {}),
      ...(template === 'stroke-highlight' ? { highlightColor: s.highlightColor, strokeColor: s.strokeColor, strokeWidth: s.strokeWidth } : {}),
    };
  };

  function renderLabels() {
    const s = current();
    $('pro-captions-upcoming-value').textContent = `${s.upcomingOpacity ?? 0}%`;
    $('pro-captions-radius-value').textContent = String(s.boxRadius ?? 0);
    $('pro-captions-stroke-width-value').textContent = String(s.strokeWidth ?? 0);
    $('pro-captions-shadow-value').textContent = `${s.shadowOpacity}%`;
    $('pro-captions-size-value').textContent = `${s.size}%`;
  }

  // ---------------------------------------------------------------- preview player
  let time = 0, playing = true, lastFrame = 0, raf = 0, visible = true, shownCaption = null;
  let wordEls = [];

  function sampleAt(t) {
    const caption = SAMPLE.find(c => t >= c.start && t < c.end) || null;
    return { caption, local: caption ? t - caption.start : 0 };
  }

  function buildLine(caption) {
    shownCaption = caption;
    line.textContent = '';
    wordEls = [];
    if (!caption) return;
    caption.words.forEach(([word], i) => {
      if (i) line.append(' ');
      const span = document.createElement('span');
      span.textContent = word;
      line.append(span);
      wordEls.push(span);
    });
  }

  function draw() {
    const t = TEMPLATES[template];
    const s = current();
    const width = preview.clientWidth || 320;
    const scale = width / 1920 * (s.size / 100);
    const { caption, local } = sampleAt(time);
    if (caption !== shownCaption) buildLine(caption);
    preview.style.setProperty('--line-y', `${t.positions[s.position] ?? t.positions.bottom}%`);
    line.style.font = t.font;
    line.style.fontSize = `${parseFloat(t.font.split(' ')[1]) * scale}px`;
    line.style.letterSpacing = `${t.letterSpacing}em`;
    line.style.wordSpacing = `${t.wordSpacing}em`;
    line.style.color = s.textColor;
    const frame = Math.floor(local * FPS + 0.001);

    if (template === 'box-highlight') {
      const k = frame >= POP.length ? 1 : POP[Math.max(0, frame)];
      line.style.opacity = String(k);
      line.style.background = s.boxColor;
      line.style.borderRadius = `${s.boxRadius * scale}px`;
      line.style.padding = `0 ${20 * scale}px`;
      line.style.height = 'auto';
      line.style.lineHeight = `${95 * scale}px`;
      line.style.webkitTextStroke = '';
    } else {
      line.style.opacity = '1';
      line.style.background = 'none';
      line.style.borderRadius = '0';
      line.style.padding = '0';
      line.style.height = 'auto';
      line.style.lineHeight = '1';
    }

    const shadowAlpha = s.shadowOpacity / 100;
    if (!caption) return;
    caption.words.forEach(([, start], i) => {
      const el = wordEls[i];
      if (!el) return;
      const next = caption.words[i + 1]?.[1] ?? (caption.end - caption.start);
      const sinceStart = local * FPS - start * FPS;
      if (template === 'box-highlight') {
        const lit = easeOutCubic(clamp01((sinceStart + 1) / 4));
        const upcoming = s.upcomingOpacity / 100;
        el.style.opacity = String(upcoming + (1 - upcoming) * lit);
        el.style.transform = '';
        el.style.textShadow = lit > 0 && shadowAlpha > 0 ? `${2.5 * scale}px ${3 * scale}px ${1 * scale}px ${hexToRgba('#000000', shadowAlpha * lit)}` : 'none';
        el.style.color = '';
      } else if (template === 'stroke-highlight') {
        const on = local >= start && local < next;
        el.style.opacity = '1';
        el.style.transform = '';
        el.style.color = on ? s.highlightColor : s.textColor;
        // Centred stroke under the fill (paint-order in CSS), like the template's "fill over stroke".
        el.style.webkitTextStroke = s.strokeWidth > 0 ? `${s.strokeWidth * scale}px ${s.strokeColor}` : '';
        el.style.textShadow = shadowAlpha > 0 ? `0 ${3 * scale}px ${6 * scale}px ${hexToRgba('#000000', shadowAlpha)}` : 'none';
      } else {
        const shown = easeOutQuart(clamp01(sinceStart / t.frames));
        el.style.opacity = String(shown);
        el.style.transform = `translate(${(1 - shown) * t.from[0] * scale}px, ${(1 - shown) * t.from[1] * scale}px)`;
        el.style.textShadow = shadowAlpha > 0 ? `0 ${3 * scale}px ${10 * scale}px ${hexToRgba('#000000', shadowAlpha)}` : 'none';
        el.style.color = '';
        el.style.webkitTextStroke = '';
      }
    });
  }

  function tick(now) {
    raf = 0;
    if (playing && visible) {
      if (footageReady && !footage.paused) {
        time = footage.currentTime % LOOP;
      } else {
        const delta = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
        time = (time + delta) % LOOP;
      }
    }
    lastFrame = now;
    progress.style.width = `${(time / LOOP) * 100}%`;
    clock.textContent = `0:0${Math.floor(time)}`;
    draw();
    if (playing && visible) raf = requestAnimationFrame(tick);
  }
  // The footage is decoration: if it cannot load or play, the clock runs on its own.
  let footageReady = false;
  footage?.addEventListener('loadeddata', () => { footageReady = true; footage.currentTime = time; syncFootage(); });
  footage?.addEventListener('error', () => { footageReady = false; footage.hidden = true; });
  function syncFootage() {
    if (!footage || !footageReady) return;
    // An interrupted play() (a quick pause or seek) is harmless; only a refused one stops the footage.
    if (playing && visible) footage.play().catch(error => { if (error?.name !== 'AbortError') footageReady = false; });
    else footage.pause();
  }
  function seek(seconds) {
    time = seconds;
    if (footage && footageReady) footage.currentTime = seconds;
  }
  const kick = () => { syncFootage(); if (!raf) { lastFrame = 0; raf = requestAnimationFrame(tick); } };

  function setPlaying(next) {
    playing = next;
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
    playBtn.classList.toggle('is-paused', !playing);
    kick();
  }
  playBtn.addEventListener('click', () => setPlaying(!playing));
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting) && !document.hidden; kick(); }).observe(preview);
  }
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; kick(); });
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { seek(1.9); setPlaying(false); }

  // ---------------------------------------------------------------- send
  // The free look: the Outline style with its default look (position on screen is free).
  function isFreeLook() {
    if (template !== FREE_TEMPLATE) return false;
    const s = settings[FREE_TEMPLATE], d = TEMPLATES[FREE_TEMPLATE].defaults;
    return Object.keys(d).every(key => key === 'position' || String(s[key]).toLowerCase() === String(d[key]).toLowerCase());
  }

  function refresh() {
    const hasCaptions = (getCaptions() || []).length > 0;
    const free = isFreeLook();
    const sendable = allowed || free;
    sendBtn.disabled = busy || !sendable || !hasCaptions || !canSend();
    upgradeBtn.classList.toggle('hidden', allowed);
    freeBtn.classList.toggle('hidden', allowed || free);
    templateButtons.forEach(button => button.classList.toggle('is-locked', !allowed && button.dataset.template !== FREE_TEMPLATE));
    section.classList.toggle('is-free-user', !allowed);
    $('pro-captions-custom-hint').classList.toggle('hidden', allowed);
    if (!busy && !status.dataset.result) {
      status.textContent = !sendable
        ? (template !== FREE_TEMPLATE
          ? `${NAMES[template]} is part of Smoothy Pro. Outline is free in its default look.`
          : 'Your own colours, outline, shadow and size are part of Smoothy Pro. Use the free Outline look to send for free.')
        : !hasCaptions ? 'Generate captions first.'
        : !canSend() ? 'Connect Premiere Pro and open a sequence.'
        : !allowed ? 'Outline is free. Other styles and your own look come with Smoothy Pro.'
        : 'Shows one line per caption. Set Max lines to 1 for the best fit.';
    }
  }

  async function refreshAccess() {
    try { allowed = (await window.electronAPI.canUseFeature('pro_captions')).allowed !== false; }
    catch { allowed = true; /* the main process still enforces Pro */ }
    refresh();
  }

  async function send() {
    const captions = getCaptions() || [];
    if (!captions.length) return;
    busy = true; delete status.dataset.result;
    status.textContent = `Placing ${captions.length} animated captions in Premiere…`;
    onStatus?.('Placing animated captions…', 'processing');
    refresh();
    try {
      const result = await window.electronAPI.importProCaptionsToPremiere(captions, style());
      if (result?.requiresPro) { allowed = false; }
      status.textContent = result?.success ? result.message : (result?.error || 'Could not place animated captions.');
      status.dataset.result = result?.success ? 'success' : 'error';
      onStatus?.(result?.success ? 'Animated captions placed' : 'Animated captions failed', result?.success ? 'success' : 'error');
    } catch (error) {
      status.textContent = error?.message || 'Could not place animated captions.';
      status.dataset.result = 'error';
      onStatus?.('Animated captions failed', 'error');
    } finally {
      busy = false;
      refresh();
    }
  }

  const changed = () => { delete status.dataset.result; renderLabels(); persist(); draw(); refresh(); };
  Object.values(inputs).forEach(input => input.addEventListener('input', () => { readInputs(); changed(); }));
  templateButtons.forEach(button => button.addEventListener('click', () => {
    template = button.dataset.template;
    seek(0);
    loadInputs();
    changed();
    kick();
  }));
  positionButtons.forEach(button => button.addEventListener('click', () => {
    current().position = button.dataset.position;
    positionButtons.forEach(other => { other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button)); });
    changed();
  }));
  sendBtn.addEventListener('click', send);
  freeBtn.addEventListener('click', () => {
    settings[FREE_TEMPLATE] = {
      ...TEMPLATES[FREE_TEMPLATE].defaults,
      position: settings[FREE_TEMPLATE]?.position ?? TEMPLATES[FREE_TEMPLATE].defaults.position,
    };
    template = FREE_TEMPLATE;
    seek(0);
    loadInputs();
    changed();
    kick();
  });
  upgradeBtn.addEventListener('click', () => {
    void window.electronAPI.proUpgradeClick('pro_captions');
    void window.electronAPI.openProCheckout();
  });
  window.electronAPI.onAuthStateChange?.(() => { void refreshAccess(); });
  loadInputs();
  renderLabels();
  kick();
  void refreshAccess();
  return { refresh, section };
}
