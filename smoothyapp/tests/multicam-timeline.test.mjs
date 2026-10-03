import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { build } from 'esbuild';

async function moduleAt(relative) {
  const output = await build({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}
const { createMulticamPlan } = await moduleAt('../src/main/autocut/multicam-plan.ts');
const { runPremiereMulticam } = await moduleAt('../src/main/autocut/premiere-multicam.ts');
const { runVad } = await moduleAt('../src/main/autocut/vad-runner.ts');
const { generateShotDecisions } = await moduleAt('../src/main/autocut/decision-engine.ts');
const host = await readFile(new URL('../../smoothyapp-cep/jsx/host.jsx', import.meta.url), 'utf8');
const fullCameras = [{ index: 0, clips: [{ start: 0, end: 10 }] }, { index: 2, clips: [{ start: 0, end: 10 }] }];
const shots = [{ start: 0, end: 5, camera: 0 }, { start: 5, end: 10, camera: 1 }];

test('nested cameras need no paths and sparse tracks remain correctly mapped', () => {
  assert.deepEqual(createMulticamPlan(fullCameras, shots, [], 25, 10), [
    { startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 2 }
  ]);
});
test('J-cuts and wide decisions use exact sequence frames', () => {
  assert.deepEqual(createMulticamPlan(fullCameras, shots, [{ start: 6, end: 8, camera: 0 }], 25, 10, 1), [
    { startFrame: 0, endFrame: 150, trackIndex: 0 }, { startFrame: 150, endFrame: 175, trackIndex: 2 },
    { startFrame: 175, endFrame: 225, trackIndex: 0 }, { startFrame: 225, endFrame: 250, trackIndex: 2 }
  ]);
});
test('camera gaps fall back to available footage and preserve true empty intervals', () => {
  const tracks = [{ index: 0, clips: [{ start: 0, end: 3 }, { start: 8, end: 10, disabled: true }] }, { index: 1, clips: [{ start: 2, end: 6 }, { start: 8, end: 10 }] }];
  assert.deepEqual(createMulticamPlan(tracks, [{ start: 0, end: 10, camera: 0 }], [], 25, 10), [
    { startFrame: 0, endFrame: 75, trackIndex: 0 }, { startFrame: 75, endFrame: 150, trackIndex: 1 },
    { startFrame: 150, endFrame: 200, trackIndex: -1 }, { startFrame: 200, endFrame: 250, trackIndex: 1 }
  ]);
  assert.throws(() => createMulticamPlan(fullCameras, [{ start: 0, end: 3, camera: 5 }], [], 25, 10), /Invalid camera/);
});

function chronological(track) { return [...track.clips].sort((a, b) => a.start.seconds - b.start.seconds); }
function collection(items, count) { Object.defineProperty(items, count, { get: () => items.length }); return items; }
function fixture(options = {}) {
  const state = { files: new Map(), exports: [], cuts: [], overwrites: [], frames: [], clones: 0, failExport: false, moves: [], timeMoves: 0, failMove: !!options.failMove };
  class Time {
    constructor(seconds = 0) { this.seconds = seconds; }
    get ticks() { return String(Math.round(this.seconds * 254016000000)); }
    set ticks(value) { this.seconds = Number(value) / 254016000000; }
    getFormatted(rate, display) { state.frames.push({ rate: rate.seconds, display }); return 'frame:' + Math.round(this.seconds / rate.seconds); }
  }
  const clip = (name, start, end, attrs = {}) => ({ name, start: new Time(start), end: new Time(end), inPoint: new Time(30 + start), outPoint: new Time(30 + end),
    disabled: false, selected: false, linked: true, setSelected(value) { this.selected = value; },
    move() { state.timeMoves++; throw Error("Time moves leave invisible reverse clips in Premiere"); },
    getSpeed: () => 1, isSpeedReversed: () => false,
    projectItem: { nodeId: name, _inTicks: String(Math.round((30 + start) * 254016000000)), _outTicks: String(Math.round((30 + end) * 254016000000)),
      getMediaPath: () => name.includes('Nest') ? '' : '/fixture/' + name + '.mov', getFootageInterpretation: () => ({ frameRate: 25 }),
      getInPoint() { return { ticks: this._inTicks }; }, getOutPoint() { return { ticks: this._outTicks }; },
      setInPoint(ticks, mediaType) { this._inTicks = String(Number(ticks)); }, setOutPoint(ticks, mediaType) { this._outTicks = String(Number(ticks)); } },
    effects: { lumetri: 'warm', position: [960, 540], keyframes: [{ time: 34, value: 20 }] }, ...attrs });
  const copyClip = item => ({ ...item, start: new Time(item.start.seconds), end: new Time(item.end.seconds), inPoint: new Time(item.inPoint.seconds), outPoint: new Time(item.outPoint.seconds), effects: structuredClone(item.effects) });
  const track = (name, clips, muted = false) => ({ name, clips: collection(clips, 'numItems'), muted,
    isMuted() { return this.muted; }, setMute(value) { this.muted = !!value; },
    overwriteClip(item, ticks) {
      // Actual Premiere inserts linked audio even through a video track API.
      state.overwrites.push({ track: this.name });
      project.activeSequence.audioTracks[0].clips.push(clip('Inserted camera audio', 0, 5));
      throw Error('Unsafe video overwrite used');
    } });
  const makeSequence = (id, videos, audios) => ({ sequenceID: id, name: id, projectItem: { name: id }, end: new Time(10), timebase: String(254016000000 / (options.fps || 25)), zeroPoint: String(254016000000 * 3600), videoDisplayFormat: options.display || 101,
    markers: { numMarkers: 1, note: 'Personal marker' }, captions: ['Hello'], mixer: { gain: -3 },
    videoTracks: collection(videos, 'numTracks'), audioTracks: collection(audios, 'numTracks'),
    getSettings() { return { videoFrameRate: new Time(1 / (options.fps || 25)), videoFrameWidth: 1920, videoFrameHeight: 1080 }; },
    setZeroPoint(value) { this.zeroPoint = value; },
    unlinkSelection() {
      for (const track of this.videoTracks) for (const item of track.clips) if (item.selected) item.linked = false;
      return false; // Native Premiere can return false after successful unlink.
    },
    getExportFileExtension() { return 'wav'; },
    exportAsMediaDirect(file, preset, workArea) {
      state.exports.push({ sequence: this.sequenceID, microphones: this.audioTracks.map(track => track.muted), file, workArea });
      if (state.failExport) throw Error('Export failed');
      if (options.renderAudio) { options.renderAudio(file); return 0; }
      state.files.set(file, 128); return 0;
    },
    clone() {
      const clone = makeSequence('clone-' + (++state.clones), this.videoTracks.map(item => track(item.name, item.clips.map(copyClip), item.muted)), this.audioTracks.map(item => track(item.name, item.clips.map(copyClip), item.muted)));
      clone.markers = structuredClone(this.markers); clone.captions = structuredClone(this.captions); clone.mixer = structuredClone(this.mixer);
      project.sequences.push(clone); return true; // Deliberately not a Sequence.
    }
  });
  const source = makeSequence('source', [track('V1', [clip('Nest 1', 0, 10)]), track('V2', [clip('Nest 2', 0, 10)]), track('Titles', [clip('Title', 0, 10)])],
    [track('A1', [clip('Mic Nest 1', 0, 10)]), track('A2', [clip('Mic Nest 2', 0, 10)], true)]);
  const project = { activeSequence: source, sequences: collection([source], 'numSequences'), openSequence(id) { this.activeSequence = this.sequences.find(seq => seq.sequenceID === id); } };
  function File(file) { this.fsName = file; }
  Object.defineProperties(File.prototype, { exists: { get() { return options.renderAudio ? fs.existsSync(this.fsName) : state.files.has(this.fsName); } }, length: { get() { return options.renderAudio ? fs.statSync(this.fsName).size : state.files.get(this.fsName) || 0; } } });
  File.prototype.remove = function() { if (options.renderAudio) fs.rmSync(this.fsName, { force: true }); else state.files.delete(this.fsName); };
  function Folder(folder) { this.fsName = folder; this.name = path.basename(folder); this.exists = folder.includes('57415645') || (options.renderAudio ? fs.existsSync(folder) : this.name === 'smoothyedit-multicam-ABC123'); this.getFiles = () => [{ fsName: folder + '/Waveform.epr' }]; }
  Folder.temp = { fsName: '/fixture/tmp' }; Folder.appPackage = { fsName: '/fixture/Premiere.app' };
  const context = { app: { project, enableQE() {} }, Time, File, Folder, console, qe: { project: { getActiveSequence() { return {
    addTracks(count, after, audioCount) {
      if (options.failScratchAdd) return;
      assert.equal(audioCount, 0);
      const seq = project.activeSequence;
      seq.videoTracks.splice(after + 1, 0, track('Scratch', []));
      if (options.scratchAudioMutation) seq.audioTracks.push(track('Unexpected Audio', []));
    },
    removeVideoTrack(index) {
      if (options.failScratchRemove) return;
      const seq = project.activeSequence;
      assert.equal(seq.videoTracks[index].clips.length, 0);
      seq.videoTracks.splice(index, 1);
    },
    getVideoTrackAt(index) { return {
      get numItems() { return project.activeSequence.videoTracks[index].clips.length; },
      getItemAt(position) {
        const item = project.activeSequence.videoTracks[index].clips[position];
        return { type: 'Clip', start: item.start, end: item.end,
          moveToTrack(videoDelta, audioDelta, timeDelta, duplicate) {
            if (state.failMove) throw Error('Camera move failed');
            if (options.noopMove) return;
            const seq = project.activeSequence, from = seq.videoTracks[index], to = seq.videoTracks[index + videoDelta];
            state.moves.push({ from: index, to: index + videoDelta, seconds: item.start.seconds, audioDelta, timeDelta, duplicate });
            from.clips.splice(from.clips.indexOf(item), 1);
            // Native DOM collection is not sorted after moving between tracks.
            to.clips.push(item);
            if (item.linked || options.mutateAudio) seq.audioTracks[0].clips[0].end.seconds -= 1;
            options.afterMove?.(seq, index + videoDelta, item);
          }
        };
      }, razor(formatted) {
      const frame = Number(formatted.replace('frame:', '')), seq = project.activeSequence;
      state.cuts.push({ sequence: seq.sequenceID, track: index, frame, zeroPoint: seq.zeroPoint });
      if (state.failRazor) return;
      const time = frame * Number(seq.timebase) / 254016000000, clips = seq.videoTracks[index].clips;
      const position = clips.findIndex(item => item.start.seconds < time && item.end.seconds > time);
      if (position < 0) return;
      const first = clips[position], second = copyClip(first), sourceIn = first.inPoint.seconds + time - first.start.seconds;
      second.start = new Time(time); second.inPoint = new Time(sourceIn);
      first.end = new Time(time); first.outPoint = new Time(sourceIn); clips.splice(position + 1, 0, second);
      options.afterRazor?.(seq, index, frame);
    } }; }
  }; } } } };
  vm.createContext(context); vm.runInContext(host, context);
  const json = value => JSON.parse(JSON.stringify(value));
  const call = (name, payload) => JSON.parse(context[name](JSON.stringify(payload)));
  const jobId = '11111111-1111-4111-8111-111111111111';
  const prepare = () => call('prepareMulticamTimeline', { jobId, sequenceId: 'source', timelineRevision: context.smoothyTimelineRevision(source, false), sequenceName: 'Interview - Auto-Switch', audioDirectory: '/fixture/smoothyedit-multicam-ABC123', videoTrackIndices: [0, 1], audioTrackIndices: [0, 1] });
  return { state, context, source, project, call, prepare, jobId, json };
}

test('Premiere reader exposes nests and prepares a complete duplicate without touching original', () => {
  const f = fixture(), before = f.json(f.source);
  const info = JSON.parse(f.context.getSequenceInfo());
  assert.equal(info.multicamTimelineVersion, 7); assert.equal(info.videoTracks[0].clips[0].path, '');
  const prepared = f.prepare(); assert.equal(prepared.success, true); assert.equal(prepared.duration, 10);
  assert.equal(f.project.activeSequence, f.source); assert.deepEqual(f.json(f.source), before);
  const clone = f.project.sequences[1]; assert.deepEqual(clone.mixer, f.source.mixer); assert.deepEqual(clone.captions, f.source.captions); assert.deepEqual(clone.markers, f.source.markers);
});
test('each rendered microphone is isolated, then mute states and active sequence are restored', () => {
  const f = fixture(); f.prepare(); const before = f.json(f.source);
  for (const trackIndex of [0, 1]) {
    const rendered = f.call('exportMulticamTimelineTrack', { jobId: f.jobId, trackIndex });
    assert.equal(rendered.success, true); assert.equal(rendered.fileSize, 128);
    assert.equal(rendered.filePath, `/fixture/smoothyedit-multicam-ABC123/microphone-${trackIndex}.wav`);
  }
  assert.deepEqual(f.state.exports.map(item => item.microphones), [[false, true], [true, false]]);
  assert.ok(f.state.exports.every(item => item.sequence === 'clone-1' && item.workArea === 0));
  assert.deepEqual(f.project.sequences[1].audioTracks.map(track => track.muted), [false, true]);
  assert.deepEqual(f.json(f.source), before); assert.equal(f.project.activeSequence, f.source);
  f.call('discardMulticamTimeline', { jobId: f.jobId }); assert.equal(f.state.files.size, 0);
});
test('winners stack on the top camera track while the bottom keeps the reverse angle, nothing disabled', () => {
  const f = fixture();
  f.source.videoTracks[0].clips[0].effects.lumetri = 'camera one';
  f.source.videoTracks[1].clips[0].effects.lumetri = 'camera two';
  f.prepare(); const before = f.json(f.source), clone = f.project.sequences[1], zero = clone.zeroPoint;
  const audio = f.json(clone.audioTracks), overlay = f.json(clone.videoTracks[2]);
  vm.runInContext(host, f.context); // Re-loading the host must retain the analysis job.
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] });
  assert.equal(result.success, true, result.error); assert.equal(clone.zeroPoint, zero);
  assert.equal(f.state.overwrites.length, 0);
  assert.equal(f.state.timeMoves, 0);
  assert.equal(clone.videoTracks.numTracks, f.source.videoTracks.numTracks);
  assert.ok(f.state.moves.every(move => move.audioDelta === 0 && move.timeDelta === '00:00:00:00' && move.duplicate === false));
  assert.deepEqual(f.json(f.source), before);
  assert.equal(f.project.activeSequence, clone); assert.equal(clone.name, 'Interview - Auto-Switch');
  const top = { clips: chronological(clone.videoTracks[1]) }, bottom = { clips: chronological(clone.videoTracks[0]) };
  assert.ok(top.clips.concat(bottom.clips).every(clip => !clip.disabled));
  assert.deepEqual(top.clips.map(item => item.projectItem.nodeId), ['Nest 1', 'Nest 2']);
  assert.equal(top.clips[0].start.seconds, 0); assert.equal(top.clips[0].end.seconds, 5);
  assert.equal(top.clips[0].inPoint.seconds, 30); assert.equal(top.clips[0].outPoint.seconds, 35);
  assert.deepEqual(top.clips[0].effects, f.source.videoTracks[0].clips[0].effects);
  assert.deepEqual(bottom.clips[0].effects, f.source.videoTracks[1].clips[0].effects);
  assert.equal(top.clips[1].start.seconds, 5); assert.equal(top.clips[1].end.seconds, 10);
  assert.equal(top.clips[1].inPoint.seconds, 35);
  assert.deepEqual(top.clips[1].effects, f.source.videoTracks[1].clips[0].effects);
  assert.deepEqual(bottom.clips.map(item => item.projectItem.nodeId), ['Nest 2', 'Nest 1']);
  assert.equal(bottom.clips[0].inPoint.seconds, 30); assert.equal(bottom.clips[0].outPoint.seconds, 35);
  assert.equal(bottom.clips[1].inPoint.seconds, 35); assert.deepEqual(bottom.clips[1].effects, f.source.videoTracks[0].clips[0].effects);
  for (let t = 0; t < 2; t++) for (const piece of clone.videoTracks[t].clips) {
    assert.ok(piece.projectItem === f.source.videoTracks[0].clips[0].projectItem || piece.projectItem === f.source.videoTracks[1].clips[0].projectItem);
  }
  assert.deepEqual(f.json(clone.audioTracks), audio); assert.deepEqual(f.json(clone.videoTracks[2]), overlay);
  assert.equal(f.call('discardMulticamTimeline', { jobId: f.jobId, completed: true }).success, true);
  assert.equal(clone.name, 'Interview - Auto-Switch');
});
test('temporary video track failures cannot report a complete result or change the source', () => {
  for (const option of ['failScratchAdd', 'failScratchRemove', 'scratchAudioMutation']) {
    const f = fixture({ [option]: true }); f.prepare(); const before = f.json(f.source);
    const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 0 }] });
    assert.equal(result.success, false, option);
    assert.match(result.error, /temporary camera track|empty temporary camera track|changed linked audio/);
    assert.deepEqual(f.json(f.source), before);
    assert.equal(f.state.timeMoves, 0);
    if (option !== 'failScratchRemove') assert.equal(f.project.sequences[1].videoTracks.numTracks, 3);
    f.call('discardMulticamTimeline', { jobId: f.jobId });
    assert.match(f.project.sequences[1].name, /incomplete/);
  }
});
test('a failed swap retains the stranded reverse video on the appended track for recovery', () => {
  const f = fixture({ afterMove(seq, index) { if (index === 3) f.state.failMove = true; } });
  f.prepare(); const before = f.json(f.source);
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 0 }] });
  assert.equal(result.success, false); assert.match(result.error, /Camera move failed/);
  const clone = f.project.sequences[1];
  assert.equal(clone.videoTracks.numTracks, 4);
  assert.equal(clone.videoTracks[3].clips[0].projectItem.nodeId, 'Nest 2');
  assert.equal(clone.videoTracks[0].clips[0].projectItem.nodeId, 'Nest 1');
  assert.deepEqual(f.json(clone.videoTracks[2]), f.json(f.source.videoTracks[2]));
  assert.deepEqual(f.json(clone.audioTracks), f.json(f.source.audioTracks));
  assert.deepEqual(f.json(f.source), before);
});
test('a winning top camera needs no temporary track', () => {
  const f = fixture({ failScratchAdd: true }); f.prepare();
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 1 }] });
  assert.equal(result.success, true, result.error);
  assert.equal(f.state.moves.length, 0); assert.equal(f.state.timeMoves, 0);
  assert.equal(f.project.sequences[1].videoTracks.numTracks, 3);
});
test('rearranged pieces land on exact native frame boundaries at fixed frame rates', () => {
  const f = fixture(); f.prepare();
  assert.equal(f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] }).success, true);
  assert.equal(f.state.moves[0].seconds, 0);
  assert.equal(f.state.overwrites.length, 0);
  assert.equal(chronological(f.project.sequences[1].videoTracks[1])[0].end.seconds, 5);
});
test('fractional frame rates preserve native positions and trims when swapping camera video', () => {
  const f = fixture({ fps: 30000 / 1001 }); f.prepare();
  const last = Math.round(10 * 30000 / 1001);
  assert.equal(f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 150, trackIndex: 1 }, { startFrame: 150, endFrame: last, trackIndex: 0 }] }).success, true);
  assert.equal(f.state.moves.length, 3);
  assert.equal(f.state.moves.find(item => item.to === 1).seconds, 150 / (30000 / 1001));
  assert.equal(f.state.moves.filter(item => item.to === 0).length, 1);
});
test('selected hidden camera output is enabled only on the duplicate', () => {
  const f = fixture(); f.source.videoTracks[0].setMute(1); f.prepare();
  assert.equal(f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 0 }] }).success, true);
  assert.equal(f.project.sequences[1].videoTracks[0].isMuted(), false);
  assert.equal(f.source.videoTracks[0].isMuted(), true);
});
test('the winning camera always plays on the top track, including repeated switches and reversed mappings', () => {
  for (const order of [[0, 1, 0, 1], [1, 0, 1, 0]]) {
    const f = fixture(); f.prepare(); const before = f.json(f.source);
    const ranges = order.map((trackIndex, i) => ({ startFrame: i * 50, endFrame: i === 3 ? 250 : (i + 1) * 50, trackIndex }));
    const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges });
    assert.equal(result.success, true, result.error); assert.equal(result.verifiedRanges, 4);
    const clone = f.project.sequences[1];
    assert.ok(clone.videoTracks.slice(0, 2).every(track => track.clips.every(clip => !clip.disabled)));
    for (let frame = 0; frame < 250; frame++) {
      const winner = ranges.find(range => range.startFrame <= frame && range.endFrame > frame).trackIndex;
      const playing = clone.videoTracks[1].clips.filter(clip => !clip.disabled && clip.start.seconds * 25 <= frame && clip.end.seconds * 25 > frame);
      assert.deepEqual(playing.map(clip => clip.projectItem.nodeId), [`Nest ${winner + 1}`], `top@${frame}:{${playing.map(c=>c.projectItem.nodeId+'@'+c.start.seconds+'-'+c.end.seconds)}}`);
      const under = clone.videoTracks[0].clips.filter(clip => !clip.disabled && clip.start.seconds * 25 <= frame && clip.end.seconds * 25 > frame);
      assert.deepEqual(under.map(clip => clip.projectItem.nodeId), [`Nest ${2 - winner}`], `under@${frame}:{${under.map(c=>c.projectItem.nodeId+'@'+c.start.seconds+'-'+c.end.seconds)}}`);
    }
    assert.deepEqual(f.json(f.source), before);
  }
});
test('final coverage rejects failed relocation or partial footage after the pieces move', () => {
  for (const failure of ['move', 'partial', 'noop']) {
    let f;
    const options = { failMove: failure === 'move', noopMove: failure === 'noop' };
    if (failure === 'partial') options.afterMove = function(seq, index, item) { if (index === 1) item.end.seconds -= 0.5; };
    f = fixture(options);
    f.prepare(); const before = f.json(f.source);
    const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] });
    assert.equal(result.success, false, JSON.stringify(result.error)); assert.match(result.error, /Camera move failed|preserve the camera piece|camera coverage/);
    f.call('discardMulticamTimeline', { jobId: f.jobId });
    assert.match(f.project.sequences[1].name, /incomplete/); assert.deepEqual(f.json(f.source), before);
  }
});
test('a failed video razor stops before moves and leaves the original intact', () => {
  const f = fixture(); f.prepare(); const before = f.json(f.source);
  f.state.failRazor = true;
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] });
  assert.equal(result.success, false); assert.match(result.error, /did not cut camera/);
  assert.equal(f.state.moves.length, 0); assert.deepEqual(f.json(f.source), before);
});
test('linked audio corruption still rejects success, while video-only parking is not an audio change', () => {
  const f = fixture({ mutateAudio: true }); f.prepare(); const before = f.json(f.source);
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 0 }] });
  assert.equal(result.success, false); assert.match(result.error, /changed linked audio/);
  assert.deepEqual(f.json(f.source), before);

  const g = fixture(), audio = g.context.smoothyTimelineRevision(g.source, true);
  g.source.videoTracks[0].clips[0].end.seconds = 20;
  g.source.end.seconds = 20;
  assert.equal(g.context.smoothyTimelineRevision(g.source, true), audio);
  g.source.audioTracks[0].clips[0].outPoint.seconds -= 1;
  assert.notEqual(g.context.smoothyTimelineRevision(g.source, true), audio);
});
test('three camera swaps keep every angle once', () => {
  const f = fixture();
  const result = f.call('prepareMulticamTimeline', { jobId: f.jobId, sequenceId: 'source', timelineRevision: f.context.smoothyTimelineRevision(f.source, false),
    audioDirectory: '/fixture/smoothyedit-multicam-ABC123', videoTrackIndices: [0, 1, 2], audioTrackIndices: [0, 1] });
  assert.equal(result.success, true);
  const ranges = [0, 1, 2, 0, 1].map((trackIndex, i) => ({ startFrame: i * 50, endFrame: (i + 1) * 50, trackIndex }));
  assert.equal(f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges }).success, true);
  for (let frame = 0; frame < 250; frame++) {
    const playing = f.project.sequences[1].videoTracks.map(track => track.clips.find(clip => Math.round(clip.start.seconds * 25) <= frame && Math.round(clip.end.seconds * 25) > frame).projectItem.nodeId);
    assert.deepEqual([...playing].sort(), ['Nest 1', 'Nest 2', 'Title']);
    assert.equal(playing[2], ['Nest 1', 'Nest 2', 'Title'][ranges[Math.floor(frame / 50)].trackIndex]);
  }
});
test('final audit rejects a wrong camera even when every video frame is covered', () => {
  const f = fixture({ afterMove(seq, index) {
    if (index !== 0) return;
    const earlierWinner = seq.videoTracks[1].clips.find(item => item.start.seconds === 0);
    earlierWinner.projectItem = { ...earlierWinner.projectItem, nodeId: 'Wrong camera' };
  } });
  f.prepare(); const before = f.json(f.source);
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] });
  assert.equal(result.success, false); assert.match(result.error, /preserve the camera piece/);
  assert.deepEqual(f.json(f.source), before);
});
test('a shorter reverse camera stays a gap underneath the available winning camera', () => {
  const f = fixture();
  f.source.videoTracks[1].clips[0].end.seconds = 9.8;
  f.source.videoTracks[1].clips[0].outPoint.seconds = 39.8;
  f.prepare();
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 245, trackIndex: 1 }, { startFrame: 245, endFrame: 250, trackIndex: 0 }] });
  assert.equal(result.success, true, result.error);
  const clone = f.project.sequences[1];
  assert.equal(clone.videoTracks[0].clips.some(clip => clip.start.seconds >= 9.8), false);
  assert.equal(clone.videoTracks[1].clips.find(clip => clip.start.seconds === 9.8).projectItem.nodeId, 'Nest 1');
});
test('CEP end represented as ticks gives the same duration with or without sequence start timecode', () => {
  const f = fixture();
  for (const absolute of [false, true]) {
    f.source.end = String(254016000000 * (10 + (absolute ? 3600 : 0)));
    assert.equal(f.context.smoothySequenceDuration(f.source), 10);
    f.source.end = { seconds: 10 + (absolute ? 3600 : 0) };
    assert.equal(f.context.smoothySequenceDuration(f.source), 10);
  }
});
test('preparation resolves the requested sequence even after switching tabs, but rejects stale source edits', () => {
  const f = fixture();
  const unrelated = { ...f.source, sequenceID: 'unrelated', name: 'Another timeline' };
  f.project.sequences.push(unrelated); f.project.activeSequence = unrelated;
  assert.equal(f.prepare().success, true);
  assert.equal(f.project.activeSequence, unrelated);
  assert.equal(f.project.sequences[2].videoTracks[0].clips[0].projectItem.nodeId, 'Nest 1');

  const stale = fixture(), revision = stale.context.smoothyTimelineRevision(stale.source, false);
  stale.source.videoTracks[0].clips[0].end.seconds = 9;
  const result = stale.call('prepareMulticamTimeline', { jobId: stale.jobId, sequenceId: 'source', timelineRevision: revision,
    audioDirectory: '/fixture/smoothyedit-multicam-ABC123', videoTrackIndices: [0, 1], audioTrackIndices: [0, 1] });
  assert.equal(result.success, false); assert.match(result.error, /timeline changed/); assert.equal(stale.state.clones, 0);
});
test('microphone exports and camera edits stay bound to the duplicate when other sequences are viewed or edited', () => {
  const f = fixture(); f.prepare();
  const duplicate = f.project.sequences[1];
  const unrelated = { ...f.source, sequenceID: 'unrelated', name: 'Another timeline' };
  f.project.sequences.push(unrelated); f.project.activeSequence = unrelated;
  // Editing the original after cloning cannot change this top-level snapshot.
  f.source.videoTracks[0].clips[0].end.seconds = 9;
  const editedOriginal = f.json(f.source);
  for (const trackIndex of [0, 1]) {
    assert.equal(f.call('exportMulticamTimelineTrack', { jobId: f.jobId, trackIndex }).success, true);
    assert.equal(f.project.activeSequence, unrelated);
  }
  assert.ok(f.state.exports.every(render => render.sequence === duplicate.sequenceID));
  assert.deepEqual(duplicate.audioTracks.map(track => track.muted), [false, true]);
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] });
  assert.equal(result.success, true, result.error); assert.equal(result.sequenceId, duplicate.sequenceID);
  assert.deepEqual(chronological(duplicate.videoTracks[1]).map(clip => clip.projectItem.nodeId), ['Nest 1', 'Nest 2']);
  assert.deepEqual(f.json(f.source), editedOriginal);
  assert.equal(f.project.activeSequence, duplicate);
  assert.equal(f.call('discardMulticamTimeline', { jobId: f.jobId }).success, true);
});
test('a job continues with no active sequence but rejects a changed or closed working duplicate', () => {
  const f = fixture(); f.prepare(); f.project.activeSequence = null;
  assert.equal(f.call('exportMulticamTimelineTrack', { jobId: f.jobId, trackIndex: 0 }).success, true);
  f.project.activeSequence = null;
  assert.equal(f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 0 }] }).success, true);

  for (const change of ['trim', 'audio', 'closed']) {
    const g = fixture(); g.prepare();
    if (change === 'trim') g.project.sequences[1].videoTracks[0].clips[0].inPoint.seconds = 3;
    if (change === 'audio') g.project.sequences[1].audioTracks[0].clips[0].end.seconds = 9;
    if (change === 'closed') g.project.sequences.splice(1, 1);
    const result = g.call('applyMulticamTimelineCuts', { jobId: g.jobId, ranges: [{ startFrame: 0, endFrame: 250, trackIndex: 0 }] });
    assert.equal(result.success, false); assert.match(result.error, /duplicate.*(?:changed|closed)/i); assert.equal(g.state.overwrites.length, 0);
  }
});
test('desktop routing accepts the captured Multicam sequence after live sequence info switches tabs', async () => {
  const file = new URL('../src/main/websocket-server.ts', import.meta.url).pathname;
  const source = await readFile(file, 'utf8');
  const state = { received: [], results: [] };
  const output = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'multicam-routing-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/autocut\/premiere-multicam$/ }, () => ({ path: 'runner', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function runPremiereMulticam(config) { globalThis.__multicamRouting.received.push(config); return {success:true,sequenceId:'working-duplicate'}; }` }));
      builder.onLoad({ filter: /websocket-server\.ts$/ }, () => ({ contents: source + '\nexport { handleMessage as fixtureMessage };', loader: 'ts' }));
    } }] });
  const context = { require: createRequire(import.meta.url), module: { exports: {} }, exports: {}, process, Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval, __multicamRouting: state };
  vm.createContext(context); vm.runInContext(output.outputFiles[0].text, context);
  const route = context.module.exports;
  route.setCallbacks({ onResult: result => state.results.push(result) });
  await route.fixtureMessage({ type: 'sequenceInfo', id: 'unrelated', multicamTimelineVersion: 7 });
  const config = { options: { sequenceId: 'captured-source', timelineRevision: 'captured-revision' } };
  await route.runAutoCut(config);
  assert.equal(state.received[0], config); assert.equal(state.results[0].success, true);
  // An older panel must still be rejected before it can apply stale guards.
  await route.fixtureMessage({ type: 'sequenceInfo', id: 'captured-source', multicamTimelineVersion: 6 });
  await route.runAutoCut(config);
  assert.equal(state.received.length, 1); assert.equal(state.results[1].success, false);
  assert.match(state.results[1].error, /reopen the SmoothyEdit panel/);
});
test('export failure restores mute states; a failed camera move never edits the original or reports success', () => {
  const f = fixture(); f.prepare(); const before = f.json(f.source);
  f.state.failExport = true;
  assert.equal(f.call('exportMulticamTimelineTrack', { jobId: f.jobId, trackIndex: 1 }).success, false);
  assert.deepEqual(f.project.sequences[1].audioTracks.map(track => track.muted), [false, true]);
  f.state.failMove = true;
  const result = f.call('applyMulticamTimelineCuts', { jobId: f.jobId, ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] });
  assert.equal(result.success, false); assert.match(result.error, /Camera move failed/);
  f.call('discardMulticamTimeline', { jobId: f.jobId });
  assert.match(f.project.sequences[1].name, /incomplete/); assert.equal(f.project.activeSequence, f.source); assert.deepEqual(f.json(f.source), before);
});

