/**
 * SmoothyEdit Electron App - Main Process
 */

import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
import { initTelemetry, trackEvent, trackTool, startHeartbeat } from './telemetry';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import {
  startNLEServers,
  stopNLEServers,
  setCallbacks,
  requestSequenceInfo,
  runAutoCut,
  runSilenceRemoval,
  getConnectionStatus,
  getSequenceInfo,
  getActiveNLE,
  setActiveNLE,
  exportAudio,
  addMarkersToSequence,
  clearMarkersFromSequence,
  exportSubtitles,
  sendCaptionsToNLE
} from './nle-router';
import {
  getConnectionStatus as getPremiereConnectionStatus
} from './websocket-server';
import {
  setWebsiteCallbacks,
  saveConnectionToken,
  getConnectionToken,
  connectToWebsite,
  disconnectFromWebsite,
  getWebsiteConnectionStatus,
  sendAudioToWebsite,
  sendToWebsite,
  fetchUserTheme,
  saveUserTheme,
  syncThemeFromWebsite
} from './website-connection';
import {
  initializeTrial,
  getAuthState,
  login,
  logout,
  refreshUserData,
  getTrialStatus,
  canUseFeature,
  setAuthChangeCallback,
  generateConnectionToken
} from './auth-service';
import {
  getAvailableModels,
  getModelById,
  getDefaultModelId,
  isEnglishOnlyModel,
  ensureModelDownloaded
} from './captions/model-manager';
import {
  WHISPER_LANGUAGES,
  DEFAULT_CAPTION_LANGUAGE,
  isSupportedLanguage,
  getLanguageName
} from './captions/languages';
import {
  formatCaptions,
  toSRT,
  toVTT,
  CaptionSettings,
  FormattedCaption
} from './captions/caption-formatter';
import * as whisperService from './captions/whisper-service';
import {
  stitchTimelineAudio,
  extractAudioTrack,
  cancelAudioExtraction,
  resetAudioExtractionCancel,
  cleanupTempFile,
  TimelineAudioClip
} from './autocut/audio-extractor';
import videoCompressor, { CompressionSettings, VideoFile } from './compressor/video-compressor';
import * as webApi from './web-api';
import type { StudioShort } from './web-api';

function swallowStdIOMaybeEpipe() {
  const handle = (err: any) => {
    if (err && err.code === 'EPIPE') return;
  };
  try {
    if (process.stdout) process.stdout.on('error', handle);
    if (process.stderr) process.stderr.on('error', handle);
  } catch {
    // Ignore any failure to attach listeners
  }
}

swallowStdIOMaybeEpipe();

let mainWindow: BrowserWindow | null = null;
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const store = new Store();
let compressorEventsBound = false;

// Cached GitHub release notes for the pending update (null = not fetched yet).
let updateNotesCache: string | null = null;

// Whether a caption/transcription job is currently running (for cancellation).
let captionsJobActive = false;

/**
 * Fetch the release body for a specific version from the public releases repo.
 * Used to show "what's new" in the update modal.
 */
async function fetchUpdateNotes(version: string): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'SmoothyEdit'
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch('https://api.github.com/repos/alibahrawy/smoothyapp/releases?per_page=20', { headers });
    if (!res.ok) return null;
    const releases = await res.json() as Array<{ tag_name?: string; name?: string; body?: string }>;
    const normalized = version.replace(/^v/, '');
    const match = releases.find((r) =>
      (r.tag_name || '').replace(/^v/, '') === normalized || (r.name || '').replace(/^v/, '') === normalized
    );
    return match?.body?.trim() || null;
  } catch (err) {
    console.warn('[Updater] Failed to fetch release notes:', err instanceof Error ? err.message : err);
    return null;
  }
}

function sendLog(level: string, message: string) {
  const timestamp = new Date().toLocaleTimeString();
  mainWindow?.webContents.send('log-message', { level, message, timestamp });
}

function bindCompressorEventForwarding() {
  if (compressorEventsBound) return;
  compressorEventsBound = true;

  videoCompressor.on('progress', (progress) => {
    mainWindow?.webContents.send('compressor-progress', progress);
  });

  videoCompressor.on('hardware-detected', (hardware) => {
    mainWindow?.webContents.send('compressor-hardware-detected', hardware);
  });

  videoCompressor.on('stats-update', (stats) => {
    mainWindow?.webContents.send('compressor-stats-update', stats);
  });

  videoCompressor.on('complete', (results) => {
    mainWindow?.webContents.send('compressor-complete', results);
  });
}

// ─── Windows GPU Optimization (NVIDIA, AMD, Intel) ─────────────────────────
// Must be set before app.whenReady()

