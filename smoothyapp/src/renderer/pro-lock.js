// Smoothy Pro lock screen for the Agent (ShortsCuts is free for 6 keys; see shortscuts.js). The real gate lives in
// the main process; this only explains it and hides controls that cannot work.
const FEATURES = [
  {
    id: 'agent',
    tab: 'tab-agentic',
    title: 'The Agent Bridge is part of Smoothy Pro',
    body: 'Let Claude Code or Codex edit for you. You review and leave notes.',
  },
];
const PRICING_URL = 'https://smoothyedit.com/pricing';

function badge() {
  const span = document.createElement('span');
  span.className = 'pro-badge';
  span.textContent = 'Pro';
  return span;
}

function buildCard(feature) {
  const card = document.createElement('section');
  card.className = 'pro-lock hidden';
  card.dataset.proLock = feature.id;
  card.innerHTML = `
    <div class="pro-lock-card">
      <span class="pro-badge pro-badge-large">Pro</span>
      <h2></h2>
      <p class="pro-lock-body"></p>
      <p class="pro-lock-note"></p>
      <div class="pro-lock-actions">
        <button type="button" class="btn btn-primary" data-pro-action="upgrade">Upgrade to Pro</button>
        <button type="button" class="btn btn-secondary hidden" data-pro-action="signin">Sign in</button>
      </div>
    </div>`;
  card.querySelector('h2').textContent = feature.title;
  card.querySelector('.pro-lock-body').textContent = feature.body;
  card.querySelector('[data-pro-action="upgrade"]').addEventListener('click', () => {
    void window.electronAPI.proUpgradeClick(feature.id);
    void window.electronAPI.openExternal(PRICING_URL);
  });
  card.querySelector('[data-pro-action="signin"]').addEventListener('click', () => {
    document.getElementById('settings-btn')?.click();
    setTimeout(() => document.querySelector('[data-settings-pane="profile"]')?.click(), 50);
  });
  return card;
}

async function refresh(entries) {
  for (const { feature, tab, card } of entries) {
    let access = { allowed: true };
    try { access = await window.electronAPI.canUseFeature(feature.id); } catch { /* keep the tab usable if the check fails; the main process still enforces */ }
    const locked = access.allowed === false;
    tab.classList.toggle('pro-locked', locked);
    card.classList.toggle('hidden', !locked);
    const signedOut = access.reason === 'login-required';
    card.querySelector('[data-pro-action="signin"]').classList.toggle('hidden', !signedOut);
    card.querySelector('.pro-lock-note').textContent = signedOut
      ? 'Sign in to unlock if you are subscribed.'
      : 'Subscribed? It unlocks with the same account.';
  }
}

function init() {
  const entries = [];
  for (const feature of FEATURES) {
    const tab = document.getElementById(feature.tab);
    if (!tab) continue;
    const card = buildCard(feature);
    tab.prepend(card);
    entries.push({ feature, tab, card });
    document.querySelector(`.nav-item[data-tab="${feature.id === 'agent' ? 'agentic' : feature.id}"] .nav-label`)?.after(badge());
  }
  const run = () => void refresh(entries);
  run();
  window.electronAPI.onAuthStateChange?.(run);
  document.querySelectorAll('.nav-item[data-tab]').forEach((item) => item.addEventListener('click', run));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