function runnerFixture(mode = 'success') {
  const state = { requests: [], cleaned: [], speakers: [], normalized: [] };
  const config = { sources: [{ index: 0, camera: 0, name: 'Mic' }, { index: 3, camera: 1, name: 'Mic' }], options: { sequenceId: 'source', timelineRevision: 'snapshot', videoTracks: fullCameras, sequenceName: 'Result', jcutOffset: 1 } };
  const deps = {
    request: async (type, response, payload) => {
      state.requests.push({ type, response, payload });
      if (type === 'prepareMulticam') { state.audioDirectory = payload.audioDirectory; return { success: true, videoTracks: fullCameras, duration: 10, fps: 25 }; }
      if (type === 'exportMulticamTrack') {
        if (mode === 'export-fail') return { success: false, error: 'Render failed' };
        if (mode === 'old-bridge') return { success: true, filePath: '/private/TemporaryItems/render.wav' };
        const directory = mode === 'canonical' ? fs.realpathSync(state.audioDirectory) : state.audioDirectory;
        const filePath = path.join(directory, `microphone-${payload.trackIndex}.${mode === 'mp3' ? 'mp3' : 'wav'}`);
        fs.writeFileSync(filePath, Buffer.alloc(128));
        return { success: true, filePath, fileSize: mode === 'incomplete' ? 256 : 128 };
      }
      return { success: true, sequenceId: 'clone', sequenceName: 'Result', verifiedRanges: mode === 'unverified' ? undefined : payload.ranges?.length };
    },
    normalizeAudio: async file => { assert.equal(fs.statSync(file).size, 128); state.normalized.push(file); if (mode === 'normalize-fail') throw Error('FFmpeg failed'); return file + '.normalised.wav'; },
    detectSpeech: async (file, speaker) => { state.speakers.push(speaker); if (mode === 'vad-fail') throw Error('VAD failed'); return mode === 'silent' || (mode === 'silent-second' && speaker === 'microphone_3') ? [] : [{ start: 0, end: 5, speaker }]; },
    decideShots: (segments, mapping) => { assert.deepEqual(Object.values(mapping), [0, 1]); return { mainShots: shots, wideShots: [] }; },
    cleanup: file => { state.cleaned.push(file); fs.rmSync(file, { force: true }); }, progress() {}
  };
  return { state, config, deps };
}
test('runner uses rendered audio and camera ranges, never rebuilds media XML', async () => {
  const f = runnerFixture(), result = await runPremiereMulticam(f.config, f.deps);
  assert.equal(result.success, true); assert.equal(result.stats.shots, 2);
  assert.deepEqual(f.state.requests.map(item => item.type), ['prepareMulticam', 'exportMulticamTrack', 'exportMulticamTrack', 'applyMulticamCuts', 'discardMulticam']);
  assert.deepEqual(f.state.speakers, ['microphone_0', 'microphone_3']); assert.equal(f.state.cleaned.length, 4);
  assert.ok(f.state.normalized.every(file => file.includes('smoothyedit-multicam-') && !file.includes('TemporaryItems')));
  assert.equal(fs.existsSync(path.dirname(f.state.normalized[0])), false);
  assert.equal(f.state.requests[3].payload.ranges[0].endFrame, 150);
});
test('render, speech-analysis and no-speech failures clean the session without partial camera decisions', async () => {
  for (const mode of ['export-fail', 'normalize-fail', 'vad-fail', 'silent']) {
    const f = runnerFixture(mode);
    await assert.rejects(runPremiereMulticam(f.config, f.deps), /Render failed|FFmpeg failed|VAD failed|No speech/);
    assert.equal(f.state.requests.at(-1).type, 'discardMulticam');
    assert.equal(f.state.requests.some(item => item.type === 'applyMulticamCuts'), false);
    if (mode === 'vad-fail') assert.equal(f.state.cleaned.length, 2);
    assert.equal(fs.existsSync(f.state.audioDirectory), false);
  }
});

