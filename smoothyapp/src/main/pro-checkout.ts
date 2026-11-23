/**
 * Smoothy Pro checkout inside SmoothyApp.
 *
 * The app's sign-in token is the same signed session the website keeps in its
 * `session` cookie, so a private, in-memory browser session gets that cookie and
 * opens `/pricing?checkout=1`: the Paddle checkout appears already signed in, with
 * no second sign-in. Payment still runs on smoothyedit.com through Paddle.js; no
 * payment keys live in the app. When Paddle returns to `/subscription?success=true`
 * the app re-checks the plan, unlocks Pro and closes the window.
 *
 * Signed out of the app: the checkout opens in the default browser instead, where
 * the website asks the visitor to sign up or sign in first.
 */
import { BrowserWindow, session, shell, type Session } from 'electron';

export interface ProCheckoutDeps {
  apiBase: () => string;
  token: () => string | null;
  isPro: () => boolean;
  refresh: () => Promise<unknown>;
  parent: () => BrowserWindow | null;
  onUnlocked: () => void;
}

// No "persist:" prefix: the cookie lives in memory only and is cleared on close.
const PARTITION = 'smoothy-checkout';
const SESSION_DAYS = 7;
const POPUP_HOSTS = ['paddle.com', 'paypal.com', 'paypalobjects.com'];
const UNLOCK_POLL_MS = 3000;
const UNLOCK_TIMEOUT_MS = 90_000;

const hostMatches = (host: string, domains: string[]) => domains.some(d => host === d || host.endsWith(`.${d}`));

export function createProCheckout(deps: ProCheckoutDeps) {
  let win: BrowserWindow | null = null;
  let polling: ReturnType<typeof setInterval> | null = null;

  const site = () => new URL(deps.apiBase());
  const checkoutUrl = (account = false) => `${site().origin}/pricing?checkout=1${account ? '&account=1' : ''}`;
  const stopPolling = () => { if (polling) clearInterval(polling); polling = null; };

  function inSite(url: string): boolean {
    try { return new URL(url).origin === site().origin; } catch { return false; }
  }
  function allowedPopup(url: string): boolean {
    try { const u = new URL(url); return u.protocol === 'https:' && hostMatches(u.hostname, POPUP_HOSTS); } catch { return false; }
  }
  function openOutside(url: string) {
    try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString()); } catch { /* ignore */ }
  }

  async function signIn(ses: Session, token: string) {
    const base = site();
    await ses.clearStorageData();
    await ses.cookies.set({
      url: base.origin, name: 'session', value: token, path: '/',
      httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 3600,
    });
  }

  /** After Paddle's success page: re-check the plan until Pro shows up, then close. */
  function waitForPro() {
    if (polling) return;
    const started = Date.now();
    const check = async () => {
      try { await deps.refresh(); } catch { /* keep trying */ }
      if (deps.isPro()) {
        stopPolling();
        deps.onUnlocked();
        setTimeout(() => win?.close(), 1500);
      } else if (Date.now() - started > UNLOCK_TIMEOUT_MS) stopPolling();
    };
    void check();
    polling = setInterval(() => void check(), UNLOCK_POLL_MS);
  }

  function isSuccess(url: string): boolean {
    try { const u = new URL(url); return inSite(url) && u.pathname.replace(/\/$/, '') === '/subscription' && u.searchParams.get('success') === 'true'; } catch { return false; }
  }

  async function open(): Promise<{ success: boolean; mode: 'window' | 'browser'; error?: string }> {
    const token = deps.token();
    if (!token) {
      openOutside(checkoutUrl());
      return { success: true, mode: 'browser' };
    }
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return { success: true, mode: 'window' }; }

    const ses = session.fromPartition(PARTITION);
    try { await signIn(ses, token); } catch (error) {
      openOutside(checkoutUrl(true));
      return { success: true, mode: 'browser', error: error instanceof Error ? error.message : 'Could not prepare checkout.' };
    }

    const parent = deps.parent();
    win = new BrowserWindow({
      width: 1000, height: 800, minWidth: 420, minHeight: 560,
      title: 'Upgrade to Smoothy Pro',
      parent: parent ?? undefined,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#1f1f1f',
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
    });
    const current = win;
    current.once('ready-to-show', () => current.show());
    current.on('page-title-updated', event => event.preventDefault());

    // Keep the window on the website; anything else (terms, help, socials) opens in the browser.
    current.webContents.on('will-navigate', (event, url) => {
      if (inSite(url) || allowedPopup(url)) return;
      event.preventDefault();
      openOutside(url);
    });
    // PayPal and some card checks open a popup; keep those in the same private session.
    current.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedPopup(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { parent: current, autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } } };
      }
      openOutside(url);
      return { action: 'deny' };
    });
    current.webContents.on('did-navigate', (_event, url) => { if (isSuccess(url)) waitForPro(); });
    current.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      // -3 is an aborted load (a redirect or our own navigation guard), not a failure.
      if (!isMainFrame || code === -3 || !inSite(url)) return;
      openOutside(checkoutUrl(true));
      current.close();
    });
    current.on('closed', () => {
      stopPolling();
      if (win === current) win = null;
      void ses.clearStorageData().catch(() => {});
      // Paid but closed early (or Paddle skipped the success page): check once more.
      if (!deps.isPro()) void Promise.resolve(deps.refresh()).catch(() => {});
    });

    try {
      await current.loadURL(checkoutUrl(true));
    } catch {
      // did-fail-load handles real failures; a redirect-aborted load lands here harmlessly.
    }
    return { success: true, mode: 'window' };
  }

  return {
    open,
    /** Signed out or switched account: never leave a checkout open for the old account. */
    close() { if (win && !win.isDestroyed()) win.close(); },
  };
}
