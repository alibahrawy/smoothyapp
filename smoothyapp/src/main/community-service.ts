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
 *
 * 3.1: profiles (avatars, guest names), delete, report, block and timeouts.
 * Blocking and timeouts are enforced by the lobby; this service only mirrors
 * what it is told, and re-validates avatars before the renderer draws them.
 */

import Store from 'electron-store';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { cleanAvatar, type CommunityAvatar } from '../shared/community-avatar';
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
  /** SmoothyEdit staff, set by the server. */
  dev?: boolean;
}

export interface CommunityMessage {
  id: string;
  authorId: string;
  authorName: string;
  guest: boolean;
  tier: string;
  dev?: boolean;
  body: string;
  at: number;
}

export interface CommunityProfile {
  id: string;
  /** A guest's chosen name; null for members (their account name is on each message). */
  name: string | null;
  avatar: CommunityAvatar | null;
}

export interface BlockedPerson {
  id: string;
  name: string;
}

export interface CommunitySanction {
  until: number;
  strikes: number;
}

export type CommunityStatus = 'idle' | 'connecting' | 'online' | 'offline';

export interface CommunityState {
  status: CommunityStatus;
  identity: CommunityIdentity | null;
  messages: CommunityMessage[];
  presence: number;
  signedIn: boolean;
  error: string | null;
  blocks: BlockedPerson[];
  /** Set while the person is on a timeout. */
  sanction: CommunitySanction | null;
}

interface ServiceOptions {
  store: Store;
  track: (id: string) => void;
  onState: (state: CommunityState) => void;
  /** Profiles that arrived or changed. Sent separately so pictures never ride along with every message. */
  onProfiles?: (profiles: CommunityProfile[]) => void;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Report only: the third report removed the message. */
  removed?: boolean;
}

interface PendingSend {
  resolve: (result: ActionResult) => void;
  timer: NodeJS.Timeout;
}

/** Acknowledged lobby actions and the usage counter each one earns (one per accepted action). */
const ACK_TRACKING: Record<string, string> = {
  delete: 'community_message_delete',
  report: 'community_report',
  block: 'community_block',
  unblock: 'community_unblock',
  profile: 'community_profile_save',
};

function cleanBlocks(value: unknown): BlockedPerson[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>)
    .filter((entry) => typeof entry?.id === 'string' && typeof entry?.name === 'string')
    .slice(0, 200)
    .map((entry) => ({ id: String(entry.id).slice(0, 80), name: String(entry.name).slice(0, 40) }));
}

function cleanSanction(value: unknown): CommunitySanction | null {
  const input = value as Partial<CommunitySanction> | null;
  if (!input || typeof input.until !== 'number' || typeof input.strikes !== 'number') return null;
  return input.until > Date.now() ? { until: input.until, strikes: input.strikes } : null;
}