test('runner rejects old private paths and incomplete audio before FFmpeg or camera edits', async () => {
  for (const mode of ['old-bridge', 'incomplete']) {
    const f = runnerFixture(mode);
    await assert.rejects(runPremiereMulticam(f.config, f.deps), /updated SmoothyEdit panel|complete microphone/);
    assert.equal(f.state.normalized.length, 0);
    assert.equal(f.state.requests.some(item => item.type === 'applyMulticamCuts'), false);
    assert.equal(f.state.requests.at(-1).type, 'discardMulticam');
    assert.equal(fs.existsSync(f.state.audioDirectory), false);
  }
});

test('audio export accepts MP3 fallback and canonical macOS temp paths', async () => {
  for (const mode of ['mp3', 'canonical']) {
    const f = runnerFixture(mode);
    assert.equal((await runPremiereMulticam(f.config, f.deps)).success, true);
    assert.equal(f.state.normalized.length, 2);
    assert.equal(fs.existsSync(f.state.audioDirectory), false);
  }
});

test('Premiere rejects a missing handoff folder before duplicating the timeline', () => {
  const f = fixture();
  const result = f.call('prepareMulticamTimeline', { jobId: f.jobId, sequenceId: 'source', timelineRevision: f.context.smoothyTimelineRevision(f.source, false), videoTrackIndices: [0, 1], audioTrackIndices: [0, 1] });
  assert.equal(result.success, false); assert.match(result.error, /audio folder/); assert.equal(f.state.clones, 0);
});
test('runner reports a silent microphone and never reports success without final coverage verification', async () => {
  let f = runnerFixture('silent-second');
  const result = await runPremiereMulticam(f.config, f.deps);
  assert.equal(result.success, true); assert.match(result.warnings[0], /No speech detected on A4/);
  f = runnerFixture('unverified');
  await assert.rejects(runPremiereMulticam(f.config, f.deps), /verify every camera range/);
  assert.equal(f.state.requests.at(-1).payload.completed, false); assert.equal(fs.existsSync(f.state.audioDirectory), false);
});
test('strict microphone analysis rejects unreadable audio instead of silently losing one speaker', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-vad-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'invalid.wav'); fs.writeFileSync(file, 'Not a WAV');
  await assert.rejects(runVad([{ path: file, speaker: 'microphone_1' }], 3, true), /Could not analyse microphone_1/);
});

