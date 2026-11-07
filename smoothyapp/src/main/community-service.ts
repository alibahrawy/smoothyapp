/**
 * Community lobby — a shared chat for every Smoothy editor.
 *
 * Identity: signed-in members use their account name through the signed
 * session token. Guests get a stable, server-derived "Guest <Animal> NN" name
 * from a random device id, so they can take part without an account and are
 * always labelled as guests.
 *
 * Transport: the app asks the website for a single-use ticket, then opens a
 * WebSocket to the lobby Durable Object. History is replayed on connect.
 */

import Store from 'electron-store';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { getAuthHeaders, getSessionToken } from './auth-service';

const isDev = process.env.NODE_ENV === 'development';
const API_BASE = process.env.SMOOTHY_API_URL || (isDev ? 'http://localhost:4321' : 'https://smoothyedit.com');
const SOCKET_BASE = API_BASE.replace(/^http/i, (scheme) => (scheme.toLowerCase() === 'http' ? 'ws' : 'wss'));

const MAX_BODY = 500;
const MAX_MESSAGES = 300;
const SEND_GAP_MS = 1200;
const PING_MS = 25_000;
const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 15_000];

/** Turns low-level network failures ("fetch failed", ECONNREFUSED…) into plain language. */
function friendlyConnectError(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
  const raw = error instanceof Error ? error.message : '';
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|aborted/i.test(raw) || cause?.code) {
    return 'Can’t reach the lobby. Check your internet connection — Smoothy will keep retrying.';
  }
  return raw || 'Could not reach the lobby.';
}

export interface CommunityIdentity {
  id: string;
  name: string;
  guest: boolean;
  tier: 'free' | 'pro' | 'guest';
}

export interface CommunityMessage {
  id: string;
  authorId: string;
  authorName: string;
  guest: boolean;
  tier: string;
  body: string;
  at: number;
}

export type CommunityStatus = 'idle' | 'connecting' | 'online' | 'offline';

export interface CommunityState {
  status: CommunityStatus;
  identity: CommunityIdentity | null;
  messages: CommunityMessage[];
  presence: number;
  signedIn: boolean;
  error: string | null;
}

interface ServiceOptions {
  store: Store;
  track: (id: string) => void;
  onState: (state: CommunityState) => void;
}

interface PendingSend {
  resolve: (result: { success: boolean; error?: string }) => void;
  timer: NodeJS.Timeout;
}