export function createCommunityService(options: ServiceOptions) {
  const { store } = options;
  const messages: CommunityMessage[] = [];
  const pending = new Map<string, PendingSend>();

  let socket: WebSocket | null = null;
  let status: CommunityStatus = 'idle';
  let identity: CommunityIdentity | null = null;
  let connectedToken: string | null = null;
  let presence = 0;
  let error: string | null = null;
  let retryIndex = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let connecting: Promise<void> | null = null;
  let closedByUser = false;
  let lastSentAt = 0;
  let guestJoinTracked = false;
  let blocks: BlockedPerson[] = [];
  let sanction: CommunitySanction | null = null;
  const profiles = new Map<string, CommunityProfile>();
  const requestedProfiles = new Set<string>();
  let profileTimer: NodeJS.Timeout | null = null;
  const wantedProfiles = new Set<string>();

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
      blocks,
      sanction: sanction && sanction.until > Date.now() ? sanction : null,
    };
  }

  function profileList(): CommunityProfile[] {
    return [...profiles.values()];
  }

  function emitProfiles(list: CommunityProfile[]) {
    if (!list.length) return;
    try {
      options.onProfiles?.(list);
    } catch {
      // The window may be closing; the service keeps running.
    }
  }

  /** Remember profiles from the lobby, validating every avatar first. */
  function mergeProfiles(raw: unknown) {
    if (!Array.isArray(raw)) return;
    const changed: CommunityProfile[] = [];
    for (const entry of raw as Array<Record<string, unknown>>) {
      const id = typeof entry?.id === 'string' ? entry.id : '';
      if (!id || id.length > 80) continue;
      const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : null;
      const profile: CommunityProfile = { id, name, avatar: cleanAvatar(entry.avatar) };
      profiles.set(id, profile);
      requestedProfiles.add(id);
      changed.push(profile);
      if (identity && id === identity.id && name && identity.guest) identity = { ...identity, name };
    }
    emitProfiles(changed);
    if (changed.length) notify();
  }

  function flushProfiles() {
    profileTimer = null;
    const ids = [...wantedProfiles].slice(0, 20);
    ids.forEach((entry) => wantedProfiles.delete(entry));
    if (ids.length) sendRaw({ type: 'profiles', ids });
    if (wantedProfiles.size) profileTimer = setTimeout(flushProfiles, 400);
  }

  /** Ask the lobby for avatars we have not seen. People without a profile are asked about once. */
  function wantProfile(id: string) {
    if (!id || requestedProfiles.has(id) || profiles.has(id)) return;
    requestedProfiles.add(id);
    wantedProfiles.add(id);
    if (!profileTimer) profileTimer = setTimeout(flushProfiles, 150);
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
      blocks = cleanBlocks(data.blocks);
      sanction = cleanSanction(data.sanction);
      requestedProfiles.clear();
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

    if (data.type === 'profiles') {
      mergeProfiles(data.profiles);
      return;
    }

    if (data.type === 'profile') {
      mergeProfiles(data.profile ? [data.profile] : []);
      return;
    }

    // A block or unblock changes who we may see: the lobby sends the filtered history.
    if (data.type === 'history') {
      messages.length = 0;
      for (const entry of Array.isArray(data.history) ? (data.history as CommunityMessage[]) : []) {
        if (entry?.id && typeof entry.body === 'string') messages.push(entry);
      }
      blocks = cleanBlocks(data.blocks);
      notify();
      return;
    }

    if (data.type === 'deleted') {
      const id = typeof data.id === 'string' ? data.id : '';
      const index = messages.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        messages.splice(index, 1);
        notify();
      }
      return;
    }

    if (data.type === 'sanction') {
      sanction = cleanSanction(data.sanction);
      notify();
      return;
    }

    if (data.type === 'ack') {
      const clientId = typeof data.clientId === 'string' ? data.clientId : '';
      const entry = clientId ? pending.get(clientId) : undefined;
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(clientId);
        entry.resolve({ success: true, removed: data.removed === true });
        const counter = typeof data.action === 'string' ? ACK_TRACKING[data.action] : undefined;
        if (counter) {
          try {
            options.track(counter);
          } catch {
            // Analytics never blocks chat.
          }
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
      wantProfile(message.authorId);
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
      if (data.sanction) sanction = cleanSanction(data.sanction);
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
    const currentToken = getSessionToken() || null;
    const identityMatches = identity
      ? currentToken
        ? !identity.guest && connectedToken === currentToken
        : identity.guest
      : false;
    if (status === 'online' && identityMatches) return snapshot();
    if (status === 'connecting' && connecting) {
      await connecting.catch(() => {});
      if ((status as CommunityStatus) === 'online') return snapshot();
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

    connectedToken = currentToken;
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
    identity = null;
    connectedToken = null;
    presence = 0;
    wantedProfiles.clear();
    if (profileTimer) clearTimeout(profileTimer);
    profileTimer = null;
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

  /** One request/acknowledge exchange with the lobby (delete, report, block, unblock, profile). */
  function request(payload: Record<string, unknown>): Promise<ActionResult> {
    if (status !== 'online') return Promise.resolve({ success: false, error: 'Connect to the lobby first.' });
    const clientId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(clientId);
        resolve({ success: false, error: 'The lobby did not answer. Try again.' });
      }, 10_000);
      pending.set(clientId, { resolve, timer });
      if (!sendRaw({ ...payload, clientId })) {
        clearTimeout(timer);
        pending.delete(clientId);
        resolve({ success: false, error: 'The lobby connection is not ready.' });
      }
    });
  }

  const idOf = (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(value) ? value : '');

  function saveProfile(input: { name?: unknown; avatar?: unknown }): Promise<ActionResult> {
    const payload: Record<string, unknown> = { type: 'profile' };
    if (input && input.avatar !== undefined) {
      const avatar = cleanAvatar(input.avatar);
      if (!avatar) return Promise.resolve({ success: false, error: 'That picture could not be used.' });
      payload.avatar = avatar;
    }
    if (input && input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) return Promise.resolve({ success: false, error: 'Type a name first.' });
      payload.name = input.name.trim().slice(0, 40);
    }
    if (payload.avatar === undefined && payload.name === undefined) return Promise.resolve({ success: false, error: 'Nothing to change.' });
    return request(payload);
  }

  return {
    state: snapshot,
    profiles: profileList,
    deleteMessage: (id: unknown) => (idOf(id) ? request({ type: 'delete', id }) : Promise.resolve({ success: false, error: 'That message could not be found.' })),
    reportMessage: (id: unknown, reason?: unknown) => (idOf(id)
      ? request({ type: 'report', id, reason: typeof reason === 'string' ? reason.slice(0, 120) : undefined })
      : Promise.resolve({ success: false, error: 'That message could not be found.' })),
    block: (id: unknown) => (idOf(id) ? request({ type: 'block', id }) : Promise.resolve({ success: false, error: 'That person could not be found.' })),
    unblock: (id: unknown) => (idOf(id) ? request({ type: 'unblock', id }) : Promise.resolve({ success: false, error: 'That person could not be found.' })),
    saveProfile,
    connect,
    send,
    disconnect,
    dispose() {
      disconnect();
    },
  };
}
