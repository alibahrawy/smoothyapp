/**
 * Anonymous usage telemetry for the free desktop app.
 *
 * The app needs no account, so we count usage with a random install ID that is
 * generated once and stored locally. It contains no personal information — just
 * an ID, the platform, the app version and which tool was run.
 *
 * Users can disable it by setting SMOOTHY_TELEMETRY=0 in the environment.
 */

import { app } from 'electron';
import { randomUUID } from 'crypto';
import Store from 'electron-store';

const API_URL = process.env.SMOOTHY_API_URL || 'https://smoothyedit.com';
const DISABLED = process.env.SMOOTHY_TELEMETRY === '0';

let store: Store | null = null;
let installId: string | null = null;
let started = false;

export function initTelemetry(appStore: Store) {
  if (DISABLED || started) return;
  started = true;
  store = appStore;
  installId = (store.get('installId') as string | undefined) ?? null;
  if (!installId) {
    installId = randomUUID();
    store.set('installId', installId);
  }
}

async function send(event: string, tool?: string) {
  if (DISABLED || !installId) return;
  try {
    await fetch(`${API_URL}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId,
        event,
        tool,
        platform: process.platform,
        appVersion: app.getVersion(),
      }),
    });
  } catch {
    // Offline or blocked — telemetry is best-effort and never blocks the app.
  }
}

export function trackEvent(event: 'install' | 'launch' | 'heartbeat', tool?: string) {
  void send(event, tool);
}

export function trackTool(tool: string) {
  void send('tool_run', tool);
}

export function startHeartbeat() {
  const timer = setInterval(() => send('heartbeat'), 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