test('real microphone turns survive FFmpeg, VAD, camera decisions and native-cut verification', async () => {
  const nodeRequire = createRequire(import.meta.url);
  const ffmpeg = nodeRequire('ffmpeg-static');
  const entry = new URL('../src/main/autocut/audio-extractor.ts', import.meta.url).pathname;
  const output = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require: nodeRequire, __dirname: path.dirname(entry), process, console });
  const { extractAudioTrack, cleanupTempFile } = module.exports;
  const f = fixture({ renderAudio(file) {
    const turns = path.basename(file) === 'microphone-0.wav' ? 'between(t,0,3)+between(t,6,8)' : 'between(t,3,6)+between(t,8,10)';
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-af', `volume='if(${turns},1,0)':eval=frame`, '-ar', '48000', '-ac', '2', file]);
  } });
  const config = { sources: [{ index: 0, camera: 0 }, { index: 1, camera: 1 }], options: { sequenceId: 'source', timelineRevision: f.context.smoothyTimelineRevision(f.source, false), videoTracks: [{ index: 0 }, { index: 1 }] } };
  const actions = { prepareMulticam: 'prepareMulticamTimeline', exportMulticamTrack: 'exportMulticamTimelineTrack', applyMulticamCuts: 'applyMulticamTimelineCuts', discardMulticam: 'discardMulticamTimeline' };
  const normalized = [], rendered = []; let directory;
  const result = await runPremiereMulticam(config, {
    async request(type, response, payload) {
      if (type === 'prepareMulticam') directory = payload.audioDirectory;
      const result = f.call(actions[type], payload);
      if (type === 'exportMulticamTrack') { assert.equal(result.success, true, result.error); rendered.push(result.filePath); }
      return result;
    },
    normalizeAudio: extractAudioTrack,
    async detectSpeech(file, speaker) {
      normalized.push(file);
      const wav = fs.readFileSync(file), fmt = wav.indexOf('fmt ', 12), data = wav.indexOf('data', fmt + 24);
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.ok(fmt >= 12 && data > fmt);
      assert.equal(wav.readUInt16LE(fmt + 8), 1); assert.equal(wav.readUInt16LE(fmt + 10), 1);
      assert.equal(wav.readUInt32LE(fmt + 12), 16000); assert.equal(wav.readUInt16LE(fmt + 22), 16);
      assert.ok(wav.readUInt32LE(data + 4) / 32000 >= 9.9);
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'null', '-']);
      return runVad([{ path: file, speaker }], 3, true);
    },
    decideShots: generateShotDecisions, cleanup: cleanupTempFile, progress() {}
  });
  assert.equal(result.success, true); assert.equal(normalized.length, 2);
  assert.ok(rendered.every(file => path.dirname(file) === directory && !file.includes('TemporaryItems')));
  assert.ok(normalized.every(file => !fs.existsSync(file))); assert.equal(fs.existsSync(directory), false);
  assert.ok(result.stats.segments >= 4); assert.ok(result.stats.shots >= 4);
  for (const [seconds, camera] of [[1, 0], [4, 1], [7, 0], [9, 1]]) {
    const clone = f.project.sequences[1];
    const playing = clone.videoTracks[1].clips.filter(clip => !clip.disabled && clip.start.seconds <= seconds && clip.end.seconds > seconds);
    assert.deepEqual(playing.map(clip => clip.projectItem.nodeId), [`Nest ${camera + 1}`]);
    assert.ok(clone.videoTracks[0].clips.some(clip => !clip.disabled && clip.start.seconds <= seconds && clip.end.seconds > seconds));
  }
});

