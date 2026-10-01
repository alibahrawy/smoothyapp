/**
 * Preload script - Exposes safe IPC methods to renderer
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Get current status
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Refresh sequence info
  refreshSequence: () => ipcRenderer.invoke('refresh-sequence'),

  // Start AutoCut processing
  startAutoCut: (config: any) => ipcRenderer.invoke('start-autocut', config),

  // Start Silence Removal processing
  startSilenceRemoval: (config: any) => ipcRenderer.invoke('start-silence-removal', config),

  // Website connection
  saveConnectionToken: (token: string) => ipcRenderer.invoke('save-connection-token', token),
  getConnectionToken: () => ipcRenderer.invoke('get-connection-token'),
  connectToWebsite: () => ipcRenderer.invoke('connect-to-website'),
  disconnectFromWebsite: () => ipcRenderer.invoke('disconnect-from-website'),
  getWebsiteConnectionStatus: () => ipcRenderer.invoke('get-website-connection-status'),

  // Best Shorts
  exportAudioToWebsite: () => ipcRenderer.invoke('export-audio-to-website'),
  clearMarkers: (scope = 'smoothy', sequenceId?: string) => ipcRenderer.invoke('clear-markers', { scope, sequenceId }),
  exportSubtitles: () => ipcRenderer.invoke('export-subtitles'),

  // Studio (cloud)
  getStudioCredits: () => ipcRenderer.invoke('get-studio-credits'),
  getShortsHistory: (page = 1) => ipcRenderer.invoke('get-shorts-history', page),
  analyzeShorts: (config?: import('../main/shorts-service').ShortsAnalysisConfig) => ipcRenderer.invoke('analyze-shorts', config),
  cancelShorts: () => ipcRenderer.invoke('cancel-analyze-shorts'),
  retryShortsHistory: (payload: { text: string; fileName: string }) => ipcRenderer.invoke('retry-shorts-history', payload),
  reformatCaptions: (chunks: any[], settings: any) => ipcRenderer.invoke('reformat-captions', { chunks, settings }),
  selectShortsAudio: () => ipcRenderer.invoke('select-caption-audio'),
  getShortsYoutubeTranscript: (url: string) => ipcRenderer.invoke('get-shorts-youtube-transcript', url),
  copyShortsText: (text: string) => ipcRenderer.invoke('copy-shorts-text', text),
  addShortsMarkers: (shorts: any[]) => ipcRenderer.invoke('add-shorts-markers', shorts),

  // Captions
  getCaptionModels: () => ipcRenderer.invoke('get-caption-models'),
  getCaptionModelStatus: () => ipcRenderer.invoke('get-caption-model-status'),
  downloadCaptionModel: (modelId: string) => ipcRenderer.invoke('download-caption-model', modelId),
  generateCaptions: (config: { audioPath?: string; settings: any; trackIndices?: number[] }) =>
    ipcRenderer.invoke('generate-captions', config),
  cancelCaptions: () => ipcRenderer.invoke('cancel-generate-captions'),
  selectCaptionAudio: () => ipcRenderer.invoke('select-caption-audio'),
  saveCaptions: (options: { format: string; content: string; fileName?: string }) =>
    ipcRenderer.invoke('save-captions', options),
  importCaptionsToPremiere: (captions: any[]) =>
    ipcRenderer.invoke('import-captions-to-premiere', captions),
  unloadCaptionModel: () => ipcRenderer.invoke('unload-caption-model'),
  getCaptionEngineInfo: () => ipcRenderer.invoke('get-caption-engine-info'),
  getCaptionEngine: () => ipcRenderer.invoke('get-caption-engine'),
  setCaptionEngine: (engine: string) => ipcRenderer.invoke('set-caption-engine', engine),
  getSelectedCaptionModel: () => ipcRenderer.invoke('get-selected-caption-model'),
  setSelectedCaptionModel: (modelId: string) => ipcRenderer.invoke('set-selected-caption-model', modelId),
  getCaptionLanguages: () => ipcRenderer.invoke('get-caption-languages'),
  getCaptionLanguage: () => ipcRenderer.invoke('get-caption-language'),
  setCaptionLanguage: (code: string) => ipcRenderer.invoke('set-caption-language', code),

  // Auth
  login: (email: string, password: string, totpCode?: string) =>
    ipcRenderer.invoke('auth-login', { email, password, totpCode }),
  logout: () => ipcRenderer.invoke('auth-logout'),
  getAuthState: () => ipcRenderer.invoke('auth-get-state'),
  refreshAuth: () => ipcRenderer.invoke('auth-refresh'),
  getTrialStatus: () => ipcRenderer.invoke('get-trial-status'),
  canUseFeature: (feature: string) => ipcRenderer.invoke('can-use-feature', feature),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Theme sync
  syncThemeFromWebsite: () => ipcRenderer.invoke('sync-theme-from-website'),
  saveThemeToWebsite: (theme: string) => ipcRenderer.invoke('save-theme-to-website', theme),
  saveThemeLocal: (theme: string) => ipcRenderer.invoke('save-theme-local', theme),

  // Window always on top
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),

  // Preferences
  getShowLogs: () => ipcRenderer.invoke('get-show-logs'),
  setShowLogs: (value: boolean) => ipcRenderer.invoke('set-show-logs', value),

  // Auto-updater
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // NLE Bridge
  getActiveNLE: () => ipcRenderer.invoke('get-active-nle'),
  setActiveNLE: (nle: 'premiere' | null) => ipcRenderer.invoke('set-active-nle', nle),

  // Premiere Bridge
  getBridgeStatus: () => ipcRenderer.invoke('get-bridge-status'),
  installBridge: () => ipcRenderer.invoke('install-bridge'),
  installLegacyCepBridge: () => ipcRenderer.invoke('install-legacy-cep-bridge'),
  setCepPath: (customPath?: string) => ipcRenderer.invoke('set-cep-path', customPath),
  browseCepPath: () => ipcRenderer.invoke('browse-cep-path'),

  // Assets (SVG / image -> PNG)
  assetsGetOutputFolder: () => ipcRenderer.invoke('assets-get-output-folder'),
  assetsSelectOutputFolder: (defaultPath?: string) => ipcRenderer.invoke('assets-select-output-folder', defaultPath),
  assetsSavePng: (options: { fileName: string; bytes: Uint8Array; saveAs?: boolean }) =>
    ipcRenderer.invoke('assets-save-png', options),
  assetsSendToPremiere: (options: { fileName: string; bytes: Uint8Array; durationSeconds?: number }) =>
    ipcRenderer.invoke('assets-send-to-premiere', options),
  assetsReadClipboard: () => ipcRenderer.invoke('assets-read-clipboard'),

  // Video Compressor
  compressorCheckFFmpeg: () => ipcRenderer.invoke('compressor-check-ffmpeg'),
  compressorDetectHardware: () => ipcRenderer.invoke('compressor-detect-hardware'),
  compressorScanDirectory: (dirPath: string) => ipcRenderer.invoke('compressor-scan-directory', dirPath),
  getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  compressorScanSource: (sourcePath: string) => ipcRenderer.invoke('compressor-scan-source', sourcePath),
  compressorStart: (files: any[], settings: any) => ipcRenderer.invoke('compressor-start', files, settings),
  compressorStop: () => ipcRenderer.invoke('compressor-stop'),
  compressorIsRunning: () => ipcRenderer.invoke('compressor-is-running'),
  compressorGetStats: () => ipcRenderer.invoke('compressor-get-stats'),
  compressorSelectFolder: () => ipcRenderer.invoke('compressor-select-folder'),
  compressorSelectSource: () => ipcRenderer.invoke('compressor-select-source'),
  compressorSelectOutputFolder: (defaultPath?: string) => ipcRenderer.invoke('compressor-select-output-folder', defaultPath),
  onCompressorProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('compressor-progress', (_, data) => callback(data));
  },
  onCompressorHardwareDetected: (callback: (data: any) => void) => {
    ipcRenderer.on('compressor-hardware-detected', (_, data) => callback(data));
  },
  onCompressorStatsUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('compressor-stats-update', (_, data) => callback(data));
  },
  onCompressorComplete: (callback: (data: any) => void) => {
    ipcRenderer.on('compressor-complete', (_, data) => callback(data));
  },

  // Event listeners
  onConnectionChange: (callback: (data: any) => void) => {
    ipcRenderer.on('connection-change', (_, data) => callback(data));
  },
  onSequenceInfo: (callback: (info: any) => void) => {
    ipcRenderer.on('sequence-info', (_, info) => callback(info));
  },
  onProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('progress', (_, data) => callback(data));
  },
  onAutoCutResult: (callback: (result: any) => void) => {
    ipcRenderer.on('autocut-result', (_, result) => callback(result));
  },
  onWebsiteConnectionChange: (callback: (data: any) => void) => {
    ipcRenderer.on('website-connection-change', (_, data) => callback(data));
  },
  onWebsiteMessage: (callback: (data: any) => void) => {
    ipcRenderer.on('website-message', (_, data) => callback(data));
  },
  onExportProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('export-progress', (_, data) => callback(data));
  },
  onShortsProgress: (callback: (data: { message: string }) => void) => {
    ipcRenderer.on('shorts-progress', (_, data) => callback(data));
  },
  onAuthStateChange: (callback: (state: any) => void) => {
    ipcRenderer.on('auth-state-change', (_, state) => callback(state));
  },
  onThemeSync: (callback: (data: { theme: string }) => void) => {
    ipcRenderer.on('theme-sync', (_, data) => callback(data));
  },
  onPlatformInfo: (callback: (data: { isMac: boolean; isWindows: boolean }) => void) => {
    ipcRenderer.on('platform-info', (_, data) => callback(data));
  },
  onCaptionModelProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('caption-model-progress', (_, data) => callback(data));
  },
  onCaptionProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('caption-progress', (_, data) => callback(data));
  },
  onUpdateStatus: (callback: (data: any) => void) => {
    ipcRenderer.on('update-status', (_, data) => callback(data));
  },
  onUpdateNotes: (callback: (data: { version: string; notes: string | null }) => void) => {
    ipcRenderer.on('update-notes', (_, data) => callback(data));
  },

  // Log streaming from main process
  onLogMessage: (callback: (data: { level: string; message: string; timestamp: string }) => void) => {
    ipcRenderer.on('log-message', (_, data) => callback(data));
  }
});
