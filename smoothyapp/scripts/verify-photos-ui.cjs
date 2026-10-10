// Real Electron renderer and PhotoService. Only account/cloud/file adapters are simulated.
const { app, BrowserWindow, ipcMain, session, protocol } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-photo-ui-'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/photo-catalog.json'), 'utf8'));
app.setPath('userData', path.join(scratch, 'profile'));
app.once('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
protocol.registerSchemesAsPrivileged([{ scheme: 'smoothy-photo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const servicePath = path.join(scratch, 'photos.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/photo-service.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: servicePath });
const { PhotoService } = require(servicePath);
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(match => match[1]);
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>ipcRenderer.on(name,(_e,data)=>fn(data)):(...args)=>ipcRenderer.invoke('fixture-call',name,args)]));contextBridge.exposeInMainWorld('electronAPI',api);`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
let win, user = null, rejectNext = false, callId = 0, holdNext = false, releaseHeld, saveCanceled = false, fileFailure = false, storageMode = 'paid';
const calls = [], errors = [], usage = [];
const service = new PhotoService({ owner: () => user?.id || null, imageBytes: async () => png, png: bytes => bytes, track: id => usage.push(id), request: async (route, options) => {
  calls.push({ route, options });
  if (holdNext) { holdNext = false; await new Promise(resolve => { releaseHeld = resolve; }); }
  if (rejectNext) { rejectNext = false; throw Error('No credits remaining'); }
  if (route.startsWith('/api/reactions?')) return storageMode === 'free' ? { totalPages: 0, reactions: [], cloudStorageAvailable: false } : { totalPages: 2, cloudStorageAvailable: true, reactions: [{ id: 'history-a', reactionLabel: '<img src=x onerror=alert(1)>', imageUrl, model: 'google/gemini-3.1-flash-image', aspectRatio: '16:9' }] };
  return { imageUrl, savedReactionId: storageMode === 'paid' ? `saved-${++callId}` : null, historySaved: storageMode === 'paid', cloudStorageAvailable: storageMode !== 'free' };
} });
ipcMain.handle('fixture-call', async (_event, name, args) => {
  const canned = { getAuthState: { user }, getStatus: { connected: false }, getWebsiteConnectionStatus: { connected: false }, getAppVersion: '2.0.0', getCaptionModels: [], getCaptionLanguages: [], getCaptionEngine: 'cpu', getBridgeStatus: { cep: { installed: true } }, assetsGetOutputFolder: '/fixture/assets', audioLibraryState: { success: true, tracks: [], candidates: [], watching: false }, audioArchiveSearch: { success: true, tracks: [], categories: [], moods: [], total: 0, hasMore: false }, stockGetSettings: { pixabayEnabled: true, folder: '/fixture/stock' }, getStudioCredits: { success: true, credits: { credits: 1950 } } };
  try {
    if (name === 'photosRun') return { success: true, ...await service.run(args[0]) };
    if (name === 'photosHistory') return { success: true, ...await service.history(args[0]?.page || 1, args[0]?.favorites) };
    if (name === 'photosReset') { service.reset(); return { success: true }; }
    if (name === 'photosFavorite') { await service.favorite(args[0].id, args[0].active); return { success: true }; }
    if (name === 'photosDelete') { await service.remove(args[0]); return { success: true }; }
    if (name.startsWith('photos')) { calls.push({ name, args }); return fileFailure ? { success: false, error: 'Could not save image' } : { success: true, canceled: name === 'photosSave' && saveCanceled }; }
    return canned[name] ?? {};
  } catch (error) { return { success: false, error: error.message }; }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  protocol.handle('smoothy-photo', async request => new Response(await service.bytes(new URL(request.url).pathname.slice(1)), { headers: { 'content-type': 'image/png' } }));
  win = new BrowserWindow({ width: 1000, height: 740, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  let lastJs = '';
  const js = code => { lastJs = code; return win.webContents.executeJavaScript(code); };
  const click = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(90); };
  const capture = async name => { await pause(350); const folder = process.env.SMOOTHY_REVIEW_DIR || path.join(root, '../docs/reviews/smoothyapp-v2-photo-menus'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const setUser = async value => { user = value; win.webContents.send('onAuthStateChange', { user }); await pause(100); };
  try {
    await win.loadFile(process.env.SMOOTHY_TEST_RENDERER || path.join(root, 'out/renderer/index.html')); await pause(250);
    await click('.nav-item[data-tab="photos"]');
    assert.equal(await js(`document.getElementById('photos-signin').classList.contains('hidden')`), false);
    assert.equal(await js(`document.querySelector('#photos-empty h2').textContent`),'Create or edit an image');
    assert.equal(await js(`document.querySelector('#photos-empty p').textContent`),'Describe it or attach a picture.');
    assert.equal(await js(`document.querySelector('#photos-empty > span:last-child')`),null);
    assert.deepEqual(calls, []); assert.deepEqual(usage, []);
    await click('#photos-signin-btn'); assert.equal(await js(`document.getElementById('login-modal').classList.contains('hidden')`), false); await click('#login-close-btn');
    await setUser({ id: 'account-a', email: 'fixture@example.test', tier: 'free' });
    assert.equal(await js(`document.getElementById('photos-signin').classList.contains('hidden')`), true);
    assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 0);
    assert.equal(await js(`document.querySelectorAll('.nav-item[data-tab="photos"]').length`), 1);
    assert.equal(await js(`document.querySelectorAll('#photos-model-list [role=option]').length`),catalog.IMAGE_MODELS.length); assert.equal(await js(`document.querySelectorAll('#tab-photos select').length`),0); assert.equal(await js(`document.getElementById('photos-tool')`),null);
    assert.equal(await js(`document.getElementById('photos-model').value`),catalog.DEFAULT_IMAGE_MODEL);
    assert.equal(await js(`document.querySelector('#photos-model .photo-picker-label').textContent`),'GPT Image 2.5 Flare');
    assert.equal(await js(`document.getElementById('photos-ratio').value`),'16:9');
    await click('.nav-item[data-tab="photos"]');
    assert.equal(await js(`document.querySelector('#tab-photos .photo-composer-note')`),null);
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none');
    assert.equal(await js(`document.querySelectorAll('#photos-drop-zone #photos-ratio, #photos-drop-zone #photos-size').length`),2);
    assert.equal(await js(`document.querySelectorAll('#photos-model-list .photo-model-avatar').length`),catalog.IMAGE_MODELS.length);
    assert.equal(await js(`document.querySelectorAll('#photos-model-list .photo-picker-price').length`),catalog.IMAGE_MODELS.length);
    assert.ok(await js(`[...document.querySelectorAll('#photos-model-list .photo-picker-price')].every(item=>/credits|unavailable/i.test(item.textContent))`));
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-estimate')).display`),'none');
    assert.equal(await js(`document.querySelectorAll('#tab-photos [role=tab]').length`),0);
    assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');
    assert.equal(await js(`document.querySelector('#photos-drop-zone .photo-image-label')`),null);
    assert.equal(await js(`document.getElementById('photos-options')`),null);
    assert.equal(await js(`document.getElementById('photos-reactions-panel').hasAttribute('popover')`),false);
       assert.match(await js(`document.getElementById('photos-estimate').textContent`),/≈.*credits|Estimate unavailable/);
    assert.ok(await js(`document.querySelectorAll('#photos-model-list img.photo-model-logo').length`)>0);
    assert.equal(await js(`[...document.querySelectorAll('#photos-model-list img.photo-model-logo')].every(i=>i.complete&&i.naturalWidth>0)`),true);
    assert.equal(await js(`document.querySelector('#photos-model .photo-model-logo').naturalWidth>0`),true);
    await click('#photos-model');await click('#photos-model-list [data-value="google/gemini-3.1-flash-image"]');
    const localCalls=calls.length, localUsage=usage.length;
    await click('#photos-size'); await click('#photos-size-list [data-value="4K"]');
    const largerEstimate=await js(`document.getElementById('photos-estimate').textContent`);
    const largerModelPrice=await js(`document.querySelector('#photos-model-list [data-value="google/gemini-3.1-flash-image"] .photo-picker-price').textContent`);
    await click('#photos-size'); await click('#photos-size-list [data-value="1K"]');
    assert.notEqual(await js(`document.getElementById('photos-estimate').textContent`),largerEstimate);
    assert.notEqual(await js(`document.querySelector('#photos-model-list [data-value="google/gemini-3.1-flash-image"] .photo-picker-price').textContent`),largerModelPrice);
    await click('#photos-reactions');
    assert.equal(await js(`document.getElementById('photos-reactions-panel').hidden`),false);
    assert.equal(await js(`document.activeElement.id`),'photos-reactions-close');
    await click('[data-preset-id="curious"]'); await click('[data-preset-id="mindblown"]');
    assert.match(await js(`document.getElementById('photos-estimate').textContent`),/credits total/);
    assert.equal(await js(`document.getElementById('photos-reactions-estimate').textContent`),await js(`document.getElementById('photos-estimate').textContent`));
    await click('#photos-reactions-clear'); await click('#photos-reactions-done');
    assert.equal(calls.length,localCalls);assert.equal(usage.length,localUsage);

    const menuCalls=calls.length, menuUsage=usage.length;
    await click('#photos-model'); await click('[data-model-filter="low-cost"]');
    assert.ok(await js(`document.querySelectorAll('#photos-model-list [role=option]:not([hidden])').length`)>0);
    await js(`document.getElementById('photos-model-search').value='OpenAI';document.getElementById('photos-model-search').dispatchEvent(new Event('input'))`);
    assert.ok(await js(`document.querySelectorAll('#photos-model-list [role=option]:not([hidden])').length`)>0);
    assert.ok(await js(`[...document.querySelectorAll('#photos-model-list [role=option]:not([hidden])')].every(option=>option.textContent.includes('OpenAI'))`));
    await js(`document.getElementById('photos-model-search').value='No match';document.getElementById('photos-model-search').dispatchEvent(new Event('input'))`);
    assert.equal(await js(`document.querySelector('#photos-model-menu .photo-picker-empty').classList.contains('hidden')`),false);
    await js(`document.getElementById('photos-model-menu').hidePopover()`); await click('#photos-model');
    assert.equal(await js(`document.querySelectorAll('#photos-model-list [role=option]:not([hidden])').length`),catalog.IMAGE_MODELS.length);
    await click('[data-model-filter="4k"]');
    assert.ok(await js(`document.querySelectorAll('#photos-model-list [role=option]:not([hidden])').length > 0`));
    await capture('model-filter-desktop'); await js(`document.getElementById('photos-model-menu').hidePopover()`);
    assert.equal(calls.length,menuCalls); assert.equal(usage.length,menuUsage);
    await capture('workspace-desktop');
    await js(`document.getElementById('photos-prompt').value='A beautiful sky';document.getElementById('photos-prompt').dispatchEvent(new Event('input'))`);holdNext=true;await click('#photos-generate');
    assert.equal(await js(`document.querySelector('.photo-generation-loading')?.getAttribute('role')`),'status');
    assert.equal(await js(`getComputedStyle(document.querySelector('.photo-generation-spinner')).animationName`),'photo-generation-spin');
    releaseHeld();await pause(120);
    assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 1); assert.match(await js(`document.getElementById('photos-credits').textContent`), /1,950/);
    const alignment=await js(`(()=>{const row=document.querySelector('.photo-chat-turn').getBoundingClientRect(),workspace=document.getElementById('photos-signedin').getBoundingClientRect(),prompt=document.querySelector('.photo-chat-prompt').getBoundingClientRect(),response=document.querySelector('.photo-chat-response').getBoundingClientRect(),card=document.querySelector('.photo-chat-response .photo-result-card').getBoundingClientRect();return{rowLeft:row.left,rowRight:row.right,workspaceLeft:workspace.left,workspaceRight:workspace.right,promptRight:prompt.right,responseLeft:response.left,cardLeft:card.left}})()`);
    assert.ok(Math.abs(alignment.rowLeft-alignment.workspaceLeft)<1&&Math.abs(alignment.rowRight-alignment.workspaceRight)<1&&alignment.promptRight>=alignment.workspaceRight-1&&alignment.responseLeft<=alignment.workspaceLeft+1&&alignment.cardLeft<=alignment.workspaceLeft+1,JSON.stringify(alignment));
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');
    assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-selected-source')).display`),'none');
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-source-label')).position`),'absolute');
    await capture('selected-image-replaces-tile');


    const clearCalls=calls.length, clearUsage=usage.length;
    await click('#photos-source-clear');
    assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');
    assert.equal(calls.length,clearCalls);assert.equal(usage.length,clearUsage);
    await click('.photo-result-preview'); assert.equal(await js(`document.getElementById('photos-viewer').open`), true);
    const viewerBounds=await js(`(()=>{const r=document.getElementById('photos-viewer').getBoundingClientRect();return{centerX:r.left+r.width/2,centerY:r.top+r.height/2,width:innerWidth,height:innerHeight,right:r.right,bottom:r.bottom}})()`);
    assert.ok(Math.abs(viewerBounds.centerX-viewerBounds.width/2)<1&&Math.abs(viewerBounds.centerY-viewerBounds.height/2)<1&&viewerBounds.right<=viewerBounds.width&&viewerBounds.bottom<=viewerBounds.height,JSON.stringify(viewerBounds));
    assert.equal(await js(`document.activeElement.id`), 'photos-viewer-close');
    assert.equal(calls.filter(call => call.name === 'photosPreview').length, 1);
    await click('#photos-viewer-save');
    assert.equal(await js(`document.getElementById('photos-status').textContent`),'');
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none');
    saveCanceled=true; await click('#photos-viewer-save'); saveCanceled=false;
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none');
    fileFailure=true; await click('#photos-viewer-save'); fileFailure=false;
    assert.match(await js(`document.getElementById('photos-status').textContent`),/Could not save/);
    assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none');
    await click('#photos-viewer-save');
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none');
    await click('#photos-viewer-use'); assert.equal(await js(`document.getElementById('photos-viewer').open`), false);
    await click('#photos-reactions');
    await click('[data-preset-id="curious"]'); await click('[data-preset-id="mindblown"]'); await click('#photos-reactions-done'); await click('#photos-generate');
    assert.equal(usage.filter(id => id === 'photos_preset').length, 2);
    assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 3);
    await click('#photos-history-toggle');
    assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 1);
    assert.equal(await js(`document.querySelectorAll('.photo-result-card h3 img').length`), 0);
    await click('#photos-history-next'); assert.match(calls.at(-1).route, /page=2/);
    assert.match(await js(`document.getElementById('photos-history-policy').textContent`), /30 images.*100 MB.*favorites/);
    await capture('history-desktop');
    await click('#photos-history-toggle');
    await click('#photos-new-chat');
    const prompt = async value => js(`document.getElementById('photos-prompt').value=${JSON.stringify(value)};document.getElementById('photos-prompt').dispatchEvent(new Event('input'))`);
    for (const model of catalog.IMAGE_MODELS) {
      await click('#photos-new-chat');
      await click('#photos-model'); await click(`#photos-model-list [data-value="${model.id}"]`);
      assert.equal(await js(`document.getElementById('photos-model').getAttribute('aria-expanded')`),'false');
       assert.match(await js(`document.getElementById('photos-estimate').textContent`),/≈.*credits|Estimate unavailable/);
       const selectedIcon=await js(`(()=>{const trigger=document.querySelector('#photos-model .photo-model-logo'),monogram=document.querySelector('#photos-model .photo-model-trigger-monogram'),option=document.querySelector('#photos-model-list [aria-selected="true"]'),logo=option.querySelector('.photo-model-logo'),avatar=option.querySelector('.photo-model-avatar');return{hasLogo:Boolean(logo),triggerHidden:trigger.hidden,triggerSource:trigger.src,menuSource:logo?.src,monogram:monogram.textContent,avatar:avatar.textContent}})()`);
       if(selectedIcon.hasLogo)assert.equal(selectedIcon.triggerSource,selectedIcon.menuSource);else assert.equal(selectedIcon.monogram,selectedIcon.avatar);
      await prompt('A sky with '+model.label); await click('#photos-generate');
      assert.equal(calls.filter(call=>call.route==='/api/generate-reaction').at(-1).options.body.model, model.id);
    }
    // Model-specific options and references cannot create an unsupported paid request.
    await click('#photos-model'); await click('#photos-model-list [data-value="bytedance-seed/seedream-4.5"]');
    await click('#photos-size'); await click('#photos-size-list [data-value="4K"]');
    assert.equal(await js(`document.getElementById('photos-size').value`),'4K');
    assert.equal(await js(`document.getElementById('photos-size-menu').matches(':popover-open')`),false);
    await click('#photos-ratio'); await click('#photos-ratio-list [data-value="5:4"]');
    await click('#photos-model'); await click('#photos-model-list [data-value="bytedance-seed/seedream-5-0-flash"]');
    assert.equal(await js(`document.getElementById('photos-size').value`),'1K');
    assert.equal(await js(`document.querySelector('#photos-size-list [data-value="4K"]')`),null);
    await click('#photos-model'); await click('#photos-model-list [data-value="x-ai/grok-imagine-image-2.0"]');
    assert.equal(await js(`document.querySelector('#photos-ratio-list [data-value="5:4"]')`),null);
    assert.notEqual(await js(`document.getElementById('photos-ratio').value`),'5:4');
    await click('#photos-new-chat');
    const beforeLimit = calls.filter(call=>call.route).length;
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0));const transfer=new DataTransfer();for(let i=0;i<4;i++)transfer.items.add(new File([bytes],'reference-'+i+'.png',{type:'image/png'}));document.getElementById('photos-prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));})()`); await pause(100);
    await prompt('Use these references');
    assert.equal(await js(`document.getElementById('photos-generate').disabled`),true);
    assert.match(await js(`document.getElementById('photos-reference-warning').textContent`),/up to 3 reference/);
    assert.equal(calls.filter(call=>call.route).length,beforeLimit);
    await click('#photos-model'); await click('#photos-model-list [data-value="google/gemini-3.1-flash-image"]');
    assert.equal(await js(`document.getElementById('photos-generate').disabled`),false);
    await click('#photos-new-chat');
    // Menus use app focus/keyboard handling, including search, Home/End and Escape.
    await click('#photos-model');
    assert.equal(await js(`document.activeElement.id`),'photos-model-search');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
    assert.equal(await js(`document.activeElement.dataset.value`),catalog.IMAGE_MODELS.at(-1).id);
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
    assert.equal(await js(`document.activeElement.dataset.value`),catalog.IMAGE_MODELS[0].id);
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await pause(50);
    assert.equal(await js(`document.activeElement.id`),'photos-model');
    assert.equal(await js(`document.getElementById('photos-model').getAttribute('aria-expanded')`),'false');
    await prompt('A reference sky'); await click('#photos-generate');
    // Enter submits once, Shift+Enter and IME composition do not submit.
    await prompt('Change it to a night sky'); const requestCount = calls.filter(call=>call.route).length;
    await js(`document.getElementById('photos-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}));document.getElementById('photos-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
    assert.equal(calls.filter(call=>call.route).length, requestCount);
    await js(`document.getElementById('photos-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`); await pause(100);
    assert.equal(calls.filter(call=>call.route).length, requestCount+1);
    assert.equal(usage.at(-1),'photos_edit');
    await click('#photos-new-chat');
    // Clipboard attachment uses the same bounds and reference path as + and drag/drop.
    assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');

    const beforeAttachment = calls.filter(call=>call.route).length;
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'reference.png',{type:'image/png'}));document.getElementById('photos-prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));})()`); await pause(100);
    assert.equal(await js(`document.querySelectorAll('.photo-reference').length`),1); assert.equal(calls.filter(call=>call.route).length,beforeAttachment);
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');
    assert.equal(await js(`document.querySelector('#photos-references .photo-reference-preview').getAttribute('aria-label')`),'Add reference pictures');
    const savedReference=await js(`document.querySelector('#photos-references img').src`);
    await js(`document.getElementById('photos-files').dispatchEvent(new Event('change'))`);
    assert.equal(await js(`document.querySelector('#photos-references img').src`),savedReference);
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');
    await capture('attached-image-replaces-tile');
    await click('#photos-references .photo-reference-remove');
    assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-attach')).display`),'none');
    assert.equal(calls.filter(call=>call.route).length,beforeAttachment);
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'reference.png',{type:'image/png'}));document.getElementById('photos-prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));})()`); await pause(100);

    await prompt('Turn this into a painting'); await click('#photos-generate'); assert.equal(usage.at(-1),'photos_edit');
    assert.equal(calls.filter(call=>call.route==='/api/generate-reaction').at(-1).options.body.images.length,1);
    await click('#photos-reactions'); await click('[data-preset-id="curious"]'); await click('[data-preset-id="mindblown"]');
    await click('#photos-reactions-done');
    const beforeBatch=usage.filter(id=>id==='photos_preset').length; holdNext=true;
    await click('#photos-generate'); assert.equal(await js(`document.getElementById('photos-generate').disabled`),true);
    await click('#photos-stop-batch'); releaseHeld(); await pause(150);
    assert.equal(usage.filter(id=>id==='photos_preset').length,beforeBatch+1);
    assert.equal(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none');
    await capture('chat-result-desktop');
    // Model menus and the full-height reactions drawer stay in the viewport.
    await click('#photos-model'); await js(`document.getElementById('photos-model-search').value='flux';document.getElementById('photos-model-search').dispatchEvent(new Event('input'))`); assert.equal(await js(`document.querySelectorAll('#photos-model-list [role=option]:not([hidden])').length`),5); await capture('model-menu-desktop'); await js(`document.getElementById('photos-model-menu').hidePopover()`);
    await click('#photos-reactions');
    assert.equal(await js(`document.getElementById('photos-reactions-panel').hidden`),false);
    assert.equal(await js(`document.activeElement.id`),'photos-reactions-close');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await js(`document.getElementById('photos-reactions-panel').hidden`),true);
    assert.equal(await js(`document.activeElement.id`),'photos-reactions');
    for (const windows of [false, true]) for (const [width, height] of [[1000, 740], [600, 500]]) {
      win.setSize(width, height); win.webContents.send('onPlatformInfo', { isMac: !windows, isWindows: windows, isExpanded: false }); await pause(80);
      await click('.nav-item[data-tab="photos"]');
      const bounds = await js(`(()=>{const nav=document.getElementById('sidebar-nav'),foot=document.querySelector('.sidebar-footer').getBoundingClientRect();return {scroll:nav.scrollHeight,available:nav.clientHeight,footerBottom:foot.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,contentOverflow:document.querySelector('.photos-scroll').scrollWidth>document.querySelector('.photos-scroll').clientWidth}})()`);
      assert.equal(bounds.overflow, false, JSON.stringify(bounds)); assert.equal(bounds.contentOverflow, false, JSON.stringify(bounds)); assert.ok(bounds.footerBottom <= bounds.height, JSON.stringify(bounds));
       const actionBounds = await js(`(()=>{const r=document.getElementById('photos-generate').getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,height:innerHeight,width:innerWidth}})()`);
       assert.ok(actionBounds.top >= 0 && actionBounds.bottom <= actionBounds.height && actionBounds.right <= actionBounds.width, JSON.stringify(actionBounds));
       assert.ok(parseFloat(await js(`getComputedStyle(document.getElementById('photos-prompt')).maxHeight`))<=74);
      if (height === 500) assert.ok(bounds.scroll > bounds.available, JSON.stringify(bounds));
      await js(`document.getElementById('sidebar-nav').scrollTop=document.getElementById('sidebar-nav').scrollHeight`);
      const last = await js(`document.querySelector('.nav-item[data-tab="studio-text"]').getBoundingClientRect().bottom <= document.querySelector('.sidebar-footer').getBoundingClientRect().top`); assert.equal(last, true);
      const composerBounds=await js(`(()=>{const r=document.getElementById('photos-composer-dock').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})()`); assert.ok(composerBounds.bottom<=composerBounds.height && composerBounds.top>=38,JSON.stringify(composerBounds));
      await click('#sidebar-toggle-btn'); assert.equal(await js(`document.querySelector('.app-container').classList.contains('sidebar-collapsed')`), true);
      assert.equal(await js(`document.querySelector('.photos-scroll').scrollWidth>document.querySelector('.photos-scroll').clientWidth`),false);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`);
      assert.equal(await js(`document.activeElement.id`), 'tool-search'); assert.equal(await js(`document.querySelector('.app-container').classList.contains('sidebar-collapsed')`), false);
      await js(`(()=>{const input=document.getElementById('tool-search');input.value='reaction';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      assert.equal(await js(`document.querySelectorAll('.channel-group:not(.tool-filter-hidden)').length`), 1);
      await js(`document.getElementById('tool-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
      assert.equal(await js(`document.getElementById('photos-heading').textContent`), 'AI Photos');
      await js(`document.getElementById('tool-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await click('#photos-ratio'); const ratio=await js(`(()=>{const r=document.getElementById('photos-ratio-menu').getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,width:innerWidth,height:innerHeight}})()`); assert.ok(ratio.top>=38 && ratio.bottom<=ratio.height && ratio.right<=ratio.width,JSON.stringify(ratio)); await js(`document.getElementById('photos-ratio-menu').hidePopover()`); await click('#photos-model'); const menu=await js(`(()=>{const r=document.getElementById('photos-model-menu').getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,width:innerWidth,height:innerHeight}})()`); assert.ok(menu.top>=38 && menu.bottom<=menu.height && menu.right<=menu.width,JSON.stringify(menu)); if (!windows) await capture(`models-${width}x${height}`); await js(`document.getElementById('photos-model-menu').hidePopover()`);
      await click('#photos-reactions');
      const panel = await js(`(()=>{const r=document.getElementById('photos-reactions-panel').getBoundingClientRect(), w=document.querySelector('.photo-workspace').getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,height:r.height,workspaceHeight:w.height,width:innerWidth,viewportHeight:innerHeight}})()`);
      assert.ok(panel.top>=38 && panel.bottom<=panel.viewportHeight && panel.right<=panel.width,JSON.stringify(panel));
      assert.ok(Math.abs(panel.height-panel.workspaceHeight)<2,JSON.stringify(panel));
      assert.equal(await js(`document.querySelector('.photo-workspace-main').inert`),true);
      await js(`document.getElementById('photos-reactions-done').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`);
      assert.equal(await js(`document.activeElement.id`),'photos-reactions-close');
      if (!windows) await capture(`reactions-${width}x${height}`);
      await click('#photos-reactions-done');
      assert.equal(await js(`document.querySelector('.photo-workspace-main').inert`),false);
      const refs = await js(`(()=>{const a=document.getElementById('photos-reference-slot').getBoundingClientRect(),b=document.getElementById('photos-reactions').getBoundingClientRect();return {sameRow:Math.abs(a.top-b.top)<2,nonoverlap:a.right<b.left,bottom:b.bottom,height:innerHeight}})()`);
      assert.ok(refs.sameRow && refs.nonoverlap && refs.bottom<=refs.height,JSON.stringify(refs));
    }
    win.setSize(1400,850); await pause(100); await click('#photos-reactions');
    assert.equal(await js(`document.querySelector('.photo-workspace-main').inert`),false);
    assert.equal(await js(`document.getElementById('photos-reactions-panel').getAttribute('aria-modal')`),null);
    const dock=await js(`document.querySelector('.photo-workspace-main').getBoundingClientRect().right<=document.getElementById('photos-reactions-panel').getBoundingClientRect().left`);assert.equal(dock,true);
    await capture('reactions-docked');await click('#photos-reactions-close');
    await click('.channel-group[data-channel-group="library"] .channel-group-toggle');
    await win.reload(); await pause(250); assert.equal(await js(`document.querySelector('[data-channel-group="library"]').classList.contains('channel-folded')`), true);
    await click('.nav-item[data-tab="photos"]'); await click('#photos-new-chat'); await js(`document.getElementById('photos-prompt').value='A sky';document.getElementById('photos-prompt').dispatchEvent(new Event('input'))`);
    rejectNext = true; const before = usage.length; await click('#photos-generate');
    assert.match(await js(`document.getElementById('photos-status').textContent`), /No credits/); assert.notEqual(await js(`getComputedStyle(document.getElementById('photos-status')).display`),'none'); assert.equal(usage.length, before);
    await click('#photos-generate');
    for (const mode of ['free', 'failed-save']) {
      storageMode = mode;
      await click('#photos-new-chat'); await prompt('Storage policy check');
      const beforeGeneration = usage.filter(id => id === 'photos_generate').length;
      await click('#photos-generate');
      assert.equal(usage.filter(id => id === 'photos_generate').length, beforeGeneration + 1);
      assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 1);
      const text = await js(`document.getElementById('photos-status').textContent`);
      assert.match(text, mode === 'free' ? /Save PNG.*paid membership/ : /Cloud history could not save.*Save PNG/);
      await capture('storage-' + mode);
      await click('.photo-result-card button:nth-child(2)');
      assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 1);
      if (mode === 'free') {
        const beforeHistory = usage.length;
        await click('#photos-history-toggle');
        assert.equal(usage.length, beforeHistory);
        assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 0);
        assert.match(await js(`document.getElementById('photos-history-policy').textContent`), /paid membership.*Save PNG/);
        await capture('history-free'); await click('#photos-history-toggle');
      }
    }
    storageMode = 'paid';
    await click('.photo-result-preview'); await setUser(null);
    assert.equal(await js(`document.getElementById('photos-viewer').open`), false); assert.equal(await js(`document.querySelectorAll('.photo-result-card').length`), 0);
    assert.equal(await js(`document.getElementById('photos-prompt').value`), ''); assert.equal(await js(`document.getElementById('photos-signin').classList.contains('hidden')`), false);
    assert.deepEqual(errors, []);
     console.log(`Native composer/reference and reaction row/full-height docked and responsive drawer/local logos/credit estimates/${catalog.IMAGE_MODELS.length} models/generate-edit/reactions/batch stopping/save success-cancel-failure/history/viewer/keyboard/privacy/zero input telemetry/Mac-Windows layouts passed.`);
    win.destroy(); app.quit();
  } catch (error) { console.error(error, lastJs, errors); win.destroy(); app.exit(1); }
});