if (isWindows) {
  // Prevent Chromium from blocking 3D APIs after GPU process crashes
  app.disableDomainBlockingFor3DAPIs();

  // Override the GPU blocklist to enable hardware acceleration on more hardware
  app.commandLine.appendSwitch('ignore-gpu-blocklist');

  // Enable GPU rasterization (GPU renders page content instead of CPU)
  app.commandLine.appendSwitch('enable-gpu-rasterization');

  // Use ANGLE D3D11 backend - most stable across NVIDIA, AMD, and Intel on Windows
  app.commandLine.appendSwitch('use-angle', 'd3d11');

  // Enable hardware-accelerated video decode (NVDEC/AMD VCN/Intel Quick Sync),
  // out-of-process canvas rasterization, and HEVC codec support
  app.commandLine.appendSwitch('enable-features', [
    'D3D11VideoDecoder',
    'CanvasOopRasterization',
    'PlatformHEVCDecoderSupport',
    'PlatformHEVCEncoderSupport'
  ].join(','));

  // Prevent CalculateNativeWinOcclusion from causing rendering issues
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// ─── Premiere Bridge Installation ───────────────────────────────────────────

const CEP_PLUGIN_ID = 'com.smoothyedit.panel';
const CEP_EXTENSION_ID = 'com.smoothyedit.autocut.panel';

function getDefaultCepPath(): string {
  if (isMac) {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
  }
  return path.join(process.env.APPDATA || '', 'Adobe', 'CEP', 'extensions');
}

function getCepExtensionsPath(): string {
  const custom = store.get('cepExtensionsPath') as string | null;
  return custom || getDefaultCepPath();
}

function getCepPluginSource(): string {
  // In packaged app: resources/cep-plugin
  // In dev: ../smoothyapp-cep (relative to project)
  const resourcePath = path.join(process.resourcesPath, 'cep-plugin');
  if (fs.existsSync(resourcePath)) {
    return resourcePath;
  }
  // Fallback for dev
  return path.join(__dirname, '..', '..', '..', 'smoothyapp-cep');
}

function getInstalledPanelPath(): string {
  return path.join(getCepExtensionsPath(), CEP_PLUGIN_ID);
}

/**
 * The panel version is stored in the CEP manifest. Reading it lets us reinstall
 * the panel whenever the app ships a newer one — previously we only installed
 * when the panel was completely missing, so caption-import fixes from a later
 * app build never reached anyone who had an older panel on disk.
 */
function readPanelVersion(pluginDir: string): string | null {
  try {
    const manifestPath = path.join(pluginDir, 'CSXS', 'manifest.xml');
    if (!fs.existsSync(manifestPath)) return null;
    const xml = fs.readFileSync(manifestPath, 'utf-8');
    const match = xml.match(/ExtensionBundleVersion="([^"]+)"/);
    return match ? match[1] : '0.0.0';
  } catch {
    return null;
  }
}

function getBundledPanelVersion(): string | null {
  return readPanelVersion(getCepPluginSource());
}

function getInstalledPanelVersion(): string | null {
  return readPanelVersion(getInstalledPanelPath());
}

function isBridgeInstalled(): { installed: boolean; path: string } {
  return {
    installed: fs.existsSync(path.join(getInstalledPanelPath(), 'CSXS', 'manifest.xml')),
    path: getInstalledPanelPath()
  };
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Write the `.debug` file Premiere looks for when loading an unsigned CEP
 * extension. Without it the (unsigned) panel never appears in
 * Window → Extensions.
 */
function writeCepDebugFile(pluginDir: string) {
  const debugXml = `<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="${CEP_EXTENSION_ID}">
    <HostList>
      <Host Name="PPRO" Port="8088"/>
    </HostList>
  </Extension>
</ExtensionList>
`;
  fs.writeFileSync(path.join(pluginDir, '.debug'), debugXml, 'utf-8');
}

// CSXS versions Premiere Pro reads. 9–11 cover older releases; 12 and 13 are
// what current Premiere builds look at.
const CSXS_DEBUG_VERSIONS = ['9', '10', '11', '12', '13'];

/**
 * Enable PlayerDebugMode so Premiere loads the unsigned CEP panel. On Windows
 * that is a set of registry values; on macOS it is a `defaults` domain per CSXS
 * version. Both are best-effort — a failure here should not abort the install.
 */
function enableCepDebugMode() {
  if (isWindows) {
    for (const version of CSXS_DEBUG_VERSIONS) {
      try {
        execFileSync('reg', ['add', `HKCU\\Software\\Adobe\\CSXS.${version}`, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], {
          stdio: 'ignore',
          windowsHide: true
        });
      } catch {
        // Registry entry not creatable (rare); the .debug file may still cover it.
      }
    }
    return;
  }

  if (isMac) {
    for (const version of CSXS_DEBUG_VERSIONS) {
      try {
        execFileSync('defaults', ['write', `com.adobe.CSXS.${version}`, 'PlayerDebugMode', '1'], { stdio: 'ignore' });
      } catch {
        // Missing domain is fine; `defaults write` normally creates it.
      }
    }
  }
}

/**
 * Install (or refresh) the bundled Premiere Pro CEP panel into the user's CEP
 * extensions folder. Safe to call on every launch: if the panel is missing or
 * a different version than the bundled one, it is replaced.
 */
function installBridge(): { success: boolean; path?: string; version?: string; error?: string } {
  try {
    const source = getCepPluginSource();
    if (!fs.existsSync(path.join(source, 'CSXS', 'manifest.xml'))) {
      return { success: false, error: `Bundled Premiere panel not found at ${source}` };
    }

    const extensionsPath = getCepExtensionsPath();
    const dest = getInstalledPanelPath();

    fs.mkdirSync(extensionsPath, { recursive: true });
    // Remove the old copy so renamed/removed files can't linger.
    fs.rmSync(dest, { recursive: true, force: true });
    copyDirSync(source, dest);
    writeCepDebugFile(dest);

    const version = getBundledPanelVersion() || undefined;

    clearSmoothyCepCaches();
    // Enable debug mode after clearing caches so Premiere reloads the new panel.
    enableCepDebugMode();

    console.log(`[CEP] Installed panel ${version || '?'} to ${dest}`);
    return { success: true, path: dest, version };
  } catch (error) {
    console.error('[CEP] installBridge failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to install the Premiere panel' };
  }
}

function clearSmoothyCepCaches() {
  const cacheRoots = isMac
    ? [path.join(app.getPath('home'), 'Library', 'Caches', 'CSXS', 'cep_cache')]
    : [path.join(process.env.APPDATA || '', 'Adobe', 'CEP', 'cep_cache')];

  for (const cacheRoot of cacheRoots) {
    if (!fs.existsSync(cacheRoot)) continue;

    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.includes('com.smoothyedit')) continue;
      fs.rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function createWindow() {
  // Platform-specific window options
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: ['white', 'cream'].includes((store.get('theme') as string) || 'cream') ? '#FEFDFB' : '#1a1a2e',
    icon: path.join(__dirname, '../../build/icon.png')
  };

  // macOS-specific: hidden title bar with traffic lights
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 15, y: 15 };
  }

  // Windows-specific: native frame with no menu bar
  if (isWindows) {
    windowOptions.frame = true;
    windowOptions.titleBarStyle = 'default';
    windowOptions.autoHideMenuBar = true;
  }

  mainWindow = new BrowserWindow(windowOptions);

  // Send platform info to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('platform-info', { isMac, isWindows });
  });

  // Load renderer
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://127.0.0.1:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// GPU crash recovery for Windows
if (isWindows) {
  app.on('gpu-process-crashed', (_event, killed) => {
    console.error('[GPU] GPU process crashed, killed:', killed);
    app.relaunch();
    app.exit(0);
  });
}