export function createCommunityService(options: ServiceOptions) {
  const { store } = options;
  const messages: CommunityMessage[] = [];
  const pending = new Map<string, PendingSend>();

  let socket: WebSocket | null = null;
  let status: CommunityStatus = 'idle';
  let identity: CommunityIdentity | null = null;
  let presence = 0;
  let error: string | null = null;
  let retryIndex = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let connecting: Promise<void> | null = null;
  let closedByUser = false;
  let lastSentAt = 0;
  let guestJoinTracked = false;

  function signedIn(): boolean {
    return Boolean(getSessionToken());
  }

  function guestId(): string {
    const stored = store.get('communityGuestId') as string | undefined;
    if (stored && /^[0-9a-f-]{16,40}$/i.test(stored)) return stored;
    const created = randomUUID().toLowerCase();
    store.set('communityGuestId', created);
    return created;
  }

  function snapshot(): CommunityState {
    return {
      status,
      identity,
      messages: messages.slice(-MAX_MESSAGES),
      presence,
      signedIn: signedIn(),
      error,
    };
  }

  function notify() {
    try {
      options.onState(snapshot());
    } catch {
      // The window may be closing; the service keeps running.
    }
  }

  function setStatus(next: CommunityStatus, message: string | null = null) {
    status = next;
    error = message;
    notify();
  }

  function clearTimers() {
    if (retryTimer) clearTimeout(retryTimer);
    if (pingTimer) clearInterval(pingTimer);
    retryTimer = null;
    pingTimer = null;
  }

  function rejectPending(message: string) {
    for (const [clientId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ success: false, error: message });
      pending.delete(clientId);
    }
  }

  function sendRaw(payload: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function scheduleRetry() {
    if (closedByUser) return;
    const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
    retryIndex += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().catch(() => {});
    }, delay);
  }

  function handleMessage(raw: unknown) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data.type === 'hello') {
      const you = data.you as CommunityIdentity | undefined;
      if (you?.id) identity = you;
      if (Array.isArray(data.history)) {
        messages.length = 0;
        for (const entry of data.history as CommunityMessage[]) {
          if (entry?.id && typeof entry.body === 'string') messages.push(entry);
        }
      }
      presence = Number(data.count) || 0;
      retryIndex = 0;
      setStatus('online');
      if (identity?.guest && !guestJoinTracked) {
        guestJoinTracked = true;
        try {
          options.track('community_guest_join');
        } catch {
          // Analytics never blocks chat.
        }
      }
      return;
    }

    if (data.type === 'presence') {
      presence = Number(data.count) || 0;
      notify();
      return;
    }

    if (data.type === 'message') {
      const message = data.message as CommunityMessage | undefined;
      if (!message?.id || typeof message.body !== 'string') return;
      if (messages.some((entry) => entry.id === message.id)) return;
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
      notify();
      return;
    }

    if (data.type === 'sent') {
      const clientId = typeof data.clientId === 'string' ? data.clientId : '';
      const entry = clientId ? pending.get(clientId) : undefined;
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(clientId);
        entry.resolve({ success: true });
      }
      try {
        options.track('community_message_sent');
      } catch {
        // Analytics never blocks chat.
      }
      return;
    }

    if (data.type === 'error') {
      const message = typeof data.error === 'string' ? data.error : 'The lobby rejected that message.';
      const clientId = typeof data.clientId === 'string' ? data.clientId : '';
      const entry = clientId ? pending.get(clientId) : undefined;
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(clientId);
        entry.resolve({ success: false, error: message });
      }
      // Rate-limit/validation messages are transient; keep the connection.
      error = message;
      notify();
    }
  }

  function openSocket(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${SOCKET_BASE}/api/community/ws?ticket=${encodeURIComponent(ticket)}`);
      socket = ws;
      let settled = false;
      let helloGuard: NodeJS.Timeout | null = null;

      ws.on('open', () => {
        settled = true;
        clearTimers();
        pingTimer = setInterval(() => {
          if (!sendRaw({ type: 'ping' })) return;
        }, PING_MS);
        // A lobby that accepts the socket but never sends `hello` is stuck.
        helloGuard = setTimeout(() => {
          if (status !== 'online') {
            try {
              ws.terminate();
            } catch {
              // Already gone.
            }
          }
        }, 12_000);
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => handleMessage(data.toString()));

      ws.on('close', () => {
        if (socket === ws) socket = null;
        if (helloGuard) clearTimeout(helloGuard);
        clearTimers();
        rejectPending('Connection lost. Reconnecting…');
        if (!settled) {
          settled = true;
          reject(new Error('Could not open the lobby connection.'));
        }
        if (closedByUser) {
          setStatus('idle');
          return;
        }
        setStatus('offline', 'Lost the connection to the lobby. Reconnecting…');
        scheduleRetry();
      });

      ws.on('error', (eventError: Error) => {
        if (!settled) {
          settled = true;
          reject(eventError);
        }
      });
    });
  }

  async function connect(): Promise<CommunityState> {
    closedByUser = false;
    const identityMatches = identity ? identity.guest === !signedIn() : false;
    if (status === 'online' && identityMatches) return snapshot();
    if (status === 'connecting' && connecting) {
      await connecting.catch(() => {});
      if (status === 'online') return snapshot();
    }

    clearTimers();
    rejectPending('Reconnecting to the lobby…');
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.close();
      } catch {
        // Already closed.
      }
      socket = null;
    }

    setStatus('connecting');
    const task = (async () => {
      const response = await fetch(`${API_BASE}/api/community/session`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ guestId: guestId() }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ticket?: string;
        identity?: CommunityIdentity;
        error?: string;
      };
      if (!response.ok || typeof payload.ticket !== 'string') {
        throw new Error(payload.error || `The lobby is unavailable (${response.status}).`);
      }
      if (payload.identity) identity = payload.identity;
      await openSocket(payload.ticket);
    })();

    connecting = task;
    try {
      await task;
    } catch (connectError) {
      setStatus('offline', friendlyConnectError(connectError));
      scheduleRetry();
    } finally {
      if (connecting === task) connecting = null;
    }
    return snapshot();
  }

  function disconnect() {
    closedByUser = true;
    clearTimers();
    rejectPending('Left the lobby.');
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.close();
      } catch {
        // Already closed.
      }
      socket = null;
    }
    status = 'idle';
    presence = 0;
    notify();
  }

  async function send(body: unknown): Promise<{ success: boolean; error?: string }> {
    if (typeof body !== 'string') return { success: false, error: 'Type a message first.' };
    const text = body.replace(/\r\n?/g, '\n').trim();
    if (!text) return { success: false, error: 'Type a message first.' };
    if (text.length > MAX_BODY) return { success: false, error: `Keep messages under ${MAX_BODY} characters.` };
    if (status !== 'online') return { success: false, error: 'Connect to the lobby first.' };
    const now = Date.now();
    if (now - lastSentAt < SEND_GAP_MS) {
      return { success: false, error: 'Give it a second between messages.' };
    }
    lastSentAt = now;

    const clientId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(clientId);
        resolve({ success: false, error: 'The lobby did not answer. Try again.' });
      }, 10_000);
      pending.set(clientId, { resolve, timer });
      if (!sendRaw({ type: 'message', body: text, clientId })) {
        clearTimeout(timer);
        pending.delete(clientId);
        resolve({ success: false, error: 'The lobby connection is not ready.' });
      }
    });
  }

  return {
    state: snapshot,
    connect,
    send,
    disconnect,
    dispose() {
      disconnect();
    },
  };
}
