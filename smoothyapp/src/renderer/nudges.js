// Smoothy Pro and social reminders. The main process decides when one is due
// (src/main/nudges.ts); this file waits for an idle moment, shows it and reports
// what the user picked. Pro is a centred dialog; social is a corner card that
// never blocks the app.
const SOCIAL = {
  discord: { url: 'https://discord.gg/KmJRqUZzDe', label: 'Discord' },
  x: { url: 'https://x.com/smoothyedit', label: 'X' },
  instagram: { url: 'https://www.instagram.com/smoothyedit/', label: 'Instagram' },
  threads: { url: 'https://www.threads.com/@smoothyedit', label: 'Threads' },
  linkedin: { url: 'https://www.linkedin.com/company/140813934/', label: 'LinkedIn' },
};
const SOCIAL_TINT = { x: 'var(--ink-tint)', instagram: 'var(--rose-tint)', threads: 'var(--grape-tint)', linkedin: 'var(--sky-tint)' };
// Keep in step with web/src/pages/pricing.astro and web/src/lib/plans.ts.
const PRO_PERKS = [
  { tint: 'var(--mango-tint)', title: 'Unlimited ShortsCuts keys', text: 'Free decks have 6.', icon: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>' },
  { tint: 'var(--ink-tint)', title: 'The Agent Bridge', text: 'Claude Code or Codex edits for you. You review.', icon: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13v2M15 13v2"/>' },
  { tint: 'var(--rose-tint)', title: 'Animated captions and repeated takes', text: 'Pro captions in Premiere, and cut the takes you redid.', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M14 15h3M7 11h10"/>' },
  { tint: 'var(--lime-tint)', title: '2,000 AI credits every 30 days', text: 'Free accounts get 100.', icon: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/><path d="M19 15v4M17 17h4"/>' },
  { tint: 'var(--grape-tint)', title: 'The full Studio', text: 'Thumbnails, B-roll, SFX, social posts and blog drafts.', icon: '<path d="m15 4 5 5L9 20H4v-5L15 4Z"/><path d="m13 6 5 5"/>' },
];
const WAIT_BEFORE_MS = 1200; // let the finished result land first
const QUIET_INPUT_MS = 2500; // never pop up under a click or keystroke
const GIVE_UP_MS = 15 * 60 * 1000;
const BUSY_IDS = ['compressor-progress-section', 'local-audio-progress', 'assets-process-progress'];

let lastInput = 0;
let waiting = null;
const openNudges = { pro: null, social: null }; // hide() of each reminder on screen

const visible = el => !!el && !el.hidden && !el.classList.contains('hidden') && el.getClientRects().length > 0;

function busy() {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return true;
  if (Date.now() - lastInput < QUIET_INPUT_MS) return true;
  if ([...document.querySelectorAll('.overlay')].some(visible)) return true;
  if (visible(document.getElementById('nudge-social'))) return true;
  if (document.querySelector('[aria-busy="true"]')) return true;
  return BUSY_IDS.some(id => visible(document.getElementById(id)));
}

function svg(paths, { fill = false } = {}) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** Reuse the brand marks already in Settings → Community instead of duplicating them. */
function socialIcon(key) {
  const source = document.querySelector(`.cs-social[data-open-url="${SOCIAL[key].url}"] .cs-social-icon svg`);
  if (source) return source.cloneNode(true);
  const letter = document.createElement('span');
  letter.textContent = SOCIAL[key].label[0];
  return letter;
}

function buildPro() {
  const root = document.createElement('div');
  root.id = 'nudge-pro';
  root.className = 'overlay nudge-overlay hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'nudge-pro-title');
  root.innerHTML = `
    <div class="modal-content nudge-pro-card">
      <span class="pro-badge pro-badge-large">Pro</span>
      <h3 id="nudge-pro-title">Nice edit. Want more?</h3>
      <p class="nudge-sub" id="nudge-pro-sub"></p>
      <ul class="nudge-perks">${PRO_PERKS.map(p => `
        <li><span class="nudge-tile" style="--tile:${p.tint}">${svg(p.icon)}</span>
          <span class="nudge-perk-text"><strong>${p.title}</strong><small>${p.text}</small></span></li>`).join('')}
      </ul>
      <p class="nudge-fine" id="nudge-pro-fine"></p>
      <div class="nudge-actions">
        <button type="button" class="btn btn-secondary" data-nudge="skip">Skip for now</button>
        <button type="button" class="btn btn-pro" data-nudge="upgrade">Upgrade to Pro</button>
      </div>
    </div>`;
  document.body.append(root);
  return root;
}

function buildSocial() {
  const root = document.createElement('aside');
  root.id = 'nudge-social';
  root.className = 'nudge-social hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-labelledby', 'nudge-social-title');
  root.innerHTML = `
    <button type="button" class="nudge-close" data-nudge="skip" aria-label="Not now">${svg('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    <h3 id="nudge-social-title">Join the Smoothy community</h3>
    <p class="nudge-sub">Suggest features, report bugs, get editing tips and see new tools first. Plus other editors to swap notes with.</p>
    <button type="button" class="nudge-discord" data-nudge="discord"><span class="nudge-discord-icon"></span><span>Join the Discord</span></button>
    <div class="nudge-social-row">${['x', 'instagram', 'threads', 'linkedin'].map(key => `
      <button type="button" class="nudge-social-btn" data-nudge="${key}" style="--tile:${SOCIAL_TINT[key]}" aria-label="Follow Smoothy on ${SOCIAL[key].label}" title="${SOCIAL[key].label}"><span class="nudge-tile"></span><span>${SOCIAL[key].label}</span></button>`).join('')}
    </div>
    <div class="nudge-foot">
      <button type="button" class="nudge-link" data-nudge="already">I already follow</button>
      <button type="button" class="nudge-link" data-nudge="skip">Not now</button>
    </div>`;
  root.querySelector('.nudge-discord-icon').append(socialIcon('discord'));
  root.querySelectorAll('.nudge-social-btn').forEach(button => button.querySelector('.nudge-tile').append(socialIcon(button.dataset.nudge)));
  document.body.append(root);
  return root;
}

// Keep in step with FOUNDER_MEMBER_LIMIT / FOUNDER_SHOW_LEFT_AT in web/src/lib/plans.ts.
const FOUNDER = { price: 5, later: 8, limit: 50, showLeftAt: 20 };

/** Founder wording; the live offer (spots left, or the later price) refines it when available. */
function renderPrice(el, offer) {
  el.replaceChildren();
  const strong = document.createElement('strong');
  if (offer && offer.open === false) {
    strong.textContent = `$${offer.price || FOUNDER.price} a month.`;
    el.append(strong, ' Cancel anytime; every free tool stays free.');
    return;
  }
  const limit = offer?.limit || FOUNDER.limit;
  strong.textContent = `Founder price: $${FOUNDER.price} a month`;
  const left = offer?.left;
  const spots = left > 0 && left <= FOUNDER.showLeftAt ? ` Only ${left} founder ${left === 1 ? 'spot' : 'spots'} left.` : '';
  el.append(strong, ` for the first ${limit} members, locked in for as long as you stay subscribed. After that it’s $${FOUNDER.later}.${spots} Cancel anytime; every free tool stays free.`);
}

function showPro(payload) {
  const root = document.getElementById('nudge-pro') || buildPro();
  const fine = root.querySelector('#nudge-pro-fine');
  renderPrice(fine, null);
  void window.electronAPI.proFounderOffer?.().then(offer => { if (offer) renderPrice(fine, offer); }).catch(() => {});
  const returnFocus = document.activeElement;
  const runs = Number(payload.runs) || 0;
  root.querySelector('#nudge-pro-sub').textContent = runs > 0
    ? `You’ve finished ${runs} ${runs === 1 ? 'edit' : 'edits'} with SmoothyApp. Smoothy Pro adds:`
    : 'Smoothy Pro adds:';
  const buttons = [...root.querySelectorAll('[data-nudge]')];
  const hide = () => {
    if (root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('click', onClick);
    openNudges.pro = null;
    payload.onClose?.();
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
  };
  const close = action => {
    hide();
    void window.electronAPI.nudgeAction('pro', action, payload.preview === true);
    if (action === 'upgrade') void window.electronAPI.openProCheckout();
  };
  const onClick = event => {
    const action = event.target.closest('[data-nudge]')?.dataset.nudge;
    if (action) close(action);
    else if (event.target === root) close('skip');
  };
  const onKey = event => {
    if (root.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close('skip'); }
    else if (event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation();
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
  };
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  root.classList.remove('hidden');
  openNudges.pro = hide;
  root.querySelector('[data-nudge="upgrade"]').focus();
}

function showSocial(payload) {
  const root = document.getElementById('nudge-social') || buildSocial();
  const hide = () => {
    if (root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
    openNudges.social = null;
    payload.onClose?.();
  };
  const close = action => {
    hide();
    void window.electronAPI.nudgeAction('social', action, payload.preview === true);
    if (SOCIAL[action]) void window.electronAPI.openExternal(SOCIAL[action].url);
  };
  const onClick = event => {
    const action = event.target.closest('[data-nudge]')?.dataset.nudge;
    if (action) close(action);
  };
  const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); close('skip'); } };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  // A corner card: it does not take focus or block the app.
  root.classList.remove('hidden');
  openNudges.social = hide;
}

async function present(payload) {
  if (payload.kind === 'pro') {
    // A sign-in or upgrade since the main process checked: Pro members never see it.
    try { if ((await window.electronAPI.canUseFeature('agent'))?.allowed) { void window.electronAPI.nudgeDropped('pro'); return; } } catch { /* show it */ }
    showPro(payload);
  } else showSocial(payload);
  void window.electronAPI.nudgeShown(payload.kind, payload.preview === true);
}

function queue(payload) {
  if (!payload || (payload.kind !== 'pro' && payload.kind !== 'social')) return;
  if (waiting) return;
  const started = Date.now();
  const tick = () => {
    if (Date.now() - started > GIVE_UP_MS) { waiting = null; void window.electronAPI.nudgeDropped(payload.kind); return; }
    if (Date.now() - started < WAIT_BEFORE_MS || busy()) { waiting = setTimeout(tick, 1000); return; }
    waiting = null;
    void present(payload);
  };
  waiting = setTimeout(tick, WAIT_BEFORE_MS);
}

/**
 * Dev tab → Reminder preview. Shows a reminder right away (no idle wait, shown to
 * Pro members too). Its buttons behave for real, but a preview is never counted
 * and never changes the schedule.
 */
function initDevPreview() {
  const toggles = { pro: document.getElementById('dev-nudge-pro-toggle'), social: document.getElementById('dev-nudge-social-toggle') };
  const status = document.getElementById('dev-nudge-status');
  if (!toggles.pro || !toggles.social) return;
  const refresh = async () => {
    try {
      const s = await window.electronAPI.nudgeStatus();
      const hours = Math.ceil(s.cooldownMs / 3600000);
      const social = s.social.done ? 'stopped (followed)' : `at ${s.social.nextAt}${s.social.notBefore > Date.now() ? `, after ${new Date(s.social.notBefore).toLocaleDateString()}` : ''}`;
      status.textContent = `${s.runs} finished ${s.runs === 1 ? 'tool' : 'tools'} · Pro ${s.isPro ? 'off (Pro member)' : `at ${s.pro.nextAt}`} · Social ${social} · ${s.shownThisLaunch ? 'Already shown this launch' : s.cooldownMs > 0 ? `Next reminder in ${hours} h at the earliest` : 'A reminder can show now'}`;
    } catch { status.textContent = ''; }
  };
  for (const kind of ['pro', 'social']) {
    toggles[kind].addEventListener('change', () => {
      if (!toggles[kind].checked) { openNudges[kind]?.(); return; }
      if (openNudges[kind]) return; // already on screen
      const payload = { kind, runs: 0, preview: true, onClose: () => { toggles[kind].checked = false; void refresh(); } };
      if (kind === 'pro') showPro(payload); else showSocial(payload);
    });
  }
  document.querySelector('.nav-item[data-tab="logs"]')?.addEventListener('click', () => void refresh());
  window.addEventListener('focus', () => void refresh());
  void refresh();
}

/** Shown once checkout succeeds and the app has confirmed the new plan. */
function showProWelcome() {
  let toast = document.getElementById('pro-welcome');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'pro-welcome';
    toast.className = 'pro-welcome hidden';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `<span class="pro-badge">Pro</span><span><strong>You’re on Smoothy Pro.</strong> Everything is unlocked. Thanks for backing Smoothy early.</span>`;
    document.body.append(toast);
  }
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 7000);
}

function init() {
  const noteInput = () => { lastInput = Date.now(); };
  ['pointerdown', 'keydown', 'wheel'].forEach(type => document.addEventListener(type, noteInput, { capture: true, passive: true }));
  window.electronAPI.onNudge?.(queue);
  initDevPreview();
  window.electronAPI.onProCheckoutComplete?.(showProWelcome);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