app.whenReady().then(() => {
  console.log('[App] Starting SmoothyEdit...');

  // Remove the default menu bar on Windows (File, Edit, View, etc.)
  if (isWindows) {
    Menu.setApplicationMenu(null);
  }

  // Trials removed — all local features free forever (no-op kept for compat)
  initializeTrial();

  // Anonymous usage telemetry (free app, no account). Best-effort only.
  initTelemetry(store);
  trackEvent('launch');
  startHeartbeat();

  // Set up auth state change callback
  setAuthChangeCallback((state) => {
    mainWindow?.webContents.send('auth-state-change', state);
  });

  // Start the Premiere WebSocket server
  startNLEServers();

  // Set up callbacks to send to renderer
  setCallbacks({
    onConnectionChange: (connected) => {
      const nle = getActiveNLE();
      sendLog('info', `Premiere Pro bridge ${connected ? 'connected' : 'disconnected'}`);
      mainWindow?.webContents.send('connection-change', { connected, nle });
    },
    onSequenceInfo: (info) => {
      mainWindow?.webContents.send('sequence-info', info);
    },
    onProgress: (progress, message) => {
      mainWindow?.webContents.send('progress', { progress, message });
    },
    onResult: (result) => {
      sendLog(result.success ? 'success' : 'error', result.message || result.error || 'Operation complete');
      mainWindow?.webContents.send('autocut-result', result);
    }
  });

  // Set up website connection callbacks
  setWebsiteCallbacks({
    onConnectionChange: (connected) => {
      sendLog('info', `Website ${connected ? 'connected' : 'disconnected'}`);
      mainWindow?.webContents.send('website-connection-change', { connected });
      // Sync theme when connected
      if (connected) {
        syncThemeFromWebsite();
      }
    },
    onThemeSync: (theme) => {
      sendLog('info', `Theme synced from website: ${theme}`);
      mainWindow?.webContents.send('theme-sync', { theme });
    },
    onMessage: async (data) => {
      sendLog('info', `Website message: ${data.type}`);

      if (data.type === 'addMarkers' && data.markers) {
        sendLog('info', `Adding ${data.markers.length} markers from website...`);
        // Add markers to Premiere through the CEP bridge.
        const result = await addMarkersToSequence(data.markers);
        if (!result.success) {
          sendLog('error', `Failed to add markers: ${result.error || 'Unknown marker error'}`);
          if (result.debug) {
            console.warn('[Main] Marker debug:', JSON.stringify(result.debug, null, 2));
          }
        } else {
          sendLog('success', `Markers added: ${result.count} markers via ${result.pluginType || 'unknown'}`);
        }
        mainWindow?.webContents.send('website-message', {
          type: 'markersAdded',
          success: result.success,
          count: result.count ?? data.markers.length,
          error: result.error,
          debug: result.debug,
          bridgeVersion: result.bridgeVersion,
          pluginType: result.pluginType,
          attemptedTypes: result.attemptedTypes,
          fallbackMethod: result.fallbackMethod
        });

        // Send confirmation back to website
        sendToWebsite({
          type: 'markersAdded',
          success: result.success,
          count: result.count ?? data.markers.length,
          error: result.error,
          debug: result.debug,
          bridgeVersion: result.bridgeVersion,
          pluginType: result.pluginType,
          attemptedTypes: result.attemptedTypes,
          fallbackMethod: result.fallbackMethod
        });
      } else if (data.type === 'clearMarkers') {
        sendLog('info', 'Clearing markers from website request');
        const result = await clearMarkersFromSequence();
        mainWindow?.webContents.send('website-message', {
          type: 'markersCleared',
          success: result.success,
          count: result.count
        });
        sendToWebsite({
          type: 'markersCleared',
          success: result.success,
          count: result.count
        });
      } else if (data.type === 'getStatus') {
        const seqInfo = getSequenceInfo();
        sendToWebsite({
          type: 'status',
          connected: getConnectionStatus(),
          sequenceName: seqInfo?.name || null,
          hasSequence: !!seqInfo?.hasSequence
        });
      } else {
        mainWindow?.webContents.send('website-message', data);
      }
    },
    onExportProgress: (progress, message) => {
      mainWindow?.webContents.send('export-progress', { progress, message });
    }
  });

  // Try to connect to website if token exists
  const token = getConnectionToken();
  if (token) {
    connectToWebsite();
  }

  createWindow();

  // Keep the Premiere Pro CEP panel in sync with the app. On macOS the panel
  // only reaches users via this install path; on Windows the NSIS installer
  // also copies it, but this guarantees updates when the app updates.
  const bundledPanelVersion = getBundledPanelVersion();
  const installedPanelVersion = getInstalledPanelVersion();
  const panelNeedsInstall = !isBridgeInstalled().installed || installedPanelVersion !== bundledPanelVersion;

  if (panelNeedsInstall) {
    console.log(
      `[CEP] Panel ${bundledPanelVersion || '?'} needed (installed: ${installedPanelVersion || 'none'}), installing...`
    );
    const result = installBridge();
    if (result.success) {
      console.log(`[CEP] Panel ${result.version || ''} installed at ${result.path}`);
    } else {
      console.warn('[CEP] Panel install failed:', result.error);
    }
  } else {
    console.log(`[CEP] Panel ${installedPanelVersion} is up to date at ${getInstalledPanelPath()}`);
  }

  // Auto-updater setup
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (msg?: any) => console.log('[Updater]', msg),
    warn: (msg?: any) => console.warn('[Updater]', msg),
    error: (msg?: any) => console.error('[Updater]', msg),
    debug: (msg?: any) => console.log('[Updater:debug]', msg)
  } as any;
  updateNotesCache = null;
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...');
    mainWindow?.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    mainWindow?.webContents.send('update-status', { status: 'available', version: info.version });
    updateNotesCache = null;
    fetchUpdateNotes(info.version).then((notes) => {
      updateNotesCache = notes;
      mainWindow?.webContents.send('update-notes', { version: info.version, notes });
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] App is up to date');
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-status', {
      status: 'downloading',
      percent: Math.round(progress.percent)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    mainWindow?.webContents.send('update-status', { status: 'downloaded', version: info.version });

    const emit = (notes: string | null) => mainWindow?.webContents.send('update-notes', { version: info.version, notes });
    if (updateNotesCache !== null) {
      emit(updateNotesCache);
    } else {
      fetchUpdateNotes(info.version).then((notes) => {
        updateNotesCache = notes;
        emit(notes);
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
    mainWindow?.webContents.send('update-status', { status: 'error', error: err.message });
  });

  // Check for updates (don't block app startup)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[Updater] Check failed:', err.message);
    });
  }, 3000);

  console.log('[App] Ready! Listening on ws://localhost:3456');
});

