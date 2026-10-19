import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), bundled = { exports: {} };
const output = await build({ entryPoints: [fileURLToPath(new URL('../src/main/resolve/handoff.ts', import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false });
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, bundled, bundled.exports);
const { createResolveHandoff, sendToSmoothyScript, luaString, resolveScriptDirectory, readHandoffReceipt, readSnapshotPacket } = bundled.exports;
const snapshotModule = { exports: {} };
const snapshotOutput = await build({ entryPoints: [fileURLToPath(new URL('../src/main/resolve/snapshot.ts', import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false });
new Function('require', 'module', 'exports', snapshotOutput.outputFiles[0].text)(require, snapshotModule, snapshotModule.exports);
const { snapshotToXml } = snapshotModule.exports;
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-handoff-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) assert.fail('Timed out waiting for the handoff'); await pause(10); } }
function fixture(name, receive, changed = () => {}) {
  const directory = path.join(scratch, name, 'handoff'), scriptDirectory = path.join(scratch, name, 'Scripts');
  return { directory, incoming: path.join(directory, 'timeline.xml'), scriptDirectory,
    helper: createResolveHandoff({ directory, scriptDirectory, receive, changed, delay: 20 }) };
}
test('Lua helper uses only Resolve native XML export and safely quotes spaces, Unicode and delimiters', () => {
  const destination = 'C:\\Users\\A ]]==] علي\\timeline.xml';
  const source = sendToSmoothyScript(destination);
  assert.match(source, /timeline:Export\(destination, host.EXPORT_FCP_7_XML\)/);
  assert.equal(source.includes(destination.replace(/\\/g, '/')), true);
  assert.match(luaString('x]]y]=]z'), /^\[==\[/);
  assert.doesNotMatch(source, /\bio\.|\brequire\(|os\.execute|scriptapp|socket|StartRendering|SaveProject/);
});
test('script installation is repeatable, profile-scoped and does not overwrite unrelated scripts', () => {
  const f = fixture('install', () => false); f.helper.start();
  try {
    const first = f.helper.install(); assert.equal(first.installed, true);
    assert.equal(fs.readFileSync(first.scriptPath, 'utf8'), sendToSmoothyScript(f.incoming));
    assert.equal(f.helper.install().installed, true);
    fs.writeFileSync(first.scriptPath, '-- user script');
    assert.throws(() => f.helper.install(), /different/);
    assert.equal(fs.readFileSync(first.scriptPath, 'utf8'), '-- user script');
  } finally { f.helper.close(); }
});
test('platform locations use the vendor documented per-user scripts folder', () => {
  assert.equal(resolveScriptDirectory('win32', 'profile', 'home'), path.join('profile', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility'));
  assert.equal(resolveScriptDirectory('darwin', 'profile', 'home'), path.join('profile', 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts', 'Utility'));
  assert.equal(resolveScriptDirectory('linux', 'profile', 'home'), path.join('home', '.local', 'share', 'DaVinciResolve', 'Fusion', 'Scripts', 'Utility'));
});
test('new exports automatically arrive once, repeated watcher events do not duplicate imports, other XML is ignored', async () => {
  const received = [];
  const f = fixture('receive', file => { received.push(fs.readFileSync(file, 'utf8')); return true; });
  f.helper.start();
  try {
    fs.writeFileSync(path.join(f.directory, 'unrelated.xml'), '<private/>'); await pause(80); assert.equal(received.length, 0);
    fs.writeFileSync(f.incoming, '<first/>'); await until(() => received.length === 1);
    fs.writeFileSync(f.incoming, '<first/>'); await pause(100); assert.equal(received.length, 1);
    fs.writeFileSync(f.incoming, '<second/>'); await until(() => received.length === 2);
    assert.deepEqual(received, ['<first/>', '<second/>']); assert.equal(f.helper.snapshot().received, true);
  } finally { f.helper.close(); }
});
test('busy jobs queue incoming XML and close stops the watcher', async () => {
  let busy = true, received = 0;
  const f = fixture('busy', () => { if (busy) return false; received++; return true; });
  f.helper.start();
  fs.writeFileSync(f.incoming, '<queued/>'); await pause(100); assert.equal(received, 0);
  busy = false; await until(() => received === 1);
  f.helper.close(); fs.writeFileSync(f.incoming, '<closed/>'); await pause(100);
  assert.equal(received, 1); assert.equal(f.helper.snapshot().watching, false);
});
test('partial or invalid exports cannot replace a loaded source and a later valid export recovers', async () => {
  let loaded = 'previous', errors = [];
  const f = fixture('partial', file => { const value = fs.readFileSync(file, 'utf8'); if (!value.endsWith('</xmeml>')) throw Error('Incomplete XML'); loaded = value; return true; }, status => { if (status.error) errors.push(status.error); });
  f.helper.start();
  try {
    fs.writeFileSync(f.incoming, '<xmeml>partial'); await until(() => errors.length > 0);
    assert.equal(loaded, 'previous');
    fs.writeFileSync(f.incoming, '<xmeml>valid</xmeml>'); await until(() => loaded.includes('valid'));
    assert.equal(f.helper.snapshot().error, '');
  } finally { f.helper.close(); }
});

function runHelperInLua(before, assertions) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const destination = 'C:\\Users\\Example space\\timeline.xml';
  const setup = `
io=nil;os=nil;package=nil;require=nil;print=function()end
local values={};local writes={};local factoryCalls=0;local didExport=false
local preferences={GetPrefs=function(self,key)return values[key]end,SetPrefs=function(self,key,value)values[key]=value;writes[#writes+1]=value end,SavePrefs=function()return true end}
local timeline={Export=function(self,file,kind)assert(file==${luaString(destination.replace(/\\/g, '/'))});assert(kind==42);didExport=true;return true end}
local project={GetCurrentTimeline=function()return timeline end}
local manager={GetCurrentProject=function()return project end}
local fixture={GetProjectManager=function()return manager end,Fusion=function()return preferences end,EXPORT_FCP_7_XML=42,EXPORT_NONE=0}
Resolve=function()factoryCalls=factoryCalls+1;return fixture end
fusion=preferences
${before}
`;
  try {
    const status = lauxlib.luaL_dostring(L, to_luastring(setup + sendToSmoothyScript(destination) + '\n' + assertions));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    lua.lua_getglobal(L, to_luastring('testSnapshot'));
    return lua.lua_isstring(L, -1) ? to_jsstring(lua.lua_tostring(L, -1)) : null;
  } finally { lua.lua_close(L); }
}
test('actual Lua execution initializes Resolve through the vendor factory when the global is absent', () => {
  runHelperInLua('resolve=nil', `assert(factoryCalls==1);assert(didExport);assert(values["Global.SmoothyEditHandoffV2"]=="2|1|exported|ok")`);
});
test('actual Lua execution recovers from a stale host global and does not call the factory for a working host', () => {
  runHelperInLua('resolve={}', 'assert(factoryCalls==1);assert(didExport)');
  runHelperInLua('resolve=fixture', 'assert(factoryCalls==0);assert(didExport)');
});
test('actual Lua execution reports missing host, project, timeline and unavailable fallback getters', () => {
  for (const [before, code] of [
    ['resolve=nil;Resolve=function()return nil end', 'noResolve'],
    ['manager.GetCurrentProject=function()return nil end', 'noProject'],
    ['project.GetCurrentTimeline=function()return nil end', 'noTimeline'],
    ['fixture.EXPORT_FCP_7_XML=nil', 'snapshotFailed'],
    ['timeline.Export=function()return false end', 'snapshotFailed'],
    ['timeline.Export=function()error("native export failed")end', 'snapshotFailed']
  ]) runHelperInLua(before, `assert(not didExport);assert(values["Global.SmoothyEditHandoffV2"]=="2|1|failed|${code}")`);
});
test('Lua feedback carries a fresh attempt ID and preference failures do not prevent native export', () => {
  runHelperInLua('values["Global.SmoothyEditHandoffV2"]="2|7|failed|noTimeline"', `assert(values["Global.SmoothyEditHandoffV2"]=="2|8|exported|ok")`);
  runHelperInLua('preferences.SavePrefs=function()error("preferences locked")end', 'assert(didExport)');
});

test('Lua export uses a bounded subtype fallback and stops after success', () => {
  runHelperInLua('local calls=0;timeline.Export=function(self,file,kind,subtype)calls=calls+1;assert(file=="C:/Users/Example space/timeline.xml");if subtype==nil then return false end;assert(subtype==0);didExport=true;return true end', 'assert(calls==2);assert(didExport)');
  runHelperInLua('local calls=0;timeline.Export=function()calls=calls+1;return true end', 'assert(calls==1)');
  runHelperInLua('local calls=0;timeline.Export=function()calls=calls+1;return false end', 'assert(calls==2);assert(values["Global.SmoothyEditHandoffV2"]=="2|1|failed|snapshotFailed")');
  runHelperInLua('timeline.Export=function(self,file,kind,subtype)if subtype==nil then error("argument count") end;didExport=true;return true end', 'assert(didExport)');
});

function sourceSnapshot() {
  const source = path.join(scratch, 'Interview & علي.wav');
  const clip = { name: 'Interview & علي', path: source, fps: 25, start: 90010, finish: 90100, left: 23,
    sourceStart: 23, sourceEnd: 113, enabled: true, speed: { Percentage: 100 }, fusion: 0,
    mapping: JSON.stringify({ embedded_audio_channels: 2, linked_audio: {}, track_mapping: { '1': { type: 'Mono', channel_idx: [2], mute: false } } }) };
  return { version: 1, name: 'Podcast', fps: 25, origin: 90000, finish: 90125, timecode: '01:00:00:00', width: 1920, height: 1080,
    video: { '1': { name: 'Cam 1', enabled: true, clips: { '1': { ...clip } } }, '2': { name: 'Cam 2', enabled: true, clips: { '1': { ...clip, sourceStart: 24, sourceEnd: 114 } } } },
    audio: { '1': { name: 'Mic 2', enabled: true, clips: { '1': { ...clip } } } } };
}

test('source snapshot reconstructs offsets, timecode, names, enablement and the isolated native channel', () => {
  const input = sourceSnapshot(), xml = snapshotToXml(input);
  assert.match(xml, /<name>Interview &amp; علي<\/name>/);
  assert.match(xml, /<start>10<\/start><end>100<\/end><in>23<\/in><out>113<\/out>/);
  assert.match(xml, /<timecode>.*<string>01:00:00:00<\/string><frame>90000<\/frame>/);
  assert.match(xml, /<mediatype>audio<\/mediatype><trackindex>2<\/trackindex>/);
  assert.match(xml, /<lognote>smoothy-source-snapshot-v1<\/lognote>/);
  input.audio['1'].clips['1'].mapping = input.audio['1'].clips['1'].mapping.replace('"mute":false', '"mute":true');
  assert.match(snapshotToXml(input), /<name>Interview &amp; علي<\/name><enabled>FALSE<\/enabled>/);
});

test('snapshot AV references share a complete source definition with native source duration and local FCP7 URL',()=>{
  const input=sourceSnapshot();input.video['1'].clips['1'].frames='1000';input.video['1'].clips['1'].timecode='00:00:00:00';
  const {DOMParser}=require('@xmldom/xmldom');const doc=new DOMParser().parseFromString(snapshotToXml(input),'text/xml');
  const files=Array.from(doc.getElementsByTagName('file'));
  const definitions=files.filter(f=>f.getElementsByTagName('pathurl').length);
  assert.equal(definitions.length,1);const f=definitions[0];
  assert.equal(f.getElementsByTagName('duration')[0].textContent,'1000');
  assert.match(f.getElementsByTagName('pathurl')[0].textContent,/^file:\/\/localhost\//);
  assert.equal(f.getElementsByTagName('video').length,1);assert.equal(f.getElementsByTagName('audio').length,1);
  assert.equal(new Set(files.map(f=>f.getAttribute('id'))).size,1);
  assert.equal(f.getElementsByTagName('timecode')[0].getElementsByTagName('string')[0].textContent,'00:00:00:00');
  assert.equal(f.getElementsByTagName('video')[0].getElementsByTagName('duration')[0].textContent,'1000');
  for(const item of Array.from(doc.getElementsByTagName('clipitem')))assert.equal(item.getElementsByTagName('duration')[0].textContent,'1000');
});

test('a normalized source snapshot can be cut and normalized again with Resolve-compatible file ordering',async()=>{
 const output=await build({entryPoints:[fileURLToPath(new URL('../src/main/resolve/timeline.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
 const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(require,mod,mod.exports);
 const input=sourceSnapshot();input.video['1'].clips['1'].frames='1000';input.video['1'].clips['1'].timecode='00:00:00:00';
 const {parseResolveTimeline,renderResolveMulticam}=mod.exports;
 const xml=renderResolveMulticam(parseResolveTimeline(snapshotToXml(input)),[0,1],[{startFrame:0,endFrame:50,trackIndex:0},{startFrame:50,endFrame:125,trackIndex:1}]);
 assert.match(xml,/^<\?xml version="1.0" encoding="UTF-8"\?>\n/);
 assert.match(xml,/<file id="[^"]+">\n<duration>1000<\/duration>\n<rate>/);
 assert.equal(parseResolveTimeline(xml).audioTracks[0].clips[0].sourceIn,23);
 assert.equal(parseResolveTimeline(xml).videoTracks.every(t=>t.clips.length>0),true);
});

test('source snapshot refuses ambiguous timing, retiming, unsupported audio and missing native fields', () => {
  const mutations = [
    x => { x.audio['1'].clips['1'].sourceEnd = 0; },
    x => { x.audio['1'].clips['1'].left = 0.5; },
    x => { x.video['1'].clips['1'].speed.Percentage = 200; },
    x => { x.video['1'].clips['1'].fps = 24; },
    x => { x.video['1'].clips['1'].path = ''; },
    x => { x.video['1'].clips['1'].fusion = 1; },
    x => { delete x.video['1'].clips['1'].speed; },
    x => { x.audio['1'].clips['1'].mapping = '{}'; },
    x => { const m=JSON.parse(x.audio['1'].clips['1'].mapping);m.track_mapping['1'].type='Stereo';m.track_mapping['1'].channel_idx=[1,2];x.audio['1'].clips['1'].mapping=JSON.stringify(m); },
    x => { const m=JSON.parse(x.audio['1'].clips['1'].mapping);m.linked_audio={'1':{path:'external.wav',offset:200}};x.audio['1'].clips['1'].mapping=JSON.stringify(m); },
    x => { x.video['1'].clips['2'] = {...x.video['1'].clips['1']}; },
    x => { x.finish = x.origin; }
  ];
  for (const change of mutations) { const x = sourceSnapshot(); change(x); assert.throws(() => snapshotToXml(x)); }
});

test('actual restricted Lua sends a bounded source packet when native XML export refuses', () => {
  const input = sourceSnapshot(), clip = input.audio['1'].clips['1'];
  const packet = runHelperInLua(`
timeline.Export=function()return false end
timeline.GetName=function()return ${luaString(input.name)} end
timeline.GetStartFrame=function()return 90000 end;timeline.GetEndFrame=function()return 90125 end
timeline.GetStartTimecode=function()return "01:00:00:00" end
timeline.GetSettings=function()return {timelineFrameRate=25,timelineResolutionWidth=1920,timelineResolutionHeight=1080}end
timeline.GetTrackCount=function(self,kind)return kind=="video" and 2 or 1 end
timeline.GetTrackName=function(self,kind,index)return kind .. index end
timeline.GetIsTrackEnabled=function()return true end
local media={GetClipProperty=function()return {["File Path"]=${luaString(clip.path)},FPS=25}end}
local item={GetName=function()return ${luaString(clip.name + '\n"slash\\')}end,GetStart=function()return 90010 end,GetEnd=function()return 90100 end,
GetLeftOffset=function()return 23 end,GetSourceStartFrame=function()return 23 end,GetSourceEndFrame=function()return 113 end,
GetClipEnabled=function()return true end,GetMediaPoolItem=function()return media end,GetSpeed=function()return {Percentage=100}end,
GetFusionCompCount=function()return 0 end,GetSourceAudioChannelMapping=function()return ${luaString(clip.mapping)} end}
timeline.GetItemListInTrack=function()return {item} end
`, 'assert(values["Global.SmoothyEditHandoffV2"]=="2|1|snapshot|ok");testSnapshot=values["Global.SmoothyEditSnapshotV1"]');
  assert.ok(packet.startsWith('1|'));
  const value = JSON.parse(Buffer.from(packet.split('|')[1], 'hex').toString('utf8'));
  assert.equal(value.audio['1'].clips['1'].name, clip.name + '\n"slash\\');
  assert.equal(value.audio['1'].clips['1'].mapping, clip.mapping);
  assert.equal(value.video['2'].clips['1'].left, 23);
  // XML names reject C0 controls instead of writing malformed files. Test JSON transport independently.
  value.audio['1'].clips['1'].name = clip.name;
  value.video['1'].clips['1'].name = clip.name; value.video['2'].clips['1'].name = clip.name;
  assert.match(snapshotToXml(value), /<in>23<\/in>/);
});

test('source packet is attempt-bound, decoded without evaluating prefs, queued while busy and failed imports retain input', async () => {
  const directory = path.join(scratch, 'snapshot-receive'), profiles = path.join(directory, 'Profiles'), profile = path.join(profiles, 'Default');
  fs.mkdirSync(profile, { recursive: true });
  const prefs = path.join(profile, 'Fusion.prefs');
  const write = (serial, input, payloadSerial = serial) => fs.writeFileSync(prefs, `Global={ Unrelated="private", SmoothyEditHandoffV2="2|${serial}|snapshot|ok", SmoothyEditSnapshotV1="${payloadSerial}|${Buffer.from(JSON.stringify(input)).toString('hex')}" }`);
  let busy = true, loaded = 'previous', imports = 0;
  const helper = createResolveHandoff({ directory: path.join(directory, 'handoff'), scriptDirectory: path.join(directory, 'Scripts'), preferencesDirectory: profiles,
    receiptInterval: 10, receive: (file, source) => { if (busy) return false; assert.equal(source, 'snapshot'); loaded = fs.readFileSync(file, 'utf8'); imports++; return true; } });
  helper.start();
  try {
    write(1, sourceSnapshot()); await pause(80); assert.equal(loaded, 'previous');
    busy = false; await until(() => imports === 1); assert.match(loaded, /source-snapshot/); assert.equal(helper.snapshot().phase, 'received');
    await pause(80); assert.equal(imports, 1);
    write(2, sourceSnapshot(), 1); await until(() => helper.snapshot().phase === 'failed');
    assert.match(helper.snapshot().error, /matching/); assert.equal(imports, 1); assert.equal(JSON.stringify(helper.snapshot()).includes('private'), false);
    assert.throws(() => readSnapshotPacket(prefs, '2'), /matching/);
    write(3, { ...sourceSnapshot(), fps: 0 }); await until(() => /frame rate/.test(helper.snapshot().error)); assert.equal(imports, 1);
    write(4, sourceSnapshot()); await until(() => imports === 2);
  } finally { helper.close(); }
});
test('Smoothy reports a no-response timeout, then reads only its own native diagnostic receipt', async () => {
  const directory = path.join(scratch, 'diagnostics'), profiles = path.join(directory, 'Profiles'), profile = path.join(profiles, 'Default');
  fs.mkdirSync(profile, { recursive: true });
  const prefs = path.join(profile, 'Fusion.prefs');
  fs.writeFileSync(prefs, 'Global = { Unrelated = "private", SmoothyEditHandoffV2 = "2|1|failed|noTimeline" }');
  const helper = createResolveHandoff({ directory: path.join(directory, 'handoff'), scriptDirectory: path.join(directory, 'Scripts'), preferencesDirectory: profiles,
    receiptInterval: 10, responseTimeout: 50, receive: () => true });
  helper.start();
  try {
    helper.waitForHelper(); await until(() => helper.snapshot().phase === 'unresponsive');
    assert.match(helper.snapshot().error, /No response/);
    fs.writeFileSync(prefs, 'Global = { Unrelated = "private", SmoothyEditHandoffV2 = "2|2|failed|noTimeline" }');
    await until(() => helper.snapshot().phase === 'failed');
    assert.match(helper.snapshot().error, /no timeline/i);
    assert.equal(JSON.stringify(helper.snapshot()).includes('private'), false);
    assert.equal(readHandoffReceipt(profiles).code, 'noTimeline');
    fs.writeFileSync(prefs, 'Global = { SmoothyEditHandoffV2 = "2|3|exported|ok" }');
    await until(() => helper.snapshot().phase === 'exported'); assert.equal(helper.snapshot().error, '');
  } finally { helper.close(); }
});
