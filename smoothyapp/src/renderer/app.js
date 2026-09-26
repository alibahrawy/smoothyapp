/**
 * SmoothyEdit - Renderer Script
 */

const state = {
  isConnected: false,
  sequenceInfo: null,
  isProcessing: false,
  currentTab: 'multicam',
  isWebsiteConnected: false,
  isExporting: false,
  authState: null,
  trialStatus: null,
  currentTheme: 'cream',
  platform: 'unknown',
  captionResult: null,
  activeNLE: null,
  pendingUpdateNotes: null,
  updateModalOpen: false
};

// DOM Elements
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const sequenceName = document.getElementById('sequence-name');
const sequenceDetails = document.getElementById('sequence-details');
const audioTracksList = document.getElementById('audio-tracks-list');
const videoTracksList = document.getElementById('video-tracks-list');
const autoCutBtn = document.getElementById('autocut-btn');
const footerStatus = document.getElementById('footer-status');
const refreshBtn = document.getElementById('refresh-btn');
const connectionStatus = document.getElementById('connection-status');

// Silence Removal DOM Elements
const silenceStatusBar = document.getElementById('silence-status-bar');
const silenceStatusText = document.getElementById('silence-status-text');
const silenceSequenceName = document.getElementById('silence-sequence-name');
const silenceSequenceDetails = document.getElementById('silence-sequence-details');
const silenceAudioTracksList = document.getElementById('silence-audio-tracks-list');
const silenceRemoveBtn = document.getElementById('silence-remove-btn');
const silenceFooterStatus = document.getElementById('silence-footer-status');
const silenceRefreshBtn = document.getElementById('silence-refresh-btn');

// Captions DOM Elements
const captionsStatusBar = document.getElementById('captions-status-bar');
const captionsStatusText = document.getElementById('captions-status-text');
const captionsSequenceName = document.getElementById('captions-sequence-name');
const captionsSequenceDetails = document.getElementById('captions-sequence-details');
const captionsRefreshBtn = document.getElementById('captions-refresh-btn');
const generateCaptionsBtn = document.getElementById('generate-captions-btn');
const saveCaptionsBtn = document.getElementById('save-captions-btn');
const importCaptionsBtn = document.getElementById('import-captions-btn');
const captionsFooterStatus = document.getElementById('captions-footer-status');
const captionsAudioTracksList = document.getElementById('captions-audio-tracks-list');
const captionModelProgress = document.getElementById('caption-model-progress');
const captionModelProgressFill = document.getElementById('caption-model-progress-fill');
const captionModelProgressText = document.getElementById('caption-model-progress-text');
const captionsPreviewSection = document.getElementById('captions-preview-section');
const captionsPreview = document.getElementById('captions-preview');
const captionsCount = document.getElementById('captions-count');

// Best Shorts DOM Elements
const bestshortsStatusBar = document.getElementById('bestshorts-status-bar');
const bestshortsStatusText = document.getElementById('bestshorts-status-text');
const bestshortsSequenceName = document.getElementById('bestshorts-sequence-name');
const bestshortsSequenceDetails = document.getElementById('bestshorts-sequence-details');
const bestshortsRefreshBtn = document.getElementById('bestshorts-refresh-btn');
const exportAudioBtn = document.getElementById('export-audio-btn');
const clearMarkersBtn = document.getElementById('clear-markers-btn');
const bestshortsFooterStatus = document.getElementById('bestshorts-footer-status');
const websiteStatusDot = document.getElementById('website-status-dot');
const websiteStatusText = document.getElementById('website-status-text');
const websiteHelpText = document.getElementById('website-help-text');

// Settings DOM Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const connectionTokenInput = document.getElementById('connection-token');
const saveTokenBtn = document.getElementById('save-token-btn');
const connectWebsiteBtn = document.getElementById('connect-website-btn');
const settingsConnectionDot = document.getElementById('settings-connection-dot');
const settingsConnectionStatus = document.getElementById('settings-connection-status');
const getTokenLink = document.getElementById('get-token-link');

// Bridge Settings DOM Elements
const bridgeStatusDot = document.getElementById('bridge-status-dot');
const bridgeStatusText = document.getElementById('bridge-status-text');
const uxpPackageInput = document.getElementById('uxp-package-input');
const uxpInstallBtn = document.getElementById('uxp-install-btn');
const cepPathInput = document.getElementById('cep-path-input');
const cepBrowseBtn = document.getElementById('cep-browse-btn');
const cepResetBtn = document.getElementById('cep-reset-btn');
const cepInstallBtn = document.getElementById('cep-install-btn');

// Resolve Bridge Settings DOM Elements
const resolveBridgeStatusDot = document.getElementById('resolve-bridge-status-dot');
const resolveBridgeStatusText = document.getElementById('resolve-bridge-status-text');
const resolveScriptsInput = document.getElementById('resolve-scripts-input');
const resolveBrowseBtn = document.getElementById('resolve-browse-btn');
const resolveInstallBtn = document.getElementById('resolve-install-btn');
const resolveRevealBtn = document.getElementById('resolve-reveal-btn');

// NLE Selector DOM Elements
const nleAutoBtn = document.getElementById('nle-auto-btn');
const nlePremiereBtn = document.getElementById('nle-premiere-btn');
const nleResolveBtn = document.getElementById('nle-resolve-btn');
const nleStatusText = document.getElementById('nle-status-text');
const connectionNleLabel = document.getElementById('connection-nle-label');

// Update Settings DOM Elements
const checkUpdateBtn = document.getElementById('check-update-btn');
const settingsUpdateStatus = document.getElementById('settings-update-status');

// Logs DOM Elements
const logsContainer = document.getElementById('logs-container');
const logsClearBtn = document.getElementById('logs-clear-btn');

// Auth DOM Elements
const userInfo = document.getElementById('user-info');
const trialInfo = document.getElementById('trial-info');
const userName = document.getElementById('user-name');
const userTier = document.getElementById('user-tier');
const userInitial = document.getElementById('user-initial');
const trialDays = document.getElementById('trial-days'); // may be null after free-pill redesign
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const loginModal = document.getElementById('login-modal');
const loginForm = document.getElementById('login-form');
const loginCloseBtn = document.getElementById('login-close-btn');
const loginError = document.getElementById('login-error');
const totpGroup = document.getElementById('totp-group');
const signupLink = document.getElementById('signup-link');

// Feature lock overlays (multicam lock removed — free forever; bestshorts = Studio AI upsell)
const multicamLock = document.getElementById('multicam-lock');
const bestshortsLock = document.getElementById('bestshorts-lock');

// Pin (Always on Top) DOM Elements
const pinBtn = document.getElementById('pin-btn');

// Initialize
async function init() {
  setupEventListeners();
  setupElectronListeners();

  // Initialize auth state
  await initAuth();

  // Get initial NLE status
  const status = await window.electronAPI.getStatus();
  if (status.nle) state.activeNLE = status.nle;
  updateConnection(status.connected, status.nle);
  if (status.sequenceInfo) {
    displaySequenceInfo(status.sequenceInfo);
  }

  // Get initial website connection status
  const websiteStatus = await window.electronAPI.getWebsiteConnectionStatus();
  updateWebsiteConnection(websiteStatus.connected);
}

// ========================================
// Auth Functions
// ========================================

async function initAuth() {
  state.authState = await window.electronAPI.getAuthState();
  // Trials removed — local tools free forever. Keep stub for compat.
  try {
    if (window.electronAPI.getTrialStatus) {
      state.trialStatus = await window.electronAPI.getTrialStatus();
    }
  } catch {}
  updateAuthUI();
  updateFeatureLocks();
}

function updateAuthUI() {
  const { authState } = state;

  if (authState && authState.user) {
    // User is logged in (optional — only needed for Studio AI)
    userInfo.classList.remove('hidden');
    trialInfo.classList.add('hidden');

    // Set user display
    const displayName = authState.user.name || authState.user.email.split('@')[0];
    userName.textContent = displayName;
    userInitial.textContent = displayName.charAt(0).toUpperCase();

    // Set tier badge
    const isPro = authState.user.tier === 'pro';
    userTier.textContent = isPro ? 'Studio Pro' : 'Free';
    userTier.className = 'tier-badge ' + (isPro ? 'pro' : 'free');
  } else {
    // Not logged in — local tools free forever, show free pill + Connect Studio
    userInfo.classList.add('hidden');
    trialInfo.classList.remove('hidden');
    trialInfo.classList.remove('expired');
  }
}

async function updateFeatureLocks() {
  // Multicam (autocut) is free forever — ensure legacy overlay stays hidden
  if (multicamLock) {
    multicamLock.classList.add('hidden');
  }

  // Check bestshorts feature (cloud AI — Studio Pro only)
  const bestshortsAccess = await window.electronAPI.canUseFeature('bestshorts');
  if (bestshortsLock) {
    if (bestshortsAccess.allowed) {
      bestshortsLock.classList.add('hidden');
    } else {
      bestshortsLock.classList.remove('hidden');
      // Show/hide login button based on reason
      const loginBtnInLock = bestshortsLock.querySelector('#bestshorts-login-btn');
      if (loginBtnInLock) {
        loginBtnInLock.style.display = bestshortsAccess.reason === 'login-required' ? 'inline-block' : 'none';
      }
    }
  }
}

function openLoginModal() {
  loginModal.classList.remove('hidden');
  loginError.classList.add('hidden');
  totpGroup.classList.add('hidden');
  loginForm.reset();
}

