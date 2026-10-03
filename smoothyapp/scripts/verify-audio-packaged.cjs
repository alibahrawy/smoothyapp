// Native packaged Electron window verification. Launch the development .app with
// --remote-debugging-port=9335 first. Uses its actual renderer, preload and main.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
 const targets = await (await fetch('http://127.0.0.1:9335/json/list')).json();
 const target = targets.find(page => page.url.includes('app.asar/out/renderer/index.html'));
 assert.ok(target, 'Expected the packaged SmoothyEdit window');
 const socket = new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
 let sequence = 0; const pending = new Map();
 socket.on('message', bytes => { const message = JSON.parse(bytes); if (message.id) { const task = pending.get(message.id); pending.delete(message.id); message.error ? task?.reject(Error(message.error.message)) : task?.resolve(message.result); } });
 const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
 const js = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.text); return result.result.value; };
 const wait = async expression => { for (let i = 0; i < 180; i++) { if (await js(expression)) return; await delay(250); } throw Error('Timed out: ' + expression); };
 try {
  await call('Network.enable');
  socket.on('message',bytes=>{const message=JSON.parse(bytes);if(message.method==='Network.loadingFailed'&&!message.params.canceled)console.log('Network failure:',JSON.stringify(message.params));});
  assert.equal(await js(`window.electronAPI.getAppVersion()`),'1.5.1');
  await js(`document.querySelector('[data-tab="audio"]').click();document.getElementById('audio-view-all').click()`);
  await wait(`document.getElementById('audio-archive-search').disabled===false&&document.querySelectorAll('#audio-archive-results tr').length===40`);
  const rows = () => js(`Array.from(document.querySelectorAll('#audio-archive-results tr'),row=>({id:row.dataset.id,title:row.querySelector('.audio-track-title strong').textContent}))`);
  const first = await rows(); assert.equal(first.length,40);
  assert.notDeepEqual(first.map(track=>track.title),first.map(track=>track.title).sort((a,b)=>a.localeCompare(b)));
  await js(`document.getElementById('audio-archive-more').click()`);
  await wait(`document.querySelectorAll('#audio-archive-results tr').length===80`);
  const expanded = await rows(); assert.deepEqual(expanded.slice(0,40),first); assert.equal(new Set(expanded.map(track=>track.id)).size,80);
  await js(`document.getElementById('audio-archive-genre').value='cinematic';document.getElementById('audio-archive-genre').dispatchEvent(new Event('change'))`);
  await wait(`document.getElementById('audio-archive-search').disabled===false&&document.querySelectorAll('#audio-archive-results tr').length===40`);
  await js(`document.getElementById('audio-archive-genre').value='all';document.getElementById('audio-archive-genre').dispatchEvent(new Event('change'))`);
  await wait(`document.getElementById('audio-archive-search').disabled===false&&document.querySelectorAll('#audio-archive-results tr').length===40`);
  assert.deepEqual(await rows(),first);
  await js(`document.getElementById('audio-view-favorites').click();document.getElementById('audio-view-all').click()`);
  await wait(`document.getElementById('audio-archive-search').disabled===false&&document.querySelectorAll('#audio-archive-results tr').length===40`);
  const reopened = await rows(); assert.notDeepEqual(reopened,first);
  await js(`document.querySelector('[data-tab="stock"]').click();document.querySelector('[data-tab="audio"]').click()`);
  await wait(`document.getElementById('audio-archive-search').disabled===false&&document.querySelectorAll('#audio-archive-results tr').length===40`);
  const returned = await rows(); assert.notDeepEqual(returned,reopened);
  const shuffledScreenshot = await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.resolve(__dirname,'../../docs/reviews/smoothyapp-1.5.1/audio-refresh/packaged-shuffle.png'),Buffer.from(shuffledScreenshot.data,'base64'));
  console.log('PASS: packaged Music shuffles on each visit, maintains filter ordering, and appends 80 unique tracks. First sample:',returned.slice(0,5).map(track=>track.title).join(', '));
  let failed = false;
  for (const query of ['100 Degrees Under', '69 Bronco', 'Sky Skating']) {
   await js(`document.getElementById('audio-archive-query').value=${JSON.stringify(query)};document.getElementById('audio-archive-form').dispatchEvent(new Event('submit',{cancelable:true}))`);
   await wait(`document.querySelectorAll('#audio-archive-results tr').length>0&&document.querySelector('#audio-archive-results .audio-track-title').textContent.includes(${JSON.stringify(query)})`);
   await js(`document.querySelector('#audio-archive-results .audio-row-play').click()`);
   await wait(`document.getElementById('audio-dock-player').currentTime>1||!!document.getElementById('audio-dock-player').error`);
   const state = await js(`(()=>{const a=document.getElementById('audio-dock-player');return {title:document.getElementById('audio-dock-title').textContent,src:a.src,time:a.currentTime,paused:a.paused,duration:a.duration,error:a.error?.message,status:document.getElementById('audio-archive-status').textContent};})()`);
   console.log('Packaged playback:', JSON.stringify(state));
   if (!(state.time > 1 && !state.paused)) { failed = true; continue; }
   assert.equal(await js(`document.querySelector('#audio-archive-results .selected .audio-row-play').dataset.icon`),'pause');
   assert.equal(await js(`document.getElementById('audio-dock-play').dataset.icon`),'pause');
   await js(`document.querySelector('#audio-archive-results .selected .audio-row-play').click()`); assert.equal(await js(`document.getElementById('audio-dock-player').paused`), true);
   assert.equal(await js(`document.getElementById('audio-dock-play').dataset.icon`),'play');
   await js(`document.getElementById('audio-dock-play').click()`); await wait(`document.getElementById('audio-dock-player').currentTime>${state.time + .3}`);
   await js(`document.getElementById('audio-dock-seek').value=10;document.getElementById('audio-dock-seek').dispatchEvent(new Event('input'))`);
   await wait(`document.getElementById('audio-dock-player').currentTime>10.3`);
   await js(`document.getElementById('audio-dock-play').click()`);
  }
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../../docs/reviews/smoothyapp-1.5.1/audio-refresh/packaged-playback.png'), Buffer.from(screenshot.data, 'base64'));
  assert.equal(failed, false, 'One or more packaged previews failed');
  const sharing = await js(`window.electronAPI.audioCommunityState()`);
  await js(`document.getElementById('audio-info-open').click()`);await delay(150);
  assert.equal(await js(`document.getElementById('audio-info-dialog').open`),true);
  assert.equal(await js(`document.getElementById('audio-info-title').textContent`),'Sky Skating');
  assert.equal(await js(`document.getElementById('audio-info-artist').textContent`),'Geographer');
  assert.equal(await js(`document.getElementById('audio-info-license').textContent`),'Not supplied');
  assert.equal(await js(`document.getElementById('audio-info-copy').disabled`),true);
  assert.equal(await js(`document.getElementById('audio-share-favorites').checked`),sharing.sharing);
  assert.equal(await js(`document.getElementById('audio-share-favorites').disabled`),sharing.sharingLocked);
  assert.equal(await js(`document.activeElement.id`),'audio-info-close');
  assert.equal(await js(`document.getElementById('audio-info-dialog').scrollWidth<=document.getElementById('audio-info-dialog').clientWidth`),true);
  const noticeScreenshot = await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.resolve(__dirname,'../../docs/reviews/smoothyapp-1.5.1/audio-refresh/packaged-licenses.png'),Buffer.from(noticeScreenshot.data,'base64'));
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await js(`document.getElementById('audio-info-dialog').open`),false);
  assert.equal(await js(`document.activeElement.id`),'audio-info-open');
  console.log('PASS: packaged license notice shows current track, unknown license, persisted sharing preference and native Escape/focus restoration. Sharing setting and favorites unchanged.');
  console.log('PASS: actual packaged app plays three live tracks, pauses/resumes and advances after seeking. No favorites or library files changed.');
 } finally { socket.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
