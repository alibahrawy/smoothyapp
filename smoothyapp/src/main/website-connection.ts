/**
 * Website WebSocket Connection
 * Connects to SmoothyEdit website for AI features like Best Shorts
 */

// @ts-ignore
const WebSocket = require('ws');
import Store from 'electron-store';
import { getStoredUserId } from './auth-service';

const isDev = process.env.NODE_ENV === 'development';
const LOCAL_WS_URL = 'ws://localhost:4321/api/ws';
const PRODUCTION_WS_URL = process.env.SMOOTHY_WS_URL || 'wss://smoothyedit.com/api/ws';
const WS_URLS = isDev ? [LOCAL_WS_URL, PRODUCTION_WS_URL] : [PRODUCTION_WS_URL];
const LOCAL_API_URL = 'http://localhost:3000';
const PRODUCTION_API_URL = 'https://smoothyedit.com';
const API_URLS = isDev ? [LOCAL_API_URL, PRODUCTION_API_URL] : [PRODUCTION_API_URL];
const CONNECTION_TIMEOUT_MS = 8000;

const store = new Store();

let websocket: any = null;
let isConnected = false;
let reconnectTimer: any = null;
let connectionToken: string | null = null;

// Callbacks
let callbacks = {
  onConnectionChange: (connected: boolean) => {},
  onMessage: (data: any) => {},
  onExportProgress: (progress: number, message: string) => {},
  onThemeSync: (theme: string) => {}
};

export function setWebsiteCallbacks(cbs: Partial<typeof callbacks>) {
  callbacks = { ...callbacks, ...cbs };
}

export function saveConnectionToken(token: string): void {
  connectionToken = token;
  store.set('websiteConnectionToken', token);
  console.log('[Website] Token saved');
}

export function getConnectionToken(): string | null {
  if (!connectionToken) {
    connectionToken = store.get('websiteConnectionToken') as string | null;
  }
  return connectionToken;
}

export function getWebsiteConnectionStatus(): { connected: boolean; token: string | null } {
  return {
    connected: isConnected,
    token: getConnectionToken()
  };
}

export function connectToWebsite(): Promise<boolean> {
  return connectToWebsiteAt(0);
}

