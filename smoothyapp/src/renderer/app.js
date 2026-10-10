/**
 * SmoothyEdit - Renderer Script
 */
import { findCaptionMatches, replaceCaptionMatches } from './caption-text-tools.js';
import { initCaptionFileInput } from './caption-file-input.js';
import { initStockFootage } from './stock-footage.js';
import { initAudioLibrary } from './audio-library.js';
import { initPhotos } from './photos.js';
import { initChat } from './chat.js';
import { initStudioText } from './studio-text.js';
import { initAccount } from './account.js';
import { initAppPreferences } from './app-preferences.js';
let photosTools = null;
let chatTools = null;
let studioTextTools = null;
let accountTools = null;
let studioEnabled = true;
let stockTools = null, audioTools = null;

const state = {
  isConnected: false,
  sequenceInfo: null,
  isProcessing: false,
  currentTab: 'multicam',
  studioMode: 'condense',
  isWebsiteConnected: false,
  isExporting: false,
  authState: null,
  trialStatus: null,
  currentTheme: 'cream',
  platform: 'unknown',
  captionResult: null,
  captionRaw: null,
  captionTransforms: { capitalize: false, removePunctuation: false },
  activeNLE: null,
  pendingUpdateNotes: null,
  updateModalOpen: false,
  appVersion: null,
  updateState: { status: 'idle', version: null, percent: 0, notes: null, notesLoading: false },
  captionSource: 'sequence',
  captionFilePath: null,
  isTranscribing: false,
  currentShorts: [],
  shortsView: 'workspace',
  shortsSource: 'sequence',
  shortsMode: 'multiple',
  shortsAudioPath: null,
  shortsTranscriptName: '',
  shortsYoutube: null,
  shortsSourceLoading: false,
  shortsResultName: ''
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
const captionsSourceSequence = document.getElementById('captions-source-sequence');
const captionsSourceFile = document.getElementById('captions-source-file');
const captionsFileRow = document.getElementById('captions-file-row');
const captionsFilePath = document.getElementById('captions-file-path');
const captionsFileBrowse = document.getElementById('captions-file-browse');
const captionsSequenceSection = document.getElementById('captions-sequence-section');
const captionsTracksSection = document.getElementById('captions-tracks-section');
const progressCancelBtn = document.getElementById('progress-cancel-btn');
const captionModelSelect = document.getElementById('caption-model-select');
const captionRecommendedModel = document.getElementById('caption-recommended-model');
const captionLanguageSelect = document.getElementById('caption-language-select');
const captionLanguageStatus = document.getElementById('caption-language-status');
const captionEngineSelect = document.getElementById('caption-engine-select');
const captionEngineStatus = document.getElementById('caption-engine-status');
// "Force GPU" means CUDA on Windows/Linux and Metal on Apple Silicon. Label the
// option to match the machine instead of always claiming CUDA.
const isMacApp = /Mac/i.test(navigator.userAgent);
const GPU_ENGINE_LABEL = isMacApp ? 'GPU (Metal)' : 'GPU (CUDA)';
const captionsCapitalizeBtn = document.getElementById('captions-capitalize-btn');
const captionsRemovePunctBtn = document.getElementById('captions-remove-punct-btn');

// Best Shorts DOM Elements
const bestshortsStatusBar = document.getElementById('bestshorts-status-bar');
const bestshortsStatusText = document.getElementById('bestshorts-status-text');
const bestshortsSequenceName = document.getElementById('bestshorts-sequence-name');
const bestshortsSequenceDetails = document.getElementById('bestshorts-sequence-details');
const bestshortsRefreshBtn = document.getElementById('bestshorts-refresh-btn');
const clearMarkersBtn = document.getElementById('clear-markers-btn');
const bestshortsFooterStatus = document.getElementById('bestshorts-footer-status');
const websiteStatusDot = document.getElementById('website-status-dot');
const websiteStatusText = document.getElementById('website-status-text');
const websiteHelpText = document.getElementById('website-help-text');

// Settings DOM Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsBody = document.getElementById('settings-body');
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
const cepPathInput = document.getElementById('cep-path-input');
const cepBrowseBtn = document.getElementById('cep-browse-btn');
const cepResetBtn = document.getElementById('cep-reset-btn');
const cepInstallBtn = document.getElementById('cep-install-btn');

// NLE Selector DOM Elements
const nleAutoBtn = document.getElementById('nle-auto-btn');
const nlePremiereBtn = document.getElementById('nle-premiere-btn');
const nleStatusText = document.getElementById('nle-status-text');
const connectionNleLabel = document.getElementById('connection-nle-label');

// Update Settings DOM Elements
const checkUpdateBtn = document.getElementById('check-update-btn');
const settingsUpdateStatus = document.getElementById('settings-update-status');
const settingsInstallUpdateBtn = document.getElementById('settings-install-update-btn');
const settingsUpdateNotes = document.getElementById('settings-update-notes');
const settingsCurrentVersion = document.getElementById('settings-current-version');
const sidebarVersion = document.getElementById('sidebar-version');
const discordBtn = document.getElementById('discord-btn');
const instagramBtn = document.getElementById('instagram-btn');
const settingsDiscordBtn = document.getElementById('settings-discord-btn');
const settingsTwitterBtn = document.getElementById('settings-twitter-btn');
const settingsInstagramBtn = document.getElementById('settings-instagram-btn');
const settingsLinkedinBtn = document.getElementById('settings-linkedin-btn');
const settingsWebsiteBtn = document.getElementById('settings-website-btn');

// Logs DOM Elements
const logsContainer = document.getElementById('logs-container');
const logsClearBtn = document.getElementById('logs-clear-btn');

// Auth DOM Elements
const userInfo = document.getElementById('user-info');
const studioCreditsInline = document.getElementById('studio-credits-inline');
const userName = document.getElementById('user-name');
const userPlan = document.getElementById('user-plan');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const loginModal = document.getElementById('login-modal');

// Feature lock overlays (multicam lock removed — free forever; bestshorts = Studio AI upsell)
const multicamLock = document.getElementById('multicam-lock');
const bestshortsLock = document.getElementById('bestshorts-lock');

// Pin (Always on Top) DOM Elements
const pinBtn = document.getElementById('pin-btn');

// Initialize
async function init() {
  setupWindowTitlebar();
  setupSidebar();
  setupSettingsLayout();
  accountTools = initAccount({ getUser: () => state.authState?.user, enabled: () => studioEnabled, onSignedIn: initAuth });
  setupEventListeners();
  setupElectronListeners();
  setupStudioEvents();
  setupReviewUI();
  await setupPreferenceEvents();
  await initAppPreferences({ applyStudio: applyStudioPreference }).load();
  setupCaptionUpdateNotice();

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

  // Show the real app version (never hardcode it again)
  try {
    const version = await window.electronAPI.getAppVersion();
    if (version) {
      const label = `v${version}`;
      if (settingsCurrentVersion) settingsCurrentVersion.textContent = label;
      if (sidebarVersion) {
        sidebarVersion.textContent = label;
        sidebarVersion.title = `SmoothyEdit ${label}`;
      }
      state.appVersion = version;
    }
  } catch {}

  try { applyUpdateState(await window.electronAPI.getUpdateState()); } catch {}

  // Caption model list + engine status
  loadCaptionModels();
  loadCaptionLanguages();
  loadCaptionEnginePreference();

  // Assets (SVG / image -> PNG) tab
  initAssets();
  stockTools = initStockFootage({ isConnected: () => state.isConnected });
  audioTools = initAudioLibrary({ isConnected: () => state.isConnected });
  chatTools = initChat({ getUser: () => studioEnabled ? state.authState?.user : null, signIn: openLoginModal, refreshCredits: refreshStudioCredits });
  photosTools = initPhotos({ getUser: () => studioEnabled ? state.authState?.user : null, signIn: openLoginModal, refreshCredits: refreshStudioCredits });
  studioTextTools = initStudioText({ getUser: () => state.authState?.user, enabled: () => studioEnabled, signIn: openLoginModal, refreshCredits: refreshStudioCredits,
    getInputConfig: () => ({ source: state.shortsSource, subtitleText: document.getElementById('studio-text-input').value, fileName: state.shortsTranscriptName, audioPath: state.shortsAudioPath, ...(state.shortsSource === 'youtube' ? state.shortsYoutube || {} : {}) }),
    getWorkspace: () => ({ mode: state.studioMode, busy: state.isProcessing || state.shortsSourceLoading, history: state.studioMode === 'shorts' && state.shortsView === 'history', connected: state.isConnected && state.sequenceInfo?.hasSequence }),
    onSource: (text, name) => { state.shortsTranscriptName = name; updateExportButton(); },
    runShorts: runStudioShorts,
    onStateChange: syncStudioToolButtons,
    selectChannel: mode => {
      state.studioMode = mode;
      syncStudioToolButtons();
      updateWindowTitlebar();
    },
  });
}

function setupWindowTitlebar() {
  const titlebar = document.querySelector('.window-titlebar');
  document.querySelectorAll('.tab-content').forEach(tab => {
    let bar = tab.querySelector(':scope > .status-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'status-bar status-idle';
      const name = document.createElement('span');
      name.dataset.windowToolName = '';
      bar.append(name);
    }
    bar.dataset.windowTab = tab.id.slice(4);
    titlebar.append(bar);
  });
  updateWindowTitlebar();
}

function updateWindowTitlebar() {
  const selected = document.querySelector('.nav-item.active');
  const studioTool = ['studio-text', 'bestshorts'].includes(state.currentTab) ? document.querySelector(`[data-studio-mode="${state.studioMode}"]`) : null;
  const label = studioTool ? `Studio · ${studioTool.textContent.trim()}` : selected?.querySelector('.nav-label')?.textContent || 'SmoothyEdit';
  const accent = studioTool ? getComputedStyle(studioTool).getPropertyValue('--tool-color').trim() : selected && getComputedStyle(selected).getPropertyValue('--tab-accent').trim();
  document.querySelector('.window-titlebar').style.setProperty('--window-accent', accent || '#E6E4DF');
  document.querySelectorAll('.window-titlebar > .status-bar').forEach(bar => {
    bar.dataset.windowActive = String(bar.dataset.windowTab === state.currentTab);
    const name = bar.querySelector('[data-window-tool-name]');
    if (name) name.textContent = label;
  });
}

function syncStudioToolButtons() {
  const busy = state.isProcessing || state.shortsSourceLoading || studioTextTools?.isBusy();
  document.getElementById('studio-compose-footer').classList.toggle('shorts-mode', state.studioMode === 'shorts');
  document.querySelectorAll('[data-studio-mode]').forEach(button => {
    const active = button.dataset.studioMode === state.studioMode;
    button.setAttribute('aria-pressed', String(active)); button.disabled = Boolean(busy);
  });
  document.getElementById('studio-text-history-toggle').classList.toggle('hidden', state.studioMode === 'shorts');
  document.getElementById('shorts-history-btn').classList.toggle('hidden', state.studioMode !== 'shorts');
  document.querySelector('.shorts-footer-actions').classList.toggle('hidden', !studioEnabled || !state.authState?.user || state.studioMode !== 'shorts' || state.shortsView === 'history');
}

function activateStudioTool(mode = state.studioMode) {
  if (!studioEnabled || state.isProcessing || state.shortsSourceLoading || studioTextTools?.isBusy()) return;
  const button = document.querySelector(`[data-studio-mode="${mode}"]`);
  if (!button) return;
  state.studioMode = mode;
  state.currentTab = mode === 'shorts' ? 'bestshorts' : 'studio-text';
  const channel = document.querySelector('.nav-item[data-tab="studio-text"]');
  document.querySelectorAll('.nav-item').forEach(item => { item.classList.toggle('active', item === channel); item.setAttribute('aria-current', item === channel ? 'page' : 'false'); });
  channel.scrollIntoView({ block: 'nearest' });
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.toggle('active', tab.id === `tab-${state.currentTab}`));
  document.getElementById(`tab-${state.currentTab}`).prepend(document.getElementById('studio-workspace-header'));
  document.getElementById(`tab-${state.currentTab}`).append(document.getElementById('studio-compose-footer'));
  studioTextTools?.refresh();
  if (mode === 'shorts') {
    document.getElementById('studio-workspace-description').textContent = 'Suggest source ranges for a shorter edit. You arrange the footage and make the final cut.';
    if (state.sequenceInfo) displayBestshortsSequenceInfo(state.sequenceInfo);
    studioTextTools?.refresh(); setShortsView(state.shortsView); refreshStudioCredits();
    if (state.shortsView === 'history') loadShortsHistory();
  } else studioTextTools?.activate(mode);
  syncStudioToolButtons(); updateWindowTitlebar();
}

function applyStudioPreference(enabled, changed) {
  studioEnabled = enabled;
  document.querySelector('.app-container').classList.toggle('studio-disabled', !enabled);
  if (!enabled && ['photos', 'chat', 'studio-text', 'bestshorts'].includes(state.currentTab)) document.querySelector('.nav-item[data-tab="multicam"]').click();
  accountTools?.authChanged();
  if (changed) { photosTools?.authChanged(); chatTools?.authChanged(); studioTextTools?.authChanged(); if (enabled) refreshStudioCredits(); }
  document.getElementById('tool-search').dispatchEvent(new Event('input'));
}

function setupCaptionUpdateNotice() {
  const notice = document.getElementById('caption-update-notice');
  const dismissedKey = 'smoothyedit:arabic-captions:2026-10-09:dismissed';
  let dismissed = false;
  try { dismissed = localStorage.getItem(dismissedKey) === 'true'; } catch {}
  notice.classList.toggle('hidden', dismissed);
  document.getElementById('caption-update-dismiss').addEventListener('click', () => {
    try { localStorage.setItem(dismissedKey, 'true'); } catch {}
    notice.classList.add('hidden');
    captionLanguageSelect.focus();
  });
  notice.querySelectorAll('[data-caption-support]').forEach(link => {
    link.addEventListener('click', event => { event.preventDefault(); window.electronAPI.openExternal(link.href); });
  });
}

function setupSidebar() {
  const container = document.querySelector('.app-container');
  const toggle = document.getElementById('sidebar-toggle-btn');
  document.querySelector('[data-channel-group="studio"] .channel-group-name').textContent = 'AI Tools';
  const studioNav = document.querySelector('#channels-studio [data-tab="studio-text"]');
  studioNav.querySelector('.nav-label').textContent = 'Studio';
  studioNav.setAttribute('aria-label', 'Studio · Shorts, Condense, Hooks, Titles, Descriptions, Thumbnails, B-roll, Social, Blog, SFX');
  document.querySelector('#channels-studio [data-tab="chat"] .nav-icon svg').innerHTML = '<path d="M19 11a7 7 0 0 1-7 7H7l-4 3V10a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7z"/><path d="M8 9h8M8 13h5"/>';
  for (const [tab, label] of [['photos', 'AI Photos · uses Studio credits · generate, edit, reactions, image history'], ['chat', 'Chat · uses Studio credits']]) {
    const item = document.querySelector(`#channels-studio [data-tab="${tab}"]`);
    item.setAttribute('aria-label', label);
    if (!item.querySelector('.paid-badge')) {
      const badge = document.createElement('span');
      badge.className = 'paid-badge';
      badge.textContent = 'Credits';
      item.append(badge);
    }
  }
  const applyCollapsed = (collapsed) => {
    container.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  document.querySelectorAll('.sidebar-nav .nav-item, .studio-dashboard-btn').forEach(item => {
    const label = item.querySelector('.nav-label').textContent.trim();
    item.setAttribute('aria-label', item.getAttribute('aria-label') || label);
    if (!item.title) item.title = label + (['bestshorts', 'photos', 'chat'].includes(item.dataset.tab) ? ' (uses credits)' : '');
    if (item.classList.contains('nav-item')) item.setAttribute('aria-current', item.classList.contains('active') ? 'page' : 'false');
  });
  let collapsed = false;
  try { collapsed = localStorage.getItem('sidebarCollapsed') === 'true'; } catch {}
  applyCollapsed(collapsed);
  toggle.addEventListener('click', () => {
    container.classList.add('sidebar-motion');
    const collapsed = !container.classList.contains('sidebar-collapsed');
    applyCollapsed(collapsed);
    try { localStorage.setItem('sidebarCollapsed', String(collapsed)); } catch {}
  });
  const search = document.getElementById('tool-search');
  const groups = [...document.querySelectorAll('.channel-group')];
  let folded = {};
  try { folded = JSON.parse(localStorage.getItem('toolChannelGroups') || '{}'); } catch {}
  if (!folded || typeof folded !== 'object' || Array.isArray(folded)) folded = {};
  const filter = () => {
    const query = search.value.trim().toLowerCase(); let matches = 0;
    groups.forEach(group => {
      const button = group.querySelector('.channel-group-toggle');
      const items = [...group.querySelectorAll('.nav-item, .studio-dashboard-btn')];
      let count = 0;
      items.forEach(item => {
        const available = studioEnabled || !['studio', 'photos'].includes(group.dataset.channelGroup);
        const match = available && (!query || `${group.querySelector('.channel-group-name').textContent} ${item.getAttribute('aria-label')}`.toLowerCase().includes(query));
        item.classList.toggle('tool-filter-hidden', !match); if (match) count++;
      });
      matches += count; group.classList.toggle('tool-filter-hidden', count === 0);
      const collapsed = !query && folded[group.dataset.foldKey || group.dataset.channelGroup] === true;
      group.classList.toggle('channel-folded', collapsed); button.setAttribute('aria-expanded', String(!collapsed));
    });
    document.getElementById('tool-search-empty').classList.toggle('hidden', matches > 0);
  };
  groups.forEach(group => group.querySelector('.channel-group-toggle').addEventListener('click', () => {
    if (search.value) { search.value = ''; }
    const key = group.dataset.foldKey || group.dataset.channelGroup; folded[key] = !folded[key];
    try { localStorage.setItem('toolChannelGroups', JSON.stringify(folded)); } catch {}
    filter();
  }));
  search.addEventListener('input', filter);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { search.value = ''; filter(); search.blur(); document.querySelector('.sidebar-nav .nav-item.active')?.scrollIntoView({ block: 'nearest' }); }
    if (event.key === 'Enter') { const first = [...document.querySelectorAll('.sidebar-nav .nav-item, .studio-dashboard-btn')].find(item => item.getClientRects().length && !item.closest('.tool-filter-hidden') && !item.classList.contains('tool-filter-hidden') && !item.classList.contains('hidden')); if (first) { first.click(); first.focus(); } }
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      if (document.querySelector('dialog[open], .modal:not(.hidden)')) return;
      event.preventDefault(); applyCollapsed(false);
      try { localStorage.setItem('sidebarCollapsed', 'false'); } catch {}
      search.focus(); search.select();
    }
  });
  document.querySelector('.tool-search-shortcut').textContent = navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl K';
  filter();
}

