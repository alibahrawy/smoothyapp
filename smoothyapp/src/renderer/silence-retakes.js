// Smoothy Pro repeated-takes removal inside the Silence Removal tab.
// Uses the existing local Whisper transcription engine + deterministic matching;
// the main process enforces Pro before running.

const SENSITIVITY_HINTS = {
  conservative: 'Strict matching — only cuts near-identical repeated sentences and clear false starts.',
  balanced: 'Catches repeated sentences and stumbled restarts while leaving normal speech untouched.',
  aggressive: 'Cuts shorter false starts and looser rephrased retakes.',
};

function formatTimecode(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(s / 60);
  const secs = (s % 60).toFixed(1).padStart(4, '0');
  return `${mins}:${secs}`;
}

function formatShortDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return `${mins}m ${secs}s`;
}

export function initSilenceRetakes({ onToggleChange, openSettings, signIn } = {}) {
  const $ = id => document.getElementById(id);
  const checkbox = $('remove-retakes');
  const optionsBox = $('retakes-options');
  const sensitivitySelect = $('retake-sensitivity');
  const sensitivityHint = $('retake-sensitivity-hint');
  const modelNote = $('retakes-model-note');
  const openSettingsBtn = $('retakes-open-captions-settings');
  const proNotice = $('retakes-pro-notice');
  const proNote = $('retakes-pro-note');
  const upgradeBtn = $('retakes-upgrade-btn');
  const signinBtn = $('retakes-signin-btn');

  const statItem = $('stat-retakes-item');
  const statValue = $('stat-retakes-removed');
  const listWrap = $('silence-retakes-list-wrap');
  const listCount = $('silence-retakes-list-count');
  const listEl = $('silence-retakes-list');

  let allowed = true;
  let signedOut = false;

  function updateSensitivityHint() {
    if (!sensitivityHint || !sensitivitySelect) return;
    sensitivityHint.textContent = SENSITIVITY_HINTS[sensitivitySelect.value] || SENSITIVITY_HINTS.balanced;
  }

  function refreshUI() {
    if (!checkbox) return;
    checkbox.disabled = !allowed;
    if (!allowed && checkbox.checked) checkbox.checked = false;
    optionsBox?.classList.toggle('hidden', !allowed || !checkbox.checked);
    proNotice?.classList.toggle('hidden', allowed);
    if (proNote) {
      proNote.textContent = signedOut
        ? 'Part of Smoothy Pro. Sign in to unlock if you are subscribed.'
        : 'Part of Smoothy Pro. Subscribed? It unlocks with the same account.';
    }
    signinBtn?.classList.toggle('hidden', !signedOut);
    updateSensitivityHint();
    onToggleChange?.(isEnabled());
  }

  async function refreshModelInfo() {
    if (!modelNote) return;
    try {
      const [models, selectedId, langCode] = await Promise.all([
        window.electronAPI.getCaptionModels?.(),
        window.electronAPI.getSelectedCaptionModel?.(),
        window.electronAPI.getCaptionLanguage?.(),
      ]);
      const model = Array.isArray(models) ? models.find(m => m.id === selectedId) : null;
      const modelName = model?.name || selectedId || 'Default Whisper model';
      const langLabel = !langCode || langCode === 'auto' ? 'Auto language' : String(langCode).toUpperCase();
      modelNote.textContent = `Local model: ${modelName} · ${langLabel}`;
    } catch {
      modelNote.textContent = 'Uses your local Whisper model from Captions settings.';
    }
  }

  async function refreshAccess() {
    try {
      const access = await window.electronAPI.canUseFeature('silence_retakes');
      allowed = access?.allowed !== false;
      signedOut = access?.reason === 'login-required';
    } catch {
      allowed = true;
      signedOut = false;
    }
    refreshUI();
    if (allowed) void refreshModelInfo();
  }

  function isEnabled() {
    return Boolean(allowed && checkbox?.checked);
  }

  function getSensitivity() {
    const value = sensitivitySelect?.value;
    return value === 'conservative' || value === 'aggressive' ? value : 'balanced';
  }

  function handleProDenied() {
    allowed = false;
    refreshUI();
  }

  function clearResults() {
    statItem?.classList.add('hidden');
    listWrap?.classList.add('hidden');
    if (listEl) listEl.replaceChildren();
    if (listCount) listCount.textContent = '';
  }

  function renderResults(stats) {
    if (!stats?.retakesEnabled) {
      clearResults();
      return;
    }
    const items = Array.isArray(stats.removedRetakes) ? stats.removedRetakes : [];
    const count = Number(stats.retakesCount || items.length || 0);
    const removedSec = Number(stats.retakesRemoved || 0);

    if (statItem && statValue) {
      statItem.classList.remove('hidden');
      statValue.textContent = count > 0
        ? `${count} (${formatShortDuration(removedSec)})`
        : '0';
    }

    if (!listWrap || !listEl) return;
    listWrap.classList.remove('hidden');
    listEl.replaceChildren();
    if (listCount) {
      listCount.textContent = count === 0
        ? 'No repeated takes found'
        : `${count} repeated ${count === 1 ? 'take' : 'takes'} cut · ${formatShortDuration(removedSec)} saved`;
    }

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'help-text retakes-empty';
      empty.textContent = 'No repeated sentences or false starts were detected in this sequence.';
      listEl.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'retake-item';

      const head = document.createElement('div');
      head.className = 'retake-item-head';

      const time = document.createElement('span');
      time.className = 'retake-time';
      time.textContent = `${formatTimecode(item.start)} – ${formatTimecode(item.end)}`;

      const tag = document.createElement('span');
      tag.className = `retake-badge retake-badge-${item.reason === 'false-start' ? 'false-start' : 'repeat'}`;
      tag.textContent = item.reason === 'false-start' ? 'False start' : 'Repeat';

      head.append(time, tag);

      const cutText = document.createElement('p');
      cutText.className = 'retake-removed-text';
      cutText.textContent = item.text || '(repeated phrase)';

      row.append(head, cutText);

      if (item.matchedText) {
        const keptText = document.createElement('p');
        keptText.className = 'retake-kept-text';
        keptText.textContent = `Kept: ${item.matchedText}`;
        row.appendChild(keptText);
      }

      listEl.appendChild(row);
    }
  }

  checkbox?.addEventListener('change', () => {
    refreshUI();
    if (isEnabled()) void refreshModelInfo();
  });

  sensitivitySelect?.addEventListener('change', updateSensitivityHint);

  openSettingsBtn?.addEventListener('click', () => {
    if (openSettings) {
      openSettings('captions');
    } else {
      document.getElementById('settings-btn')?.click();
      setTimeout(() => document.querySelector('[data-settings-pane="captions"]')?.click(), 50);
    }
  });

  upgradeBtn?.addEventListener('click', () => {
    void window.electronAPI.proUpgradeClick('silence_retakes');
    void window.electronAPI.openProCheckout();
  });

  signinBtn?.addEventListener('click', () => {
    if (signIn) {
      signIn();
    } else if (openSettings) {
      openSettings('profile');
    } else {
      document.getElementById('settings-btn')?.click();
      setTimeout(() => document.querySelector('[data-settings-pane="profile"]')?.click(), 50);
    }
  });

  window.electronAPI.onAuthStateChange?.(() => { void refreshAccess(); });
  document.querySelector('.nav-item[data-tab="silence"]')?.addEventListener('click', () => {
    void refreshAccess();
  });

  void refreshAccess();

  return {
    isEnabled,
    getSensitivity,
    refreshAccess,
    handleProDenied,
    renderResults,
    clearResults,
  };
}
