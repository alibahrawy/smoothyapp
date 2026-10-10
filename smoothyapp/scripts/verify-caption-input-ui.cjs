// Actual Electron preload/renderer and webUtils drop paths. Native transcription
// is exercised separately; dialogs/generation/analytics here are isolated fixtures.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-caption-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const validatorBundle = path.join(scratch, 'media-input.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/captions/media-input.ts')], platform: 'node', bundle: true, format: 'cjs', outfile: validatorBundle });
const { validateCaptionMediaPath } = require(validatorBundle);
const audio = path.join(scratch, 'تسجيل صوتي.wav'), other = path.join(scratch, 'other.mp3'), empty = path.join(scratch, 'empty.wav'), subtitle = path.join(scratch, 'captions.srt'), folder = path.join(scratch, 'directory.mp3');
fs.copyFileSync('/tmp/smoothy-caption-arabic.wav', audio); fs.writeFileSync(other, 'fixture'); fs.writeFileSync(empty, ''); fs.writeFileSync(subtitle, 'fixture'); fs.mkdirSync(folder);
let win, language = 'ar', model = 'ggml-base.bin', picker = null, delayed = false, complete;
const starts = [], calls = [], errors = [];
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)/g)].map(m => m[1]);
for (const channel of new Set(methods)) ipcMain.handle(channel, async (_event, ...args) => {
  calls.push({ channel, args });
  const canned = { 'get-status': { connected: false }, 'get-app-preferences': { studioEnabled: false },
    'get-auth-state': { user: null }, 'get-app-version': '2.0.0', 'get-website-connection-status': { connected: false },
    'get-caption-models': [{ id: 'ggml-base.bin', name: 'Base (multilingual)', size: '142 MB' }, { id: 'ggml-large-v3-turbo.bin', name: 'Large v3 Turbo (multilingual)', size: '1.6 GB' }, { id: 'ggml-base.en.bin', name: 'Base (English)', size: '142 MB' }],
    'get-caption-languages': [{ code: 'auto', name: 'Auto-detect' }, { code: 'ar', name: 'Arabic' }, { code: 'en', name: 'English' }],
    'get-caption-language': language, 'get-selected-caption-model': model, 'get-caption-engine': 'auto',
    'get-caption-engine-info': { ready: true, backend: 'metal' }, 'get-bridge-status': { cep: { installed: true } },
    'audio-library-state': { success: true, tracks: [], candidates: [] }, 'audio-archive-search': { success: true, tracks: [], categories: [], moods: [], total: 0 },
    'stock-get-settings': { folder: scratch }, 'assets-get-output-folder': scratch };
  if (channel === 'set-caption-language') { language = args[0]; return { success: true }; }
  if (channel === 'set-selected-caption-model') { model = args[0]; return { success: true }; }
  if (channel === 'validate-caption-audio') {
    try { return { success: true, path: await validateCaptionMediaPath(args[0]) }; }
    catch (error) { return { success: false, error: error.message }; }
  }
  if (channel === 'select-caption-audio') {
    if (!picker) return { canceled: true };
    try { return { success: true, path: await validateCaptionMediaPath(picker) }; }
    catch (error) { return { success: false, error: error.message }; }
  }
  if (channel === 'generate-captions') {
    starts.push('captions');
    if (delayed) return new Promise(resolve => { complete = resolve; });
    return { success: true, captions: [{ index: 1, startTime: 0, endTime: 3, text: 'أعزائي المشاهدين فيديو جديد' }], chunks: [{ text: 'أعزائي', timestamp: [0, 1] }], text: 'أعزائي المشاهدين فيديو جديد' };
  }
  if (channel === 'cancel-generate-captions') { complete?.({ success: false, cancelled: true }); return { success: true }; }
  return canned[channel] ?? {};
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1000, height: 740, show: false, webPreferences: {
    preload: process.env.SMOOTHY_TEST_PRELOAD || path.join(root, 'out/preload/index.js'), contextIsolation: true, sandbox: true
  } });
  const js = code => win.webContents.executeJavaScript(code);
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const click = async id => { await js(`document.getElementById(${JSON.stringify(id)}).click()`); await pause(90); };
  const value = () => js(`document.getElementById('captions-file-path').value`);
  const closeError = () => click('error-close-btn');
  const drop = async files => {
    await js(`(()=>{document.getElementById('fixture-file')?.remove(); const input=document.createElement('input');input.type='file';input.multiple=true;input.id='fixture-file';input.style.display='none';document.body.append(input);})()`);
    const doc = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const node = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fixture-file' });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
    await js(`(()=>{const dt=new DataTransfer();for(const file of document.getElementById('fixture-file').files)dt.items.add(file);document.getElementById('captions-file-drop-zone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`);
    await pause(120);
  };
  try {
    await win.loadFile(process.env.SMOOTHY_TEST_RENDERER || path.join(root, 'out/renderer/index.html')); await pause(350);
    win.webContents.debugger.attach('1.3'); await js(`document.querySelector('[data-tab="captions"]').click()`); await pause(90);
    const noticeVisible = () => js(`!document.getElementById('caption-update-notice').classList.contains('hidden')`);
    const reloadCaptions = async () => { await win.loadFile(process.env.SMOOTHY_TEST_RENDERER || path.join(root, 'out/renderer/index.html')); await pause(350); await js(`document.querySelector('[data-tab="captions"]').click()`); };
    assert.equal(await js(`document.getElementById('multicam-update-notice')`), null);
    assert.equal(await noticeVisible(), true);
    assert.match(await js(`document.getElementById('caption-update-notice').textContent`), /Arabic.*Large v3 Turbo/s);
    await js(`localStorage.setItem('smoothyedit:multicam-beta:1.5.1:dismissed','true')`); await reloadCaptions();
    assert.equal(await noticeVisible(), true);
    for (const label of ['Discord', 'X', 'Instagram']) await js(`Array.from(document.querySelectorAll('[data-caption-support]')).find(a=>a.textContent===${JSON.stringify(label)}).click()`);
    assert.deepEqual(calls.filter(c => c.channel === 'open-external').map(c => c.args[0]), ['https://discord.gg/KmJRqUZzDe', 'https://x.com/alibahrawy34', 'https://www.instagram.com/alibahrawy34/']);
    await click('caption-update-dismiss'); assert.equal(await noticeVisible(), false);
    assert.equal(await js(`document.activeElement.id`), 'caption-language-select');
    await reloadCaptions(); assert.equal(await noticeVisible(), false);
    assert.equal(starts.length, 0); assert.equal(language, 'ar'); assert.equal(model, 'ggml-base.bin');
    assert.equal(calls.filter(c => /^set-|generate|track|telemetry/.test(c.channel)).length, 0);
    await js(`localStorage.removeItem('smoothyedit:arabic-captions:2026-10-09:dismissed')`); await reloadCaptions();
    assert.equal(await noticeVisible(), true);
    assert.match(await js(`document.getElementById('caption-language-status').textContent`), /mishear Arabic/);
    await click('caption-recommended-model'); assert.equal(model, 'ggml-large-v3-turbo.bin'); assert.equal(starts.length, 0);
    await js(`document.getElementById('caption-model-select').value='ggml-base.en.bin';document.getElementById('caption-model-select').dispatchEvent(new Event('change'));`); await pause(80);
    assert.match(await js(`document.getElementById('caption-language-status').textContent`), /needs a multilingual model/);
    await js(`document.getElementById('caption-model-select').value='ggml-base.bin';document.getElementById('caption-model-select').dispatchEvent(new Event('change'));document.getElementById('caption-language-select').value='auto';document.getElementById('caption-language-select').dispatchEvent(new Event('change'));`); await pause(80);
    assert.match(await js(`document.getElementById('caption-language-status').textContent`), /favor speed/);
    await click('caption-recommended-model'); assert.equal(language, 'auto'); assert.equal(starts.length, 0);
    await js(`document.getElementById('caption-language-select').value='ar';document.getElementById('caption-language-select').dispatchEvent(new Event('change'));`); await pause(80);
    await drop([audio]); assert.equal(await value(), fs.realpathSync(audio));
    assert.equal(await js(`document.getElementById('captions-source-file').classList.contains('active')`), true);
    assert.equal(await js(`document.getElementById('generate-captions-btn').disabled`), false); assert.equal(starts.length, 0);
    for (const files of [[subtitle], [empty], [folder], [audio, other]]) {
      await drop(files); assert.equal(await value(), fs.realpathSync(audio));
      assert.equal(await js(`document.getElementById('error-modal').classList.contains('hidden')`), false); await closeError();
    }
    await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['fake'],'remote.wav'));document.getElementById('captions-file-drop-zone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`);
    await pause(80); assert.equal(await value(), fs.realpathSync(audio)); await closeError();
    await click('captions-file-browse'); assert.equal(await value(), fs.realpathSync(audio)); assert.equal(starts.length, 0);
    picker = other; await js(`document.getElementById('captions-file-drop-zone').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`); await pause(90);
    assert.equal(await value(), fs.realpathSync(other)); picker = null;
    await drop([audio]); await click('generate-captions-btn'); assert.deepEqual(starts, ['captions']);
    assert.match(await js(`document.querySelector('.caption-text-editor').value`), /أعزائي المشاهدين/);
    assert.equal(await js(`getComputedStyle(document.querySelector('.caption-text-editor')).direction`), 'rtl');
    assert.equal(await js(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','ordinary text');return document.querySelector('.caption-text-editor').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`), true);
    assert.equal(await js(`document.getElementById('error-modal').classList.contains('hidden')`), true);
    delayed = true; await click('generate-captions-btn'); await drop([other]); assert.equal(await value(), fs.realpathSync(audio));
    await click('progress-cancel-btn'); assert.equal(await js(`document.getElementById('progress-overlay').classList.contains('hidden')`), true);
    assert.deepEqual(starts, ['captions', 'captions']); delayed = false;
    for (const platform of ['macos', 'windows']) for (const [width, height] of [[1000, 740], [600, 500]]) {
      win.setSize(width, height); win.webContents.send('platform-info', { isMac: platform === 'macos', isWindows: platform === 'windows' });
      await js(`document.querySelector('#tab-captions .content-scroll').scrollTop=0`); await pause(100);
      const bounds = await js(`(()=>{const zone=document.getElementById('captions-file-drop-zone'),r=zone.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,border:getComputedStyle(zone).borderTopStyle}})()`);
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width); assert.equal(bounds.border, 'dashed');
      assert.equal(await js(`document.documentElement.scrollWidth>innerWidth`), false);
      const review = process.env.SMOOTHY_REVIEW_DIR;
      if (review) { fs.mkdirSync(review, { recursive: true }); fs.writeFileSync(path.join(review, `captions-${platform}-${width}.png`), (await win.webContents.capturePage()).toPNG()); }
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, nativeFileDrops: true, generationStarts: starts, validationCalls: calls.filter(x => x.channel === 'validate-caption-audio').length, layouts: 4 }));
    app.exit(0);
  } catch (error) { console.error(error, errors); app.exit(1); }
}).finally(() => fs.rmSync(scratch, { recursive: true, force: true }));