function setupSettingsLayout() {
  const body = document.getElementById('settings-body');
  const sections = [...body.children].filter(element => element.classList.contains('settings-section'));
  const visibleSections = sections.filter(section => !section.classList.contains('hidden'));
  const hiddenSections = sections.filter(section => section.classList.contains('hidden'));
  const columns = [document.createElement('div'), document.createElement('div')];
  columns.forEach(column => { column.className = 'settings-column'; });
  let compact = null;
  const arrange = () => {
    const nextCompact = window.innerWidth <= 800;
    if (nextCompact === compact) return;
    compact = nextCompact;
    if (compact) {
      body.replaceChildren(...sections);
      return;
    }
    columns[0].replaceChildren(...visibleSections.filter((_, index) => index % 2 === 0));
    columns[1].replaceChildren(...visibleSections.filter((_, index) => index % 2 === 1));
    body.replaceChildren(...columns, ...hiddenSections);
  };
  arrange();
  window.addEventListener('resize', arrange);
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
  refreshStudioCredits();
}

function updateAuthUI() {
  const { authState } = state;

  if (authState && authState.user) {
    // User is logged in (optional — only needed for Studio AI)
    userInfo.classList.remove('hidden');
    loginBtn.classList.add('hidden');
    studioCreditsInline.classList.remove('hidden');

    // Set user display
    const displayName = authState.user.name || authState.user.email.split('@')[0];
    userName.textContent = displayName;
    document.getElementById('sidebar-user-initial').textContent = Array.from(displayName)[0]?.toUpperCase() || '?';
    userInfo.title = displayName;
    if (userPlan) {
      userPlan.textContent = authState.user.tier === 'pro' ? 'Studio' : 'Free';
    }
  } else {
    // Studio has one sign-in control; local tools need no account.
    userInfo.classList.add('hidden');
    loginBtn.classList.remove('hidden');
    studioCreditsInline.classList.add('hidden');
  }
  syncShortsAccount();
  accountTools?.authChanged();
  photosTools?.authChanged(); chatTools?.authChanged();
  studioTextTools?.authChanged();
  requestAnimationFrame(() => document.querySelector('.sidebar-nav .nav-item.active')?.scrollIntoView({ block: 'nearest' }));
}

async function updateFeatureLocks() {
  // Multicam (autocut) is free forever — ensure legacy overlay stays hidden
  if (multicamLock) {
    multicamLock.classList.add('hidden');
  }

  // Shorts sign-in is a normal page, with one account dialog when needed.
  setShortsView(state.shortsView);
}

function openLoginModal() { accountTools?.open(); }

async function handleLogout() {
  await window.electronAPI.logout();
  await initAuth();
}

function setupEventListeners() {
  document.getElementById('update-bar-close').addEventListener('click', skipPendingUpdate);
  document.getElementById('update-bar-btn').addEventListener('click', () => showUpdateModal(state.updateState.version));
  document.getElementById('update-modal-close').addEventListener('click', closeUpdateModal);
  document.getElementById('update-modal-install').addEventListener('click', installPendingUpdate);
  document.getElementById('update-modal-later').addEventListener('click', skipPendingUpdate);
  document.getElementById('update-modal-release-link').addEventListener('click', () => {
    if (state.updateState.version) window.electronAPI.openExternal(`https://github.com/alibahrawy/smoothyapp/releases/tag/v${encodeURIComponent(state.updateState.version)}`);
  });
  document.getElementById('update-modal').addEventListener('click', event => {
    if (event.target.id === 'update-modal') closeUpdateModal();
  });

  // Tab navigation
  document.querySelectorAll('.nav-item:not(.disabled)').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;
      if (!studioEnabled && ['photos', 'chat', 'bestshorts', 'studio-text'].includes(tab)) return;
      if (tab === 'studio-text') {
        const query = document.getElementById('tool-search').value.trim().toLowerCase();
        const tools = [...document.querySelectorAll('[data-studio-mode]')];
        const match = query ? tools.find(button => button.textContent.toLowerCase().includes(query)) || tools.find(button => button.title.toLowerCase().includes(query)) : null;
        activateStudioTool(match?.dataset.studioMode || state.studioMode); return;
      }
      state.currentTab = tab;

      // Update active nav item
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      item.scrollIntoView({ block: 'nearest' });
      document.querySelectorAll('.nav-item').forEach(nav => nav.setAttribute('aria-current', nav === item ? 'page' : 'false'));
      updateWindowTitlebar();

      // Show corresponding tab content
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');
      if (tab === 'photos') photosTools?.activate();
      if (tab === 'chat') chatTools?.activate();

      // Update tabs if switching
      if (tab === 'silence' && state.sequenceInfo) {
        displaySilenceSequenceInfo(state.sequenceInfo);
      }
      if (tab === 'bestshorts') {
        if (state.sequenceInfo) displayBestshortsSequenceInfo(state.sequenceInfo);
        refreshStudioCredits();
        if (state.shortsView === 'history') loadShortsHistory();
      }
      if (tab === 'captions') {
        if (state.sequenceInfo) displayCaptionsSequenceInfo(state.sequenceInfo);
      }
    });
  });

  document.querySelectorAll('[data-studio-mode]').forEach(button => button.addEventListener('click', () => activateStudioTool(button.dataset.studioMode)));

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
  document.getElementById('edit-in-place').addEventListener('change', event => {
    document.getElementById('silence-action-note').textContent = event.target.checked
      ? 'Ripple-deletes silence directly from your current sequence. Each cut is a separate undo step.'
      : 'Creates a new sequence from source media. Existing effects and titles are not copied.';
  });

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

  if (captionsSourceSequence) captionsSourceSequence.addEventListener('click', () => setCaptionSource('sequence'));
  if (captionsSourceFile) captionsSourceFile.addEventListener('click', () => setCaptionSource('file'));
  initCaptionFileInput({
    api: window.electronAPI, root: document.getElementById('tab-captions'),
    zone: document.getElementById('captions-file-drop-zone'), browse: captionsFileBrowse,
    busy: () => state.isProcessing || state.isTranscribing,
    selected: filePath => {
      state.captionFilePath = filePath;
      if (captionsFilePath) captionsFilePath.value = filePath;
      setCaptionSource('file');
    }, error: showError
  });
  captionRecommendedModel?.addEventListener('click', async () => {
    if (state.isProcessing || state.isTranscribing) return;
    captionModelSelect.value = 'ggml-large-v3-turbo.bin';
    await onCaptionModelChange();
  });
  if (progressCancelBtn) progressCancelBtn.addEventListener('click', cancelCaptionGeneration);
  if (captionModelSelect) captionModelSelect.addEventListener('change', onCaptionModelChange);
  if (captionLanguageSelect) captionLanguageSelect.addEventListener('change', onCaptionLanguageChange);
  if (captionEngineSelect) captionEngineSelect.addEventListener('change', onCaptionEngineChange);
  if (captionsCapitalizeBtn) captionsCapitalizeBtn.addEventListener('click', () => toggleCaptionTransform('capitalize'));
  if (captionsRemovePunctBtn) captionsRemovePunctBtn.addEventListener('click', () => toggleCaptionTransform('removePunctuation'));

  document.getElementById('caption-max-chars').addEventListener('input', (e) => {
    document.getElementById('caption-max-chars-value').textContent = e.target.value;
  });

  document.querySelectorAll('#caption-max-lines-group .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#caption-max-lines-group .toggle-btn').forEach(b => {
        b.classList.remove('active'); b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  document.getElementById('caption-max-duration').addEventListener('input', (e) => {
    document.getElementById('caption-max-duration-value').textContent = `${e.target.value}s`;
  });

  // Best Shorts Tab
  bestshortsRefreshBtn.addEventListener('click', () => {
    studioTextTools?.invalidateSource();
    window.electronAPI.refreshSequence();
  });

  clearMarkersBtn.addEventListener('click', clearAllMarkers);

  // Settings Modal
  settingsBtn.addEventListener('click', openSettings);
  document.getElementById('settings-account-btn').addEventListener('click', () => { closeSettings(); if (state.authState?.user) window.electronAPI.openExternal('https://smoothyedit.com/settings'); else openLoginModal(); });
  document.querySelectorAll('[data-account-page]').forEach(button => button.addEventListener('click', () => {
    closeSettings(); if (state.authState?.user) window.electronAPI.openExternal(`https://smoothyedit.com/${button.dataset.accountPage}`); else openLoginModal();
  }));
  settingsCloseBtn.addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (state.updateModalOpen) {
      if (e.key === 'Escape') closeUpdateModal();
      if (e.key === 'Tab') {
        const focusable = [...document.getElementById('update-modal').querySelectorAll('button')].filter(el => !el.disabled && el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      return;
    }
    if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
    if (e.key === 'Tab' && !settingsModal.classList.contains('hidden') && document.getElementById('error-modal').classList.contains('hidden')) {
      const focusable = [...settingsModal.querySelectorAll('button, input, select, summary, a[href]')].filter(element => !element.disabled && element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });

  saveTokenBtn.addEventListener('click', saveToken);
  connectWebsiteBtn.addEventListener('click', toggleWebsiteConnection);

  getTokenLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://smoothyedit.com/connection');
  });

  // Bridge settings
  cepBrowseBtn.addEventListener('click', browseCepPath);
  cepResetBtn.addEventListener('click', resetCepPath);
  cepInstallBtn.addEventListener('click', reinstallLegacyBridge);

  // NLE selector
  if (nleAutoBtn) {
    nleAutoBtn.addEventListener('click', () => setActiveNLE(null));
  }
  if (nlePremiereBtn) {
    nlePremiereBtn.addEventListener('click', () => setActiveNLE('premiere'));
  }

  // Check for updates button
  checkUpdateBtn.addEventListener('click', manualCheckForUpdates);
  if (settingsInstallUpdateBtn) {
    settingsInstallUpdateBtn.addEventListener('click', () => showUpdateModal(state.updateState.version));
  }
  if (discordBtn) {
    discordBtn.addEventListener('click', () => window.electronAPI.openExternal('https://discord.gg/KmJRqUZzDe'));
  }
  if (settingsDiscordBtn) {
    settingsDiscordBtn.addEventListener('click', () => window.electronAPI.openExternal('https://discord.gg/KmJRqUZzDe'));
  }
  if (settingsTwitterBtn) {
    settingsTwitterBtn.addEventListener('click', () => window.electronAPI.openExternal('https://x.com/alibahrawy34'));
  }
  document.getElementById('settings-smoothy-twitter-btn').addEventListener('click', () => window.electronAPI.openExternal('https://x.com/smoothyedit'));
  document.querySelectorAll('[data-feedback-kind]').forEach(button => {
    button.addEventListener('click', async () => {
      const drafts = {
        feedback: ['SmoothyEdit feedback', 'My feedback:\n'],
        feature: ['SmoothyEdit feature request', 'The feature I’d like to see:\n\nHow it would help my editing:\n'],
        bug: ['SmoothyEdit bug report', 'What happened:\n\nSteps to reproduce:\n\nWhat I expected:\n']
      };
      const [subject, prompt] = drafts[button.dataset.feedbackKind];
      const status = document.getElementById('settings-feedback-status');
      status.classList.add('hidden');
      button.disabled = true;
      try {
        await window.electronAPI.openExternal(`mailto:support@smoothyedit.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`SmoothyEdit v${state.appVersion || '?'}\n\n${prompt}`)}`);
      } catch {
        status.textContent = 'Could not open your email app. Email support@smoothyedit.com or use the Discord link below.';
        status.classList.remove('hidden');
      } finally { button.disabled = false; }
    });
  });
  settingsInstagramBtn.addEventListener('click', () => window.electronAPI.openExternal('https://www.instagram.com/alibahrawy34/'));
  instagramBtn.addEventListener('click', () => window.electronAPI.openExternal('https://www.instagram.com/alibahrawy34/'));
  settingsLinkedinBtn.addEventListener('click', () => window.electronAPI.openExternal('https://www.linkedin.com/in/alibahrawy/'));
  settingsWebsiteBtn.addEventListener('click', () => window.electronAPI.openExternal('https://www.alibahrawy.com/'));

  // Logs tab
  if (logsClearBtn) {
    logsClearBtn.addEventListener('click', () => {
      if (logsContainer) logsContainer.innerHTML = '';
    });
  }

  // Auth event listeners
  loginBtn.addEventListener('click', openLoginModal);
  logoutBtn.addEventListener('click', handleLogout);
  // Feature lock buttons
  const multicamUpgradeBtn = document.getElementById('multicam-upgrade-btn');
  const multicamLoginBtn = document.getElementById('multicam-login-btn');
  const bestshortsLoginBtn = document.getElementById('bestshorts-login-btn');

  if (multicamUpgradeBtn) {
    multicamUpgradeBtn.addEventListener('click', () => {
      window.electronAPI.openExternal('https://smoothyedit.com/pricing');
    });
  }
  if (multicamLoginBtn) {
    multicamLoginBtn.addEventListener('click', openLoginModal);
  }
  if (bestshortsLoginBtn) bestshortsLoginBtn.addEventListener('click', openLoginModal);

  // Open the Studio dashboard in the browser
  const studioDashboardBtn = document.getElementById('studio-dashboard-btn');
  const openStudioDashboardBtn = document.getElementById('open-studio-dashboard-btn');
  const settingsOpenStudioBtn = document.getElementById('settings-open-studio-btn');
  const openStudioDashboard = () => window.electronAPI.openExternal('https://smoothyedit.com/dashboard');
  studioDashboardBtn.addEventListener('click', openStudioDashboard);
  if (openStudioDashboardBtn) {
    openStudioDashboardBtn.addEventListener('click', openStudioDashboard);
  }
  if (settingsOpenStudioBtn) {
    settingsOpenStudioBtn.addEventListener('click', openStudioDashboard);
  }
}

// ─── Preferences ────────────────────────────────────────────────────────────
async function setupPreferenceEvents() {
  const toggle = document.getElementById('show-logs-toggle');
  let show = false;
  try {
    show = await window.electronAPI.getShowLogs();
  } catch {}
  if (toggle) toggle.checked = !!show;
  applyLogsVisibility(!!show);

  if (toggle) {
    toggle.addEventListener('change', async () => {
      applyLogsVisibility(toggle.checked);
      try { await window.electronAPI.setShowLogs(toggle.checked); } catch {}
    });
  }
}

// The Logs tab is hidden by default and only shown from Settings → Advanced.
function applyLogsVisibility(show) {
  const navItem = document.querySelector('.nav-item[data-tab="logs"]');
  const tab = document.getElementById('tab-logs');
  if (navItem) navItem.classList.toggle('hidden', !show);
  if (tab) tab.classList.toggle('hidden', !show);

  if (!show && state.currentTab === 'logs') {
    const fallback = document.querySelector('.nav-item[data-tab="multicam"]');
    if (fallback) fallback.click();
  }
}

// ─── Studio (cloud) — Best Shorts, credits, history ─────────────────────────
let shortsHistoryItems = [];
let shortsHistoryRequest = 0;
let shortsHistoryLoading = false;
let shortsHistoryError = '';
let shortsFlags = {};
let shortsAccountKey = '';

function setStudioSource(source, force = false) {
  if (!force && (state.isProcessing || state.shortsSourceLoading || studioTextTools?.isBusy())) return;
  if (state.shortsSource !== source) studioTextTools?.invalidateSource();
  state.shortsSource = source;
  const names = { sequence: 'Premiere', transcript: 'Subtitles', audio: 'Audio/Video', youtube: 'YouTube' };
  document.getElementById('studio-source-slider').style.setProperty('--source-index', Object.keys(names).indexOf(source));
  document.querySelectorAll('[data-shorts-source]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.shortsSource === source)));
  for (const kind of Object.keys(names)) document.getElementById(`shorts-source-${kind}`).classList.toggle('hidden', kind !== source);
  updateExportButton();
}

function setupStudioEvents() {
  const shortsActions = document.querySelector('#shorts-footer .shorts-footer-actions');
  document.getElementById('analyze-shorts-btn').after(shortsActions);
  shortsActions.classList.add('hidden');
  window.addEventListener('resize', updateExportButton);
  try {
    if (localStorage.getItem('shortsMode') === 'best') {
      state.shortsMode = 'best';
      document.querySelector('input[name="shorts-mode"][value="best"]').checked = true;
    }
  } catch {}
  document.getElementById('analyze-shorts-btn').addEventListener('click', runStudioShorts);
  document.getElementById('send-shorts-btn').addEventListener('click', (event) => sendShortsToPremiere(state.currentShorts, event.currentTarget));
  document.getElementById('shorts-history-btn').addEventListener('click', () => {
    setShortsView(state.shortsView === 'history' ? 'workspace' : 'history');
    if (state.shortsView === 'history') {
      loadShortsHistory();
      document.getElementById('shorts-history-search').focus();
    }
  });
  document.getElementById('shorts-history-refresh-btn').addEventListener('click', loadShortsHistory);
  document.getElementById('shorts-history-search').addEventListener('input', renderShortsHistory);
  document.querySelectorAll('[data-shorts-source]').forEach(button => button.addEventListener('click', () => setStudioSource(button.dataset.shortsSource)));
  document.getElementById('shorts-audio-browse').addEventListener('click', async () => {
    try {
      const account = shortsAccountKey;
      const result = await window.electronAPI.selectShortsAudio();
      if (account !== shortsAccountKey || !studioEnabled) return;
      if (result?.canceled || !result?.path) return;
      studioTextTools.invalidateSource();
      state.shortsAudioPath = result.path;
      document.getElementById('shorts-audio-name').textContent = result.path.split(/[\\/]/).pop();
      updateExportButton();
    } catch { showError('Could not choose an audio file.'); }
  });
  document.getElementById('shorts-youtube-load').addEventListener('click', loadShortsYoutube);
  document.getElementById('shorts-youtube-url').addEventListener('input', () => {
    state.shortsYoutube = null;
    document.getElementById('shorts-youtube-name').textContent = "Load once, then use any Studio tool.";
    updateExportButton();
  });
  document.querySelectorAll('input[name="shorts-mode"]').forEach(input => input.addEventListener('change', () => {
    state.shortsMode = input.value;
    try { localStorage.setItem('shortsMode', input.value); } catch {}
    updateExportButton();
  }));
}

function syncShortsAccount() {
  const user = state.authState?.user;
  const key = user ? String(user.id || user.email) : '';
  if (key === shortsAccountKey) return;
  shortsAccountKey = key;
  state.shortsAudioPath = null; state.shortsYoutube = null; state.shortsTranscriptName = '';
  document.getElementById('studio-text-input').value = ''; document.getElementById('shorts-youtube-url').value = '';
  document.getElementById('shorts-audio-name').textContent = 'MP3, WAV, M4A, MP4, MOV, and more';
  setStudioSource('sequence', true);
  shortsHistoryRequest++;
  shortsHistoryItems = [];
  shortsHistoryLoading = false;
  shortsHistoryError = '';
  shortsFlags = {};
  if (key) {
    try { shortsFlags = JSON.parse(localStorage.getItem(`shorts-flags:${key}`) || '{}') || {}; } catch {}
  }
  state.shortsView = 'workspace';
  state.shortsResultName = '';
  renderShorts([]);
  document.getElementById('shorts-status').textContent = 'Choose a source to get started.';
  document.getElementById('shorts-history-search').value = '';
  renderShortsHistory();
}

function setShortsView(view) {
  state.shortsView = view;
  const signedIn = !!state.authState?.user;
  document.getElementById('shorts-workspace').classList.toggle('hidden', !signedIn || view === 'history');
  document.getElementById('shorts-history-page').classList.toggle('hidden', !signedIn || view !== 'history');
  document.getElementById('shorts-footer').classList.toggle('hidden', !signedIn || view === 'history');
  bestshortsLock.classList.toggle('hidden', signedIn);
  const button = document.getElementById('shorts-history-btn');
  button.disabled = !signedIn;
  button.textContent = view === 'history' ? '← Back to Shorts' : 'History';
  bestshortsStatusText.textContent = view === 'history' ? 'Studio · Shorts history' : 'Studio · Shorts';
  updateExportButton();
}

async function loadShortsYoutube() {
  const button = document.getElementById('shorts-youtube-load');
  const label = document.getElementById('shorts-youtube-name');
  const account = shortsAccountKey;
  const url = document.getElementById('shorts-youtube-url').value.trim();
  if (!url) { label.textContent = 'Enter a YouTube video URL first.'; return; }
  state.shortsSourceLoading = true;
  state.shortsYoutube = null;
  label.textContent = 'Loading subtitles…';
  button.textContent = 'Loading…';
  updateExportButton();
  try {
    const result = await window.electronAPI.getShortsYoutubeTranscript(url);
    if (account !== shortsAccountKey || !studioEnabled) return;
    if (!result?.success) throw new Error(result?.error || 'Could not load these subtitles.');
    state.shortsYoutube = { subtitleText: result.transcript, fileName: result.fileName };
    label.textContent = `Ready · ${result.fileName}`;
    refreshStudioCredits();
  } catch (error) {
    if (account === shortsAccountKey) label.textContent = error.message || 'Could not load these subtitles.';
  } finally {
    state.shortsSourceLoading = false;
    button.textContent = 'Load subtitles';
    updateExportButton();
  }
}

function formatCredits(n) {
  return typeof n === 'number' ? n.toLocaleString() : '--';
}

function updateUpgradeButton(credits) {
  const upgradeBtn = document.getElementById('studio-upgrade-btn');
  if (!upgradeBtn || !credits) return;
  const pct = Math.max(0, Math.min(100, Number(credits.percentage) || 0));
  const low = credits.tier !== 'pro' || pct <= 20;
  upgradeBtn.classList.toggle('hidden', !low);
}

// Credits only cover Studio's cloud AI; the local tools never touch them.
function renderCredits(credits) {
  // Shown next to the "Studio" label in the sidebar.
  const textEl = document.getElementById('studio-credits-inline');
  const barEl = document.getElementById('studio-credit-bar-fill');
  if (!credits) return;

  const pct = Math.max(0, Math.min(100, Number(credits.percentage) || 0));
  const reset = credits.daysRemaining != null
    ? ` · resets in ${credits.daysRemaining} day${credits.daysRemaining === 1 ? '' : 's'}`
    : '';
  if (textEl) {
    textEl.classList.remove('hidden');
    textEl.textContent = `${formatCredits(credits.credits)} credits`;
    textEl.title = `${formatCredits(credits.credits)} of ${formatCredits(credits.totalCredits)} Studio credits left${reset}`;
  }
  const workspaceCredits = document.getElementById('studio-workspace-credits');
  if (workspaceCredits) { workspaceCredits.textContent = `${formatCredits(credits.credits)} credits`; workspaceCredits.title = textEl?.title || ''; }
  if (barEl) barEl.style.width = `${pct}%`;
  updateUpgradeButton(credits);
}

async function refreshStudioCredits() {
  if (!studioEnabled) return;
  const textEl = document.getElementById('studio-credits-inline');
  const barEl = document.getElementById('studio-credit-bar-fill');
  const upgradeBtn = document.getElementById('studio-upgrade-btn');

  const result = await window.electronAPI.getStudioCredits();
  if (!result || !result.success) {
    const workspaceCredits = document.getElementById('studio-workspace-credits');
    workspaceCredits.textContent = state.authState?.user ? 'Credits unavailable' : 'Studio credits';
    workspaceCredits.title = '';
    if (textEl) {
      textEl.classList.toggle('hidden', !!(result && result.requiresLogin) || !state.authState?.user);
      textEl.textContent = '—';
      textEl.title = (result && result.error) || '';
    }
    if (result && result.requiresLogin) loginBtn.classList.remove('hidden');
    if (barEl) barEl.style.width = '0%';
    if (upgradeBtn) upgradeBtn.classList.toggle('hidden', !(result && result.requiresLogin));
    return;
  }
  renderCredits(result.credits);
}

async function loadShortsHistory() {
  if (!studioEnabled || !state.authState?.user) return;
  const request = ++shortsHistoryRequest;
  shortsHistoryLoading = true;
  shortsHistoryError = '';
  renderShortsHistory();
  const items = [];
  try {
    let page = 1;
    let totalPages = 1;
    do {
      const result = await window.electronAPI.getShortsHistory(page);
      if (request !== shortsHistoryRequest) return;
      if (!result?.success) throw new Error(result?.requiresLogin ? 'Sign in again to load your history.' : result?.error || 'Could not load history. Try Refresh.');
      items.push(...(result.items || []));
      shortsHistoryItems = [...new Map(items.map(item => [item.id, item])).values()];
      totalPages = Number(result.totalPages) || 1;
      page++;
      renderShortsHistory();
      if (!result.items?.length) break;
    } while (page <= totalPages);
  } catch (error) {
    if (request !== shortsHistoryRequest) return;
    shortsHistoryError = error.message || 'Could not load history.';
  } finally {
    if (request === shortsHistoryRequest) {
      shortsHistoryLoading = false;
      renderShortsHistory();
    }
  }
}

function readHistoryShorts(item) {
  try {
    const parsed = JSON.parse(item.result);
    return Array.isArray(parsed?.shorts) ? parsed.shorts : [];
  } catch { return []; }
}

function renderShortsHistory() {
  const list = document.getElementById('shorts-history-list');
  const status = document.getElementById('shorts-history-status');
  const query = document.getElementById('shorts-history-search').value.trim().toLocaleLowerCase();
  const items = shortsHistoryItems.filter(item => `${item.fileName || ''} ${item.result || ''}`.toLocaleLowerCase().includes(query));
  document.getElementById('shorts-history-refresh-btn').disabled = shortsHistoryLoading;
  status.textContent = shortsHistoryError || (shortsHistoryLoading ? `Loading history… ${shortsHistoryItems.length} saved runs` :
    query ? `${items.length} matching run${items.length === 1 ? '' : 's'}` :
    shortsHistoryItems.length ? `${shortsHistoryItems.length} saved run${shortsHistoryItems.length === 1 ? '' : 's'}` :
    'Your saved Shorts will appear here after your first analysis.');
  list.replaceChildren();
  for (const item of items) {
    const shorts = readHistoryShorts(item);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'short-history-item';
    const date = new Date(item.createdAt).toLocaleString();
    button.innerHTML = `<span class="short-history-title">${escapeHtml(item.fileName || 'Shorts')}</span>
      <span class="short-history-meta">${escapeHtml(date)} · ${shorts.length} short${shorts.length === 1 ? '' : 's'}</span>
      <span class="short-history-preview">${escapeHtml(shorts.slice(0, 3).map(short => short.title || 'Untitled short').join(' · '))}</span>`;
    button.addEventListener('click', () => {
      if (state.isProcessing) return;
      state.shortsHistoryRetry = null; document.getElementById('shorts-history-retry').classList.add('hidden');
      if (!shorts.length) {
        shortsHistoryError = 'This saved run has no readable Shorts results.';
        renderShortsHistory();
        return;
      }
      state.shortsResultName = item.fileName || 'Saved Shorts';
      renderShorts(shorts);
      document.getElementById('shorts-status').textContent = `${shorts.length} short${shorts.length === 1 ? '' : 's'} · from history`;
      setShortsView('workspace');
      document.getElementById('shorts-results-section').scrollIntoView({ block: 'start' });
    });
    list.appendChild(button);
  }
  if (query && !items.length && !shortsHistoryLoading && !shortsHistoryError) {
    const empty = document.createElement('p');
    empty.className = 'help-text';
    empty.textContent = 'No saved runs match your search.';
    list.appendChild(empty);
  }
}

function shortFlagKey(short) {
  return `${state.shortsResultName}|${short.startTime || ''}|${short.endTime || ''}|${short.title || ''}`;
}

function saveShortFlags() {
  try { localStorage.setItem(`shorts-flags:${shortsAccountKey}`, JSON.stringify(shortsFlags)); } catch {}
}

async function copyShortField(button, text) {
  try {
    const result = await window.electronAPI.copyShortsText(String(text || ''));
    if (!result?.success) throw new Error(result?.error || 'Could not copy this text.');
    const hint = button.querySelector('.shorts-copy-hint');
    hint.textContent = '✓ Copied';
    button.classList.add('copied');
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      hint.textContent = button.dataset.copyLabel;
      button.classList.remove('copied');
    }, 1500);
  } catch (error) { document.getElementById('shorts-status').textContent = error.message || 'Could not copy this text.'; }
}

