import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ShortsCutKind, ShortsCutsLayout, ShortsCutsServerState } from './types';
import { makeQrDataUrl } from './qr';
import { SHORTSCUT_ICONS, resolveShortsCutIcon, shortsCutColorValue, shortsCutIconSvg } from '../../shared/shortscuts-icons';

export interface ShortsCutsMobileDeckItem {
  id: string;
  label: string;
  kind: ShortsCutKind;
  icon: string;
  color?: string;
  folderId?: string | null;
}

export interface ShortsCutsMobileFolder {
  id: string;
  label: string;
  icon: string;
  color: string;
}

export interface ShortsCutsMobileState {
  connected: boolean;
  editor: string;
  deck: ShortsCutsMobileDeckItem[];
  folders?: ShortsCutsMobileFolder[];
  layout?: ShortsCutsLayout;
  lastAction: string | null;
}

export interface ShortsCutsApplyResponse {
  success: boolean;
  message?: string;
  error?: string;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const PAGE_BODY_LIMIT = 4096;
const CLIENT_WINDOW_MS = 20_000;
const RATE_WINDOW_MS = 60_000;
const RATE_REQUESTS = 120;
const RATE_ACTIONS = 30;

function privateIpv4(value: string): boolean {
  if (/^10\./.test(value) || /^192\.168\./.test(value)) return true;
  const match = value.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function loopback(value: string): boolean {
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

function normalizeAddress(value: string | undefined): string {
  const address = String(value || '');
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function localUrls(port: number): string[] {
  const entries: { name: string; address: string }[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || !privateIpv4(address.address)) continue;
      entries.push({ name, address: address.address });
    }
  }
  const preference = (name: string) => (name === 'en0' ? 0 : name === 'en1' ? 1 : 2);
  entries.sort((a, b) => preference(a.name) - preference(b.name) || a.address.localeCompare(b.address));
  return entries.map((entry) => `http://${entry.address}:${port}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function keyMarkup(attr: string, icon: string, label: string, color: string, extra = ''): string {
  return `<button class="key${extra}" type="button" ${attr} style="--key:${escapeHtml(color)}" aria-label="${escapeHtml(label)}"><span class="key-icon">${shortsCutIconSvg(icon, 30)}</span><span class="key-label">${escapeHtml(label)}</span></button>`;
}

const fontCache = new Map<string, string>();
function fontBase64(file: string): string {
  if (fontCache.has(file)) return fontCache.get(file)!;
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'fonts', file),
    path.join(__dirname, '..', 'renderer', 'assets', file),
    path.join(process.cwd(), 'src', 'renderer', 'fonts', file),
  ];
  for (const candidate of candidates) {
    try {
      const value = readFileSync(candidate).toString('base64');
      fontCache.set(file, value);
      return value;
    } catch {
      // Try the next location.
    }
  }
  try {
    const assets = path.join(__dirname, '..', 'renderer', 'assets');
    const prefix = file.replace(/\.woff2$/, '-');
    const match = readdirSync(assets).find((name) => name.startsWith(prefix) && name.endsWith('.woff2'));
    if (match) {
      const value = readFileSync(path.join(assets, match)).toString('base64');
      fontCache.set(file, value);
      return value;
    }
  } catch {
    // No bundled font; the phone page falls back to the system font.
  }
  fontCache.set(file, '');
  return '';
}

function safeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  });
  response.end(body);
}

export class ShortsCutsServer {
  private server: Server | null = null;
  private tokenValue: string | null = null;
  private portValue: number | null = null;
  private urlsValue: string[] = [];
  private errorValue: string | null = null;
  private lastAction: string | null = null;
  private clients = new Map<string, number>();
  private rates = new Map<string, RateBucket>();
  private actionRates = new Map<string, RateBucket>();
  private qrCache: { url: string; data: string | null } = { url: '', data: null };

  constructor(private readonly options: {
    getState: () => ShortsCutsMobileState;
    apply: (id: string) => Promise<ShortsCutsApplyResponse>;
    onAction?: (message: string) => void;
  }) {}

  get running(): boolean {
    return Boolean(this.server);
  }

  get token(): string | null {
    return this.tokenValue;
  }

  get urls(): string[] {
    return this.urlsValue;
  }

  get port(): number | null {
    return this.portValue;
  }

  state(): ShortsCutsServerState {
    const pageUrl = this.pageUrl();
    if (pageUrl && this.qrCache.url !== pageUrl) this.qrCache = { url: pageUrl, data: makeQrDataUrl(pageUrl) };
    return {
      running: this.running,
      port: this.portValue,
      urls: [...this.urlsValue],
      pageUrl,
      token: this.tokenValue,
      qrDataUrl: pageUrl ? this.qrCache.data : null,
      clients: this.activeClients(),
      lastAction: this.lastAction,
      lastClientAt: this.lastClientAt(),
      error: this.errorValue,
    };
  }

  async start(port: number): Promise<ShortsCutsServerState> {
    this.stop();
    this.errorValue = null;
    const token = randomBytes(24).toString('base64url');
    this.tokenValue = token;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        console.error('[ShortsCuts] Phone remote request failed:', error);
        if (!response.headersSent) sendJson(response, 500, { error: 'The phone remote could not complete that request.' });
        else response.end();
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo | null;
      this.portValue = address?.port ?? port;
      this.urlsValue = localUrls(this.portValue);
      return this.state();
    } catch (error) {
      this.stop();
      const message = error instanceof Error ? error.message : 'Could not start the phone remote.';
      this.errorValue = /EADDRINUSE/i.test(message)
        ? `Port ${port} is already in use. Choose another port.`
        : `Could not start the phone remote: ${message}`;
      throw new Error(this.errorValue);
    }
  }

  stop(): void {
    this.errorValue = null;
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // Already closed.
      }
    }
    this.server = null;
    this.tokenValue = null;
    this.portValue = null;
    this.urlsValue = [];
    this.clients.clear();
    this.rates.clear();
    this.actionRates.clear();
  }

  async rotateToken(): Promise<ShortsCutsServerState> {
    if (this.server && this.portValue !== null) {
      const port = this.portValue;
      this.stop();
      return this.start(port);
    }
    this.tokenValue = randomBytes(24).toString('base64url');
    return this.state();
  }

  pageUrl(): string | null {
    if (!this.tokenValue) return null;
    const base = this.urlsValue[0] || (this.portValue ? `http://127.0.0.1:${this.portValue}` : null);
    return base ? `${base}/m/${this.tokenValue}` : null;
  }

  private activeClients(): number {
    const cutoff = Date.now() - CLIENT_WINDOW_MS;
    let count = 0;
    for (const seenAt of this.clients.values()) if (seenAt >= cutoff) count++;
    return count;
  }

  private lastClientAt(): number | null {
    let latest = 0;
    for (const seenAt of this.clients.values()) latest = Math.max(latest, seenAt);
    return latest || null;
  }

  private markClient(address: string) {
    this.clients.set(address, Date.now());
    if (this.clients.size > 64) {
      const cutoff = Date.now() - CLIENT_WINDOW_MS;
      for (const [key, seenAt] of this.clients) if (seenAt < cutoff) this.clients.delete(key);
    }
  }

  private limited(bucket: Map<string, RateBucket>, address: string, limit: number): boolean {
    const now = Date.now();
    const current = bucket.get(address);
    if (!current || current.resetAt < now) {
      bucket.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return false;
    }
    current.count++;
    return current.count > limit;
  }

  private tokenFrom(pathname: string, prefix: '/m/' | '/api/'): string | null {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    if (!rest || rest.includes('/')) return null;
    return rest;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = normalizeAddress(request.socket.remoteAddress);
    if (!loopback(address) && !privateIpv4(address)) {
      sendJson(response, 403, { error: 'This remote is available on the local network only.' });
      return;
    }
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, app: 'ShortsCuts' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (this.limited(this.rates, address, RATE_REQUESTS)) {
      sendJson(response, 429, { error: 'Too many requests. Wait a minute and try again.' });
      return;
    }

    const pageToken = this.tokenFrom(url.pathname, '/m/');
    if (pageToken && request.method === 'GET') {
      if (!this.tokenValue || !safeEqual(pageToken, this.tokenValue)) {
        sendJson(response, 401, { error: 'This phone remote code is no longer valid. Scan the new code on your computer.' });
        return;
      }
      this.markClient(address);
      this.sendPage(response);
      return;
    }

    const apiParts = url.pathname.split('/');
    const apiToken = apiParts.length === 4 && apiParts[1] === 'api' ? apiParts[2] : '';
    const endpoint = apiParts.length === 4 ? apiParts[3] : '';
    if (!apiToken || !this.tokenValue || !safeEqual(apiToken, this.tokenValue)) {
      sendJson(response, 401, { error: 'This phone remote code is no longer valid. Scan the new code on your computer.' });
      return;
    }
    if (request.method === 'GET' && endpoint === 'state') {
      this.markClient(address);
      sendJson(response, 200, this.options.getState());
      return;
    }
    if (request.method === 'POST' && endpoint === 'apply') {
      if (this.limited(this.actionRates, address, RATE_ACTIONS)) {
        sendJson(response, 429, { error: 'Too many shortcuts. Wait a minute and try again.' });
        return;
      }
      this.markClient(address);
      let body: string;
      try {
        body = await this.readBody(request);
      } catch (error) {
        sendJson(response, 413, { success: false, error: error instanceof Error ? error.message : 'Request too large.' });
        return;
      }
      let id = '';
      try {
        const parsed = JSON.parse(body);
        id = typeof parsed?.id === 'string' ? parsed.id : '';
      } catch {
        sendJson(response, 400, { success: false, error: 'Invalid shortcut request.' });
        return;
      }
      if (!id || !this.options.getState().deck.some((item) => item.id === id)) {
        sendJson(response, 404, { success: false, error: 'That shortcut is no longer in the deck.' });
        return;
      }
      const result = await this.options.apply(id);
      this.lastAction = result.success ? `Applied from phone at ${new Date().toLocaleTimeString()}` : `Phone shortcut failed at ${new Date().toLocaleTimeString()}`;
      try {
        this.options.onAction?.(this.lastAction);
      } catch {
        // Never let UI feedback break the action.
      }
      sendJson(response, result.success ? 200 : 409, result);
      return;
    }
    sendJson(response, 404, { error: 'Not found.' });
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > PAGE_BODY_LIMIT) {
          reject(new Error('Request too large.'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  private sendPage(response: ServerResponse): void {
    const body = this.pageHtml();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    response.end(body);
  }

  private pageHtml(): string {
    const state = this.options.getState();
    const deck = state.deck.map((item) => ({
      id: item.id,
      label: item.label,
      kind: item.kind,
      icon: item.icon || resolveShortsCutIcon(item),
      color: item.color || shortsCutColorValue(undefined, item.kind),
      folderId: item.folderId || null,
    }));
    const folders = state.folders || [];
    const layout = state.layout || { phoneColumns: 3, tabletColumns: 5 };
    const initial = scriptJson({ connected: state.connected, deck, folders, layout });
    const iconsJson = scriptJson(SHORTSCUT_ICONS);
    const regular = fontBase64('Bunch-Regular.woff2');
    const bold = fontBase64('Bunch-Bold.woff2');
    const folderIds = new Set(folders.map((folder) => folder.id));
    const cards = [
      ...folders.map((folder) => keyMarkup(`data-folder-id="${escapeHtml(folder.id)}"`, folder.icon, folder.label, folder.color, ' key-folder')),
      ...deck.filter((item) => !item.folderId || !folderIds.has(item.folderId)).map((item) => keyMarkup(`data-cut-id="${escapeHtml(item.id)}"`, item.icon, item.label, item.color)),
    ];
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#faf9f5">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>ShortsCuts · Smoothy</title>
<style>
${regular ? `@font-face{font-family:Bunch;font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${regular}) format("woff2")}` : ''}
${bold ? `@font-face{font-family:Bunch;font-style:normal;font-weight:700;src:url(data:font/woff2;base64,${bold}) format("woff2")}` : ''}
:root{color-scheme:light;--bg:#faf9f5;--ink:#23302d;--muted:#79807b;--line:#e7e4db;--card:#fff;--bad:#c4543f;--cols:${layout.phoneColumns}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Bunch,-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-text-size-adjust:100%;-webkit-user-select:none;user-select:none}
main{width:min(100%,1100px);margin-inline:auto;padding:calc(14px + env(safe-area-inset-top)) 14px calc(24px + env(safe-area-inset-bottom))}
header{display:flex;align-items:center;gap:10px;min-height:40px;margin-bottom:12px}
h1{flex:1;min-width:0;margin:0;overflow:hidden;font-size:20px;letter-spacing:-.03em;line-height:1.1;text-overflow:ellipsis;white-space:nowrap}
.back{display:none;place-items:center;width:38px;height:38px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);font:inherit;font-size:20px;cursor:pointer}
.in-folder .back{display:grid}
.state{display:none;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad);font-size:12px;font-weight:700;white-space:nowrap}
.state[data-connected="false"]{display:inline-flex}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.deck{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:10px}
.key{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;aspect-ratio:1;min-width:0;padding:10px 6px;border:0;border-radius:18px;background:var(--key);color:#fff;font:inherit;text-align:center;cursor:pointer;touch-action:manipulation;box-shadow:inset 0 -3px 0 rgb(0 0 0 / .14),0 1px 2px rgb(0 0 0 / .08);transition:transform .08s ease,filter .12s ease}
.key-icon{display:grid;place-items:center;width:44%;max-width:44px;aspect-ratio:1}
.key-icon svg{width:100%;height:100%}
.key-label{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;width:100%;overflow:hidden;font-size:clamp(11px,3.2vw,14px);font-weight:700;line-height:1.15;letter-spacing:-.01em;overflow-wrap:anywhere;text-shadow:0 1px 1px rgb(0 0 0 / .12)}
.key-folder::after{content:"";position:absolute;top:8px;right:8px;width:6px;height:6px;border-radius:50%;background:rgb(255 255 255 / .75)}
.key:active,.key.is-pressed{transform:scale(.95);filter:brightness(.92)}
.key:disabled{opacity:.42;cursor:default}
.key-folder:disabled{opacity:1}
.hint{margin:16px 4px 0;text-align:center;font-size:13px;line-height:1.5;color:var(--muted)}
.hint:empty{display:none}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));z-index:5;transform:translate(-50%,20px);max-width:min(90vw,420px);padding:12px 16px;border-radius:12px;background:var(--ink);color:#fff;font-size:13px;font-weight:700;box-shadow:0 12px 30px rgb(0 0 0 / .2);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}
#toast.show{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){.key{transition:none}}
</style>
</head>
<body>
<main id="main">
<header>
<button class="back" id="back" type="button" aria-label="Back">‹</button>
<h1 id="title">ShortsCuts</h1>
<span class="state" id="state" data-connected="${state.connected ? 'true' : 'false'}">Premiere offline</span>
</header>
<section class="deck" id="deck" aria-label="ShortsCuts deck">${cards.join('')}</section>
<p class="hint" id="hint"></p>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>
const initial=${initial};
const ICONS=${iconsJson};
const api='/api/${this.tokenValue}';
const deckEl=document.getElementById('deck');
const hint=document.getElementById('hint');
const stateEl=document.getElementById('state');
const titleEl=document.getElementById('title');
const mainEl=document.getElementById('main');
let state=initial,folder=null,toastTimer,lastSignature='';
function iconSvg(id){const inner=ICONS[id]||ICONS.sparkle;return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">'+inner+'</svg>'}
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function key(attr,icon,label,color,extra){return '<button class="key'+(extra||'')+'" type="button" '+attr+' style="--key:'+esc(color)+'" aria-label="'+esc(label)+'"><span class="key-icon">'+iconSvg(icon)+'</span><span class="key-label">'+esc(label)+'</span></button>'}
function columns(){const layout=state.layout||{};const tablet=Math.min(window.innerWidth,window.innerHeight)>=600||window.innerWidth>=820;document.documentElement.style.setProperty('--cols',String(tablet?(layout.tabletColumns||5):(layout.phoneColumns||3)))}
function toast(message){const el=document.getElementById('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2200)}
function renderDeck(){
  const folders=state.folders||[];
  const ids=new Set(folders.map(f=>f.id));
  if(folder&&!ids.has(folder))folder=null;
  const current=folders.find(f=>f.id===folder);
  mainEl.classList.toggle('in-folder',!!current);
  titleEl.textContent=current?current.label:'ShortsCuts';
  const items=(state.deck||[]).filter(item=>current?item.folderId===current.id:!(item.folderId&&ids.has(item.folderId)));
  const keys=current?[]:folders.map(f=>key('data-folder-id="'+esc(f.id)+'"',f.icon,f.label,f.color,' key-folder'));
  for(const item of items)keys.push(key('data-cut-id="'+esc(item.id)+'"',item.icon,item.label,item.color));
  deckEl.innerHTML=keys.join('');
  deckEl.querySelectorAll('[data-cut-id]').forEach(button=>{button.disabled=!state.connected});
  if(!state.connected)hint.textContent='Open Premiere and connect the Smoothy panel.';
  else if(!keys.length)hint.textContent=current?'This folder is empty. Add keys to it on your computer.':'Add keys on your computer to fill this deck.';
  else hint.textContent='';
}
function applyState(next){
  const signature=JSON.stringify([next.connected,next.deck,next.folders,next.layout]);
  state=next;
  stateEl.dataset.connected=String(!!next.connected);
  stateEl.textContent='Premiere offline';
  columns();
  if(signature!==lastSignature){lastSignature=signature;renderDeck()}
}
async function refresh(){
  try{
    const response=await fetch(api+'/state',{cache:'no-store'});
    if(!response.ok)throw new Error((await response.json()).error||'Connection lost');
    applyState(await response.json());
  }catch(error){
    state.connected=false;lastSignature='';
    stateEl.dataset.connected='false';
    stateEl.textContent='Computer offline';
    hint.textContent='Lost the connection to Smoothy on your computer.';
    deckEl.querySelectorAll('[data-cut-id]').forEach(button=>{button.disabled=true});
  }
}
async function apply(id,button){
  if(!state.connected){toast('Connect Premiere on your computer first');return}
  button.disabled=true;button.classList.add('is-pressed');
  try{
    const response=await fetch(api+'/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const result=await response.json();
    if(!response.ok||!result.success)throw new Error(result.error||'Could not apply that shortcut');
    toast(result.message||'Applied');
    if(navigator.vibrate)navigator.vibrate(12);
  }catch(error){
    toast(error.message||'Could not apply that shortcut');
    if(navigator.vibrate)navigator.vibrate([20,40,20]);
  }finally{
    setTimeout(()=>{button.classList.remove('is-pressed');button.disabled=!state.connected},170);
    refresh();
  }
}
deckEl.addEventListener('click',event=>{
  const open=event.target.closest('[data-folder-id]');
  if(open){folder=open.dataset.folderId;renderDeck();window.scrollTo(0,0);return}
  const button=event.target.closest('[data-cut-id]');
  if(button)apply(button.dataset.cutId,button);
});
document.getElementById('back').addEventListener('click',()=>{folder=null;renderDeck()});
window.addEventListener('resize',columns);
applyState(initial);
setInterval(refresh,4000);
</script>
</body>
</html>`;
  }
}
