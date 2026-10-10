/**
 * Preload script - Exposes safe IPC methods to renderer
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPreferences: () => ipcRenderer.invoke('get-app-preferences'),
  setStudioEnabled: (value: boolean) => ipcRenderer.invoke('set-studio-enabled', value),
  saveChatWritingPrompt: (value: string) => ipcRenderer.invoke('save-chat-writing-prompt', value),
  resetChatWritingPrompt: () => ipcRenderer.invoke('reset-chat-writing-prompt'),
  onAppPreferencesChanged: (callback: (data: any) => void) => ipcRenderer.on('app-preferences-changed', (_, data) => callback(data)),
  studioSourceImport: (input: { source: 'transcript' | 'sequence' | 'audio'; audioPath?: string }) => ipcRenderer.invoke('studio-source-import', input),
  studioSourceCancel: () => ipcRenderer.invoke('studio-source-cancel'),
  onStudioSourceProgress: (callback: (data: { message: string }) => void) => { ipcRenderer.on('studio-source-progress', (_, data) => callback(data)); },
  studioToolsRun: (input: unknown) => ipcRenderer.invoke('studio-tools-run', input),
  studioToolsCancel: () => ipcRenderer.invoke('studio-tools-cancel'),
  studioToolsHistory: (input: { mode: string; page: number }) => ipcRenderer.invoke('studio-tools-history', input),
  studioToolsCopy: (text: string) => ipcRenderer.invoke('studio-tools-copy', text),
  studioToolsSave: (input: { mode: string; text: string }) => ipcRenderer.invoke('studio-tools-save', input),
  photosRun: (input: unknown) => ipcRenderer.invoke('photos-run', input),
  photosHistory: (input: { page?: number; favorites?: boolean }) => ipcRenderer.invoke('photos-history', input),
  photosFavorite: (input: { id: string; active: boolean }) => ipcRenderer.invoke('photos-favorite', input),
  photosDelete: (id: string) => ipcRenderer.invoke('photos-delete', id),
  photosReset: () => ipcRenderer.invoke('photos-reset'),
  photosSave: (id: string) => ipcRenderer.invoke('photos-save', id),
  photosCopy: (id: string) => ipcRenderer.invoke('photos-copy', id),
  photosPreview: (id: string) => ipcRenderer.invoke('photos-preview', id),
  photosPremiere: (id: string) => ipcRenderer.invoke('photos-premiere', id),
  trackMediaPreview: (kind: 'audio' | 'stock' | 'assets') => ipcRenderer.invoke('track-media-preview', kind),
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
  validateCaptionAudio: (filePath: string) => ipcRenderer.invoke('validate-caption-audio', filePath),
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
  signup: (input: { name: string; email: string; password: string }) => ipcRenderer.invoke('auth-signup', input),
  openInbox: (provider: string) => ipcRenderer.invoke('auth-open-inbox', provider),
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
  installUpdate: (version: string) => ipcRenderer.invoke('install-update', version),
  skipUpdate: (version: string) => ipcRenderer.invoke('skip-update', version),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
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

  // Text chat: signed requests and fixed, inexpensive models only.
  chatRun: (input: any) => ipcRenderer.invoke('chat-run', input),
  onChatChunk: (callback: (data: { requestId: string; delta: string }) => void) => {
    const listener = (_: unknown, data: { requestId: string; delta: string }) => callback(data);
    ipcRenderer.on('chat-chunk', listener);
    return () => ipcRenderer.removeListener('chat-chunk', listener);
  },
  chatCancel: () => ipcRenderer.invoke('chat-cancel'),
  chatReset: () => ipcRenderer.invoke('chat-reset'),
  chatAttach: (kind: 'image' | 'file', slots: number) => ipcRenderer.invoke('chat-attach', kind, slots),
  chatRelease: (ids: string[]) => ipcRenderer.invoke('chat-release', ids),
  chatHistoryList: () => ipcRenderer.invoke('chat-history-list'),
  chatHistorySave: (conversationId: string | null, turns: any[]) => ipcRenderer.invoke('chat-history-save', conversationId, turns),
  chatHistoryLoad: (conversationId: string) => ipcRenderer.invoke('chat-history-load', conversationId),
  chatHistoryDelete: (conversationId: string) => ipcRenderer.invoke('chat-history-delete', conversationId),
  chatCopy: (text: string) => ipcRenderer.invoke('chat-copy', text),
  chatSave: (text: string) => ipcRenderer.invoke('chat-save', text),

  // Assets (SVG / image -> PNG)
  assetsGetOutputFolder: () => ipcRenderer.invoke('assets-get-output-folder'),
  assetsSelectOutputFolder: (defaultPath?: string) => ipcRenderer.invoke('assets-select-output-folder', defaultPath),
  assetsSavePng: (options: { fileName: string; bytes: Uint8Array; saveAs?: boolean }) =>
    ipcRenderer.invoke('assets-save-png', options),
  assetsSendToPremiere: (options: { fileName: string; bytes: Uint8Array; durationSeconds?: number }) =>
    ipcRenderer.invoke('assets-send-to-premiere', options),
  assetsReadClipboard: () => ipcRenderer.invoke('assets-read-clipboard'),
  assetsProcessImage: (options: { operation: 'remove-background' | 'upscale'; bytes: Uint8Array; factor?: number }) => ipcRenderer.invoke('assets-process-image', options),
  assetsCancelProcessing: () => ipcRenderer.invoke('assets-cancel-processing'),
  onAssetsProcessingProgress: (callback: (data: any) => void) => ipcRenderer.on('assets-processing-progress', (_, data) => callback(data)),

  // Local audio collection and no-key Wikimedia Commons stock footage
  audioLibraryState: () => ipcRenderer.invoke('audio-library-state'),
  audioCommunityState: () => ipcRenderer.invoke('audio-community-state'),
  audioFavoriteSharing: (enabled: boolean) => ipcRenderer.invoke('audio-favorite-sharing', enabled),
  audioFavoriteSet: (options: { id: string; active: boolean }) => ipcRenderer.invoke('audio-favorite-set', options),
  onAudioCommunityChanged: (callback: (data: any) => void) => ipcRenderer.on('audio-community-changed', (_, data) => callback(data)),
  audioArchiveSearch: (options: any) => ipcRenderer.invoke('audio-archive-search', options),
  audioArchiveDownload: (options: any) => ipcRenderer.invoke('audio-archive-download', options),
  audioArchiveCancel: () => ipcRenderer.invoke('audio-archive-cancel'),
  onAudioArchiveProgress: (callback: (data: any) => void) => ipcRenderer.on('audio-archive-progress', (_, data) => callback(data)),
  audioLibraryOpen: () => ipcRenderer.invoke('audio-library-open'),
  audioLibraryStop: () => ipcRenderer.invoke('audio-library-stop'),
  audioLibrarySelectFolder: () => ipcRenderer.invoke('audio-library-select-folder'),
  audioLibraryPick: () => ipcRenderer.invoke('audio-library-pick'),
  audioLibraryKeep: (options: any) => ipcRenderer.invoke('audio-library-keep', options),
  audioLibraryUpdate: (options: any) => ipcRenderer.invoke('audio-library-update', options),
  audioLibraryDismiss: (id: string) => ipcRenderer.invoke('audio-library-dismiss', id),
  audioLibraryImport: (id: string) => ipcRenderer.invoke('audio-library-import', id),
  audioLibraryShowFolder: () => ipcRenderer.invoke('audio-library-show-folder'),
  onAudioLibraryChanged: (callback: (data: any) => void) => ipcRenderer.on('audio-library-changed', (_, data) => callback(data)),
  stockGetSettings: () => ipcRenderer.invoke('stock-get-settings'),
  stockSelectFolder: () => ipcRenderer.invoke('stock-select-folder'),
  stockSearch: (input: import('../main/stock-footage').StockSearch) => ipcRenderer.invoke('stock-search', input),
  stockDownload: (options: { videoId: number | string; fileId: number; premiere?: boolean }) => ipcRenderer.invoke('stock-download', options),
  stockCancelDownload: () => ipcRenderer.invoke('stock-cancel-download'),
  onStockDownloadProgress: (callback: (data: any) => void) => ipcRenderer.on('stock-download-progress', (_, data) => callback(data)),

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
  onPlatformInfo: (callback: (data: { isMac: boolean; isWindows: boolean; isExpanded: boolean }) => void) => {
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


  // Log streaming from main process
  onLogMessage: (callback: (data: { level: string; message: string; timestamp: string }) => void) => {
    ipcRenderer.on('log-message', (_, data) => callback(data));
  }
});