function renderShorts(shorts) {
  const container = document.getElementById('shorts-results');
  state.currentShorts = Array.isArray(shorts) ? shorts.filter(short => short && typeof short === 'object') : [];
  container.replaceChildren();
  document.getElementById('shorts-results-source').textContent = state.shortsResultName || '';
  if (!state.currentShorts.length) { updateExportButton(); return; }
  const wrap = document.createElement('div');
  wrap.className = 'shorts-card-list';
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Shorts results');
  wrap.tabIndex = 0;
  state.currentShorts.forEach((short, index) => {
    const row = document.createElement('article');
    row.className = 'studio-result-card shorts-result-row';
    const key = shortFlagKey(short);
    const flags = shortsFlags[key] || {};
    row.classList.toggle('short-used', !!flags.used);
    row.classList.toggle('short-not-used', !!flags.notUsed);
    const title = short.title || `Short ${index + 1}`;
    const desc = short.description || short.reason || '';
    row.innerHTML = `<div class="studio-result-card-heading"><h3>Short ${index + 1}</h3><span class="studio-time-badge">${escapeHtml(short.startTime || '—')} → ${escapeHtml(short.endTime || '')}</span></div>
      <div class="shorts-title-cell"><button type="button" class="shorts-copy-field" data-copy-label="Copy title" aria-label="Copy title for short ${index + 1}"><span>${escapeHtml(title)}</span><small class="shorts-copy-hint">Copy title</small></button></div>
      <div class="shorts-desc-cell"><button type="button" class="shorts-copy-field" data-copy-label="Copy description" aria-label="Copy description for short ${index + 1}" ${desc ? '' : 'disabled'}><span>${escapeHtml(desc || 'No description')}</span><small class="shorts-copy-hint">Copy description</small></button></div>
      <div class="shorts-card-flags">${[['used', 'Used'], ['notUsed', 'Not used'], ['memo', 'Memo']].map(([field, label]) => `<label><input type="checkbox" data-flag="${field}" aria-label="Mark short ${index + 1} as ${label.toLowerCase()}" ${flags[field] ? 'checked' : ''}>${label}</label>`).join('')}</div>`;
    const copies = row.querySelectorAll('.shorts-copy-field');
    copies[0].addEventListener('click', () => copyShortField(copies[0], title));
    copies[1].addEventListener('click', () => copyShortField(copies[1], desc));
    row.querySelectorAll('[data-flag]').forEach(input => input.addEventListener('change', () => {
      const next = { ...(shortsFlags[key] || {}), [input.dataset.flag]: input.checked };
      if (input.checked && input.dataset.flag === 'used') next.notUsed = false;
      if (input.checked && input.dataset.flag === 'notUsed') next.used = false;
      shortsFlags[key] = next;
      row.querySelectorAll('[data-flag]').forEach(control => { control.checked = !!next[control.dataset.flag]; });
      row.classList.toggle('short-used', !!next.used);
      row.classList.toggle('short-not-used', !!next.notUsed);
      saveShortFlags();
    }));
    wrap.appendChild(row);
  });
  container.appendChild(wrap);
  updateExportButton();
}

async function sendShortsToPremiere(shorts, button) {
  if (!shorts.length || !state.isConnected || !state.sequenceInfo?.hasSequence) return;
  button.disabled = true;
  button.textContent = 'Adding markers…';
  try {
    const result = await window.electronAPI.addShortsMarkers(shorts);
    if (!result?.success) throw new Error(result?.error || 'Could not add markers to Premiere.');
    document.getElementById('shorts-status').textContent = `${shorts.length} marker${shorts.length === 1 ? '' : 's'} added to Premiere.`;
  } catch (error) { document.getElementById('shorts-status').textContent = error.message || 'Could not add markers.'; }
  finally { updateExportButton(); }
}

async function runStudioShorts() {
  if (state.isProcessing || state.shortsSourceLoading) return;
  if (!state.authState?.user) { openLoginModal(); return; }
  if (!await studioTextTools.prepareSource()) return;
  const config = { ...studioTextTools.preparedInput(), shortsMode: state.shortsMode };
  const account = shortsAccountKey;
  const statusEl = document.getElementById('shorts-status');
  state.isProcessing = true;
  updateExportButton();
  statusEl.textContent = 'Starting…';
  state.shortsJobRunning = true;
  const cancelButton = document.getElementById('shorts-cancel-btn');
  cancelButton.classList.remove('hidden'); cancelButton.disabled = false; cancelButton.textContent = 'Cancel';
  const started = Date.now();
  const elapsed = setInterval(() => { document.getElementById('shorts-elapsed').textContent = `${Math.floor((Date.now() - started) / 1000)}s elapsed`; }, 1000);
  try {
    const result = await window.electronAPI.analyzeShorts(config);
    if (account !== shortsAccountKey) return;
    if (!result?.success) {
      statusEl.textContent = result?.error || 'Best Shorts failed. Try again.';
      if (result?.requiresLogin) openLoginModal();
      return;
    }
    state.shortsResultName = result.fileName || config.fileName || state.sequenceInfo?.name || 'Shorts';
    renderShorts(result.shorts);
    state.shortsHistoryRetry = result.historyRetry || null;
    document.getElementById('shorts-history-retry').classList.toggle('hidden', !state.shortsHistoryRetry);
    statusEl.textContent = result.warning || `Found ${state.currentShorts.length} short${state.currentShorts.length === 1 ? '' : 's'}. Click a title or description to copy it.`;
    if (result.credits) renderCredits(result.credits);
    if (!result.warning) loadShortsHistory();
    if (state.shortsView === 'workspace') document.getElementById('shorts-results-section').scrollIntoView({ block: 'start' });
  } catch (error) {
    if (account === shortsAccountKey) statusEl.textContent = error.message || 'Best Shorts failed. Try again.';
  } finally {
    state.isProcessing = false;
    state.shortsJobRunning = false; clearInterval(elapsed); cancelButton.classList.add('hidden');
    reconcileSequenceActions();
    updateExportButton();
  }
}