const bridgeSource = await readFile(new URL('../../smoothyapp-cep/js/bridge.js', import.meta.url), 'utf8');

test('refresh and final camera edits load current host code even when Premiere restores a cached manifest script', () => {
  const f = fixture(), replies = []; let socket, unsafeCalls = 0;
  f.prepare(); const before = f.json(f.source), audio = f.json(f.project.sequences[1].audioTracks);
  f.context.$ = { global: {}, evalFile() { vm.runInContext(host, f.context); } };
  class CSInterface {
    getSystemPath() { return '/fixture'; }
    evalScript(script, callback) {
      // Native Premiere reintroduced the previous host on subsequent calls.
      vm.runInContext(host.replace('20261004-multicam-reverse-track-v32', 'cached-host').replace('multicamTimelineVersion: 7', 'multicamTimelineVersion: 6'), f.context);
      f.context.applyMulticamTimelineCuts = () => { unsafeCalls++; throw Error('Cached camera overwrite invoked'); };
      callback(String(vm.runInContext(script, f.context)));
    }
  }
  class WebSocket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
    send(value) { replies.push(JSON.parse(value)); }
  }
  const context = { CSInterface, WebSocket, SystemPath: { EXTENSION: 'extension' }, window: {}, document: { getElementById: () => ({}) }, console: { log() {}, error() {} }, setInterval() {}, clearInterval() {} };
  vm.createContext(context); vm.runInContext(bridgeSource, context);
  socket.onopen();
  assert.equal(replies.find(reply => reply.type === 'sequenceInfo').multicamTimelineVersion, 7);
  socket.onmessage({ data: JSON.stringify({ type: 'applyMulticamCuts', requestId: 'cached-request', jobId: f.jobId,
    ranges: [{ startFrame: 0, endFrame: 125, trackIndex: 0 }, { startFrame: 125, endFrame: 250, trackIndex: 1 }] }) });
  const result = replies.find(reply => reply.type === 'multicamCutsApplied');
  assert.equal(result.success, true, result.error); assert.equal(result.verifiedRanges, 2);
  assert.equal(unsafeCalls, 0); assert.equal(f.state.overwrites.length, 0);
  assert.ok(replies.filter(reply => reply.type === 'sequenceInfo').every(reply => reply.multicamTimelineVersion === 7));
  assert.deepEqual(f.json(f.project.sequences[1].audioTracks), audio); assert.deepEqual(f.json(f.source), before);
});

