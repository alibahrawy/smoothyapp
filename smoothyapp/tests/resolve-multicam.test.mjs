import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
async function moduleAt(relative) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', output.outputFiles[0].text)(require, module, module.exports, fileURLToPath(new URL('../src/main', import.meta.url)));
  return module.exports;
}
const { parseResolveTimeline, resolveTimelineInfo, renderResolveMulticam, renderResolveSilence } = await moduleAt('../src/main/resolve/timeline.ts');
const { createResolveService } = await moduleAt('../src/main/resolve/service.ts');
const { renderResolveMicrophone } = await moduleAt('../src/main/resolve/audio.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const media = path.join(scratch, 'source with space.wav'); fs.writeFileSync(media, 'fixture');
const rate = '<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>';
const file = `<file id="f1"><name>Source</name><pathurl>${pathToFileURL(media).href}</pathurl><duration>200</duration>${rate}</file>`;
const clip = (id, kind = 'video', channel = 1, extra = '', reference = false) => `<clipitem id="${id}"><name>${id} &amp; source</name>${rate}<start>0</start><end>100</end><in>25</in><out>125</out>${reference ? '<file id="f1"/>' : file}<sourcetrack><mediatype>${kind}</mediatype><trackindex>${channel}</trackindex></sourcetrack>${extra}</clipitem>`;
const xml = `<?xml version="1.0"?><!DOCTYPE xmeml><xmeml version="5"><sequence id="original"><name>Interview</name><duration>100</duration>${rate}<timecode>${rate}<string>01:00:00:00</string><frame>90000</frame></timecode><media><video><format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format><track>${clip('cam1')}<enabled>TRUE</enabled></track><track>${clip('cam2', 'video', 1, '', true)}</track><track>${clip('overlay', 'video', 1, '', true)}</track></video><audio><track>${clip('mic1', 'audio', 1, '', true)}</track><track>${clip('mic2', 'audio', 2, '', true)}</track></audio></media></sequence></xmeml>`;
const ranges = [{ startFrame: 0, endFrame: 50, trackIndex: 0 }, { startFrame: 50, endFrame: 100, trackIndex: 1 }];
test('Resolve export reads shared file references, source offsets, timebase and stereo microphone channels', () => {
  const timeline = parseResolveTimeline(xml), info = resolveTimelineInfo(timeline);
  assert.equal(info.name, 'Interview'); assert.equal(info.fps, 25); assert.equal(info.duration, 4);
  assert.equal(info.videoTracks[1].clips[0].path, media);
  assert.equal(info.audioTracks[1].clips[0].channel, 2);
  assert.equal(info.audioTracks[1].clips[0].inPoint, 1);
  assert.equal(info.capabilities.live, false);
  assert.equal(JSON.stringify(info).includes('ownerDocument'), false);
});
test('exact winner/reverse cuts preserve source timing, unselected overlay, full audio and start timecode', () => {
  const source = parseResolveTimeline(xml), output = renderResolveMulticam(source, [0, 1], ranges), result = parseResolveTimeline(output);
  assert.equal(source.xml, xml);
  assert.equal(result.name, 'Interview - Auto-Switch');
  assert.deepEqual(result.videoTracks[1].clips.map(c => [c.name, c.start, c.end, c.inPoint, c.outPoint]), [
    ['cam1 & source', 0, 2, 1, 3], ['cam2 & source', 2, 4, 3, 5]
  ]);
  assert.deepEqual(result.videoTracks[0].clips.map(c => c.name), ['cam2 & source', 'cam1 & source']);
  assert.deepEqual(result.videoTracks[2].clips.map(c => [c.name, c.start, c.end]), [['overlay & source', 0, 4]]);
  assert.deepEqual(result.audioTracks.map(t => t.clips.map(c => [c.name, c.start, c.end, c.inPoint, c.channel])), source.audioTracks.map(t => t.clips.map(c => [c.name, c.start, c.end, c.inPoint, c.channel])));
  assert.match(output, /01:00:00:00/); assert.match(output, /90000/);
  assert.equal(new Set([...output.matchAll(/<clipitem id="([^"]+)"/g)].map(m => m[1])).size, 7);
});
test('three cameras retain every alternate and sparse original track placement', () => {
  const timeline = parseResolveTimeline(xml);
  const result = parseResolveTimeline(renderResolveMulticam(timeline, [0, 2, 1], [
    { startFrame: 0, endFrame: 25, trackIndex: 2 }, { startFrame: 25, endFrame: 100, trackIndex: 1 }
  ]));
  assert.deepEqual(result.videoTracks[2].clips.map(c => c.name), ['overlay & source', 'cam2 & source']);
  assert.equal(result.audioTracks[0].clips.length, 1);
});

test('snapshot Multicam and silence XML retain complete source definitions after cuts replace the defining clip',()=>{
  const snapshot=xml.replace('<name>Interview</name>','<name>Interview</name><logginginfo><lognote>smoothy-source-snapshot-v1</lognote></logginginfo>');
  const original=parseResolveTimeline(snapshot);
  for(const output of [renderResolveMulticam(original,[0,1],ranges),renderResolveSilence(original,[{start:1,end:3}])]){
    assert.equal((output.match(/<pathurl>/g)||[]).length,1);
    assert.match(output,/<pathurl>file:\/\/localhost\//);
    const parsed=parseResolveTimeline(output);
    for(const track of [...parsed.videoTracks,...parsed.audioTracks])for(const clip of track.clips)assert.equal(clip.path,media);
    assert.match(output,/<duration>200<\/duration>/);
  }
  assert.equal(original.xml,snapshot);
});
test('malformed XML, external entities, wrong formats and incomplete edit plans are rejected', () => {
  for (const source of ['<fcpxml/>', xml.replace('</sequence>', ''), xml.replace('<!DOCTYPE xmeml>', '<!DOCTYPE xmeml SYSTEM "file:///secret">')]) assert.throws(() => parseResolveTimeline(source));
  const timeline = parseResolveTimeline(xml);
  assert.throws(() => renderResolveMulticam(timeline, [0, 1], ranges.slice(0, 1)), /cover/);
  assert.throws(() => renderResolveMulticam(timeline, [0, 1], [{ startFrame: 1, endFrame: 100, trackIndex: 0 }]), /Invalid/);
});
test('selected retiming, animation and nested clips have explicit support failures', () => {
  const animated = parseResolveTimeline(xml.replace('<name>cam1 &amp; source</name>', '<name>cam1 &amp; source</name><filter><effect><parameter><keyframe><when>25</when></keyframe></parameter></effect></filter>'));
  assert.throws(() => renderResolveMulticam(animated, [0, 1], ranges), /animated/);
  const retimed = parseResolveTimeline(xml.replace('<out>125</out>', '<out>175</out>'));
  assert.throws(() => renderResolveMulticam(retimed, [0, 1], ranges), /retimed/);
  const nested = parseResolveTimeline(xml.replace(clip('cam1'), clip('cam1').replace(file, '<sequence id="nested"/>')));
  assert.throws(() => renderResolveMulticam(nested, [0, 1], ranges), /nested/);
});
test('NTSC timing stays frame accurate across a 100-switch plan', () => {
  const fractional = xml.replaceAll('<timebase>25</timebase><ntsc>FALSE', '<timebase>30</timebase><ntsc>TRUE');
  const source = parseResolveTimeline(fractional);
  assert.equal(source.fps, 30000 / 1001);
  const result = parseResolveTimeline(renderResolveMulticam(source, [0, 1], Array.from({ length: 100 }, (_, i) => ({ startFrame: i, endFrame: i + 1, trackIndex: i % 2 }))));
  assert.equal(result.videoTracks[1].clips.length, 100);
  assert.equal(result.frames, 100);
  assert.equal(Math.round(result.videoTracks[1].clips.at(-1).end * result.fps), 100);
});
const sourcePath = path.join(scratch, 'input.xml'); fs.writeFileSync(sourcePath, xml);
const configFor = info => ({ sources: [{ index: 0, camera: 0 }, { index: 1, camera: 1 }], options: { sequenceId: info.id, timelineRevision: info.timelineRevision, videoTracks: [{ index: 0 }, { index: 1 }], minCutDuration: 0.1, holdTime: 0 } });
test('accepted run uses local analysis and atomic export, with one start/success and original unchanged', async () => {
  let starts = 0, exports = 0;
  const service = createResolveService({ progress() {}, result() {}, exported() { exports++; },
    renderAudio: async (_track, destination) => { fs.writeFileSync(destination, 'mock WAV'); return destination; },
    detectSpeech: async sources => sources[0].speaker.endsWith('_0') ? [{ start: 0, end: 2, speaker: sources[0].speaker }] : [{ start: 2, end: 4, speaker: sources[0].speaker }] });
  const info = service.load(sourcePath), destination = path.join(scratch, 'result.xml');
  const result = await service.run(configFor(info), destination, () => starts++);
  assert.equal(result.success, true, result.error); assert.equal(result.handoff, true);
  assert.equal(starts, 1); assert.equal(exports, 1);
  assert.equal(parseResolveTimeline(fs.readFileSync(destination, 'utf8')).name, 'Interview - Auto-Switch');
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), xml);
  const rejected = await service.run(configFor(info), sourcePath, () => starts++);
  assert.equal(rejected.success, false); assert.equal(starts, 1); assert.equal(exports, 1);
});
test('symlinked output folders cannot overwrite the loaded source or start either Resolve tool', async () => {
  const alias = path.join(scratch, 'source-alias');
  fs.symlinkSync(scratch, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let starts = 0, exports = 0;
  const service = createResolveService({ progress() {}, result() {}, exported() { exports++; } });
  const info = service.load(sourcePath), destination = path.join(alias, path.basename(sourcePath));
  const multicam = await service.run(configFor(info), destination, () => starts++);
  const silence = await service.removeSilence({ options: { sequenceId: info.id } }, destination, () => starts++);
  for (const result of [multicam, silence]) {
    assert.equal(result.success, false);
    assert.match(result.error, /new XML file/);
  }
  assert.equal(starts, 0); assert.equal(exports, 0);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), xml);
});
test('busy/canceled jobs cannot export, change source, or count a second start', async () => {
  let release, started = 0, exported = 0;
  const service = createResolveService({ progress() {}, result() {}, exported() { exported++; },
    renderAudio: async () => new Promise(resolve => { release = resolve; }), detectSpeech: async () => [] });
  const info = service.load(sourcePath), destination = path.join(scratch, 'canceled.xml');
  const first = service.run(configFor(info), destination, () => started++);
  assert.equal((await service.run(configFor(info), destination, () => started++)).success, false);
  assert.throws(() => service.load(sourcePath), /Wait/);
  service.cancel(); release('unused');
  const result = await first;
  assert.equal(result.success, false); assert.match(result.error, /canceled/);
  assert.equal(fs.existsSync(destination), false); assert.equal(started, 1); assert.equal(exported, 0); assert.equal(service.isBusy(), false);
});
test('real FFmpeg extraction isolates the selected microphone channel and respects the timeline offset', async () => {
  const ffmpeg = require('ffmpeg-static'), stereo = path.join(scratch, 'stereo.wav');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=2:sample_rate=48000', '-af', 'pan=stereo|c0=c0|c1=0*c0', stereo], { windowsHide: true });
  const source = parseResolveTimeline(xml), track = source.audioTracks[0];
  track.clips = [{ ...track.clips[0], path: stereo, start: 1, end: 2, inPoint: 0, outPoint: 1 }];
  const levels = [];
  for (const channel of [1, 2]) {
    track.clips[0].channel = channel;
    const output = path.join(scratch, `channel-${channel}.wav`);
    await renderResolveMicrophone(track, output, 3, new AbortController().signal);
    const bytes = fs.readFileSync(output), start = bytes.indexOf(Buffer.from('data')) + 8;
    const energy = (from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += Math.abs(bytes.readInt16LE(start + i * 2)); return sum / (to - from); };
    assert.ok(energy(0, 15000) < 1);
    levels.push(energy(17000, 30000));
  }
  assert.ok(levels[0] > 1000); assert.ok(levels[1] < 1);
});

test('Resolve Silence Removal ripples every track equally, retains source channels and preserves input XML', () => {
  const source=parseResolveTimeline(xml), before=source.xml;
  const result=parseResolveTimeline(renderResolveSilence(source,[{start:0,end:1},{start:3,end:4}]));
  assert.equal(result.name,'Interview - Silence Removed');assert.equal(result.frames,2*source.fps);
  assert.equal(result.audioTracks.length,source.audioTracks.length);assert.equal(result.videoTracks.length,source.videoTracks.length);
  for(let i=0;i<result.audioTracks.length;i++){
    assert.equal(result.audioTracks[i].clips[0].channel,source.audioTracks[i].clips[0].channel);
    assert.equal(result.audioTracks[i].clips[1].start,1);
    assert.equal(result.audioTracks[i].clips[1].inPoint,source.audioTracks[i].clips[0].inPoint+3);
  }
  assert.equal(source.xml,before);
});

test('Resolve sequence source preparation mixes only selected source channels with their timeline offsets', async()=>{
  const {renderResolveSource}=await moduleAt('../src/main/resolve/source-audio.ts');
  const file=path.join(scratch,'sequence-stereo.wav');
  execFileSync(require('ffmpeg-static'),['-y','-v','error','-f','lavfi','-i','sine=frequency=600:duration=2:sample_rate=48000','-af','pan=stereo|c0=c0|c1=0*c0',file],{windowsHide:true});
  const timeline=parseResolveTimeline(xml);timeline.duration=3;
  for(const track of timeline.audioTracks)track.clips=[{...track.clips[0],path:file,start:1,end:2,inPoint:0,outPoint:1}];
  timeline.audioTracks[0].clips[0].channel=1;timeline.audioTracks[1].clips[0].channel=2;
  const levels=[];
  for(const index of [0,1]){
    const result=await renderResolveSource(timeline,[index],new AbortController().signal);
    try{const bytes=fs.readFileSync(result.path),position=bytes.indexOf(Buffer.from('data')),start=position+8;let silence=0,speech=0;
      for(let i=0;i<14400;i++)silence+=Math.abs(bytes.readInt16LE(start+i*2));
      for(let i=16000;i<32000;i++)speech+=Math.abs(bytes.readInt16LE(start+i*2));
      assert.equal(result.durationSeconds,3);assert.equal(silence,0);levels.push(speech);
    }finally{fs.rmSync(result.path,{force:true});}
  }
  assert.ok(levels[0]>100000);assert.equal(levels[1],0);
});

test('Resolve Silence Removal exports only a successful local result, cancels safely and keeps source XML intact',async()=>{
 const audio=path.join(scratch,'silence-source.wav');
 execFileSync(require('ffmpeg-static'),['-y','-v','error','-f','lavfi','-i','sine=frequency=600:duration=6:sample_rate=48000','-af','pan=stereo|c0=c0|c1=0*c0',audio],{windowsHide:true});
 const input=path.join(scratch,'silence-input.xml'),destination=path.join(scratch,'silence-result.xml');
 const inputXML=xml.replaceAll(pathToFileURL(media).href,pathToFileURL(audio).href);fs.writeFileSync(input,inputXML);
 let starts=0;const results=[];const service=createResolveService({progress(){},result:r=>results.push(r),exported(){}});const info=service.load(input);
 const config={sources:[{trackIndex:0}],options:{sequenceId:info.id,thresholdDb:-40,minSilenceDuration:0.5,padding:0.1}};
 const completed=await service.removeSilence(config,destination,()=>starts++);assert.equal(completed.success,true,completed.error);assert.equal(completed.operation,'silence');assert.equal(starts,1);assert.equal(parseResolveTimeline(fs.readFileSync(destination,'utf8')).name,'Interview - Silence Removed');
 const canceledFile=path.join(scratch,'silence-canceled.xml');const pending=service.removeSilence(config,canceledFile,()=>starts++);service.cancel();assert.equal((await pending).canceled,true);assert.equal(fs.existsSync(canceledFile),false);assert.equal(fs.readFileSync(input,'utf8'),inputXML);assert.equal(starts,2);assert.equal(service.isBusy(),false);
});