function closeLoginModal() {
  loginModal.classList.add('hidden');
  loginError.classList.add('hidden');
  totpGroup.classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const totpCode = document.getElementById('login-totp').value.trim() || undefined;

  const submitBtn = document.getElementById('login-submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in...';

  try {
    const result = await window.electronAPI.login(email, password, totpCode);

    if (result.requires2FA) {
      totpGroup.classList.remove('hidden');
      loginError.classList.add('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Login';
      document.getElementById('login-totp').focus();
      return;
    }

    if (result.success) {
      closeLoginModal();
      await initAuth();
    } else {
      loginError.textContent = result.error || 'Login failed';
      loginError.classList.remove('hidden');
    }
  } catch (error) {
    loginError.textContent = 'Network error. Please try again.';
    loginError.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Login';
  }
}

async function handleLogout() {
  await window.electronAPI.logout();
  await initAuth();
}

function setupEventListeners() {
  // Update bar close button
  document.getElementById('update-bar-close').addEventListener('click', () => {
    document.getElementById('update-bar').classList.add('hidden');
  });

  // Tab navigation
  document.querySelectorAll('.nav-item:not(.disabled)').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;
      state.currentTab = tab;

      // Update active nav item
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      // Show corresponding tab content
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');

      // Update tabs if switching
      if (tab === 'silence' && state.sequenceInfo) {
        displaySilenceSequenceInfo(state.sequenceInfo);
      }
      if (tab === 'bestshorts' && state.sequenceInfo) {
        displayBestshortsSequenceInfo(state.sequenceInfo);
      }
      if (tab === 'captions') {
        if (state.sequenceInfo) displayCaptionsSequenceInfo(state.sequenceInfo);
      }
    });
  });

  refreshBtn.addEventListener('click', () => {
    window.electronAPI.refreshSequence();
  });

  autoCutBtn.addEventListener('click', runAutoCut);

  document.getElementById('error-close-btn').addEventListener('click', () => {
    document.getElementById('error-modal').classList.add('hidden');
  });

  document.getElementById('use-wide-shot').addEventListener('change', (e) => {
    document.getElementById('wide-shot-config').classList.toggle('hidden', !e.target.checked);
  });

  document.getElementById('min-cut-duration').addEventListener('input', (e) => {
    document.getElementById('min-cut-value').textContent = `${e.target.value}s`;
  });

  document.getElementById('hold-time').addEventListener('input', (e) => {
    document.getElementById('hold-time-value').textContent = `${e.target.value}s`;
  });

  document.getElementById('jcut-offset').addEventListener('input', (e) => {
    document.getElementById('jcut-value').textContent = `${e.target.value}s`;
  });

  // Silence Removal Tab
  silenceRefreshBtn.addEventListener('click', () => {
    window.electronAPI.refreshSequence();
  });

  silenceRemoveBtn.addEventListener('click', runSilenceRemoval);

  document.getElementById('silence-threshold').addEventListener('input', (e) => {
    document.getElementById('silence-threshold-value').textContent = `${e.target.value} dB`;
  });

  document.getElementById('min-silence-duration').addEventListener('input', (e) => {
    document.getElementById('min-silence-value').textContent = `${e.target.value}s`;
  });

  document.getElementById('padding-amount').addEventListener('input', (e) => {
    document.getElementById('padding-value').textContent = `${e.target.value}s`;
  });

  // Captions Tab
  captionsRefreshBtn.addEventListener('click', () => {
    window.electronAPI.refreshSequence();
  });

  generateCaptionsBtn.addEventListener('click', runGenerateCaptions);
  saveCaptionsBtn.addEventListener('click', saveCaptionsFile);
  importCaptionsBtn.addEventListener('click', importCaptionsToPremiere);

  document.getElementById('caption-max-chars').addEventListener('input', (e) => {
    document.getElementById('caption-max-chars-value').textContent = e.target.value;
  });

  document.querySelectorAll('#caption-max-lines-group .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#caption-max-lines-group .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('caption-max-duration').addEventListener('input', (e) => {
    document.getElementById('caption-max-duration-value').textContent = `${e.target.value}s`;
  });

  // Best Shorts Tab
  bestshortsRefreshBtn.addEventListener('click', () => {
    window.electronAPI.refreshSequence();
  });

  exportAudioBtn.addEventListener('click', exportAudioToWebsite);
  clearMarkersBtn.addEventListener('click', clearAllMarkers);

  // Settings Modal
  settingsBtn.addEventListener('click', openSettings);
  settingsCloseBtn.addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  saveTokenBtn.addEventListener('click', saveToken);
  connectWebsiteBtn.addEventListener('click', toggleWebsiteConnection);

  getTokenLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://smoothyedit.com/connection');
  });

  // Bridge settings
  uxpInstallBtn.addEventListener('click', installUxpBridge);
  cepBrowseBtn.addEventListener('click', browseCepPath);
  cepResetBtn.addEventListener('click', resetCepPath);
  cepInstallBtn.addEventListener('click', reinstallLegacyBridge);

  // Resolve bridge settings
  if (resolveInstallBtn) {
    resolveInstallBtn.addEventListener('click', installResolveBridge);
  }
  if (resolveBrowseBtn) {
    resolveBrowseBtn.addEventListener('click', browseResolveScriptsPath);
  }
  if (resolveRevealBtn) {
    resolveRevealBtn.addEventListener('click', revealResolveFolder);
  }

  // NLE selector
  if (nleAutoBtn) {
    nleAutoBtn.addEventListener('click', () => setActiveNLE(null));
  }
  if (nlePremiereBtn) {
    nlePremiereBtn.addEventListener('click', () => setActiveNLE('premiere'));
  }
  if (nleResolveBtn) {
    nleResolveBtn.addEventListener('click', () => setActiveNLE('resolve'));
  }

  // Check for updates button
  checkUpdateBtn.addEventListener('click', manualCheckForUpdates);

  // Logs tab
  if (logsClearBtn) {
    logsClearBtn.addEventListener('click', () => {
      if (logsContainer) logsContainer.innerHTML = '';
    });
  }

  // Auth event listeners
  loginBtn.addEventListener('click', openLoginModal);
  logoutBtn.addEventListener('click', handleLogout);
  loginCloseBtn.addEventListener('click', closeLoginModal);
  loginForm.addEventListener('submit', handleLogin);
  loginModal.addEventListener('click', (e) => {
    if (e.target === loginModal) closeLoginModal();
  });

  signupLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://smoothyedit.com/signup');
  });

  // Feature lock buttons
  const multicamUpgradeBtn = document.getElementById('multicam-upgrade-btn');
  const multicamLoginBtn = document.getElementById('multicam-login-btn');
  const bestshortsUpgradeBtn = document.getElementById('bestshorts-upgrade-btn');
  const bestshortsLoginBtn = document.getElementById('bestshorts-login-btn');

  if (multicamUpgradeBtn) {
    multicamUpgradeBtn.addEventListener('click', () => {
      window.electronAPI.openExternal('https://smoothyedit.com/pricing');
    });
  }
  if (multicamLoginBtn) {
    multicamLoginBtn.addEventListener('click', openLoginModal);
  }
  if (bestshortsUpgradeBtn) {
    bestshortsUpgradeBtn.addEventListener('click', () => {
      window.electronAPI.openExternal('https://smoothyedit.com/pricing');
    });
  }
  if (bestshortsLoginBtn) {
    bestshortsLoginBtn.addEventListener('click', openLoginModal);
  }
}