test('CEP bridge stages a large Unicode cut list and preserves the correlated response', async () => {
  const f = fixture(), scripts = [], replies = []; let socket, received;
  f.context.$ = { global: {}, evalFile() {
    vm.runInContext(host, f.context);
    f.context.applyMulticamTimelineCuts = value => { received = JSON.parse(value); return JSON.stringify({ success: true, sequenceId: 'fixture-clone' }); };
  } };
  class CSInterface {
    getSystemPath() { return '/fixture'; }
    evalScript(script, callback) { scripts.push(script); callback(String(vm.runInContext(script, f.context))); }
  }
  class WebSocket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
    send(value) { replies.push(JSON.parse(value)); }
  }
  const context = { CSInterface, WebSocket, SystemPath: { EXTENSION: 'extension' }, window: {}, document: { getElementById: () => ({}) }, console: { log() {}, error() {} }, setInterval() {}, clearInterval() {} };
  vm.createContext(context); vm.runInContext(bridgeSource, context);
  const payload = { type: 'applyMulticamCuts', requestId: 'fixture-request', jobId: f.jobId, label: 'مقابلة 日本語', ranges: Array.from({ length: 1200 }, (_, i) => ({ startFrame: i * 10, endFrame: (i + 1) * 10, trackIndex: i % 2 })) };
  socket.onmessage({ data: JSON.stringify(payload) });
  assert.deepEqual(received, payload);
  assert.ok(scripts.filter(script => script.includes('SMOOTHY_MULTICAM_PAYLOAD +=')).length > 5);
  assert.ok(scripts.filter(script => script.includes('SMOOTHY_MULTICAM_PAYLOAD +=')).every(script => script.length < 8200));
  assert.ok(replies.some(reply => reply.type === 'multicamCutsApplied' && reply.requestId === payload.requestId && reply.success));
});