function setupElectronListeners() {
  window.electronAPI.onConnectionChange((data) => {
    updateConnection(data.connected, data.nle);
  });

  window.electronAPI.onSequenceInfo((info) => {
    if (state.shortsSource === 'sequence') studioTextTools?.invalidateSource();
    displaySequenceInfo(info);
  });

  window.electronAPI.onProgress((data) => {
    setProgress(data.progress, data.message);
  });

  window.electronAPI.onAutoCutResult((result) => {
    hideProgress();
    state.isProcessing = false;
    reconcileSequenceActions();

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
        setStatus(`${result.stats?.shots || 0} camera cuts created — review in Premiere`, 'success');
        const warnings = document.getElementById('multicam-review-warnings');
        warnings.replaceChildren();
        for (const message of result.warnings || []) {
          const item = document.createElement('li'); item.textContent = message; warnings.appendChild(item);
        }
        document.getElementById('multicam-result-notice').classList.toggle('hidden', !warnings.children.length);
        if (warnings.children.length) document.querySelector('#tab-multicam .content-scroll').scrollTop = 0;
        footerStatus.textContent = warnings.children.length ? 'Review the warnings above, both cameras and audio sync.' : 'Review both cameras and audio sync in the new sequence.';
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

  // Studio Best Shorts progress
  window.electronAPI.onShortsProgress((data) => {
    const statusEl = document.getElementById('shorts-status');
    if (statusEl && data && data.message) statusEl.textContent = data.message;
  });

  // Caption progress listener
  window.electronAPI.onCaptionProgress((data) => {
    if (data.status === 'complete') {
      hideProgress();
      setCaptionsStatus('Captions generated!', 'success');
    } else if (data.status === 'cancelled') {
      hideProgress();
      setCaptionsStatus('Transcription cancelled', 'idle');
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
    refreshStudioCredits();
  });

  // Single brand theme — theme sync from the website is ignored.
  window.electronAPI.onThemeSync(() => {
    applyTheme();
  });

  window.electronAPI.onUpdateStatus(applyUpdateState);

  // Platform info listener - applies platform-specific styles
  window.electronAPI.onPlatformInfo((data) => {
    state.platform = data.isWindows ? 'windows' : (data.isMac ? 'macos' : 'unknown');
    document.body.classList.toggle('window-expanded', Boolean(data.isExpanded));
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
  return 'Premiere Pro';
}

function getNLEPanelName() {
  return 'Premiere';
}

function updateConnectionGuide() {
  document.querySelectorAll('[data-premiere-guide]').forEach(card => {
    const localFile = card.closest('#tab-captions') && state.captionSource === 'file';
    card.classList.toggle('hidden', !!(localFile || (state.isConnected && state.sequenceInfo?.hasSequence)));
    const installed = state.bridgeInstalled !== false;
    const steps = card.querySelectorAll('li');
    [installed, state.isConnected, !!state.sequenceInfo?.hasSequence].forEach((complete, index) => steps[index].classList.toggle('complete', complete));
    card.querySelector('button').textContent = !installed ? 'Install bridge' : !state.isConnected ? 'Connection settings' : 'Refresh sequence';
    card.querySelector('p').textContent = !installed ? 'Install the bridge, then restart Premiere.' : !state.isConnected ? 'In Premiere, open Window → Extensions → SmoothyEdit.' : 'Open the sequence you want to edit, then refresh.';
  });
}
function setupReviewUI() {
  for (const name of ['multicam', 'silence', 'captions']) {
    const card = document.createElement('section');
    card.className = 'section premiere-guide';
    card.dataset.premiereGuide = '';
    card.innerHTML = '<h2>Connect Premiere</h2><ol><li>Install bridge</li><li>Open Premiere panel</li><li>Open sequence</li></ol><p class="help-text"></p><button type="button" class="btn btn-secondary btn-small"></button>';
    card.querySelector('button').addEventListener('click', async () => {
      if (state.bridgeInstalled === false) {
        const result = await window.electronAPI.installBridge();
        if (!result?.success) { showError(result?.error || 'Could not install the bridge.'); return; }
        state.bridgeInstalled = true; updateConnectionGuide();
      } else if (!state.isConnected) { await openSettings(); }
      else window.electronAPI.refreshSequence();
    });
    const scroll = document.querySelector(`#tab-${name} > .content-scroll`);
    scroll.prepend(card);
  }
  window.electronAPI.getBridgeStatus().then(result => { state.bridgeInstalled = !!result?.cep?.installed; updateConnectionGuide(); }).catch(() => {});
  document.querySelectorAll('#caption-max-lines-group .toggle-btn').forEach(button => button.addEventListener('click', scheduleCaptionReformat));
  ['caption-max-chars', 'caption-max-duration'].forEach(id => document.getElementById(id).addEventListener('input', scheduleCaptionReformat));
  setupCaptionSearch();
  document.getElementById('captions-reset-edits').addEventListener('click', () => {
    if (!state.captionOriginal) return;
    invalidateCaptionReformat(); discardCaptionReplacementUndo();
    state.captionResult = structuredClone(state.captionOriginal);
    state.captionRaw = state.captionResult.captions.map(caption => ({ ...caption }));
    state.captionEdited = false;
    applyCaptionTransforms();
  });
  document.getElementById('shorts-cancel-btn').addEventListener('click', async event => {
    event.currentTarget.disabled = true; event.currentTarget.textContent = 'Cancelling…';
    await window.electronAPI.cancelShorts();
  });
  document.getElementById('shorts-history-retry').addEventListener('click', async event => {
    if (!state.shortsHistoryRetry) return;
    const button = event.currentTarget; button.disabled = true;
    try {
      const result = await window.electronAPI.retryShortsHistory(state.shortsHistoryRetry);
      if (!result?.success) throw new Error(result?.error || 'Could not save history.');
      state.shortsHistoryRetry = null; button.classList.add('hidden');
      document.getElementById('shorts-status').textContent = 'Saved to history.'; loadShortsHistory();
    } catch (error) { document.getElementById('shorts-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('clear-all-markers-btn').addEventListener('click', () => clearAllMarkers('all'));
  updateConnectionGuide();
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
  document.getElementById('connection-state-label').textContent = connected ? 'Connected' : 'Not connected';
  connectionStatus.setAttribute('aria-label', `${nleName}: ${connected ? 'Connected' : 'Not connected'}`);
  connectionStatus.title = `${nleName}: ${connected ? 'Connected' : 'Not connected'}`;

  if (connected) {
    setStatus(`Connected to ${nleName}`, 'idle');
    setSilenceStatus(`Connected to ${nleName}`, 'idle');
    setCaptionsStatus(`Connected to ${nleName}`, 'idle');
    statusDot.classList.remove('disconnected');
    statusDot.classList.add('connected');
  } else {
    setStatus(`Waiting for ${nleName}...`, 'idle');
    state.sequenceInfo = null;
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
    footerStatus.textContent = '';

    // Silence tab
    silenceSequenceName.textContent = 'No sequence loaded';
    silenceSequenceDetails.textContent = '';
    silenceAudioTracksList.innerHTML = `<p class="empty-message">Connect to ${panelName} to see audio tracks</p>`;
    silenceRemoveBtn.disabled = true;
    silenceFooterStatus.textContent = '';

    // Captions tab
    captionsSequenceName.textContent = 'No sequence loaded';
    captionsSequenceDetails.textContent = '';
    captionsAudioTracksList.innerHTML = `<p class="empty-message">Connect to ${panelName} to see audio tracks</p>`;
    generateCaptionsBtn.disabled = true;
    captionsFooterStatus.textContent = '';

    // Best Shorts tab
    bestshortsSequenceName.textContent = 'No sequence loaded';
    bestshortsSequenceDetails.textContent = '';
    updateExportButton();
  }
  reconcileSequenceActions();
  if (!connected && state.captionSource === 'file') setCaptionsStatus(state.captionResult?.captions?.length ? 'Captions ready · local file' : 'Local file · Premiere connection optional', 'idle');
  updateConnectionGuide();
  if (typeof assetsState !== 'undefined') updateAssetsUI();
}

// Track choices belong to their sequence and stable track index.
const sequenceChoices = new Map();
function preserveTrackChoices(container) {
  const id = container.dataset.sequenceId;
  if (!id) return;
  const choices = sequenceChoices.get(id) || {};
  container.querySelectorAll('input[data-track-index], select[data-track-index]').forEach(input => {
    choices[container.id + ':' + input.className + ':' + input.dataset.trackIndex] = input.type === 'checkbox' ? input.checked : input.value;
  });
  sequenceChoices.set(id, choices);
  try { localStorage.setItem('sequence-choices:' + id, JSON.stringify(choices)); } catch {}
}
function restoreTrackChoices(container, info) {
  const id = String(info.id || info.sequenceId || info.name || info.sequenceName);
  container.dataset.sequenceId = id;
  let choices = sequenceChoices.get(id);
  if (!choices) {
    try { choices = JSON.parse(localStorage.getItem('sequence-choices:' + id) || '{}'); } catch { choices = {}; }
    sequenceChoices.set(id, choices);
  }
  container.querySelectorAll('input[data-track-index], select[data-track-index]').forEach(input => {
    const saved = choices[container.id + ':' + input.className + ':' + input.dataset.trackIndex];
    if (saved === undefined) return;
    if (input.type === 'checkbox') input.checked = saved;
    else if (input.tagName !== 'SELECT' || [...input.options].some(option => option.value === saved)) input.value = saved;
  });
  if (!container.dataset.choicesListener) {
    container.dataset.choicesListener = 'true';
    container.addEventListener('change', () => { preserveTrackChoices(container); reconcileSequenceActions(); });
    container.addEventListener('input', () => preserveTrackChoices(container));
  }
}
function reconcileSequenceActions() {
  const ready = state.isConnected && state.sequenceInfo?.hasSequence && !state.isProcessing;
  autoCutBtn.disabled = !ready || !audioTracksList.querySelector('.audio-track-cb:checked') || !videoTracksList.querySelector('.video-track-cb:checked');
  silenceRemoveBtn.disabled = !ready || !silenceAudioTracksList.querySelector('.silence-audio-track-cb:checked');
  updateGenerateCaptionsButton();
  importCaptionsBtn.disabled = !state.isConnected || !state.sequenceInfo?.hasSequence || !state.captionResult?.captions?.length || state.isProcessing;
  updateAssetsUI();
}

function displaySequenceInfo(info) {
  [audioTracksList, videoTracksList, silenceAudioTracksList, captionsAudioTracksList].forEach(preserveTrackChoices);
  if (!info || !info.hasSequence) {
    state.sequenceInfo = null;
    displayBestshortsSequenceInfo(info);
    displaySilenceSequenceInfo(info);
    displayCaptionsSequenceInfo(info);
    reconcileSequenceActions();
    sequenceName.textContent = 'No sequence open';
    sequenceDetails.textContent = 'Open a sequence in Premiere';
    audioTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    videoTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    autoCutBtn.disabled = true;
    footerStatus.textContent = 'Open a sequence to begin';
    updateConnectionGuide();
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
          <input type="checkbox" class="track-checkbox audio-track-cb" aria-label="Include audio ${escapeHtml(track.name)}" data-track-index="${track.index}" checked>
        <span class="track-name">${escapeHtml(track.name)}</span>
        <span class="track-clips">${escapeHtml(clipNames)}</span>
        </div>
        <div class="track-mapping">
          <label>Speaker:</label>
          <input type="text" class="speaker-name" aria-label="Speaker for ${escapeHtml(track.name)}" data-track-index="${track.index}" value="Speaker ${index + 1}">
          <label>Camera:</label><select class="speaker-camera" aria-label="Camera for ${escapeHtml(track.name)}" data-track-index="${track.index}">
            ${(info.videoTracks || []).map((camera, position) => `<option value="${camera.index}" ${position === index ? 'selected' : ''}>${escapeHtml(camera.name)}</option>`).join('')}
          </select>
        </div>
      `;
      audioTracksList.appendChild(trackEl);
    });
  } else {
    audioTracksList.innerHTML = '<p class="empty-message">No audio tracks found</p>';
  }

  // Display video tracks
  if (info.videoTracks && info.videoTracks.length > 0) {
    videoTracksList.innerHTML = '';
    info.videoTracks.forEach((track, index) => {
      const clipNames = track.clips ? track.clips.map(c => c.name).join(', ') : '';
      const trackEl = document.createElement('div');
      trackEl.className = 'track-item';
      trackEl.innerHTML = `
        <div class="track-info">
          <input type="checkbox" class="track-checkbox video-track-cb" aria-label="Include video ${escapeHtml(track.name)}" data-track-index="${track.index}" checked>
        <span class="track-name">${escapeHtml(track.name)}</span>
        <span class="track-clips">${escapeHtml(clipNames)}</span>
        </div>
        <div class="track-mapping">
          <label>Camera:</label>
          <select class="camera-index" aria-label="Camera number for ${escapeHtml(track.name)}" data-track-index="${track.index}">
            ${generateCameraOptions(info.videoTracks.length, index)}
          </select>
        </div>
      `;
      videoTracksList.appendChild(trackEl);
    });

    videoTracksList.querySelectorAll('.camera-index').forEach(sel => {
      sel.addEventListener('change', refreshWideCameraOptions);
    });
  } else {
    videoTracksList.innerHTML = '<p class="empty-message">No video tracks found</p>';
  }

  restoreTrackChoices(audioTracksList, info);
  restoreTrackChoices(videoTracksList, info);
  refreshWideCameraOptions();

  // Enable button if we have both
  const hasAudio = info.audioTracks && info.audioTracks.length > 0;
  const hasVideo = info.videoTracks && info.videoTracks.length > 0;
  autoCutBtn.disabled = !(hasAudio && hasVideo);
  footerStatus.textContent = hasAudio && hasVideo ? '' : 'Need audio and video tracks';

  // Also update other tabs
  displaySilenceSequenceInfo(info);
  displayBestshortsSequenceInfo(info);
  displayCaptionsSequenceInfo(info);
  reconcileSequenceActions();
  updateConnectionGuide();
}

function generateCameraOptions(count, defaultIndex) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<option value="${i}" ${i === defaultIndex ? 'selected' : ''}>Camera ${i + 1}</option>`;
  }
  return html;
}

// Keep the wide-shot camera list in sync with the per-track camera dropdowns so
// the selected wide camera is one the cut list actually understands.
function refreshWideCameraOptions() {
  const wideSelect = document.getElementById('wide-camera-select');
  if (!wideSelect) return;

  const previous = wideSelect.value;
  let html = '<option value="-1">None</option>';

  document.querySelectorAll('.camera-index').forEach(sel => {
    const trackIndex = parseInt(sel.dataset.trackIndex);
    const track = state.sequenceInfo?.videoTracks?.find(t => t.index === trackIndex);
    const camera = parseInt(sel.value);
    if (!Number.isFinite(camera)) return;
    html += `<option value="${camera}">Camera ${camera + 1}${track ? ` (${escapeHtml(track.name)})` : ''}</option>`;
  });

  wideSelect.innerHTML = html;
  if (Array.from(wideSelect.options).some(option => option.value === previous)) {
    wideSelect.value = previous;
  }
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
        name: track.name,
        cameraTrack: Number(document.querySelector(`.speaker-camera[data-track-index="${trackIndex}"]`)?.value),
        speaker: speakerName.toLowerCase().replace(/\s+/g, '_'),
        path: track.clips[0].path,
        clips: track.clips,
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
        clips: track.clips,
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

  // Sort the selected video tracks by the camera number picked in their
  // dropdown, then assign dense camera slots. The cut list now follows those
  // dropdowns instead of blindly numbering audio tracks Camera 1, Camera 2.
  const cameraTracks = videoMappings
    .filter(v => Number.isFinite(v.camera))
    .sort((a, b) => a.camera - b.camera);
  if (new Set(cameraTracks.map(track => track.camera)).size !== cameraTracks.length) {
    showError('Choose a different camera number for each enabled video track.');
    return;
  }
  const cameraSlot = new Map();
  cameraTracks.forEach((v, slot) => cameraSlot.set(v.camera, slot));
  const slotByTrack = new Map(cameraTracks.map((track, slot) => [track.trackIndex, slot]));
  if (audioMappings.some(audio => !slotByTrack.has(audio.cameraTrack))) {
    showError('Choose an enabled camera for each selected speaker.');
    return;
  }

  const clips = cameraTracks.map(v => ({
    name: v.trackName,
    index: v.trackIndex,
    clips: v.clips
  }));

  // Each microphone follows its explicitly selected video track.
  const sources = audioMappings.map(audio => ({
    index: audio.trackIndex,
    name: audio.trackName,
    path: audio.path,
    clips: audio.clips,
    speaker: audio.speaker,
    camera: slotByTrack.get(audio.cameraTrack)
  }));

  const useWideShot = document.getElementById('use-wide-shot').checked;
  const wideValue = useWideShot ? parseInt(document.getElementById('wide-camera-select').value) : -1;
  const wideIndex = wideValue >= 0 ? (cameraSlot.get(wideValue) ?? wideValue) : -1;
  const jcutOffset = parseFloat(document.getElementById('jcut-offset').value);

  const config = {
    sources,
    options: {
      sequenceId: state.sequenceInfo.id,
      timelineRevision: state.sequenceInfo.timelineRevision,
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
      // Wide decisions switch to the selected existing camera track.
      useOverlapWideShots: useWideShot && wideIndex >= 0,
      jcutOffset: jcutOffset,
      videoTracks: clips
    }
  };

  state.isProcessing = true;
  showProgress('Starting...');
  setStatus('Processing...', 'processing');

  await window.electronAPI.startAutoCut(config);
}

// Silence Removal Functions
function displaySilenceSequenceInfo(info) {
  preserveTrackChoices(silenceAudioTracksList);
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
          <input type="checkbox" class="track-checkbox silence-audio-track-cb" aria-label="Analyze ${escapeHtml(track.name)}" data-track-index="${track.index}" checked>
        <span class="track-name">${escapeHtml(track.name)}</span>
        <span class="track-clips">${escapeHtml(clipNames)}</span>
        </div>
      `;
      silenceAudioTracksList.appendChild(trackEl);
    });
  } else {
    silenceAudioTracksList.innerHTML = '<p class="empty-message">No audio tracks found</p>';
  }

  restoreTrackChoices(silenceAudioTracksList, info);
  const hasAudio = !!silenceAudioTracksList.querySelector('.silence-audio-track-cb:checked');
  silenceRemoveBtn.disabled = !hasAudio;
  silenceFooterStatus.textContent = hasAudio ? '' : 'Need audio tracks';

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
        name: track.name,
        path: track.clips[0].path,
        clips: track.clips,
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
          index: track.index,
          clips: track.clips
        });
      }
    });
  }

  const editInPlace = document.getElementById('edit-in-place').checked;

  if (editInPlace) {
    const confirmed = window.confirm(
      'Silence Removal will ripple-delete the silent parts directly from the current sequence. ' +
      'Premiere records each cut as a separate undo step. Continue?'
    );
    if (!confirmed) return;
  }

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
      sequenceId: state.sequenceInfo.id,
      editInPlace: editInPlace,
      videoTracks: videoClips
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

let progressClock = null;
function showProgress(msg, options = {}) {
  clearInterval(progressClock);
  const started = Date.now();
  const clock = document.getElementById('progress-elapsed');
  clock.textContent = '0s elapsed';
  progressClock = setInterval(() => { clock.textContent = `${Math.floor((Date.now() - started) / 1000)}s elapsed`; }, 1000);
  document.getElementById('progress-overlay').classList.remove('hidden');
  document.getElementById('progress-text').textContent = msg;
  document.getElementById('progress-fill').style.width = '0%';
  if (progressCancelBtn) {
    if (options.cancelable) {
      progressCancelBtn.classList.remove('hidden');
      progressCancelBtn.disabled = false;
      progressCancelBtn.textContent = 'Cancel';
    } else {
      progressCancelBtn.classList.add('hidden');
    }
  }
}

function setProgress(pct, msg) {
  if (msg) document.getElementById('progress-text').textContent = msg;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-fill').setAttribute('aria-valuenow', String(pct));
}

function hideProgress() {
  clearInterval(progressClock); progressClock = null;
  document.getElementById('progress-overlay').classList.add('hidden');
  if (progressCancelBtn) progressCancelBtn.classList.add('hidden');
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  document.getElementById('error-modal').classList.remove('hidden');
}

// ========================================
// Update "what's new" modal
// ========================================

function applyUpdateState(data) {
  if (!data?.status) return;
  state.updateState = data;
  state.pendingUpdateNotes = data.notes || null;
  renderUpdateState();
  renderSettingsUpdateNotes(data.version, data.notes);
  if (state.updateModalOpen) {
    if (data.version) document.getElementById('update-modal-version').textContent = data.version;
    renderUpdateModalNotes(data.version, data.notes);
  }
}

function renderUpdateState() {
  const { status, version, percent, error } = state.updateState;
  const updateBar = document.getElementById('update-bar');
  const updateText = document.getElementById('update-bar-text');
  const updateBtn = document.getElementById('update-bar-btn');
  const busy = ['checking', 'downloading', 'installing'].includes(status);
  const visible = ['available', 'downloading', 'downloaded', 'installing'].includes(status) || (status === 'error' && version);
  checkUpdateBtn.disabled = busy || status === 'dev-build';
  checkUpdateBtn.classList.toggle('hidden', status === 'dev-build');
  document.getElementById('settings-update-help').textContent = status === 'dev-build'
    ? 'This local preview does not receive automatic updates. Update checks are enabled in the published app.'
    : 'SmoothyEdit checks for updates on startup and every six hours. Downloads and installation only start when you choose. Skip any version and keep using the one you have.';
  checkUpdateBtn.textContent = status === 'checking' ? 'Checking…' : 'Check for Updates';
  settingsInstallUpdateBtn.classList.toggle('hidden', !version || status === 'checking');
  settingsInstallUpdateBtn.textContent = status === 'skipped' ? 'View skipped update' : 'View update';
  updateBar.classList.toggle('hidden', !visible);
  updateBtn.textContent = 'See what’s new';
  document.getElementById('update-bar-close').disabled = busy;

  const messages = {
    idle: `v${state.appVersion || '?'}`,
    checking: 'Checking for updates…',
    available: `Update v${version} is available. Review the changes before installing.`,
    skipped: `Skipped v${version}. You’re staying on v${state.appVersion || '?'}.`,
    downloading: `Downloading v${version}… ${percent}%`,
    downloaded: `Update v${version} is ready. Restart when you choose to install it.`,
    installing: `Restarting to install v${version}…`,
    'up-to-date': `You’re on the latest version (v${state.appVersion || '?'}).`,
    error: `Update failed${error ? `: ${error}` : '. Try again later.'}`,
    'dev-build': 'Local preview · automatic updates unavailable'
  };
  settingsUpdateStatus.textContent = messages[status] || messages.idle;
  updateText.textContent = status === 'available' ? `Update v${version} available` : (messages[status] || messages.idle);
  if (state.updateModalOpen) {
    const ready = status === 'downloaded' || percent === 100;
    const install = document.getElementById('update-modal-install');
    install.disabled = busy || !version;
    install.textContent = status === 'downloading' ? `Downloading… ${percent}%` : status === 'installing' ? 'Restarting…' : ready ? 'Restart & Install' : 'Install update';
    const skip = document.getElementById('update-modal-later');
    skip.disabled = busy || status === 'skipped' || !version;
    skip.textContent = status === 'skipped' ? 'Skipped' : 'Skip this version';
    document.getElementById('update-modal-status').textContent = messages[status] || '';
  }
}

/**
 * Render the pending update's release notes inline in Settings, so the user can
 * read what a version fixes/adds before choosing to install.
 */
function renderSettingsUpdateNotes(version, notes) {
  if (!settingsUpdateNotes) return;

  if (!version || !notes) {
    settingsUpdateNotes.classList.add('hidden');
    settingsUpdateNotes.innerHTML = '';
    return;
  }

  settingsUpdateNotes.innerHTML = '';
  const title = document.createElement('p');
  title.innerHTML = `<strong>What's new in v${escapeHtml(version)}</strong>`;
  settingsUpdateNotes.appendChild(title);
  renderMarkdownInto(settingsUpdateNotes, notes);
  settingsUpdateNotes.classList.remove('hidden');
}

let updateReturnFocus = null;
function showUpdateModal(version) {
  if (!version) return;
  if (!state.updateModalOpen) updateReturnFocus = document.activeElement;
  state.updateModalOpen = true;
  document.querySelector('.app-container').inert = true;
  settingsModal.inert = true;
  document.getElementById('update-modal-version').textContent = version;
  document.getElementById('update-modal').classList.remove('hidden');
  renderUpdateModalNotes(version, state.pendingUpdateNotes);
  renderUpdateState();
  document.getElementById('update-modal-close').focus();
}

function closeUpdateModal() {
  document.getElementById('update-modal').classList.add('hidden');
  state.updateModalOpen = false;
  settingsModal.inert = false;
  document.querySelector('.app-container').inert = !settingsModal.classList.contains('hidden');
  if (updateReturnFocus?.getClientRects().length) updateReturnFocus.focus();
  else if (!settingsModal.classList.contains('hidden')) settingsCloseBtn.focus();
  else settingsBtn.focus();
}

async function skipPendingUpdate() {
  try {
    const result = await window.electronAPI.skipUpdate(state.updateState.version);
    if (result?.success) closeUpdateModal();
    else { closeUpdateModal(); showError(result?.error || 'Could not skip this update.'); }
  } catch { closeUpdateModal(); showError('Could not save your update choice. Please try again.'); }
}

async function installPendingUpdate() {
  try {
    const result = await window.electronAPI.installUpdate(state.updateState.version);
    if (result?.error) { closeUpdateModal(); showError(result.error); }
  } catch { closeUpdateModal(); showError('Could not start the update. Please try again.'); }
}

function renderUpdateModalNotes(version, notes) {
  const body = document.getElementById('update-modal-body');
  body.innerHTML = '';
  if (notes) { renderMarkdownInto(body, notes); return; }
  const p = document.createElement('p');
  p.className = 'update-empty';
  p.textContent = state.updateState.notesLoading ? 'Loading fixes and new features…' : 'Release notes are unavailable right now. Open the release page to see the fixes and new features.';
  body.appendChild(p);
}

/**
 * Render a GitHub release body (markdown: headings, bullet lists, paragraphs)
 * into a container. Shared by the update modal and the settings panel.
 */
function renderMarkdownInto(body, notes) {
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
  const hasSequence = !!(state.isConnected && state.sequenceInfo?.hasSequence);
  const busy = state.isProcessing || state.shortsSourceLoading;
  const signedIn = !!state.authState?.user;
  let ready = hasSequence || studioTextTools?.hasPreparedSource();
  if (state.shortsSource === 'transcript') ready = !!document.getElementById('studio-text-input').value.trim();
  if (state.shortsSource === 'audio') ready = !!state.shortsAudioPath;
  if (state.shortsSource === 'youtube') ready = !!state.shortsYoutube?.subtitleText;
  clearMarkersBtn.disabled = !hasSequence || busy;
  document.getElementById('clear-all-markers-btn').disabled = !hasSequence || busy;
  const analyzeBtn = document.getElementById('analyze-shorts-btn');
  analyzeBtn.disabled = !signedIn || !ready || busy;
  analyzeBtn.textContent = state.isProcessing ? 'Analyzing…' : state.shortsMode === 'best' ? 'Find Best Part' : 'Find Shorts';
  const sendBtn = document.getElementById('send-shorts-btn');
  sendBtn.disabled = !hasSequence || busy || !state.currentShorts.length;
  const compactActions = window.innerWidth <= 650;
  const fullSendLabel = state.currentShorts.length > 1 ? `Add ${state.currentShorts.length} markers in Premiere` : 'Add marker in Premiere';
  sendBtn.textContent = compactActions ? (state.currentShorts.length > 1 ? `Add ${state.currentShorts.length} markers` : 'Add marker') : fullSendLabel;
  sendBtn.title = sendBtn.ariaLabel = fullSendLabel;
  clearMarkersBtn.textContent = compactActions ? 'Clear markers' : 'Clear Smoothy markers';
  clearMarkersBtn.title = clearMarkersBtn.ariaLabel = 'Clear Smoothy markers';
  const clearAllMarkersBtn = document.getElementById('clear-all-markers-btn');
  clearAllMarkersBtn.textContent = compactActions ? 'Clear all' : 'Clear all…';
  clearAllMarkersBtn.title = clearAllMarkersBtn.ariaLabel = 'Clear all markers';
  document.querySelectorAll('#studio-compose-footer [data-shorts-source], #studio-compose-footer input, #studio-compose-footer textarea, #shorts-workspace button:not(.shorts-copy-field)').forEach(control => { control.disabled = busy; });
  document.getElementById('shorts-history-btn').disabled = !signedIn || state.isProcessing;
  if (!signedIn) bestshortsFooterStatus.textContent = 'Sign in to use Studio';
  else if (busy) bestshortsFooterStatus.textContent = state.shortsSourceLoading ? 'Loading YouTube subtitles…' : 'Analyzing your source…';
  else if (!ready) bestshortsFooterStatus.textContent = state.shortsSource === 'sequence' ? 'Connect Premiere and open a sequence' : '';
  else bestshortsFooterStatus.textContent = '';
  syncStudioToolButtons(); studioTextTools?.refresh();
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

function setBestshortsStatus(text, type) {
  bestshortsStatusBar.className = `status-bar status-${type} bestshorts-statusbar-row`;
  bestshortsStatusText.textContent = text;
}

async function clearAllMarkers(scope = 'smoothy') {
  if (typeof scope !== 'string') scope = 'smoothy';
  if (scope === 'all' && !window.confirm(`Delete all ${state.sequenceInfo?.markerCount ?? ''} markers from ${state.sequenceInfo?.name || 'this sequence'}, including your own markers?`)) return;
  if (!state.isConnected || !state.sequenceInfo?.hasSequence) return;

  clearMarkersBtn.disabled = true;
  setBestshortsStatus('Clearing markers...', 'processing');

  try {
    const result = await window.electronAPI.clearMarkers(scope, state.sequenceInfo.id);

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
  preserveTrackChoices(captionsAudioTracksList);
  if (!info || !info.hasSequence) {
    captionsSequenceName.textContent = 'No sequence open';
    captionsSequenceDetails.textContent = 'Open a sequence in Premiere';
    captionsAudioTracksList.innerHTML = '<p class="empty-message">Open a sequence first</p>';
    updateGenerateCaptionsButton();
    if (state.captionSource === 'sequence') {
      captionsFooterStatus.textContent = 'Open a sequence, or pick an audio/video file';
    }
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
          <input type="checkbox" class="track-checkbox captions-audio-track-cb" aria-label="Transcribe ${escapeHtml(track.name)}" data-track-index="${track.index}" checked>
        <span class="track-name">${escapeHtml(track.name)}</span>
        <span class="track-clips">${escapeHtml(clipNames)}</span>
        </div>
      `;
      captionsAudioTracksList.appendChild(trackEl);
    });
  } else {
    captionsAudioTracksList.innerHTML = '<p class="empty-message">No audio tracks found</p>';
  }

  restoreTrackChoices(captionsAudioTracksList, info);
  updateGenerateCaptionsButton();
}

/**
 * Enable/disable Generate based on the active source: a chosen file, or a
 * sequence with at least one audio track.
 */
function updateGenerateCaptionsButton() {
  if (state.isProcessing || state.isTranscribing) {
    generateCaptionsBtn.disabled = true;
    return;
  }

  if (state.captionSource === 'file') {
    const hasFile = !!state.captionFilePath;
    generateCaptionsBtn.disabled = !hasFile;
    captionsFooterStatus.textContent = '';
    return;
  }

  const hasAudio = state.isConnected && state.sequenceInfo?.hasSequence && !!captionsAudioTracksList.querySelector('.captions-audio-track-cb:checked');
  generateCaptionsBtn.disabled = !hasAudio;
  if (hasAudio) {
    captionsFooterStatus.textContent = '';
  }
}

async function loadCaptionModels() {
  if (!captionModelSelect) return;
  try {
    const [models, selected] = await Promise.all([
      window.electronAPI.getCaptionModels(),
      window.electronAPI.getSelectedCaptionModel()
    ]);
    captionModelSelect.innerHTML = '';
    (models || []).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} — ${m.size}`;
      if (m.id === selected) opt.selected = true;
      captionModelSelect.appendChild(opt);
    });
    if (!captionModelSelect.value && selected) captionModelSelect.value = selected;
  } catch (error) {
    console.warn('Failed to load caption models', error);
  }
  updateCaptionLanguageHint();
  refreshCaptionEngineStatus();
}

async function refreshCaptionEngineStatus() {
  if (!captionEngineStatus) return;
  try {
    const info = await window.electronAPI.getCaptionEngineInfo();
    const backend = (info.backend || 'cpu').toUpperCase();
    const label = backend === 'CUDA' ? 'GPU (CUDA)'
      : backend === 'METAL' ? 'GPU (Metal)'
      : backend === 'VULKAN' ? 'GPU (Vulkan)'
      : 'CPU (all cores)';
    if (info.ready) {
      captionEngineStatus.textContent = `Running on ${label}`;
    } else {
      captionEngineStatus.textContent = 'The engine downloads automatically on your first transcription';
    }
  } catch {
    captionEngineStatus.textContent = '';
  }
}

async function onCaptionModelChange() {
  if (!captionModelSelect) return;
  try {
    await window.electronAPI.setSelectedCaptionModel(captionModelSelect.value);
    captionEngineStatus.textContent = 'Model set — applies to your next transcription';
    updateCaptionLanguageHint();
  } catch (error) {
    showError(error.message || 'Could not change the model');
  }
}

async function loadCaptionLanguages() {
  if (!captionLanguageSelect) return;
  try {
    const [languages, selected] = await Promise.all([
      window.electronAPI.getCaptionLanguages(),
      window.electronAPI.getCaptionLanguage()
    ]);
    captionLanguageSelect.innerHTML = '';
    (languages || []).forEach((lang) => {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      if (lang.code === selected) opt.selected = true;
      captionLanguageSelect.appendChild(opt);
    });
    if (!captionLanguageSelect.value) captionLanguageSelect.value = 'auto';
  } catch (error) {
    console.warn('Failed to load caption languages', error);
  }
  updateCaptionLanguageHint();
}

async function onCaptionLanguageChange() {
  if (!captionLanguageSelect) return;
  try {
    await window.electronAPI.setCaptionLanguage(captionLanguageSelect.value);
    updateCaptionLanguageHint();
  } catch (error) {
    showError(error.message || 'Could not change the language');
  }
}

/**
 * Warn when a non-English language is paired with an English-only (.en) model,
 * which cannot transcribe it. The main process refuses such a run, so this is
 * the early heads-up.
 */
function updateCaptionLanguageHint() {
  if (!captionLanguageStatus || !captionLanguageSelect) return;
  const code = captionLanguageSelect.value;
  const modelId = captionModelSelect ? captionModelSelect.value : '';
  const lowAccuracyArabic = code === 'ar' && /^ggml-(tiny|base)\.bin$/i.test(modelId);
  const lowAccuracyAuto = code === 'auto' && /^ggml-(tiny|base)\.bin$/i.test(modelId);
  captionRecommendedModel?.classList.toggle('hidden', !lowAccuracyArabic && !lowAccuracyAuto);
  if (/\.en\.bin$/i.test(modelId) && code !== 'auto' && code !== 'en') {
    const label = captionLanguageSelect.options[captionLanguageSelect.selectedIndex]?.textContent || code;
    captionLanguageStatus.textContent = `${label} needs a multilingual model — choose one above (e.g. Large v3 Turbo).`;
    return;
  }
  if (lowAccuracyArabic) {
    captionLanguageStatus.textContent = 'Tiny and Base often mishear Arabic, especially dialects. Choose Large v3 Turbo for better accuracy (1.6 GB, downloaded once).';
    return;
  }
  if (lowAccuracyAuto) {
    captionLanguageStatus.textContent = 'Tiny and Base favor speed over accuracy. For Arabic or other non-English speech, select the language and use Large v3 Turbo (1.6 GB, downloaded once).';
    return;
  }
  captionLanguageStatus.textContent = code === 'auto'
    ? 'Auto-detect works for any spoken language. Non-English languages need a multilingual model.'
    : 'Applies to your next transcription.';
}

async function loadCaptionEnginePreference() {
  if (!captionEngineSelect) return;
  const gpuOption = captionEngineSelect.querySelector('option[value="cuda"]');
  if (gpuOption) gpuOption.textContent = GPU_ENGINE_LABEL;
  try {
    const engine = await window.electronAPI.getCaptionEngine();
    if (engine && ['auto', 'cuda', 'cpu'].includes(engine)) {
      captionEngineSelect.value = engine;
    }
  } catch (error) {
    console.warn('Failed to load engine preference', error);
  }
}

async function onCaptionEngineChange() {
  if (!captionEngineSelect) return;
  try {
    const result = await window.electronAPI.setCaptionEngine(captionEngineSelect.value);
    if (result && result.success) {
      const label = result.engine === 'cpu' ? 'CPU (all cores)'
        : result.engine === 'cuda' ? GPU_ENGINE_LABEL
        : 'Auto';
      captionEngineStatus.textContent = `Engine set to ${label} — applies to your next transcription`;
    }
  } catch (error) {
    showError(error.message || 'Could not change the engine');
  }
}

/**
 * Toggle a text transform. It is applied to the generated captions on top of
 * the raw transcription, so it can be turned on or off before or after
 * generating without losing the original text.
 */
function toggleCaptionTransform(kind) {
  invalidateCaptionReformat(); discardCaptionReplacementUndo();
  state.captionTransforms[kind] = !state.captionTransforms[kind];
  syncCaptionTransformButtons();
  applyCaptionTransforms();
}

function syncCaptionTransformButtons() {
  if (captionsCapitalizeBtn) {
    captionsCapitalizeBtn.classList.toggle('active', state.captionTransforms.capitalize);
    captionsCapitalizeBtn.setAttribute('aria-pressed', String(state.captionTransforms.capitalize));
  }
  if (captionsRemovePunctBtn) {
    captionsRemovePunctBtn.classList.toggle('active', state.captionTransforms.removePunctuation);
    captionsRemovePunctBtn.setAttribute('aria-pressed', String(state.captionTransforms.removePunctuation));
  }
}

/**
 * Rebuild the visible captions (and their SRT/VTT) from the raw transcription
 * with the active text transforms applied.
 */
function applyCaptionTransforms() {
  if (!state.captionResult || !Array.isArray(state.captionRaw)) return;

  const { capitalize, removePunctuation } = state.captionTransforms;
  const transform = (text) => {
    let out = text;
    if (removePunctuation) {
      out = out
        .replace(/[\p{P}]/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    if (capitalize) {
      out = out.replace(/(^|\n)(\s*\p{L})/gu, (_, prefix, ch) => prefix + ch.toLocaleUpperCase());
    }
    return out;
  };

  state.captionResult.captions = state.captionRaw.map((cap) => ({
    ...cap,
    text: transform(cap.text)
  }));
  state.captionResult.srt = buildSRT(state.captionResult.captions);
  state.captionResult.vtt = buildVTT(state.captionResult.captions);

  if (captionsPreviewSection.style.display !== 'none') {
    displayCaptionsPreview(state.captionResult.captions);
  }
}

function buildSRT(captions) {
  return captions
    .map((cap) => `${cap.index}\n${formatSRTTime(cap.startTime)} --> ${formatSRTTime(cap.endTime)}\n${cap.text}\n`)
    .join('\n');
}

function buildVTT(captions) {
  const time = (seconds) => formatSRTTime(seconds).replace(',', '.');
  const body = captions
    .map((cap) => `${time(cap.startTime)} --> ${time(cap.endTime)}\n${cap.text}\n`)
    .join('\n');
  return 'WEBVTT\n\n' + body;
}

function setCaptionSource(source) {
  state.captionSource = source;
  const isFile = source === 'file';

  if (captionsSourceSequence) captionsSourceSequence.classList.toggle('active', !isFile);
  if (captionsSourceFile) captionsSourceFile.classList.toggle('active', isFile);
  if (captionsFileRow) captionsFileRow.classList.toggle('hidden', !isFile);
  if (captionsSequenceSection) captionsSequenceSection.classList.toggle('hidden', isFile);
  if (captionsTracksSection) captionsTracksSection.classList.toggle('hidden', isFile);

  updateGenerateCaptionsButton();
  updateConnectionGuide();
}

async function cancelCaptionGeneration() {
  if (!state.isTranscribing) return;
  progressCancelBtn.disabled = true;
  progressCancelBtn.textContent = 'Cancelling...';
  try {
    await window.electronAPI.cancelCaptions();
  } catch (error) {
    // The generation promise will settle; nothing else to do here.
  }
}

async function runGenerateCaptions() {
  if (state.isProcessing) return;

  const useFile = state.captionSource === 'file';

  if (!useFile && !state.sequenceInfo) {
    showError('Open a sequence in Premiere, or switch to Audio / Video File');
    return;
  }

  let trackIndices = [];
  if (!useFile) {
    trackIndices = Array.from(document.querySelectorAll('.captions-audio-track-cb:checked'))
      .map(cb => parseInt(cb.dataset.trackIndex, 10))
      .filter(index => !Number.isNaN(index));

    if (trackIndices.length === 0) {
      showError('Select at least one audio track');
      return;
    }
  } else if (!state.captionFilePath) {
    showError('Choose an audio or video file first');
    return;
  }

  state.isProcessing = true;
  state.isTranscribing = true;
  generateCaptionsBtn.disabled = true;
  showProgress('Starting caption generation...', { cancelable: true });
  setCaptionsStatus('Generating captions...', 'processing');

  const settings = {
    maxCharsPerLine: parseInt(document.getElementById('caption-max-chars').value),
    maxLines: parseInt(document.querySelector('#caption-max-lines-group .toggle-btn.active').dataset.value),
    maxDurationSeconds: parseFloat(document.getElementById('caption-max-duration').value)
  };

  try {
    const config = useFile
      ? { settings, audioPath: state.captionFilePath }
      : { settings, trackIndices };

    const result = await window.electronAPI.generateCaptions(config);

    hideProgress();
    state.isProcessing = false;
    state.isTranscribing = false;

    if (result.cancelled) {
      setCaptionsStatus('Transcription cancelled', 'idle');
      captionsFooterStatus.textContent = 'Cancelled';
      updateGenerateCaptionsButton();
      return;
    }

    if (result.success) {
      state.captionResult = result;
      invalidateCaptionReformat(); discardCaptionReplacementUndo();
      state.captionOriginal = structuredClone(result);
      state.captionEdited = false;
      // Keep the raw transcription so the text-style toggles stay reversible.
      state.captionRaw = result.captions.map((cap) => ({ ...cap }));

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

      // Apply the active text-style toggles, then show the preview.
      applyCaptionTransforms();
      displayCaptionsPreview(state.captionResult.captions);
      captionsPreviewSection.scrollIntoView({ block: 'start' });
    } else {
      setCaptionsStatus('Generation failed', 'error');
      showError(result.error || 'Caption generation failed');
    }
  } catch (error) {
    hideProgress();
    state.isProcessing = false;
    state.isTranscribing = false;
    setCaptionsStatus('Generation failed', 'error');
    showError(error.message || 'Caption generation failed');
  } finally {
    updateGenerateCaptionsButton();
  }
}

let captionReformatTimer = null;
let captionReformatRequest = 0;
function currentCaptionSettings() {
  return { maxCharsPerLine: Number(document.getElementById('caption-max-chars').value),
    maxLines: Number(document.querySelector('#caption-max-lines-group .toggle-btn.active').dataset.value),
    maxDurationSeconds: Number(document.getElementById('caption-max-duration').value) };
}
function invalidateCaptionReformat() {
  ++captionReformatRequest;
  clearTimeout(captionReformatTimer);
}
function scheduleCaptionReformat() {
  invalidateCaptionReformat(); discardCaptionReplacementUndo();
  captionReformatTimer = setTimeout(reformatExistingCaptions, 250);
}
async function reformatExistingCaptions() {
  if (!state.captionResult || state.isProcessing) return;
  const request = ++captionReformatRequest;
  const chunks = state.captionEdited ? state.captionRaw.flatMap(caption => {
    const words = caption.text.trim().split(/\s+/).filter(Boolean);
    return words.map((text, index) => ({ text, timestamp: [caption.startTime + (caption.endTime - caption.startTime) * index / words.length,
      caption.startTime + (caption.endTime - caption.startTime) * (index + 1) / words.length] }));
  }) : state.captionOriginal?.chunks;
  if (!chunks) return;
  try {
    const result = await window.electronAPI.reformatCaptions(chunks, currentCaptionSettings());
    if (request !== captionReformatRequest) return;
    if (!result?.success) throw new Error(result?.error || 'Could not update caption formatting.');
    state.captionRaw = result.captions.map(caption => ({ ...caption }));
    applyCaptionTransforms();
    document.getElementById('caption-reformat-note').textContent = 'Caption formatting updated. Your text edits are kept.';
  } catch (error) { if (request === captionReformatRequest) document.getElementById('caption-reformat-note').textContent = error.message; }
}
function captionWarning(caption) {
  const duration = caption.endTime - caption.startTime;
  const speed = Array.from(caption.text.replace(/\s/g, '')).length / Math.max(duration, 0.01);
  const limit = currentCaptionSettings().maxCharsPerLine;
  const messages = [];
  if (speed > 20) messages.push(`${Math.round(speed)} characters/s — may be hard to read`);
  if (caption.text.split('\n').some(line => Array.from(line).length > limit)) messages.push('Line exceeds your character limit');
  return messages.join(' · ');
}
function updateCaptionExports() {
  state.captionResult.srt = buildSRT(state.captionResult.captions);
  state.captionResult.vtt = buildVTT(state.captionResult.captions);
}

const captionSearch = { matches: [], index: -1, undo: null };
function setupCaptionSearch() {
  const find = document.getElementById('caption-find');
  find.addEventListener('input', () => {
    document.getElementById('caption-replace-status').textContent = '';
    refreshCaptionSearch(true); revealCaptionMatch(false);
  });
  ['caption-find-case', 'caption-find-whole'].forEach(id => document.getElementById(id).addEventListener('change', () => {
    document.getElementById('caption-replace-status').textContent = '';
    refreshCaptionSearch(true); revealCaptionMatch(false);
  }));
  find.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); moveCaptionMatch(event.shiftKey ? -1 : 1);
  });
  document.getElementById('caption-find-previous').addEventListener('click', () => moveCaptionMatch(-1));
  document.getElementById('caption-find-next').addEventListener('click', () => moveCaptionMatch(1));
  document.getElementById('caption-replace-one').addEventListener('click', () => replaceCaptionText(false));
  document.getElementById('caption-replace-all').addEventListener('click', () => replaceCaptionText(true));
  document.getElementById('caption-undo-replace').addEventListener('click', undoCaptionReplacement);
}
function refreshCaptionSearch(reset = false) {
  captionSearch.matches = findCaptionMatches(state.captionResult?.captions || [], document.getElementById('caption-find').value, {
    matchCase: document.getElementById('caption-find-case').checked,
    wholeWords: document.getElementById('caption-find-whole').checked
  });
  captionSearch.index = captionSearch.matches.length ? (reset ? 0 : Math.max(0, Math.min(captionSearch.index, captionSearch.matches.length - 1))) : -1;
  renderCaptionSearch();
}
function renderCaptionSearch() {
  const { matches, index } = captionSearch;
  const current = matches[index];
  const matchedRows = new Set(matches.map(match => match.captionIndex));
  [...captionsPreview.children].forEach((row, captionIndex) => {
    row.classList.toggle('caption-search-match', matchedRows.has(captionIndex));
    row.classList.toggle('caption-search-current', captionIndex === current?.captionIndex);
  });
  for (const id of ['caption-find-previous', 'caption-find-next', 'caption-replace-one', 'caption-replace-all']) {
    document.getElementById(id).disabled = !matches.length;
  }
  const status = document.getElementById('caption-search-status');
  status.textContent = !document.getElementById('caption-find').value ? 'Search your generated captions.'
    : current ? `${index + 1} of ${matches.length} ${matches.length === 1 ? 'match' : 'matches'} · Caption ${current.captionIndex + 1}` : 'No matches';
}
function revealCaptionMatch(focus) {
  const match = captionSearch.matches[captionSearch.index];
  if (!match) return;
  const row = captionsPreview.children[match.captionIndex];
  const editor = row.querySelector('textarea');
  // Scroll the subtitle list first; keyboard navigation also reveals the editor.
  const top = row.getBoundingClientRect().top - captionsPreview.getBoundingClientRect().top + captionsPreview.scrollTop;
  if (top < captionsPreview.scrollTop || top + row.offsetHeight > captionsPreview.scrollTop + captionsPreview.clientHeight) {
    captionsPreview.scrollTop = Math.max(0, top - 8);
  }
  if (focus) {
    const workspace = captionsPreviewSection.closest('.content-scroll').getBoundingClientRect();
    const bounds = editor.getBoundingClientRect();
    if (bounds.top < workspace.top || bounds.bottom > workspace.bottom) editor.scrollIntoView({ block: 'nearest' });
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(match.start, match.end);
  }
}
function moveCaptionMatch(direction) {
  refreshCaptionSearch();
  if (!captionSearch.matches.length) return;
  captionSearch.index = (captionSearch.index + direction + captionSearch.matches.length) % captionSearch.matches.length;
  renderCaptionSearch(); revealCaptionMatch(true);
}
function discardCaptionReplacementUndo() {
  captionSearch.undo = null;
  document.getElementById('caption-undo-replace').classList.add('hidden');
  document.getElementById('caption-replace-status').textContent = '';
}
function replaceCaptionText(all) {
  refreshCaptionSearch();
  if (!captionSearch.matches.length) return;
  const matches = all ? captionSearch.matches : [captionSearch.matches[captionSearch.index]];
  const replacement = document.getElementById('caption-replace').value;
  const captions = replaceCaptionMatches(state.captionResult.captions, matches, replacement);
  const changed = captions.some((caption, index) => caption.text !== state.captionResult.captions[index].text);
  if (!changed) { document.getElementById('caption-replace-status').textContent = 'The replacement is the same as the matching text.'; return; }
  invalidateCaptionReformat();
  captionSearch.undo = { captions: structuredClone(state.captionResult.captions), raw: structuredClone(state.captionRaw), edited: state.captionEdited };
  state.captionResult.captions = captions;
  const affected = new Set(matches.map(match => match.captionIndex));
  affected.forEach(index => { state.captionRaw[index].text = captions[index].text; });
  state.captionEdited = true;
  updateCaptionExports(); displayCaptionsPreview(captions);
  document.getElementById('caption-undo-replace').classList.remove('hidden');
  document.getElementById('caption-replace-status').textContent = `Replaced ${matches.length} ${matches.length === 1 ? 'match' : 'matches'} in ${affected.size} ${affected.size === 1 ? 'caption' : 'captions'}.`;
  revealCaptionMatch(false);
}
function undoCaptionReplacement() {
  if (!captionSearch.undo) return;
  invalidateCaptionReformat();
  state.captionResult.captions = captionSearch.undo.captions;
  state.captionRaw = captionSearch.undo.raw;
  state.captionEdited = captionSearch.undo.edited;
  discardCaptionReplacementUndo();
  updateCaptionExports(); displayCaptionsPreview(state.captionResult.captions);
  document.getElementById('caption-replace-status').textContent = 'Replacement undone.';
}
function displayCaptionsPreview(captions) {
  captionsPreviewSection.style.display = 'block';
  captionsCount.textContent = `${captions.length} captions`;
  captionsPreview.innerHTML = '';
  captions.forEach((caption, index) => {
    const row = document.createElement('div'); row.className = 'caption-item';
    row.innerHTML = `<div class="caption-row-heading">Caption ${index + 1}</div><div class="caption-time-inputs"><label>Start (s)<input type="number" step="0.01" min="0" value="${caption.startTime}" aria-label="Caption ${index + 1} start"></label><label>End (s)<input type="number" step="0.01" min="0" value="${caption.endTime}" aria-label="Caption ${index + 1} end"></label></div><textarea class="caption-text-editor" dir="auto" aria-label="Caption ${index + 1} text" rows="2">${escapeHtml(caption.text)}</textarea><p class="caption-warning help-text"></p>`;
    const warning = row.querySelector('.caption-warning'); warning.textContent = captionWarning(caption);
    row.querySelector('textarea').addEventListener('input', event => {
      invalidateCaptionReformat(); discardCaptionReplacementUndo(); state.captionEdited = true;
      caption.text = event.target.value; state.captionRaw[index].text = event.target.value;
      updateCaptionExports(); warning.textContent = captionWarning(caption); refreshCaptionSearch();
    });
    row.querySelectorAll('input').forEach((input, field) => {
      const commitTiming = (resetInvalid) => {
        const value = Number(input.value), key = field === 0 ? 'startTime' : 'endTime';
        const candidate = { ...caption, [key]: value };
        const valid = input.value !== '' && Number.isFinite(value) && value >= 0 && candidate.startTime < candidate.endTime &&
          (!captions[index - 1] || candidate.startTime >= captions[index - 1].endTime) && (!captions[index + 1] || candidate.endTime <= captions[index + 1].startTime);
        if (!valid) {
          if (resetInvalid) input.value = caption[key];
          warning.textContent = 'Use increasing, non-overlapping caption timings.'; return;
        }
        if (value !== caption[key]) {
          invalidateCaptionReformat(); discardCaptionReplacementUndo(); state.captionEdited = true;
          caption[key] = value; state.captionRaw[index][key] = value; updateCaptionExports();
        }
        warning.textContent = captionWarning(caption);
      };
      input.addEventListener('input', () => commitTiming(false));
      input.addEventListener('change', () => commitTiming(true));
    });
    captionsPreview.appendChild(row);
  });
  refreshCaptionSearch();
}

function formatSRTTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(total / 3600000);
  const m = Math.floor(total / 60000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const ms = total % 1000;
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
    reconcileSequenceActions();
  }
}

// ========================================
// Settings Functions
// ========================================

let settingsReturnFocus = null;
async function openSettings() {
  if (settingsModal.classList.contains('hidden')) settingsReturnFocus = document.activeElement;
  document.querySelector('.app-container').inert = true;
  settingsModal.classList.remove('hidden');
  settingsBody.scrollTop = 0;
  settingsCloseBtn.focus({ preventScroll: true });
  document.getElementById('settings-account-btn').textContent = state.authState?.user ? 'Open account' : 'Sign in';

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

  // Refresh the update section so it reflects the real current state
  renderUpdateState();
  renderSettingsUpdateNotes(state.updateState.version, state.pendingUpdateNotes);
}

function closeSettings() {
  settingsModal.classList.add('hidden');
  document.querySelector('.app-container').inert = false;
  settingsReturnFocus?.focus();
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
    const cep = status.cep || {};
    cepPathInput.value = status.extensionsPath;

    if (cep.installed) {
      bridgeStatusDot.className = 'connection-dot connected';
      bridgeStatusText.textContent = 'CEP bridge installed';
    } else {
      bridgeStatusDot.className = 'connection-dot disconnected';
      bridgeStatusText.textContent = 'Bridge not installed';
    }
  } catch (err) {
    bridgeStatusDot.className = 'connection-dot disconnected';
    bridgeStatusText.textContent = 'Error checking bridge';
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
  [nleAutoBtn, nlePremiereBtn].forEach(btn => {
    if (btn) btn.classList.remove('active');
  });

  if (nle === null && nleAutoBtn) {
    nleAutoBtn.classList.add('active');
    nleStatusText.textContent = 'Auto-detecting based on which editor is open';
  } else if (nle === 'premiere' && nlePremiereBtn) {
    nlePremiereBtn.classList.add('active');
    nleStatusText.textContent = 'Locked to Premiere Pro';
  }
}

// ========================================
// Update Functions
// ========================================

async function manualCheckForUpdates() {
  checkUpdateBtn.disabled = true;
  try { applyUpdateState(await window.electronAPI.checkForUpdates()); }
  catch { applyUpdateState({ status: 'error', version: null, percent: 0, notes: null, error: 'Could not reach the update service.' }); }
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
  pinBtn.classList.toggle('active', isOnTop);
  pinBtn.setAttribute('aria-pressed', String(isOnTop));
  pinBtn.setAttribute('aria-label', isOnTop ? 'Turn off stay on top' : 'Stay on top');
  pinBtn.title = isOnTop ? 'Stop keeping SmoothyEdit above other windows' : 'Keep SmoothyEdit above other windows';
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
  } else if (platformInfo.isMac) {
    document.body.classList.add('platform-macos');
    console.log('[Platform] macOS detected - applying macOS styles');
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
    if (file) {
      try {
        const filePath = window.electronAPI.getDroppedFilePath(file);
        if (!filePath) throw new Error('This dropped item has no local file path. Use Browse to select it.');
        await selectCompressorSource(filePath);
      } catch (error) { showCompressorError(error.message || 'Could not read the dropped file.'); }
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
  const emptyGuide = document.getElementById('compressor-empty-guide');
  const folderSection = document.getElementById('compressor-folder-section');
  const filesSection = document.getElementById('compressor-files-section');
  const hardwareSection = document.getElementById('compressor-hardware-section');
  const settingsSection = document.getElementById('compressor-settings-section');
  const startBtn = document.getElementById('compressor-start-btn');
  const footerStatus = document.getElementById('compressor-footer-status');

  if (compressorState.currentSourcePath) {
    dropSection.classList.add('hidden');
    emptyGuide.classList.add('hidden');
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
      footerStatus.textContent = '';
    }

    // Update output path
    document.getElementById('compressor-output-path').textContent = compressorState.outputFolder || 'Output folder will be created automatically';

  } else {
    dropSection.classList.remove('hidden');
    emptyGuide.classList.remove('hidden');
    folderSection.classList.add('hidden');
    filesSection.classList.add('hidden');
    hardwareSection.classList.add('hidden');
    settingsSection.classList.add('hidden');
    startBtn.disabled = true;
    footerStatus.textContent = '';
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

// ========================================
// Assets (SVG / image -> PNG) Functions
// ========================================

const ASSET_RASTER_MAX = 8192;
const ASSET_DEFAULT_SVG_WIDTH = 1000;

const assetsState = {
  items: [],
  activeIndex: 0,
  previewUrl: null,
  outputFolder: null,
  widthTouched: false,
  busy: false
};

const assetsStatusBar = document.getElementById('assets-status-bar');
const assetsStatusText = document.getElementById('assets-status-text');
const assetsDropZone = document.getElementById('assets-drop-zone');
const assetsBrowseBtn = document.getElementById('assets-browse-btn');
const assetsPasteBtn = document.getElementById('assets-paste-btn');
const assetsPreviewSection = document.getElementById('assets-preview-section');
const assetsEmptyGuide = document.getElementById('assets-empty-guide');
const assetsPreviewImg = document.getElementById('assets-preview-img');
const assetsFileName = document.getElementById('assets-file-name');
const assetsFileInfo = document.getElementById('assets-file-info');
const assetsClearBtn = document.getElementById('assets-clear-btn');
const assetsOptimizeSection = document.getElementById('assets-optimize-section');
const assetsOptimizeToggle = document.getElementById('assets-optimize-toggle');
const assetsSvgPrecision = document.getElementById('assets-svg-precision');
const assetsSvgPrecisionValue = document.getElementById('assets-svg-precision-value');
const assetsOptimizeResult = document.getElementById('assets-optimize-result');
const assetsOutputSection = document.getElementById('assets-output-section');
const assetsWidthInput = document.getElementById('assets-width');
const assetsWidthValue = document.getElementById('assets-width-value');
const assetsBackground = document.getElementById('assets-background');
const assetsBackgroundColor = document.getElementById('assets-background-color');
const assetsDuration = document.getElementById('assets-duration');
const assetsDurationValue = document.getElementById('assets-duration-value');
const assetsOutputPath = document.getElementById('assets-output-path');
const assetsOutputChangeBtn = document.getElementById('assets-output-change-btn');
const assetsConvertBtn = document.getElementById('assets-convert-btn');
const assetsSaveAsBtn = document.getElementById('assets-saveas-btn');
const assetsSendBtn = document.getElementById('assets-send-btn');
const assetsFooterStatus = document.getElementById('assets-footer-status');

async function initAssets() {
  if (!assetsDropZone) return;
  setupAssetsListeners();
  await refreshAssetsOutputFolder();
}

function setupAssetsListeners() {
  assetsDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    assetsDropZone.classList.add('drag-over');
  });
  assetsDropZone.addEventListener('dragleave', () => {
    assetsDropZone.classList.remove('drag-over');
  });
  assetsDropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    assetsDropZone.classList.remove('drag-over');
    const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (files.length) await handleAssetFiles(files);
  });
  assetsDropZone.addEventListener('click', openAssetFilePicker);
  assetsBrowseBtn.addEventListener('click', openAssetFilePicker);
  assetsPasteBtn.addEventListener('click', () => pasteAssetsFromClipboard(null));
  assetsClearBtn.addEventListener('click', clearAssets);
  document.getElementById('assets-replace-btn').addEventListener('click', openAssetFilePicker);
  document.getElementById('assets-repaste-btn').addEventListener('click', () => pasteAssetsFromClipboard(null));
  document.getElementById('assets-remove-background-btn').addEventListener('click', () => processActiveAsset('remove-background'));
  document.getElementById('assets-upscale-btn').addEventListener('click', () => processActiveAsset('upscale'));
  document.getElementById('assets-restore-btn').addEventListener('click', restoreOriginalAsset);
  document.getElementById('assets-process-cancel-btn').addEventListener('click', async () => {
    assetsState.cancelRequested = true;
    document.getElementById('assets-process-cancel-btn').disabled = true;
    document.getElementById('assets-process-status').textContent = 'Canceling…';
    await window.electronAPI.assetsCancelProcessing();
  });
  window.electronAPI.onAssetsProcessingProgress?.(progress => {
    if (!assetsState.processing) return;
    document.getElementById('assets-process-status').textContent = progress.message;
    const bar = document.getElementById('assets-process-progress');
    if (typeof progress.percent === 'number') bar.value = progress.percent;
    else bar.removeAttribute('value');
  });
  assetsPreviewImg.addEventListener('load', () => {
    const item = assetsState.items[assetsState.activeIndex];
    if (!item || item.previewTracked || assetsPreviewImg.src !== assetsState.previewUrl) return;
    item.previewTracked = true;
    window.electronAPI.trackMediaPreview?.('assets')?.catch(() => {});
  });
  const previewFrame = document.querySelector('.assets-preview-frame');
  previewFrame.addEventListener('dragover', e => e.preventDefault());
  previewFrame.addEventListener('drop', async e => {
    e.preventDefault();
    if (!assetsState.busy && e.dataTransfer?.files.length) await handleAssetFiles(Array.from(e.dataTransfer.files));
  });

  document.addEventListener('paste', (e) => {
    if (state.currentTab !== 'assets') return;
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    e.preventDefault();
    pasteAssetsFromClipboard(e.clipboardData);
  });

  assetsOptimizeToggle.addEventListener('change', () => updateAssetsOptimizeResult());
  assetsSvgPrecision.addEventListener('input', () => {
    assetsSvgPrecisionValue.textContent = assetsSvgPrecision.value;
    updateAssetsOptimizeResult();
  });

  assetsWidthInput.addEventListener('input', () => {
    assetsState.widthTouched = true;
    updateAssetsWidthLabel();
  });

  assetsBackground.addEventListener('change', () => {
    assetsBackgroundColor.classList.toggle('hidden', assetsBackground.value !== 'custom');
  });

  assetsDuration.addEventListener('input', () => {
    assetsDurationValue.textContent = `${parseFloat(assetsDuration.value).toFixed(1)}s`;
  });

  assetsOutputChangeBtn.addEventListener('click', changeAssetsOutputFolder);
  assetsConvertBtn.addEventListener('click', () => convertAssets(false));
  assetsSaveAsBtn.addEventListener('click', () => convertAssets(true));
  assetsSendBtn.addEventListener('click', sendAssetsToPremiere);
}

function openAssetFilePicker() {
  if (assetsState.busy) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg,image/*';
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    if (files.length) handleAssetFiles(files);
  });
  input.click();
}

function setAssetsStatus(text, type = 'idle') {
  if (!assetsStatusBar) return;
  assetsStatusBar.className = `status-bar status-${type}`;
  assetsStatusText.textContent = text;
}

async function refreshAssetsOutputFolder() {
  try {
    const folder = await window.electronAPI.assetsGetOutputFolder();
    assetsState.outputFolder = folder || null;
    if (assetsOutputPath) assetsOutputPath.textContent = folder || 'No folder set';
  } catch (e) {
    console.error('Failed to load assets output folder:', e);
  }
}

async function changeAssetsOutputFolder() {
  try {
    const result = await window.electronAPI.assetsSelectOutputFolder(assetsState.outputFolder);
    if (result && !result.canceled && result.path) {
      assetsState.outputFolder = result.path;
      assetsOutputPath.textContent = result.path;
    }
  } catch (e) {
    showError('Failed to choose an output folder');
  }
}

async function handleAssetFiles(files) {
  if (assetsState.busy) return;
  const loaded = [];
  const failures = [];
  for (const file of files) {
    try {
      loaded.push(await loadAssetFile(file));
    } catch (e) {
      failures.push(`${file?.name || 'File'}: ${e.message || 'Could not read'}`);
      console.error('Could not read asset:', file && file.name, e);
    }
  }

  if (!loaded.length) {
    document.getElementById('assets-file-errors').textContent = failures.join(' · ');
    setAssetsStatus('Could not read the dropped file(s).', 'error');
    return;
  }

  assetsState.items = loaded;
  document.getElementById('assets-process-status').textContent = '';
  assetsState.failures = failures;
  document.getElementById('assets-file-errors').textContent = failures.join(' · ');
  renderAssetsFileList();
  assetsState.activeIndex = 0;
  assetsState.widthTouched = false;
  assetsWidthInput.value = '';
  renderAssetsPreview();
  updateAssetsUI();

  if (loaded.length > 1) {
    setAssetsStatus(`Loaded ${loaded.length} files — ready to convert`, 'idle');
  } else {
    setAssetsStatus(`Loaded ${loaded[0].name}`, 'idle');
  }
}

function clearAssets() {
  if (assetsState.busy) return;
  if (assetsState.previewUrl) {
    URL.revokeObjectURL(assetsState.previewUrl);
    assetsState.previewUrl = null;
  }
  assetsState.items = [];
  document.getElementById('assets-process-status').textContent = '';
  assetsState.failures = []; document.getElementById('assets-file-errors').textContent = ''; renderAssetsFileList();
  assetsState.activeIndex = 0;
  assetsPreviewImg.removeAttribute('src');
  assetsPreviewSection.classList.add('hidden');
  assetsOptimizeSection.classList.add('hidden');
  assetsOutputSection.classList.add('hidden');
  updateAssetsUI();
  setAssetsStatus('Assets', 'idle');
}

async function loadAssetFile(file) {
  const name = file.name || 'asset';
  const type = (file.type || '').toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  const isSvg = type.indexOf('svg') !== -1 || ext === 'svg';

  if (isSvg) {
    const svgText = await file.text();
    const dims = parseSvgDimensions(svgText);
    return {
      kind: 'svg',
      name,
      file,
      svgText,
      width: dims.width,
      height: dims.height,
      sizeBytes: file.size || new Blob([svgText]).size
    };
  }

  let width = null;
  let height = null;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    if (bitmap.close) bitmap.close();
  } catch (e) {
    // Some formats can't be decoded here; the preview/raster step will surface it.
  }

  return { kind: 'raster', name, file, width, height, sizeBytes: file.size };
}

function parseSvgDimensions(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') return { width: null, height: null };

    const parseLen = (value) => {
      if (!value) return null;
      const match = String(value).trim().match(/^([0-9]*\.?[0-9]+)/);
      if (!match) return null;
      const n = parseFloat(match[1]);
      return isFinite(n) && n > 0 ? n : null;
    };

    let width = parseLen(root.getAttribute('width'));
    let height = parseLen(root.getAttribute('height'));

    if (!width || !height) {
      const viewBox = root.getAttribute('viewBox');
      if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          if (!width) width = parts[2];
          if (!height) height = parts[3];
        }
      }
    }

    return { width: width || null, height: height || null };
  } catch (e) {
    return { width: null, height: null };
  }
}

function renderAssetsPreview() {
  const item = assetsState.items[assetsState.activeIndex];
  if (!item) return;

  if (assetsState.previewUrl) {
    URL.revokeObjectURL(assetsState.previewUrl);
    assetsState.previewUrl = null;
  }

  const url = URL.createObjectURL(getAssetSourceBlob(item, { optimize: false }));
  assetsState.previewUrl = url;
  assetsPreviewImg.src = url;

  const dims = item.width && item.height ? `${item.width}×${item.height}` : 'size unknown';
  const count = assetsState.items.length > 1
    ? ` · ${assetsState.activeIndex + 1} of ${assetsState.items.length}`
    : '';
  assetsFileName.textContent = item.name || 'asset';
  assetsFileInfo.textContent = `${item.kind.toUpperCase()} · ${dims} · ${formatBytes(item.sizeBytes || 0)}${count}`;

  assetsPreviewSection.classList.remove('hidden');
  assetsOptimizeSection.classList.toggle('hidden', item.kind !== 'svg');
  assetsOutputSection.classList.remove('hidden');

  if (!assetsState.widthTouched) {
    assetsWidthInput.value = item.kind === 'svg' ? ASSET_DEFAULT_SVG_WIDTH : (item.width || '');
  }
  updateAssetsWidthLabel();
  updateAssetsOptimizeResult();
}

function updateAssetsWidthLabel() {
  const value = parseInt(assetsWidthInput.value, 10);
  assetsWidthValue.textContent = isFinite(value) && value > 0 ? `${value}px` : 'auto';
}

function getAssetSourceBlob(item, options) {
  if (item.kind === 'svg') {
    const svg = options && options.optimize
      ? optimizeSvgText(item.svgText, { precision: parseInt(assetsSvgPrecision.value, 10) })
      : item.svgText;
    return new Blob([svg], { type: 'image/svg+xml' });
  }
  return item.file;
}

function updateAssetsOptimizeResult() {
  const item = assetsState.items[assetsState.activeIndex];
  if (!assetsOptimizeResult) return;
  if (!item || item.kind !== 'svg') {
    assetsOptimizeResult.textContent = '';
    return;
  }

  if (!assetsOptimizeToggle.checked) {
    assetsOptimizeResult.textContent = `Original SVG: ${formatBytes(item.sizeBytes || 0)} (optimization off)`;
    return;
  }

  try {
    const optimized = optimizeSvgText(item.svgText, { precision: parseInt(assetsSvgPrecision.value, 10) });
    const before = item.sizeBytes || new Blob([item.svgText]).size;
    const after = new Blob([optimized]).size;
    const saved = before > 0 ? Math.max(0, Math.round((1 - after / before) * 100)) : 0;
    assetsOptimizeResult.textContent = `${formatBytes(before)} → ${formatBytes(after)} (${saved}% smaller)`;
  } catch (e) {
    assetsOptimizeResult.textContent = '';
  }
}

function optimizeSvgText(svgText, options) {
  let out = String(svgText || '');
  out = out.replace(/<\?xml[\s\S]*?\?>/gi, '');
  out = out.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  out = out.replace(/<sodipodi:namedview[\s\S]*?\/>/gi, '');
  out = out.replace(/\s(?:sodipodi|inkscape|sketch|xmlns:sodipodi|xmlns:inkscape|xmlns:sketch|xmlns:dc|xmlns:cc|xmlns:rdf):[a-zA-Z-]+="[^"]*"/g, '');
  out = out.replace(/\sdata-name="[^"]*"/g, '');
  out = out.replace(/>\s+</g, '><');

  const precision = options && typeof options.precision === 'number' ? options.precision : 2;
  if (precision < 4) {
    out = roundSvgNumbers(out, Math.max(0, precision));
  }

  return out.trim();
}

function roundSvgNumbers(str, precision) {
  const factor = Math.pow(10, precision);
  return str.replace(/-?\d+\.\d+/g, (match) => {
    const n = parseFloat(match);
    if (!isFinite(n)) return match;
    const rounded = Math.round(n * factor) / factor;
    return String(rounded);
  });
}

function readAssetOptions() {
  const widthRaw = parseInt(assetsWidthInput.value, 10);
  return {
    optimize: assetsOptimizeToggle.checked,
    precision: parseInt(assetsSvgPrecision.value, 10),
    width: assetsState.widthTouched && isFinite(widthRaw) && widthRaw > 0 ? widthRaw : null,
    background: assetsBackground.value,
    backgroundColor: assetsBackgroundColor.value
  };
}

function resolveBackgroundColor(options) {
  switch (options.background) {
    case 'white': return '#ffffff';
    case 'black': return '#000000';
    case 'custom': return options.backgroundColor || '#ffffff';
    default: return null;
  }
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode this image'));
    };
    img.src = url;
  });
}

function clampInt(value, min, max) {
  const n = Math.round(value);
  if (!isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function renderAssetToPng(item, options) {
  const blob = getAssetSourceBlob(item, options);
  const img = await loadImageElement(blob);

  let intrinsicW = item.width || img.naturalWidth || null;
  let intrinsicH = item.height || img.naturalHeight || null;

  // SVGs without width/height report a default 300x150 from the decoder; fall
  // back to a sensible width and infer the height from the viewBox ratio.
  if (item.kind === 'svg' && !item.width && !item.height) {
    intrinsicW = ASSET_DEFAULT_SVG_WIDTH;
    intrinsicH = img.naturalWidth && img.naturalHeight
      ? Math.round(ASSET_DEFAULT_SVG_WIDTH * (img.naturalHeight / img.naturalWidth))
      : ASSET_DEFAULT_SVG_WIDTH;
  }

  const ratio = intrinsicW && intrinsicH ? intrinsicH / intrinsicW : 1;
  const defaultW = item.kind === 'svg' ? ASSET_DEFAULT_SVG_WIDTH : (intrinsicW || ASSET_DEFAULT_SVG_WIDTH);
  let targetW = options.width ? clampInt(options.width, 16, ASSET_RASTER_MAX) : defaultW;
  let targetH = targetW * ratio;
  const scale = Math.min(1, ASSET_RASTER_MAX / targetW, ASSET_RASTER_MAX / targetH);
  targetW = Math.max(1, Math.round(targetW * scale));
  targetH = Math.max(1, Math.round(targetH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const bg = resolveBackgroundColor(options);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, targetW, targetH);
  }
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const bytes = await new Promise((resolve, reject) => {
    canvas.toBlob((out) => {
      if (!out) {
        reject(new Error('PNG encoding failed'));
        return;
      }
      out.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
    }, 'image/png');
  });

  const baseName = (item.name || 'asset').replace(/\.[^.]+$/, '') || 'asset';
  return { bytes, width: targetW, height: targetH, fileName: `${baseName}.png` };
}

async function convertAssets(saveAs) {
  if (assetsState.busy || !assetsState.items.length) return;
  assetsState.busy = true;
  updateAssetsUI();
  const failures = [];
  let saved = 0;
  try {
    const options = readAssetOptions();
    const batch = saveAs ? [assetsState.items[assetsState.activeIndex]] : assetsState.items;
    for (const item of batch) {
      try {
        setAssetsStatus(`Converting ${item.name}…`, 'working');
        const rendered = await renderAssetToPng(item, options);
        const result = await window.electronAPI.assetsSavePng({ fileName: rendered.fileName, bytes: rendered.bytes, saveAs: !!saveAs });
        if (result?.canceled) { setAssetsStatus('Save canceled', 'idle'); return; }
        if (!result?.success) throw new Error(result?.error || 'Could not save the PNG');
        delete item.error; saved++;
      } catch (error) { item.error = error.message; failures.push(`${item.name}: ${error.message}`); }
    }
    document.getElementById('assets-file-errors').textContent = [...(assetsState.failures || []), ...failures].join(' · ');
    setAssetsStatus(`${saved} PNG${saved === 1 ? '' : 's'} saved${failures.length ? ` · ${failures.length} failed (see file list)` : ''}`, failures.length ? 'error' : 'success');
  } finally {
    assetsState.busy = false;
    updateAssetsUI();
  }
}

async function sendAssetsToPremiere() {
  if (assetsState.busy || !assetsState.items.length) return;

  assetsState.busy = true;
  updateAssetsUI();

  try {
    const item = assetsState.items[assetsState.activeIndex];
    setAssetsStatus(`Preparing ${item.name} for Premiere…`, 'working');
    const rendered = await renderAssetToPng(item, readAssetOptions());

    setAssetsStatus('Sending to Premiere…', 'working');
    const result = await window.electronAPI.assetsSendToPremiere({
      fileName: rendered.fileName,
      bytes: rendered.bytes,
      durationSeconds: parseFloat(assetsDuration.value) || 5
    });

    if (!result || !result.success) {
      throw new Error((result && result.error) || 'Premiere did not accept the image. Is the SmoothyEdit panel open?');
    }

    setAssetsStatus(`Sent to Premiere: ${rendered.fileName}`, 'success');
  } catch (e) {
    console.error('Send asset to Premiere failed:', e);
    setAssetsStatus(`Send failed: ${e.message}`, 'error');
    showError(`Could not send the image to Premiere: ${e.message}`);
  } finally {
    assetsState.busy = false;
    updateAssetsUI();
  }
}

function renderAssetsFileList() {
  const list = document.getElementById('assets-file-list'); list.innerHTML = '';
  if (assetsState.items.length < 2) return;
  assetsState.items.forEach((item, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'asset-file-option';
    button.textContent = item.name + (item.error ? ' — failed' : ''); button.title = item.error || item.name; button.setAttribute('aria-pressed', String(index === assetsState.activeIndex));
    button.disabled = assetsState.busy;
    button.addEventListener('click', () => { assetsState.activeIndex = index; assetsState.widthTouched = false; assetsWidthInput.value = ''; renderAssetsPreview(); updateAssetsUI(); });
    list.appendChild(button);
  });
}
function updateAssetsUI() {
  renderAssetsFileList();
  const tools = document.querySelector('.assets-tools-section');
  if (assetsState.items.length) assetsPreviewSection.after(tools); else document.getElementById('assets-input-section').before(tools);
  document.getElementById('assets-local-note').textContent = assetsState.items.length ? 'Free, on your device · Remove backgrounds or upscale images 2× / 4×. Models download once; your images stay on this computer.' : 'Remove backgrounds or upscale images 2× / 4×, free on your device. Add an image below to start. Models download once; your images stay on this computer.';
  const enabled = assetsState.items.length > 0 && !assetsState.busy;
  document.getElementById('assets-input-section').classList.toggle('hidden', assetsState.items.length > 0);
  for (const id of ['assets-clear-btn', 'assets-replace-btn', 'assets-repaste-btn', 'assets-remove-background-btn', 'assets-upscale-btn', 'assets-upscale-factor', 'assets-restore-btn']) {
    document.getElementById(id).disabled = !enabled;
  }
  document.getElementById('assets-restore-btn').classList.toggle('hidden', !assetsState.items[assetsState.activeIndex]?.original);
  document.getElementById('assets-process-cancel-btn').classList.toggle('hidden', !assetsState.processing);
  document.getElementById('assets-process-progress').classList.toggle('hidden', !assetsState.processing);
  document.getElementById('assets-preview-section').setAttribute('aria-busy', String(!!assetsState.processing));
  assetsEmptyGuide.classList.toggle('hidden', assetsState.items.length > 0);
  [assetsConvertBtn, assetsSaveAsBtn, assetsSendBtn].forEach((btn) => {
    if (btn) btn.disabled = !enabled || (btn === assetsSendBtn && !(state.isConnected && state.sequenceInfo?.hasSequence));
  });

  if (assetsFooterStatus) {
    if (!assetsState.items.length) {
      assetsFooterStatus.textContent = '';
    } else if (assetsState.items.length > 1) {
      assetsFooterStatus.textContent = `${assetsState.items.length} images loaded`;
    } else {
      assetsFooterStatus.textContent = '';
    }
  }

  if (assetsState.busy) {
    setAssetsStatus('Working…', 'working');
  } else if (!assetsState.items.length) {
    setAssetsStatus('Assets', 'idle');
  }
}

async function processActiveAsset(operation) {
  if (assetsState.busy || !assetsState.items.length) return;
  const index = assetsState.activeIndex;
  const item = assetsState.items[index];
  const factor = Number(document.getElementById('assets-upscale-factor').value);
  assetsState.busy = true;
  assetsState.processing = true;
  assetsState.cancelRequested = false;
  document.getElementById('assets-process-progress').value = 0;
  document.getElementById('assets-process-cancel-btn').disabled = false;
  document.getElementById('assets-process-status').textContent = 'Preparing image…';
  updateAssetsUI();
  try {
    // Work on the selected image's pixels, before output resizing/background compositing.
    const input = await renderAssetToPng(item, { optimize: false, width: null, background: 'transparent' });
    if (assetsState.cancelRequested) {
      document.getElementById('assets-process-status').textContent = 'Canceled. Your image is unchanged.';
      setAssetsStatus('Image processing canceled', 'idle');
      return;
    }
    const result = await window.electronAPI.assetsProcessImage({ operation, factor, bytes: input.bytes });
    if (result?.canceled) {
      document.getElementById('assets-process-status').textContent = 'Canceled. Your image is unchanged.';
      setAssetsStatus('Image processing canceled', 'idle');
      return;
    }
    if (!result?.success || !result.bytes?.length) throw new Error(result?.error || 'Could not process this image.');
    const suffix = operation === 'upscale' ? `-${factor}x` : '-cutout';
    const file = new File([result.bytes], item.name.replace(/\.[^.]+$/, '') + suffix + '.png', { type: 'image/png' });
    const updated = await loadAssetFile(file);
    updated.original = item.original || item;
    assetsState.items[index] = updated;
    assetsState.widthTouched = false;
    if (operation === 'remove-background') {
      assetsBackground.value = 'transparent';
      assetsBackgroundColor.classList.add('hidden');
    }
    renderAssetsPreview();
    document.getElementById('assets-process-status').textContent = operation === 'upscale'
      ? `Upscaled ${factor}× to ${updated.width} × ${updated.height}. Ready to save or send to Premiere.`
      : 'Background removed. Ready to save a transparent PNG or send to Premiere.';
    setAssetsStatus(operation === 'upscale' ? 'Image upscaled' : 'Background removed', 'success');
  } catch (error) {
    document.getElementById('assets-process-status').textContent = error.message || 'Image processing failed. Try again.';
    setAssetsStatus('Image processing failed', 'error');
  } finally {
    assetsState.busy = false;
    assetsState.processing = false;
    updateAssetsUI();
  }
}

function restoreOriginalAsset() {
  if (assetsState.busy) return;
  const item = assetsState.items[assetsState.activeIndex];
  if (!item?.original) return;
  assetsState.items[assetsState.activeIndex] = item.original;
  assetsState.widthTouched = false;
  document.getElementById('assets-process-status').textContent = '';
  renderAssetsPreview();
  updateAssetsUI();
  setAssetsStatus('Original image restored', 'idle');
}

async function pasteAssetsFromClipboard(clipboardData) {
  if (assetsState.busy) return;
  try {
    const files = [];

    if (clipboardData) {
      let svgText = '';
      try { svgText = clipboardData.getData('image/svg+xml') || ''; } catch (e) {}
      if (!svgText) {
        let html = '';
        try { html = clipboardData.getData('text/html') || ''; } catch (e) {}
        if (/<svg[\s>]/i.test(html)) {
          const match = html.match(/<svg[\s\S]*?<\/svg>/i);
          if (match) svgText = match[0];
        }
      }
      if (svgText) {
        files.push(new File([svgText], 'clipboard.svg', { type: 'image/svg+xml' }));
      }

      if (clipboardData.files && clipboardData.files.length) {
        files.push(...Array.from(clipboardData.files));
      } else if (!files.length && clipboardData.items) {
        for (const item of Array.from(clipboardData.items)) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
      }
    }

    if (files.length) {
      await handleAssetFiles(files);
      return;
    }

    // Fallback: read the clipboard from the main process (incl. remote image URLs).
    setAssetsStatus('Reading clipboard…', 'working');
    const clip = await window.electronAPI.assetsReadClipboard();

    if (!clip || !clip.hasImage) {
      setAssetsStatus('No image found on the clipboard.', 'idle');
      return;
    }

    let file = null;
    if (clip.svgText) {
      file = new File([clip.svgText], clip.name || 'clipboard.svg', { type: 'image/svg+xml' });
    } else if (clip.base64) {
      const binary = atob(clip.base64);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      file = new File([arr], clip.name || 'clipboard.png', { type: clip.mime || 'image/png' });
    }

    if (!file) {
      setAssetsStatus('No image found on the clipboard.', 'idle');
      return;
    }
    await handleAssetFiles([file]);
  } catch (e) {
    console.error('Paste failed:', e);
    setAssetsStatus(`Paste failed: ${e.message}`, 'error');
  }
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
