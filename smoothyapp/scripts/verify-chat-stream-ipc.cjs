// Actual packaged preload + renderer + native Chat IPC + HTTP stream reader.
// Provider/auth adapters are local fixtures; no paid requests or production events.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-chat-stream-ipc-'));
app.setPath('userData', path.join(scratch, 'profile'));
globalThis.nativeChatFixture = { owner: 'fixture-owner', events: [], calls: [] };
const fixture = globalThis.nativeChatFixture, errors = []; let win, release;
const stubs = {
  './auth-service': `export const getStoredUserId=()=>globalThis.nativeChatFixture.owner;export const getAuthHeaders=()=>({'Content-Type':'application/json',Authorization:'Bearer test-fixture'});`,
  './telemetry': `export const trackTool=id=>globalThis.nativeChatFixture.events.push(id);`,
  './app-preferences': `export const assertStudioEnabled=()=>{};export const studioSignal=()=>new AbortController().signal;`,
  './studio-service': `export const studioModes=[];`,
  './chat-attachments': `export const chatFileExtensions=['txt'];export const readChatAttachment=async()=>{throw Error('No fixture attachments');};`,
};
const bundleReady = require('esbuild').build({ entryPoints: [path.join(root, 'src/main/chat-ipc.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(scratch, 'chat.cjs'),
  plugins: [{ name: 'fixtures', setup(b) { b.onResolve({ filter: /.*/ }, a => a.path in stubs ? { path: a.path, namespace: 'fixture' } : undefined); b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: stubs[a.path] })); } }] });
const reply = 'A 🌟 streamed reply with several smoothly appearing words.';
globalThis.fetch = async (_url, options) => {
  fixture.calls.push(JSON.parse(options.body)); const bytes = new TextEncoder().encode(reply);
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 4)); // Incomplete emoji waits for its remaining UTF-8 bytes.
    release = () => { controller.enqueue(bytes.slice(4)); controller.close(); };
    options.signal.addEventListener('abort', () => controller.error(new Error('Chat canceled.')), { once: true });
  } }));
};
const canned = { getAppPreferences: { studioEnabled: true }, getAuthState: { user: { id: fixture.owner, tier: 'free', email: 'fixture@example.test' } }, getStatus: { connected: false }, getWebsiteConnectionStatus: { connected: false }, getAppVersion: '2.0.0', getCaptionModels: [], getCaptionLanguages: [], getCaptionEngine: 'cpu', getBridgeStatus: { cep: { installed: true } }, assetsGetOutputFolder: '/fixture/assets', audioLibraryState: { success: true, tracks: [], candidates: [], watching: false }, audioArchiveSearch: { success: true, tracks: [], categories: [], moods: [], total: 0, hasMore: false }, stockGetSettings: { pixabayEnabled: true, folder: '/fixture/stock' }, getStudioCredits: { success: true, credits: { credits: 1950 } } };
const channels = new Set();
for (const match of fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):[^\n]*ipcRenderer.invoke\('([^']+)'/gm)) {
  if (!match[2].startsWith('chat-') && !channels.has(match[2])) { channels.add(match[2]); ipcMain.handle(match[2], () => canned[match[1]] ?? {}); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  try {
    await bundleReady; require(path.join(scratch, 'chat.cjs')).registerChat(() => win, () => true);
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^https?:/.test(d.url) }));
    const built = process.env.CHAT_ASAR_PATH || path.join(root, 'out', '..');
    win = new BrowserWindow({ width: 1000, height: 740, show: false, webPreferences: { preload: path.join(built, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async code => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await pause(30); } throw Error('Timeout: ' + code); };
    const send = async () => js(`document.getElementById('chat-prompt').value='Show a streamed answer';document.getElementById('chat-prompt').dispatchEvent(new Event('input'));document.getElementById('chat-send').click()`);
    await win.loadFile(path.join(built, 'out/renderer/index.html')); await pause(200); await js(`document.querySelector('.nav-item[data-tab="chat"]').click()`);
    await send(); await until(`document.querySelector('.chat-reply')?.textContent==='A '`);
    assert.deepEqual(fixture.events, []); assert.equal(await js(`document.getElementById('chat-send').getAttribute('aria-label')`), 'Stop generating');
    assert.equal('requestId' in fixture.calls[0], false); release(); await until(`!document.getElementById('chat-prompt').disabled`);
    assert.equal(await js(`document.querySelector('.chat-reply').textContent`), reply); assert.deepEqual(fixture.events, ['chat_reply']);
    await js(`document.getElementById('chat-new').click()`); await send(); await until(`document.querySelector('.chat-reply')?.textContent==='A '`);
    await js(`document.getElementById('chat-send').click()`); await until(`!document.getElementById('chat-prompt').disabled`);
    assert.equal(await js(`document.querySelector('.chat-reply').textContent`), 'A '); assert.deepEqual(fixture.events, ['chat_reply']);
    assert.deepEqual(errors, []); console.log('Actual preload/native IPC/HTTP reader/renderer: pre-EOF UTF-8 chunks, word reveal, one completed count, correlated request ID stripped, active stream Stop with frozen partial and zero extra counts passed.'); app.exit(0);
  } catch (error) { console.error(error); console.error(errors); app.exit(1); }
});