function connectToWebsiteAt(index: number): Promise<boolean> {
  return new Promise((resolve) => {
    const token = getConnectionToken();
    const userId = getStoredUserId();
    const wsBase = WS_URLS[index];
    const wsParams = new URLSearchParams({ role: 'plugin' });
    if (userId) wsParams.set('userId', userId);
    else if (token) wsParams.set('token', token);
    const wsUrl = `${wsBase}${wsBase.includes('?') ? '&' : '?'}${wsParams.toString()}`;
    let socket: any = null;

    // Need either a token or a logged-in user
    if (!token && !userId) {
      console.log('[Website] No connection token and not logged in');
      resolve(false);
      return;
    }

    if (!wsUrl) {
      console.log('[Website] No more WebSocket endpoints to try');
      resolve(false);
      return;
    }

    if (websocket && websocket.readyState === WebSocket.OPEN) {
      console.log('[Website] Already connected');
      resolve(true);
      return;
    }

    let settled = false;
    let authenticated = false;
    let timeout: NodeJS.Timeout | null = null;

    const cleanupSocket = () => {
      if (!socket) return;

      try {
        socket.removeAllListeners();
        // The ws package emits this asynchronously when aborting a CONNECTING socket.
        socket.on('error', () => {});

        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      } catch (error) {
        console.warn('[Website] Socket cleanup warning:', error instanceof Error ? error.message : error);
      }

      if (websocket === socket) {
        websocket = null;
      }
    };

    const finish = (success: boolean, shouldTryNext = false) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }

      if (!success) {
        cleanupSocket();
      }

      if (success) {
        isConnected = true;
        callbacks.onConnectionChange(true);

        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }

        resolve(true);
        return;
      }

      if (shouldTryNext && index < WS_URLS.length - 1) {
        console.log('[Website] Trying fallback endpoint...');
        connectToWebsiteAt(index + 1).then(resolve);
        return;
      }

      isConnected = false;
      callbacks.onConnectionChange(false);
      resolve(false);
    };

    try {
      console.log('[Website] Connecting to', wsUrl);
      socket = new WebSocket(wsUrl);
      websocket = socket;

      timeout = setTimeout(() => {
        console.error('[Website] Connection timed out:', wsUrl);
        finish(false, true);
      }, CONNECTION_TIMEOUT_MS);

      socket.on('open', () => {
        console.log('[Website] Socket opened:', wsUrl);

        // Send handshake with userId (preferred) or token (fallback)
        const handshake: any = {
          type: 'handshake',
          source: 'premiere-plugin',
          timestamp: Date.now()
        };

        // Use userId if logged in, otherwise use token
        if (userId) {
          handshake.userId = userId;
          console.log('[Website] Authenticating with userId:', userId);
        } else if (token) {
          handshake.connectionToken = token;
          console.log('[Website] Authenticating with token');
        }

        socket.send(JSON.stringify(handshake));
      });

      socket.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'welcome' || message.type === 'connected') {
            authenticated = true;
            console.log('[Website] Connected and authenticated:', wsUrl);
            handleWebsiteMessage(message);
            finish(true);
            return;
          }

          if (message.type === 'error') {
            console.error('[Website] Server error:', message.message);
            handleWebsiteMessage(message);
            finish(false, true);
            return;
          }

          handleWebsiteMessage(message);
        } catch (e) {
          console.error('[Website] Message parse error:', e);
        }
      });

      socket.on('close', () => {
        console.log('[Website] Disconnected');
        isConnected = false;
        callbacks.onConnectionChange(false);

        if (!authenticated) {
          finish(false, true);
          return;
        }

        // Auto-reconnect after 5 seconds
        if (!reconnectTimer) {
          reconnectTimer = setInterval(() => {
            if (!isConnected && connectionToken) {
              console.log('[Website] Attempting reconnect...');
              connectToWebsite();
            }
          }, 5000);
        }
      });

      socket.on('error', (err: Error) => {
        console.error('[Website] Error:', err.message);
        finish(false, true);
      });

    } catch (e) {
      console.error('[Website] Connection error:', e);
      finish(false, true);
    }
  });
}

export function disconnectFromWebsite(): void {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }

  if (websocket) {
    try {
      websocket.removeAllListeners();
      websocket.on('error', () => {});
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close();
      } else if (websocket.readyState === WebSocket.CONNECTING) {
        websocket.terminate();
      }
    } catch (error) {
      console.warn('[Website] Disconnect cleanup warning:', error instanceof Error ? error.message : error);
    }
    websocket = null;
  }

  isConnected = false;
  callbacks.onConnectionChange(false);
}

function handleWebsiteMessage(message: any) {
  console.log('[Website] Received:', message.type);

  switch (message.type) {
    case 'connected':
      console.log('[Website] Handshake accepted');
      break;

    case 'addMarkers':
      // Website wants to add markers to Premiere
      callbacks.onMessage({ type: 'addMarkers', markers: message.markers });
      break;

    case 'ping':
      sendToWebsite({ type: 'pong' });
      break;

    case 'getStatus':
      // Website requesting status
      callbacks.onMessage({ type: 'getStatus' });
      break;

    case 'error':
      console.error('[Website] Server error:', message.message);
      callbacks.onMessage({ type: 'error', error: message.message });
      break;

    default:
      callbacks.onMessage(message);
  }
}

