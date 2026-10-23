import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface BrowserAuthOptions {
  apiBase: string;
  openExternal(url: string): Promise<unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
}

/** Google stays in the system browser; only a PKCE code crosses loopback. */
export async function browserGoogleSignIn({ apiBase, openExternal, signal, timeoutMs = 5 * 60 * 1000 }: BrowserAuthOptions) {
  const base = new URL(apiBase);
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) throw new Error('Use a secure Smoothy sign-in service.');
  signal.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  let settled = false;
  let finish!: (code: string) => void;
  let fail!: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  // A cancellation may happen while the OS is opening the browser.
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const address = server.address();
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    if (request.method !== 'GET' || request.headers.host !== expectedHost) { response.writeHead(400).end('Invalid sign-in request.'); return; }
    let url: URL;
    try { url = new URL(request.url || '/', `http://${expectedHost}`); }
    catch { response.writeHead(400).end('Invalid sign-in request.'); return; }
    if (url.pathname !== '/callback') { response.writeHead(404).end('Not found.'); return; }
    const suppliedState = url.searchParams.get('state') || '';
    const supplied = Buffer.from(suppliedState);
    if (settled || supplied.length !== state.length || !timingSafeEqual(supplied, Buffer.from(state))) { response.writeHead(400).end('This sign-in request is invalid or expired.'); return; }
    if (url.searchParams.has('error')) {
      settled = true; response.end('Sign-in canceled. You can return to SmoothyApp.'); fail(new Error('Sign-in was canceled.')); return;
    }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1) { response.writeHead(400).end('Missing sign-in code.'); return; }
    settled = true;
    response.end('Sign-in received. Return to SmoothyApp to continue.');
    finish(code);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const abort = () => fail(new Error('Sign-in was canceled.'));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    timeout = setTimeout(() => fail(new Error('Google sign-in timed out. Please try again.')), timeoutMs);
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('Could not open the sign-in receiver.');
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const next = '/desktop-link?' + new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
    const start = new URL('/api/auth/google', base);
    start.searchParams.set('next', next);
    const code = await Promise.race([callback, Promise.resolve().then(() => openExternal(start.href)).then(() => callback)]);
    signal.throwIfAborted();
    const response = await fetch(new URL('/api/desktop-link/token', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error('Could not finish Google sign-in. Please try again.');
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type !== 'Bearer' || typeof data.user?.id !== 'string' || !data.user.id) throw new Error('The sign-in service returned an invalid session.');
    return { sessionToken: data.access_token as string, userId: data.user.id as string };
  } finally {
    settled = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}
