// Isolated native renderer fixture. No real accounts, provider grants or analytics.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-google-ui-'));
const captures = process.env.SMOOTHY_REVIEW_DIR || path.resolve(root, '../docs/reviews/smoothyapp-google-sign-in-2026-10-21');
fs.mkdirSync(captures, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile'));
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `
const {contextBridge}=require('electron');
const calls=[],callbacks={};let user=null,google=true,pending;
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>{(callbacks[name]||=[]).push(fn)}:async()=>({})]));
Object.assign(api,{
 getAuthState:async()=>({user}),getAuthProviders:async()=>({google}),
 loginWithGoogle:()=>{calls.push('google');return new Promise(resolve=>{pending=resolve})},
 cancelGoogleSignIn:async()=>{calls.push('cancel');return {success:true}},
 openExternal:async url=>{calls.push(url);return {success:true}},
 getStatus:async()=>({connected:false}),getActiveNLE:async()=>({activeNLE:'premiere'}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.1.1-local-google',
 getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 getStudioCredits:async()=>({success:true,credits:{tier:'free',credits:100,totalCredits:100,creditsUsed:0,percentage:100,daysRemaining:30}}),
 __calls:()=>calls,__provider:value=>{google=value},__complete:(success,verified=true)=>{if(success)user={id:'fixture',email:'editor@example.test',name:'Editor',tier:'free',emailVerified:verified};pending?.({success,error:success?undefined:'Google sign-in was canceled.'});pending=null},
 __reset:()=>{user=null;for(const fn of callbacks.onAuthStateChange||[])fn({user:null})}
});contextBridge.exposeInMainWorld('electronAPI',api);
`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
 session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
 const win = new BrowserWindow({ width:1000, height:780, show:false, webPreferences:{ preload, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } });
 const js = code => win.webContents.executeJavaScript(code);
 const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
 const visible = id => js(`!!document.getElementById(${JSON.stringify(id)}).getClientRects().length`);
 const capture = async name => fs.writeFileSync(path.join(captures, name+'.png'), (await win.webContents.capturePage()).toPNG());
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'&&!event.message.includes('ERR_BLOCKED_BY_CLIENT'))errors.push(event.message)});
 try {
  await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(500);
  await win.webContents.insertCSS('* { animation:none !important; transition:none !important; }');win.showInactive();
  await click('login-btn');await pause(80);
  assert.equal(await visible('account-google-btn'),true);
  assert.equal(await js(`document.getElementById('account-google-btn').disabled`),false);
  assert.equal(await js(`document.getElementById('account-google-btn').querySelector('img').naturalWidth>0`),true);
  await capture('sign-in-desktop');
  await click('account-header-switch');await pause(30);
  assert.equal(await visible('signup-confirm-group'),true);await capture('sign-up-desktop');
  await click('account-header-switch');
  await click('account-password-toggle');assert.equal(await js(`document.getElementById('login-password').type`),'text');
  await click('account-password-toggle');assert.equal(await js(`document.getElementById('login-password').type`),'password');
  await click('account-forgot-password');assert.ok((await js(`window.electronAPI.__calls()`)).includes('https://smoothyedit.com/forgot-password'));
  await click('account-google-btn');await pause(30);assert.equal(await visible('account-google-waiting'),true);assert.equal(await visible('login-form'),false);await capture('browser-waiting');
  await click('account-google-cancel');await pause(30);assert.equal(await visible('login-form'),true);assert.ok((await js(`window.electronAPI.__calls()`)).includes('cancel'));
  // A late result from the canceled request must not close the reopened dialog.
  await js(`window.electronAPI.__complete(false)`);await pause(30);assert.equal(await visible('login-modal'),true);assert.equal(await visible('login-error'),false);
  await click('account-google-btn');await pause(10);await js(`window.electronAPI.__complete(false)`);await pause(30);assert.equal(await visible('login-error'),true);assert.equal(await visible('login-form'),true);
  await click('account-google-btn');await pause(10);await js(`window.electronAPI.__complete(true)`);await pause(80);assert.equal(await visible('login-modal'),false);assert.equal(await visible('user-info'),true);
  await js(`window.electronAPI.__reset()`);await click('login-btn');await pause(40);
  await click('account-google-btn');await pause(10);await click('login-close-btn');await js(`window.electronAPI.__complete(false)`);await pause(20);assert.equal(await visible('login-modal'),false);
  for(const [width,height] of [[600,500],[1000,780]]) {
   win.setSize(width,height);await pause(40);await click('login-btn');await pause(40);
   const bounds=await js(`(()=>{const r=document.querySelector('.login-modal').getBoundingClientRect(),b=document.getElementById('account-header-switch').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,signupVisible:b.top>=0&&b.bottom<=innerHeight}})()`);
   assert.ok(bounds.top>=0&&bounds.bottom<=bounds.height&&bounds.signupVisible,JSON.stringify(bounds));
   await capture('sign-in-'+width);await click('account-header-switch');await pause(20);assert.equal(await visible('signup-confirm-group'),true);await capture('sign-up-'+width);await click('login-close-btn');
  }
  await js(`window.electronAPI.__provider(false)`);await click('login-btn');await pause(40);
  assert.equal(await js(`document.getElementById('account-google-btn').disabled`),true);assert.equal(await visible('login-form'),true);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS: native Google availability, local icon, clear signup, password toggle/recovery, browser wait/cancel, late result, errors, successful return, close, and minimum 600×500 window. No production requests or usage events.');
  win.destroy();app.exit(0);
 } catch(error) { console.error(error,errors);win.destroy();app.exit(1); }
});
app.once('will-quit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