export function sendToWebsite(message: any): boolean {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * Fetch user's theme from website API
 */
export async function fetchUserTheme(): Promise<string | null> {
  const userId = getStoredUserId();
  if (!userId) {
    console.log('[Website] No user ID, cannot fetch theme');
    return null;
  }

  for (const apiUrl of API_URLS) {
    try {
      const response = await fetch(`${apiUrl}/api/user/theme`, {
        headers: {
          'x-member-id': userId
        }
      });

      if (!response.ok) {
        console.error('[Website] Failed to fetch theme:', response.status, apiUrl);
        continue;
      }

      const data = await response.json();
      console.log('[Website] Fetched theme:', data.theme);
      return data.theme || null;
    } catch (error) {
      console.error('[Website] Error fetching theme from', apiUrl, error);
    }
  }

  return null;
}

/**
 * Save user's theme to website API
 */
export async function saveUserTheme(theme: string): Promise<boolean> {
  const userId = getStoredUserId();
  if (!userId) {
    console.log('[Website] No user ID, cannot save theme');
    return false;
  }

  for (const apiUrl of API_URLS) {
    try {
      const response = await fetch(`${apiUrl}/api/user/theme`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-member-id': userId
        },
        body: JSON.stringify({ theme })
      });

      if (!response.ok) {
        console.error('[Website] Failed to save theme:', response.status, apiUrl);
        continue;
      }

      console.log('[Website] Theme saved:', theme);
      return true;
    } catch (error) {
      console.error('[Website] Error saving theme to', apiUrl, error);
    }
  }

  return false;
}

/**
 * Sync theme from website (called after connection)
 */
export async function syncThemeFromWebsite(): Promise<void> {
  const theme = await fetchUserTheme();
  if (theme) {
    callbacks.onThemeSync(theme);
  }
}

/**
 * Send audio data to website in chunks
 */
export function sendAudioToWebsite(audioBase64: string, sequenceName: string, duration: number): void {
  const CHUNK_SIZE = 100 * 1024; // 100KB chunks
  const totalChunks = Math.ceil(audioBase64.length / CHUNK_SIZE);

  console.log(`[Website] Sending audio: ${(audioBase64.length / 1024 / 1024).toFixed(2)}MB in ${totalChunks} chunks`);

  // Send start message
  sendToWebsite({
    type: 'audioExportStart',
    sequenceName,
    duration,
    totalSize: audioBase64.length,
    totalChunks
  });

  // Send chunks with delay
  let chunkIndex = 0;

  const sendNextChunk = () => {
    if (chunkIndex >= totalChunks) {
      // Send completion
      sendToWebsite({
        type: 'audioExportComplete',
        sequenceName
      });
      callbacks.onExportProgress(100, 'Upload complete');
      return;
    }

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, audioBase64.length);
    const chunk = audioBase64.substring(start, end);

    sendToWebsite({
      type: 'audioChunk',
      chunkIndex,
      totalChunks,
      data: chunk
    });

    const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
    callbacks.onExportProgress(progress, `Uploading: ${progress}%`);

    chunkIndex++;
    setTimeout(sendNextChunk, 50); // 50ms delay between chunks
  };

  sendNextChunk();
}

/** Reply to the web app's on-demand Premiere import protocol. */
export function sendAudioDataToWebsite(
  audioBase64: string,
  metadata: { requestId?: string; fileName?: string; fileSize?: number } = {}
): void {
  const fileName = metadata.fileName || 'premiere-sequence.mp3';
  const fileSize = metadata.fileSize || Math.floor(audioBase64.length * 0.75);
  const chunkSize = 256 * 1024;

  if (audioBase64.length <= chunkSize * 2) {
    sendToWebsite({ type: 'audioData', success: true, requestId: metadata.requestId, audio: audioBase64, fileName, fileSize });
    return;
  }

  const totalChunks = Math.ceil(audioBase64.length / chunkSize);
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    sendToWebsite({
      type: 'audioDataChunk',
      requestId: metadata.requestId,
      chunkIndex,
      totalChunks,
      chunk: audioBase64.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
      fileName,
      fileSize
    });
  }
  sendToWebsite({ type: 'audioDataComplete', success: true, requestId: metadata.requestId, totalChunks, fileName, fileSize });
}