app.on('window-all-closed', () => {
  stopNLEServers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('get-status', () => {
  return {
    connected: getConnectionStatus(),
    sequenceInfo: getSequenceInfo(),
    nle: getActiveNLE()
  };
});

ipcMain.handle('refresh-sequence', () => {
  requestSequenceInfo();
});

ipcMain.handle('start-autocut', async (_, config) => {
  trackTool('multicam');
  return runAutoCut(config);
});

ipcMain.handle('start-silence-removal', async (_, config) => {
  trackTool('silence');
  return runSilenceRemoval(config);
});

// Website connection handlers
ipcMain.handle('save-connection-token', (_, token: string) => {
  saveConnectionToken(token);
  return { success: true };
});

ipcMain.handle('get-connection-token', () => {
  return getConnectionToken();
});

ipcMain.handle('connect-to-website', async () => {
  return await connectToWebsite();
});

ipcMain.handle('disconnect-from-website', () => {
  disconnectFromWebsite();
  return { success: true };
});

ipcMain.handle('get-website-connection-status', () => {
  return getWebsiteConnectionStatus();
});

ipcMain.handle('export-audio-to-website', async () => {
  trackTool('shorts');
  try {
    const seqInfo = getSequenceInfo();
    if (!seqInfo || !seqInfo.hasSequence) {
      return { success: false, error: 'No active sequence' };
    }

    // Export audio via CEP plugin
    const result = await exportAudio();
    if (!result.success) {
      return { success: false, error: result.error || 'Export failed' };
    }

    // Send to website
    sendAudioToWebsite(result.audioBase64, seqInfo.name, seqInfo.duration);

    return { success: true };
  } catch (error) {
    console.error('[Main] Export audio error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('clear-markers', async () => {
  try {
    const result = await clearMarkersFromSequence();
    return result;
  } catch (error) {
    console.error('[Main] Clear markers error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('export-subtitles', async () => {
  try {
    const result = await exportSubtitles();
    console.log('[Main] Subtitles exported:', result.success, 'count:', result.count);

    // Save SRT file to desktop if we have subtitles
    if (result.success && result.srt && result.count > 0) {
      const desktopPath = path.join(os.homedir(), 'Desktop');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `${result.sequenceName || 'subtitles'}_${timestamp}.srt`;
      const filePath = path.join(desktopPath, fileName);

      fs.writeFileSync(filePath, result.srt, 'utf-8');
      console.log('[Main] SRT saved to:', filePath);

      result.savedPath = filePath;
    }

    return result;
  } catch (error) {
    console.error('[Main] Export subtitles error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

// Auth handlers
ipcMain.handle('auth-login', async (_, { email, password, totpCode }) => {
  const result = await login(email, password, totpCode);

  // If login successful, auto-generate connection token and connect to website
  if (result.success) {
    const token = await generateConnectionToken();
    if (token) {
      saveConnectionToken(token);
      await connectToWebsite();
    }
  }

  return result;
});

ipcMain.handle('auth-logout', () => {
  logout();
  disconnectFromWebsite();
  return { success: true };
});

ipcMain.handle('auth-get-state', () => {
  return getAuthState();
});

ipcMain.handle('auth-refresh', async () => {
  return await refreshUserData();
});

// Deprecated: trials removed, kept for renderer compat (always free-forever)
ipcMain.handle('get-trial-status', () => {
  return getTrialStatus();
});

ipcMain.handle('can-use-feature', (_, feature: string) => {
  return canUseFeature(feature);
});

// Open external links
ipcMain.handle('open-external', (_, url: string) => {
  shell.openExternal(url);
});

// Theme sync handlers
ipcMain.handle('sync-theme-from-website', async () => {
  const theme = await fetchUserTheme();
  return { theme };
});

ipcMain.handle('save-theme-to-website', async (_, theme: string) => {
  const success = await saveUserTheme(theme);
  return { success };
});

ipcMain.handle('save-theme-local', (_, theme: string) => {
  store.set('theme', theme);
  return { success: true };
});

// Preferences
ipcMain.handle('get-show-logs', () => !!store.get('showLogs'));
ipcMain.handle('set-show-logs', (_, value: boolean) => {
  store.set('showLogs', !!value);
  return { success: true };
});

// Window always on top
ipcMain.handle('toggle-always-on-top', () => {
  if (mainWindow) {
    const isOnTop = mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(!isOnTop);
    return { alwaysOnTop: !isOnTop };
  }
  return { alwaysOnTop: false };
});

ipcMain.handle('get-always-on-top', () => {
  if (mainWindow) {
    return { alwaysOnTop: mainWindow.isAlwaysOnTop() };
  }
  return { alwaysOnTop: false };
});

// Caption generation handlers
ipcMain.handle('get-caption-models', () => {
  try {
    const models = getAvailableModels();
    console.log('[Captions] Available models:', models.length);
    return models;
  } catch (error) {
    console.error('[Captions] Failed to get models:', error);
    return [];
  }
});

ipcMain.handle('get-caption-model-status', () => {
  return {
    loaded: whisperService.isModelLoaded(),
    currentModelId: whisperService.getCurrentModelId()
  };
});

ipcMain.handle('download-caption-model', async (_, modelId: string) => {
  try {
    const model = getModelById(modelId);
    if (!model) {
      return { success: false, error: 'Model not found' };
    }

    const progressCallback = (progress: any) => {
      mainWindow?.webContents.send('caption-model-progress', {
        modelId,
        ...progress
      });
    };

    // Download GGML model file if needed
    await ensureModelDownloaded(modelId, progressCallback);

    // Load the model into whisper.cpp context
    await whisperService.loadModel(modelId, progressCallback);

    return { success: true };
  } catch (error) {
    console.error('[Main] Model download error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
});

ipcMain.handle('generate-captions', async (_, config: {
  audioPath?: string;
  settings: Partial<CaptionSettings>;
  trackIndices?: number[];
}) => {
  trackTool('captions');
  let tempAudioFiles: string[] = [];

  resetAudioExtractionCancel();
  captionsJobActive = true;

  try {
    let audioPath = config.audioPath;

    // A local file (audio or video) was chosen directly — normalise it to a
    // 16 kHz mono WAV so non-WAV/MP3 sources work too.
    if (audioPath) {
      mainWindow?.webContents.send('caption-progress', {
        status: 'exporting',
        message: 'Preparing audio file...'
      });
      try {
        const normalized = await extractAudioTrack(audioPath, `caption_file_${Date.now()}`);
        tempAudioFiles.push(normalized);
        audioPath = normalized;
      } catch (err) {
        if (err instanceof Error && err.message === 'AUDIO_EXTRACTION_CANCELLED') throw err;
        console.warn('[Captions] Could not normalize audio file, using it as-is:', err);
      }
    }

    // If no audio path provided, extract from sequence using ffmpeg
    if (!audioPath) {
      mainWindow?.webContents.send('caption-progress', {
        status: 'exporting',
        message: 'Extracting audio from sequence...'
      });

      // Get sequence info to find audio tracks
      const seqInfo = getSequenceInfo();
      if (!seqInfo || !seqInfo.hasSequence) {
        return { success: false, error: 'No active sequence' };
      }

      if (!seqInfo.audioTracks || seqInfo.audioTracks.length === 0) {
        return { success: false, error: 'No audio tracks in sequence' };
      }

      // Build a timeline-accurate WAV from every clip on the selected audio
      // tracks. Only using the first clip and ignoring clip in/out + timeline
      // offsets silently truncated long sequences.
      const selectedTracks = Array.isArray(config.trackIndices) && config.trackIndices.length > 0
        ? new Set<number>(config.trackIndices)
        : null;

      const timelineClips: TimelineAudioClip[] = [];
      for (const track of seqInfo.audioTracks) {
        if (selectedTracks && !selectedTracks.has(track.index)) continue;
        for (const clip of track.clips || []) {
          if (!clip || !clip.path) continue;
          timelineClips.push({
            path: clip.path,
            start: Number(clip.start) || 0,
            end: Number(clip.end) || 0,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint
          });
        }
      }

      if (timelineClips.length === 0) {
        return { success: false, error: 'No audio clips found on the selected tracks' };
      }

      mainWindow?.webContents.send('caption-progress', {
        status: 'exporting',
        message: `Preparing timeline audio (${timelineClips.length} clip${timelineClips.length === 1 ? '' : 's'})...`
      });

      const stitched = await stitchTimelineAudio(timelineClips, `caption_timeline_${Date.now()}`);
      tempAudioFiles.push(stitched.path);
      audioPath = stitched.path;
      console.log(`[Captions] Timeline audio ready: ${stitched.durationSeconds.toFixed(1)}s from ${stitched.clipCount} clip(s)`);

      if (stitched.durationSeconds < 1) {
        return { success: false, error: 'Extracted audio is empty' };
      }
    }

    // Resolve the model: whatever the user picked in Settings, else the default.
    const selectedModel = (store.get('captionModel') as string | null) || getDefaultModelId();

    // Resolve the language: stored preference, else auto-detect.
    const selectedLanguage = (store.get('captionLanguage') as string | null) || DEFAULT_CAPTION_LANGUAGE;

    // English-only (.en) models can't transcribe another language — fail with a
    // clear, actionable message instead of returning English gibberish.
    if (isEnglishOnlyModel(selectedModel) && selectedLanguage !== 'auto' && selectedLanguage !== 'en') {
      return {
        success: false,
        error: `The selected model can only transcribe English. Choose a multilingual model (e.g. Large v3 Turbo) to transcribe ${getLanguageName(selectedLanguage)}.`
      };
    }

    // An English-only model always transcribes English, so pin it rather than
    // asking whisper to auto-detect on a model that can't detect.
    const effectiveLanguage = isEnglishOnlyModel(selectedModel) ? 'en' : selectedLanguage;

    // Apply the user's engine choice (auto / cuda / cpu) before preparing the engine.
    whisperService.setEnginePreference((store.get('captionEngine') as 'auto' | 'cuda' | 'cpu') || 'auto');

    // Ensure the engine + model are ready (downloads on first use).
    if (!whisperService.isModelLoaded() || whisperService.getCurrentModelId() !== selectedModel) {
      mainWindow?.webContents.send('caption-progress', {
        status: 'loading-model',
        message: 'Preparing transcription engine (first run downloads it once)…'
      });

      await whisperService.loadModel(selectedModel, (progress) => {
        const isEngineDownload = progress.status === 'downloading-bin';
        const isModelDownload = progress.status === 'downloading';
        const pct = typeof progress.progress === 'number' ? Math.round(progress.progress) : undefined;
        let message: string;
        if (isEngineDownload) {
          message = `${progress.file || 'Downloading transcription engine (one-time setup)'}${pct != null ? ` — ${pct}%` : '…'}`;
        } else if (isModelDownload) {
          message = `Downloading transcription model (one-time setup)${pct != null ? ` — ${pct}%` : '…'}`;
        } else {
          message = `Preparing: ${progress.status}`;
        }

        mainWindow?.webContents.send('caption-progress', {
          status: 'loading-model',
          message,
          progress: (isEngineDownload || isModelDownload) ? (pct ?? 0) : undefined
        });
      });
    }

    // Transcribe
    mainWindow?.webContents.send('caption-progress', {
      status: 'transcribing',
      message: effectiveLanguage === 'auto'
        ? `Detecting language and transcribing on ${whisperService.getActiveBackend().toUpperCase()}...`
        : `Transcribing ${getLanguageName(effectiveLanguage)} on ${whisperService.getActiveBackend().toUpperCase()}...`
    });

    const transcriptionResult = await whisperService.transcribe(audioPath!, (progress) => {
      mainWindow?.webContents.send('caption-progress', {
        status: 'transcribing',
        message: progress.status,
        progress: progress.progress
      });
    }, selectedModel, effectiveLanguage);

    // Format captions
    mainWindow?.webContents.send('caption-progress', {
      status: 'formatting',
      message: 'Formatting captions...'
    });

    const captions = formatCaptions(transcriptionResult, config.settings);

    if (captions.length === 0) {
      console.warn('[Captions] 0 captions generated. Transcription text:', JSON.stringify(transcriptionResult.text?.slice(0, 200)));
      console.warn('[Captions] Transcription segments:', transcriptionResult.segments?.length || 0);
    }

    const srt = toSRT(captions);
    const vtt = toVTT(captions);

    mainWindow?.webContents.send('caption-progress', {
      status: 'complete',
      message: captions.length > 0 ? 'Captions generated!' : 'No speech detected in audio'
    });

    // Cleanup temp files
    tempAudioFiles.forEach(f => cleanupTempFile(f));
    captionsJobActive = false;

    return {
      success: true,
      captions,
      srt,
      vtt,
      text: transcriptionResult.text
    };
  } catch (error) {
    captionsJobActive = false;

    // Cleanup temp files on error
    tempAudioFiles.forEach(f => cleanupTempFile(f));

    const message = error instanceof Error ? error.message : 'Generation failed';

    if (message === 'TRANSCRIPTION_CANCELLED' || message === 'AUDIO_EXTRACTION_CANCELLED') {
      console.log('[Main] Caption generation cancelled by user');
      mainWindow?.webContents.send('caption-progress', { status: 'cancelled', message: 'Cancelled' });
      return { success: false, cancelled: true, error: 'Cancelled' };
    }

    console.error('[Main] Caption generation error:', error);
    return { success: false, error: message };
  }
});

ipcMain.handle('cancel-generate-captions', async () => {
  if (!captionsJobActive) return { success: true };
  await whisperService.cancelTranscription();
  cancelAudioExtraction();
  return { success: true };
});

ipcMain.handle('select-caption-audio', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an audio or video file',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif'] },
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts', 'mpg', 'mpeg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('save-captions', async (_, { format, content, fileName }: {
  format: 'srt' | 'vtt' | 'txt';
  content: string;
  fileName?: string;
}) => {
  try {
    const { dialog } = await import('electron');
    const fs = await import('fs');

    const extensions: Record<string, string[]> = {
      srt: ['srt'],
      vtt: ['vtt'],
      txt: ['txt']
    };

    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save Captions',
      defaultPath: fileName || `captions.${format}`,
      filters: [
        { name: `${format.toUpperCase()} File`, extensions: extensions[format] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { success: true, path: result.filePath };
  } catch (error) {
    console.error('[Main] Save captions error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Save failed' };
  }
});

ipcMain.handle('import-captions-to-premiere', async (_, captions: FormattedCaption[]) => {
  try {
    if (!Array.isArray(captions) || captions.length === 0) {
      return { success: false, error: 'No captions to import' };
    }

    // Write the SRT on the Node side using the exact same bytes as "Save SRT".
    // The previous flow rebuilt the file inside ExtendScript, which broke on
    // Windows paths and produced files Premiere rejected as malformed.
    const seqInfo = getSequenceInfo();
    const safeName = (seqInfo?.name || 'captions').replace(/[\\/:*?"<>|]/g, '_');
    const srtPath = path.join(os.tmpdir(), `${safeName}_captions_${Date.now()}.srt`);
    fs.writeFileSync(srtPath, toSRT(captions), 'utf-8');

    const result = await sendCaptionsToNLE(srtPath);

    return result;
  } catch (error) {
    console.error('[Main] Import captions error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Import failed' };
  }
});

ipcMain.handle('unload-caption-model', async () => {
  await whisperService.unloadModel();
  return { success: true };
});

ipcMain.handle('get-caption-engine-info', () => {
  return {
    backend: whisperService.getActiveBackend(),
    ready: whisperService.isModelLoaded(),
    currentModelId: whisperService.getCurrentModelId(),
    enginePreference: (store.get('captionEngine') as string) || 'auto'
  };
});

ipcMain.handle('get-caption-engine', () => {
  return (store.get('captionEngine') as string) || 'auto';
});

ipcMain.handle('set-caption-engine', async (_, preference: string) => {
  const normalized = preference === 'cuda' || preference === 'cpu' ? preference : 'auto';
  store.set('captionEngine', normalized);
  // Force a reload on the next transcription so the new engine is used.
  await whisperService.unloadModel();
  return { success: true, engine: normalized };
});

ipcMain.handle('get-selected-caption-model', () => {
  return (store.get('captionModel') as string | null) || getDefaultModelId();
});

ipcMain.handle('set-selected-caption-model', async (_, modelId: string) => {
  const model = getModelById(modelId);
  if (!model) return { success: false, error: 'Model not found' };
  store.set('captionModel', modelId);
  // Force a reload on the next transcription so the new model is used.
  await whisperService.unloadModel();
  return { success: true, modelId };
});

ipcMain.handle('get-caption-languages', () => WHISPER_LANGUAGES);

ipcMain.handle('get-caption-language', () => {
  return (store.get('captionLanguage') as string | null) || DEFAULT_CAPTION_LANGUAGE;
});

ipcMain.handle('set-caption-language', (_, code: string) => {
  const language = isSupportedLanguage(code) ? code : DEFAULT_CAPTION_LANGUAGE;
  store.set('captionLanguage', language);
  // Language is a per-run argument, so no model reload is needed.
  return { success: true, language };
});

// ─── Studio (cloud) handlers ────────────────────────────────────────────────
// Studio credits apply only here. Local tools (multicam, silence, captions,
// compressor) never call the web API and never spend credits.

function studioErrorPayload(error: unknown) {
  if (error instanceof webApi.NotSignedInError) {
    return { success: false, requiresLogin: true, error: error.message };
  }
  return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
}

ipcMain.handle('get-studio-credits', async () => {
  try {
    const credits = await webApi.getCredits();
    return { success: true, credits };
  } catch (error) {
    return studioErrorPayload(error);
  }
});

ipcMain.handle('get-shorts-history', async (_, page = 1) => {
  try {
    const history = await webApi.listShortsHistory(page);
    return { success: true, ...history };
  } catch (error) {
    return studioErrorPayload(error);
  }
});

ipcMain.handle('add-shorts-markers', async (_, shorts: StudioShort[]) => {
  try {
    if (!Array.isArray(shorts) || shorts.length === 0) {
      return { success: false, error: 'No shorts to send' };
    }
    const markers = shorts.map((short, index) => ({
      time: short.startTime,
      endTime: short.endTime,
      name: short.title || `Short ${index + 1}`,
      comment: short.description || short.reason || ''
    }));
    const result = await addMarkersToSequence(markers);
    return result;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add markers' };
  }
});

ipcMain.handle('analyze-shorts', async (_, config: { trackIndices?: number[] } = {}) => {
  trackTool('bestshorts');

  const tempAudioFiles: string[] = [];
  resetAudioExtractionCancel();
  captionsJobActive = true;

  const progress = (message: string) => {
    mainWindow?.webContents.send('shorts-progress', { message });
  };

  try {
    const seqInfo = getSequenceInfo();
    if (!seqInfo || !seqInfo.hasSequence) {
      return { success: false, error: 'No active sequence' };
    }

    const selectedTracks = Array.isArray(config.trackIndices) && config.trackIndices.length > 0
      ? new Set<number>(config.trackIndices)
      : null;

    const timelineClips: TimelineAudioClip[] = [];
    for (const track of seqInfo.audioTracks || []) {
      if (selectedTracks && !selectedTracks.has(track.index)) continue;
      for (const clip of track.clips || []) {
        if (!clip || !clip.path) continue;
        timelineClips.push({
          path: clip.path,
          start: Number(clip.start) || 0,
          end: Number(clip.end) || 0,
          inPoint: clip.inPoint,
          outPoint: clip.outPoint
        });
      }
    }

    if (timelineClips.length === 0) {
      return { success: false, error: 'No audio clips found on the selected tracks' };
    }

    // 1. Build one timeline-accurate WAV from the selected tracks.
    progress(`Preparing audio (${timelineClips.length} clip${timelineClips.length === 1 ? '' : 's'})...`);
    const stitched = await stitchTimelineAudio(timelineClips, `shorts_timeline_${Date.now()}`);
    tempAudioFiles.push(stitched.path);

    // 2. Transcribe locally with Whisper — free, offline, no credits.
    const selectedModel = (store.get('captionModel') as string | null) || getDefaultModelId();
    whisperService.setEnginePreference((store.get('captionEngine') as 'auto' | 'cuda' | 'cpu') || 'auto');

    if (!whisperService.isModelLoaded() || whisperService.getCurrentModelId() !== selectedModel) {
      progress('Preparing transcription engine...');
      await whisperService.loadModel(selectedModel, (p) => {
        progress(p.status === 'downloading'
          ? `Downloading model: ${p.progress || 0}%`
          : `Preparing: ${p.status}`);
      });
    }

    progress('Transcribing audio locally...');
    const transcription = await whisperService.transcribe(stitched.path, (p) => {
      progress(p.status);
    });

    const captions = formatCaptions(transcription, {});
    const subtitleText = toSRT(captions);
    if (!subtitleText.trim()) {
      return { success: false, error: 'No speech detected in the audio' };
    }

    // 3. Send only the text to Studio for analysis (this is what spends credits).
    progress('Finding the best shorts...');
    const { shorts } = await webApi.analyzeShorts(subtitleText, stitched.durationSeconds);
    if (shorts.length === 0) {
      return { success: false, error: 'No shorts found in this clip' };
    }

    // 4. Save to history so it appears on the web dashboard too.
    progress('Saving to history...');
    const historyText = JSON.stringify({ shorts }, null, 2);
    const fileName = seqInfo.name ? `${seqInfo.name} — shorts` : 'shorts';
    await webApi.saveShortsToHistory(historyText, fileName);

    // 5. Refresh credits so the meter reflects the spend.
    let credits = null;
    try { credits = await webApi.getCredits(); } catch { /* non-fatal */ }

    return { success: true, shorts, credits, duration: stitched.durationSeconds };
  } catch (error) {
    console.error('[Studio] analyze-shorts error:', error);
    return studioErrorPayload(error);
  } finally {
    tempAudioFiles.forEach((file) => cleanupTempFile(file));
    captionsJobActive = false;
  }
});

// Auto-updater handlers
ipcMain.handle('install-update', () => {
  // isForceRunAfter=true relaunches the app right after the installer finishes,
  // so a completed update can never leave the user on the old version.
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('check-for-updates', () => {
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[Updater] Manual check failed:', err.message);
  });
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Premiere Bridge handlers
ipcMain.handle('get-bridge-status', () => {
  const cepStatus = isBridgeInstalled();
  return {
    installed: cepStatus.installed,
    path: cepStatus.path,
    version: getInstalledPanelVersion(),
    bundledVersion: getBundledPanelVersion(),
    cep: cepStatus,
    extensionsPath: getCepExtensionsPath(),
    defaultPath: getDefaultCepPath(),
    isCustomPath: !!store.get('cepExtensionsPath')
  };
});

ipcMain.handle('install-bridge', () => {
  return installBridge();
});

ipcMain.handle('install-legacy-cep-bridge', () => {
  return installBridge();
});

ipcMain.handle('set-cep-path', async (_, customPath?: string) => {
  if (customPath) {
    store.set('cepExtensionsPath', customPath);
  } else {
    store.delete('cepExtensionsPath');
  }
  return { success: true, path: getCepExtensionsPath() };
});

ipcMain.handle('browse-cep-path', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Adobe CEP Extensions Folder',
    defaultPath: getCepExtensionsPath(),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

// NLE switching handlers
ipcMain.handle('get-active-nle', () => {
  return {
    activeNLE: getActiveNLE(),
    premiereConnected: getPremiereConnectionStatus()
  };
});

ipcMain.handle('set-active-nle', (_, nle: 'premiere' | null) => {
  setActiveNLE(nle);
  return { success: true, activeNLE: getActiveNLE() };
});

// Video Compression Handlers
ipcMain.handle('compressor-check-ffmpeg', async () => {
  return await videoCompressor.checkFFmpeg();
});

ipcMain.handle('compressor-detect-hardware', async () => {
  return await videoCompressor.detectHardware();
});

ipcMain.handle('compressor-scan-directory', async (_, dirPath: string) => {
  return videoCompressor.scanDirectory(dirPath);
});

ipcMain.handle('compressor-scan-source', async (_, sourcePath: string) => {
  return videoCompressor.scanSource(sourcePath);
});

ipcMain.handle('compressor-start', async (_, files: VideoFile[], settings: CompressionSettings) => {
  trackTool('compressor');
  bindCompressorEventForwarding();

  try {
    const result = await videoCompressor.compressBatch(files, settings);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('compressor-stop', () => {
  videoCompressor.stop();
  return { success: true };
});

ipcMain.handle('compressor-is-running', () => {
  return videoCompressor.isCompressing();
});

ipcMain.handle('compressor-get-stats', () => {
  return videoCompressor.getStats();
});

ipcMain.handle('compressor-select-folder', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Video or Folder',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts', 'mpg', 'mpeg'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('compressor-select-source', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Video or Folder',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts', 'mpg', 'mpeg'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('compressor-select-output-folder', async (_, defaultPath?: string) => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Output Folder',
    defaultPath: defaultPath || '',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});