function setupElectronListeners() {
  window.electronAPI.onConnectionChange((data) => {
    updateConnection(data.connected, data.nle);
  });

  window.electronAPI.onSequenceInfo((info) => {
    displaySequenceInfo(info);
  });

  window.electronAPI.onProgress((data) => {
    setProgress(data.progress, data.message);
  });

  window.electronAPI.onAutoCutResult((result) => {
    hideProgress();
    state.isProcessing = false;

    if (state.currentTab === 'silence') {
      // Silence removal result
      if (result.success) {
        setSilenceStatus(`Done! Removed ${formatDuration(result.stats?.silenceRemoved || 0)} of silence`, 'success');
        silenceFooterStatus.textContent = 'Silence removed - check Premiere for new sequence';

        // Show stats
        document.getElementById('silence-stats-section').style.display = 'block';
        document.getElementById('stat-original-duration').textContent = formatDuration(result.stats?.originalDuration || 0);
        document.getElementById('stat-silence-removed').textContent = formatDuration(result.stats?.silenceRemoved || 0);
        document.getElementById('stat-new-duration').textContent = formatDuration(result.stats?.newDuration || 0);
        document.getElementById('stat-cuts-count').textContent = result.stats?.cuts || 0;
      } else {
        setSilenceStatus('Error', 'error');
        showError(result.error || 'Silence removal failed');
      }
    } else {
      // Auto-Switch result
      if (result.success) {
        setStatus(`Done! ${result.stats?.shots || 0} cuts created`, 'success');
        footerStatus.textContent = 'Auto-Switch complete - check Premiere for new sequence';
      } else {
        setStatus('Error', 'error');
        showError(result.error || 'Auto-Switch failed');
      }
    }
  });

  // Website connection listeners
  window.electronAPI.onWebsiteConnectionChange((data) => {
    updateWebsiteConnection(data.connected);
  });

  window.electronAPI.onWebsiteMessage((data) => {
    console.log('[App] Website message:', data.type);
    if (data.type === 'markersAdded') {
      setBestshortsStatus(data.success ? 'Markers added to timeline!' : 'Failed to add markers', data.success ? 'success' : 'error');
      bestshortsFooterStatus.textContent = data.success ? `Added ${data.count} markers` : 'Failed to add markers';
    }
  });

  window.electronAPI.onExportProgress((data) => {
    setProgress(data.progress, data.message);
  });

  // Caption progress listener
  window.electronAPI.onCaptionProgress((data) => {
    if (data.status === 'complete') {
      hideProgress();
      setCaptionsStatus('Captions generated!', 'success');
    } else {
      const pct = data.progress || 0;
      setProgress(pct, data.message || 'Processing...');
      setCaptionsStatus(data.message || 'Processing...', 'processing');
    }
  });

  window.electronAPI.onCaptionModelProgress((data) => {
    if (data.progress !== undefined) {
      captionModelProgress.classList.remove('hidden');
      captionModelProgressFill.style.width = `${Math.round(data.progress)}%`;
      captionModelProgressText.textContent = data.status || `Downloading model... ${Math.round(data.progress)}%`;
    }
    if (data.status === 'ready' || data.progress >= 100) {
      captionModelProgress.classList.add('hidden');
    }
  });

  // Auth state change listener (optional login — only for Studio AI)
  window.electronAPI.onAuthStateChange(async (newState) => {
    state.authState = newState;
    updateAuthUI();
    updateFeatureLocks();
  });

  // Single brand theme — theme sync from the website is ignored.
  window.electronAPI.onThemeSync(() => {
    applyTheme();
  });

  // Auto-updater listener
  window.electronAPI.onUpdateStatus((data) => {
    const updateBar = document.getElementById('update-bar');
    const updateText = document.getElementById('update-bar-text');
    const updateBtn = document.getElementById('update-bar-btn');

    if (data.status === 'downloaded') {
      updateText.textContent = `Update v${data.version} ready`;
      updateBtn.textContent = 'Restart to Update';
      updateBtn.onclick = () => window.electronAPI.installUpdate();
      updateBar.classList.remove('hidden');
      settingsUpdateStatus.textContent = `Update v${data.version} ready - restart to install`;
      checkUpdateBtn.textContent = 'Restart to Update';
      checkUpdateBtn.onclick = () => window.electronAPI.installUpdate();
      showUpdateModal(data.version);
    } else if (data.status === 'downloading') {
      updateText.textContent = `Downloading update... ${data.percent}%`;
      updateBtn.style.display = 'none';
      updateBar.classList.remove('hidden');
      settingsUpdateStatus.textContent = `Downloading update... ${data.percent}%`;
      checkUpdateBtn.disabled = true;
    } else if (data.status === 'checking') {
      settingsUpdateStatus.textContent = 'Checking for updates...';
      checkUpdateBtn.disabled = true;
    } else if (data.status === 'up-to-date') {
      settingsUpdateStatus.textContent = 'You are on the latest version';
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = 'Check for Updates';
    } else if (data.status === 'available') {
      settingsUpdateStatus.textContent = `Update v${data.version} available, downloading...`;
    } else if (data.status === 'error') {
      settingsUpdateStatus.textContent = 'Update check failed';
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = 'Check for Updates';
    }
  });

  // Release notes for the pending update -> shown in the "what's new" modal
  window.electronAPI.onUpdateNotes((data) => {
    state.pendingUpdateNotes = data.notes || null;
    if (state.updateModalOpen) {
      renderUpdateModalNotes(data.version, data.notes);
    }
  });

  // Platform info listener - applies platform-specific styles
  window.electronAPI.onPlatformInfo((data) => {
    state.platform = data.isWindows ? 'windows' : (data.isMac ? 'macos' : 'unknown');
    applyPlatformStyles(data);
  });

  // Log streaming from main process
  window.electronAPI.onLogMessage((data) => {
    if (!logsContainer) return;
    const entry = document.createElement('div');
    entry.className = `log-entry log-level-${data.level}`;
    entry.innerHTML = `<span class="log-time">${data.timestamp}</span>${escapeHtml(data.message)}`;
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
    // Keep max 500 entries
    while (logsContainer.children.length > 500) {
      logsContainer.removeChild(logsContainer.firstChild);
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getNLEDisplayName() {
  if (state.activeNLE === 'resolve') return 'DaVinci Resolve';
  return 'Premiere Pro';
}

function getNLEPanelName() {
  if (state.activeNLE === 'resolve') return 'Resolve';
  return 'Premiere';
}

function updateConnection(connected, nle) {
  state.isConnected = connected;
  if (nle) state.activeNLE = nle;
  const statusDot = connectionStatus.querySelector('.status-dot');
  const nleName = getNLEDisplayName();
  const panelName = getNLEPanelName();

  if (connectionNleLabel) {
    connectionNleLabel.textContent = nleName;
  }

  if (connected) {
    setStatus(`Connected to ${nleName}`, 'idle');
    setSilenceStatus(`Connected to ${nleName}`, 'idle');
    setCaptionsStatus(`Connected to ${nleName}`, 'idle');
    statusDot.classList.remove('disconnected');
    statusDot.classList.add('connected');
  } else {
    setStatus(`Waiting for ${nleName}...`, 'idle');
    setSilenceStatus(`Waiting for ${nleName}...`, 'idle');
    setCaptionsStatus(`Waiting for ${nleName}...`, 'idle');
    statusDot.classList.remove('connected');
    statusDot.classList.add('disconnected');

    // Multicam tab
    sequenceName.textContent = 'No sequence loaded';
    sequenceDetails.textContent = '';
    audioTracksList.innerHTML = `<p class="empty-message">Connect to ${panelName} to see audio tracks</p>`;
    videoTracksList.innerHTML = `<p class="empty-message">Connect to ${panelName} to see video tracks</p>`;
    autoCutBtn.disabled = true;
    footerStatus.textContent = `Open SmoothyEdit panel in ${panelName}`;

    // Silence tab
    silenceSequenceName.textContent = 'No sequence loaded';
    silenceSequenceDetails.textContent = '';
    silenceAudioTracksList.innerHTML = `<p class="empty-message">Connect to ${panelName} to see audio tracks</p>`;
    silenceRemoveBtn.disabled = true;
    silenceFooterStatus.textContent = `Open SmoothyEdit panel in ${panelName}`;

    // Captions tab
    captionsSequenceName.textContent = 'No sequence loaded';
    captionsSequenceDetails.textContent = '';
    captionsAudioTracksList.innerHTML = `<p class="empty-message">Connect to ${panelName} to see audio tracks</p>`;
    generateCaptionsBtn.disabled = true;
    captionsFooterStatus.textContent = `Open SmoothyEdit panel in ${panelName}`;

    // Best Shorts tab
    bestshortsSequenceName.textContent = 'No sequence loaded';
    bestshortsSequenceDetails.textContent = '';
    updateExportButton();
  }
}

function displaySequenceInfo(info) {
  if (!info || !info.hasSequence) {
    sequenceName.textContent = 'No sequence open';
    sequenceDetails.textContent = 'Open a sequence in Premiere';
    audioTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    videoTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    autoCutBtn.disabled = true;
    footerStatus.textContent = 'Open a sequence to begin';
    return;
  }

  state.sequenceInfo = info;
  sequenceName.textContent = info.name || info.sequenceName;
  sequenceDetails.textContent = `${Math.round(info.duration || 0)}s | ${Math.round(info.fps || 24)}fps`;

  // Display audio tracks
  if (info.audioTracks && info.audioTracks.length > 0) {
    audioTracksList.innerHTML = '';
    info.audioTracks.forEach((track, index) => {
      const clipNames = track.clips ? track.clips.map(c => c.name).join(', ') : '';
      const trackEl = document.createElement('div');
      trackEl.className = 'track-item';
      trackEl.innerHTML = `
        <div class="track-info">
          <input type="checkbox" class="track-checkbox audio-track-cb" data-track-index="${track.index}" checked>
          <span class="track-name">${track.name}</span>
          <span class="track-clips">${clipNames}</span>
        </div>
        <div class="track-mapping">
          <label>Speaker:</label>
          <input type="text" class="speaker-name" data-track-index="${track.index}" value="Speaker ${index + 1}">
        </div>
      `;
      audioTracksList.appendChild(trackEl);
    });
  } else {
    audioTracksList.innerHTML = '<p class="empty-message">No audio tracks found</p>';
  }

  // Display video tracks
  const wideSelect = document.getElementById('wide-camera-select');
  wideSelect.innerHTML = '<option value="-1">None</option>';

  if (info.videoTracks && info.videoTracks.length > 0) {
    videoTracksList.innerHTML = '';
    info.videoTracks.forEach((track, index) => {
      const clipNames = track.clips ? track.clips.map(c => c.name).join(', ') : '';
      const trackEl = document.createElement('div');
      trackEl.className = 'track-item';
      trackEl.innerHTML = `
        <div class="track-info">
          <input type="checkbox" class="track-checkbox video-track-cb" data-track-index="${track.index}" checked>
          <span class="track-name">${track.name}</span>
          <span class="track-clips">${clipNames}</span>
        </div>
        <div class="track-mapping">
          <label>Camera:</label>
          <select class="camera-index" data-track-index="${track.index}">
            ${generateCameraOptions(info.videoTracks.length, index)}
          </select>
        </div>
      `;
      videoTracksList.appendChild(trackEl);

      wideSelect.innerHTML += `<option value="${index}">Camera ${index + 1} (${track.name})</option>`;
    });
  } else {
    videoTracksList.innerHTML = '<p class="empty-message">No video tracks found</p>';
  }

  // Enable button if we have both
  const hasAudio = info.audioTracks && info.audioTracks.length > 0;
  const hasVideo = info.videoTracks && info.videoTracks.length > 0;
  autoCutBtn.disabled = !(hasAudio && hasVideo);
  footerStatus.textContent = hasAudio && hasVideo ? 'Ready to process' : 'Need audio and video tracks';

  // Also update other tabs
  displaySilenceSequenceInfo(info);
  displayBestshortsSequenceInfo(info);
  displayCaptionsSequenceInfo(info);
}

function generateCameraOptions(count, defaultIndex) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<option value="${i}" ${i === defaultIndex ? 'selected' : ''}>Camera ${i + 1}</option>`;
  }
  return html;
}

async function runAutoCut() {
  if (state.isProcessing || !state.sequenceInfo) return;

  // Gather audio mappings
  const audioMappings = [];
  document.querySelectorAll('.audio-track-cb:checked').forEach(cb => {
    const trackIndex = parseInt(cb.dataset.trackIndex);
    const track = state.sequenceInfo.audioTracks.find(t => t.index === trackIndex);
    const speakerInput = document.querySelector(`.speaker-name[data-track-index="${trackIndex}"]`);
    const speakerName = speakerInput ? speakerInput.value : `speaker_${trackIndex}`;

    if (track && track.clips && track.clips.length > 0) {
      audioMappings.push({
        trackIndex,
        speaker: speakerName.toLowerCase().replace(/\s+/g, '_'),
        path: track.clips[0].path,
        trackName: track.name
      });
    }
  });

  // Gather video mappings
  const videoMappings = [];
  document.querySelectorAll('.video-track-cb:checked').forEach(cb => {
    const trackIndex = parseInt(cb.dataset.trackIndex);
    const track = state.sequenceInfo.videoTracks.find(t => t.index === trackIndex);
    const cameraSelect = document.querySelector(`.camera-index[data-track-index="${trackIndex}"]`);
    const cameraIndex = cameraSelect ? parseInt(cameraSelect.value) : trackIndex;

    if (track && track.clips && track.clips.length > 0) {
      videoMappings.push({
        trackIndex,
        camera: cameraIndex,
        path: track.clips[0].path,
        trackName: track.name
      });
    }
  });

  if (audioMappings.length === 0) {
    showError('Please select at least one audio track');
    return;
  }

  if (videoMappings.length === 0) {
    showError('Please select at least one video track');
    return;
  }

  // Build sources - map each audio track to its corresponding camera index
  const sources = audioMappings.map((audio, index) => {
    // Use the index directly as camera number (speaker 1 -> camera 0, speaker 2 -> camera 1, etc.)
    // This ensures each speaker gets a unique camera
    return {
      path: audio.path,
      speaker: audio.speaker,
      camera: index  // Direct mapping: audio track 0 = camera 0, audio track 1 = camera 1
    };
  });

  const clips = videoMappings.map(v => ({
    name: v.trackName,
    path: v.path,
    camera: v.camera
  }));

  const useWideShot = document.getElementById('use-wide-shot').checked;
  const wideIndex = useWideShot ? parseInt(document.getElementById('wide-camera-select').value) : -1;
  const jcutOffset = parseFloat(document.getElementById('jcut-offset').value);

  const config = {
    sources,
    options: {
      sequenceName: state.sequenceInfo.name + ' - Auto-Switch',
      fps: state.sequenceInfo.fps,
      width: state.sequenceInfo.width,
      height: state.sequenceInfo.height,
      duration: state.sequenceInfo.duration,
      minCutDuration: parseFloat(document.getElementById('min-cut-duration').value),
      holdTime: parseFloat(document.getElementById('hold-time').value),
      wideCameraIndex: wideIndex,
      // Enable overlap-based wide shots when wide camera is selected
      // Wide shot triggers when both speakers talk at the same time (overlap > 0.5s)
      // Shows for 5 seconds, extends if another overlap occurs within that window
      // Wide shots are placed on V3 track (removable without affecting main V1/V2 cuts)
      useOverlapWideShots: useWideShot && wideIndex >= 0,
      jcutOffset: jcutOffset,
      clips
    }
  };

  state.isProcessing = true;
  showProgress('Starting...');
  setStatus('Processing...', 'processing');

  await window.electronAPI.startAutoCut(config);
}

// Silence Removal Functions
function displaySilenceSequenceInfo(info) {
  if (!info || !info.hasSequence) {
    silenceSequenceName.textContent = 'No sequence open';
    silenceSequenceDetails.textContent = 'Open a sequence in Premiere';
    silenceAudioTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    silenceRemoveBtn.disabled = true;
    silenceFooterStatus.textContent = 'Open a sequence to begin';
    return;
  }

  silenceSequenceName.textContent = info.name || info.sequenceName;
  silenceSequenceDetails.textContent = `${Math.round(info.duration || 0)}s | ${Math.round(info.fps || 24)}fps`;

  // Display audio tracks for silence removal
  if (info.audioTracks && info.audioTracks.length > 0) {
    silenceAudioTracksList.innerHTML = '';
    info.audioTracks.forEach((track) => {
      const clipNames = track.clips ? track.clips.map(c => c.name).join(', ') : '';
      const trackEl = document.createElement('div');
      trackEl.className = 'track-item';
      trackEl.innerHTML = `
        <div class="track-info">
          <input type="checkbox" class="track-checkbox silence-audio-track-cb" data-track-index="${track.index}" checked>
          <span class="track-name">${track.name}</span>
          <span class="track-clips">${clipNames}</span>
        </div>
      `;
      silenceAudioTracksList.appendChild(trackEl);
    });
  } else {
    silenceAudioTracksList.innerHTML = '<p class="empty-message">No audio tracks found</p>';
  }

  const hasAudio = info.audioTracks && info.audioTracks.length > 0;
  silenceRemoveBtn.disabled = !hasAudio;
  silenceFooterStatus.textContent = hasAudio ? 'Ready to analyze' : 'Need audio tracks';

  // Hide stats section until we run analysis
  document.getElementById('silence-stats-section').style.display = 'none';
}

async function runSilenceRemoval() {
  if (state.isProcessing || !state.sequenceInfo) return;

  // Gather selected audio tracks
  const audioSources = [];
  document.querySelectorAll('.silence-audio-track-cb:checked').forEach(cb => {
    const trackIndex = parseInt(cb.dataset.trackIndex);
    const track = state.sequenceInfo.audioTracks.find(t => t.index === trackIndex);

    if (track && track.clips && track.clips.length > 0) {
      audioSources.push({
        trackIndex,
        path: track.clips[0].path,
        trackName: track.name
      });
    }
  });

  if (audioSources.length === 0) {
    showError('Please select at least one audio track');
    return;
  }

  // Get video tracks for the XML (use all video tracks)
  const videoClips = [];
  if (state.sequenceInfo.videoTracks) {
    state.sequenceInfo.videoTracks.forEach((track) => {
      if (track.clips && track.clips.length > 0) {
        videoClips.push({
          name: track.name,
          path: track.clips[0].path
        });
      }
    });
  }

  const editInPlace = document.getElementById('edit-in-place').checked;

  const config = {
    sources: audioSources,
    options: {
      sequenceName: state.sequenceInfo.name + ' - Silence Removed',
      fps: state.sequenceInfo.fps,
      width: state.sequenceInfo.width,
      height: state.sequenceInfo.height,
      thresholdDb: parseInt(document.getElementById('silence-threshold').value),
      minSilenceDuration: parseFloat(document.getElementById('min-silence-duration').value),
      padding: parseFloat(document.getElementById('padding-amount').value),
      editInPlace: editInPlace,
      clips: videoClips.length > 0 ? videoClips : audioSources.map(s => ({ name: s.trackName, path: s.path }))
    }
  };

  state.isProcessing = true;
  showProgress('Starting silence analysis...');
  setSilenceStatus('Analyzing...', 'processing');

  await window.electronAPI.startSilenceRemoval(config);
}

function setSilenceStatus(text, type) {
  silenceStatusBar.className = `status-bar status-${type}`;
  silenceStatusText.textContent = text;
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(0);
  return `${mins}m ${secs}s`;
}

// UI Helpers
function setStatus(text, type) {
  statusBar.className = `status-bar status-${type}`;
  statusText.textContent = text;
}

function showProgress(msg) {
  document.getElementById('progress-overlay').classList.remove('hidden');
  document.getElementById('progress-text').textContent = msg;
  document.getElementById('progress-fill').style.width = '0%';
}

function setProgress(pct, msg) {
  if (msg) document.getElementById('progress-text').textContent = msg;
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function hideProgress() {
  document.getElementById('progress-overlay').classList.add('hidden');
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  document.getElementById('error-modal').classList.remove('hidden');
}

// ========================================
// Update "what's new" modal
// ========================================

function showUpdateModal(version) {
  const modal = document.getElementById('update-modal');
  document.getElementById('update-modal-version').textContent = version;
  renderUpdateModalNotes(version, state.pendingUpdateNotes);
  modal.classList.remove('hidden');
  state.updateModalOpen = true;

  document.getElementById('update-modal-install').onclick = () => {
    modal.classList.add('hidden');
    state.updateModalOpen = false;
    window.electronAPI.installUpdate();
  };
  document.getElementById('update-modal-later').onclick = () => {
    modal.classList.add('hidden');
    state.updateModalOpen = false;
  };
}

function renderUpdateModalNotes(version, notes) {
  const body = document.getElementById('update-modal-body');
  body.innerHTML = '';

  if (!notes) {
    const p = document.createElement('p');
    p.className = 'update-empty';
    p.textContent = `SmoothyEdit v${version} is ready to install. Restart to get the latest fixes and features.`;
    body.appendChild(p);
    return;
  }

  // GitHub release bodies are markdown. Render the common shapes:
  // headings (##), bullet lists (-/*), and plain paragraphs.
  let list = null;
  const lines = notes.split(/\r?\n/);
  const flushList = () => {
    if (list) { body.appendChild(list); list = null; }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushList();
      const h = document.createElement('h4');
      h.textContent = stripInlineMarkdown(heading[1]);
      body.appendChild(h);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!list) { list = document.createElement('ul'); }
      const li = document.createElement('li');
      applyInlineMarkdown(li, bullet[1]);
      list.appendChild(li);
      continue;
    }

    flushList();
    const p = document.createElement('p');
    p.className = 'update-empty';
    applyInlineMarkdown(p, line);
    body.appendChild(p);
  }
  flushList();
}

function stripInlineMarkdown(text) {
  return text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

function applyInlineMarkdown(el, text) {
  const html = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  el.innerHTML = html;
}

// ========================================
// Best Shorts Functions
// ========================================

function updateWebsiteConnection(connected) {
  state.isWebsiteConnected = connected;

  // Update Best Shorts tab
  if (websiteStatusDot) {
    websiteStatusDot.className = 'connection-dot' + (connected ? ' connected' : '');
  }
  if (websiteStatusText) {
    websiteStatusText.textContent = connected ? 'Connected' : 'Disconnected';
  }
  if (websiteHelpText) {
    websiteHelpText.textContent = connected
      ? 'Ready to export audio and receive markers'
      : 'Add your connection token in Settings to connect';
  }

  // Update settings modal
  if (settingsConnectionDot) {
    settingsConnectionDot.className = 'connection-dot' + (connected ? ' connected' : '');
  }
  if (settingsConnectionStatus) {
    settingsConnectionStatus.textContent = connected ? 'Connected to Smoothy' : 'Not connected';
  }
  if (connectWebsiteBtn) {
    connectWebsiteBtn.textContent = connected ? 'Disconnect' : 'Connect';
  }

  // Update export button
  updateExportButton();
}

function updateExportButton() {
  const canExport = state.isConnected && state.isWebsiteConnected && state.sequenceInfo?.hasSequence && !state.isExporting;
  exportAudioBtn.disabled = !canExport;

  // Clear markers only requires Premiere connection and sequence
  const canClear = state.isConnected && state.sequenceInfo?.hasSequence;
  clearMarkersBtn.disabled = !canClear;

  if (!state.isConnected) {
    bestshortsFooterStatus.textContent = 'Connect to Premiere Pro first';
  } else if (!state.isWebsiteConnected) {
    bestshortsFooterStatus.textContent = 'Connect to website in Settings';
  } else if (!state.sequenceInfo?.hasSequence) {
    bestshortsFooterStatus.textContent = 'Open a sequence in Premiere';
  } else {
    bestshortsFooterStatus.textContent = 'Ready to export';
  }
}

function displayBestshortsSequenceInfo(info) {
  if (!info || !info.hasSequence) {
    bestshortsSequenceName.textContent = 'No sequence open';
    bestshortsSequenceDetails.textContent = 'Open a sequence in Premiere';
    updateExportButton();
    return;
  }

  bestshortsSequenceName.textContent = info.name || info.sequenceName;
  bestshortsSequenceDetails.textContent = `${Math.round(info.duration || 0)}s | ${Math.round(info.fps || 24)}fps`;
  updateExportButton();
}

async function exportAudioToWebsite() {
  if (state.isExporting || !state.isWebsiteConnected) return;

  state.isExporting = true;
  exportAudioBtn.disabled = true;
  showProgress('Exporting audio...');
  setBestshortsStatus('Exporting audio...', 'processing');

  try {
    const result = await window.electronAPI.exportAudioToWebsite();

    if (result.success) {
      setBestshortsStatus('Audio sent to website!', 'success');
      bestshortsFooterStatus.textContent = 'Check smoothyedit.com for analysis results';
    } else {
      setBestshortsStatus('Export failed', 'error');
      showError(result.error || 'Failed to export audio');
    }
  } catch (error) {
    setBestshortsStatus('Export failed', 'error');
    showError(error.message || 'Failed to export audio');
  } finally {
    state.isExporting = false;
    hideProgress();
    updateExportButton();
  }
}

function setBestshortsStatus(text, type) {
  bestshortsStatusBar.className = `status-bar status-${type}`;
  bestshortsStatusText.textContent = text;
}

async function clearAllMarkers() {
  if (!state.isConnected || !state.sequenceInfo?.hasSequence) return;

  clearMarkersBtn.disabled = true;
  setBestshortsStatus('Clearing markers...', 'processing');

  try {
    const result = await window.electronAPI.clearMarkers();

    if (result.success) {
      setBestshortsStatus(`Cleared ${result.count} markers`, 'success');
      bestshortsFooterStatus.textContent = `${result.count} markers removed`;
    } else {
      setBestshortsStatus('Failed to clear markers', 'error');
      showError(result.error || 'Failed to clear markers');
    }
  } catch (error) {
    setBestshortsStatus('Failed to clear markers', 'error');
    showError(error.message || 'Failed to clear markers');
  } finally {
    updateExportButton();
  }
}

// ========================================
// Captions Functions
// ========================================

function setCaptionsStatus(text, type) {
  captionsStatusBar.className = `status-bar status-${type}`;
  captionsStatusText.textContent = text;
}

function displayCaptionsSequenceInfo(info) {
  if (!info || !info.hasSequence) {
    captionsSequenceName.textContent = 'No sequence open';
    captionsSequenceDetails.textContent = 'Open a sequence in Premiere';
    captionsAudioTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    generateCaptionsBtn.disabled = true;
    captionsFooterStatus.textContent = 'Open a sequence to begin';
    return;
  }

  captionsSequenceName.textContent = info.name || info.sequenceName;
  captionsSequenceDetails.textContent = `${Math.round(info.duration || 0)}s | ${Math.round(info.fps || 24)}fps`;

  // Display audio tracks
  if (info.audioTracks && info.audioTracks.length > 0) {
    captionsAudioTracksList.innerHTML = '';
    info.audioTracks.forEach((track) => {
      const clipNames = track.clips ? track.clips.map(c => c.name).join(', ') : '';
      const trackEl = document.createElement('div');
      trackEl.className = 'track-item';
      trackEl.innerHTML = `
        <div class="track-info">
          <input type="checkbox" class="track-checkbox captions-audio-track-cb" data-track-index="${track.index}" checked>
          <span class="track-name">${track.name}</span>
          <span class="track-clips">${clipNames}</span>
        </div>
      `;
      captionsAudioTracksList.appendChild(trackEl);
    });
  } else {
    captionsAudioTracksList.innerHTML = '<p class="empty-message">No audio tracks found</p>';
  }

  const hasAudio = info.audioTracks && info.audioTracks.length > 0;
  generateCaptionsBtn.disabled = !hasAudio;
  captionsFooterStatus.textContent = hasAudio ? 'Ready to generate captions' : 'Need audio tracks';
}

async function runGenerateCaptions() {
  if (state.isProcessing || !state.sequenceInfo) return;

  const trackIndices = Array.from(document.querySelectorAll('.captions-audio-track-cb:checked'))
    .map(cb => parseInt(cb.dataset.trackIndex, 10))
    .filter(index => !Number.isNaN(index));

  if (trackIndices.length === 0) {
    showError('Select at least one audio track');
    return;
  }

  state.isProcessing = true;
  generateCaptionsBtn.disabled = true;
  showProgress('Starting caption generation...');
  setCaptionsStatus('Generating captions...', 'processing');

  const settings = {
    maxCharsPerLine: parseInt(document.getElementById('caption-max-chars').value),
    maxLines: parseInt(document.querySelector('#caption-max-lines-group .toggle-btn.active').dataset.value),
    maxDurationSeconds: parseFloat(document.getElementById('caption-max-duration').value)
  };

  try {
    const result = await window.electronAPI.generateCaptions({ settings, trackIndices });

    hideProgress();
    state.isProcessing = false;

    if (result.success) {
      state.captionResult = result;

      if (result.captions.length === 0) {
        // Warn user — no speech detected
        setCaptionsStatus('No speech detected in audio', 'error');
        captionsFooterStatus.textContent = 'Check that audio tracks contain speech and aren\'t silent';
        saveCaptionsBtn.disabled = true;
        importCaptionsBtn.disabled = true;
      } else {
        setCaptionsStatus(`Generated ${result.captions.length} captions`, 'success');
        captionsFooterStatus.textContent = 'Captions ready - save or send to Premiere';
        saveCaptionsBtn.disabled = false;
        importCaptionsBtn.disabled = !state.isConnected;
      }
      generateCaptionsBtn.disabled = false;

      // Show preview
      displayCaptionsPreview(result.captions);
    } else {
      setCaptionsStatus('Generation failed', 'error');
      showError(result.error || 'Caption generation failed');
      generateCaptionsBtn.disabled = false;
    }
  } catch (error) {
    hideProgress();
    state.isProcessing = false;
    setCaptionsStatus('Generation failed', 'error');
    showError(error.message || 'Caption generation failed');
    generateCaptionsBtn.disabled = false;
  }
}

function displayCaptionsPreview(captions) {
  captionsPreviewSection.style.display = 'block';
  captionsCount.textContent = `${captions.length} captions`;
  captionsPreview.innerHTML = '';

  captions.forEach(cap => {
    const el = document.createElement('div');
    el.className = 'caption-item';
    el.innerHTML = `
      <div class="caption-time">${formatSRTTime(cap.startTime)} --> ${formatSRTTime(cap.endTime)}</div>
      <div class="caption-text">${escapeHtml(cap.text)}</div>
    `;
    captionsPreview.appendChild(el);
  });
}

function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

async function saveCaptionsFile() {
  if (!state.captionResult) return;

  try {
    const result = await window.electronAPI.saveCaptions({
      format: 'srt',
      content: state.captionResult.srt,
      fileName: `${state.sequenceInfo?.name || 'captions'}.srt`
    });

    if (result.success) {
      captionsFooterStatus.textContent = `Saved to ${result.path}`;
    } else if (!result.canceled) {
      showError(result.error || 'Failed to save captions');
    }
  } catch (error) {
    showError(error.message || 'Failed to save captions');
  }
}

async function importCaptionsToPremiere() {
  if (!state.captionResult || !state.isConnected) return;

  importCaptionsBtn.disabled = true;
  setCaptionsStatus('Sending to Premiere...', 'processing');

  try {
    const result = await window.electronAPI.importCaptionsToPremiere(state.captionResult.captions);

    if (result.success) {
      const msg = result.message || 'Captions sent to Premiere!';
      setCaptionsStatus(msg, 'success');
      captionsFooterStatus.textContent = msg;
    } else {
      setCaptionsStatus('Import failed', 'error');
      showError(result.error || 'Failed to import captions');
    }
  } catch (error) {
    setCaptionsStatus('Import failed', 'error');
    showError(error.message || 'Failed to import captions');
  } finally {
    importCaptionsBtn.disabled = false;
  }
}

// ========================================
// Settings Functions
// ========================================

async function openSettings() {
  settingsModal.classList.remove('hidden');

  // Load saved token
  const token = await window.electronAPI.getConnectionToken();
  if (token) {
    connectionTokenInput.value = token;
  }

  // Get connection status
  const status = await window.electronAPI.getWebsiteConnectionStatus();
  updateWebsiteConnection(status.connected);

  // Load bridge status
  loadBridgeStatus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

async function saveToken() {
  const token = connectionTokenInput.value.trim();
  if (!token) {
    showError('Please enter a connection token');
    return;
  }

  await window.electronAPI.saveConnectionToken(token);
  saveTokenBtn.textContent = 'Saved!';
  setTimeout(() => {
    saveTokenBtn.textContent = 'Save Token';
  }, 2000);
}

async function toggleWebsiteConnection() {
  const status = await window.electronAPI.getWebsiteConnectionStatus();

  if (status.connected) {
    await window.electronAPI.disconnectFromWebsite();
  } else {
    const token = connectionTokenInput.value.trim();
    if (!token) {
      showError('Please enter and save a connection token first');
      return;
    }

    // Save token first
    await window.electronAPI.saveConnectionToken(token);

    // Connect
    settingsConnectionDot.className = 'connection-dot connecting';
    settingsConnectionStatus.textContent = 'Connecting...';

    const connected = await window.electronAPI.connectToWebsite();
    if (!connected) {
      showError('Failed to connect to SmoothyEdit. Check your token and try again.');
    }
  }
}

// ========================================
// Bridge Settings Functions
// ========================================

async function loadBridgeStatus() {
  try {
    const status = await window.electronAPI.getBridgeStatus();
    const uxp = status.uxp || {};
    const cep = status.cep || {};
    uxpPackageInput.value = uxp.installPath || status.path || '';
    cepPathInput.value = status.extensionsPath;

    if (cep.installed) {
      bridgeStatusDot.className = 'connection-dot connected';
      bridgeStatusText.textContent = 'CEP bridge installed';
    } else if (uxp.installed) {
      bridgeStatusDot.className = 'connection-dot connected';
      bridgeStatusText.textContent = 'UXP bridge installed (CEP not found)';
    } else if (cep.error || uxp.error) {
      bridgeStatusDot.className = 'connection-dot disconnected';
      bridgeStatusText.textContent = 'Bridge status check failed';
    } else {
      bridgeStatusDot.className = 'connection-dot disconnected';
      bridgeStatusText.textContent = 'Bridge not installed';
    }
  } catch (err) {
    bridgeStatusDot.className = 'connection-dot disconnected';
    bridgeStatusText.textContent = 'Error checking bridge';
  }

  // Load Resolve bridge status
  try {
    const resolveStatus = await window.electronAPI.getResolveBridgeStatus();
    if (resolveScriptsInput) {
      resolveScriptsInput.value = resolveStatus.path || '';
    }
    if (resolveBridgeStatusDot) {
      if (resolveStatus.installed) {
        resolveBridgeStatusDot.className = 'connection-dot connected';
        resolveBridgeStatusText.textContent = 'Resolve bridge installed';
      } else {
        resolveBridgeStatusDot.className = 'connection-dot disconnected';
        resolveBridgeStatusText.textContent = 'Resolve bridge not installed';
      }
    }
  } catch (err) {
    if (resolveBridgeStatusDot) {
      resolveBridgeStatusDot.className = 'connection-dot disconnected';
      resolveBridgeStatusText.textContent = 'Error checking Resolve bridge';
    }
  }

  // Load NLE status
  try {
    const nleStatus = await window.electronAPI.getActiveNLE();
    state.activeNLE = nleStatus.activeNLE;
    updateNLESelectorUI();
  } catch (err) {
    console.warn('Failed to get NLE status:', err);
  }
}

async function browseCepPath() {
  const result = await window.electronAPI.browseCepPath();
  if (!result.canceled && result.path) {
    await window.electronAPI.setCepPath(result.path);
    cepPathInput.value = result.path;
    // Re-check bridge status at new path
    await loadBridgeStatus();
  }
}

async function resetCepPath() {
  await window.electronAPI.setCepPath(); // undefined = reset to default
  await loadBridgeStatus();
  cepResetBtn.textContent = 'Reset!';
  setTimeout(() => { cepResetBtn.textContent = 'Reset Path'; }, 1500);
}

async function installUxpBridge() {
  uxpInstallBtn.textContent = 'Installing...';
  uxpInstallBtn.disabled = true;

  try {
    const result = await window.electronAPI.installUxpBridge();
    if (result.success) {
      uxpInstallBtn.textContent = result.requiresUserAction ? 'Opened Installer' : 'Installed!';
      if (result.message) {
        bridgeStatusText.textContent = result.message;
      }
      await loadBridgeStatus();
    } else {
      uxpInstallBtn.textContent = 'Failed';
      showError('UXP bridge install failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    uxpInstallBtn.textContent = 'Failed';
    showError('UXP bridge install error');
  }

  setTimeout(() => {
    uxpInstallBtn.textContent = 'Install UXP Bridge';
    uxpInstallBtn.disabled = false;
  }, 2500);
}

async function reinstallLegacyBridge() {
  cepInstallBtn.textContent = 'Installing...';
  cepInstallBtn.disabled = true;

  try {
    const result = await window.electronAPI.installLegacyCepBridge();
    if (result.success) {
      cepInstallBtn.textContent = 'Installed!';
      await loadBridgeStatus();
    } else {
      cepInstallBtn.textContent = 'Failed';
      showError('Bridge install failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    cepInstallBtn.textContent = 'Failed';
    showError('Bridge install error');
  }

  setTimeout(() => {
    cepInstallBtn.textContent = 'Install CEP Bridge';
    cepInstallBtn.disabled = false;
  }, 2000);
}

async function installResolveBridge() {
  resolveInstallBtn.textContent = 'Installing...';
  resolveInstallBtn.disabled = true;

  try {
    const result = await window.electronAPI.installResolveBridge();
    if (result.success) {
      resolveInstallBtn.textContent = 'Installed!';
      resolveBridgeStatusText.textContent = 'Installed — restart Resolve to use';
      resolveBridgeStatusDot.className = 'connection-dot connecting';
      await loadBridgeStatus();
    } else {
      resolveInstallBtn.textContent = 'Failed';
      showError('Resolve bridge install failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    resolveInstallBtn.textContent = 'Failed';
    showError('Resolve bridge install error');
  }

  setTimeout(() => {
    resolveInstallBtn.textContent = 'Install Resolve Bridge';
    resolveInstallBtn.disabled = false;
  }, 2000);
}

async function browseResolveScriptsPath() {
  const result = await window.electronAPI.browseResolveScriptsPath();
  if (!result.canceled && result.path) {
    await window.electronAPI.setResolveScriptsPath(result.path);
    resolveScriptsInput.value = result.path;
    await loadBridgeStatus();
  }
}

async function revealResolveFolder() {
  try {
    const result = await window.electronAPI.revealResolveFolder();
    if (!result.success) {
      showError('Could not open folder: ' + (result.error || 'Not found'));
    }
  } catch (err) {
    showError('Could not reveal folder in Finder');
  }
}

async function setActiveNLE(nle) {
  await window.electronAPI.setActiveNLE(nle);
  state.activeNLE = nle;
  updateNLESelectorUI();

  // Refresh sequence info for the newly selected NLE
  const status = await window.electronAPI.getStatus();
  updateConnection(status.connected, nle || state.activeNLE);
  if (status.sequenceInfo) {
    displaySequenceInfo(status.sequenceInfo);
  }
}

function updateNLESelectorUI() {
  const nle = state.activeNLE;

  // Update button states
  [nleAutoBtn, nlePremiereBtn, nleResolveBtn].forEach(btn => {
    if (btn) btn.classList.remove('active');
  });

  if (nle === null && nleAutoBtn) {
    nleAutoBtn.classList.add('active');
    nleStatusText.textContent = 'Auto-detecting based on which editor is open';
  } else if (nle === 'premiere' && nlePremiereBtn) {
    nlePremiereBtn.classList.add('active');
    nleStatusText.textContent = 'Locked to Premiere Pro';
  } else if (nle === 'resolve' && nleResolveBtn) {
    nleResolveBtn.classList.add('active');
    nleStatusText.textContent = 'Locked to DaVinci Resolve. Launch the bridge from Workspace > Scripts > Utility > SmoothyEdit Bridge';
  }
}

// ========================================
// Update Functions
// ========================================

function manualCheckForUpdates() {
  checkUpdateBtn.disabled = true;
  checkUpdateBtn.textContent = 'Checking...';
  settingsUpdateStatus.textContent = 'Checking for updates...';
  window.electronAPI.checkForUpdates();

  // Re-enable after 10s in case no response comes back
  setTimeout(() => {
    if (checkUpdateBtn.textContent === 'Checking...') {
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = 'Check for Updates';
      settingsUpdateStatus.textContent = 'No updates found';
    }
  }, 10000);
}

// ========================================
// Theme Functions
// ========================================

// Single brand theme — cream background, black ink, lime action. No picker.
const THEME = 'cream';

function initTheme() {
  applyTheme();
}

function applyTheme() {
  state.currentTheme = THEME;
  document.documentElement.classList.add(`theme-${THEME}`);
  localStorage.setItem('smoothyedit-theme', THEME);

  // Remember for next launch's window background colour
  if (window.electronAPI?.saveThemeLocal) {
    window.electronAPI.saveThemeLocal(THEME);
  }
}

// ========================================
// Always on Top (Pin) Functions
// ========================================

async function initAlwaysOnTop() {
  const result = await window.electronAPI.getAlwaysOnTop();
  updatePinButton(result.alwaysOnTop);
}

function updatePinButton(isOnTop) {
  if (isOnTop) {
    pinBtn.classList.add('active');
    pinBtn.title = 'Unpin Window';
  } else {
    pinBtn.classList.remove('active');
    pinBtn.title = 'Stay on Top';
  }
}

async function toggleAlwaysOnTop() {
  const result = await window.electronAPI.toggleAlwaysOnTop();
  updatePinButton(result.alwaysOnTop);
}

function setupPinListener() {
  pinBtn.addEventListener('click', toggleAlwaysOnTop);
}

// ========================================
// Platform Detection
// ========================================

function applyPlatformStyles(platformInfo) {
  // Remove any existing platform classes
  document.body.classList.remove('platform-windows', 'platform-macos');

  if (platformInfo.isWindows) {
    document.body.classList.add('platform-windows');
    console.log('[Platform] Windows detected - applying Windows styles');
    // Update platform-specific button text
    const revealBtn = document.getElementById('resolve-reveal-btn');
    if (revealBtn) revealBtn.textContent = 'Reveal in File Explorer';
  } else if (platformInfo.isMac) {
    document.body.classList.add('platform-macos');
    console.log('[Platform] macOS detected - applying macOS styles');
    // Update platform-specific button text
    const revealBtn = document.getElementById('resolve-reveal-btn');
    if (revealBtn) revealBtn.textContent = 'Reveal in Finder';
  }
}

function detectPlatformFallback() {
  // Fallback detection using navigator if platform info hasn't been received
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('win')) {
    applyPlatformStyles({ isWindows: true, isMac: false });
  } else if (userAgent.includes('mac')) {
    applyPlatformStyles({ isWindows: false, isMac: true });
  }
}

// ========================================
// Compressor Tab Functions
// ========================================

const compressorState = {
  currentSourcePath: null,
  currentSourceType: null,
  sourceName: null,
  videoFiles: [],
  outputFolder: null,
  quality: 'high',
  hardwareInfo: null,
  isCompressing: false,
  compressionResults: [],
  lastBatchResult: null,
  settings: {
    quality: 'high',
    encoder: 'auto'
  }
};

// Load saved settings
function loadCompressorSettings() {
  const saved = localStorage.getItem('compressorSettings');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      compressorState.settings = { ...compressorState.settings, ...parsed };
      compressorState.quality = compressorState.settings.quality;
    } catch (e) {
      console.error('Failed to load compressor settings:', e);
    }
  }
}

function saveCompressorSettings() {
  localStorage.setItem('compressorSettings', JSON.stringify({
    quality: compressorState.quality,
    encoder: 'auto'
  }));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function fileNameFromPath(filePath) {
  return (filePath || '').split(/[\\/]/).pop() || filePath || 'Unknown file';
}

async function initCompressor() {
  loadCompressorSettings();
  setupCompressorListeners();
  setupCompressorIPCListeners();

  // Detect hardware on init
  try {
    compressorState.hardwareInfo = await window.electronAPI.compressorDetectHardware();
    updateCompressorHardwareUI();
  } catch (e) {
    console.error('Failed to detect hardware:', e);
  }

  // Update quality button states
  updateQualityButtons();
}

function setupCompressorListeners() {
  // Drop zone
  const dropZone = document.getElementById('compressor-drop-zone');
  const browseBtn = document.getElementById('compressor-browse-btn');
  const changeFolderBtn = document.getElementById('compressor-change-folder-btn');
  const changeOutputBtn = document.getElementById('compressor-change-output-btn');
  const startBtn = document.getElementById('compressor-start-btn');
  const cancelBtn = document.getElementById('compressor-cancel-btn');
  const qualityButtons = document.querySelectorAll('#compressor-quality-group .toggle-btn');

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');

    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.path) {
      await selectCompressorSource(file.path);
    }
  });

  dropZone.addEventListener('click', () => {
    browseCompressorSource();
  });

  browseBtn.addEventListener('click', () => {
    browseCompressorSource();
  });

  changeFolderBtn.addEventListener('click', () => {
    browseCompressorSource();
  });

  if (changeOutputBtn) changeOutputBtn.addEventListener('click', () => {
    changeOutputFolder();
  });

  startBtn.addEventListener('click', () => {
    startCompression();
  });

  cancelBtn.addEventListener('click', () => {
    cancelCompression();
  });

  // Quality buttons
  qualityButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      compressorState.quality = btn.dataset.value;
      compressorState.settings.quality = btn.dataset.value;
      saveCompressorSettings();
      updateQualityButtons();
      updateQualityHelp();
    });
  });
}

function setupCompressorIPCListeners() {
  // Progress updates
  window.electronAPI.onCompressorProgress((progress) => {
    updateCompressorProgress(progress);
  });

  // Hardware detected
  window.electronAPI.onCompressorHardwareDetected((hardware) => {
    compressorState.hardwareInfo = hardware;
    updateCompressorHardwareUI();
  });

  // Stats update
  window.electronAPI.onCompressorStatsUpdate((stats) => {
    updateCompressorStats(stats);
  });

  // Complete
  window.electronAPI.onCompressorComplete((results) => {
    compressionComplete(results);
  });
}

async function browseCompressorFolder() {
  return browseCompressorSource();
}

async function browseCompressorSource() {
  try {
    const result = window.electronAPI.compressorSelectSource
      ? await window.electronAPI.compressorSelectSource()
      : await window.electronAPI.compressorSelectFolder();
    if (!result.canceled && result.path) {
      await selectCompressorSource(result.path);
    }
  } catch (e) {
    console.error('Failed to browse source:', e);
    showCompressorError('Failed to open video or folder browser');
  }
}

async function selectCompressorFolder(folderPath) {
  return selectCompressorSource(folderPath);
}

async function selectCompressorSource(sourcePath) {
  compressorState.currentSourcePath = sourcePath;
  compressorState.currentSourceType = null;
  compressorState.sourceName = null;
  compressorState.outputFolder = null;
  compressorState.videoFiles = [];
  compressorState.compressionResults = [];
  compressorState.lastBatchResult = null;
  updateCompressorUI();

  try {
    const scan = window.electronAPI.compressorScanSource
      ? await window.electronAPI.compressorScanSource(sourcePath)
      : {
          sourcePath,
          sourceType: 'folder',
          sourceName: fileNameFromPath(sourcePath),
          outputFolder: '_compressed',
          files: await window.electronAPI.compressorScanDirectory(sourcePath)
        };

    compressorState.currentSourcePath = scan.sourcePath;
    compressorState.currentSourceType = scan.sourceType;
    compressorState.sourceName = scan.sourceName;
    compressorState.outputFolder = scan.outputFolder;
    compressorState.videoFiles = scan.files || [];
    updateCompressorUI();
  } catch (e) {
    console.error('Failed to scan source:', e);
    showCompressorError('Failed to scan selected video or folder');
  }
}

async function changeOutputFolder() {
  try {
    const result = await window.electronAPI.compressorSelectOutputFolder(compressorState.currentFolder);
    if (!result.canceled && result.path) {
      compressorState.outputFolder = result.path;
      compressorState.settings.outputFolder = result.path;
      saveCompressorSettings();
      updateCompressorUI();
    }
  } catch (e) {
    console.error('Failed to select output folder:', e);
    showCompressorError('Failed to select output folder');
  }
}

function updateCompressorUI() {
  const dropSection = document.getElementById('compressor-drop-section');
  const folderSection = document.getElementById('compressor-folder-section');
  const filesSection = document.getElementById('compressor-files-section');
  const hardwareSection = document.getElementById('compressor-hardware-section');
  const settingsSection = document.getElementById('compressor-settings-section');
  const startBtn = document.getElementById('compressor-start-btn');
  const footerStatus = document.getElementById('compressor-footer-status');

  if (compressorState.currentSourcePath) {
    dropSection.classList.add('hidden');
    folderSection.classList.remove('hidden');
    filesSection.classList.remove('hidden');
    hardwareSection.classList.remove('hidden');
    settingsSection.classList.remove('hidden');

    const sourceHeading = document.getElementById('compressor-source-heading');
    if (sourceHeading) {
      sourceHeading.textContent = compressorState.currentSourceType === 'file' ? 'Selected Video' : 'Selected Folder';
    }

    document.getElementById('compressor-folder-path').textContent = compressorState.currentSourcePath;

    // Check for large files
    const largeFiles = compressorState.videoFiles.filter(f => f.size > 10 * 1024 * 1024 * 1024);
    const largeWarning = document.getElementById('compressor-large-file-warning');
    if (largeFiles.length > 0) {
      largeWarning.classList.remove('hidden');
    } else {
      largeWarning.classList.add('hidden');
    }

    // Update files list
    const filesList = document.getElementById('compressor-files-list');
    const filesCount = document.getElementById('compressor-files-count');

    if (compressorState.videoFiles.length === 0) {
      filesList.innerHTML = '<p class="empty-message">No video files found in this folder</p>';
      filesCount.textContent = '0 files';
      startBtn.disabled = true;
      footerStatus.textContent = compressorState.currentSourceType === 'file'
        ? 'Selected file is not a supported video'
        : 'No top-level video files found';
    } else {
      const totalSize = compressorState.videoFiles.reduce((sum, f) => sum + f.size, 0);
      filesCount.textContent = `${compressorState.videoFiles.length} files (${formatBytes(totalSize)})`;

      filesList.innerHTML = compressorState.videoFiles.map(file => `
        <div class="compressor-file-item">
          <span class="compressor-file-name">${escapeHtml(file.name)}</span>
          <span class="compressor-file-size">${formatBytes(file.size)}</span>
        </div>
      `).join('');

      startBtn.disabled = compressorState.isCompressing;
      footerStatus.textContent = `Ready to compress ${compressorState.videoFiles.length} video file${compressorState.videoFiles.length === 1 ? '' : 's'} to HEVC MP4`;
    }

    // Update output path
    document.getElementById('compressor-output-path').textContent = compressorState.outputFolder || 'Output folder will be created automatically';

  } else {
    dropSection.classList.remove('hidden');
    folderSection.classList.add('hidden');
    filesSection.classList.add('hidden');
    hardwareSection.classList.add('hidden');
    settingsSection.classList.add('hidden');
    startBtn.disabled = true;
    footerStatus.textContent = 'Select a video or folder to begin';
  }
}

function updateCompressorHardwareUI() {
  const hardwareDot = document.getElementById('compressor-hardware-dot');
  const hardwareName = document.getElementById('compressor-hardware-name');
  const hardwareSystem = document.getElementById('compressor-hardware-system');
  const hardwareEncoder = document.getElementById('compressor-hardware-encoder');
  const hardwareAcceleration = document.getElementById('compressor-hardware-acceleration');
  const hardwareHelp = document.getElementById('compressor-hardware-help');

  if (compressorState.hardwareInfo) {
    hardwareName.textContent = compressorState.hardwareInfo.name;
    hardwareSystem.textContent = compressorState.hardwareInfo.systemName || 'Unknown';
    hardwareEncoder.textContent = compressorState.hardwareInfo.encoderName || compressorState.hardwareInfo.encoder || 'Unknown';
    hardwareAcceleration.textContent = compressorState.hardwareInfo.isHardwareAccelerated ? 'Hardware' : 'CPU fallback';

    if (compressorState.hardwareInfo.isHardwareAccelerated) {
      hardwareDot.classList.remove('disconnected');
      hardwareDot.classList.add('connected');
      hardwareHelp.textContent = `Hardware acceleration active - FFmpeg will use ${compressorState.hardwareInfo.name}`;
    } else if (compressorState.hardwareInfo.fallbackUsed) {
      hardwareDot.classList.remove('connected');
      hardwareDot.classList.add('disconnected');
      hardwareHelp.textContent = 'Hardware encoder failed; continuing with CPU libx265 HEVC fallback';
    } else {
      hardwareDot.classList.remove('connected');
      hardwareDot.classList.add('disconnected');
      hardwareHelp.textContent = 'No hardware HEVC encoder detected - using CPU libx265 HEVC';
    }
  }
}

function updateQualityButtons() {
  const buttons = document.querySelectorAll('#compressor-quality-group .toggle-btn');
  buttons.forEach(btn => {
    if (btn.dataset.value === compressorState.quality) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function updateQualityHelp() {
  const help = document.getElementById('compressor-quality-help');
  const qualityMap = {
    high: 'High: Near-original quality, larger files, slower encoding',
    balanced: 'Balanced: Quality-first compression with smaller files',
    fast: 'Fast: More compression, still prioritizes usable quality'
  };
  help.textContent = qualityMap[compressorState.quality];
}

async function startCompression() {
  if (compressorState.videoFiles.length === 0) return;

  const ffmpegAvailable = await window.electronAPI.compressorCheckFFmpeg();
  if (!ffmpegAvailable) {
    showCompressorError('FFmpeg is not available. Please reinstall the app or install FFmpeg on your system.');
    return;
  }

  compressorState.isCompressing = true;
  compressorState.compressionResults = [];
  compressorState.lastBatchResult = null;

  // Update UI
  document.getElementById('compressor-progress-section').classList.remove('hidden');
  document.getElementById('compressor-results-section').classList.add('hidden');
  document.getElementById('compressor-start-btn').disabled = true;
  document.getElementById('compressor-settings-section').classList.add('hidden');
  document.getElementById('compressor-footer-status').textContent = 'Compressing videos...';
  document.getElementById('compressor-progress-fill').style.width = '0%';
  document.getElementById('compressor-current-file').textContent = 'Preparing...';
  document.getElementById('compressor-file-progress').textContent = `0/${compressorState.videoFiles.length}`;
  document.getElementById('compressor-fps').textContent = '-- fps';
  document.getElementById('compressor-speed').textContent = '--x';
  document.getElementById('compressor-time').textContent = '--:--';

  // Prepare settings
  const settings = {
    encoder: 'auto',
    quality: compressorState.quality,
    outputFolder: compressorState.outputFolder,
    sourcePath: compressorState.currentSourcePath,
    sourceType: compressorState.currentSourceType
  };

  try {
    const result = await window.electronAPI.compressorStart(
      compressorState.videoFiles,
      settings
    );

    if (!result.success) {
      compressorState.isCompressing = false;
      document.getElementById('compressor-start-btn').disabled = false;
      document.getElementById('compressor-settings-section').classList.remove('hidden');
      showCompressorError(result.error || 'Compression failed');
    }
  } catch (e) {
    console.error('Compression error:', e);
    compressorState.isCompressing = false;
    document.getElementById('compressor-start-btn').disabled = false;
    document.getElementById('compressor-settings-section').classList.remove('hidden');
    showCompressorError('Failed to start compression');
  }
}

function updateCompressorProgress(progress) {
  const progressFill = document.getElementById('compressor-progress-fill');
  const currentFile = document.getElementById('compressor-current-file');
  const fileProgress = document.getElementById('compressor-file-progress');
  const fps = document.getElementById('compressor-fps');
  const speed = document.getElementById('compressor-speed');
  const time = document.getElementById('compressor-time');
  const statusBar = document.getElementById('compressor-status-bar');
  const statusText = document.getElementById('compressor-status-text');

  const visibleProgress = progress.overallProgress ?? progress.progress;
  progressFill.style.width = `${visibleProgress}%`;

  // Update file info
  currentFile.textContent = progress.fileName;
  fileProgress.textContent = `${progress.fileIndex + 1}/${progress.totalFiles}`;

  // Update details
  if (progress.fps) fps.textContent = `${progress.fps} fps`;
  if (progress.speed) speed.textContent = progress.speed;
  if (progress.time) time.textContent = progress.time;

  // Update status
  statusBar.className = 'status-bar status-processing';
  const action = progress.status === 'analyzing' ? 'Analyzing' : progress.status === 'queued' ? 'Preparing' : 'Compressing';
  const usingText = progress.encoderName ? ` - Using ${progress.encoderName}` : '';
  const fallbackText = progress.fallbackUsed ? ' (CPU fallback)' : '';
  statusText.textContent = `${action} ${progress.fileName} (${progress.progress}%)${usingText}${fallbackText}`;
}

function updateCompressorStats(stats) {
  // Update can be shown in real-time if needed
}

function compressionComplete(payload) {
  const batch = Array.isArray(payload)
    ? {
        results: payload,
        stats: null,
        hardware: compressorState.hardwareInfo,
        outputFolder: compressorState.outputFolder,
        elapsedMs: 0,
        fallbackUsed: false,
        canceled: false
      }
    : payload;

  const results = batch.results || [];
  compressorState.isCompressing = false;
  compressorState.compressionResults = results;
  compressorState.lastBatchResult = batch;

  // Hide progress, show results
  document.getElementById('compressor-progress-section').classList.add('hidden');
  document.getElementById('compressor-results-section').classList.remove('hidden');
  document.getElementById('compressor-settings-section').classList.remove('hidden');
  document.getElementById('compressor-start-btn').disabled = false;

  // Calculate totals
  const successful = results.filter(r => r.success && !r.skipped && !r.canceled);
  const failed = results.filter(r => !r.success);
  const skipped = results.filter(r => r.skipped);
  const canceled = results.filter(r => r.canceled);

  const totalInput = successful.reduce((sum, r) => sum + r.inputSize, 0);
  const totalOutput = successful.reduce((sum, r) => sum + r.outputSize, 0);
  const bytesSaved = totalInput - totalOutput;
  const savings = totalInput > 0 ? ((totalInput - totalOutput) / totalInput * 100).toFixed(1) : 0;
  const elapsedMs = batch.elapsedMs || successful.reduce((sum, r) => sum + (r.elapsedMs || 0), 0);
  const encoderName = batch.hardware?.name || successful[0]?.encoderName || compressorState.hardwareInfo?.name || 'Unknown';
  const outputFolder = batch.outputFolder || compressorState.outputFolder || 'Unknown output folder';

  // Update stats
  document.getElementById('compressor-stat-files').textContent = successful.length;
  document.getElementById('compressor-stat-input').textContent = formatBytes(totalInput);
  document.getElementById('compressor-stat-output').textContent = formatBytes(totalOutput);
  document.getElementById('compressor-stat-saved').textContent = `${formatBytes(Math.max(bytesSaved, 0))} (${savings}%)`;
  document.getElementById('compressor-stat-time').textContent = formatDurationMs(elapsedMs);
  document.getElementById('compressor-stat-encoder').textContent = encoderName;
  document.getElementById('compressor-results-summary').textContent =
    `Output: ${outputFolder} | Saved ${formatBytes(Math.max(bytesSaved, 0))} (${savings}%) in ${formatDurationMs(elapsedMs)} using ${encoderName}`;

  // Update results list
  const resultsList = document.getElementById('compressor-results-list');
  resultsList.innerHTML = results.map(result => {
    let statusClass = 'success';
    let statusText = result.compressionRatio >= 0
      ? `Saved ${result.compressionRatio.toFixed(1)}%`
      : `${Math.abs(result.compressionRatio).toFixed(1)}% larger`;

    if (result.skipped) {
      statusClass = 'skipped';
      statusText = 'Skipped';
    } else if (result.canceled) {
      statusClass = 'skipped';
      statusText = 'Cancelled';
    } else if (!result.success) {
      statusClass = 'error';
      statusText = 'Failed';
    }

    // Extract filename from path
    const fileName = fileNameFromPath(result.inputPath);
    const outputName = result.outputName || fileNameFromPath(result.outputPath);
    const detailParts = [
      `${formatBytes(result.inputSize)} to ${formatBytes(result.outputSize)}`,
      outputName
    ];

    if (result.encoderName) detailParts.push(result.encoderName);
    if (result.fallbackUsed) detailParts.push('CPU fallback');
    if (!result.success && result.error) detailParts.push(result.error.slice(0, 140));

    return `
      <div class="result-item">
        <div class="result-info">
          <div class="result-name">${escapeHtml(fileName)}</div>
          <div class="result-details">${escapeHtml(detailParts.join(' | '))}</div>
        </div>
        <span class="compressor-file-status ${statusClass}">${statusText}</span>
      </div>
    `;
  }).join('');

  // Update status
  const statusBar = document.getElementById('compressor-status-bar');
  const statusText = document.getElementById('compressor-status-text');
  const footerStatus = document.getElementById('compressor-footer-status');

  if (batch.canceled || canceled.length > 0) {
    statusBar.className = 'status-bar status-idle';
    statusText.textContent = `Compression cancelled - ${successful.length} completed`;
  } else if (failed.length === 0) {
    statusBar.className = 'status-bar status-success';
    statusText.textContent = batch.fallbackUsed
      ? 'Compression complete with CPU fallback'
      : 'Compression complete!';
  } else if (successful.length === 0) {
    statusBar.className = 'status-bar status-error';
    statusText.textContent = 'All files failed to compress';
  } else {
    statusBar.className = 'status-bar status-idle';
    statusText.textContent = `Complete - ${successful.length} successful, ${failed.length} failed`;
  }

  footerStatus.textContent = `Compressed ${successful.length} file${successful.length === 1 ? '' : 's'} in ${formatDurationMs(elapsedMs)}, saved ${formatBytes(Math.max(bytesSaved, 0))} (${savings}%)`;
}

function cancelCompression() {
  window.electronAPI.compressorStop();
  compressorState.isCompressing = false;

  document.getElementById('compressor-progress-section').classList.add('hidden');
  document.getElementById('compressor-start-btn').disabled = false;
  document.getElementById('compressor-settings-section').classList.remove('hidden');

  const statusBar = document.getElementById('compressor-status-bar');
  const statusText = document.getElementById('compressor-status-text');
  statusBar.className = 'status-bar status-idle';
  statusText.textContent = 'Cancelling compression...';
}

function showCompressorError(message) {
  const statusBar = document.getElementById('compressor-status-bar');
  const statusText = document.getElementById('compressor-status-text');

  statusBar.className = 'status-bar status-error';
  statusText.textContent = message;

  // Also show in error modal
  showError(message);
}

// Initialize compressor when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initCompressor();
});

// Start
detectPlatformFallback(); // Apply initial platform detection
initTheme();
initAlwaysOnTop();
setupPinListener();
init();
