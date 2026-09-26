/**
 * SmoothyEdit Electron App - Main Process
 */

import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
import { initTelemetry, trackEvent, trackTool, startHeartbeat } from './telemetry';
import path from 'path';
import fs from 'fs';
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
  getResolveConnectionStatus
} from './resolve-bridge';
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
  ensureModelDownloaded
} from './captions/model-manager';
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
  cleanupTempFile,
  TimelineAudioClip
} from './autocut/audio-extractor';
import videoCompressor, { CompressionSettings, VideoFile } from './compressor/video-compressor';

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
const UXP_PLUGIN_ID = 'com.smoothyedit.uxp.bridge';
const UXP_PLUGIN_NAME = 'SmoothyEdit Bridge';
const UXP_PLUGIN_VERSION = '1.0.0';

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
  // In dev: ../smoothyedit (relative to project)
  const resourcePath = path.join(process.resourcesPath, 'cep-plugin');
  if (fs.existsSync(resourcePath)) {
    return resourcePath;
  }
  // Fallback for dev
  return path.join(__dirname, '..', '..', '..', 'smoothyapp-cep');
}

function getUxpPluginSource(): string {
  // In packaged app: resources/uxp-plugin
  // In dev: ../smoothyedit-uxp (relative to project)
  const resourcePath = path.join(process.resourcesPath, 'uxp-plugin');
  if (fs.existsSync(resourcePath)) {
    return resourcePath;
  }
  return path.join(__dirname, '..', '..', '..', 'smoothyapp');
}

function getAdobeUxpRootPath(): string {
  if (isMac) {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'Adobe', 'UXP');
  }
  return path.join(process.env.APPDATA || '', 'Adobe', 'UXP');
}

function getUxpExternalPluginsPath(): string {
  return path.join(getAdobeUxpRootPath(), 'Plugins', 'External');
}

function getUxpInstallPath(): string {
  return path.join(getUxpExternalPluginsPath(), `${UXP_PLUGIN_ID}_${UXP_PLUGIN_VERSION}`);
}

function getUxpPremierePluginInfoPath(): string {
  return path.join(getAdobeUxpRootPath(), 'PluginsInfo', 'v1', 'premierepro.json');
}

function getUxpPackagePath(): string {
  return path.join(getAdobeUxpRootPath(), 'Installers', 'SmoothyEdit-Bridge.ccx');
}

function getUpiaPath(): string | null {
  if (isMac) {
    const upiaPath = '/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent';
    return fs.existsSync(upiaPath) ? upiaPath : null;
  }

  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const upiaPath = path.join(
    programFiles,
    'Common Files',
    'Adobe',
    'Adobe Desktop Common',
    'RemoteComponents',
    'UPI',
    'UnifiedPluginInstallerAgent',
    'UnifiedPluginInstallerAgent.exe'
  );
  return fs.existsSync(upiaPath) ? upiaPath : null;
}

