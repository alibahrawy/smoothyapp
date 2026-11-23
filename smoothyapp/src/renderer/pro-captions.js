// Smoothy Pro animated captions (Premiere only). Sends the generated captions
// with the chosen template and style; the main process enforces Pro and places
// one Motion Graphics Template clip per caption on a new top video track.

// One style for now: Box Highlight (docs/caption-pro/box-highlight). More styles
// become more templates; the main process picks the defaults per template.
const TEMPLATE = 'box-highlight';

export function initProCaptions({ getCaptions, canSend, onStatus }) {
  const $ = id => document.getElementById(id);
  const section = $('pro-captions-section');
  const preview = $('pro-captions-preview');
  const sendBtn = $('pro-captions-btn');
  const upgradeBtn = $('pro-captions-upgrade');
  const status = $('pro-captions-status');
  const inputs = {
    textColor: $('pro-captions-text-color'),
    boxColor: $('pro-captions-box-color'),
    upcomingOpacity: $('pro-captions-upcoming'),
    boxRadius: $('pro-captions-radius'),
    shadowOpacity: $('pro-captions-shadow'),
    size: $('pro-captions-size'),
  };
  // Height on screen: Bottom (93.1%), Lower (halfway to the centre) or Centre (50%).
  const positionButtons = Array.from($('pro-captions-position').querySelectorAll('.toggle-btn'));
  const verticalPosition = () => Number((positionButtons.find(button => button.classList.contains('active')) || positionButtons[0]).dataset.value);
  let allowed = true;
  let busy = false;

  const style = () => ({
    template: TEMPLATE,
    textColor: inputs.textColor.value,
    boxColor: inputs.boxColor.value,
    upcomingOpacity: Number(inputs.upcomingOpacity.value),
    boxRadius: Number(inputs.boxRadius.value),
    shadowOpacity: Number(inputs.shadowOpacity.value),
    size: Number(inputs.size.value),
    verticalPosition: verticalPosition(),
  });

  function renderStyle() {
    const s = style();
    $('pro-captions-upcoming-value').textContent = `${s.upcomingOpacity}%`;
    $('pro-captions-radius-value').textContent = String(s.boxRadius);
    $('pro-captions-shadow-value').textContent = `${s.shadowOpacity}%`;
    $('pro-captions-size-value').textContent = `${s.size}%`;
    preview.style.setProperty('--pro-caption-text', s.textColor);
    preview.style.setProperty('--pro-caption-box', s.boxColor);
    preview.style.setProperty('--pro-caption-upcoming', String(s.upcomingOpacity / 100));
    preview.style.setProperty('--pro-caption-radius', `${s.boxRadius / 2}px`);
    preview.style.setProperty('--pro-caption-shadow', String(s.shadowOpacity / 100));
  }

  function refresh() {
    const hasCaptions = (getCaptions() || []).length > 0;
    sendBtn.disabled = busy || !allowed || !hasCaptions || !canSend();
    upgradeBtn.classList.toggle('hidden', allowed);
    if (!busy && !status.dataset.result) {
      status.textContent = !allowed ? 'Part of Smoothy Pro. Subscribed? Sign in with the same account.'
        : !hasCaptions ? 'Generate captions first.'
        : !canSend() ? 'Connect Premiere Pro and open a sequence.'
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

  Object.values(inputs).forEach(input => input.addEventListener('input', () => { delete status.dataset.result; renderStyle(); }));
  positionButtons.forEach(button => button.addEventListener('click', () => {
    positionButtons.forEach(other => { other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button)); });
    delete status.dataset.result;
  }));
  sendBtn.addEventListener('click', send);
  upgradeBtn.addEventListener('click', () => {
    void window.electronAPI.proUpgradeClick('pro_captions');
    void window.electronAPI.openProCheckout();
  });
  window.electronAPI.onAuthStateChange?.(() => { void refreshAccess(); });
  renderStyle();
  void refreshAccess();
  return { refresh, section };
}