function isBridgeInstalled(): { installed: boolean; path: string } {
  const extPath = getCepExtensionsPath();
  const pluginPath = path.join(extPath, CEP_PLUGIN_ID);
  const manifestPath = path.join(pluginPath, 'CSXS', 'manifest.xml');
  return {
    installed: fs.existsSync(manifestPath),
    path: path.join(extPath, CEP_PLUGIN_ID)
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

function isUxpBridgeInstalled(): {
  installed: boolean;
  sourcePath: string;
  installPath: string;
  externalPluginsPath: string;
  pluginInfoPath: string;
  packagePath: string;
  installerAvailable: boolean;
  installerPath?: string;
  error?: string;
} {
  const sourcePath = getUxpPluginSource();
  const installPath = getUxpInstallPath();
  const packagePath = getUxpPackagePath();
  const installerPath = getUpiaPath();
  const installed = fs.existsSync(path.join(installPath, 'manifest.json'));

  return {
    installed,
    sourcePath,
    installPath,
    externalPluginsPath: getUxpExternalPluginsPath(),
    pluginInfoPath: getUxpPremierePluginInfoPath(),
    packagePath,
    installerAvailable: Boolean(installerPath),
    installerPath: installerPath || undefined
  };
}

function writeUxpPremierePluginInfo() {
  const pluginInfoPath = getUxpPremierePluginInfoPath();
  const pluginInfoDir = path.dirname(pluginInfoPath);
  try {
    fs.mkdirSync(pluginInfoDir, { recursive: true });

    let data: { plugins: any[] } = { plugins: [] };
    if (fs.existsSync(pluginInfoPath)) {
      try {
        data = JSON.parse(fs.readFileSync(pluginInfoPath, 'utf-8'));
      } catch {
        data = { plugins: [] };
      }
    }

    const plugins = Array.isArray(data.plugins) ? data.plugins : [];
    const withoutSmoothyEdit = plugins.filter((plugin) => plugin.pluginId !== UXP_PLUGIN_ID);
    withoutSmoothyEdit.push({
      hostMinVersion: '25.2.0',
      name: UXP_PLUGIN_NAME,
      path: `$localPlugins/External/${UXP_PLUGIN_ID}_${UXP_PLUGIN_VERSION}`,
      pluginId: UXP_PLUGIN_ID,
      status: 'enabled',
      type: 'uxp',
      versionString: UXP_PLUGIN_VERSION
    });

    fs.writeFileSync(pluginInfoPath, JSON.stringify({ plugins: withoutSmoothyEdit }, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[UXP] Could not write Premiere plugin info:', err);
  }
}

function installBridge(targetExtPath?: string): { success: boolean; error?: string; path: string } {
  const extPath = targetExtPath || getCepExtensionsPath();
  const pluginDest = path.join(extPath, CEP_PLUGIN_ID);
  const source = getCepPluginSource();

  try {
    if (!fs.existsSync(source)) {
      return { success: false, error: 'CEP plugin source not found in app resources', path: pluginDest };
    }

    // Ensure extensions directory exists
    fs.mkdirSync(extPath, { recursive: true });

    // Remove old install if exists
    if (fs.existsSync(pluginDest)) {
      fs.rmSync(pluginDest, { recursive: true, force: true });
    }

    // Copy plugin
    copyDirSync(source, pluginDest);

    // Create .debug file for unsigned extensions
    const debugContent = `<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="${CEP_EXTENSION_ID}">
    <HostList>
      <Host Name="PPRO" Port="8088"/>
    </HostList>
  </Extension>
</ExtensionList>`;
    fs.writeFileSync(path.join(pluginDest, '.debug'), debugContent, 'utf-8');
    clearSmoothyCepCaches();

    // macOS: enable PlayerDebugMode via defaults
    if (isMac) {
      const { execSync } = require('child_process');
      try {
        execSync('defaults write com.adobe.CSXS.11 PlayerDebugMode 1');
        execSync('defaults write com.adobe.CSXS.10 PlayerDebugMode 1');
        execSync('defaults write com.adobe.CSXS.9 PlayerDebugMode 1');
      } catch {
        // Non-fatal if defaults command fails
      }
    }

    console.log('[CEP] Bridge installed to:', pluginDest);
    return { success: true, path: pluginDest };
  } catch (err) {
    console.error('[CEP] Install failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      path: pluginDest
    };
  }
}

function packageUxpBridge(): { success: boolean; error?: string; packagePath: string; sourcePath: string } {
  const sourcePath = getUxpPluginSource();
  const packagePath = getUxpPackagePath();
  const stagingPath = path.join(getAdobeUxpRootPath(), 'Installers', 'package-staging');

  try {
    if (!fs.existsSync(path.join(sourcePath, 'manifest.json'))) {
      return { success: false, error: 'UXP plugin source not found in app resources', packagePath, sourcePath };
    }

    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.rmSync(packagePath, { force: true });
    copyDirSync(sourcePath, stagingPath);

    const { execFileSync } = require('child_process');
    if (isWindows) {
      const zipPath = packagePath.replace(/\.ccx$/i, '.zip');
      fs.rmSync(zipPath, { force: true });
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path ${JSON.stringify(path.join(stagingPath, '*'))} -DestinationPath ${JSON.stringify(zipPath)} -Force`
      ], { timeout: 60000 });
      fs.renameSync(zipPath, packagePath);
    } else {
      execFileSync('zip', ['-qry', packagePath, '.'], {
        cwd: stagingPath,
        timeout: 60000
      });
    }

    fs.rmSync(stagingPath, { recursive: true, force: true });
    return { success: true, packagePath, sourcePath };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown UXP packaging error',
      packagePath,
      sourcePath
    };
  }
}

async function installUxpBridge(): Promise<{
  success: boolean;
  error?: string;
  path: string;
  installPath?: string;
  packagePath: string;
  sourcePath: string;
  method?: string;
  requiresUserAction?: boolean;
  message?: string;
}> {
  const sourcePath = getUxpPluginSource();
  const installPath = getUxpInstallPath();
  const packagePath = getUxpPackagePath();

  try {
    if (!fs.existsSync(path.join(sourcePath, 'manifest.json'))) {
      return {
        success: false,
        error: 'UXP plugin source not found in app resources',
        path: installPath,
        installPath,
        packagePath,
        sourcePath
      };
    }

    fs.mkdirSync(getUxpExternalPluginsPath(), { recursive: true });
    fs.rmSync(installPath, { recursive: true, force: true });
    copyDirSync(sourcePath, installPath);
    writeUxpPremierePluginInfo();

    console.log('[UXP] Bridge installed to Adobe UXP folder:', installPath);
    return {
      success: true,
      path: installPath,
      installPath,
      packagePath,
      sourcePath,
      method: 'adobe-folder',
      message: 'UXP bridge installed in Adobe UXP folder. Restart Premiere Pro, then open Window > UXP Plugins > SmoothyEdit Bridge.'
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Adobe UXP folder install failed',
      path: installPath,
      installPath,
      packagePath,
      sourcePath,
      method: 'adobe-folder'
    };
  }
}

// ─── DaVinci Resolve Bridge Installation ────────────────────────────────────

function getDefaultResolveScriptsPath(): string {
  if (isMac) {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts', 'Utility');
  }
  return path.join(process.env.APPDATA || '', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility');
}

function getResolveScriptsPath(): string {
  const custom = store.get('resolveScriptsPath') as string | null;
  return custom || getDefaultResolveScriptsPath();
}

function getResolveBridgeSource(): string {
  const resourcePath = path.join(process.resourcesPath, 'resolve-plugin');
  if (fs.existsSync(resourcePath)) {
    return resourcePath;
  }
  return path.join(__dirname, '..', '..', '..', 'smoothyedit-resolve');
}

function isResolveBridgeInstalled(): { installed: boolean; path: string } {
  const scriptsPath = getResolveScriptsPath();
  const bridgePath = path.join(scriptsPath, 'smoothyedit_bridge.lua');
  return {
    installed: fs.existsSync(bridgePath),
    path: scriptsPath
  };
}

function installResolveBridge(targetPath?: string): { success: boolean; error?: string; path: string } {
  const scriptsPath = targetPath || getResolveScriptsPath();
  const source = getResolveBridgeSource();

  try {
    if (!fs.existsSync(source)) {
      return { success: false, error: 'Resolve bridge source not found in app resources', path: scriptsPath };
    }

    fs.mkdirSync(scriptsPath, { recursive: true });

    // Copy entire resolve plugin directory
    copyDirSync(source, scriptsPath);

    console.log('[Resolve] Bridge installed to:', scriptsPath);
    return { success: true, path: scriptsPath };
  } catch (err) {
    console.error('[Resolve] Install failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      path: scriptsPath
    };
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

  // Start NLE servers (WebSocket for Premiere, HTTP polling for Resolve)
  startNLEServers();

  // Set up callbacks to send to renderer
  setCallbacks({
    onConnectionChange: (connected) => {
      const nle = getActiveNLE();
      const nleName = nle === 'resolve' ? 'DaVinci Resolve' : 'Premiere Pro';
      sendLog('info', `${nleName} bridge ${connected ? 'connected' : 'disconnected'}`);
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
        // Add markers to Premiere through the active bridge (UXP preferred, CEP fallback).
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

  // Auto-install CEP bridge on macOS (Windows uses NSIS installer)
  if (isMac) {
    const bridgeStatus = isBridgeInstalled();
    if (!bridgeStatus.installed) {
      console.log('[CEP] Bridge not found, auto-installing...');
      const result = installBridge();
      if (result.success) {
        console.log('[CEP] Bridge auto-installed successfully');
      } else {
        console.warn('[CEP] Bridge auto-install failed:', result.error);
      }
    } else {
      console.log('[CEP] Bridge already installed at:', bridgeStatus.path);
    }

    // Auto-install Resolve bridge on macOS
    const resolveStatus = isResolveBridgeInstalled();
    if (!resolveStatus.installed) {
      console.log('[Resolve] Bridge not found, auto-installing...');
      const result = installResolveBridge();
      if (result.success) {
        console.log('[Resolve] Bridge auto-installed successfully');
      } else {
        console.warn('[Resolve] Bridge auto-install failed:', result.error);
      }
    } else {
      console.log('[Resolve] Bridge already installed at:', resolveStatus.path);
    }
  }

  // Auto-updater setup
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
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
      const os = require('os');
      const fs = require('fs');
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

  try {
    let audioPath = config.audioPath;

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

    // Ensure model is loaded (downloads GGML model if needed)
    if (!whisperService.isModelLoaded()) {
      mainWindow?.webContents.send('caption-progress', {
        status: 'loading-model',
        message: 'Loading Whisper model...'
      });

      const defaultModel = getDefaultModelId();
      await whisperService.loadModel(defaultModel, (progress) => {
        mainWindow?.webContents.send('caption-progress', {
          status: 'loading-model',
          message: progress.status === 'downloading'
            ? `Downloading model: ${progress.progress || 0}%`
            : `Loading model: ${progress.status}`,
          progress: progress.progress
        });
      });
    }

    // Transcribe
    mainWindow?.webContents.send('caption-progress', {
      status: 'transcribing',
      message: 'Transcribing audio...'
    });

    const transcriptionResult = await whisperService.transcribe(audioPath!, (progress) => {
      mainWindow?.webContents.send('caption-progress', {
        status: 'transcribing',
        message: progress.status,
        progress: progress.progress
      });
    });

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

    return {
      success: true,
      captions,
      srt,
      vtt,
      text: transcriptionResult.text
    };
  } catch (error) {
    console.error('[Main] Caption generation error:', error);

    // Cleanup temp files on error
    tempAudioFiles.forEach(f => cleanupTempFile(f));

    return { success: false, error: error instanceof Error ? error.message : 'Generation failed' };
  }
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

// Auto-updater handlers
ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('check-for-updates', () => {
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[Updater] Manual check failed:', err.message);
  });
});

// Premiere Bridge handlers
ipcMain.handle('get-bridge-status', () => {
  const cepStatus = isBridgeInstalled();
  const uxpStatus = isUxpBridgeInstalled();
  return {
    installed: uxpStatus.installed,
    path: uxpStatus.installPath,
    uxp: uxpStatus,
    cep: cepStatus,
    extensionsPath: getCepExtensionsPath(),
    defaultPath: getDefaultCepPath(),
    isCustomPath: !!store.get('cepExtensionsPath')
  };
});

ipcMain.handle('install-bridge', () => {
  return installUxpBridge();
});

ipcMain.handle('install-uxp-bridge', () => {
  return installUxpBridge();
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

// DaVinci Resolve Bridge handlers
ipcMain.handle('get-resolve-bridge-status', () => {
  const status = isResolveBridgeInstalled();
  return {
    installed: status.installed,
    path: status.path,
    defaultPath: getDefaultResolveScriptsPath(),
    isCustomPath: !!store.get('resolveScriptsPath')
  };
});

ipcMain.handle('install-resolve-bridge', () => {
  return installResolveBridge();
});

ipcMain.handle('set-resolve-scripts-path', async (_, customPath?: string) => {
  if (customPath) {
    store.set('resolveScriptsPath', customPath);
  } else {
    store.delete('resolveScriptsPath');
  }
  return { success: true, path: getResolveScriptsPath() };
});

ipcMain.handle('browse-resolve-scripts-path', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select DaVinci Resolve Scripts Folder',
    defaultPath: getResolveScriptsPath(),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('reveal-resolve-folder', () => {
  const folderPath = getResolveScriptsPath();
  if (fs.existsSync(folderPath)) {
    shell.showItemInFolder(path.join(folderPath, 'smoothyedit_bridge.lua'));
    return { success: true };
  }
  return { success: false, error: 'Folder not found' };
});

// NLE switching handlers
ipcMain.handle('get-active-nle', () => {
  return {
    activeNLE: getActiveNLE(),
    premiereConnected: getPremiereConnectionStatus(),
    resolveConnected: getResolveConnectionStatus()
  };
});

ipcMain.handle('set-active-nle', (_, nle: 'premiere' | 'resolve' | null) => {
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
